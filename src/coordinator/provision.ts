import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isValidAppId } from "../agent/spec.js";
import { ConfigError } from "../config/load.js";
import { isMasterProject, masterAppDir } from "../master/constants.js";
import { writeRegularFileNoFollow } from "../master/workspace-files.js";
import { isInside, resolveAppPath } from "../runtime/app-path.js";
import type { SqliteDatabase } from "../store/index.js";

export type ProvisioningErrorCode =
  | "invalid_argument"
  | "invalid_path"
  | "reserved_path"
  | "project_not_found"
  | "project_exists"
  | "project_manifest_missing"
  | "invalid_manifest"
  | "app_exists"
  | "deletion_in_progress"
  | "deletion_incomplete"
  | "clone_failed"
  | "io_error";

/** A provisioning request failed with a stable code and an HTTP-friendly status. */
export class ProvisioningError extends Error {
  readonly code: ProvisioningErrorCode;
  readonly status: number;
  readonly configCode?: string;

  constructor(
    code: ProvisioningErrorCode,
    status: number,
    message: string,
    options: { configCode?: string; cause?: unknown } = {},
  ) {
    const detail =
      options.cause instanceof Error && options.cause.message.length > 0
        ? `: ${options.cause.message}`
        : "";
    super(`${message}${detail}`);
    this.name = "ProvisioningError";
    this.code = code;
    this.status = status;
    this.configCode = options.configCode;
  }
}

/** Subset of `DeletionService` used to reject provisioning during a deletion. */
export interface ProvisioningDeletionGuard {
  isActive(): boolean;
  isDeletingProject(projectId: string): boolean;
  isDeletingApp(appId: string): boolean;
  isDeletingAppState(projectId: string, appKey: string): boolean;
  isDeletingPath(resolvedPath: string): boolean;
}

export interface ProvisioningDeps {
  db: SqliteDatabase;
  workspaceRoot: string;
  deletion?: ProvisioningDeletionGuard;
  /** Test seam for `git clone`; production runs git in the coordinator. */
  clone?: (remote: string, target: string) => void;
}

export interface CreateProjectInput {
  name: string;
  /** Optional single workspace-relative directory name; defaults to the name slug. */
  directory?: string;
}

export interface CreateProjectResult {
  id: string;
  name: string;
  rootPath: string;
  directory: string;
}

export interface AddApplicationInput {
  projectId: string;
  name: string;
  /** Workspace-relative or project-relative path, or an absolute path inside the workspace. */
  path?: string;
  remote?: string;
}

export interface AddApplicationResult {
  id: string;
  projectId: string;
  appKey: string;
  path: string;
  rootPath: string;
}

const RESERVED_SEGMENTS = new Set([".git", ".hanse", ".hanse-master"]);
const REMOTE_SCHEME = /^(?:https?|ssh|git):\/\/[^\s]+$/i;
const REMOTE_SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function requireName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProvisioningError("invalid_argument", 400, "name is required");
  }
  const name = value.trim();
  if (name.length === 0 || name.length > 200 || hasControlCharacters(name)) {
    throw new ProvisioningError(
      "invalid_argument",
      400,
      "name must be 1-200 characters without control characters",
    );
  }
  return name;
}

function slugFor(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0 || slug === "." || slug === ".." || RESERVED_SEGMENTS.has(slug)) {
    return fallback;
  }
  return slug.slice(0, 100);
}

function requireSingleSegment(value: unknown, label: string): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ProvisioningError("invalid_argument", 400, `${label} must be a string`);
  }
  const segment = value.trim();
  if (segment.length === 0) {
    return "";
  }
  if (
    segment.length > 100 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    hasControlCharacters(segment) ||
    RESERVED_SEGMENTS.has(segment)
  ) {
    throw new ProvisioningError(
      "invalid_path",
      400,
      `${label} must be one directory name and must not be reserved`,
    );
  }
  return segment;
}

function isReservedPath(workspaceReal: string, target: string): boolean {
  const master = masterAppDir(workspaceReal);
  return target === master || isInside(master, target);
}

