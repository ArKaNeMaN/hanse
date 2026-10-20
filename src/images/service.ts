import { ConfigError } from "../config/load.js";
import type { AppBuildInspection, AppImageStatus } from "../registry/index.js";
import { resolveAppBuild } from "../registry/index.js";
import { mapToHostPath } from "../runner/names.js";
import { resolveAppPath } from "../runtime/app-path.js";
import { boundedErrorMessage } from "../runtime/build-spec.js";
import type { SqliteDatabase } from "../store/index.js";
import type { ImageBuildInput, ImageBuildResult, RunnerImageRecord } from "./client.js";
import { ImageClientError } from "./client.js";

export interface ImageServiceOptions {
  db: SqliteDatabase;
  /** Coordinator-visible workspace root used to contain app paths. */
  workspaceRoot: string;
  /** Host path the runner sees for the same workspace. */
  hostWorkspace: string;
  /** Default/base agent image reference, including an optional digest. */
  defaultImage: string;
  runner: ImageRunnerClient;
}

/** Build runners are injected so tests never need Docker or a live runner. */
export interface ImageRunnerClient {
  build(input: ImageBuildInput): Promise<ImageBuildResult>;
  get(appId: string): Promise<RunnerImageRecord>;
  getBuild(buildId: string): Promise<RunnerImageRecord | undefined>;
}

export interface AppImageStatusView {
  appId: string;
  appKey: string;
  status: AppImageStatus;
  imageRef: string | null;
  imageId: string | null;
  buildId: string | null;
  hash: string | null;
  currentHash: string | null;
  baseDigest: string | null;
  builtAt: string | null;
  error: string | null;
  updatedAt: string | null;
  runnerAvailable: boolean;
}

export interface AppImageLogsView {
  appId: string;
  buildId: string | null;
  status: AppImageStatus;
  logs: string;
  runnerAvailable: boolean;
}

/** Typed image-service failure; the HTTP layer maps `status`/`code` directly. */
export class ImageServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "ImageServiceError";
    this.status = status;
    this.code = code;
  }
}

interface AppRow {
  id: string;
  project_id: string;
  app_key: string;
  path: string;
  root_path: string;
  image_ref: string | null;
  image_status: AppImageStatus;
  image_hash: string | null;
  image_base_digest: string | null;
  image_built_at: string | null;
  image_error: string | null;
}

interface BuildMeta {
  appId: string;
  specHash: string;
  baseDigest: string;
}

interface ResolvedBuild {
  appDir: string;
  hostAppDir: string;
  dockerfile: string;
  buildArgs: Record<string, string>;
  specHash: string;
}

const MAX_LOG_BYTES = 64 * 1024;

/**
 * Human-triggered app image builds.
 *
 * The service is the only place the coordinator turns a registered app into a runner build request:
 * it re-reads the live manifest/Dockerfile (never a stale DB snapshot), enforces one in-flight build
 * per app, proxies status/logs, and persists the bounded image metadata in the coordinator DB.
 */
export class ImageService {
  readonly #db: SqliteDatabase;
  readonly #workspaceRoot: string;
  readonly #hostWorkspace: string;
  readonly #defaultImage: string;
  readonly #runner: ImageRunnerClient;
  readonly #active = new Map<string, string>();
  readonly #builds = new Map<string, BuildMeta>();

  constructor(options: ImageServiceOptions) {
    this.#db = options.db;
    this.#workspaceRoot = options.workspaceRoot;
    this.#hostWorkspace = options.hostWorkspace;
    this.#defaultImage = options.defaultImage;
    this.#runner = options.runner;
  }

