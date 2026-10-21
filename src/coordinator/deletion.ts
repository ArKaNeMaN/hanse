import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ConfigError, HANSE_DIR, PROJECT_CONFIG_FILENAME } from "../config/load.js";
import type { RunnerImageRecord } from "../images/client.js";
import type { Logger } from "../logging/logger.js";
import { sanitizeAppKey } from "../opencode/instance.js";
import type { ImageGcReport } from "../runner/image-gc.js";
import { isInside, resolveAppPath, resolveWithinRoot } from "../runtime/app-path.js";
import { boundedErrorMessage } from "../runtime/build-spec.js";
import { projectSchema } from "../schema/index.js";
import type { SqliteDatabase } from "../store/index.js";

/** Manager surface needed by deletion; production passes `InstanceManager`. */
export interface DeletionManager {
  /**
   * Stop the app and durably mark it deleting in the same per-app lock body. Must ignore an
   * existing target marker so a retry works.
   */
  stopForDeletion(appId: string): Promise<boolean>;
}

/** Image-service surface needed by deletion; production passes `ImageService`. */
export interface DeletionImages {
  assertRunnerIdle(appId: string): Promise<RunnerImageRecord>;
  reserveDelete(appId: string, observed: RunnerImageRecord): void;
  endDelete(appId: string): void;
  purgeApp(appId: string): Promise<ImageGcReport>;
  forgetApp(appId: string): void;
}

export interface DeletionServiceOptions {
  db: SqliteDatabase;
  workspaceRoot: string;
  agentsHome: string;
  coordinatorStateDir: string;
  manager: DeletionManager;
  images: DeletionImages;
  /** Optional structured logger. Only ids, counts, and warnings are emitted. */
  logger?: Logger;
}

export interface DeleteOptions {
  /** Must exactly equal the project name (project delete) or app key (app delete). */
  confirm: string;
  /** Remove the source directory after the registry row is gone. Defaults to `false`. */
  deleteFiles?: boolean;
}

export interface DeleteResult {
  deleted: true;
  kind: "app" | "project";
  projectId: string;
  appKey?: string;
  warnings: string[];
}

/** Typed deletion failure; the HTTP layer maps `status`/`code` directly. */
export class DeletionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DeletionError";
    this.status = status;
    this.code = code;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  deleting: number;
}

interface AppRow {
  id: string;
  project_id: string;
  app_key: string;
  path: string;
  deleting: number;
  project_name: string;
  root_path: string;
  project_deleting: number;
}

interface Roots {
  workspace: string;
  agents: string;
  coordinator: string;
}

interface ManifestTarget {
  /** Canonical project root. */
  root: string;
  /** Canonical `.hanse` directory. */
  hanseDir: string;
  /** Canonical `project.yaml`. */
  file: string;
}

interface ProjectManifest {
  raw: Record<string, unknown>;
  id: string;
}

interface ProjectStateTarget {
  literal: string;
  resolved: string;
}

interface AppStateTarget extends ProjectStateTarget {
  projectLiteral: string;
  projectResolved: string;
}

interface AppDirectory {
  literal: string;
  resolved: string;
}

/** One process-wide mutex: deletions are rare, destructive, and serialize manifest writes. */
let deletionInProgress = false;

/**
 * Coordinator-side orchestration for application and project deletion.
 *
 * The service owns the order of destructive work: guard paths, reserve runtime images, stop the
 * runner, update the manifest, remove per-app state, commit all DB changes in one transaction, purge
 * images, and finally remove source files (when explicitly requested). Every failure before the DB
 * commit leaves a durable marker and a retryable state; post-commit failures are warnings.
 */
export class DeletionService {
  readonly #db: SqliteDatabase;
  readonly #workspaceRoot: string;
  readonly #agentsHome: string;
  readonly #coordinatorStateDir: string;
  readonly #manager: DeletionManager;
  readonly #images: DeletionImages;
  readonly #logger: Logger | undefined;

  readonly #projectReservations = new Set<string>();
  readonly #appReservations = new Set<string>();
  readonly #pathReservations = new Set<string>();

  constructor(options: DeletionServiceOptions) {
    this.#db = options.db;
    this.#workspaceRoot = options.workspaceRoot;
    this.#agentsHome = options.agentsHome;
    this.#coordinatorStateDir = options.coordinatorStateDir;
    this.#manager = options.manager;
    this.#images = options.images;
    this.#logger = options.logger;
  }

  /** True while any delete operation (of this process) holds the deletion mutex. */
  isActive(): boolean {
    return deletionInProgress;
  }

  isDeletingProject(projectId: string): boolean {
    return this.#projectReservations.has(projectId);
  }

  isDeletingApp(appId: string): boolean {
    return this.#appReservations.has(appId);
  }

