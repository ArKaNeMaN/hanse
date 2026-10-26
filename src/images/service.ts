import { ConfigError } from "../config/load.js";
import type { DeploymentLock } from "../coordinator/deployment-lock.js";
import type { LifecycleActivity } from "../coordinator/lifecycle-activity.js";
import type { AppBuildInspection, AppImageBaseKind, AppImageStatus } from "../registry/index.js";
import { mergeImageMetadata, resolveAppBuild } from "../registry/index.js";
import type { ImageGcReport, ImageUsageReport } from "../runner/image-gc.js";
import { mapToHostPath } from "../runner/names.js";
import { resolveAppPath } from "../runtime/app-path.js";
import { isDigest, legacyV1BaseReference, resolveManifestDigest } from "../runtime/base-image.js";
import {
  BUILD_SPEC_HASH_VERSION,
  boundedErrorMessage,
  computeLegacyBuildSpecHashV1,
} from "../runtime/build-spec.js";
import type { SqliteDatabase } from "../store/index.js";
import type {
  ImageBuildInput,
  ImageBuildResult,
  RunnerImageInspect,
  RunnerImageRecord,
} from "./client.js";
import { ImageClientError } from "./client.js";

export interface ImageServiceOptions {
  db: SqliteDatabase;
  /** Coordinator-visible workspace root used to contain app paths. */
  workspaceRoot: string;
  /** Host path the runner sees for the same workspace. */
  hostWorkspace: string;
  /** Default agent image reference, including an optional digest. */
  defaultImage: string;
  /** Configured shared base reference (`HANSE_AGENT_BASE_IMAGE`), if any. */
  baseImage?: string;
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
  inspect?(reference: string, appId?: string): Promise<RunnerImageInspect>;
  usage?(): Promise<ImageUsageReport>;
  gc?(protectedRefs: string[]): Promise<ImageGcReport>;
  purgeApp?(appId: string): Promise<ImageGcReport>;
}

/** Every derived image state (D5). */
export type ImageStateName =
  | "current"
  | "restart_required"
  | "rebuild_required"
  | "building"
  | "build_error"
  | "not_ready"
  | "unknown";

export type SelectedImageVerdict = "present" | "missing" | "unknown";

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
  buildConfigured: boolean;
  state: ImageStateName;
  running: boolean;
  usableImageRef: string | null;
  targetImageId: string | null;
  appliedImageId: string | null;
  hashVersion: number | null;
  currentBaseDigest: string | null;
  baseKind: AppImageBaseKind | null;
  baseRef: string | null;
  baseDrift: boolean | null;
  hashDrift: boolean | null;
  blocked: boolean;
  selectedImage: SelectedImageVerdict | null;
  imageBuildId: string | null;
  latestBuildImageId: string | null;
}

/** Shared image view exported for the HTTP route and the manager preflight. */
export type ImageStateView = AppImageStatusView;

export interface AppImageRollbackResult {
  appId: string;
  appKey: string;
  status: AppImageStatus;
  imageRef: string | null;
  previousImageRef: string | null;
  builtAt: string | null;
}

/** Result of re-reading one app's manifest/Dockerfile without building. */
export interface AppImageCheckResult {
  appId: string;
  appKey: string;
  status: AppImageStatus;
  imageRef: string | null;
  imageHash: string | null;
  buildConfigured: boolean;
  state: ImageStateName;
  notice: string;
  tone: "success" | "error";
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

/** A build-configured application has no usable image for a cold start. HTTP 409. */
export class ImageNotReadyError extends Error {
  readonly status = 409;
  readonly code = "image_not_ready";
  readonly appId: string;
  readonly imageStatus: AppImageStatus;
  readonly buildConfigured: boolean;
  readonly state: ImageStateName;

  constructor(view: ImageStateView) {
    super(`application image is not ready (${view.state})`);
    this.name = "ImageNotReadyError";
    this.appId = view.appId;
    this.imageStatus = view.status;
    this.buildConfigured = view.buildConfigured;
    this.state = view.state;
  }
}

/** A default-image application's image is unavailable locally. HTTP 503. */
export class DefaultImageUnavailableError extends Error {
  readonly status = 503;
  readonly code = "default_image_unavailable";
  readonly appId: string;
  readonly state: ImageStateName;

