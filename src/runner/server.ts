import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
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
import { isGitErrorCode } from "../git/errors.js";
import {
  GIT_SANDBOX_APP_DIR_ENV,
  GIT_SANDBOX_BRANCH_ENV,
  GIT_SANDBOX_MESSAGE_ENV,
  GIT_SANDBOX_OPERATION_ENV,
  type GitOpPayload,
} from "../git/op.js";
import { type GitOperation, type GitRequest, validateGitRequest } from "../git/request.js";
import { isInside, resolveWithinRoot } from "../runtime/app-path.js";
import { VERSION } from "../version.js";
import {
  type DockerBuildRuntime,
  type DockerContainerInspect,
  DockerError,
  type DockerExecRuntime,
  type DockerExecSize,
  type DockerExecStream,
  type DockerRuntime,
} from "./docker.js";
import { ImageBuildError, ImageBuildService } from "./images.js";
import { appContainerName, appNetworkName } from "./names.js";
import {
  hostPathForSpecEnv,
  RUNNER_APP_PORT,
  RUNNER_CONTAINER_WORKSPACE_ROOT,
  type RunnerConfig,
  type RunnerSpec,
  validateRunnerSpec,
} from "./validate.js";
import { acceptWebSocket, websocketHandshakeError } from "./ws.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECONCILE_APPS = 1000;
const DEFAULT_LOG_TAIL = 500;
const RUNNER_ENTRYPOINT = "/usr/local/bin/hanse-agent-entrypoint";
const EXEC_SHELL = "if [ -x /bin/bash ]; then exec /bin/bash -l; fi; exec /bin/sh -l";
const MAX_EXEC_DIMENSION = 1000;
const GIT_CONTAINER_GIT_DIR = "/run/hanse/git";
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
const GIT_FILE_ENV_KEYS = new Set([
  "HANSE_GIT_SSH_KEY",
  "HANSE_GIT_KNOWN_HOSTS",
  "HANSE_GIT_ASKPASS",
  "HANSE_GIT_SSL_CAINFO",
]);

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
    ...(inspect.State?.Error === undefined ? {} : { error: inspect.State.Error }),
  };
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

function translateGitPath(key: string, value: string, hostGitDir?: string): string {
  if (!GIT_FILE_ENV_KEYS.has(key) || !path.isAbsolute(value) || hostGitDir === undefined) {
    return value;
  }
  if (!isInside(hostGitDir, value)) return value;
  const relative = path.relative(hostGitDir, value);
  return path.posix.join(GIT_CONTAINER_GIT_DIR, ...relative.split(path.sep));
}

function gitContainerEnv(
  request: GitRequest,
  containerAppDir: string,
  config: RunnerConfig,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/hanse-git-home",
    TMPDIR: "/tmp",
    LC_ALL: "C",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    [GIT_SANDBOX_OPERATION_ENV]: request.operation,
    [GIT_SANDBOX_APP_DIR_ENV]: containerAppDir,
  };
  if (request.branch !== undefined) {
    env[GIT_SANDBOX_BRANCH_ENV] = request.branch;
  }
  if (request.message !== undefined) {
    env[GIT_SANDBOX_MESSAGE_ENV] = request.message;
  }
  for (const [key, value] of Object.entries(config.gitEnv ?? {})) {
    if (value === undefined || value.length === 0) continue;
    env[key] = translateGitPath(key, value, config.hostGitDir);
  }
  return env;
}

function hasGitCredentials(config: RunnerConfig): boolean {
  const env = config.gitEnv ?? {};
  return [
    "HANSE_GIT_TOKEN",
    "HANSE_GIT_SSH_COMMAND",
    "HANSE_GIT_SSH_KEY",
    "HANSE_GIT_ASKPASS",
  ].some((key) => (env[key] ?? "").trim().length > 0);
}

function parseGitEnvelope(logs: string, exitCode: number, config: RunnerConfig): GitEnvelope {
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
      !hasGitCredentials(config) &&
      !/credentials are not configured/i.test(message)
    ) {
      message = `${message} Git credentials are not configured for the runner.`;
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
}