  /** Start one human-requested build. Never triggered by file changes or registration. */
  async build(appId: string, appKey?: string): Promise<ImageBuildResult> {
    const app = this.#getApp(appId);
    if (appKey !== undefined && app.app_key !== appKey) {
      throw new ImageServiceError(404, "application not found", "not_found");
    }
    if (this.#active.has(appId)) {
      throw new ImageServiceError(
        409,
        "an image build is already running for this app",
        "build_in_progress",
      );
    }
    const spec = this.#resolveBuild(app);

    this.#active.set(appId, "pending");
    let result: ImageBuildResult;
    try {
      result = await this.#runner.build({
        appId: app.id,
        appDir: spec.hostAppDir,
        dockerfile: spec.dockerfile,
        baseImage: this.#defaultImage,
        buildArgs: spec.buildArgs,
        specHash: spec.specHash,
      });
    } catch (error) {
      this.#active.delete(appId);
      throw this.#runnerFailure(error);
    }

    this.#active.set(appId, result.buildId);
    this.#builds.set(result.buildId, {
      appId,
      specHash: spec.specHash,
      baseDigest: digestFromReference(this.#defaultImage),
    });
    this.#db
      .prepare("UPDATE apps SET image_status = 'building', image_error = NULL WHERE id = ?")
      .run(appId);
    return result;
  }

  /** Refresh the DB from the runner and return the bounded status view. */
  async status(appId: string): Promise<AppImageStatusView> {
    let app = this.#getApp(appId);
    const inspection = this.#inspect(app);
    let record: RunnerImageRecord;
    try {
      record = await this.#runner.get(appId);
    } catch (error) {
      if (!(error instanceof ImageClientError)) {
        throw error;
      }
      return this.#view(app, inspection, {
        buildId: null,
        imageId: null,
        runnerAvailable: false,
      });
    }

    this.#applyRecord(app, inspection, record);
    app = this.#getApp(appId);
    return this.#view(app, inspection, {
      buildId: record.buildId,
      imageId: record.imageId,
      updatedAt: record.updatedAt,
      runnerAvailable: true,
    });
  }

  /** Return the bounded build log tail for the app's current (or last) build. */
  async logs(appId: string): Promise<AppImageLogsView> {
    const app = this.#getApp(appId);
    let record: RunnerImageRecord;
    try {
      record = await this.#runner.get(appId);
      if (record.buildId !== null) {
        const byBuild = await this.#runner.getBuild(record.buildId).catch(() => undefined);
        if (byBuild !== undefined) {
          record = byBuild;
        }
      }
    } catch (error) {
      if (!(error instanceof ImageClientError)) {
        throw error;
      }
      return {
        appId,
        buildId: null,
        status: app.image_status,
        logs: "",
        runnerAvailable: false,
      };
    }
    return {
      appId,
      buildId: record.buildId,
      status: record.status,
      logs: sanitizeLogs(record.logs, [this.#hostWorkspace, this.#workspaceRoot]),
      runnerAvailable: true,
    };
  }

  #applyRecord(app: AppRow, inspection: AppBuildInspection, record: RunnerImageRecord): void {
    const activeBuildId = this.#active.get(app.id);
    const meta = record.buildId === null ? undefined : this.#builds.get(record.buildId);

    if (record.status === "building") {
      if (record.buildId !== null && activeBuildId === undefined) {
        this.#active.set(app.id, record.buildId);
      }
      this.#db
        .prepare("UPDATE apps SET image_status = 'building', image_error = NULL WHERE id = ?")
        .run(app.id);
      return;
    }

    if (record.status === "ready") {
      const builtHash = meta?.specHash ?? app.image_hash ?? inspection.specHash;
      const builtBase =
        meta?.baseDigest ?? app.image_base_digest ?? digestFromReference(this.#defaultImage);
      const stale =
        inspection.specHash !== null && builtHash !== null && inspection.specHash !== builtHash;
      this.#db
        .prepare(
          `UPDATE apps SET
             image_status = @status,
             image_ref = @image_ref,
             image_hash = @image_hash,
             image_base_digest = @image_base_digest,
             image_built_at = @image_built_at,
             image_error = NULL
           WHERE id = @id`,
        )
        .run({
          id: app.id,
          status: stale ? "stale" : "ready",
          image_ref: record.imageRef,
          image_hash: builtHash,
          image_base_digest: builtBase,
          image_built_at: record.updatedAt ?? new Date().toISOString(),
        });
      this.#finish(app.id, record.buildId);
      return;
    }

    if (record.status === "error") {
      this.#db
        .prepare("UPDATE apps SET image_status = 'error', image_error = @error WHERE id = @id")
        .run({
          id: app.id,
          error: boundedErrorMessage(new Error(record.error ?? "image build failed")),
        });
      this.#finish(app.id, record.buildId);
      return;
    }

    // A runner restart forgets in-memory build records. Never downgrade a durable ready image, but
    // do not leave an interrupted `building` row stuck forever without a human action.
    if (app.image_ref === null && app.image_status === "building" && activeBuildId === undefined) {
      this.#db
        .prepare("UPDATE apps SET image_status = 'error', image_error = ? WHERE id = ?")
        .run("build state was lost; retry the image build", app.id);
    }
    this.#finish(app.id, record.buildId);
  }

  #finish(appId: string, buildId: string | null): void {
    if (buildId !== null) {
      this.#builds.delete(buildId);
      if (this.#active.get(appId) === buildId) {
        this.#active.delete(appId);
      }
    } else if (this.#active.get(appId) !== "pending") {
      this.#active.delete(appId);
    }
  }

  #runnerFailure(error: unknown): ImageServiceError {
    if (error instanceof ImageClientError) {
      if (error.transport) {
        return new ImageServiceError(502, "the image runner is unavailable", "runner_unavailable");
      }
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return new ImageServiceError(status, error.message, error.code ?? "runner_rejected");
    }
    return new ImageServiceError(
      502,
      `image runner request failed: ${boundedErrorMessage(error)}`,
      "runner_unavailable",
    );
  }

  #resolveBuild(app: AppRow): ResolvedBuild {
    const appDir = this.#appDir(app);
    const inspection = resolveAppBuild(appDir, this.#defaultImage);
    if (inspection.status === "error") {
      throw new ImageServiceError(
        409,
        `application image configuration is invalid: ${inspection.error ?? "unknown error"}`,
        "invalid_build",
      );
    }
    if (
      inspection.dockerfile === null ||
      inspection.relativeDockerfile === null ||
      inspection.specHash === null
    ) {
      throw new ImageServiceError(
        409,
        "application has no image build configured",
        "not_build_configured",
      );
    }
    let hostAppDir: string;
    try {
      hostAppDir = mapToHostPath(this.#workspaceRoot, appDir, this.#hostWorkspace, "appDir");
    } catch {
      throw new ImageServiceError(
        400,
        "application path cannot be mapped to the runner workspace",
        "outside_workspace",
      );
    }
    return {
      appDir,
      hostAppDir,
      dockerfile: inspection.relativeDockerfile,
      buildArgs: inspection.args,
      specHash: inspection.specHash,
    };
  }

  #inspect(app: AppRow): AppBuildInspection {
    try {
      return resolveAppBuild(this.#appDir(app), this.#defaultImage);
    } catch (error) {
      return {
        status: "error",
        error: boundedErrorMessage(error),
        dockerfile: null,
        relativeDockerfile: null,
        args: {},
        specHash: null,
      };
    }
  }

  #appDir(app: AppRow): string {
    try {
      return resolveAppPath({
        appPath: app.path,
        projectRoot: app.root_path,
        workspaceRoot: this.#workspaceRoot,
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new ImageServiceError(403, error.message, "outside_workspace");
      }
      throw error;
    }
  }

  #getApp(appId: string): AppRow {
    const row = this.#db
      .prepare(
        `SELECT a.id, a.project_id, a.app_key, a.path,
                a.image_ref, a.image_status, a.image_hash,
                a.image_base_digest, a.image_built_at, a.image_error,
                p.root_path
         FROM apps a
         JOIN projects p ON p.id = a.project_id
         WHERE a.id = ?`,
      )
      .get(appId) as AppRow | undefined;
    if (row === undefined) {
      throw new ImageServiceError(404, "application not found", "not_found");
    }
    return row;
  }

  #view(
    app: AppRow,
    inspection: AppBuildInspection,
    extra: {
      buildId: string | null;
      imageId: string | null;
      updatedAt?: string | null;
      runnerAvailable: boolean;
    },
  ): AppImageStatusView {
    return {
      appId: app.id,
      appKey: app.app_key,
      status: app.image_status,
      imageRef: app.image_ref,
      imageId: extra.imageId,
      buildId: extra.buildId,
      hash: app.image_hash,
      currentHash: inspection.specHash,
      baseDigest: app.image_base_digest,
      builtAt: app.image_built_at,
      error: app.image_error,
      updatedAt: extra.updatedAt ?? app.image_built_at,
      runnerAvailable: extra.runnerAvailable,
    };
  }
}

function digestFromReference(reference: string): string {
  const at = reference.indexOf("@");
  return at < 0 ? reference : reference.slice(at + 1);
}

/** Keep the tail of a build log, strip control bytes, and redact known host paths/tokens. */
export function sanitizeLogs(text: string, roots: readonly string[]): string {
  let cleaned = Array.from(text, (character) => {
    if (character === "\n" || character === "\t") {
      return character;
    }
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "" : character;
  }).join("");

  for (const root of [...new Set(roots)]
    .filter((entry) => entry.length > 0)
    .sort((left, right) => right.length - left.length)) {
    cleaned = cleaned.split(root).join("<workspace>");
  }
  cleaned = cleaned
    .replace(/(Bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/(HANSE_RUNTIME_TOKEN\s*=\s*)[^\s]+/gi, "$1<redacted>");

  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.length <= MAX_LOG_BYTES) {
    return cleaned;
  }
  return `[logs truncated]\n${bytes.subarray(bytes.length - MAX_LOG_BYTES).toString("utf8")}`;
}
