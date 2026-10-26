import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { APP_CONFIG_FILENAME, ConfigError, HANSE_DIR, loadProject } from "../config/load.js";
import { isMasterProject, MASTER_DIR_NAME } from "../master/constants.js";
import { isInside, resolveAppPath } from "../runtime/app-path.js";
import {
  type BaseImageConfigErrorCode,
  type BaseImageKind,
  legacyV1BaseReference,
  resolveBaseImage,
} from "../runtime/base-image.js";
import {
  boundedErrorMessage,
  computeBuildSpecHash,
  computeLegacyBuildSpecHashV1,
  defaultImageReference,
  resolveBuildDockerfile,
} from "../runtime/build-spec.js";
import { type Project, safeParseApp } from "../schema/index.js";
import type { SqliteDatabase } from "../store/index.js";

export type AppImageStatus = "missing" | "building" | "ready" | "stale" | "error";

/** Base-image identity recorded for a built image. */
export type AppImageBaseKind = BaseImageKind;

/** An application registered with the coordinator. */
export interface RegisteredApp {
  id: string;
  projectId: string;
  appKey: string;
  path: string;
  kind: string | null;
  contract: string;
  /** True while a deletion is pending or incomplete; never reset by re-registration. */
  deleting: boolean;
  imageStatus: AppImageStatus;
  imageRef: string | null;
  imageHash: string | null;
  imageBaseDigest: string | null;
  imageBuiltAt: string | null;
  imageError: string | null;
  imageBaseRef: string | null;
  imageBaseKind: AppImageBaseKind | null;
  imageHashVersion: number;
  imageBuildId: string | null;
  imageBuildRef: string | null;
  imageBuildStartedAt: string | null;
  imageBuildRejectedRef: string | null;
  imageRollbackRef?: string | null;
  imageRollbackBuiltAt?: string | null;
  /** Canonical absolute Dockerfile path, or `null` when the app is not a build app. */
  buildDockerfile: string | null;
  /** True when the app declares a per-app build, including an invalid one. */
  buildConfigured: boolean;
  buildArgs: Record<string, string>;
  /** Current image build spec hash; changes only with the Dockerfile, base, or build args. */
  buildSpecHash: string | null;
}

export interface RegisteredProject {
  id: string;
  name: string;
  baseBranch: string;
  rootPath: string;
  apps: RegisteredApp[];
}

/** Result of reading one application's build declaration from its real app directory. */
export interface AppBuildInspection {
  status: AppImageStatus;
  error: string | null;
  /** True when the app declares a per-app build, including an invalid one. */
  buildConfigured?: boolean;
  /** Canonical absolute Dockerfile path, or `null` when the app is not build-configured. */
  dockerfile: string | null;
  /** Manifest Dockerfile value relative to the application directory. */
  relativeDockerfile: string | null;
  /** Raw Dockerfile bytes, or `null` when no build spec could be resolved. */
  dockerfileContent?: Buffer | null;
  args: Record<string, string>;
  specHash: string | null;
  /** Resolved build base kind. */
  baseKind?: AppImageBaseKind | null;
  /** Resolved build base reference. */
  baseRef?: string | null;
  /** Bounded base-configuration error code, when the inspection failed there. */
  baseErrorCode?: BaseImageConfigErrorCode | null;
  /** Version of {@link specHash}; always 2 for a current inspection. */
  hashVersion?: number;
}

export interface ExistingImageRow {
  image_ref: string | null;
  image_status: AppImageStatus;
  image_hash: string | null;
  image_base_digest: string | null;
  image_built_at: string | null;
  image_error?: string | null;
  image_base_ref?: string | null;
  image_base_kind?: AppImageBaseKind | null;
  image_hash_version?: number;
  image_build_id?: string | null;
  image_build_ref?: string | null;
  image_build_started_at?: string | null;
  image_build_rejected_ref?: string | null;
}

export interface MergedImageMetadata {
  imageStatus: AppImageStatus;
  imageRef: string | null;
  imageHash: string | null;
  imageBaseDigest: string | null;
  imageBuiltAt: string | null;
  imageError: string | null;
  imageBaseRef: string | null;
  imageBaseKind: AppImageBaseKind | null;
  imageHashVersion: number;
  imageBuildRejectedRef: string | null;
}

/** Stable application id: unique per (project, app). */
export function appId(projectId: string, appKey: string): string {
  return `${projectId}:${appKey}`;
}