  /**
   * True when the computed per-app state directory is reserved by an in-flight deletion.
   * Invalid project/app keys cannot match any reservation and return `false`.
   */
  isDeletingAppState(projectId: string, appKey: string): boolean {
    try {
      const projectSegment = sanitizeAppKey(projectId);
      const appSegment = sanitizeAppKey(appKey);
      assertSafeSegment(projectSegment, "project state segment");
      assertSafeSegment(appSegment, "application state segment");
      return this.isDeletingPath(path.join(this.#roots().agents, projectSegment, appSegment));
    } catch {
      return false;
    }
  }

  /** `resolvedPath` is expected to be a canonical path as used by the caller. */
  isDeletingPath(resolvedPath: string): boolean {
    const normalized = path.resolve(resolvedPath);
    for (const reserved of this.#pathReservations) {
      if (samePath(reserved, normalized)) {
        return true;
      }
    }
    return false;
  }

  async deleteApp(
    projectId: string,
    appKey: string,
    options: DeleteOptions,
  ): Promise<DeleteResult> {
    const project = this.#findProject(projectId);
    if (project === undefined) {
      throw new DeletionError(404, "project_not_found", "project not found");
    }
    const app = this.#findApp(projectId, appKey);
    if (app === undefined) {
      throw new DeletionError(404, "app_not_found", "application not found");
    }
    if (options.confirm !== app.app_key) {
      throw new DeletionError(
        400,
        "confirmation_mismatch",
        "confirmation must exactly match the application key",
      );
    }
    if (app.project_deleting === 1) {
      throw new DeletionError(
        409,
        "deletion_incomplete",
        "the project is being deleted; delete the project instead",
      );
    }

    const deleteFiles = options.deleteFiles === true;
    const roots = this.#roots();
    const appId = app.id;
    const warnings: string[] = [];

    this.#acquire();

    let imageReserved = false;
    let statePath: string | undefined;
    let sourcePath: string | undefined;
    try {
      this.#appReservations.add(appId);
      this.#logger?.info("deletion started", {
        kind: "app",
        projectId: app.project_id,
        appId,
        appKey: app.app_key,
      });

      // Fail fast on an invalid manifest before stopping anything. The write below re-reads it.
      const manifest = this.#readManifestForProject(app.root_path);
      const state = this.#resolveAppStateDir(app, roots);
      statePath = state.resolved;
      this.#pathReservations.add(statePath);
      const directory = this.#resolveAppDirectory(app, roots, deleteFiles, manifest?.raw);
      sourcePath = directory.resolved;
      this.#pathReservations.add(sourcePath);

      const observed = await this.#images.assertRunnerIdle(appId);
      this.#images.reserveDelete(appId, observed);
      imageReserved = true;

      try {
        await this.#manager.stopForDeletion(appId);
      } catch (error) {
        throw new DeletionError(
          502,
          "runtime_stop_failed",
          `failed to stop application ${appId}: ${errorMessage(error)}`,
        );
      }

      this.#assertNoSiblingStateCollision(app);
      this.#removeAppManifestEntry(app.root_path, directory.resolved, roots.workspace, app.app_key);
      this.#removeAppStateDir(app, state, roots.agents);
      this.#deleteAppRows(app);

      try {
        const report = await this.#images.purgeApp(appId);
        this.#recordImagePurgeWarnings(report, warnings, {
          kind: "app",
          projectId: app.project_id,
          appId,
        });
      } catch (error) {
        this.#addWarning(warnings, `image purge failed: ${errorMessage(error)}`, {
          kind: "app",
          projectId: app.project_id,
          appId,
        });
      } finally {
        this.#images.forgetApp(appId);
        this.#images.endDelete(appId);
        imageReserved = false;
      }

      if (deleteFiles) {
        this.#deleteAppSourceIfSafe(app, directory, roots, warnings);
      }

      this.#logger?.info("deletion completed", {
        kind: "app",
        projectId: app.project_id,
        appId,
        appKey: app.app_key,
        warnings: warnings.length,
      });
      return {
        deleted: true,
        kind: "app",
        projectId: app.project_id,
        appKey: app.app_key,
        warnings,
      };
    } catch (error) {
      throw asDeletionError(error);
    } finally {
      if (imageReserved) {
        this.#images.endDelete(appId);
      }
      this.#appReservations.delete(appId);
      if (statePath !== undefined) {
        this.#pathReservations.delete(statePath);
      }
      if (sourcePath !== undefined) {
        this.#pathReservations.delete(sourcePath);
      }
      this.#release();
    }
  }

  async deleteProject(projectId: string, options: DeleteOptions): Promise<DeleteResult> {
    const project = this.#findProject(projectId);
    if (project === undefined) {
      throw new DeletionError(404, "project_not_found", "project not found");
    }
    if (options.confirm !== project.name) {
      throw new DeletionError(
        400,
        "confirmation_mismatch",
        "confirmation must exactly match the project name",
      );
    }

    const deleteFiles = options.deleteFiles === true;
    const roots = this.#roots();
    const projectRoot = canonicalizePath(project.root_path);
    const warnings: string[] = [];

    this.#acquire();

    const reservedAppIds: string[] = [];
    let stateResolved: string | undefined;
    try {
      this.#projectReservations.add(project.id);
      this.#pathReservations.add(projectRoot);
      const state = this.#resolveProjectStateDir(project.id, roots);
      stateResolved = state.resolved;
      this.#pathReservations.add(state.resolved);
      this.#logger?.info("deletion started", {
        kind: "project",
        projectId: project.id,
      });

      // Validate the manifest path before the marker or any stop; parsing is only needed when
      // another project shares this root and may own the manifest.
      const manifestTarget = this.#manifestTarget(project.root_path);
      let removeManifest = true;
      if (this.#projectSharesRoot(project.id, projectRoot) && manifestTarget !== undefined) {
        const manifestId = this.#manifestIdForSharedRoot(manifestTarget);
        if (manifestId === undefined || manifestId === project.id) {
          throw new DeletionError(
            409,
            "shared_project_root",
            "the project root is shared with another project; its manifest cannot be removed safely",
          );
        }
        removeManifest = false;
      }

      // The marker blocks add-app and `ensure` for every app in the project before anything stops.
      this.#db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(project.id);

      const apps = this.#db
        .prepare("SELECT id, app_key FROM apps WHERE project_id = ? ORDER BY app_key")
        .all(project.id) as Array<{ id: string; app_key: string }>;

      for (const app of apps) {
        const observed = await this.#images.assertRunnerIdle(app.id);
        this.#images.reserveDelete(app.id, observed);
        reservedAppIds.push(app.id);
        try {
          await this.#manager.stopForDeletion(app.id);
        } catch (error) {
          // The project marker stays set: the project is `deletion_incomplete`, not normal.
          throw new DeletionError(
            502,
            "runtime_stop_failed",
            `failed to stop application ${app.id}: ${errorMessage(error)}`,
          );
        }
      }

      if (removeManifest) {
        this.#removeProjectManifest(project.root_path);
      }
      this.#removeStateDirectory(state, roots.agents, "project state directory");
      this.#deleteProjectRows(project, apps);

      for (const app of apps) {
        try {
          const report = await this.#images.purgeApp(app.id);
          this.#recordImagePurgeWarnings(report, warnings, {
            kind: "project",
            projectId: project.id,
            appId: app.id,
          });
        } catch (error) {
          this.#addWarning(warnings, `image purge failed for ${app.id}: ${errorMessage(error)}`, {
            kind: "project",
            projectId: project.id,
            appId: app.id,
          });
        } finally {
          this.#images.forgetApp(app.id);
        }
      }

      if (deleteFiles) {
        this.#deleteProjectSourceIfSafe(project, projectRoot, roots, warnings);
      }

      this.#logger?.info("deletion completed", {
        kind: "project",
        projectId: project.id,
        apps: apps.length,
        warnings: warnings.length,
      });
      return { deleted: true, kind: "project", projectId: project.id, warnings };
    } catch (error) {
      throw asDeletionError(error);
    } finally {
      for (const appId of reservedAppIds) {
        this.#images.endDelete(appId);
      }
      this.#projectReservations.delete(project.id);
      this.#pathReservations.delete(projectRoot);
      if (stateResolved !== undefined) {
        this.#pathReservations.delete(stateResolved);
      }
      this.#release();
    }
  }

  #acquire(): void {
    if (deletionInProgress) {
      throw new DeletionError(
        409,
        "deletion_in_progress",
        "another deletion is already in progress",
      );
    }
    deletionInProgress = true;
  }

  #release(): void {
    deletionInProgress = false;
  }

  #roots(): Roots {
    return {
      workspace: canonicalizePath(this.#workspaceRoot),
      agents: canonicalizePath(this.#agentsHome),
      coordinator: canonicalizePath(this.#coordinatorStateDir),
    };
  }

  #findProject(projectId: string): ProjectRow | undefined {
    return this.#db
      .prepare("SELECT id, name, root_path, deleting FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
  }

  #findApp(projectId: string, appKey: string): AppRow | undefined {
    return this.#db
      .prepare(
        `SELECT a.id, a.project_id, a.app_key, a.path, a.deleting,
                p.name AS project_name, p.root_path, p.deleting AS project_deleting
         FROM apps a
         JOIN projects p ON p.id = a.project_id
         WHERE a.project_id = ? AND a.app_key = ?`,
      )
      .get(projectId, appKey) as AppRow | undefined;
  }

  #projectSharesRoot(projectId: string, projectRoot: string): boolean {
    const others = this.#db
      .prepare("SELECT id, root_path FROM projects WHERE id <> ?")
      .all(projectId) as Array<{ id: string; root_path: string }>;
    return others.some((other) => samePath(canonicalizePath(other.root_path), projectRoot));
  }

  #manifestIdForSharedRoot(target: ManifestTarget): string | undefined {
    try {
      return readManifest(target).id;
    } catch {
      return undefined;
    }
  }

  #manifestTarget(projectRoot: string): ManifestTarget | undefined {
    const literalRoot = path.resolve(projectRoot);
    if (lstatIfExists(literalRoot) === undefined) {
      return undefined;
    }
    const root = canonicalizePath(literalRoot);
    const hanseLiteral = path.join(literalRoot, HANSE_DIR);
    if (!this.#assertManifestDirectory(hanseLiteral)) {
      return undefined;
    }
    const hanseDir = realpathSync(hanseLiteral);
    if (!strictlyInside(root, hanseDir)) {
      throw new DeletionError(
        409,
        "unsafe_manifest_path",
        `${HANSE_DIR} is not strictly inside the project root`,
      );
    }
    const fileLiteral = path.join(hanseLiteral, PROJECT_CONFIG_FILENAME);
    if (!this.#assertManifestFile(fileLiteral)) {
      return undefined;
    }
    const file = realpathSync(fileLiteral);
    if (!strictlyInside(hanseDir, file) || !strictlyInside(root, file)) {
      throw new DeletionError(
        409,
        "unsafe_manifest_path",
        `${HANSE_DIR}/${PROJECT_CONFIG_FILENAME} is not strictly inside the project root`,
      );
    }
    return { root, hanseDir, file };
  }

  #assertManifestDirectory(target: string): boolean {
    const stat = lstatIfExists(target);
    if (stat === undefined) {
      return false;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DeletionError(409, "unsafe_manifest_path", `${HANSE_DIR} must be a real directory`);
    }
    return true;
  }

  #assertManifestFile(target: string): boolean {
    const stat = lstatIfExists(target);
    if (stat === undefined) {
      return false;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new DeletionError(
        409,
        "unsafe_manifest_path",
        `${HANSE_DIR}/${PROJECT_CONFIG_FILENAME} must be a regular file`,
      );
    }
    return true;
  }

  #readManifestForProject(projectRoot: string): ProjectManifest | undefined {
    const target = this.#manifestTarget(projectRoot);
    if (target === undefined) {
      return undefined;
    }
    return readManifest(target);
  }

  /**
   * Re-read the manifest synchronously, remove the entry whose resolved path is `appDir`, and
   * atomically replace the file via temp + rename in the verified `.hanse` directory.
   */
  #removeAppManifestEntry(
    projectRoot: string,
    appDir: string,
    workspaceRoot: string,
    appKey: string,
  ): void {
    const target = this.#manifestTarget(projectRoot);
    if (target === undefined) {
      return;
    }
    const manifest = readManifest(target);
    const apps = manifest.raw.apps;
    if (!Array.isArray(apps)) {
      return;
    }
    const remaining = apps.filter((entry) => {
      if (!isRecord(entry) || typeof entry.path !== "string") {
        return true;
      }
      if (path.basename(entry.path) !== appKey) {
        return true;
      }
      try {
        const resolved = resolveAppPath({
          appPath: entry.path,
          projectRoot: target.root,
          workspaceRoot,
        });
        return !samePath(resolved, appDir);
      } catch {
        return true;
      }
    });
    if (remaining.length === apps.length) {
      return;
    }
    manifest.raw.apps = remaining;
    const temp = path.join(target.hanseDir, `.${PROJECT_CONFIG_FILENAME}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, stringifyYaml(manifest.raw), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, target.file);
    } finally {
      removeIfExists(temp);
    }
  }

  #removeProjectManifest(projectRoot: string): void {
    const target = this.#manifestTarget(projectRoot);
    if (target === undefined) {
      return;
    }
    unlinkSync(target.file);
  }

  #resolveProjectStateDir(projectId: string, roots: Roots): ProjectStateTarget {
    const segment = sanitizeAppKey(projectId);
    assertSafeSegment(segment, "project state segment");
    const literal = path.join(roots.agents, segment);
    if (lstatIfExists(literal) !== undefined) {
      this.#assertRealDirectory(literal, "project state directory");
    }
    const resolved = resolveStateWithinAgents(literal, roots.agents);
    if (samePath(resolved, roots.workspace) || related(resolved, roots.workspace)) {
      throw new DeletionError(
        409,
        "unsafe_state_path",
        "project state directory overlaps the workspace root",
      );
    }
    if (related(resolved, roots.coordinator)) {
      throw new DeletionError(
        409,
        "unsafe_state_path",
        "project state directory overlaps the coordinator state root",
      );
    }
    const others = this.#db
      .prepare("SELECT id FROM projects WHERE id <> ?")
      .all(projectId) as Array<{ id: string }>;
    for (const other of others) {
      const otherSegment = sanitizeAppKey(other.id);
      if (otherSegment === "" || otherSegment === "." || otherSegment === "..") {
        continue;
      }
      const otherResolved = canonicalizePath(path.join(roots.agents, otherSegment));
      if (related(resolved, otherResolved)) {
        throw new DeletionError(
          409,
          "state_path_collision",
          "project state directory collides with another project",
        );
      }
    }
    return { literal, resolved };
  }

  #resolveAppStateDir(app: AppRow, roots: Roots): AppStateTarget {
    const projectSegment = sanitizeAppKey(app.project_id);
    const appSegment = sanitizeAppKey(app.app_key);
    assertSafeSegment(projectSegment, "project state segment");
    assertSafeSegment(appSegment, "application state segment");

    const projectLiteral = path.join(roots.agents, projectSegment);
    const literal = path.join(projectLiteral, appSegment);
    if (lstatIfExists(projectLiteral) !== undefined) {
      this.#assertRealDirectory(projectLiteral, "project state directory");
    }
    if (lstatIfExists(literal) !== undefined) {
      this.#assertRealDirectory(literal, "application state directory");
    }

    const projectResolved = resolveStateWithinAgents(projectLiteral, roots.agents);
    const resolved = resolveStateWithinAgents(literal, roots.agents);
    if (samePath(resolved, projectResolved)) {
      throw new DeletionError(
        409,
        "unsafe_state_path",
        "application state directory resolves to the project state directory",
      );
    }
    if (related(resolved, roots.workspace)) {
      throw new DeletionError(
        409,
        "unsafe_state_path",
        "application state directory overlaps the workspace root",
      );
    }
    if (related(resolved, roots.coordinator)) {
      throw new DeletionError(
        409,
        "unsafe_state_path",
        "application state directory overlaps the coordinator state root",
      );
    }

    // Equality is the real collision risk (`web:api` and `web-api`); ancestry is impossible with
    // two fixed segments, but both directions are checked so the guard cannot regress.
    const siblings = this.#db
      .prepare("SELECT id, app_key FROM apps WHERE project_id = ? AND id <> ?")
      .all(app.project_id, app.id) as Array<{ id: string; app_key: string }>;
    for (const sibling of siblings) {
      const siblingSegment = sanitizeAppKey(sibling.app_key);
      if (
        siblingSegment === "" ||
        siblingSegment === "." ||
        siblingSegment === ".." ||
        siblingSegment === appSegment
      ) {
        if (siblingSegment === appSegment) {
          throw new DeletionError(
            409,
            "state_path_collision",
            `application ${app.app_key} shares its state directory with ${sibling.app_key}`,
          );
        }
        continue;
      }
      const siblingResolved = canonicalizePath(
        path.join(roots.agents, projectSegment, siblingSegment),
      );
      if (related(resolved, siblingResolved)) {
        throw new DeletionError(
          409,
          "state_path_collision",
          `application ${app.app_key} shares its state directory with ${sibling.app_key}`,
        );
      }
    }

    const projects = this.#db
      .prepare("SELECT id FROM projects WHERE id <> ?")
      .all(app.project_id) as Array<{ id: string }>;
    for (const other of projects) {
      const otherSegment = sanitizeAppKey(other.id);
      if (otherSegment === "" || otherSegment === "." || otherSegment === "..") {
        continue;
      }
      const otherProjectState = canonicalizePath(path.join(roots.agents, otherSegment));
      if (related(projectResolved, otherProjectState)) {
        throw new DeletionError(
          409,
          "state_path_collision",
          "project state directory collides with another project",
        );
      }
    }

    return { literal, resolved, projectLiteral, projectResolved };
  }

  #assertNoSiblingStateCollision(app: AppRow): void {
    const appSegment = sanitizeAppKey(app.app_key);
    const siblings = this.#db
      .prepare("SELECT app_key FROM apps WHERE project_id = ? AND id <> ?")
      .all(app.project_id, app.id) as Array<{ app_key: string }>;
    for (const sibling of siblings) {
      if (sanitizeAppKey(sibling.app_key) === appSegment) {
        throw new DeletionError(
          409,
          "state_path_collision",
          `application ${app.app_key} shares its state directory with ${sibling.app_key}`,
        );
      }
    }
  }

  #removeAppStateDir(app: AppRow, state: AppStateTarget, agentsRoot: string): void {
    this.#assertNoSiblingStateCollision(app);
    this.#assertRealDirectory(state.projectLiteral, "project state directory");
    this.#removeStateDirectory(state, agentsRoot, "application state directory");
  }

  #removeStateDirectory(target: ProjectStateTarget, agentsRoot: string, label: string): void {
    const stat = lstatIfExists(target.literal);
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new DeletionError(409, "unsafe_state_path", `${label} must be a real directory`);
      }
    }
    let current: string;
    try {
      current = resolveWithinRoot({ target: target.literal, root: agentsRoot, label });
    } catch (error) {
      throw new DeletionError(409, "unsafe_state_path", errorMessage(error));
    }
    if (!samePath(current, target.resolved)) {
      throw new DeletionError(409, "unsafe_state_path", `${label} changed during deletion`);
    }
    rmSync(current, { recursive: true, force: true });
  }

  #assertRealDirectory(target: string, label: string): void {
    const stat = lstatIfExists(target);
    if (stat === undefined) {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DeletionError(409, "unsafe_state_path", `${label} must be a real directory`);
    }
  }

  #resolveAppDirectory(
    app: AppRow,
    roots: Roots,
    deleteFiles: boolean,
    manifest: Record<string, unknown> | undefined,
  ): AppDirectory {
    const projectRoot = canonicalizePath(app.root_path);
    const literal = path.isAbsolute(app.path)
      ? path.resolve(app.path)
      : path.resolve(projectRoot, app.path);
    let resolved: string;
    try {
      resolved = resolveAppPath({
        appPath: app.path,
        projectRoot: app.root_path,
        workspaceRoot: roots.workspace,
      });
    } catch (error) {
      throw new DeletionError(409, "unsafe_app_dir", errorMessage(error));
    }
    if (
      samePath(resolved, roots.workspace) ||
      samePath(resolved, roots.agents) ||
      samePath(resolved, roots.coordinator) ||
      samePath(resolved, projectRoot)
    ) {
      throw new DeletionError(
        409,
        "unsafe_app_dir",
        "application directory resolves to a protected root",
      );
    }
    const stat = lstatIfExists(literal);
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new DeletionError(
          409,
          "unsafe_app_dir",
          "application directory must be a real directory",
        );
      }
    }

    if (deleteFiles) {
      const walkRoot = path.isAbsolute(app.path) ? roots.workspace : projectRoot;
      assertNoSymlinkComponents(walkRoot, literal, "unsafe_app_dir");
    }

    const otherApps = this.#resolvedOtherAppDirectories(app, roots);
    for (const other of otherApps) {
      if (samePath(resolved, other.resolved)) {
        throw new DeletionError(
          409,
          "shared_app_dir",
          `application directory is shared with ${other.id}`,
        );
      }
    }
    if (manifest !== undefined && Array.isArray(manifest.apps)) {
      for (const entry of manifest.apps) {
        if (!isRecord(entry) || typeof entry.path !== "string" || entry.path === app.path) {
          continue;
        }
        try {
          const sibling = resolveAppPath({
            appPath: entry.path,
            projectRoot: app.root_path,
            workspaceRoot: roots.workspace,
          });
          if (samePath(sibling, resolved)) {
            throw new DeletionError(
              409,
              "shared_app_dir",
              "application directory is shared with a manifest entry",
            );
          }
        } catch (error) {
          if (error instanceof DeletionError) {
            throw error;
          }
        }
      }
    }

    if (deleteFiles) {
      if (
        samePath(resolved, path.parse(resolved).root) ||
        isInside(resolved, roots.agents) ||
        isInside(roots.agents, resolved) ||
        isInside(resolved, roots.workspace) ||
        related(resolved, roots.coordinator)
      ) {
        throw new DeletionError(
          409,
          "unsafe_app_dir",
          "application source directory overlaps a protected root",
        );
      }
      for (const other of otherApps) {
        if (isInside(resolved, other.resolved)) {
          throw new DeletionError(
            409,
            "shared_app_dir",
            `application source directory contains ${other.id}`,
          );
        }
      }
    }

    return { literal, resolved };
  }

  #resolvedOtherAppDirectories(app: AppRow, roots: Roots): Array<{ id: string; resolved: string }> {
    const rows = this.#db
      .prepare(
        `SELECT a.id, a.path, p.root_path
         FROM apps a JOIN projects p ON p.id = a.project_id
         WHERE a.id <> ?`,
      )
      .all(app.id) as Array<{ id: string; path: string; root_path: string }>;
    const resolved: Array<{ id: string; resolved: string }> = [];
    for (const row of rows) {
      try {
        resolved.push({
          id: row.id,
          resolved: resolveAppPath({
            appPath: row.path,
            projectRoot: row.root_path,
            workspaceRoot: roots.workspace,
          }),
        });
      } catch {
        // A stale/invalid sibling path must not prevent deleting a valid app.
      }
    }
    return resolved;
  }

  #deleteAppRows(app: AppRow): void {
    const run = this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE handoffs SET target_task_id = NULL
           WHERE target_task_id IN (SELECT id FROM tasks WHERE app_id = ?)`,
        )
        .run(app.id);
      this.#db
        .prepare("DELETE FROM handoffs WHERE from_app_id = ? OR to_app_id = ?")
        .run(app.id, app.id);
      this.#db
        .prepare("DELETE FROM settings WHERE scope = 'app' AND project_id = ? AND app_key = ?")
        .run(app.project_id, app.app_key);
      this.#db
        .prepare("DELETE FROM provider_keys WHERE scope = 'app' AND project_id = ? AND app_key = ?")
        .run(app.project_id, app.app_key);
      this.#db
        .prepare(
          "DELETE FROM setting_secrets WHERE scope = 'app' AND project_id = ? AND app_key = ?",
        )
        .run(app.project_id, app.app_key);
      this.#db
        .prepare(
          "INSERT INTO events (scope, type, payload, created_at) VALUES ('app', 'app.deleted', ?, ?)",
        )
        .run(
          JSON.stringify({
            projectId: app.project_id,
            appId: app.id,
            appKey: app.app_key,
          }),
          new Date().toISOString(),
        );
      this.#db.prepare("DELETE FROM apps WHERE id = ?").run(app.id);
    });
    run();
  }

  #deleteProjectRows(
    project: ProjectRow,
    apps: ReadonlyArray<{ id: string; app_key: string }>,
  ): void {
    const run = this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE handoffs SET target_task_id = NULL
           WHERE target_task_id IN (
             SELECT id FROM tasks WHERE app_id IN (
               SELECT id FROM apps WHERE project_id = ?
             )
           )`,
        )
        .run(project.id);
      this.#db
        .prepare(
          `DELETE FROM handoffs
           WHERE project_id = ?
              OR from_app_id IN (SELECT id FROM apps WHERE project_id = ?)
              OR to_app_id IN (SELECT id FROM apps WHERE project_id = ?)`,
        )
        .run(project.id, project.id, project.id);
      this.#db.prepare("DELETE FROM settings WHERE project_id = ?").run(project.id);
      this.#db.prepare("DELETE FROM provider_keys WHERE project_id = ?").run(project.id);
      this.#db.prepare("DELETE FROM setting_secrets WHERE project_id = ?").run(project.id);
      this.#db
        .prepare(
          "INSERT INTO events (scope, type, payload, created_at) VALUES ('project', 'project.deleted', ?, ?)",
        )
        .run(
          JSON.stringify({
            projectId: project.id,
            apps: apps.map((app) => app.id),
          }),
          new Date().toISOString(),
        );
      this.#db.prepare("DELETE FROM apps WHERE project_id = ?").run(project.id);
      this.#db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    });
    run();
  }

  #addWarning(warnings: string[], warning: string, fields: Record<string, unknown>): void {
    warnings.push(warning);
    this.#logger?.warn(warning, fields);
  }

  #recordImagePurgeWarnings(
    report: ImageGcReport,
    warnings: string[],
    fields: Record<string, unknown>,
  ): void {
    if (report.skipped.length > 0) {
      const shown = report.skipped
        .slice(0, 5)
        .map((entry) => `${entry.ref} (${entry.reason})`)
        .join(", ");
      const extra = report.skipped.length > 5 ? `, and ${report.skipped.length - 5} more` : "";
      this.#addWarning(
        warnings,
        `image purge skipped ${report.skipped.length} image(s): ${shown}${extra}`,
        fields,
      );
    }
    if (report.truncated) {
      this.#addWarning(warnings, "image purge report was truncated", fields);
    }
  }

  #deleteAppSourceIfSafe(
    app: AppRow,
    directory: AppDirectory,
    roots: Roots,
    warnings: string[],
  ): void {
    const skip = (reason: string): void => {
      this.#addWarning(warnings, `source directory skipped: ${reason}`, {
        kind: "app",
        projectId: app.project_id,
        appId: app.id,
      });
    };
    if (this.#db.prepare("SELECT id FROM apps WHERE id = ?").get(app.id) !== undefined) {
      skip("application was re-added");
      return;
    }
    let projects: Array<{ id: string; root: string }>;
    let otherAppPaths: string[];
    try {
      projects = (
        this.#db.prepare("SELECT id, root_path FROM projects").all() as Array<{
          id: string;
          root_path: string;
        }>
      ).map((row) => ({ id: row.id, root: canonicalizePath(row.root_path) }));
      otherAppPaths = this.#resolvedAllAppPaths(roots);
    } catch {
      skip("could not re-verify registry paths");
      return;
    }
    const ownProject = projects.find((candidate) => candidate.id === app.project_id);
    if (ownProject === undefined) {
      skip("own project is no longer registered");
      return;
    }
    for (const project of projects) {
      if (project.id === app.project_id) {
        if (
          samePath(directory.resolved, project.root) ||
          isInside(directory.resolved, project.root)
        ) {
          skip("application source is the project root or an ancestor");
          return;
        }
      } else if (related(directory.resolved, project.root)) {
        skip("application source overlaps another project root");
        return;
      }
    }
    for (const appPath of otherAppPaths) {
      if (related(directory.resolved, appPath)) {
        skip("application source overlaps another application");
        return;
      }
    }
    if (sourceOverlapsProtectedRoots(directory.resolved, roots)) {
      skip("application source overlaps a protected root");
      return;
    }
    if (!sourceDirectoryIsSymlinkFree(directory.literal, directory.resolved)) {
      skip("application source path is a symlink or not a real directory");
      return;
    }
    try {
      rmSync(directory.resolved, { recursive: true, force: true });
    } catch (error) {
      skip(`filesystem error: ${errorMessage(error)}`);
    }
  }

  #deleteProjectSourceIfSafe(
    project: ProjectRow,
    projectRoot: string,
    roots: Roots,
    warnings: string[],
  ): void {
    const skip = (reason: string): void => {
      this.#addWarning(warnings, `source directory skipped: ${reason}`, {
        kind: "project",
        projectId: project.id,
      });
    };
    if (this.#db.prepare("SELECT id FROM projects WHERE id = ?").get(project.id) !== undefined) {
      skip("project was re-added");
      return;
    }
    let projectRoots: string[];
    let appPaths: string[];
    try {
      projectRoots = (
        this.#db.prepare("SELECT root_path FROM projects").all() as Array<{
          root_path: string;
        }>
      ).map((row) => canonicalizePath(row.root_path));
      appPaths = this.#resolvedAllAppPaths(roots);
    } catch {
      skip("could not re-verify registry paths");
      return;
    }
    for (const root of projectRoots) {
      if (related(projectRoot, root)) {
        skip("project source overlaps another project root");
        return;
      }
    }
    for (const appPath of appPaths) {
      if (related(projectRoot, appPath)) {
        skip("project source overlaps another application");
        return;
      }
    }
    if (sourceOverlapsProtectedRoots(projectRoot, roots)) {
      skip("project source overlaps a protected root");
      return;
    }
    const literal = path.resolve(project.root_path);
    if (!sourceDirectoryIsSymlinkFree(literal, projectRoot)) {
      skip("project source path is a symlink or not a real directory");
      return;
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch (error) {
      skip(`filesystem error: ${errorMessage(error)}`);
    }
  }

  #resolvedAllAppPaths(roots: Roots): string[] {
    const rows = this.#db
      .prepare("SELECT a.path, p.root_path FROM apps a JOIN projects p ON p.id = a.project_id")
      .all() as Array<{ path: string; root_path: string }>;
    const resolved: string[] = [];
    for (const row of rows) {
      try {
        resolved.push(
          resolveAppPath({
            appPath: row.path,
            projectRoot: row.root_path,
            workspaceRoot: roots.workspace,
          }),
        );
      } catch {
        // An invalid sibling row is not a containment target; it cannot be deleted by this call.
      }
    }
    return resolved;
  }
}

function readManifest(target: ManifestTarget): ProjectManifest {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(target.file, "utf8"));
  } catch (error) {
    throw new DeletionError(
      409,
      "invalid_manifest",
      `cannot read project manifest: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new DeletionError(409, "invalid_manifest", "project manifest must be a YAML object");
  }
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DeletionError(
      409,
      "invalid_manifest",
      `invalid project manifest: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return { raw, id: parsed.data.id };
}

function resolveStateWithinAgents(literal: string, agentsRoot: string): string {
  try {
    return resolveWithinRoot({ target: literal, root: agentsRoot, label: "state directory" });
  } catch (error) {
    throw new DeletionError(409, "unsafe_state_path", errorMessage(error));
  }
}

function sourceOverlapsProtectedRoots(target: string, roots: Roots): boolean {
  const filesystemRoot = path.parse(target).root;
  return (
    samePath(target, filesystemRoot) ||
    samePath(target, roots.workspace) ||
    samePath(target, roots.agents) ||
    samePath(target, roots.coordinator) ||
    isInside(target, roots.workspace) ||
    isInside(target, roots.agents) ||
    isInside(roots.agents, target) ||
    related(target, roots.coordinator)
  );
}

function sourceDirectoryIsSymlinkFree(literal: string, resolved: string): boolean {
  const stat = lstatIfExists(literal);
  if (stat === undefined) {
    return true;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return false;
  }
  try {
    assertNoSymlinkComponents(
      path.parse(path.resolve(literal)).root,
      path.resolve(literal),
      "unsafe_app_dir",
    );
  } catch {
    return false;
  }
  return samePath(canonicalizePath(literal), resolved);
}

function assertNoSymlinkComponents(root: string, target: string, code: string): void {
  const relative = path.relative(root, target);
  if (relative === "") {
    return;
  }
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new DeletionError(409, code, "path escapes its allowed root");
  }
  const segments = relative.split(path.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (segment === "" || segment === ".") {
      continue;
    }
    current = path.join(current, segment);
    const stat = lstatIfExists(current);
    if (stat === undefined) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new DeletionError(409, code, "path contains a symlink component");
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new DeletionError(409, code, "path component is not a directory");
    }
  }
}

function assertSafeSegment(segment: string, label: string): void {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\")
  ) {
    throw new DeletionError(409, "unsafe_state_path", `${label} is not a safe path segment`);
  }
}

function canonicalizePath(target: string): string {
  const resolved = path.resolve(target);
  let current = resolved;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return resolved;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function lstatIfExists(target: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

function removeIfExists(target: string): void {
  try {
    unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

function strictlyInside(root: string, target: string): boolean {
  return path.relative(root, target) !== "" && isInside(root, target);
}

function related(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return boundedErrorMessage(error);
}

function asDeletionError(error: unknown): DeletionError {
  if (error instanceof DeletionError) {
    return error;
  }
  if (error instanceof ConfigError) {
    return new DeletionError(409, "unsafe_app_dir", error.message);
  }
  const candidate = error as { status?: unknown; code?: unknown } | null;
  if (
    candidate !== null &&
    typeof candidate.status === "number" &&
    typeof candidate.code === "string"
  ) {
    return new DeletionError(candidate.status, candidate.code, errorMessage(error));
  }
  return new DeletionError(500, "deletion_failed", errorMessage(error));
}
