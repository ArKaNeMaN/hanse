import { ConfigError } from "../config/load.js";
import type { DeploymentLock } from "../coordinator/deployment-lock.js";
import type { LifecycleActivity } from "../coordinator/lifecycle-activity.js";
import type { AppBuildInspection, AppImageStatus } from "../registry/index.js";
import { resolveAppBuild } from "../registry/index.js";
import type { ImageGcReport, ImageUsageReport } from "../runner/image-gc.js";
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
  /** Advisory external deployment lock; builds and rollbacks are destructive. */
  deploymentLock?: DeploymentLock;
  /** Process-local destructive-operation counter; the CLI leaves this unset. */
  lifecycleActivity?: LifecycleActivity;
}

/** Build runners are injected so tests never need Docker or a live runner. */
export interface ImageRunnerClient {
  build(input: ImageBuildInput): Promise<ImageBuildResult>;
  get(appId: string): Promise<RunnerImageRecord>;
  getBuild(buildId: string): Promise<RunnerImageRecord | undefined>;
  usage?(): Promise<ImageUsageReport>;
  gc?(protectedRefs: string[]): Promise<ImageGcReport>;
  purgeApp?(appId: string): Promise<ImageGcReport>;
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
  previousImageRef: string | null;
  previousImageBuiltAt: string | null;
  runnerAvailable: boolean;
}

export interface AppImageRollbackResult {
  appId: string;
  appKey: string;
  status: AppImageStatus;
  imageRef: string | null;
  previousImageRef: string | null;
  builtAt: string | null;
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
  deleting: number;
  project_deleting: number;
}

interface AppImageVersionRow {
  image_ref: string;
  image_id: string | null;
  spec_hash: string | null;
  base_digest: string | null;
  built_at: string | null;
  created_at: string;
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
  readonly #deploymentLock: DeploymentLock | undefined;
  readonly #lifecycleActivity: LifecycleActivity | undefined;
  readonly #active = new Map<string, string>();
  readonly #builds = new Map<string, BuildMeta>();
  readonly #deleting = new Set<string>();

  constructor(options: ImageServiceOptions) {
    this.#db = options.db;
    this.#workspaceRoot = options.workspaceRoot;
    this.#hostWorkspace = options.hostWorkspace;
    this.#defaultImage = options.defaultImage;
    this.#runner = options.runner;
    this.#deploymentLock = options.deploymentLock;
    this.#lifecycleActivity = options.lifecycleActivity;
  }

