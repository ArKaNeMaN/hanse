import { randomUUID } from "node:crypto";
import path from "node:path";
import { isValidAppId } from "../agent/spec.js";
import { resolveWithinRoot } from "../runtime/app-path.js";
import { boundedErrorMessage } from "../runtime/build-spec.js";
import { BuildContextError, createBuildContext, DEFAULT_DOCKERFILE } from "./build-context.js";
import type { DockerBuildRuntime, DockerImageInspect } from "./docker.js";
import {
  type ImageValidationResult,
  type ImageValidationRuntime,
  ImageValidationService,
} from "./image-validation.js";
import { appContainerName } from "./names.js";
import { normalizeImageReference, type RunnerConfig } from "./validate.js";

export const MAX_BUILD_LOG_BYTES = 256 * 1024;
export const BUILD_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
export const BUILD_NANO_CPUS = 2_000_000_000;
export const BUILD_PIDS_LIMIT = 1024;
export const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

const MAX_BUILD_ARGS = 64;
const MAX_BUILD_ARG_KEY_LENGTH = 128;
const MAX_BUILD_ARG_VALUE_LENGTH = 4096;
const RESERVED_BUILD_ARGS: ReadonlySet<string> = new Set(["HANSE_BASE"]);
const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "appId",
  "appDir",
  "dockerfile",
  "baseImage",
  "baseKind",
  "buildArgs",
  "specHash",
  "hashVersion",
]);
const BUILD_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SPEC_HASH = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export type RunnerImageStatus = "missing" | "building" | "ready" | "error";
export type RunnerBaseKind = "default" | "base" | "explicit" | "unknown";

export const RUNNER_BASE_KINDS: ReadonlySet<string> = new Set([
  "default",
  "base",
  "explicit",
  "unknown",
]);

export interface RunnerImageRecord {
  appId: string;
  status: RunnerImageStatus;
  imageRef: string | null;
  imageId: string | null;
  buildId: string | null;
  logs: string;
  error: string | null;
  updatedAt: string | null;
  targetRef: string | null;
  specHash: string | null;
  specHashVersion: number | null;
  hashVersion: number | null;
  baseKind: RunnerBaseKind | null;
  baseRef: string | null;
  baseDigest: string | null;
}

export interface ImageBuildResult {
  readonly buildId: string;
  readonly appId: string;
  readonly status: "building";
  readonly targetRef: string;
}

/** Resolve a manifest digest: explicit `@sha256` first, then exactly one matching RepoDigests entry. */
export function resolveImageDigest(
  reference: string,
  repoDigests: readonly string[] | null | undefined,
): string | null {
  const explicit = digestFromReference(reference);
  if (explicit !== null) return explicit;
  const repository = repositoryOf(reference);
  const matches = new Set<string>();
  for (const entry of repoDigests ?? []) {
    if (typeof entry !== "string") continue;
    const at = entry.indexOf("@");
    if (at <= 0) continue;
    if (entry.slice(0, at) !== repository) continue;
    const digest = entry.slice(at + 1);
    if (DIGEST.test(digest)) matches.add(digest);
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}

function digestFromReference(reference: string): string | null {
  const at = reference.indexOf("@");
  if (at < 0) return null;
  const digest = reference.slice(at + 1);
  return DIGEST.test(digest) ? digest : null;
}

function repositoryOf(reference: string): string {
  const withoutDigest = reference.split("@")[0] ?? reference;
  const colon = withoutDigest.lastIndexOf(":");
  const slash = withoutDigest.lastIndexOf("/");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

export class ImageBuildError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ImageBuildError";
    this.status = status;
    this.code = code;
  }
}

interface ValidatedBuildRequest {
  readonly appId: string;
  readonly appDir: string;
  readonly dockerfile: string;
  readonly baseImage: string;
  readonly baseKind: RunnerBaseKind | null;
  readonly buildArgs: Record<string, string>;
  readonly specHash: string | undefined;
  readonly hashVersion: number | null;
}

