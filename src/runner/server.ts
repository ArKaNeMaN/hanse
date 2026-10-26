import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import {
  type ReconcileResponse,
  type RuntimeAppState,
  type RuntimeAppStatus,
  type RuntimeErrorBody,
  type RuntimeHealth,
  type RuntimeLogs,
  stoppedStatus,
} from "../agent/protocol.js";
import { isValidAppId } from "../agent/spec.js";
import { ConfigError } from "../config/load.js";
import { shellQuote } from "../git/env.js";
import { GitError, isGitErrorCode } from "../git/errors.js";
import { writeGitCredentialFiles } from "../git/materialize.js";
import {
  GIT_SANDBOX_APP_DIR_ENV,
  GIT_SANDBOX_BRANCH_ENV,
  GIT_SANDBOX_MESSAGE_ENV,
  GIT_SANDBOX_OPERATION_ENV,
  GIT_SANDBOX_TEST_KIND_ENV,
  GIT_SANDBOX_TEST_REMOTE_ENV,
  type GitOpPayload,
} from "../git/op.js";
import {
  type GitOperation,
  type GitRequest,
  type GitTestRequest,
  type GitTestResult,
  validateGitRequest,
  validateGitTestRequest,
} from "../git/request.js";
import { isInside, resolveWithinRoot } from "../runtime/app-path.js";
import { VERSION } from "../version.js";
import {
  type DockerBuildRuntime,
  type DockerContainerInspect,
  DockerError,
  type DockerExecRuntime,
  type DockerExecSize,
  type DockerExecStream,
  type DockerImageInspect,
  type DockerRuntime,
} from "./docker.js";
import { ImageGcError, ImageGcService } from "./image-gc.js";
import type { ImageValidationRuntime } from "./image-validation.js";
import { ImageBuildError, ImageBuildService, resolveImageDigest } from "./images.js";
import { appContainerName, appNetworkName } from "./names.js";
import {
  hostPathForSpecEnv,
  normalizeImageReference,
  RUNNER_APP_PORT,
  RUNNER_CONTAINER_WORKSPACE_ROOT,
  type RunnerConfig,
  type RunnerSpec,
  validateRunnerSpec,
} from "./validate.js";
import { acceptWebSocket, websocketHandshakeError } from "./ws.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECONCILE_APPS = 1000;
const MAX_INSPECT_DIGESTS = 16;
const MAX_INSPECT_DIGEST_LENGTH = 255;
const MAX_INSPECT_BODY_BYTES = 8 * 1024;
const DEFAULT_LOG_TAIL = 500;
const RUNNER_ENTRYPOINT = "/usr/local/bin/hanse-agent-entrypoint";
const EXEC_SHELL = "if [ -x /bin/bash ]; then exec /bin/bash -l; fi; exec /bin/sh -l";
const MAX_EXEC_DIMENSION = 1000;
const GIT_CONTAINER_APP_CREDENTIAL_DIR = "/run/hanse/git/app";
const GIT_TEST_TIMEOUT_MS = 75_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_LOG_TAIL = 10_000;
const GIT_CONTAINER_MEMORY_BYTES = 1024 * 1024 * 1024;
const GIT_CONTAINER_NANO_CPUS = 1;
const GIT_CONTAINER_PIDS_LIMIT = 128;
const GIT_NETWORK_OPERATIONS: ReadonlySet<GitOperation> = new Set(["fetch", "update", "push"]);
const GIT_TIMEOUTS: Record<GitOperation, number> = {
  status: 45_000,
  fetch: 135_000,
  update: 135_000,
  switch: 45_000,
  commit: 45_000,
  push: 195_000,
};

class RunnerError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RunnerError";
    this.status = status;
    this.code = code;
  }
}

/** A failure reported by the sandboxed git helper; the wire code is a git error code. */
class RunnerGitError extends Error {
  readonly status: number;
  readonly code: string;
  readonly root?: string;

  constructor(code: string, status: number, message: string, root?: string) {
    super(message);
    this.name = "RunnerGitError";
    this.code = code;
    this.status = status;
    this.root = root;
  }
}

interface GitContainerMounts {
  hostAppDir: string;
  containerAppDir: string;
}

interface GitEnvelope {
  status?: unknown;
  result?: unknown;
  test?: unknown;
  error?: string;
  code?: string;
  root?: string;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function writeSocketResponse(socket: Duplex, status: number, body: unknown): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  socket.write(
    [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
      "content-type: application/json; charset=utf-8",
      `content-length: ${Buffer.byteLength(payload)}`,
      "cache-control: no-store",
      "connection: close",
      "",
      payload,
    ].join("\r\n"),
  );
  socket.end();
}

function parseResizeControl(data: Buffer, type: "text" | "binary"): DockerExecSize | undefined {
  if (type !== "text") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as { type?: unknown; rows?: unknown; cols?: unknown };
  if (candidate.type !== "resize") return undefined;
  if (!Number.isInteger(candidate.rows) || !Number.isInteger(candidate.cols)) return undefined;
  const rows = candidate.rows as number;
  const cols = candidate.cols as number;
  if (rows < 1 || cols < 1 || rows > MAX_EXEC_DIMENSION || cols > MAX_EXEC_DIMENSION) {
    return undefined;
  }
  return { rows, cols };
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function tokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RunnerError(413, "request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RunnerError(413, "request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.trim().length === 0) {
    throw new RunnerError(400, "request body is required");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RunnerError(400, "request body must be valid JSON");
  }
}

async function readOptionalJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.trim().length === 0) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RunnerError(400, "request body must be valid JSON");
  }
}

function errorBody(error: unknown): RuntimeErrorBody {
  if (error instanceof ConfigError) {
    return { error: error.message, code: error.code };
  }
  if (error instanceof RunnerGitError) {
    return {
      error: error.message,
      code: error.code,
      ...(error.root === undefined ? {} : { root: error.root }),
    };
  }
  if (error instanceof ImageBuildError) {
    return { error: error.message, ...(error.code === undefined ? {} : { code: error.code }) };
  }
  if (error instanceof ImageGcError) {
    return { error: error.message, code: error.code };
  }
  if (error instanceof RunnerError) {
    return { error: error.message, ...(error.code === undefined ? {} : { code: error.code }) };
  }
  if (error instanceof DockerError) {
    return { error: error.message, code: "docker_error" };
  }
  return { error: "internal error" };
}