  constructor(view: ImageStateView) {
    super("the default agent image is unavailable");
    this.name = "DefaultImageUnavailableError";
    this.appId = view.appId;
    this.state = view.state;
  }
}

export interface DeriveImageStateInput {
  buildConfigured: boolean;
  imageStatus: AppImageStatus;
  inspectionError: boolean;
  buildActive: boolean;
  usableImageRef: string | null;
  selectedImage: SelectedImageVerdict | null;
  baseDrift: boolean | null;
  hashDrift: boolean | null;
  appliedImageId: string | null;
  targetImageId: string | null;
  running: boolean;
}

export interface DerivedImageState {
  state: ImageStateName;
  baseDrift: boolean | null;
  hashDrift: boolean | null;
  blocked: boolean;
}

/** The single D5 state derivation used by the view, typed errors, and the manager. */
export function deriveImageState(input: DeriveImageStateInput): DerivedImageState {
  const blocked = (state: ImageStateName): boolean =>
    input.buildConfigured &&
    input.usableImageRef === null &&
    (state === "not_ready" || state === "building" || state === "build_error");

  if (!input.buildConfigured) {
    let state: ImageStateName;
    if (input.running) {
      if (input.appliedImageId !== null && input.targetImageId !== null) {
        state = input.appliedImageId === input.targetImageId ? "current" : "restart_required";
      } else {
        state = "unknown";
      }
    } else {
      state = input.targetImageId !== null ? "current" : "unknown";
    }
    return {
      state,
      baseDrift: null,
      hashDrift: null,
      blocked: blocked(state),
    };
  }

  let state: ImageStateName;
  if (input.buildActive) {
    state = "building";
  } else if (input.imageStatus === "error" || input.inspectionError) {
    state = "build_error";
  } else if (input.usableImageRef === null) {
    state = "not_ready";
  } else if (input.baseDrift === true || input.hashDrift === true) {
    state = "rebuild_required";
  } else if (
    input.running &&
    input.appliedImageId !== null &&
    input.targetImageId !== null &&
    input.appliedImageId !== input.targetImageId
  ) {
    state = "restart_required";
  } else if (
    input.selectedImage === "unknown" ||
    input.baseDrift === null ||
    input.hashDrift === null
  ) {
    state = "unknown";
  } else if (input.targetImageId === null) {
    state = "unknown";
  } else if (input.running && input.appliedImageId === null) {
    state = "unknown";
  } else {
    state = "current";
  }
  return { state, baseDrift: input.baseDrift, hashDrift: input.hashDrift, blocked: blocked(state) };
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
  build_configured: number;
  image_base_ref: string | null;
  image_base_kind: AppImageBaseKind | null;
  image_hash_version: number;
  image_build_id: string | null;
  image_build_ref: string | null;
  image_build_started_at: string | null;
  image_build_rejected_ref: string | null;
  instance_state: string | null;
  applied_image_id: string | null;
  deleting: number;
  project_deleting: number;
}

interface AppImageVersionRow {
  image_ref: string;
  image_id: string | null;
  spec_hash: string | null;
  base_digest: string | null;
  base_ref: string | null;
  base_kind: AppImageBaseKind | null;
  hash_version: number;
  built_at: string | null;
  created_at: string;
}

interface BuildMeta {
  appId: string;
  specHash: string;
  baseKind: AppImageBaseKind;
  baseRef: string | null;
}

interface ResolvedBuild {
  appDir: string;
  hostAppDir: string;
  dockerfile: string;
  buildArgs: Record<string, string>;
  specHash: string;
  baseKind: AppImageBaseKind;
  baseRef: string | null;
}

interface IdentityCacheEntry extends RunnerImageInspect {
  expiresAt: number;
}

interface Derivation {
  state: ImageStateName;
  running: boolean;
  appliedImageId: string | null;
  targetImageId: string | null;
  usableImageRef: string | null;
  selectedImage: SelectedImageVerdict | null;
  currentBaseDigest: string | null;
  hashVersion: number | null;
  baseDrift: boolean | null;
  hashDrift: boolean | null;
  blocked: boolean;
}

const MAX_LOG_BYTES = 64 * 1024;
const IDENTITY_CACHE_TTL_MS = 60_000;
const BUILD_REACHABLE_GRACE_MS = 60_000;
const BUILD_UNREACHABLE_TIMEOUT_MS = 30 * 60 * 1_000;
const LOST_BUILD_MESSAGE = "build state was lost; retry the image build";
const MISMATCH_MESSAGE = "image build target mismatch; retry the build";

/**
 * Human-triggered app image builds.
 *
 * The service is the only place the coordinator turns a registered app into a runner build request:
 * it re-reads the live manifest/Dockerfile (never a stale DB snapshot), enforces one in-flight build
 * per app, proxies status/logs, persists durable build identity, and derives the shared image state.
 */
export class ImageService {
  readonly #db: SqliteDatabase;
  readonly #workspaceRoot: string;
  readonly #hostWorkspace: string;
  readonly #defaultImage: string;
  readonly #baseImage: string | undefined;
  readonly #runner: ImageRunnerClient;
  readonly #deploymentLock: DeploymentLock | undefined;
  readonly #lifecycleActivity: LifecycleActivity | undefined;
  readonly #active = new Map<string, string>();
  readonly #builds = new Map<string, BuildMeta>();
  readonly #deleting = new Set<string>();
  readonly #identities = new Map<string, IdentityCacheEntry>();

