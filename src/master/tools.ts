import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { DeletionService } from "../coordinator/deletion.js";
import { DeploymentInProgressError } from "../coordinator/deployment-lock.js";
import {
  addApplication,
  createProject,
  type ProvisioningDeletionGuard,
  ProvisioningError,
} from "../coordinator/provision.js";
import type { InstanceManager, ManagedApp } from "../opencode/manager.js";
import { DeletionPendingError, RestartInProgressError } from "../opencode/manager.js";
import { resolveAppPath } from "../runtime/app-path.js";
import type { SettingsService } from "../settings/index.js";
import { findKeyDefinition } from "../settings/registry.js";
import { SettingsValidationError } from "../settings/service.js";
import type {
  EffectiveSettings,
  EffectiveValue,
  SettingsScope,
  SettingsTarget,
} from "../settings/types.js";
import {
  SkillConflictError,
  type SkillInput,
  type SkillReference,
  type SkillRow,
  type SkillScope,
  type SkillService,
  type SkillTarget,
  SkillValidationError,
} from "../skills/index.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  isMasterApp,
  isMasterProject,
  MASTER_APP_ID,
  MASTER_APP_KEY,
  MASTER_PROJECT_ID,
} from "./constants.js";
import {
  listWorkspaceDir,
  readWorkspaceFile,
  WorkspaceFileError,
  writeWorkspaceFile,
} from "./workspace-files.js";

/** Stable tool failure returned to the model as text content. */
export class MasterToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MasterToolError";
    this.code = code;
  }
}

export interface MasterToolContext {
  db: SqliteDatabase;
  workspaceRoot: string;
  settings?: SettingsService;
  manager?: InstanceManager;
  deletion?: DeletionService;
  skills?: SkillService;
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
  kind: string | null;
  deleting: number;
  image_status: string;
  image_ref: string | null;
}

export const MASTER_TOOLS = [
  {
    name: "list_projects",
    description:
      "List every project and application with its root path, runtime state, and pending restart.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_app",
    description:
      "Read one application: path, kind, runtime, pending restart, image status, effective settings, and manifest summary.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, app_key: { type: "string" } },
      required: ["project_id", "app_key"],
    },
  },
  {
    name: "get_settings",
    description:
      "Read effective settings and their source scopes for global, project, or application scope. Never returns secret values.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, app_key: { type: "string" } },
    },
  },
  {
    name: "set_setting",
    description:
      "Write one non-secret setting. scope defaults to app when app_key is given, project when project_id is given, otherwise global.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        value: {},
        scope: { type: "string", enum: ["global", "project", "app"] },
        project_id: { type: "string" },
        app_key: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "inherit_setting",
    description: "Remove a scoped setting so the wider scope applies again.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        scope: { type: "string", enum: ["global", "project", "app"] },
        project_id: { type: "string" },
        app_key: { type: "string" },
      },
      required: ["key", "scope"],
    },
  },
  {
    name: "create_skill",
    description:
      "Create an enabled agent skill bundle at global, project, or application scope. Global scope requires confirm_global after operator approval. A same-name skill at the same scope is rejected; a narrower same-name skill shadows a wider one. Creating a skill never restarts agents.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["global", "project", "app"] },
        confirm_global: {
          type: "boolean",
          description: "Required true for global scope after the operator approves it.",
        },
        project_id: { type: "string" },
        app_key: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        content: { type: "string" },
        license: { type: ["string", "null"] },
        compatibility: { type: ["string", "null"] },
        metadata: { type: "object", additionalProperties: { type: "string" } },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["scope", "name", "description", "content"],
    },
  },
  {
    name: "start_app",
    description: "Start a stopped application agent. Starting a running agent reconnects.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, app_key: { type: "string" } },
      required: ["project_id", "app_key"],
    },
  },
  {
    name: "restart_app",
    description: "Restart a running application agent. A stopped agent is not started.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string" }, app_key: { type: "string" } },
      required: ["project_id", "app_key"],
    },
  },
  {
    name: "create_project",
    description: "Create a project directory, manifest, and registry row.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, directory: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "add_app",
    description:
      "Create an application directory or clone a git remote, write its manifest, update the project manifest, and register it.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        name: { type: "string" },
        path: { type: "string" },
        remote: { type: "string" },
      },
      required: ["project_id", "name"],
    },
  },
  {
    name: "list_dir",
    description: "List one workspace directory without following entries.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "read_file",
    description: "Read a workspace text file (256 KiB limit, UTF-8 only).",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description:
      "Write a workspace text file atomically (256 KiB limit). Refuses .git, Hanse manifests, and the master instructions.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
] as const;

