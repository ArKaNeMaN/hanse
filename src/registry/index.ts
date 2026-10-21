import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { APP_CONFIG_FILENAME, ConfigError, HANSE_DIR, loadProject } from "../config/load.js";
import { isInside, resolveAppPath } from "../runtime/app-path.js";
import {
  boundedErrorMessage,
  computeBuildSpecHash,
  defaultImageReference,
  resolveBuildDockerfile,
} from "../runtime/build-spec.js";
import { type Project, safeParseApp } from "../schema/index.js";
import type { SqliteDatabase } from "../store/index.js";

export type AppImageStatus = "missing" | "building" | "ready" | "stale" | "error";

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
  /** Canonical absolute Dockerfile path, or `null` when the app is not build-configured. */
  dockerfile: string | null;
  /** Manifest Dockerfile value relative to the application directory. */
  relativeDockerfile: string | null;
  args: Record<string, string>;
  specHash: string | null;
}

interface ExistingImageRow {
  image_ref: string | null;
  image_status: AppImageStatus;
  image_hash: string | null;
  image_base_digest: string | null;
  image_built_at: string | null;
}

interface MergedImageMetadata {
  imageStatus: AppImageStatus;
  imageRef: string | null;
  imageHash: string | null;
  imageBaseDigest: string | null;
  imageBuiltAt: string | null;
  imageError: string | null;
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
  const prepared = project.apps.map((entry) => {
    const appDir = resolveAppPath({ appPath: entry.path, projectRoot: rootPath, workspaceRoot });
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
    `SELECT image_ref, image_status, image_hash, image_base_digest, image_built_at, deleting
     FROM apps WHERE id = ?`,
  );
  const upsertApp = db.prepare(
    `INSERT INTO apps (
       id, project_id, app_key, path, kind, contract, created_at,
       image_ref, image_status, image_hash, image_base_digest, image_built_at, image_error
     )
     VALUES (
       @id, @project_id, @app_key, @path, @kind, @contract, @created_at,
       @image_ref, @image_status, @image_hash, @image_base_digest, @image_built_at, @image_error
     )
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path, kind = excluded.kind, contract = excluded.contract,
       image_ref = excluded.image_ref, image_status = excluded.image_status,
       image_hash = excluded.image_hash, image_base_digest = excluded.image_base_digest,
       image_built_at = excluded.image_built_at, image_error = excluded.image_error`,
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
      buildDockerfile: inspection.dockerfile,
      buildConfigured: inspection.status === "error" || inspection.dockerfile !== null,
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
  try {
    const resolved = resolveBuildDockerfile({ appDir, dockerfile: build.dockerfile });
    const specHash = computeBuildSpecHash({
      dockerfile: resolved.content,
      defaultImage,
      buildArgs: args,
    });
    return {
      status: "missing",
      error: null,
      dockerfile: resolved.path,
      relativeDockerfile: build.dockerfile,
      args,
      specHash,
    };
  } catch (error) {
    return failedInspection(error, args);
  }
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
    dockerfile: null,
    relativeDockerfile: null,
    args: {},
    specHash: null,
  };
}

function failedInspection(error: unknown, args: Record<string, string> = {}): AppBuildInspection {
  return {
    status: "error",
    error: boundedErrorMessage(error),
    dockerfile: null,
    relativeDockerfile: null,
    args,
    specHash: null,
  };
}

function mergeImageMetadata(
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
    };
  }
  const hashChanged =
    existing.image_hash !== null &&
    inspection.specHash !== null &&
    existing.image_hash !== inspection.specHash;
  let imageStatus: AppImageStatus;
  if (existing.image_status === "error" || hashChanged) {
    imageStatus = "stale";
  } else if (existing.image_status === "stale") {
    imageStatus = existing.image_ref === null ? "missing" : "ready";
  } else {
    imageStatus = existing.image_status;
  }
  return {
    imageStatus,
    imageRef: existing.image_ref,
    imageHash: existing.image_hash ?? inspection.specHash,
    imageBaseDigest: existing.image_base_digest,
    imageBuiltAt: existing.image_built_at,
    imageError: null,
  };
}