  constructor(options: ImageServiceOptions) {
    this.#db = options.db;
    this.#workspaceRoot = options.workspaceRoot;
    this.#hostWorkspace = options.hostWorkspace;
    this.#defaultImage = options.defaultImage;
    this.#baseImage = normalizeOptional(options.baseImage ?? process.env.HANSE_AGENT_BASE_IMAGE);
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
    if (this.#active.has(appId) || app.image_build_id !== null || app.image_status === "building") {
      throw new ImageServiceError(
        409,
        "an image build is already running for this app",
        "build_in_progress",
      );
    }
    const end = this.#beginLifecycle("image_build");
    try {
      this.#assertDeploymentUnlocked("image_build");
      const inspection = this.#inspect(app);
      if (inspection.status === "error") {
        this.#persistBuildConfigFailure(app, inspection);
        throw new ImageServiceError(
          inspection.baseErrorCode === null || inspection.baseErrorCode === undefined ? 409 : 400,
          `application image configuration is invalid: ${inspection.error ?? "unknown error"}`,
          inspection.baseErrorCode ?? "invalid_build",
        );
      }
      const spec = this.#resolveBuild(app, inspection);

      this.#active.set(appId, "pending");
      let result: ImageBuildResult;
      try {
        result = await this.#runner.build({
          appId: app.id,
          appDir: spec.hostAppDir,
          dockerfile: spec.dockerfile,
          baseImage: spec.baseRef ?? this.#defaultImage,
          buildArgs: spec.buildArgs,
          specHash: spec.specHash,
          baseKind: spec.baseKind,
          hashVersion: BUILD_SPEC_HASH_VERSION,
        });
      } catch (error) {
        this.#active.delete(appId);
        throw this.#runnerFailure(error);
      }