interface BuildJob {
  readonly tag: string;
  readonly labels: Record<string, string>;
  readonly request: ValidatedBuildRequest;
  readonly tar: Buffer;
}

export interface ImageBuildServiceOptions {
  readonly config: RunnerConfig;
  readonly build?: DockerBuildRuntime;
  readonly validation?: ImageValidationRuntime;
  readonly inspectImage?: (reference: string) => Promise<DockerImageInspect | undefined>;
}

export class ImageBuildService {
  readonly #config: RunnerConfig;
  readonly #build: DockerBuildRuntime | undefined;
  readonly #validation: ImageValidationRuntime | undefined;
  readonly #inspectImage:
    | ((reference: string) => Promise<DockerImageInspect | undefined>)
    | undefined;
  readonly #byApp = new Map<string, RunnerImageRecord>();
  readonly #byBuild = new Map<string, RunnerImageRecord>();
  readonly #starting = new Map<string, string>();
  readonly #deleting = new Set<string>();
  #active: string | undefined;

  constructor(options: ImageBuildServiceOptions) {
    this.#config = options.config;
    this.#build = options.build;
    this.#validation = options.validation;
    this.#inspectImage = options.inspectImage;
  }

  async start(raw: unknown): Promise<ImageBuildResult> {
    if (this.#build === undefined) {
      throw new ImageBuildError(501, "image builds are not enabled");
    }

    const rawAppId = appIdFromRaw(raw);
    if (rawAppId !== undefined) {
      this.#assertStartAllowed(rawAppId);
    }
    if (this.#active !== undefined) {
      throw new ImageBuildError(409, "another image build is in progress", "build_in_progress");
    }

    const buildId = randomUUID();
    this.#active = buildId;
    if (rawAppId !== undefined) {
      this.#starting.set(rawAppId, buildId);
    }
    try {
      const request = await validateBuildRequest(raw, this.#config);
      this.#assertStartAllowed(request.appId, buildId);
      const context = await createBuildContext(request.appDir, {
        dockerfile: request.dockerfile,
      });
      this.#assertStartAllowed(request.appId, buildId);
      const tag = `${appContainerName(request.appId)}:${buildId}`;
      const baseKind = request.baseKind ?? inferBaseKind(request.baseImage, this.#config);
      const baseDigest =
        baseKind === "unknown" ? null : await this.#resolveBaseDigest(request.baseImage);
      const previous = this.#byApp.get(request.appId);
      const hashVersion = request.hashVersion ?? (request.specHash === undefined ? null : 2);
      const record: RunnerImageRecord = {
        appId: request.appId,
        status: "building",
        imageRef: previous?.imageRef ?? null,
        imageId: previous?.imageId ?? null,
        buildId,
        logs: "",
        error: null,
        updatedAt: new Date().toISOString(),
        targetRef: tag,
        specHash: request.specHash ?? null,
        specHashVersion: hashVersion,
        hashVersion,
        baseKind,
        baseRef: baseKind === "unknown" ? null : request.baseImage,
        baseDigest,
      };
      this.#byApp.set(request.appId, record);
      this.#byBuild.set(buildId, record);

      const job: BuildJob = {
        tag,
        labels: buildLabels(request, baseKind, baseDigest, buildId, this.#config),
        request,
        tar: context.tar,
      };
      void this.#execute(record, job).catch(() => undefined);
      return { buildId, appId: request.appId, status: "building", targetRef: tag };
    } catch (error) {
      if (this.#active === buildId) {
        this.#active = undefined;
      }
      if (rawAppId !== undefined && this.#starting.get(rawAppId) === buildId) {
        this.#starting.delete(rawAppId);
      }
      throw mapBuildError(error);
    }
  }

  get(appId: string): RunnerImageRecord {
    const record = this.#byApp.get(appId);
    const starting = this.#starting.get(appId);
    if (starting !== undefined && (record === undefined || record.buildId !== starting)) {
      return {
        appId,
        status: "building",
        imageRef: record?.imageRef ?? null,
        imageId: record?.imageId ?? null,
        buildId: starting,
        logs: "",
        error: null,
        updatedAt: new Date().toISOString(),
        targetRef: null,
        specHash: null,
        specHashVersion: null,
        hashVersion: null,
        baseKind: null,
        baseRef: null,
        baseDigest: null,
      };
    }
    return record === undefined ? missingRecord(appId) : { ...record };
  }

  getBuild(buildId: string): RunnerImageRecord | undefined {
    const record = this.#byBuild.get(buildId);
    if (record !== undefined) return { ...record };
    const appId = [...this.#starting].find(([, id]) => id === buildId)?.[0];
    return appId === undefined ? undefined : this.get(appId);
  }

  /** Tags of builds that are still running; the image GC unions these into its protected set. */
  protectedBuildTags(): string[] {
    const tags = new Set<string>();
    for (const record of [...this.#byApp.values(), ...this.#byBuild.values()]) {
      if (record.status === "building" && record.targetRef !== null) {
        tags.add(record.targetRef);
      }
    }
    return [...tags];
  }

  beginDelete(appId: string): void {
    if (this.#isBuilding(appId)) {
      throw new ImageBuildError(
        409,
        "an image build is in progress for this app",
        "build_in_progress",
      );
    }
    this.#deleting.add(appId);
  }

  endDelete(appId: string): void {
    this.#deleting.delete(appId);
  }

  forget(appId: string): void {
    if (this.#isBuilding(appId)) {
      throw new ImageBuildError(
        409,
        "an image build is in progress for this app",
        "build_in_progress",
      );
    }
    const buildId = this.#starting.get(appId) ?? this.#byApp.get(appId)?.buildId;
    this.#byApp.delete(appId);
    for (const [id, record] of this.#byBuild) {
      if (record.appId === appId) {
        this.#byBuild.delete(id);
      }
    }
    this.#starting.delete(appId);
    if (buildId !== undefined && this.#active === buildId) {
      this.#active = undefined;
    }
  }

  #isBuilding(appId: string): boolean {
    return this.#starting.has(appId) || this.#byApp.get(appId)?.status === "building";
  }

  #assertStartAllowed(appId: string, buildId?: string): void {
    if (this.#deleting.has(appId)) {
      throw new ImageBuildError(
        409,
        "an image deletion is in progress for this app",
        "build_in_progress",
      );
    }
    if (buildId !== undefined) {
      if (this.#starting.get(appId) !== buildId) {
        throw new ImageBuildError(409, "image build was superseded", "build_in_progress");
      }
      return;
    }
    if (this.#isBuilding(appId)) {
      throw new ImageBuildError(
        409,
        "an image build is already in progress for this app",
        "build_in_progress",
      );
    }
  }

  async #execute(record: RunnerImageRecord, job: BuildJob): Promise<void> {
    const build = this.#build;
    if (build === undefined) return;
    try {
      const result = await build.buildImage({
        tag: job.tag,
        dockerfile: job.request.dockerfile,
        tar: job.tar,
        baseImage: job.request.baseImage,
        buildArgs: { ...job.request.buildArgs, HANSE_BASE: job.request.baseImage },
        labels: job.labels,
        memoryBytes: BUILD_MEMORY_BYTES,
        nanoCpus: BUILD_NANO_CPUS,
        pidsLimit: BUILD_PIDS_LIMIT,
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      record.logs = boundedLogs(result.logs);
      if (result.error !== null || result.imageId === null) {
        record.status = "error";
        record.error = boundedErrorMessage(
          result.error ?? new Error("docker build completed without an image id"),
        );
      } else {
        const validation = await this.#validateImage(job.tag, job.request.appId);
        if (validation !== undefined) {
          record.logs = boundedLogs(
            `${record.logs}${record.logs.endsWith("\n") || record.logs.length === 0 ? "" : "\n"}${
              validation.logs
            }`,
          );
        }
        if (validation !== undefined && !validation.ok) {
          record.status = "error";
          record.error = boundedErrorMessage(
            new Error(validation.error ?? "image validation failed"),
          );
        } else {
          record.status = "ready";
          record.imageRef = job.tag;
          record.imageId = result.imageId;
          record.error = null;
        }
      }
    } catch (error) {
      record.status = "error";
      record.error = boundedErrorMessage(error);
    } finally {
      record.updatedAt = new Date().toISOString();
      if (this.#active === record.buildId) {
        this.#active = undefined;
      }
      if (this.#starting.get(record.appId) === record.buildId) {
        this.#starting.delete(record.appId);
      }
    }
  }

  async #validateImage(
    imageRef: string,
    appId: string,
  ): Promise<ImageValidationResult | undefined> {
    if (this.#validation === undefined) return undefined;
    return new ImageValidationService({ runtime: this.#validation }).validate(imageRef, appId);
  }

  async #resolveBaseDigest(reference: string): Promise<string | null> {
    const explicit = digestFromReference(reference);
    if (explicit !== null) return explicit;
    if (this.#inspectImage === undefined) return null;
    let inspected: DockerImageInspect | undefined;
    try {
      inspected = await this.#inspectImage(reference);
    } catch {
      return null;
    }
    return resolveImageDigest(reference, inspected?.RepoDigests);
  }
}

function appIdFromRaw(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const appId = (raw as Record<string, unknown>).appId;
  return isValidAppId(appId) ? appId : undefined;
}

function missingRecord(appId: string): RunnerImageRecord {
  return {
    appId,
    status: "missing",
    imageRef: null,
    imageId: null,
    buildId: null,
    logs: "",
    error: null,
    updatedAt: null,
    targetRef: null,
    specHash: null,
    specHashVersion: null,
    hashVersion: null,
    baseKind: null,
    baseRef: null,
    baseDigest: null,
  };
}

function buildLabels(
  request: ValidatedBuildRequest,
  baseKind: RunnerBaseKind,
  baseDigest: string | null,
  buildId: string,
  config: RunnerConfig,
): Record<string, string> {
  const baseRef = baseKind === "unknown" ? null : request.baseImage;
  return {
    "hanse.app.id": request.appId,
    "hanse.image.version": request.specHash ?? buildId,
    "hanse.base.kind": baseKind,
    ...(baseRef === null ? {} : { "hanse.base.ref": baseRef }),
    ...(baseDigest === null ? {} : { "hanse.base.digest": baseDigest }),
    "hanse.default.digest": digestOrReference(config.defaultImage ?? request.baseImage),
  };
}

function inferBaseKind(baseImage: string, config: RunnerConfig): RunnerBaseKind {
  if (config.defaultImage !== undefined && baseImage === config.defaultImage) return "default";
  if (config.baseImage !== undefined && baseImage === config.baseImage) return "base";
  return "explicit";
}

function digestOrReference(reference: string): string {
  const at = reference.indexOf("@");
  return at < 0 ? reference : reference.slice(at + 1);
}

async function validateBuildRequest(
  raw: unknown,
  config: RunnerConfig,
): Promise<ValidatedBuildRequest> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ImageBuildError(400, "build request must be a JSON object");
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) {
      throw new ImageBuildError(400, `unsupported build option: ${key}`);
    }
  }

  const appId = value.appId;
  if (!isValidAppId(appId)) {
    throw new ImageBuildError(400, "appId must be a safe single path segment");
  }

  const rawAppDir = value.appDir;
  if (
    typeof rawAppDir !== "string" ||
    rawAppDir.length === 0 ||
    rawAppDir.includes("\0") ||
    !path.isAbsolute(rawAppDir)
  ) {
    throw new ImageBuildError(400, "appDir must be an absolute host path");
  }
  const appDir = resolveWithinRoot({
    target: rawAppDir,
    root: config.hostWorkspace,
    label: "appDir",
  });

  const dockerfile = value.dockerfile ?? DEFAULT_DOCKERFILE;
  if (typeof dockerfile !== "string" || !isSafeDockerfile(dockerfile)) {
    throw new ImageBuildError(400, "dockerfile must be a safe relative path inside the app");
  }

  const rawBaseImage = value.baseImage;
  const baseImage =
    typeof rawBaseImage === "string" ? normalizeImageReference(rawBaseImage) : undefined;
  if (baseImage === undefined) {
    throw new ImageBuildError(400, "baseImage must be a non-empty image reference");
  }
  if (
    !config.allowedImages.has(baseImage) &&
    baseImage !== config.defaultImage &&
    baseImage !== config.baseImage
  ) {
    throw new ImageBuildError(400, `baseImage is not allowed by the runner: ${baseImage}`);
  }

  const baseKind = parseBaseKind(value.baseKind);

  const buildArgs = parseBuildArgs(value.buildArgs);

  const specHash = value.specHash;
  if (specHash !== undefined && (typeof specHash !== "string" || !SPEC_HASH.test(specHash))) {
    throw new ImageBuildError(400, "specHash must be a 64-character lowercase hex digest");
  }

  const hashVersion = parseHashVersion(value.hashVersion);

  return { appId, appDir, dockerfile, baseImage, baseKind, buildArgs, specHash, hashVersion };
}

function parseBaseKind(value: unknown): RunnerBaseKind | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !RUNNER_BASE_KINDS.has(value)) {
    throw new ImageBuildError(400, "baseKind must be one of default, base, explicit, or unknown");
  }
  return value as RunnerBaseKind;
}

function parseHashVersion(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2) {
    throw new ImageBuildError(400, "hashVersion must be 1 or 2");
  }
  return value;
}

