import type { InstanceManager } from "../opencode/manager.js";
import type { SqliteDatabase } from "../store/database.js";
import { runtimeState } from "../store/runtime-state.js";
import type { SkillService } from "./service.js";
import type { EffectiveSkill, SkillRow, SkillScope, SkillSummary, SkillTarget } from "./types.js";

/** Minimum context a skill tool needs; the master and app surfaces extend it. */
export interface SkillToolContext {
  db: SqliteDatabase;
  skills?: SkillService;
  manager?: InstanceManager;
}

export function pendingRestart(
  manager: InstanceManager | undefined,
  appId: string,
): { pending: boolean; reasons: string[] } {
  return manager?.pendingRestart(appId) ?? { pending: false, reasons: [] };
}

export function skillSummary(row: SkillRow): Record<string, unknown> {
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

export function shadowedByScopes(
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

export function appsInScope(
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

export function skillDetail(row: SkillRow): Record<string, unknown> {
  return {
    ...skillSummary(row),
    content: row.content,
    metadataRaw: row.metadataRaw,
    references: row.references.map((reference) => ({
      path: reference.path,
      content: reference.content,
      size: Buffer.byteLength(reference.content, "utf8"),
    })),
    storedIssues: row.storedIssues,
  };
}

export function listEffectiveEntry(
  entry: EffectiveSkill,
  target: SkillTarget,
): Record<string, unknown> {
  return {
    id: entry.id,
    projectId: entry.source === "global" ? "" : (target.projectId ?? ""),
    appKey: entry.source === "app" ? (target.appKey ?? "") : "",
    name: entry.name,
    description: entry.description,
    license: entry.license,
    compatibility: entry.compatibility,
    metadata: entry.metadata,
    enabled: true,
    references: entry.references,
    storedIssues: [],
    source: entry.source,
    shadows: entry.shadows,
    updatedAt: entry.updatedAt,
    updatedBy: entry.updatedBy,
  };
}

export function listRowEntry(row: SkillSummary): Record<string, unknown> {
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
    references: row.references,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    storedIssues: row.storedIssues,
  };
}

interface SkillMutationEnrichment {
  effective?: boolean;
  storedIssues?: SkillRow["storedIssues"];
  shadows: SkillScope[];
  shadowedBy: SkillScope[];
  appsInScope: { total: number; running: number };
  pendingRestart?: { pending: boolean; reasons: string[] };
  warnings?: string[];
}

export function skillMutationEnrichment(
  context: SkillToolContext,
  skills: SkillService,
  row: SkillRow,
  target: SkillTarget,
  includeState: boolean,
): SkillMutationEnrichment {
  const warnings = new Set<string>();
  let effective = false;
  let shadows: SkillScope[] = [];
  try {
    const winner = skills.resolve(target).effective.find((entry) => entry.id === row.id);
    if (winner !== undefined) {
      effective = true;
      shadows = winner.shadows;
    }
  } catch {
    warnings.add("post_create_enrichment");
  }
  let shadowedBy: SkillScope[] = [];
  if (effective) {
    try {
      shadowedBy = shadowedByScopes(context.db, row.scope, target, row.name);
    } catch {
      warnings.add("post_create_enrichment");
    }
  }
  let scopeApps = { total: 0, running: 0 };
  try {
    scopeApps = appsInScope(context.db, row.scope, target);
  } catch {
    warnings.add("post_create_enrichment");
  }
  let pending: { pending: boolean; reasons: string[] } | undefined;
  if (row.scope === "app") {
    try {
      pending = pendingRestart(context.manager, `${row.projectId}:${row.appKey}`);
    } catch {
      pending = { pending: false, reasons: [] };
      warnings.add("post_create_enrichment");
    }
  }
  return {
    ...(includeState ? { effective, storedIssues: row.storedIssues } : {}),
    shadows,
    shadowedBy,
    appsInScope: scopeApps,
    ...(pending === undefined ? {} : { pendingRestart: pending }),
    ...(warnings.size === 0 ? {} : { warnings: [...warnings] }),
  };
}