      this.#active.set(appId, result.buildId);
      this.#builds.set(result.buildId, {
        appId,
        specHash: spec.specHash,
        baseKind: spec.baseKind,
        baseRef: spec.baseRef,
      });
      this.#db
        .prepare(
          `UPDATE apps SET
             image_status = 'building', image_error = NULL, build_configured = 1,
             image_build_id = @build_id, image_build_ref = @build_ref,
             image_build_started_at = @started_at, image_build_rejected_ref = NULL
           WHERE id = @id`,
        )
        .run({
          id: appId,
          build_id: result.buildId,
          build_ref: result.targetRef ?? null,
          started_at: new Date().toISOString(),
        });
      this.invalidateCache();
      return result;
    } finally {
      end();
    }
  }

  /** Refresh the DB from the runner and return the shared state view. */
  async status(appId: string, options: { refresh?: boolean } = {}): Promise<ImageStateView> {
    if (options.refresh === true) {
      this.invalidateCache();
    }
    const app = this.#getApp(appId);
    let latest: RunnerImageRecord | undefined;
    let runnerAvailable = true;
    try {
      latest = await this.#runner.get(appId);
    } catch (error) {
      if (!(error instanceof ImageClientError)) {
        throw error;
      }
      runnerAvailable = false;
    }

    if (this.#findApp(appId) === undefined) {
      const inspection = this.#inspect(app);
      const derivation = await this.#derive(app, inspection);
      return this.#view(app, inspection, {
        latest,
        runnerAvailable,
        derivation,
      });
    }

    let current = app;
    if (app.image_build_id !== null) {
      const adopted = await this.#adoptDurable(app);
      if (adopted !== null) current = adopted;
    } else if (latest !== undefined) {
      const applied = this.#applyLegacyRecord(current, latest);
      if (applied !== null) current = applied;
    }

    current = this.#findApp(appId) ?? current;
    const inspection = this.#inspect(current);
    const derivation = await this.#derive(current, inspection);
    return this.#view(current, inspection, { latest, runnerAvailable, derivation });
  }

  /** Shared state for the manager/HTTP contracts. */
  async imageState(appId: string, options: { refresh?: boolean } = {}): Promise<ImageStateView> {
    return this.status(appId, options);
  }

  /**
   * Resolve one durable in-flight build. Returns true when the durable row was resolved or adopted.
   * Both adoption branches are safe to call repeatedly; a rejected ref is never re-adopted.
   */
  async adoptBuild(appId: string): Promise<boolean> {
    const app = this.#getApp(appId);
    if (app.image_build_id === null) {
      return false;
    }
    return (await this.#adoptDurable(app)) !== null;
  }

  /** Startup adoption pass over every app with a durable in-flight build. Bounded per app. */
  async adoptBuilds(): Promise<void> {
    const rows = this.#db
      .prepare("SELECT id FROM apps WHERE image_build_id IS NOT NULL ORDER BY id")
      .all() as { id: string }[];
    for (const row of rows) {
      try {
        const app = this.#findApp(row.id);
        if (app !== undefined) {
          await this.#adoptDurable(app);
        }
      } catch {
        // One broken build must not abort startup; the next status poll retries that app.
      }
    }
  }

  /** Warm the identity cache for the default, shared base, and every recorded explicit base. */
  async warmCache(): Promise<void> {
    const refs = new Set<string>();
    if (this.#defaultImage.length > 0) refs.add(this.#defaultImage);
    if (this.#baseImage !== undefined) refs.add(this.#baseImage);
    const explicit = this.#db
      .prepare(
        `SELECT DISTINCT image_base_ref FROM apps
         WHERE image_base_kind = 'explicit' AND image_base_ref IS NOT NULL`,
      )
      .all() as { image_base_ref: string }[];
    for (const row of explicit) refs.add(row.image_base_ref);
    for (const reference of refs) {
      try {
        await this.#inspectReference(reference);
      } catch {
        // A missing/uninspectable reference stays unknown and is retried later.
      }
    }
  }

  invalidateCache(): void {
    this.#identities.clear();
  }

  /**
   * Re-read the live manifest/Dockerfile and persist the merged image metadata.
   *
   * This is the explicit human check used when an app has no build declared in the DB yet. It never
   * builds, starts, or restarts anything; a detected build still needs an explicit build and restart.
   */
  async check(appId: string, appKey?: string): Promise<AppImageCheckResult> {
    const app = this.#getApp(appId);
    if (appKey !== undefined && app.app_key !== appKey) {
      throw new ImageServiceError(404, "application not found", "not_found");
    }
    if (this.#deleting.has(appId) || app.deleting === 1 || app.project_deleting === 1) {
      throw new ImageServiceError(
        409,
        "the application is being deleted; image checks are disabled",
        "deletion_pending",
      );
    }
    if (this.#active.has(appId) || app.image_build_id !== null || app.image_status === "building") {
      throw new ImageServiceError(
        409,
        "an image build is already running for this app",
        "build_in_progress",
      );
    }

    const inspection = this.#inspect(app);
    const merged = mergeImageMetadata(app, inspection);
    const buildConfigured = inspectionBuildConfigured(inspection);
    this.#db
      .prepare(
        `UPDATE apps SET
           image_status = @image_status,
           image_ref = @image_ref,
           image_hash = @image_hash,
           image_base_digest = @image_base_digest,
           image_built_at = @image_built_at,
           image_error = @image_error,
           build_configured = @build_configured,
           image_base_ref = @image_base_ref,
           image_base_kind = @image_base_kind,
           image_hash_version = @image_hash_version,
           image_build_rejected_ref = @image_build_rejected_ref
         WHERE id = @id`,
      )
      .run({
        id: app.id,
        image_status: merged.imageStatus,
        image_ref: merged.imageRef,
        image_hash: merged.imageHash,
        image_base_digest: merged.imageBaseDigest,
        image_built_at: merged.imageBuiltAt,
        image_error: merged.imageError,
        build_configured: buildConfigured ? 1 : 0,
        image_base_ref: merged.imageBaseRef,
        image_base_kind: merged.imageBaseKind,
        image_hash_version: merged.imageHashVersion,
        image_build_rejected_ref: merged.imageBuildRejectedRef,
      });
    this.invalidateCache();

    const updated = this.#getApp(appId);
    const derivation = await this.#derive(updated, inspection);
    return {
      appId: updated.id,
      appKey: updated.app_key,
      status: updated.image_status,
      imageRef: updated.image_ref,
      imageHash: updated.image_hash,
      buildConfigured,
      state: derivation.state,
      ...checkNotice(inspection, updated),
    };
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
    const matches = this.#versionHashMatches(previous, inspection);
    const baseDrift = await this.#versionBaseDrift(previous);
    const status: AppImageStatus = matches === false || baseDrift === true ? "stale" : "ready";
    this.#db
      .prepare(
        `UPDATE apps SET
           image_status = @status,
           image_ref = @image_ref,
           image_hash = @image_hash,
           image_base_digest = @image_base_digest,
           image_base_ref = @image_base_ref,
           image_base_kind = @image_base_kind,
           image_hash_version = @image_hash_version,
           image_built_at = @image_built_at,
           image_error = NULL,
           image_build_id = NULL,
           image_build_ref = NULL,
           image_build_started_at = NULL,
           image_build_rejected_ref = NULL
         WHERE id = @id`,
      )
      .run({
        id: app.id,
        status,
        image_ref: previous.image_ref,
        image_hash: previous.spec_hash,
        image_base_digest: previous.base_digest,
        image_base_ref: previous.base_ref,
        image_base_kind: previous.base_kind,
        image_hash_version: previous.hash_version,
        image_built_at: previous.built_at,
      });
    this.invalidateCache();
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
    this.#clearBuildIdentity(appId);
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
    this.#clearBuildIdentity(appId);
  }

  #clearBuildIdentity(appId: string): void {
    this.#db
      .prepare(
        `UPDATE apps SET image_build_id = NULL, image_build_ref = NULL,
           image_build_started_at = NULL,
           image_status = CASE WHEN image_ref IS NOT NULL THEN 'ready' ELSE 'missing' END
         WHERE id = ?`,
      )
      .run(appId);
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
           WHERE state IN ('running', 'starting') AND image_ref IS NOT NULL
         UNION
         SELECT image_build_ref FROM apps
           WHERE image_build_id IS NOT NULL AND image_build_ref IS NOT NULL`,
      )
      .all() as { image_ref: string }[];
    return [...new Set(rows.map((row) => row.image_ref))].sort();
  }

  async #adoptDurable(app: AppRow): Promise<AppRow | null> {
    const buildId = app.image_build_id;
    if (buildId === null) return null;

    let record: RunnerImageRecord | undefined;
    let reachable = true;
    try {
      record = await this.#runner.getBuild(buildId);
    } catch (error) {
      if (!(error instanceof ImageClientError) || !error.transport) {
        return null;
      }
      reachable = false;
    }

    if (this.#findApp(app.id) === undefined) {
      return null;
    }

    if (record === undefined) {
      this.#applyLostBuild(app, reachable);
      return this.#findApp(app.id) ?? null;
    }
    if (record.buildId !== buildId) {
      this.#finish(app.id, record.buildId);
      return null;
    }
    if (record.status === "building") {
      this.#db
        .prepare(
          `UPDATE apps SET image_status = 'building', image_error = NULL,
             image_build_ref = COALESCE(@build_ref, image_build_ref),
             image_build_started_at = COALESCE(image_build_started_at, @started_at)
           WHERE id = @id`,
        )
        .run({
          id: app.id,
          build_ref: record.targetRef ?? null,
          started_at: new Date().toISOString(),
        });
      return this.#findApp(app.id) ?? null;
    }
    if (record.status === "ready") {
      this.#adoptReady(app, record);
      return this.#findApp(app.id) ?? null;
    }
    if (record.status === "error") {
      this.#applyTerminalError(app, record);
      return this.#findApp(app.id) ?? null;
    }
    this.#applyLostBuild(app, reachable);
    return this.#findApp(app.id) ?? null;
  }

  #applyLostBuild(app: AppRow, reachable: boolean): void {
    const started = app.image_build_started_at;
    const startedAt = started === null ? Number.NaN : Date.parse(started);
    if (Number.isFinite(startedAt)) {
      const grace = reachable ? BUILD_REACHABLE_GRACE_MS : BUILD_UNREACHABLE_TIMEOUT_MS;
      if (Date.now() - startedAt < grace) {
        return;
      }
    } else if (!reachable) {
      return;
    }
    this.#db
      .prepare(
        `UPDATE apps SET image_status = 'error', image_error = @error,
           image_build_id = NULL, image_build_ref = NULL, image_build_started_at = NULL
         WHERE id = @id`,
      )
      .run({ id: app.id, error: LOST_BUILD_MESSAGE });
    this.#finish(app.id, app.image_build_id);
  }

  #applyTerminalError(app: AppRow, record: RunnerImageRecord): void {
    this.#db
      .prepare(
        `UPDATE apps SET image_status = 'error', image_error = @error,
           image_build_id = NULL, image_build_ref = NULL, image_build_started_at = NULL
         WHERE id = @id`,
      )
      .run({
        id: app.id,
        error: boundedErrorMessage(new Error(record.error ?? "image build failed")),
      });
    this.#finish(app.id, record.buildId);
  }

  #adoptReady(app: AppRow, record: RunnerImageRecord): boolean {
    if (record.imageRef === null) {
      this.#finish(app.id, record.buildId);
      return false;
    }
    const rejected = app.image_build_rejected_ref;
    if (rejected !== null && rejected === record.imageRef) {
      this.#finish(app.id, record.buildId);
      return false;
    }
    const durableId = app.image_build_id;
    if (durableId !== null) {
      if (record.buildId !== durableId) {
        this.#finish(app.id, record.buildId);
        return false;
      }
      if (app.image_build_ref !== null && record.imageRef !== app.image_build_ref) {
        this.#db
          .prepare(
            `UPDATE apps SET
               image_status = 'error', image_error = @error,
               image_build_id = NULL, image_build_ref = NULL, image_build_started_at = NULL,
               image_build_rejected_ref = @rejected
             WHERE id = @id`,
          )
          .run({ id: app.id, error: MISMATCH_MESSAGE, rejected: record.imageRef });
        this.#finish(app.id, record.buildId);
        return false;
      }
    }
    this.#writeAdoption(app, record);
    this.#finish(app.id, record.buildId);
    return true;
  }

  #writeAdoption(app: AppRow, record: RunnerImageRecord): void {
    const imageRef = record.imageRef;
    if (imageRef === null) return;
    const meta = record.buildId === null ? undefined : this.#builds.get(record.buildId);
    const specHash =
      record.specHash ?? meta?.specHash ?? (app.image_ref === imageRef ? app.image_hash : null);
    const hashVersion =
      record.hashVersion ??
      record.specHashVersion ??
      (specHash === null ? (app.image_hash_version ?? 1) : BUILD_SPEC_HASH_VERSION);
    const baseKind = record.baseKind ?? meta?.baseKind ?? null;
    const baseRef =
      baseKind === null || baseKind === "unknown"
        ? null
        : (record.baseRef ?? meta?.baseRef ?? null);
    const baseDigest = isDigest(record.baseDigest) ? record.baseDigest : null;
    const builtAt = record.updatedAt ?? new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE apps SET
           image_status = 'ready', image_ref = @image_ref, image_hash = @image_hash,
           image_base_ref = @image_base_ref, image_base_kind = @image_base_kind,
           image_base_digest = @image_base_digest, image_hash_version = @image_hash_version,
           image_built_at = @image_built_at, image_error = NULL,
           image_build_id = NULL, image_build_ref = NULL, image_build_started_at = NULL,
           image_build_rejected_ref = NULL
         WHERE id = @id`,
      )
      .run({
        id: app.id,
        image_ref: imageRef,
        image_hash: specHash,
        image_base_ref: baseRef,
        image_base_kind: baseKind,
        image_base_digest: baseDigest,
        image_hash_version: hashVersion,
        image_built_at: builtAt,
      });
    this.#recordVersion(app.id, record, {
      specHash,
      baseDigest: baseDigest ?? record.baseDigest ?? null,
      baseRef,
      baseKind,
      hashVersion,
      builtAt,
    });
    this.invalidateCache();
  }

  #applyLegacyRecord(app: AppRow, record: RunnerImageRecord): AppRow | null {
    if (record.status === "building") {
      this.#db
        .prepare("UPDATE apps SET image_status = 'building', image_error = NULL WHERE id = ?")
        .run(app.id);
      return this.#findApp(app.id) ?? null;
    }
    if (record.status === "ready") {
      if (record.imageRef === null) {
        this.#finish(app.id, record.buildId);
        return null;
      }
      const rejected = app.image_build_rejected_ref;
      if (rejected !== null && rejected === record.imageRef) {
        this.#finish(app.id, record.buildId);
        return null;
      }
      if (app.image_ref !== null && app.image_ref !== record.imageRef) {
        this.#finish(app.id, record.buildId);
        return null;
      }
      const recorded = this.#versionByRef(app.id, record.imageRef);
      if (
        app.image_ref === record.imageRef &&
        recorded !== undefined &&
        recorded.image_id !== null &&
        recorded.image_id === record.imageId
      ) {
        this.#finish(app.id, record.buildId);
        return app;
      }
      this.#writeAdoption(app, record);
      this.#finish(app.id, record.buildId);
      return this.#findApp(app.id) ?? null;
    }
    if (record.status === "error") {
      if (app.image_status === "building" || app.image_ref === null) {
        this.#applyTerminalError(app, record);
      } else {
        this.#finish(app.id, record.buildId);
      }
      return this.#findApp(app.id) ?? null;
    }
    if (app.image_status === "building") {
      this.#applyLostBuild(app, true);
      return this.#findApp(app.id) ?? null;
    }
    this.#finish(app.id, record.buildId);
    return null;
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
    metadata: {
      specHash: string | null;
      baseDigest: string | null;
      baseRef: string | null;
      baseKind: AppImageBaseKind | null;
      hashVersion: number;
      builtAt: string;
    },
  ): void {
    if (record.imageRef === null || record.imageRef.length === 0) {
      return;
    }
    const createdAt = new Date().toISOString();
    const write = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO app_image_versions
             (app_id, image_ref, image_id, spec_hash, base_digest, base_ref, base_kind,
              hash_version, built_at, created_at)
           VALUES (@app_id, @image_ref, @image_id, @spec_hash, @base_digest, @base_ref, @base_kind,
             @hash_version, @built_at, @created_at)
           ON CONFLICT(app_id, image_ref) DO UPDATE SET
             image_id = excluded.image_id,
             spec_hash = excluded.spec_hash,
             base_digest = excluded.base_digest,
             base_ref = excluded.base_ref,
             base_kind = excluded.base_kind,
             hash_version = excluded.hash_version,
             built_at = excluded.built_at`,
        )
        .run({
          app_id: appId,
          image_ref: record.imageRef,
          image_id: record.imageId,
          spec_hash: metadata.specHash,
          base_digest: metadata.baseDigest,
          base_ref: metadata.baseRef,
          base_kind: metadata.baseKind,
          hash_version: metadata.hashVersion,
          built_at: metadata.builtAt,
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
        `SELECT image_ref, image_id, spec_hash, base_digest, base_ref, base_kind, hash_version,
                built_at, created_at
         FROM app_image_versions WHERE app_id = ? AND image_ref = ?`,
      )
      .get(appId, imageRef) as AppImageVersionRow | undefined;
  }

  #previousVersion(appId: string, currentRef: string): AppImageVersionRow | undefined {
    return this.#db
      .prepare(
        `SELECT image_ref, image_id, spec_hash, base_digest, base_ref, base_kind, hash_version,
                built_at, created_at
         FROM app_image_versions
         WHERE app_id = ? AND image_ref <> ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(appId, currentRef) as AppImageVersionRow | undefined;
  }

  #versionHashMatches(version: AppImageVersionRow, inspection: AppBuildInspection): boolean | null {
    if (version.spec_hash === null || inspection.specHash === null) return null;
    const hashVersion = version.hash_version ?? 1;
    if (hashVersion === 2) {
      return version.spec_hash === inspection.specHash;
    }
    if (hashVersion !== 1) return null;
    const legacyReference = legacyV1BaseReference(version.base_digest);
    if (legacyReference === null || !inspection.dockerfileContent) return null;
    const recomputed = computeLegacyBuildSpecHashV1({
      dockerfile: inspection.dockerfileContent,
      defaultImage: legacyReference,
      buildArgs: inspection.args,
    });
    return recomputed === version.spec_hash;
  }

  #hashDrift(app: AppRow, inspection: AppBuildInspection): boolean | null {
    if (app.image_ref === null) return false;
    if (app.image_hash === null || inspection.specHash === null) return null;
    const version = app.image_hash_version ?? 1;
    if (version === BUILD_SPEC_HASH_VERSION) {
      return app.image_hash !== inspection.specHash;
    }
    if (version !== 1) return null;
    const legacyReference = legacyV1BaseReference(app.image_base_digest);
    if (legacyReference === null || !inspection.dockerfileContent) return null;
    const recomputed = computeLegacyBuildSpecHashV1({
      dockerfile: inspection.dockerfileContent,
      defaultImage: legacyReference,
      buildArgs: inspection.args,
    });
    return recomputed !== app.image_hash;
  }

  #currentBaseReference(app: AppRow): string | null {
    if (app.image_base_kind === "default") return this.#defaultImage;
    if (app.image_base_kind === "base") return this.#baseImage ?? null;
    if (app.image_base_kind === "explicit") return app.image_base_ref;
    return null;
  }

  #baseDrift(app: AppRow): Promise<boolean | null> {
    if (!isDigest(app.image_base_digest)) return Promise.resolve(null);
    const reference = this.#currentBaseReference(app);
    if (reference === null) return Promise.resolve(null);
    return this.#currentDigest(reference).then((current) => {
      if (current === null) return null;
      return app.image_base_digest !== current;
    });
  }

  #versionBaseDrift(version: AppImageVersionRow): Promise<boolean | null> {
    if (!isDigest(version.base_digest)) return Promise.resolve(null);
    let reference: string | null = null;
    if (version.base_kind === "default") reference = this.#defaultImage;
    else if (version.base_kind === "base") reference = this.#baseImage ?? null;
    else if (version.base_kind === "explicit") reference = version.base_ref;
    if (reference === null) return Promise.resolve(null);
    return this.#currentDigest(reference).then((current) => {
      if (current === null) return null;
      return version.base_digest !== current;
    });
  }

  #currentDigest(reference: string): Promise<string | null> {
    const at = reference.indexOf("@");
    if (at >= 0 && isDigest(reference.slice(at + 1))) {
      return Promise.resolve(reference.slice(at + 1));
    }
    return this.#inspectReference(reference).then((entry) => {
      if (entry === undefined || !entry.found) return null;
      if (isDigest(entry.resolvedDigest)) return entry.resolvedDigest;
      return resolveManifestDigest(reference, entry.repoDigests);
    });
  }

  async #inspectReference(
    reference: string,
    appId?: string,
  ): Promise<RunnerImageInspect | undefined> {
    const cached = this.#identities.get(reference);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached;
    }
    const inspect = this.#runner.inspect;
    if (inspect === undefined) return undefined;
    let result: RunnerImageInspect;
    try {
      result = await inspect.call(this.#runner, reference, appId);
    } catch {
      return undefined;
    }
    this.#identities.set(reference, {
      ...result,
      expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
    });
    return result;
  }

  async #derive(app: AppRow, inspection: AppBuildInspection): Promise<Derivation> {
    const buildConfigured = app.build_configured === 1;
    const running = app.instance_state === "running" || app.instance_state === "starting";
    const appliedImageId = running ? app.applied_image_id : null;
    const hashVersion = buildConfigured ? (app.image_hash_version ?? 1) : null;
    const hashDrift = buildConfigured ? this.#hashDrift(app, inspection) : null;
    const baseDrift = buildConfigured ? await this.#baseDrift(app) : null;
    const currentBaseReference = buildConfigured ? this.#currentBaseReference(app) : null;
    const currentBaseDigest =
      currentBaseReference === null ? null : await this.#currentDigest(currentBaseReference);

    let usableImageRef: string | null = null;
    let selectedImage: SelectedImageVerdict | null = null;
    let targetImageId: string | null = null;
    if (buildConfigured) {
      if (app.image_ref === null) {
        selectedImage = "missing";
      } else {
        const version = this.#versionByRef(app.id, app.image_ref);
        targetImageId = version?.image_id ?? null;
        const inspected = await this.#inspectReference(app.image_ref, app.id);
        if (inspected === undefined) {
          selectedImage = "unknown";
          usableImageRef = app.image_ref;
        } else if (!inspected.found) {
          selectedImage = "missing";
        } else if (
          version?.image_id !== null &&
          version?.image_id !== undefined &&
          inspected.imageId !== version.image_id
        ) {
          selectedImage = "missing";
        } else {
          selectedImage = "present";
          usableImageRef = app.image_ref;
        }
      }
    } else {
      targetImageId = await this.#imageIdFor(this.#defaultImage);
    }

    const derived = deriveImageState({
      buildConfigured,
      imageStatus: app.image_status,
      inspectionError: inspection.status === "error",
      buildActive:
        buildConfigured &&
        (app.image_build_id !== null ||
          app.image_status === "building" ||
          this.#active.has(app.id)),
      usableImageRef,
      selectedImage,
      baseDrift,
      hashDrift,
      appliedImageId,
      targetImageId,
      running,
    });
    return {
      state: derived.state,
      running,
      appliedImageId,
      targetImageId,
      usableImageRef,
      selectedImage,
      currentBaseDigest,
      hashVersion,
      baseDrift: derived.baseDrift,
      hashDrift: derived.hashDrift,
      blocked: derived.blocked,
    };
  }

  async #imageIdFor(reference: string, appId?: string): Promise<string | null> {
    const entry = await this.#inspectReference(reference, appId);
    return entry?.found ? entry.imageId : null;
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

  #persistBuildConfigFailure(app: AppRow, inspection: AppBuildInspection): void {
    this.#db
      .prepare(
        `UPDATE apps SET image_status = 'error', image_error = @error, build_configured = 1
         WHERE id = @id`,
      )
      .run({
        id: app.id,
        error:
          inspection.error === null
            ? "image build configuration is invalid"
            : boundedErrorMessage(new Error(inspection.error)),
      });
  }

  #resolveBuild(app: AppRow, inspection: AppBuildInspection): ResolvedBuild {
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
    const appDir = this.#appDir(app);
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
    const baseKind = inspection.baseKind ?? "unknown";
    return {
      appDir,
      hostAppDir,
      dockerfile: inspection.relativeDockerfile,
      buildArgs: inspection.args,
      specHash: inspection.specHash,
      baseKind,
      baseRef: baseKind === "unknown" ? null : (inspection.baseRef ?? null),
    };
  }

  #inspect(app: AppRow): AppBuildInspection {
    try {
      return resolveAppBuild(this.#appDir(app), this.#defaultImage, this.#baseImage);
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
                a.build_configured, a.image_base_ref, a.image_base_kind, a.image_hash_version,
                a.image_build_id, a.image_build_ref, a.image_build_started_at,
                a.image_build_rejected_ref,
                a.deleting, p.deleting AS project_deleting, p.root_path,
                i.state AS instance_state, i.applied_image_id
         FROM apps a
         JOIN projects p ON p.id = a.project_id
         LEFT JOIN instances i ON i.app_id = a.id
         WHERE a.id = ?`,
      )
      .get(appId) as AppRow | undefined;
  }

  #view(
    app: AppRow,
    inspection: AppBuildInspection,
    extra: {
      latest: RunnerImageRecord | undefined;
      runnerAvailable: boolean;
      derivation: Derivation;
    },
  ): AppImageStatusView {
    const previous =
      app.image_ref === null ? undefined : this.#previousVersion(app.id, app.image_ref);
    const latest = extra.latest;
    return {
      appId: app.id,
      appKey: app.app_key,
      status: app.image_status,
      imageRef: app.image_ref,
      imageId: latest?.imageId ?? null,
      buildId: latest?.buildId ?? null,
      hash: app.image_hash,
      currentHash: inspection.specHash,
      baseDigest: app.image_base_digest,
      builtAt: app.image_built_at,
      error: app.image_error,
      updatedAt: latest?.updatedAt ?? app.image_built_at,
      previousImageRef: previous?.image_ref ?? null,
      previousImageBuiltAt: previous?.built_at ?? null,
      runnerAvailable: extra.runnerAvailable,
      buildConfigured: app.build_configured === 1,
      state: extra.derivation.state,
      running: extra.derivation.running,
      usableImageRef: extra.derivation.usableImageRef,
      targetImageId: extra.derivation.targetImageId,
      appliedImageId: extra.derivation.appliedImageId,
      hashVersion: extra.derivation.hashVersion,
      currentBaseDigest: extra.derivation.currentBaseDigest,
      baseKind: app.image_base_kind,
      baseRef: app.image_base_ref,
      baseDrift: extra.derivation.baseDrift,
      hashDrift: extra.derivation.hashDrift,
      blocked: extra.derivation.blocked,
      selectedImage: extra.derivation.selectedImage,
      imageBuildId: app.image_build_id,
      latestBuildImageId: latest?.imageId ?? null,
    };
  }
}

function inspectionBuildConfigured(inspection: AppBuildInspection): boolean {
  return (
    inspection.buildConfigured ?? (inspection.status === "error" || inspection.dockerfile !== null)
  );
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function checkNotice(
  inspection: AppBuildInspection,
  app: AppRow,
): { notice: string; tone: "success" | "error" } {
  if (inspection.status === "error") {
    return {
      notice: `Application image configuration is invalid: ${inspection.error ?? "unknown error"}`,
      tone: "error",
    };
  }
  if (inspection.dockerfile === null) {
    return {
      notice: "No application image build configured; using the default agent image.",
      tone: "success",
    };
  }
  if (app.image_status === "error") {
    return {
      notice: `Application image configuration is invalid: ${app.image_error ?? "unknown error"}`,
      tone: "error",
    };
  }
  if (app.image_status === "stale") {
    return { notice: "The image is out of date; rebuild it.", tone: "success" };
  }
  if (app.image_status === "ready") {
    return { notice: "The image is up to date.", tone: "success" };
  }
  return { notice: "Image build configuration detected; build the image.", tone: "success" };
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