function statusFor(error: unknown): number {
  if (error instanceof RunnerGitError) return error.status;
  if (error instanceof ImageBuildError) return error.status;
  if (error instanceof ImageGcError) return error.status;
  if (error instanceof RunnerError) return error.status;
  if (error instanceof ConfigError) return 400;
  if (error instanceof DockerError) return error.status >= 500 ? 502 : 400;
  return 500;
}

function appIdFromContainer(summary: { Labels?: Record<string, string> }): string | undefined {
  return summary.Labels?.["hanse.app.id"];
}

function containerState(inspect: DockerContainerInspect): RuntimeAppState {
  if (inspect.State?.Running === true) return "running";
  const status = inspect.State?.Status;
  if (status === "created" || status === "restarting") return "starting";
  if (
    inspect.State?.Error !== undefined ||
    (inspect.State?.ExitCode !== undefined && inspect.State.ExitCode !== 0)
  ) {
    return "error";
  }
  return "stopped";
}

function statusFromInspect(
  appId: string,
  containerName: string,
  inspect: DockerContainerInspect,
): RuntimeAppStatus {
  const state = containerState(inspect);
  const specHash = inspect.Config?.Labels?.["hanse.spec.hash"] ?? null;
  return {
    appId,
    endpoint:
      state === "running" || state === "starting"
        ? `http://${containerName}:${RUNNER_APP_PORT}`
        : null,
    state,
    specHash,
    version: null,
    containerId: inspect.Id,
    containerName,
    imageId: inspect.Image ?? null,
    ...(inspect.State?.Error === undefined ? {} : { error: inspect.State.Error }),
  };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function boundedRepoDigests(value: readonly string[] | undefined): string[] {
  const digests: string[] = [];
  for (const entry of value ?? []) {
    if (digests.length >= MAX_INSPECT_DIGESTS) break;
    if (typeof entry !== "string") continue;
    if (entry.length === 0 || entry.length > MAX_INSPECT_DIGEST_LENGTH) continue;
    if (hasControlCharacters(entry)) continue;
    digests.push(entry);
  }
  return digests;
}

function containerEnvironment(spec: RunnerSpec): Record<string, string> {
  const env: Record<string, string> = { ...spec.env };
  const passwordFile = hostPathForSpecEnv(spec, "HANSE_OPENCODE_PASSWORD_FILE");
  if (passwordFile !== undefined) {
    let password: string;
    try {
      password = readFileSync(passwordFile, "utf8").trim();
    } catch (error) {
      throw new RunnerError(
        400,
        `cannot read opencode password file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (password.length === 0) {
      throw new RunnerError(400, "opencode password file is empty");
    }
    env.OPENCODE_SERVER_PASSWORD = password;
  }
  delete env.HANSE_OPENCODE_PASSWORD_FILE;
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gitStatusFor(code: string): number {
  switch (code) {
    case "invalid_input":
    case "invalid_remote":
    case "credential_scheme_mismatch":
    case "host_not_allowed":
      return 400;
    case "outside_workspace":
      return 403;
    case "auth_failed":
      return 502;
    case "timeout":
      return 504;
    case "output_too_large":
      return 500;
    case "git_failed":
      return 502;
    case "runner_required":
      return 503;
    case "not_running":
    case "restart_required":
    case "missing_remote":
      return 409;
    default:
      return 409;
  }
}

/**
 * Derive the app mount from the managed container's bind list.
 *
 * Only a bind whose destination is inside the fixed `/data/workspace` root is accepted; the host
 * source is re-resolved under `HANSE_HOST_WORKSPACE`, so a container with forged labels or binds
 * cannot point the one-shot git container at an arbitrary host path.
 */
function gitContainerMounts(
  inspect: DockerContainerInspect,
  config: RunnerConfig,
): GitContainerMounts | undefined {
  const marker = `:${RUNNER_CONTAINER_WORKSPACE_ROOT}/`;
  for (const bind of inspect.HostConfig?.Binds ?? []) {
    const at = bind.lastIndexOf(marker);
    if (at <= 0) continue;
    const source = bind.slice(0, at);
    const target = bind.slice(at + 1).split(":")[0] ?? "";
    if (!path.isAbsolute(source)) continue;
    if (!isInside(RUNNER_CONTAINER_WORKSPACE_ROOT, target)) continue;
    if (target === RUNNER_CONTAINER_WORKSPACE_ROOT) continue;
    const hostAppDir = resolveWithinRoot({
      target: source,
      root: config.hostWorkspace,
      label: "git appDir",
    });
    return { hostAppDir, containerAppDir: target };
  }
  return undefined;
}

interface ManagedGitDirectory {
  hostAgentsRoot: string;
  credentialDirHost: string;
}

function restartRequired(message: string): RunnerError {
  return new RunnerError(409, message, "restart_required");
}

function realDirectory(directory: string): boolean {
  const info = lstatSync(directory, { throwIfNoEntry: false });
  return info !== undefined && !info.isSymbolicLink() && info.isDirectory();
}

function managedGitDirectory(
  inspect: DockerContainerInspect,
  config: RunnerConfig,
): ManagedGitDirectory {
  const label = inspect.Config?.Labels?.["hanse.agents.root"];
  if (label === undefined || label.trim().length === 0) {
    throw restartRequired("Restart the agent to materialize git credentials.");
  }
  let hostAgentsRoot: string;
  try {
    hostAgentsRoot = resolveWithinRoot({
      target: label,
      root: config.hostAgents,
      label: "hanse.agents.root",
    });
  } catch {
    throw restartRequired("Restart the agent to materialize git credentials.");
  }
  const relative = path.relative(config.hostAgents, hostAgentsRoot);
  if (relative.length === 0 || relative.split(path.sep).length !== 2) {
    throw restartRequired("Restart the agent to materialize git credentials.");
  }

  const home = path.join(hostAgentsRoot, "home");
  let realAgentsRoot: string;
  let realHome: string;
  try {
    realAgentsRoot = realpathSync(hostAgentsRoot);
    realHome = realpathSync(home);
  } catch {
    throw restartRequired("Restart the agent to materialize git credentials.");
  }
  if (realHome !== path.join(realAgentsRoot, "home")) {
    throw restartRequired(
      "The application home is not a real directory; repair it and restart the agent.",
    );
  }
  let current = home;
  for (const segment of [".config", "hanse", "git"]) {
    current = path.join(current, segment);
    if (!realDirectory(current)) {
      throw restartRequired(
        "The application home is not a real directory; repair it and restart the agent.",
      );
    }
  }
  const credentialDirHost = current;
  for (const file of ["config", "ssh", "askpass"]) {
    if (!existsSync(path.join(credentialDirHost, file))) {
      throw restartRequired("Restart the agent to materialize git credentials.");
    }
  }
  return { hostAgentsRoot, credentialDirHost };
}

function managedGitEnv(operation?: GitRequest, test?: GitTestRequest): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/hanse-git-home",
    TMPDIR: "/tmp",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: `${GIT_CONTAINER_APP_CREDENTIAL_DIR}/config`,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_SSH_COMMAND: shellQuote(`${GIT_CONTAINER_APP_CREDENTIAL_DIR}/ssh`),
    GIT_ASKPASS: `${GIT_CONTAINER_APP_CREDENTIAL_DIR}/askpass`,
    GIT_ASKPASS_REQUIRE: "force",
    HANSE_CREDENTIALS_DIR: GIT_CONTAINER_APP_CREDENTIAL_DIR,
    HANSE_CREDENTIALS_READONLY: "1",
    ...(operation === undefined ? {} : { [GIT_SANDBOX_OPERATION_ENV]: operation.operation }),
    ...(operation?.branch === undefined ? {} : { [GIT_SANDBOX_BRANCH_ENV]: operation.branch }),
    ...(operation?.message === undefined ? {} : { [GIT_SANDBOX_MESSAGE_ENV]: operation.message }),
    ...(test === undefined
      ? {}
      : {
          [GIT_SANDBOX_OPERATION_ENV]: "test",
          [GIT_SANDBOX_TEST_KIND_ENV]: test.kind,
          ...(test.remote === undefined ? {} : { [GIT_SANDBOX_TEST_REMOTE_ENV]: test.remote }),
        }),
  };
}

function gitContainerEnv(request: GitRequest, containerAppDir: string): Record<string, string> {
  return {
    ...managedGitEnv(request),
    [GIT_SANDBOX_APP_DIR_ENV]: containerAppDir,
  };
}

function gitTestContainerEnv(
  request: GitTestRequest,
  containerAppDir: string,
): Record<string, string> {
  return {
    ...managedGitEnv(undefined, request),
    [GIT_SANDBOX_APP_DIR_ENV]: containerAppDir,
  };
}

function parseGitEnvelope(
  logs: string,
  exitCode: number,
  credentialsMaterialized: boolean,
  config: RunnerConfig,
): GitEnvelope {
  if (logs.length > MAX_GIT_OUTPUT_BYTES) {
    throw new RunnerGitError(
      "output_too_large",
      gitStatusFor("output_too_large"),
      "sandboxed git output exceeded the 4 MiB limit",
    );
  }
  const text = logs.trim();
  if (text.length === 0) {
    const hint =
      exitCode === 127 ? "; the app image does not provide /usr/local/bin/hanse git-op" : "";
    throw new RunnerGitError(
      "git_failed",
      gitStatusFor("git_failed"),
      `sandboxed git exited with code ${exitCode} without a result${hint}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RunnerGitError(
      "git_failed",
      gitStatusFor("git_failed"),
      `sandboxed git returned an unreadable result (exit code ${exitCode})`,
    );
  }
  if (!isRecord(parsed)) {
    throw new RunnerGitError(
      "git_failed",
      gitStatusFor("git_failed"),
      "sandboxed git returned an invalid result",
    );
  }
  if (typeof parsed.error === "string") {
    const code = isGitErrorCode(parsed.code) ? parsed.code : "git_failed";
    let message = parsed.error;
    if (
      code === "auth_failed" &&
      !credentialsMaterialized &&
      !/credentials are not configured/i.test(message)
    ) {
      message = `${message} Git credentials are not configured for this application. Configure SSH or HTTPS in Settings.`;
    }
    const root = typeof parsed.root === "string" ? hostGitRoot(parsed.root, config) : undefined;
    throw new RunnerGitError(code, gitStatusFor(code), message, root);
  }
  if (exitCode !== 0) {
    throw new RunnerGitError(
      "git_failed",
      gitStatusFor("git_failed"),
      `sandboxed git exited with code ${exitCode}`,
    );
  }
  return parsed as GitEnvelope;
}

function hostGitRoot(root: string, config: RunnerConfig): string {
  if (!isInside(RUNNER_CONTAINER_WORKSPACE_ROOT, root)) return root;
  const relative = path.posix.relative(RUNNER_CONTAINER_WORKSPACE_ROOT, root);
  return relative.length === 0
    ? config.hostWorkspace
    : path.join(config.hostWorkspace, ...relative.split("/"));
}

function mapGitPayloadRoots(payload: GitEnvelope, config: RunnerConfig): GitEnvelope {
  if (isRecord(payload.status) && typeof payload.status.root === "string") {
    payload.status = { ...payload.status, root: hostGitRoot(payload.status.root, config) };
  }
  if (isRecord(payload.result)) {
    const status = payload.result.status;
    if (isRecord(status) && typeof status.root === "string") {
      payload.result = {
        ...payload.result,
        status: { ...status, root: hostGitRoot(status.root, config) },
      };
    }
  }
  return payload;
}

export interface RunnerServiceOptions {
  config: RunnerConfig;
  docker: DockerRuntime;
  exec?: DockerExecRuntime;
  build?: DockerBuildRuntime;
  validation?: ImageValidationRuntime;
  imageGc?: ImageGcService;
}

/** Per-app container runtime behind the same API shape as the B0 supervisor. */
export class RunnerService {
  readonly #config: RunnerConfig;
  readonly #docker: DockerRuntime;
  readonly #exec: DockerExecRuntime | undefined;
  readonly #images: ImageBuildService;
  readonly #imageGc: ImageGcService;

  constructor(options: RunnerServiceOptions) {
    this.#config = options.config;
    this.#docker = options.docker;
    this.#exec = options.exec;
    const inspectImage = options.docker.inspectImage?.bind(options.docker);
    this.#images = new ImageBuildService({
      config: options.config,
      ...(options.build === undefined ? {} : { build: options.build }),
      ...(options.validation === undefined ? {} : { validation: options.validation }),
      ...(inspectImage === undefined ? {} : { inspectImage }),
    });
    this.#imageGc =
      options.imageGc ??
      new ImageGcService({
        docker: options.docker,
        diskPath: options.config.hostWorkspace,
        protectedRefs: () => this.#images.protectedBuildTags(),
      });
  }

  async health(): Promise<RuntimeHealth> {
    const containers = await this.#docker.listContainers("hanse.managed=true");
    return { ok: true, hanseVersion: VERSION, apps: containers.length };
  }

  async #isBuiltAppImage(appId: string, image: string): Promise<boolean> {
    if (this.#config.allowedImages.has(image) || image === this.#config.defaultImage) {
      return true;
    }
    const record = this.#images.get(appId);
    if (record.status === "ready" && record.imageRef === image) {
      return true;
    }
    const inspectImage = this.#docker.inspectImage?.bind(this.#docker);
    if (inspectImage === undefined) {
      return false;
    }
    const inspected = await inspectImage(image).catch(() => undefined);
    const labels = inspected?.Config?.Labels;
    return labels?.["hanse.app.id"] === appId && typeof labels["hanse.image.version"] === "string";
  }

  async #targetImageId(reference: string): Promise<string | null> {
    const inspectImage = this.#docker.inspectImage?.bind(this.#docker);
    if (inspectImage === undefined) return null;
    try {
      const inspected = await inspectImage(reference);
      return typeof inspected?.Id === "string" && inspected.Id.length > 0 ? inspected.Id : null;
    } catch {
      return null;
    }
  }

  async #inspectImageRequest(url: URL): Promise<{
    found: boolean;
    imageId: string | null;
    repoDigests: string[];
    resolvedDigest: string | null;
  }> {
    const rawRef = url.searchParams.get("ref");
    const reference = rawRef === null ? undefined : normalizeImageReference(rawRef);
    if (reference === undefined) {
      throw new RunnerError(400, "ref must be a valid image reference", "invalid_reference");
    }
    const rawAppId = url.searchParams.get("appId");
    let appId: string | undefined;
    if (rawAppId !== null) {
      if (!isValidAppId(rawAppId)) {
        throw new RunnerError(400, "appId must be a safe app id", "invalid_app_id");
      }
      appId = rawAppId;
    }
    const preallowed =
      this.#config.allowedImages.has(reference) ||
      reference === this.#config.defaultImage ||
      reference === this.#config.baseImage;
    if (!preallowed && !(appId !== undefined && reference.startsWith("hanse-app-"))) {
      throw new RunnerError(
        403,
        "image reference is not allowed by the runner",
        "image_disallowed",
      );
    }
    const inspectImage = this.#docker.inspectImage?.bind(this.#docker);
    if (inspectImage === undefined) {
      throw new RunnerError(501, "image inspection is not supported", "inspect_unavailable");
    }
    let inspected: DockerImageInspect | undefined;
    try {
      inspected = await inspectImage(reference);
    } catch {
      throw new RunnerError(502, "image inspection failed", "docker_error");
    }
    if (
      !preallowed &&
      inspected !== undefined &&
      inspected.Config?.Labels?.["hanse.app.id"] !== appId
    ) {
      throw new RunnerError(
        403,
        "image reference is not allowed for this application",
        "image_disallowed",
      );
    }
    if (inspected === undefined) {
      return { found: false, imageId: null, repoDigests: [], resolvedDigest: null };
    }
    const imageId =
      typeof inspected.Id === "string" && inspected.Id.length > 0 ? inspected.Id : null;
    let repoDigests = boundedRepoDigests(inspected.RepoDigests);
    let resolvedDigest = resolveImageDigest(reference, repoDigests);
    while (
      repoDigests.length > 0 &&
      Buffer.byteLength(JSON.stringify({ found: true, imageId, repoDigests, resolvedDigest })) >
        MAX_INSPECT_BODY_BYTES
    ) {
      repoDigests = repoDigests.slice(0, -1);
      resolvedDigest = resolveImageDigest(reference, repoDigests);
    }
    return { found: true, imageId, repoDigests, resolvedDigest };
  }

  async #extraAllowedImages(raw: unknown): Promise<ReadonlySet<string> | undefined> {
    if (!isRecord(raw)) {
      return undefined;
    }
    const { appId, image } = raw;
    if (typeof appId !== "string" || typeof image !== "string") {
      return undefined;
    }
    if (this.#config.allowedImages.has(image) || image === this.#config.defaultImage) {
      return undefined;
    }
    return (await this.#isBuiltAppImage(appId, image)) ? new Set([image]) : undefined;
  }

  async ensure(raw: unknown, expectedAppId?: string): Promise<RuntimeAppStatus> {
    const spec = validateRunnerSpec(raw, this.#config, await this.#extraAllowedImages(raw));
    if (expectedAppId !== undefined && spec.appId !== expectedAppId) {
      throw new RunnerError(400, "appId in the path does not match the spec");
    }
    if (spec.attachmentsReadOnly === true) {
      const source = path.join(spec.hostAgentsRoot, "attachments");
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (stat === undefined || stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new RunnerError(
          409,
          "attachments bind source is missing or unsafe; repair the application state directory",
          "attachments_root_missing",
        );
      }
    }
    await this.#docker.ensureNetwork({
      name: spec.networkName,
      labels: {
        "hanse.managed": "true",
        "hanse.app.id": spec.appId,
      },
    });

    const existing = await this.#docker.inspectContainer(spec.containerName);
    if (existing !== undefined && existing.Config?.Labels?.["hanse.spec.hash"] === spec.specHash) {
      const running = existing.State?.Running === true;
      if (!running) {
        const targetImageId = await this.#targetImageId(spec.image);
        if (targetImageId === null) {
          throw new RunnerError(
            503,
            `target image is unavailable: ${spec.image}`,
            "image_unavailable",
          );
        }
        if (existing.Image === targetImageId) {
          await this.#docker.startContainer(existing.Id);
          await this.#connectCoordinator(spec.networkName);
          const inspected = await this.#docker.inspectContainer(spec.containerName);
          if (inspected === undefined) {
            throw new RunnerError(502, "container disappeared after start");
          }
          return statusFromInspect(spec.appId, spec.containerName, inspected);
        }
        await this.#docker.stopContainer(existing.Id);
        await this.#docker.removeContainer(existing.Id, true);
      } else {
        await this.#connectCoordinator(spec.networkName);
        return statusFromInspect(spec.appId, spec.containerName, existing);
      }
    } else if (existing !== undefined) {
      await this.#docker.stopContainer(existing.Id);
      await this.#docker.removeContainer(existing.Id, true);
    }

    const id = await this.#docker.createContainer({
      name: spec.containerName,
      image: spec.image,
      hostname: spec.containerName,
      user: "1000:1000",
      entrypoint: [RUNNER_ENTRYPOINT],
      cmd: [],
      workingDir: spec.containerAppDir,
      env: containerEnvironment(spec),
      labels: {
        ...spec.labels,
        "hanse.managed": "true",
        "hanse.app.id": spec.appId,
        "hanse.image": spec.image,
        "hanse.spec.hash": spec.specHash,
        "hanse.network.name": spec.networkName,
        "hanse.agents.root": spec.hostAgentsRoot,
      },
      binds: [
        `${spec.hostAppDir}:${spec.containerAppDir}:${spec.appDirReadOnly === true ? "ro" : "rw"}`,
        `${spec.hostAgentsRoot}:${spec.containerAgentsRoot}:rw`,
        ...(spec.attachmentsReadOnly === true
          ? [
              `${path.join(spec.hostAgentsRoot, "attachments")}:${path.posix.join(spec.containerAgentsRoot, "attachments")}:ro`,
            ]
          : []),
      ],
      tmpfs: {
        "/tmp": "rw,exec,nosuid,size=1g",
        "/run": "rw,nosuid,size=16m",
      },
      memoryBytes: spec.resources.memoryBytes,
      nanoCpus: spec.resources.nanoCpus,
      pidsLimit: spec.resources.pidsLimit,
      networkName: spec.networkName,
      networkAliases: [spec.containerName],
    });
    try {
      await this.#docker.startContainer(id);
      await this.#connectCoordinator(spec.networkName);
    } catch (error) {
      await this.#docker.removeContainer(id, true).catch(() => undefined);
      throw error;
    }
    const inspected = await this.#docker.inspectContainer(spec.containerName);
    if (inspected === undefined) {
      throw new RunnerError(502, "container disappeared after create");
    }
    return statusFromInspect(spec.appId, spec.containerName, inspected);
  }

  async delete(appId: string): Promise<RuntimeAppStatus> {
    const summary = await this.#findContainer(appId);
    if (summary === undefined) {
      await this.#removeManagedAppNetwork(appNetworkName(appId), appId);
      return stoppedStatus(appId);
    }
    const inspect = await this.#docker.inspectContainer(summary.Id);
    const network = inspect?.Config?.Labels?.["hanse.network.name"] ?? appNetworkName(appId);
    await this.#docker.stopContainer(summary.Id);
    await this.#docker.removeContainer(summary.Id, true);
    await this.#removeManagedAppNetwork(network, appId);
    return {
      ...stoppedStatus(appId),
      specHash: inspect?.Config?.Labels?.["hanse.spec.hash"] ?? null,
    };
  }

  async #inspectNetwork(name: string) {
    const inspectNetwork = this.#docker.inspectNetwork?.bind(this.#docker);
    if (inspectNetwork === undefined) return undefined;
    try {
      return await inspectNetwork(name);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #removeManagedAppNetwork(network: string, appId: string): Promise<void> {
    const inspected = await this.#inspectNetwork(network);
    const labels = inspected?.Labels;
    if (labels?.["hanse.managed"] !== "true" || labels["hanse.app.id"] !== appId) return;
    await this.#docker
      .disconnectNetwork(network, this.#config.coordinatorContainer)
      .catch(() => undefined);
    try {
      await this.#docker.removeNetwork(network);
    } catch (error) {
      if (error instanceof DockerError && (error.status === 404 || error.status === 409)) return;
      throw error;
    }
  }

  async status(appId: string): Promise<RuntimeAppStatus | undefined> {
    if (!isValidAppId(appId)) {
      throw new RunnerError(400, "invalid app id");
    }
    const containerName = appContainerName(appId);
    const inspect = await this.#docker.inspectContainer(containerName);
    if (inspect === undefined) return undefined;
    if (inspect.State?.Running === true) {
      const network = inspect.Config?.Labels?.["hanse.network.name"];
      if (network !== undefined) {
        await this.#connectCoordinator(network).catch(() => undefined);
      }
    }
    return statusFromInspect(appId, containerName, inspect);
  }

  async logs(appId: string): Promise<RuntimeLogs | undefined> {
    if (!isValidAppId(appId)) {
      throw new RunnerError(400, "invalid app id");
    }
    const containerName = appContainerName(appId);
    const inspect = await this.#docker.inspectContainer(containerName);
    if (inspect === undefined) return undefined;
    const logs = await this.#docker.logs(inspect.Id, DEFAULT_LOG_TAIL);
    return { appId, logs: logs.logs, truncated: logs.truncated };
  }

  async reconcile(appIds: unknown): Promise<ReconcileResponse> {
    if (!Array.isArray(appIds) || appIds.some((appId) => !isValidAppId(appId))) {
      throw new RunnerError(400, 'body must be {"appIds": [safe app ids]}');
    }
    if (appIds.length > MAX_RECONCILE_APPS) {
      throw new RunnerError(400, "too many app ids");
    }
    const desired = new Set(appIds);
    const containers = await this.#docker.listContainers("hanse.managed=true");
    const stopped: string[] = [];
    for (const container of containers) {
      const appId = appIdFromContainer(container);
      if (appId === undefined || desired.has(appId)) continue;
      await this.delete(appId);
      stopped.push(appId);
    }
    const apps: RuntimeAppStatus[] = [];
    for (const appId of appIds) {
      const status = await this.status(appId);
      if (status !== undefined) apps.push(status);
    }
    return { stopped, apps };
  }

  async stopAll(): Promise<ReconcileResponse> {
    return this.reconcile([]);
  }

  async #gitTarget(appId: string): Promise<{
    inspect: DockerContainerInspect;
    image: string;
    mounts: GitContainerMounts;
    managed: ManagedGitDirectory;
  }> {
    if (!isValidAppId(appId)) {
      throw new RunnerError(400, "invalid app id");
    }
    const inspect = await this.#docker.inspectContainer(appContainerName(appId));
    const labels = inspect?.Config?.Labels;
    if (
      inspect === undefined ||
      labels?.["hanse.managed"] !== "true" ||
      labels?.["hanse.app.id"] !== appId
    ) {
      throw new RunnerError(404, "unknown app");
    }
    if (inspect.State?.Running !== true) {
      throw new RunnerError(409, "app is not running", "not_running");
    }
    const image = inspect.Config?.Image;
    if (image === undefined || !(await this.#isBuiltAppImage(appId, image))) {
      throw new RunnerError(400, "app image is not allowed by the runner");
    }
    const mounts = gitContainerMounts(inspect, this.#config);
    if (mounts === undefined) {
      throw new RunnerError(409, "app container has no workspace mount");
    }
    const managed = managedGitDirectory(inspect, this.#config);
    return { inspect, image, mounts, managed };
  }

  async git(appId: string, raw: unknown): Promise<GitOpPayload> {
    const request = validateGitRequest(raw);
    const { image, mounts, managed } = await this.#gitTarget(appId);

    const network = !GIT_NETWORK_OPERATIONS.has(request.operation) ? "none" : appNetworkName(appId);
    const timeout = GIT_TIMEOUTS[request.operation];
    const containerName = `hanse-git-${appId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 40)}-${randomUUID().slice(0, 8)}`;
    const credentialsMaterialized =
      existsSync(path.join(managed.credentialDirHost, "id")) ||
      existsSync(path.join(managed.credentialDirHost, "token"));

    let id: string | undefined;
    try {
      id = await this.#docker.createContainer({
        name: containerName,
        image,
        hostname: containerName,
        user: "1000:1000",
        entrypoint: ["/usr/local/bin/hanse"],
        cmd: ["git-op"],
        workingDir: mounts.containerAppDir,
        env: gitContainerEnv(request, mounts.containerAppDir),
        labels: { "hanse.git": "true", "hanse.app.id": appId },
        binds: [
          `${mounts.hostAppDir}:${mounts.containerAppDir}:rw`,
          `${managed.credentialDirHost}:${GIT_CONTAINER_APP_CREDENTIAL_DIR}:ro`,
        ],
        tmpfs: {
          "/tmp": "rw,nosuid,size=512m",
          "/run": "rw,nosuid,size=16m",
        },
        memoryBytes: GIT_CONTAINER_MEMORY_BYTES,
        nanoCpus: GIT_CONTAINER_NANO_CPUS,
        pidsLimit: GIT_CONTAINER_PIDS_LIMIT,
        networkName: network,
        networkAliases: [],
        networkMode: network,
        restartPolicy: "no",
      });
      await this.#docker.startContainer(id);
      const wait = await this.#docker.waitContainer(id, timeout + 15_000);
      const logs = await this.#docker.logs(id, GIT_LOG_TAIL);
      const envelope = parseGitEnvelope(
        logs.logs,
        wait.StatusCode ?? 0,
        credentialsMaterialized,
        this.#config,
      );
      return mapGitPayloadRoots(envelope, this.#config) as GitOpPayload;
    } catch (error) {
      if (error instanceof DockerError && error.status === 413) {
        throw new RunnerGitError(
          "output_too_large",
          gitStatusFor("output_too_large"),
          "sandboxed git output exceeded the 8 MiB transport limit",
        );
      }
      if (error instanceof DockerError && /timed out/i.test(error.message)) {
        throw new RunnerGitError("timeout", gitStatusFor("timeout"), "git operation timed out");
      }
      throw error;
    } finally {
      if (id !== undefined) {
        await this.#docker.removeContainer(id, true).catch(() => undefined);
      }
    }
  }

  async test(appId: string, raw: unknown): Promise<{ test: GitTestResult }> {
    let request: GitTestRequest;
    try {
      request = await validateGitTestRequest(raw);
    } catch (error) {
      if (error instanceof GitError) {
        throw new RunnerGitError(error.code, gitStatusFor(error.code), error.message);
      }
      throw error;
    }
    const { image, mounts } = await this.#gitTarget(appId);

    mkdirSync(this.#config.hostRunnerTmp, { recursive: true, mode: 0o700 });
    const tempRoot = path.join(this.#config.hostRunnerTmp, `git-test-${randomUUID()}`);
    mkdirSync(tempRoot, { mode: 0o700 });
    const credentialDir = path.join(tempRoot, "git");
    mkdirSync(credentialDir, { mode: 0o700 });
    try {
      writeGitCredentialFiles(credentialDir, {
        identity: {},
        auth: request.kind === "ssh" ? { ssh: request.ssh } : { https: request.https },
        visibleDir: GIT_CONTAINER_APP_CREDENTIAL_DIR,
        ownership:
          typeof process.getuid === "function" && process.getuid() === 0
            ? { uid: 1000, gid: 1000 }
            : null,
      });
    } catch (error) {
      rmSync(tempRoot, { recursive: true, force: true });
      throw error;
    }

    const containerName = `hanse-git-test-${appId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 40)}-${randomUUID().slice(0, 8)}`;
    const network = appNetworkName(appId);

    let id: string | undefined;
    try {
      id = await this.#docker.createContainer({
        name: containerName,
        image,
        hostname: containerName,
        user: "1000:1000",
        entrypoint: ["/usr/local/bin/hanse"],
        cmd: ["git-op"],
        workingDir: mounts.containerAppDir,
        env: gitTestContainerEnv(request, mounts.containerAppDir),
        labels: { "hanse.git": "true", "hanse.app.id": appId, "hanse.git.test": "true" },
        binds: [
          `${mounts.hostAppDir}:${mounts.containerAppDir}:ro`,
          `${credentialDir}:${GIT_CONTAINER_APP_CREDENTIAL_DIR}:ro`,
        ],
        tmpfs: {
          "/tmp": "rw,nosuid,size=512m",
          "/run": "rw,nosuid,size=16m",
        },
        memoryBytes: GIT_CONTAINER_MEMORY_BYTES,
        nanoCpus: GIT_CONTAINER_NANO_CPUS,
        pidsLimit: GIT_CONTAINER_PIDS_LIMIT,
        networkName: network,
        networkAliases: [],
        networkMode: network,
        restartPolicy: "no",
      });
      await this.#docker.startContainer(id);
      const wait = await this.#docker.waitContainer(id, GIT_TEST_TIMEOUT_MS);
      const logs = await this.#docker.logs(id, GIT_LOG_TAIL);
      const envelope = parseGitEnvelope(logs.logs, wait.StatusCode ?? 0, true, this.#config);
      const test = envelope.test;
      if (!isRecord(test)) {
        throw new RunnerGitError(
          "git_failed",
          gitStatusFor("git_failed"),
          "sandboxed git test returned no result",
        );
      }
      return { test: test as unknown as GitTestResult };
    } catch (error) {
      if (error instanceof DockerError && error.status === 413) {
        throw new RunnerGitError(
          "output_too_large",
          gitStatusFor("output_too_large"),
          "sandboxed git output exceeded the 8 MiB transport limit",
        );
      }
      if (error instanceof DockerError && /timed out/i.test(error.message)) {
        throw new RunnerGitError("timeout", gitStatusFor("timeout"), "git test timed out");
      }
      throw error;
    } finally {
      if (id !== undefined) {
        await this.#docker.removeContainer(id, true).catch(() => undefined);
      }
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        process.stderr.write(`hanse runner: failed to remove git test dir ${tempRoot}\n`);
      }
    }
  }

  createServer(): Server {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        const status = statusFor(error);
        if (status >= 500 && !(error instanceof DockerError)) {
          process.stderr.write(
            `hanse runner: ${request.method ?? "?"} ${request.url ?? "?"} failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
        if (!response.headersSent) {
          writeJson(response, status, errorBody(error));
        } else {
          response.destroy();
        }
      });
    });
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.#handleUpgrade(request, socket, head).catch((error: unknown) => {
        writeSocketResponse(socket, statusFor(error), errorBody(error));
      });
    });
    return server;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (url.pathname === "/healthz") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      try {
        writeJson(response, 200, await this.health());
      } catch (error) {
        writeJson(response, 503, {
          error: `docker unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    const provided = bearerToken(request);
    if (provided === undefined || !tokenMatches(provided, this.#config.token)) {
      writeJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }

    if (url.pathname === "/v1/images/usage") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      writeJson(response, 200, await this.#imageGc.usage());
      return;
    }

    if (url.pathname === "/v1/images/gc") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      writeJson(response, 200, await this.#imageGc.gc(await readOptionalJson(request)));
      return;
    }

    if (url.pathname === "/v1/images/build") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      writeJson(response, 202, await this.#images.start(await readJson(request)));
      return;
    }

    const buildMatch = /^\/v1\/images\/builds\/([^/]+)$/.exec(url.pathname);
    if (buildMatch !== null) {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      let buildId: string;
      try {
        buildId = decodeURIComponent(buildMatch[1] ?? "");
      } catch {
        throw new RunnerError(400, "invalid build id");
      }
      const record = this.#images.getBuild(buildId);
      if (record === undefined) {
        writeJson(response, 404, { error: "unknown build" });
        return;
      }
      writeJson(response, 200, record);
      return;
    }

    if (url.pathname === "/v1/images/inspect") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      writeJson(response, 200, await this.#inspectImageRequest(url));
      return;
    }

    const imageMatch = /^\/v1\/images\/([^/]+)$/.exec(url.pathname);
    if (imageMatch !== null) {
      if (method !== "GET" && method !== "DELETE") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET, DELETE" });
        return;
      }
      let appId: string;
      try {
        appId = decodeURIComponent(imageMatch[1] ?? "");
      } catch {
        throw new RunnerError(400, "invalid app id");
      }
      if (!isValidAppId(appId)) {
        throw new RunnerError(400, "invalid app id");
      }
      if (method === "DELETE") {
        this.#images.beginDelete(appId);
        try {
          const report = await this.#imageGc.purgeApp(appId);
          this.#images.forget(appId);
          writeJson(response, 200, report);
        } finally {
          this.#images.endDelete(appId);
        }
        return;
      }
      writeJson(response, 200, this.#images.get(appId));
      return;
    }

    if (url.pathname === "/v1/reconcile" || url.pathname === "/v1/stop-all") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      if (url.pathname === "/v1/stop-all") {
        writeJson(response, 200, await this.stopAll());
        return;
      }
      const body = await readJson(request);
      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as { appIds?: unknown }).appIds)
      ) {
        throw new RunnerError(400, 'body must be {"appIds": [...]}');
      }
      writeJson(response, 200, await this.reconcile((body as { appIds: unknown[] }).appIds));
      return;
    }

    const gitTestMatch = /^\/v1\/apps\/([^/]+)\/git\/test$/.exec(url.pathname);
    if (gitTestMatch !== null) {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      let appId: string;
      try {
        appId = decodeURIComponent(gitTestMatch[1] ?? "");
      } catch {
        throw new RunnerError(400, "invalid app id");
      }
      if (!isValidAppId(appId)) {
        throw new RunnerError(400, "invalid app id");
      }
      writeJson(response, 200, await this.test(appId, await readJson(request)));
      return;
    }

    const match = /^\/v1\/apps\/([^/]+)(?:\/(ensure|logs|git|exec))?$/.exec(url.pathname);
    if (match === null) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    const rawAppId = match[1];
    if (rawAppId === undefined) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    let appId: string;
    try {
      appId = decodeURIComponent(rawAppId);
    } catch {
      throw new RunnerError(400, "invalid app id");
    }
    if (!isValidAppId(appId)) {
      throw new RunnerError(400, "invalid app id");
    }
    const action = match[2];

    if (action === "ensure") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      writeJson(response, 200, await this.ensure(await readJson(request), appId));
      return;
    }
    if (action === "logs") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      const logs = await this.logs(appId);
      if (logs === undefined) {
        writeJson(response, 404, { error: "unknown app" });
        return;
      }
      writeJson(response, 200, logs);
      return;
    }
    if (action === "git") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      writeJson(response, 200, await this.git(appId, await readJson(request)));
      return;
    }
    if (action === "exec") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      throw new RunnerError(426, "websocket upgrade required");
    }
    if (method === "GET") {
      const status = await this.status(appId);
      if (status === undefined) {
        writeJson(response, 404, { error: "unknown app" });
        return;
      }
      writeJson(response, 200, status);
      return;
    }
    if (method === "DELETE") {
      writeJson(response, 200, await this.delete(appId));
      return;
    }
    writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET, DELETE" });
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/v1\/apps\/([^/]+)\/exec$/.exec(url.pathname);
    if (match === null) {
      writeSocketResponse(socket, 404, { error: "not found" });
      return;
    }
    if ((request.method ?? "GET") !== "GET") {
      writeSocketResponse(socket, 405, { error: "method not allowed" });
      return;
    }
    const provided = bearerToken(request);
    if (provided === undefined || !tokenMatches(provided, this.#config.token)) {
      writeSocketResponse(socket, 401, { error: "unauthorized" });
      return;
    }

    let appId: string;
    try {
      appId = decodeURIComponent(match[1] ?? "");
    } catch {
      writeSocketResponse(socket, 400, { error: "invalid app id" });
      return;
    }
    if (!isValidAppId(appId)) {
      writeSocketResponse(socket, 400, { error: "invalid app id" });
      return;
    }

    const inspect = await this.#docker.inspectContainer(appContainerName(appId));
    const labels = inspect?.Config?.Labels;
    if (
      inspect === undefined ||
      labels?.["hanse.managed"] !== "true" ||
      labels?.["hanse.app.id"] !== appId
    ) {
      writeSocketResponse(socket, 404, { error: "unknown app" });
      return;
    }
    if (inspect.State?.Running !== true) {
      writeSocketResponse(socket, 409, { error: "app is not running" });
      return;
    }

    const handshakeError = websocketHandshakeError(request);
    if (handshakeError !== undefined) {
      writeSocketResponse(socket, 400, { error: handshakeError });
      return;
    }
    if (this.#exec === undefined) {
      writeSocketResponse(socket, 501, { error: "exec is not enabled" });
      return;
    }

    const execId = await this.#exec.createExec(inspect.Id, {
      cmd: ["/bin/sh", "-lc", EXEC_SHELL],
      env: { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8" },
    });
    const stream = await this.#exec.startExec(execId);
    if (!socket.writable) {
      stream.close();
      return;
    }
    const peer = acceptWebSocket(request, socket, head);
    this.#bridgeExec(this.#exec, execId, stream, peer);
  }

  #bridgeExec(
    exec: DockerExecRuntime,
    execId: string,
    stream: DockerExecStream,
    peer: ReturnType<typeof acceptWebSocket>,
  ): void {
    stream.onData((chunk) => {
      if (!peer.send(chunk)) {
        stream.pause();
        peer.onDrain(() => stream.resume());
      }
    });
    peer.onMessage((data, type) => {
      const resize = parseResizeControl(data, type);
      if (resize !== undefined) {
        void exec.resizeExec(execId, resize).catch(() => undefined);
        return;
      }
      stream.write(data);
    });
    stream.onEnd(() => peer.close(1000, "exec ended"));
    stream.onError(() => peer.close(1011, "exec failed"));
    peer.onClose(() => stream.close());
  }

  async #connectCoordinator(network: string): Promise<void> {
    await this.#docker.connectNetwork(network, this.#config.coordinatorContainer, ["hanse"]);
  }

  async #findContainer(appId: string) {
    const containers = await this.#docker.listContainers("hanse.managed=true");
    return containers.find((container) => appIdFromContainer(container) === appId);
  }
}