function assertNoReservedSegments(workspaceReal: string, target: string): void {
  const segments = path.relative(workspaceReal, target).split(path.sep);
  if (segments.some((segment) => RESERVED_SEGMENTS.has(segment))) {
    throw new ProvisioningError(
      "reserved_path",
      400,
      "application paths must not contain .git, .hanse, or .hanse-master segments",
    );
  }
}

/** Create every directory from `base` down to `relative`, refusing symlinked segments. */
function ensureDirectoryPath(base: string, relative: string): void {
  let current = base;
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProvisioningError("io_error", 500, `cannot inspect ${current}`, { cause: error });
      }
      try {
        mkdirSync(current, { mode: 0o755 });
      } catch (mkdirError) {
        throw new ProvisioningError("io_error", 500, `cannot create ${current}`, {
          cause: mkdirError,
        });
      }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProvisioningError("invalid_path", 400, `${current} is not a real directory`);
    }
    let resolved: string;
    try {
      resolved = realpathSync(current);
    } catch (error) {
      throw new ProvisioningError("io_error", 500, `cannot resolve ${current}`, { cause: error });
    }
    if (resolved !== current) {
      throw new ProvisioningError("invalid_path", 400, `${current} is not canonical`);
    }
  }
}

function ensureDirectory(target: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProvisioningError("io_error", 500, `cannot inspect ${target}`, { cause: error });
    }
    try {
      mkdirSync(target, { mode: 0o755 });
    } catch (mkdirError) {
      throw new ProvisioningError("io_error", 500, `cannot create ${target}`, {
        cause: mkdirError,
      });
    }
    stat = lstatSync(target);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ProvisioningError("invalid_path", 400, `${target} must be a real directory`);
  }
}

function validateRemote(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    throw new ProvisioningError("invalid_argument", 400, "remote must be a string");
  }
  const remote = value.trim();
  if (remote.length === 0) {
    return "";
  }
  if (remote.startsWith("-") || hasControlCharacters(remote) || /\s/.test(remote)) {
    throw new ProvisioningError("invalid_argument", 400, "remote is not a valid git URL");
  }
  if (/^[a-z]+:\/\/[^/]*@/i.test(remote)) {
    throw new ProvisioningError("invalid_argument", 400, "remote must not embed credentials");
  }
  if (!REMOTE_SCHEME.test(remote) && !REMOTE_SCP.test(remote)) {
    throw new ProvisioningError(
      "invalid_argument",
      400,
      "remote must be http(s), ssh, git, or user@host:path",
    );
  }
  return remote;
}