function isSafeDockerfile(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  return !value
    .split(/[\\/]/)
    .some((segment) => segment === "" || segment === "." || segment === "..");
}

function parseBuildArgs(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImageBuildError(400, "buildArgs must be an object of string values");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_BUILD_ARGS) {
    throw new ImageBuildError(400, `buildArgs must contain at most ${MAX_BUILD_ARGS} entries`);
  }
  const result: Record<string, string> = {};
  for (const [key, argument] of entries) {
    if (key.length > MAX_BUILD_ARG_KEY_LENGTH || !BUILD_ARG_KEY.test(key)) {
      throw new ImageBuildError(400, `unsafe build argument name: ${key}`);
    }
    if (RESERVED_BUILD_ARGS.has(key)) {
      throw new ImageBuildError(400, `build argument ${key} is reserved`);
    }
    if (typeof argument !== "string") {
      throw new ImageBuildError(400, `build argument ${key} must be a string`);
    }
    if (argument.length > MAX_BUILD_ARG_VALUE_LENGTH || /[\0\r\n]/.test(argument)) {
      throw new ImageBuildError(400, `unsafe build argument value for ${key}`);
    }
    result[key] = argument;
  }
  return result;
}

function boundedLogs(text: string): string {
  const sanitized = stripControlCharacters(text);
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.length <= MAX_BUILD_LOG_BYTES) return sanitized;
  const tail = bytes.subarray(bytes.length - MAX_BUILD_LOG_BYTES).toString("utf8");
  return `[logs truncated]\n${tail}`;
}

function stripControlCharacters(text: string): string {
  return Array.from(text, (character) => {
    if (character === "\n" || character === "\t") return character;
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "" : character;
  }).join("");
}

function mapBuildError(error: unknown): Error {
  if (error instanceof ImageBuildError) return error;
  if (error instanceof BuildContextError) {
    return new ImageBuildError(400, boundedErrorMessage(error), error.code);
  }
  return error instanceof Error ? error : new Error(String(error));
}
