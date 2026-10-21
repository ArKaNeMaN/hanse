import { randomUUID } from "node:crypto";
import path from "node:path";
import { isValidAppId } from "../agent/spec.js";
import { resolveWithinRoot } from "../runtime/app-path.js";
import { boundedErrorMessage } from "../runtime/build-spec.js";
import { BuildContextError, createBuildContext, DEFAULT_DOCKERFILE } from "./build-context.js";
import type { DockerBuildRuntime } from "./docker.js";
import {
  type ImageValidationResult,
  type ImageValidationRuntime,
  ImageValidationService,
} from "./image-validation.js";
import { appContainerName } from "./names.js";
import type { RunnerConfig } from "./validate.js";

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
  "buildArgs",
  "specHash",
]);
const BUILD_ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SPEC_HASH = /^[a-f0-9]{64}$/;

export type RunnerImageStatus = "missing" | "building" | "ready" | "error";

export interface RunnerImageRecord {
  appId: string;
  status: RunnerImageStatus;
  imageRef: string | null;
  imageId: string | null;
  buildId: string | null;
  logs: string;
  error: string | null;
  updatedAt: string | null;
}

export interface ImageBuildResult {
  readonly buildId: string;
  readonly appId: string;
  readonly status: "building";
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
  readonly buildArgs: Record<string, string>;
  readonly specHash: string | undefined;
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
}

export class ImageBuildService {
  readonly #config: RunnerConfig;
  readonly #build: DockerBuildRuntime | undefined;
  readonly #validation: ImageValidationRuntime | undefined;
  readonly #byApp = new Map<string, RunnerImageRecord>();
  readonly #byBuild = new Map<string, RunnerImageRecord>();
  readonly #starting = new Map<string, string>();
  readonly #deleting = new Set<string>();
  #active: string | undefined;

  constructor(options: ImageBuildServiceOptions) {
    this.#config = options.config;
    this.#build = options.build;
    this.#validation = options.validation;
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
      const previous = this.#byApp.get(request.appId);
      const record: RunnerImageRecord = {
        appId: request.appId,
        status: "building",
        imageRef: previous?.imageRef ?? null,
        imageId: previous?.imageId ?? null,
        buildId,
        logs: "",
        error: null,
        updatedAt: new Date().toISOString(),
      };
      this.#byApp.set(request.appId, record);
      this.#byBuild.set(buildId, record);

      const job: BuildJob = {
        tag,
        labels: buildLabels(request, buildId, this.#config),
        request,
        tar: context.tar,
      };
      void this.#execute(record, job).catch(() => undefined);
      return { buildId, appId: request.appId, status: "building" };
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
      };
    }
    return record === undefined ? missingRecord(appId) : { ...record };
  }

  getBuild(buildId: string): RunnerImageRecord | undefined {
    const record = this.#byBuild.get(buildId);
    return record === undefined ? undefined : { ...record };
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
  };
}

function buildLabels(
  request: ValidatedBuildRequest,
  buildId: string,
  config: RunnerConfig,
): Record<string, string> {
  return {
    "hanse.app.id": request.appId,
    "hanse.image.version": request.specHash ?? buildId,
    "hanse.base.digest": digestOrReference(request.baseImage),
    "hanse.default.digest": digestOrReference(config.defaultImage ?? request.baseImage),
  };
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

  const baseImage = value.baseImage;
  if (
    typeof baseImage !== "string" ||
    baseImage.length === 0 ||
    /\s/.test(baseImage) ||
    baseImage.includes("\0")
  ) {
    throw new ImageBuildError(400, "baseImage must be a non-empty image reference");
  }
  if (!config.allowedImages.has(baseImage) && baseImage !== config.defaultImage) {
    throw new ImageBuildError(400, `baseImage is not allowed by the runner: ${baseImage}`);
  }

  const buildArgs = parseBuildArgs(value.buildArgs);

  const specHash = value.specHash;
  if (specHash !== undefined && (typeof specHash !== "string" || !SPEC_HASH.test(specHash))) {
    throw new ImageBuildError(400, "specHash must be a 64-character lowercase hex digest");
  }

  return { appId, appDir, dockerfile, baseImage, buildArgs, specHash };
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