function readManifest(projectRoot: string): Record<string, unknown> {
  const manifestPath = path.join(projectRoot, ".hanse", "project.yaml");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProvisioningError(
        "project_manifest_missing",
        500,
        `project manifest is missing: ${manifestPath}`,
      );
    }
    throw new ProvisioningError("io_error", 500, `cannot read ${manifestPath}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ProvisioningError("invalid_manifest", 500, "project manifest is not valid YAML", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProvisioningError("invalid_manifest", 500, "project manifest must be a mapping");
  }
  return parsed as Record<string, unknown>;
}

function writeManifest(projectRoot: string, manifest: Record<string, unknown>): void {
  const hanseDir = path.join(projectRoot, ".hanse");
  try {
    ensureDirectory(hanseDir);
    writeRegularFileNoFollow(hanseDir, "project.yaml", stringifyYaml(manifest), 0o644);
  } catch (error) {
    if (error instanceof ProvisioningError) {
      throw error;
    }
    throw new ProvisioningError("io_error", 500, "cannot write the project manifest", {
      cause: error,
    });
  }
}

/** Create a project directory, manifest, and database row. */
export function createProject(
  deps: ProvisioningDeps,
  input: CreateProjectInput,
): CreateProjectResult {
  const name = requireName(input.name);
  let workspaceReal: string;
  try {
    workspaceReal = realpathSync(deps.workspaceRoot);
  } catch (error) {
    throw new ProvisioningError("io_error", 500, "workspace root is not readable", {
      cause: error,
    });
  }
  const slug = slugFor(name, `project-${Date.now()}`);
  const directory = requireSingleSegment(
    requireSingleSegment(input.directory, "directory") || slug,
    "directory",
  );
  const rootPath = path.join(workspaceReal, directory);
  if (isReservedPath(workspaceReal, rootPath)) {
    throw new ProvisioningError("reserved_path", 400, "that directory is reserved");
  }
  if (deps.deletion?.isActive() === true || deps.deletion?.isDeletingPath(rootPath) === true) {
    throw new ProvisioningError(
      "deletion_in_progress",
      409,
      "a deletion is in progress for this location",
    );
  }
  let existing: Stats | undefined;
  try {
    existing = lstatSync(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProvisioningError("io_error", 500, `cannot inspect ${rootPath}`, { cause: error });
    }
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new ProvisioningError("invalid_path", 400, `${rootPath} is not a real directory`);
    }
    try {
      lstatSync(path.join(rootPath, ".hanse", "project.yaml"));
      throw new ProvisioningError("project_exists", 409, "project already exists");
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProvisioningError("io_error", 500, "cannot inspect the project manifest", {
          cause: error,
        });
      }
    }
  }
  ensureDirectory(rootPath);
  const id = randomUUID();
  writeManifest(rootPath, { id, name, base_branch: "main", apps: [] });
  const now = new Date().toISOString();
  try {
    deps.db
      .prepare(
        "INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at) VALUES (?, ?, 'main', ?, ?, ?)",
      )
      .run(id, name, rootPath, now, now);
  } catch (error) {
    throw new ProvisioningError("io_error", 500, "cannot write the project row", { cause: error });
  }
  return { id, name, rootPath, directory };
}

/** Create or clone an application directory, write its manifest, and register the row. */
export function addApplication(
  deps: ProvisioningDeps,
  input: AddApplicationInput,
): AddApplicationResult {
  const projectId = typeof input.projectId === "string" ? input.projectId : "";
  const project = deps.db
    .prepare("SELECT id, name, root_path AS rootPath, deleting FROM projects WHERE id = ?")
    .get(projectId) as { id: string; name: string; rootPath: string; deleting: number } | undefined;
  if (project === undefined) {
    throw new ProvisioningError("project_not_found", 404, "project not found");
  }
  if (isMasterProject(project.id)) {
    throw new ProvisioningError(
      "reserved_path",
      400,
      "the master project cannot gain applications",
    );
  }
  if (project.deleting === 1) {
    throw new ProvisioningError(
      "deletion_incomplete",
      409,
      "this project is being deleted; finish the deletion first",
    );
  }
  const name = requireName(input.name);
  let workspaceReal: string;
  try {
    workspaceReal = realpathSync(deps.workspaceRoot);
  } catch (error) {
    throw new ProvisioningError("io_error", 500, "workspace root is not readable", {
      cause: error,
    });
  }
  let projectRoot: string;
  try {
    projectRoot = realpathSync(project.rootPath);
  } catch (error) {
    throw new ProvisioningError("io_error", 500, "project root is not readable", { cause: error });
  }
  const requestedPath = input.path?.trim() ?? "";
  const appPath =
    requestedPath.length > 0 ? requestedPath : `apps/${slugFor(name, `app-${Date.now()}`)}`;
  let resolved: string;
  try {
    resolved = resolveAppPath({
      appPath,
      projectRoot,
      workspaceRoot: workspaceReal,
    });
  } catch (error) {
    throw new ProvisioningError(
      "invalid_path",
      error instanceof ConfigError ? 400 : 500,
      error instanceof Error ? error.message : String(error),
      { configCode: error instanceof ConfigError ? error.code : undefined },
    );
  }
  if (resolved === projectRoot || resolved === workspaceReal) {
    throw new ProvisioningError(
      "invalid_path",
      400,
      "application path must be a dedicated directory",
    );
  }
  if (isReservedPath(workspaceReal, resolved)) {
    throw new ProvisioningError("reserved_path", 400, "that directory is reserved");
  }
  assertNoReservedSegments(workspaceReal, resolved);
  const appKey = path.basename(resolved);
  if (!isValidAppId(appKey)) {
    throw new ProvisioningError(
      "invalid_path",
      400,
      `application key is not valid: ${JSON.stringify(appKey)}`,
    );
  }
  const appId = `${project.id}:${appKey}`;
  const existingRow = deps.db
    .prepare("SELECT deleting FROM apps WHERE project_id = ? AND app_key = ?")
    .get(project.id, appKey) as { deleting: number } | undefined;
  if (existingRow !== undefined) {
    throw new ProvisioningError(
      existingRow.deleting === 1 ? "deletion_incomplete" : "app_exists",
      existingRow.deleting === 1 ? 409 : 409,
      existingRow.deleting === 1
        ? "this application is being deleted; finish the deletion first"
        : "application already exists",
    );
  }
  if (
    deps.deletion?.isDeletingProject(project.id) === true ||
    deps.deletion?.isDeletingApp(appId) === true ||
    deps.deletion?.isDeletingAppState(project.id, appKey) === true ||
    deps.deletion?.isDeletingPath(resolved) === true
  ) {
    throw new ProvisioningError(
      "deletion_in_progress",
      409,
      "a deletion is in progress for this application",
    );
  }

  const manifest = readManifest(projectRoot);
  const apps = Array.isArray(manifest.apps) ? (manifest.apps as unknown[]) : [];
  const duplicate = apps.some((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return false;
    }
    const candidate = entry as { path?: unknown };
    if (typeof candidate.path !== "string") {
      return false;
    }
    return (
      candidate.path === appPath || path.basename(candidate.path.replace(/[\\/]+$/, "")) === appKey
    );
  });
  if (duplicate) {
    throw new ProvisioningError("app_exists", 409, "application already exists in the manifest");
  }

  const remote = validateRemote(input.remote);
  let stat: Stats | undefined;
  try {
    stat = lstatSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProvisioningError("io_error", 500, `cannot inspect ${resolved}`, { cause: error });
    }
  }
  if (remote.length > 0) {
    if (stat !== undefined) {
      throw new ProvisioningError("app_exists", 409, "application directory already exists");
    }
    const parent = path.dirname(resolved);
    ensureDirectoryPath(workspaceReal, path.relative(workspaceReal, parent));
    const temp = path.join(parent, `.hanse-clone-${randomUUID()}`);
    try {
      (deps.clone ?? defaultClone)(remote, temp);
      if (lstatSync(resolved, { throwIfNoEntry: false }) !== undefined) {
        throw new ProvisioningError("app_exists", 409, "application directory already exists");
      }
      renameSync(temp, resolved);
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error instanceof ProvisioningError
        ? error
        : new ProvisioningError("clone_failed", 502, "failed to clone the application", {
            cause: error,
          });
    }
  } else {
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ProvisioningError("invalid_path", 400, `${resolved} is not a real directory`);
      }
    } else {
      const parent = path.dirname(resolved);
      ensureDirectoryPath(workspaceReal, path.relative(workspaceReal, parent));
      ensureDirectory(resolved);
    }
  }

  const hanseDir = path.join(resolved, ".hanse");
  ensureDirectory(hanseDir);
  const appYaml = path.join(hanseDir, "app.yaml");
  if (lstatSync(appYaml, { throwIfNoEntry: false }) === undefined) {
    writeRegularFileNoFollow(
      hanseDir,
      "app.yaml",
      stringifyYaml({ name, kind: "app", contract: "AGENTS.md" }),
      0o644,
    );
  }

  apps.push({ path: appPath, ...(remote.length > 0 ? { remote } : {}) });
  manifest.apps = apps;
  writeManifest(projectRoot, manifest);

  try {
    deps.db
      .prepare(
        "INSERT INTO apps (id, project_id, app_key, path, kind, contract, created_at) VALUES (?, ?, ?, ?, 'app', 'AGENTS.md', ?)",
      )
      .run(appId, project.id, appKey, appPath, new Date().toISOString());
  } catch (error) {
    throw new ProvisioningError("io_error", 500, "cannot write the application row", {
      cause: error,
    });
  }
  return { id: appId, projectId: project.id, appKey, path: appPath, rootPath: projectRoot };
}

function defaultClone(remote: string, target: string): void {
  execFileSync("git", ["clone", "--depth", "1", "--", remote, target], { stdio: "ignore" });
}