/** Discover a project manifest by walking up from `startDir`. */
export async function discoverProject(
  startDir: string,
): Promise<{ project: Project; rootPath: string }> {
  const { project, rootPath } = await loadProject(startDir);
  return { project, rootPath };
}

/**
 * Upsert a project and its applications into the store. Idempotent.
 *
 * Every manifest app path is validated before anything is written. Relative paths are confined to
 * `rootPath`; absolute paths are confined to `workspaceRoot`, which defaults to `rootPath` for
 * standalone commands that have no broader workspace (for example `hanse status`).
 *
 * The app manifest is read directly from `<appDir>/.hanse/app.yaml` and never inherited from a
 * parent directory. A missing manifest means the app uses the default image; an invalid manifest or
 * Dockerfile registers the app with an `error` image status instead of failing the project.
 */
export function registerProject(
  db: SqliteDatabase,
  project: Project,
  rootPath: string,
  workspaceRoot: string = rootPath,
): RegisteredProject {
  if (isMasterProject(project.id)) {
    throw new ConfigError(
      "VALIDATION_FAILED",
      `project id "${project.id}" is reserved for the built-in master agent`,
    );
  }
  let reservedDir: string | undefined;
  try {
    reservedDir = path.join(realpathSync(workspaceRoot), MASTER_DIR_NAME);
  } catch {
    reservedDir = undefined;
  }
  const prepared = project.apps.map((entry) => {
    const appDir = resolveAppPath({ appPath: entry.path, projectRoot: rootPath, workspaceRoot });
    if (reservedDir !== undefined && isInside(reservedDir, appDir)) {
      throw new ConfigError(
        "PATH_OUTSIDE_ROOT",
        "application path is inside the reserved master directory",
        { path: entry.path },
      );
    }
    return { entry, inspection: resolveAppBuild(appDir) };
  });

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at)
     VALUES (@id, @name, @base_branch, @root_path, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, base_branch = excluded.base_branch,
       root_path = excluded.root_path, updated_at = excluded.updated_at`,
  ).run({
    id: project.id,
    name: project.name,
    base_branch: project.base_branch,
    root_path: rootPath,
    created_at: now,
    updated_at: now,
  });

  const selectExisting = db.prepare(
    `SELECT image_ref, image_status, image_hash, image_base_digest, image_built_at, image_error,
            image_base_ref, image_base_kind, image_hash_version,
            image_build_id, image_build_ref, image_build_started_at, image_build_rejected_ref,
            deleting
     FROM apps WHERE id = ?`,
  );
  const upsertApp = db.prepare(
    `INSERT INTO apps (
       id, project_id, app_key, path, kind, contract, created_at,
       image_ref, image_status, image_hash, image_base_digest, image_built_at, image_error,
       build_configured, image_base_ref, image_base_kind, image_hash_version
     )
     VALUES (
       @id, @project_id, @app_key, @path, @kind, @contract, @created_at,
       @image_ref, @image_status, @image_hash, @image_base_digest, @image_built_at, @image_error,
       @build_configured, @image_base_ref, @image_base_kind, @image_hash_version
     )
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path, kind = excluded.kind, contract = excluded.contract,
       image_ref = excluded.image_ref, image_status = excluded.image_status,
       image_hash = excluded.image_hash, image_base_digest = excluded.image_base_digest,
       image_built_at = excluded.image_built_at, image_error = excluded.image_error,
       build_configured = excluded.build_configured,
       image_base_ref = excluded.image_base_ref, image_base_kind = excluded.image_base_kind,
       image_hash_version = excluded.image_hash_version`,
  );

  const apps: RegisteredApp[] = [];
  for (const { entry, inspection } of prepared) {
    const appKey = path.basename(entry.path);
    const id = appId(project.id, appKey);
    const kind = entry.kind ?? null;
    const existing = selectExisting.get(id) as
      | (ExistingImageRow & { deleting: number })
      | undefined;
    const image = mergeImageMetadata(existing, inspection);
    const buildConfigured =
      inspection.buildConfigured ??
      (inspection.status === "error" || inspection.dockerfile !== null);
    upsertApp.run({
      id,
      project_id: project.id,
      app_key: appKey,
      path: entry.path,
      kind,
      contract: "AGENTS.md",
      created_at: now,
      image_ref: image.imageRef,
      image_status: image.imageStatus,
      image_hash: image.imageHash,
      image_base_digest: image.imageBaseDigest,
      image_built_at: image.imageBuiltAt,
      image_error: image.imageError,
      build_configured: buildConfigured ? 1 : 0,
      image_base_ref: image.imageBaseRef,
      image_base_kind: image.imageBaseKind,
      image_hash_version: image.imageHashVersion,
    });
    apps.push({
      id,
      projectId: project.id,
      appKey,
      path: entry.path,
      kind,
      contract: "AGENTS.md",
      deleting: existing?.deleting === 1,
      ...image,
      imageBuildId: existing?.image_build_id ?? null,
      imageBuildRef: existing?.image_build_ref ?? null,
      imageBuildStartedAt: existing?.image_build_started_at ?? null,
      buildDockerfile: inspection.dockerfile,
      buildConfigured,
      buildArgs: inspection.args,
      buildSpecHash: inspection.specHash,
    });
  }

  return { id: project.id, name: project.name, baseBranch: project.base_branch, rootPath, apps };
}

/**
 * Read `.hanse/app.yaml` from the application's real directory and resolve its build spec.
 *
 * Exported so the coordinator image service uses exactly the same Dockerfile containment and hash
 * rules as registration, including the configured default image/digest.
 */
export function resolveAppBuild(
  appDir: string,
  defaultImage: string = defaultImageReference(),
  baseImage: string | undefined = configuredBaseImage(),
): AppBuildInspection {
  let raw: string | undefined;
  try {
    raw = readAppConfig(appDir);
  } catch (error) {
    return failedInspection(error);
  }
  if (raw === undefined) {
    return emptyInspection();
  }

  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (error) {
    return failedInspection(new Error(`invalid app.yaml: ${boundedErrorMessage(error)}`));
  }
  const parsed = safeParseApp(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return failedInspection(new Error(`invalid app.yaml: ${issues}`));
  }

  const build = parsed.data.build;
  if (build === undefined) {
    return emptyInspection();
  }

  const args = { ...(build.args ?? {}) };
  let resolved: ReturnType<typeof resolveBuildDockerfile>;
  try {
    resolved = resolveBuildDockerfile({ appDir, dockerfile: build.dockerfile });
  } catch (error) {
    return failedInspection(error, args);
  }
  try {
    const base = resolveBaseImage({
      dockerfile: resolved.content,
      args,
      declaredBase: build.base ?? null,
      defaultImage,
      baseImage: baseImage ?? null,
    });
    const specHash = computeBuildSpecHash({
      dockerfile: resolved.content,
      buildArgs: args,
      baseKind: base.kind,
    });
    return {
      status: "missing",
      error: null,
      buildConfigured: true,
      dockerfile: resolved.path,
      relativeDockerfile: build.dockerfile,
      dockerfileContent: resolved.content,
      args,
      specHash,
      baseKind: base.kind,
      baseRef: base.ref,
      baseErrorCode: null,
      hashVersion: 2,
    };
  } catch (error) {
    return failedInspection(error, args, resolved.content);
  }
}

function configuredBaseImage(): string | undefined {
  const value = process.env.HANSE_AGENT_BASE_IMAGE?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function readAppConfig(appDir: string): string | undefined {
  const configPath = path.join(appDir, HANSE_DIR, APP_CONFIG_FILENAME);
  try {
    lstatSync(configPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }

  const effectivePath = realpathSync(configPath);
  const root = realpathSync(appDir);
  if (path.relative(root, effectivePath) === "" || !isInside(root, effectivePath)) {
    throw new ConfigError("PATH_OUTSIDE_ROOT", "app.yaml escapes the application directory", {
      path: configPath,
    });
  }
  if (!statSync(effectivePath).isFile()) {
    throw new ConfigError("VALIDATION_FAILED", "app.yaml is not a regular file", {
      path: configPath,
    });
  }
  return readFileSync(effectivePath, "utf8");
}

function emptyInspection(): AppBuildInspection {
  return {
    status: "missing",
    error: null,
    buildConfigured: false,
    dockerfile: null,
    relativeDockerfile: null,
    dockerfileContent: null,
    args: {},
    specHash: null,
    baseKind: null,
    baseRef: null,
    baseErrorCode: null,
    hashVersion: 1,
  };
}

function failedInspection(
  error: unknown,
  args: Record<string, string> = {},
  dockerfileContent: Buffer | null = null,
): AppBuildInspection {
  return {
    status: "error",
    error: boundedErrorMessage(error),
    buildConfigured: true,
    dockerfile: null,
    relativeDockerfile: null,
    dockerfileContent,
    args,
    specHash: null,
    baseKind: null,
    baseRef: null,
    baseErrorCode: baseErrorCode(error),
    hashVersion: 1,
  };
}

function baseErrorCode(error: unknown): BaseImageConfigErrorCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "base_mismatch" || code === "base_unavailable" || code === "base_arg_reserved"
    ? code
    : null;
}

export function mergeImageMetadata(
  existing: ExistingImageRow | undefined,
  inspection: AppBuildInspection,
): MergedImageMetadata {
  if (inspection.status === "error") {
    return {
      imageStatus: "error",
      imageRef: existing?.image_ref ?? null,
      imageHash: existing?.image_hash ?? null,
      imageBaseDigest: existing?.image_base_digest ?? null,
      imageBuiltAt: existing?.image_built_at ?? null,
      imageError: inspection.error,
      imageBaseRef: existing?.image_base_ref ?? null,
      imageBaseKind: existing?.image_base_kind ?? null,
      imageHashVersion: existing?.image_hash_version ?? 1,
      imageBuildRejectedRef: existing?.image_build_rejected_ref ?? null,
    };
  }
  if (existing === undefined) {
    return {
      imageStatus: "missing",
      imageRef: null,
      imageHash: inspection.specHash,
      imageBaseDigest: null,
      imageBuiltAt: null,
      imageError: null,
      imageBaseRef: null,
      imageBaseKind: null,
      imageHashVersion: 2,
      imageBuildRejectedRef: null,
    };
  }
  if (inspection.dockerfile === null) {
    return {
      imageStatus: "missing",
      imageRef: null,
      imageHash: null,
      imageBaseDigest: null,
      imageBuiltAt: null,
      imageError: null,
      imageBaseRef: null,
      imageBaseKind: null,
      imageHashVersion: 1,
      imageBuildRejectedRef: existing.image_build_rejected_ref ?? null,
    };
  }
  const preservedError = existing.image_error ?? null;
  const rejectedRef = existing.image_build_rejected_ref ?? null;
  if (preservedError !== null || rejectedRef !== null) {
    return {
      imageStatus: "error",
      imageRef: existing.image_ref,
      imageHash: existing.image_hash,
      imageBaseDigest: existing.image_base_digest,
      imageBuiltAt: existing.image_built_at,
      imageError: preservedError,
      imageBaseRef: existing.image_base_ref ?? null,
      imageBaseKind: existing.image_base_kind ?? null,
      imageHashVersion: existing.image_hash_version ?? 1,
      imageBuildRejectedRef: rejectedRef,
    };
  }
  const hashChanged = legacyAwareHashChanged(existing, inspection);
  let imageStatus: AppImageStatus;
  if (existing.image_status === "error" || hashChanged) {
    imageStatus = "stale";
  } else if (existing.image_status === "stale") {
    imageStatus = existing.image_ref === null ? "missing" : "ready";
  } else {
    imageStatus = existing.image_status;
  }
  const fillUnbuiltHash = existing.image_ref === null && existing.image_hash === null;
  return {
    imageStatus,
    imageRef: existing.image_ref,
    imageHash: fillUnbuiltHash ? inspection.specHash : existing.image_hash,
    imageBaseDigest: existing.image_base_digest,
    imageBuiltAt: existing.image_built_at,
    imageError: null,
    imageBaseRef: existing.image_base_ref ?? null,
    imageBaseKind: existing.image_base_kind ?? null,
    imageHashVersion: fillUnbuiltHash ? 2 : (existing.image_hash_version ?? 1),
    imageBuildRejectedRef: rejectedRef,
  };
}

function legacyAwareHashChanged(
  existing: ExistingImageRow,
  inspection: AppBuildInspection,
): boolean {
  if (existing.image_ref === null) return false;
  if (existing.image_hash === null || inspection.specHash === null) return false;
  const storedVersion = existing.image_hash_version ?? 1;
  if (storedVersion === 2) {
    return existing.image_hash !== inspection.specHash;
  }
  if (storedVersion !== 1) return false;
  const legacyReference = legacyV1BaseReference(existing.image_base_digest);
  if (legacyReference === null || !inspection.dockerfileContent) return false;
  const recomputed = computeLegacyBuildSpecHashV1({
    dockerfile: inspection.dockerfileContent,
    defaultImage: legacyReference,
    buildArgs: inspection.args,
  });
  return recomputed !== existing.image_hash;
}