  /** Start one human-requested build. Never triggered by file changes or registration. */
  async build(appId: string, appKey?: string): Promise<ImageBuildResult> {
    const app = this.#getApp(appId);
    if (appKey !== undefined && app.app_key !== appKey) {
      throw new ImageServiceError(404, "application not found", "not_found");
    }
    if (this.#deleting.has(appId) || app.deleting === 1 || app.project_deleting === 1) {
      throw new ImageServiceError(
        409,
        "the application is being deleted; image builds are disabled",
        "deletion_pending",
      );
    }
    if (this.#active.has(appId)) {
      throw new ImageServiceError(
        409,
        "an image build is already running for this app",
        "build_in_progress",
      );
    }
    const end = this.#beginLifecycle("image_build");
    try {
      this.#assertDeploymentUnlocked("image_build");
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
    } finally {
      end();
    }
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

    const current = this.#findApp(appId);
    if (current === undefined) {
      return this.#view(app, inspection, {
        buildId: record.buildId,
        imageId: record.imageId,
        updatedAt: record.updatedAt,
        runnerAvailable: true,
      });
    }

    this.#applyRecord(current, inspection, record);
    app = this.#findApp(appId) ?? current;
    return this.#view(app, inspection, {
      buildId: record.buildId,
      imageId: record.imageId,
      updatedAt: record.updatedAt,
      runnerAvailable: true,
    });
  }

  /** Switch the app back to its previous recorded image version. DB-only; the manager owns guards. */
  async rollback(appId: string, appKey?: string): Promise<AppImageRollbackResult> {
    const app = this.#getApp(appId);
    if (appKey !== undefined && app.app_key !== appKey) {
      throw new ImageServiceError(404, "application not found", "not_found");
    }
    if (app.image_ref === null) {
      throw new ImageServiceError(409, "application has no current image to roll back", "no_image");
    }
    const previous = this.#previousVersion(app.id, app.image_ref);
    if (previous === undefined) {
      throw new ImageServiceError(
        409,
        "no previous image version is available",
        "no_previous_image",
      );
    }
    const inspection = this.#inspect(app);
    const matchesCurrentSpec =
      inspection.specHash !== null &&
      previous.spec_hash !== null &&
      inspection.specHash === previous.spec_hash;
    const status: AppImageStatus = matchesCurrentSpec ? "ready" : "stale";
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
        status,
        image_ref: previous.image_ref,
        image_hash: previous.spec_hash,
        image_base_digest: previous.base_digest,
        image_built_at: previous.built_at,
      });
    const updated = this.#getApp(appId);
    const next =
      updated.image_ref === null ? undefined : this.#previousVersion(updated.id, updated.image_ref);
    return {
      appId: updated.id,
      appKey: updated.app_key,
      status: updated.image_status,
      imageRef: updated.image_ref,
      previousImageRef: next?.image_ref ?? null,
      builtAt: updated.image_built_at,
    };
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

  /** Disk and Docker usage as reported by the runner (disk thresholds are advisory). */
  async usage(): Promise<ImageUsageReport> {
    if (this.#runner.usage === undefined) {
      throw new ImageServiceError(503, "image usage is not available", "usage_unavailable");
    }
    try {
      return await this.#runner.usage();
    } catch (error) {
      throw this.#runnerFailure(error);
    }
  }

  /**
   * Explicit garbage collection.
   *
   * The coordinator computes the keep set from durable state so the runner cannot remove the
   * current or rollback images, or any image a running/starting instance is using.
   */
  async gc(): Promise<ImageGcReport> {
    if (this.#runner.gc === undefined) {
      throw new ImageServiceError(503, "image gc is not available", "gc_unavailable");
    }
    const protectedRefs = this.#protectedImageRefs();
    try {
      return await this.#runner.gc(protectedRefs);
    } catch (error) {
      throw this.#runnerFailure(error);
    }
  }

  /**
   * Ask the runner whether a build is in flight before a deletion reserves the app. The returned
   * record is the observation `reserveDelete` reconciles coordinator state against.
   */
  async assertRunnerIdle(appId: string): Promise<RunnerImageRecord> {
    let record: RunnerImageRecord;
    try {
      record = await this.#runner.get(appId);
    } catch (error) {
      throw this.#runnerFailure(error);
    }
    if (record.status === "building") {
      throw new ImageServiceError(
        409,
        "an image build is running for this app",
        "build_in_progress",
      );
    }
    return record;
  }

  /**
   * Reserve the app for deletion across the check-to-build window. This is synchronous on purpose:
   * no build can slip in between the runner check and the local reservation.
   */
  reserveDelete(appId: string, observed: RunnerImageRecord): void {
    const active = this.#active.get(appId);
    if (active === "pending" || observed.status === "building") {
      throw new ImageServiceError(
        409,
        "an image build is running for this app",
        "build_in_progress",
      );
    }
    if (active !== undefined) {
      this.#active.delete(appId);
      this.#builds.delete(active);
    }
    this.#deleting.add(appId);
  }

  endDelete(appId: string): void {
    this.#deleting.delete(appId);
  }

  /** Purge one app's runner images by id; the row may already be gone from the DB. */
  async purgeApp(appId: string): Promise<ImageGcReport> {
    try {
      if (this.#runner.purgeApp === undefined) {
        throw new ImageServiceError(503, "app image purge is not available", "purge_unavailable");
      }
      return await this.#runner.purgeApp(appId);
    } catch (error) {
      if (error instanceof ImageServiceError) {
        throw error;
      }
      throw this.#runnerFailure(error);
    } finally {
      this.forgetApp(appId);
    }
  }

  forgetApp(appId: string): void {
    this.#active.delete(appId);
    for (const [buildId, meta] of this.#builds) {
      if (meta.appId === appId) {
        this.#builds.delete(buildId);
      }
    }
  }

  #beginLifecycle(operation: string): () => void {
    return this.#lifecycleActivity?.begin(operation) ?? (() => undefined);
  }

  #assertDeploymentUnlocked(operation: string): void {
    this.#deploymentLock?.assertUnlocked(operation);
  }

  #protectedImageRefs(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT image_ref FROM apps WHERE image_ref IS NOT NULL
         UNION
         SELECT image_ref FROM app_image_versions WHERE image_ref IS NOT NULL
         UNION
         SELECT image_ref FROM instances
           WHERE state IN ('running', 'starting') AND image_ref IS NOT NULL`,
      )
      .all() as { image_ref: string }[];
    return [...new Set(rows.map((row) => row.image_ref))].sort();
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
      const adoptImage =
        record.imageRef === null ||
        activeBuildId !== undefined ||
        app.image_status === "building" ||
        app.image_ref === null ||
        app.image_ref === record.imageRef;
      const recorded =
        record.imageRef === null ? undefined : this.#versionByRef(app.id, record.imageRef);
      const builtHash =
        meta?.specHash ??
        (record.imageRef !== null && record.imageRef === app.image_ref ? app.image_hash : null) ??
        recorded?.spec_hash ??
        inspection.specHash;
      const builtBase =
        meta?.baseDigest ??
        (record.imageRef !== null && record.imageRef === app.image_ref
          ? app.image_base_digest
          : null) ??
        recorded?.base_digest ??
        digestFromReference(this.#defaultImage);
      const builtAt = record.updatedAt ?? recorded?.built_at ?? new Date().toISOString();
      const selectedHash = adoptImage ? builtHash : app.image_hash;
      const stale =
        inspection.specHash !== null &&
        selectedHash !== null &&
        inspection.specHash !== selectedHash;
      if (adoptImage) {
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
            image_built_at: builtAt,
          });
      } else {
        this.#db
          .prepare("UPDATE apps SET image_status = @status, image_error = NULL WHERE id = @id")
          .run({ id: app.id, status: stale ? "stale" : "ready" });
      }
      this.#recordVersion(app.id, record, builtHash, builtBase, builtAt);
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

  #recordVersion(
    appId: string,
    record: RunnerImageRecord,
    specHash: string | null,
    baseDigest: string,
    builtAt: string,
  ): void {
    if (record.imageRef === null || record.imageRef.length === 0) {
      return;
    }
    const createdAt = new Date().toISOString();
    const write = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO app_image_versions
             (app_id, image_ref, image_id, spec_hash, base_digest, built_at, created_at)
           VALUES (@app_id, @image_ref, @image_id, @spec_hash, @base_digest, @built_at, @created_at)
           ON CONFLICT(app_id, image_ref) DO UPDATE SET
             image_id = excluded.image_id,
             spec_hash = excluded.spec_hash,
             base_digest = excluded.base_digest,
             built_at = excluded.built_at`,
        )
        .run({
          app_id: appId,
          image_ref: record.imageRef,
          image_id: record.imageId,
          spec_hash: specHash,
          base_digest: baseDigest,
          built_at: builtAt,
          created_at: createdAt,
        });
      const keep = new Set(
        (
          this.#db
            .prepare(
              `SELECT image_ref FROM app_image_versions
               WHERE app_id = ? ORDER BY created_at DESC, id DESC LIMIT 2`,
            )
            .all(appId) as { image_ref: string }[]
        ).map((row) => row.image_ref),
      );
      const running = this.#db
        .prepare(
          `SELECT image_ref FROM instances
           WHERE app_id = ? AND state IN ('running', 'starting') AND image_ref IS NOT NULL`,
        )
        .get(appId) as { image_ref: string } | undefined;
      if (running !== undefined) {
        keep.add(running.image_ref);
      }
      if (keep.size === 0) {
        return;
      }
      const refs = [...keep];
      const placeholders = refs.map(() => "?").join(", ");
      this.#db
        .prepare(
          `DELETE FROM app_image_versions
           WHERE app_id = ? AND image_ref NOT IN (${placeholders})`,
        )
        .run(appId, ...refs);
    });
    write();
  }

  #versionByRef(appId: string, imageRef: string): AppImageVersionRow | undefined {
    return this.#db
      .prepare(
        `SELECT image_ref, image_id, spec_hash, base_digest, built_at, created_at
         FROM app_image_versions WHERE app_id = ? AND image_ref = ?`,
      )
      .get(appId, imageRef) as AppImageVersionRow | undefined;
  }

  #previousVersion(appId: string, currentRef: string): AppImageVersionRow | undefined {
    return this.#db
      .prepare(
        `SELECT image_ref, image_id, spec_hash, base_digest, built_at, created_at
         FROM app_image_versions
         WHERE app_id = ? AND image_ref <> ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(appId, currentRef) as AppImageVersionRow | undefined;
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
    const row = this.#findApp(appId);
    if (row === undefined) {
      throw new ImageServiceError(404, "application not found", "not_found");
    }
    return row;
  }

  #findApp(appId: string): AppRow | undefined {
    return this.#db
      .prepare(
        `SELECT a.id, a.project_id, a.app_key, a.path,
                a.image_ref, a.image_status, a.image_hash,
                a.image_base_digest, a.image_built_at, a.image_error,
                a.deleting, p.deleting AS project_deleting,
                p.root_path
         FROM apps a
         JOIN projects p ON p.id = a.project_id
         WHERE a.id = ?`,
      )
      .get(appId) as AppRow | undefined;
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
    const previous =
      app.image_ref === null ? undefined : this.#previousVersion(app.id, app.image_ref);
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
      previousImageRef: previous?.image_ref ?? null,
      previousImageBuiltAt: previous?.built_at ?? null,
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