/** Per-app container runtime behind the same API shape as the B0 supervisor. */
export class RunnerService {
  readonly #config: RunnerConfig;
  readonly #docker: DockerRuntime;
  readonly #exec: DockerExecRuntime | undefined;
  readonly #images: ImageBuildService;

  constructor(options: RunnerServiceOptions) {
    this.#config = options.config;
    this.#docker = options.docker;
    this.#exec = options.exec;
    this.#images = new ImageBuildService({
      config: options.config,
      ...(options.build === undefined ? {} : { build: options.build }),
    });
  }

  async health(): Promise<RuntimeHealth> {
    const containers = await this.#docker.listContainers("hanse.managed=true");
    return { ok: true, hanseVersion: VERSION, apps: containers.length };
  }

  async ensure(raw: unknown, expectedAppId?: string): Promise<RuntimeAppStatus> {
    const spec = validateRunnerSpec(raw, this.#config);
    if (expectedAppId !== undefined && spec.appId !== expectedAppId) {
      throw new RunnerError(400, "appId in the path does not match the spec");
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
      if (existing.State?.Running !== true) {
        await this.#docker.startContainer(existing.Id);
      }
      await this.#connectCoordinator(spec.networkName);
      const inspected = await this.#docker.inspectContainer(spec.containerName);
      if (inspected === undefined) {
        throw new RunnerError(502, "container disappeared after start");
      }
      return statusFromInspect(spec.appId, spec.containerName, inspected);
    }

    if (existing !== undefined) {
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
      },
      binds: [
        `${spec.hostAppDir}:${spec.containerAppDir}:rw`,
        `${spec.hostAgentsRoot}:${spec.containerAgentsRoot}:rw`,
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
      return stoppedStatus(appId);
    }
    const inspect = await this.#docker.inspectContainer(summary.Id);
    const network = inspect?.Config?.Labels?.["hanse.network.name"] ?? appNetworkName(appId);
    await this.#docker.stopContainer(summary.Id);
    await this.#docker.removeContainer(summary.Id, true);
    await this.#docker
      .disconnectNetwork(network, this.#config.coordinatorContainer)
      .catch(() => undefined);
    await this.#docker.removeNetwork(network).catch(() => undefined);
    return {
      ...stoppedStatus(appId),
      specHash: inspect?.Config?.Labels?.["hanse.spec.hash"] ?? null,
    };
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

  async git(appId: string, raw: unknown): Promise<GitOpPayload> {
    const request = validateGitRequest(raw);
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
      throw new RunnerError(409, "app is not running");
    }
    const image = inspect.Config?.Image;
    if (image === undefined || !this.#config.allowedImages.has(image)) {
      throw new RunnerError(400, "app image is not allowed by the runner");
    }
    const mounts = gitContainerMounts(inspect, this.#config);
    if (mounts === undefined) {
      throw new RunnerError(409, "app container has no workspace mount");
    }

    const network = !GIT_NETWORK_OPERATIONS.has(request.operation) ? "none" : appNetworkName(appId);
    const timeout = GIT_TIMEOUTS[request.operation];
    const containerName = `hanse-git-${appId.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 40)}-${randomUUID().slice(0, 8)}`;

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
        env: gitContainerEnv(request, mounts.containerAppDir, this.#config),
        labels: { "hanse.git": "true", "hanse.app.id": appId },
        binds: [
          `${mounts.hostAppDir}:${mounts.containerAppDir}:rw`,
          ...(this.#config.hostGitDir === undefined
            ? []
            : [`${this.#config.hostGitDir}:${GIT_CONTAINER_GIT_DIR}:ro`]),
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
      const envelope = parseGitEnvelope(logs.logs, wait.StatusCode ?? 0, this.#config);
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

    const imageMatch = /^\/v1\/images\/([^/]+)$/.exec(url.pathname);
    if (imageMatch !== null) {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
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
  hostname: string;
  port: number;
  onListening?: (address: string) => void;
}

/** Start the runner HTTP server and close it on SIGTERM/SIGINT. */
export async function runRunner(options: RunRunnerOptions): Promise<number> {
  const service = new RunnerService({
    config: options.config,
    docker: options.docker,
    ...(options.exec === undefined ? {} : { exec: options.exec }),
    ...(options.build === undefined ? {} : { build: options.build }),
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