export interface RunRunnerOptions {
  config: RunnerConfig;
  docker: DockerRuntime;
  exec?: DockerExecRuntime;
  build?: DockerBuildRuntime;
  validation?: ImageValidationRuntime;
  hostname: string;
  port: number;
  onListening?: (address: string) => void;
}

export function sweepStaleGitTestDirs(root: string, now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = now - 60 * 60 * 1000;
  for (const name of entries) {
    if (!name.startsWith("git-test-")) {
      continue;
    }
    const target = path.join(root, name);
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || !info.isDirectory() || info.mtimeMs >= cutoff) {
        continue;
      }
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* skip unreadable or concurrently removed entries */
    }
  }
}

/** Start the runner HTTP server and close it on SIGTERM/SIGINT. */
export async function runRunner(options: RunRunnerOptions): Promise<number> {
  sweepStaleGitTestDirs(options.config.hostRunnerTmp);
  const service = new RunnerService({
    config: options.config,
    docker: options.docker,
    ...(options.exec === undefined ? {} : { exec: options.exec }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.validation === undefined ? {} : { validation: options.validation }),
  });
  const server = service.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      options.onListening?.(
        typeof address === "string"
          ? address
          : `${address?.address ?? options.hostname}:${address?.port ?? options.port}`,
      );
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.hostname);
  });

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      server.closeAllConnections();
      server.close(() => resolve(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}