const MASTER_TOOL_NAMES = new Set<string>(MASTER_TOOLS.map((tool) => tool.name));

export function isMasterToolName(name: string): boolean {
  return MASTER_TOOL_NAMES.has(name);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MasterToolError("invalid_argument", `"${field}" must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return asString(value, field);
}

function projectRow(db: SqliteDatabase, projectId: string): ProjectRow | undefined {
  return db
    .prepare("SELECT id, name, root_path, deleting FROM projects WHERE id = ?")
    .get(projectId) as ProjectRow | undefined;
}

function appRow(db: SqliteDatabase, projectId: string, appKey: string): AppRow | undefined {
  return db
    .prepare(
      `SELECT id, project_id, app_key, path, kind, deleting, image_status, image_ref
       FROM apps WHERE project_id = ? AND app_key = ?`,
    )
    .get(projectId, appKey) as AppRow | undefined;
}

function runtimeState(db: SqliteDatabase, appId: string): string {
  const row = db
    .prepare("SELECT COALESCE(runtime_state, state) AS state FROM instances WHERE app_id = ?")
    .get(appId) as { state: string } | undefined;
  const state = row?.state ?? "stopped";
  return state === "failed" ? "error" : state;
}

function managedApp(workspaceRoot: string, project: ProjectRow, app: AppRow): ManagedApp {
  const appDir = resolveAppPath({
    appPath: app.path,
    projectRoot: project.root_path,
    workspaceRoot,
  });
  const master = app.id === MASTER_APP_ID;
  return {
    id: app.id,
    projectId: app.project_id,
    appKey: app.app_key,
    appDir,
    imageStatus: app.image_status as ManagedApp["imageStatus"],
    imageRef: app.image_ref,
    ...(master
      ? {
          instructions: [path.join(appDir, "AGENTS.md")],
          gitCredentials: false,
          appDirReadOnly: true,
        }
      : {}),
  };
}

function pendingRestart(
  manager: InstanceManager | undefined,
  appId: string,
): { pending: boolean; reasons: string[] } {
  return manager?.pendingRestart(appId) ?? { pending: false, reasons: [] };
}

function recordEvent(db: SqliteDatabase, type: string, payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  const body =
    Buffer.byteLength(serialized, "utf8") > 8 * 1024
      ? JSON.stringify({ truncated: true, keys: Object.keys(payload) })
      : serialized;
  db.prepare(
    "INSERT INTO events (scope, type, payload, created_at) VALUES ('master', ?, ?, ?)",
  ).run(type, body, new Date().toISOString());
}

function targetFor(args: Record<string, unknown>, scope: SettingsScope): SettingsTarget {
  const projectId = asOptionalString(args.project_id, "project_id");
  const appKey = asOptionalString(args.app_key, "app_key");
  if (scope === "global") {
    if (projectId !== undefined || appKey !== undefined) {
      throw new MasterToolError(
        "invalid_argument",
        "global scope does not accept project_id/app_key",
      );
    }
    return {};
  }
  if (projectId === undefined) {
    throw new MasterToolError("invalid_argument", `${scope} scope requires project_id`);
  }
  if (scope === "project") {
    if (appKey !== undefined) {
      throw new MasterToolError("invalid_argument", "project scope does not accept app_key");
    }
    return { projectId };
  }
  if (appKey === undefined) {
    throw new MasterToolError("invalid_argument", "app scope requires app_key");
  }
  return { projectId, appKey };
}

function requireTargetExists(
  db: SqliteDatabase,
  scope: SettingsScope,
  target: SettingsTarget,
): void {
  if (scope === "global") {
    return;
  }
  const project = projectRow(db, target.projectId ?? "");
  if (project === undefined) {
    throw new MasterToolError("unknown_project", "project not found");
  }
  if (scope === "project") {
    return;
  }
  const app = appRow(db, project.id, target.appKey ?? "");
  if (app === undefined) {
    throw new MasterToolError("unknown_app", "application not found");
  }
}

function effectiveValue(effective: EffectiveSettings, key: string): EffectiveValue<unknown> {
  const groups: Record<string, EffectiveValue<unknown>> = {
    "llm.model": effective.llm.model,
    "web.search": effective.web.search,
    "web.fetch": effective.web.fetch,
    "context.auto_compact.enabled": effective.context.autoCompact.enabled,
    "context.auto_compact.percent": effective.context.autoCompact.percent,
    "git.user.name": effective.git.user.name,
    "git.user.email": effective.git.user.email,
  };
  const value = groups[key];
  if (value === undefined) {
    throw new MasterToolError("invalid_argument", `unknown settings key: ${key}`);
  }
  return value;
}

function requireSettings(context: MasterToolContext): SettingsService {
  if (context.settings === undefined) {
    throw new MasterToolError("unavailable", "settings are not configured");
  }
  return context.settings;
}

function requireManager(context: MasterToolContext): InstanceManager {
  if (context.manager === undefined) {
    throw new MasterToolError("unavailable", "the agent runtime is not configured");
  }
  return context.manager;
}

function requireSkills(context: MasterToolContext): SkillService {
  if (context.skills === undefined) {
    throw new MasterToolError("unavailable", "skills are not configured");
  }
  return context.skills;
}

function asSkillScope(value: unknown): SkillScope {
  if (value === "global" || value === "project" || value === "app") {
    return value;
  }
  throw new MasterToolError("invalid_argument", 'scope must be "global", "project", or "app"');
}

function asOptionalStringOrNull(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new MasterToolError("invalid_argument", `"${field}" must be a string or null`);
}

function asOptionalMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MasterToolError("invalid_argument", '"metadata" must be a plain object');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new MasterToolError("invalid_argument", `metadata value for ${key} must be a string`);
    }
  }
  return value as Record<string, string>;
}

function asOptionalReferences(value: unknown): SkillReference[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new MasterToolError("invalid_argument", '"references" must be an array');
  }
  const references: SkillReference[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new MasterToolError(
        "invalid_argument",
        `references[${index}] must be an object with path and content`,
      );
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string") {
      throw new MasterToolError(
        "invalid_argument",
        `references[${index}] must have string path and content`,
      );
    }
    references.push({ path: record.path, content: record.content });
  }
  return references;
}

function skillInputFromArgs(args: Record<string, unknown>): SkillInput {
  if (args.enabled !== undefined) {
    throw new MasterToolError(
      "invalid_argument",
      "enabled is not settable; create_skill always creates an enabled skill",
    );
  }
  const name = asString(args.name, "name");
  const description = asString(args.description, "description");
  const content = asString(args.content, "content");
  const license = asOptionalStringOrNull(args.license, "license");
  const compatibility = asOptionalStringOrNull(args.compatibility, "compatibility");
  const metadata = asOptionalMetadata(args.metadata);
  const references = asOptionalReferences(args.references);
  return {
    name,
    description,
    content,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(references === undefined ? {} : { references }),
  };
}

/** Validate a skill target before and inside the creation transaction. */
function assertSkillTarget(db: SqliteDatabase, scope: SkillScope, target: SkillTarget): void {
  if (scope === "global") {
    return;
  }
  const project = projectRow(db, target.projectId ?? "");
  if (project === undefined) {
    throw new MasterToolError("unknown_project", "project not found");
  }
  if (isMasterProject(project.id)) {
    throw new MasterToolError("master_protected", "the master project cannot own agent skills");
  }
  if (scope === "app" && isMasterApp(project.id, target.appKey ?? "")) {
    throw new MasterToolError("master_protected", "the master application cannot own agent skills");
  }
  if (project.deleting === 1) {
    throw new MasterToolError("deletion_pending", "the project is pending deletion");
  }
  if (scope !== "app") {
    return;
  }
  const app = appRow(db, project.id, target.appKey ?? "");
  if (app === undefined) {
    throw new MasterToolError("unknown_app", "application not found");
  }
  if (app.deleting === 1) {
    throw new MasterToolError("deletion_pending", "the application is pending deletion");
  }
}

function skillSummary(row: SkillRow): Record<string, unknown> {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId,
    appKey: row.appKey,
    name: row.name,
    description: row.description,
    license: row.license,
    compatibility: row.compatibility,
    metadata: row.metadata,
    enabled: row.enabled,
    references: row.references.map((reference) => ({
      path: reference.path,
      size: Buffer.byteLength(reference.content, "utf8"),
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

function shadowedByScopes(
  db: SqliteDatabase,
  scope: SkillScope,
  target: SkillTarget,
  name: string,
): SkillScope[] {
  if (scope === "app") {
    return [];
  }
  const scopes: SkillScope[] = [];
  if (scope === "global") {
    const project = db
      .prepare(
        `SELECT 1 FROM skills s
         JOIN projects p ON p.id = s.project_id
         WHERE s.scope = 'project' AND s.name = ? AND p.deleting = 0
         LIMIT 1`,
      )
      .get(name);
    if (project !== undefined) {
      scopes.push("project");
    }
    const app = db
      .prepare(
        `SELECT 1 FROM skills s
         JOIN apps a ON a.project_id = s.project_id AND a.app_key = s.app_key
         JOIN projects p ON p.id = a.project_id
         WHERE s.scope = 'app' AND s.name = ? AND a.deleting = 0 AND p.deleting = 0
         LIMIT 1`,
      )
      .get(name);
    if (app !== undefined) {
      scopes.push("app");
    }
    return scopes;
  }
  const app = db
    .prepare(
      `SELECT 1 FROM skills s
       JOIN apps a ON a.project_id = s.project_id AND a.app_key = s.app_key
       JOIN projects p ON p.id = a.project_id
       WHERE s.scope = 'app' AND s.name = ? AND s.project_id = ?
         AND a.deleting = 0 AND p.deleting = 0
       LIMIT 1`,
    )
    .get(name, target.projectId ?? "");
  if (app !== undefined) {
    scopes.push("app");
  }
  return scopes;
}

function appsInScope(
  db: SqliteDatabase,
  scope: SkillScope,
  target: SkillTarget,
): { total: number; running: number } {
  const clauses = ["a.deleting = 0", "p.deleting = 0"];
  const params: string[] = [];
  if (scope !== "global") {
    clauses.push("p.id = ?");
    params.push(target.projectId ?? "");
  }
  if (scope === "app") {
    clauses.push("a.app_key = ?");
    params.push(target.appKey ?? "");
  }
  const rows = db
    .prepare(
      `SELECT a.id FROM apps a
       JOIN projects p ON p.id = a.project_id
       WHERE ${clauses.join(" AND ")}`,
    )
    .all(...params) as Array<{ id: string }>;
  let running = 0;
  for (const row of rows) {
    const state = runtimeState(db, row.id);
    if (state === "running" || state === "starting") {
      running += 1;
    }
  }
  return { total: rows.length, running };
}

function skillConflictError(
  skills: SkillService,
  scope: SkillScope,
  target: SkillTarget,
  name: string,
): MasterToolError {
  let existing: ReturnType<SkillService["resolve"]>["rows"][number] | undefined;
  try {
    existing = skills.resolve(target).rows.find((row) => row.scope === scope && row.name === name);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    return new MasterToolError(
      "skill_exists",
      `a skill named "${name}" already exists at ${scope} scope (id ${existing.id}, updated by ${existing.updatedBy ?? "unknown"} at ${existing.updatedAt}); choose a different name or ask the operator to edit it`,
    );
  }
  return new MasterToolError(
    "skill_exists",
    `a skill named "${name}" already exists at ${scope} scope; choose a different name or ask the operator to edit it`,
  );
}

function lookupApp(
  context: MasterToolContext,
  projectId: string,
  appKey: string,
): { project: ProjectRow; app: AppRow } {
  const project = projectRow(context.db, projectId);
  if (project === undefined) {
    throw new MasterToolError("unknown_project", "project not found");
  }
  const app = appRow(context.db, project.id, appKey);
  if (app === undefined) {
    throw new MasterToolError("unknown_app", "application not found");
  }
  return { project, app };
}

function assertNotMaster(projectId: string, appKey: string): void {
  if (isMasterApp(projectId, appKey)) {
    throw new MasterToolError(
      "self_restart_unsupported",
      "the master cannot start or restart itself; use its application page",
    );
  }
}

function assertNotDeleting(project: ProjectRow, app: AppRow): void {
  if (project.deleting === 1 || app.deleting === 1) {
    throw new MasterToolError("deletion_pending", "the application is pending deletion");
  }
}

function manifestSummary(
  projectRoot: string,
  appDir: string,
): { project?: Record<string, unknown>; app?: Record<string, unknown> } {
  const result: { project?: Record<string, unknown>; app?: Record<string, unknown> } = {};
  for (const [file, key] of [
    [path.join(projectRoot, ".hanse", "project.yaml"), "project"],
    [path.join(appDir, ".hanse", "app.yaml"), "app"],
  ] as const) {
    try {
      const parsed = parseYaml(readFileSync(file, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        result[key] =
          key === "project"
            ? { name: record.name, base_branch: record.base_branch }
            : { name: record.name, kind: record.kind, contract: record.contract };
      }
    } catch {
      // A missing or invalid manifest is reported by registration; the tool stays read-only.
    }
  }
  return result;
}

function lifecycleError(error: unknown): MasterToolError {
  if (error instanceof MasterToolError) {
    return error;
  }
  if (error instanceof DeletionPendingError) {
    return new MasterToolError("deletion_pending", error.message);
  }
  if (error instanceof RestartInProgressError) {
    return new MasterToolError("restart_in_progress", error.message);
  }
  if (error instanceof DeploymentInProgressError) {
    return new MasterToolError("deployment_in_progress", error.message);
  }
  if (error instanceof ProvisioningError) {
    return new MasterToolError(error.code, error.message);
  }
  if (error instanceof SettingsValidationError) {
    return new MasterToolError("invalid_argument", error.message);
  }
  if (error instanceof SkillValidationError) {
    return new MasterToolError(
      "invalid_skill",
      error.field === undefined ? error.message : `${error.field}: ${error.message}`,
    );
  }
  if (error instanceof SkillConflictError) {
    return new MasterToolError("skill_exists", error.message);
  }
  if (error instanceof WorkspaceFileError) {
    return new MasterToolError(error.code, error.message);
  }
  return new MasterToolError(
    "internal_error",
    error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  );
}

/**
 * Execute one master tool. The caller must have verified that the presented token belongs to the
 * master application; this function repeats the identity check as defense in depth.
 */
export async function callMasterTool(
  context: MasterToolContext,
  agent: { appId: string; appKey: string },
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (agent.appId !== MASTER_APP_ID || agent.appKey !== MASTER_APP_KEY) {
    throw new MasterToolError("forbidden", "only the master agent may call these tools");
  }
  if (!isMasterToolName(name)) {
    throw new MasterToolError("unknown_tool", `unknown tool: ${name}`);
  }
  try {
    switch (name) {
      case "list_projects": {
        const projects = context.db
          .prepare("SELECT id, name, root_path, deleting FROM projects ORDER BY name")
          .all() as ProjectRow[];
        const apps = context.db
          .prepare(
            "SELECT id, project_id, app_key, path, kind, deleting, image_status, image_ref FROM apps ORDER BY app_key",
          )
          .all() as AppRow[];
        return {
          ok: true,
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            rootPath: project.root_path,
            builtin: project.id === MASTER_PROJECT_ID,
            deleting: project.deleting === 1,
            apps: apps
              .filter((app) => app.project_id === project.id)
              .map((app) => ({
                projectId: app.project_id,
                appKey: app.app_key,
                path: app.path,
                kind: app.kind,
                builtin: app.id === MASTER_APP_ID,
                runtime: runtimeState(context.db, app.id),
                pendingRestart: pendingRestart(context.manager, app.id),
              })),
          })),
        };
      }
      case "get_app": {
        const projectId = asString(args.project_id, "project_id");
        const appKey = asString(args.app_key, "app_key");
        const found = lookupApp(context, projectId, appKey);
        const appDir = resolveAppPath({
          appPath: found.app.path,
          projectRoot: found.project.root_path,
          workspaceRoot: context.workspaceRoot,
        });
        const settings =
          context.settings === undefined
            ? undefined
            : context.settings.resolve({ projectId: found.project.id, appKey: found.app.app_key });
        return {
          ok: true,
          project: {
            id: found.project.id,
            name: found.project.name,
            rootPath: found.project.root_path,
          },
          app: {
            id: found.app.id,
            projectId: found.project.id,
            appKey: found.app.app_key,
            path: appDir,
            kind: found.app.kind,
            runtime: runtimeState(context.db, found.app.id),
            pendingRestart: pendingRestart(context.manager, found.app.id),
            imageStatus: found.app.image_status,
            imageRef: found.app.image_ref,
            deleting: found.app.deleting === 1,
          },
          manifest: manifestSummary(found.project.root_path, appDir),
          ...(settings === undefined ? {} : { settings }),
        };
      }
      case "get_settings": {
        const projectId = asOptionalString(args.project_id, "project_id");
        const appKey = asOptionalString(args.app_key, "app_key");
        const scope: SettingsScope =
          appKey !== undefined ? "app" : projectId !== undefined ? "project" : "global";
        const target = targetFor(args, scope);
        requireTargetExists(context.db, scope, target);
        const settings = requireSettings(context);
        return { ok: true, scope, target, settings: settings.resolve(target) };
      }
      case "set_setting": {
        const key = asString(args.key, "key");
        if (findKeyDefinition(key) === undefined) {
          throw new MasterToolError("invalid_argument", `unknown settings key: ${key}`);
        }
        const scope = (typeof args.scope === "string" ? args.scope : undefined) as
          | SettingsScope
          | undefined;
        const inferred: SettingsScope =
          scope ??
          (typeof args.app_key === "string" && args.app_key.length > 0
            ? "app"
            : typeof args.project_id === "string" && args.project_id.length > 0
              ? "project"
              : "global");
        const target = targetFor(args, inferred);
        requireTargetExists(context.db, inferred, target);
        const settings = requireSettings(context);
        const cleared = args.value === null;
        if (cleared) {
          settings.clear(inferred, target, key, "master");
        } else {
          settings.set(inferred, target, key, args.value, "master");
        }
        const resolved = settings.resolve(target);
        const appId = inferred === "app" ? `${target.projectId}:${target.appKey}` : undefined;
        recordEvent(context.db, cleared ? "master.setting_cleared" : "master.setting_changed", {
          key,
          scope: inferred,
          projectId: target.projectId ?? "",
          appKey: target.appKey ?? "",
          ...(cleared ? {} : { value: args.value }),
        });
        return {
          ok: true,
          scope: inferred,
          key,
          cleared,
          effective: effectiveValue(resolved.effective, key),
          warnings: resolved.warnings,
          ...(appId === undefined
            ? {}
            : { pendingRestart: pendingRestart(context.manager, appId) }),
        };
      }
      case "inherit_setting": {
        const key = asString(args.key, "key");
        const scope = asString(args.scope, "scope") as SettingsScope;
        if (scope !== "global" && scope !== "project" && scope !== "app") {
          throw new MasterToolError("invalid_argument", "scope must be global, project, or app");
        }
        if (findKeyDefinition(key) === undefined) {
          throw new MasterToolError("invalid_argument", `unknown settings key: ${key}`);
        }
        const target = targetFor(args, scope);
        requireTargetExists(context.db, scope, target);
        const settings = requireSettings(context);
        settings.inherit(scope, target, key);
        const resolved = settings.resolve(target);
        const appId = scope === "app" ? `${target.projectId}:${target.appKey}` : undefined;
        recordEvent(context.db, "master.setting_inherited", {
          key,
          scope,
          projectId: target.projectId ?? "",
          appKey: target.appKey ?? "",
        });
        return {
          ok: true,
          scope,
          key,
          effective: effectiveValue(resolved.effective, key),
          warnings: resolved.warnings,
          ...(appId === undefined
            ? {}
            : { pendingRestart: pendingRestart(context.manager, appId) }),
        };
      }
      case "create_skill": {
        const scope = asSkillScope(args.scope);
        if (scope === "global") {
          if (args.confirm_global === undefined || args.confirm_global === false) {
            throw new MasterToolError(
              "confirmation_required",
              "global skills affect every application, including the master; ask the operator and pass confirm_global: true after approval",
            );
          }
          if (args.confirm_global !== true) {
            throw new MasterToolError("invalid_argument", '"confirm_global" must be a boolean');
          }
        } else if (args.confirm_global !== undefined) {
          throw new MasterToolError(
            "invalid_argument",
            "confirm_global is only valid for global scope",
          );
        }
        const target: SkillTarget = targetFor(args, scope);
        assertSkillTarget(context.db, scope, target);
        const input = skillInputFromArgs(args);
        const skills = requireSkills(context);
        const name = input.name ?? "";
        let created: SkillRow;
        try {
          created = context.db.transaction(() => {
            assertSkillTarget(context.db, scope, target);
            const row = skills.create(scope, target, input, "master");
            recordEvent(context.db, "master.skill_created", {
              skillId: row.id,
              scope: row.scope,
              projectId: row.projectId,
              appKey: row.appKey,
              name: row.name,
              referenceCount: row.references.length,
              contentBytes: Buffer.byteLength(row.content, "utf8"),
              referenceBytes: row.references.reduce(
                (total, reference) => total + Buffer.byteLength(reference.content, "utf8"),
                0,
              ),
            });
            return row;
          })();
        } catch (error) {
          if (error instanceof SkillConflictError) {
            throw skillConflictError(skills, scope, target, name);
          }
          throw error;
        }
        const warnings = new Set<string>();
        let shadows: SkillScope[] = [];
        try {
          shadows =
            skills.resolve(target).effective.find((entry) => entry.id === created.id)?.shadows ??
            [];
        } catch {
          warnings.add("post_create_enrichment");
        }
        let shadowedBy: SkillScope[] = [];
        try {
          shadowedBy = shadowedByScopes(context.db, scope, target, created.name);
        } catch {
          warnings.add("post_create_enrichment");
        }
        let scopeApps = { total: 0, running: 0 };
        try {
          scopeApps = appsInScope(context.db, scope, target);
        } catch {
          warnings.add("post_create_enrichment");
        }
        let pending: { pending: boolean; reasons: string[] } | undefined;
        if (scope === "app") {
          try {
            pending = pendingRestart(context.manager, `${target.projectId}:${target.appKey}`);
          } catch {
            pending = { pending: false, reasons: [] };
            warnings.add("post_create_enrichment");
          }
        }
        return {
          ok: true,
          skill: skillSummary(created),
          shadows,
          shadowedBy,
          appsInScope: scopeApps,
          ...(pending === undefined ? {} : { pendingRestart: pending }),
          ...(warnings.size === 0 ? {} : { warnings: [...warnings] }),
        };
      }
      case "start_app": {
        const projectId = asString(args.project_id, "project_id");
        const appKey = asString(args.app_key, "app_key");
        assertNotMaster(projectId, appKey);
        const found = lookupApp(context, projectId, appKey);
        assertNotDeleting(found.project, found.app);
        const manager = requireManager(context);
        await manager.ensure(managedApp(context.workspaceRoot, found.project, found.app));
        recordEvent(context.db, "master.app_started", {
          projectId: found.project.id,
          appKey: found.app.app_key,
        });
        return {
          ok: true,
          state: runtimeState(context.db, found.app.id),
          pendingRestart: pendingRestart(context.manager, found.app.id),
        };
      }
      case "restart_app": {
        const projectId = asString(args.project_id, "project_id");
        const appKey = asString(args.app_key, "app_key");
        assertNotMaster(projectId, appKey);
        const found = lookupApp(context, projectId, appKey);
        assertNotDeleting(found.project, found.app);
        const manager = requireManager(context);
        const restarted = await manager.restartIfRunning(
          managedApp(context.workspaceRoot, found.project, found.app),
        );
        recordEvent(context.db, "master.app_restarted", {
          projectId: found.project.id,
          appKey: found.app.app_key,
          restarted,
        });
        return {
          ok: true,
          restarted,
          started: false,
          state: runtimeState(context.db, found.app.id),
          pendingRestart: pendingRestart(context.manager, found.app.id),
        };
      }
      case "create_project": {
        const project = createProject(provisioningDeps(context), {
          name: asString(args.name, "name"),
          ...(asOptionalString(args.directory, "directory") === undefined
            ? {}
            : { directory: asOptionalString(args.directory, "directory") }),
        });
        recordEvent(context.db, "master.project_created", {
          projectId: project.id,
          name: project.name,
          rootPath: project.rootPath,
        });
        return { ok: true, project };
      }
      case "add_app": {
        const app = addApplication(provisioningDeps(context), {
          projectId: asString(args.project_id, "project_id"),
          name: asString(args.name, "name"),
          ...(asOptionalString(args.path, "path") === undefined
            ? {}
            : { path: asOptionalString(args.path, "path") }),
          ...(asOptionalString(args.remote, "remote") === undefined
            ? {}
            : { remote: asOptionalString(args.remote, "remote") }),
        });
        recordEvent(context.db, "master.app_added", {
          projectId: app.projectId,
          appKey: app.appKey,
          path: app.path,
        });
        return { ok: true, app };
      }
      case "list_dir":
        return { ok: true, ...listWorkspaceDir(context.workspaceRoot, args.path ?? "") };
      case "read_file":
        return { ok: true, ...readWorkspaceFile(context.workspaceRoot, args.path) };
      case "write_file": {
        const written = writeWorkspaceFile(context.workspaceRoot, args.path, args.content);
        recordEvent(context.db, "master.file_written", {
          path: written.path,
          bytes: written.bytes,
          created: written.created,
        });
        return { ok: true, ...written };
      }
      default:
        throw new MasterToolError("unknown_tool", `unknown tool: ${name}`);
    }
  } catch (error) {
    throw lifecycleError(error);
  }
}

function provisioningDeps(context: MasterToolContext): {
  db: SqliteDatabase;
  workspaceRoot: string;
  deletion?: ProvisioningDeletionGuard;
} {
  return {
    db: context.db,
    workspaceRoot: context.workspaceRoot,
    ...(context.deletion === undefined ? {} : { deletion: context.deletion }),
  };
}
