import { isMasterProject } from "../master/constants.js";
import { recordEvent } from "../store/events.js";
import type { SqliteDatabase } from "../store/index.js";
import { HANDOFF_THREAD_RATE_WINDOW_MS } from "./thread.js";

export type HandoffGrantMode = "auto" | "approve";
export const DEFAULT_GRANT_DISPATCH_MODE: HandoffGrantMode = "auto";
export const DEFAULT_GRANT_REPLY_MODE: HandoffGrantMode = "auto";

export interface HandoffGrant {
  id: number;
  projectId: string;
  fromAppKey: string;
  targetProjectId: string;
  toAppKey: string;
  dispatchMode: HandoffGrantMode;
  replyMode: HandoffGrantMode;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ResolvedCrossProjectGrant {
  grant: HandoffGrant;
  dispatchMode: HandoffGrantMode;
  replyMode: HandoffGrantMode;
}

export interface RemoteTarget {
  projectId: string;
  projectName: string;
  appKey: string;
  appId: string;
  grantId: number;
  dispatchMode: HandoffGrantMode;
  replyMode: HandoffGrantMode;
}

export type HandoffGrantErrorCode =
  // shared target guards (admission and grant CRUD)
  | "unknown_target_project"
  | "builtin_target_forbidden"
  | "deleting_target_forbidden"
  // admission-only (service cross-project branch)
  | "invalid_target_project"
  | "unknown_application"
  | "cross_project_denied"
  // reserved/defensive-only: an equal project routes to the same-project branch
  | "cross_project_self"
  // grant-CRUD-only (human HTTP surface; distinct set, D7/M5)
  | "invalid_grant"
  | "unknown_source_project"
  | "same_project_grant"
  | "unknown_source_app"
  | "unknown_target_app"
  | "invalid_app_key"
  | "invalid_mode";

export class HandoffGrantError extends Error {
  readonly code: HandoffGrantErrorCode;

  constructor(code: HandoffGrantErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "HandoffGrantError";
    this.code = code;
  }
}

interface HandoffGrantRow {
  id: number;
  project_id: string;
  from_app_key: string;
  target_project_id: string;
  to_app_key: string;
  dispatch_mode: HandoffGrantMode;
  reply_mode: HandoffGrantMode;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface ProjectState {
  id: string;
  deleting: number;
}

const APP_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function rowToGrant(row: HandoffGrantRow): HandoffGrant {
  return {
    id: row.id,
    projectId: row.project_id,
    fromAppKey: row.from_app_key,
    targetProjectId: row.target_project_id,
    toAppKey: row.to_app_key,
    dispatchMode: row.dispatch_mode,
    replyMode: row.reply_mode,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function projectState(db: SqliteDatabase, projectId: string): ProjectState | undefined {
  return db.prepare("SELECT id, deleting FROM projects WHERE id = ?").get(projectId) as
    | ProjectState
    | undefined;
}

function appState(
  db: SqliteDatabase,
  projectId: string,
  appKey: string,
): { deleting: number } | undefined {
  return db
    .prepare("SELECT deleting FROM apps WHERE project_id = ? AND app_key = ?")
    .get(projectId, appKey) as { deleting: number } | undefined;
}

/** A project that may take part in a cross-project grant (exists, not master, not deleting). */
function isEligibleProject(db: SqliteDatabase, projectId: string): boolean {
  if (isMasterProject(projectId)) {
    return false;
  }
  const project = projectState(db, projectId);
  return project !== undefined && project.deleting !== 1;
}

function specificityScore(grant: HandoffGrant, fromAppKey: string, toAppKey: string): number {
  const fromExact = grant.fromAppKey === fromAppKey ? 1 : 0;
  const toExact = grant.toAppKey === toAppKey ? 1 : 0;
  return (fromExact ? 2 : 0) + (toExact ? 2 : 0);
}

function compareGrantCandidates(
  a: HandoffGrant,
  b: HandoffGrant,
  fromAppKey: string,
  toAppKey: string,
): number {
  const aScore = specificityScore(a, fromAppKey, toAppKey);
  const bScore = specificityScore(b, fromAppKey, toAppKey);
  if (bScore !== aScore) return bScore - aScore;
  const aFrom = a.fromAppKey === fromAppKey ? 1 : 0;
  const bFrom = b.fromAppKey === fromAppKey ? 1 : 0;
  if (bFrom !== aFrom) return bFrom - aFrom;
  const aTo = a.toAppKey === toAppKey ? 1 : 0;
  const bTo = b.toAppKey === toAppKey ? 1 : 0;
  if (bTo !== aTo) return bTo - aTo;
  return a.id - b.id;
}

/**
 * Resolve the outbound grant for one directed cross-project pair.
 *
 * Absence of a grant is denial (`undefined`). This resolver matches key text only and never queries
 * `apps`, so callers can check the grant before resolving a target app (no app-existence oracle).
 * Equal, master/builtin, and deleting projects fail closed.
 */
export function resolveCrossProjectGrant(
  db: SqliteDatabase,
  sourceProjectId: string,
  fromAppKey: string,
  targetProjectId: string,
  toAppKey: string,
): ResolvedCrossProjectGrant | undefined {
  if (sourceProjectId === targetProjectId) {
    return undefined;
  }
  if (!isEligibleProject(db, sourceProjectId) || !isEligibleProject(db, targetProjectId)) {
    return undefined;
  }
  const rows = db
    .prepare(
      "SELECT * FROM handoff_grants WHERE project_id = ? AND target_project_id = ? ORDER BY id",
    )
    .all(sourceProjectId, targetProjectId) as HandoffGrantRow[];
  const candidates = rows
    .map(rowToGrant)
    .filter(
      (grant) =>
        (grant.fromAppKey === fromAppKey || grant.fromAppKey === "*") &&
        (grant.toAppKey === toAppKey || grant.toAppKey === "*"),
    )
    .sort((a, b) => compareGrantCandidates(a, b, fromAppKey, toAppKey));
  const best = candidates[0];
  if (best === undefined) {
    return undefined;
  }
  return { grant: best, dispatchMode: best.dispatchMode, replyMode: best.replyMode };
}

/** Outbound grants owned by one source project. */
export function listHandoffGrants(db: SqliteDatabase, projectId: string): HandoffGrant[] {
  const rows = db
    .prepare(
      "SELECT * FROM handoff_grants WHERE project_id = ? ORDER BY from_app_key, to_app_key, id",
    )
    .all(projectId) as HandoffGrantRow[];
  return rows.map(rowToGrant);
}

/** Grants that target one project (read-only inbound visibility). */
export function listInboundHandoffGrants(db: SqliteDatabase, projectId: string): HandoffGrant[] {
  const rows = db
    .prepare(
      "SELECT * FROM handoff_grants WHERE target_project_id = ? " +
        "ORDER BY project_id, from_app_key, to_app_key, id",
    )
    .all(projectId) as HandoffGrantRow[];
  return rows.map(rowToGrant);
}

interface ReachableRow extends HandoffGrantRow {
  target_project_name: string;
  target_project_deleting: number;
  target_app_id: string;
  target_app_key: string;
  target_app_deleting: number;
}

/**
 * Concrete remote targets the caller app may reach through its outbound grants.
 *
 * Only grants whose source side matches the caller app (exact or `*`) are considered; a wildcard
 * target expands to every concrete app in the target project. Master/builtin projects, deleting
 * projects, and deleting apps are excluded. Duplicate app ids collapse to the most specific grant.
 */
export function listReachableRemoteTargets(
  db: SqliteDatabase,
  projectId: string,
  fromAppKey: string,
): RemoteTarget[] {
  if (fromAppKey.length === 0 || !isEligibleProject(db, projectId)) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT g.*, p.name AS target_project_name, p.deleting AS target_project_deleting,
              a.id AS target_app_id, a.app_key AS target_app_key, a.deleting AS target_app_deleting
       FROM handoff_grants g
       JOIN projects p ON p.id = g.target_project_id
       JOIN apps a ON a.project_id = g.target_project_id
       WHERE g.project_id = ?
         AND (g.from_app_key = ? OR g.from_app_key = '*')
         AND (g.to_app_key = a.app_key OR g.to_app_key = '*')
       ORDER BY g.id`,
    )
    .all(projectId, fromAppKey) as ReachableRow[];

  const bestByApp = new Map<string, { row: ReachableRow; grant: HandoffGrant }>();
  for (const row of rows) {
    if (isMasterProject(row.target_project_id) || row.target_project_deleting === 1) {
      continue;
    }
    if (row.target_app_deleting === 1) {
      continue;
    }
    const grant = rowToGrant(row);
    const existing = bestByApp.get(row.target_app_id);
    if (
      existing === undefined ||
      compareGrantCandidates(grant, existing.grant, fromAppKey, row.target_app_key) < 0
    ) {
      bestByApp.set(row.target_app_id, { row, grant });
    }
  }

  return [...bestByApp.values()]
    .map(({ row, grant }) => ({
      projectId: grant.targetProjectId,
      projectName: row.target_project_name,
      appKey: row.target_app_key,
      appId: row.target_app_id,
      grantId: grant.id,
      dispatchMode: grant.dispatchMode,
      replyMode: grant.replyMode,
    }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.appKey.localeCompare(b.appKey));
}

export interface SetHandoffGrantInput {
  projectId: string;
  fromAppKey?: string;
  targetProjectId: string;
  toAppKey?: string;
  dispatchMode?: string;
  replyMode?: string;
  actor?: string | null;
}

interface ParsedKey {
  key: string;
  validGrammar: boolean;
  malformed: boolean;
}

function parseKey(value: unknown): ParsedKey {
  if (value === undefined || value === null) {
    return { key: "*", validGrammar: true, malformed: false };
  }
  if (typeof value !== "string") {
    return { key: "*", validGrammar: true, malformed: true };
  }
  const key = value.trim();
  if (key.length === 0) {
    return { key: "*", validGrammar: true, malformed: false };
  }
  return { key, validGrammar: key === "*" || APP_KEY_PATTERN.test(key), malformed: false };
}

function parseMode(value: unknown, fallback: HandoffGrantMode): HandoffGrantMode | undefined {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (value === "auto" || value === "approve") {
    return value;
  }
  return undefined;
}

/**
 * Create or replace one outbound grant. `*` is the wildcard for either app key; a target project is
 * always concrete. Validation codes are the grant-CRUD set from the design (D7/M5).
 */
export function setHandoffGrant(db: SqliteDatabase, input: SetHandoffGrantInput): HandoffGrant {
  const source = projectState(db, input.projectId);
  if (source === undefined) {
    throw new HandoffGrantError("unknown_source_project", "source project not found");
  }
  const target = projectState(db, input.targetProjectId);
  if (target === undefined) {
    throw new HandoffGrantError("unknown_target_project", "target project not found");
  }
  if (source.id === target.id) {
    throw new HandoffGrantError("same_project_grant", "a grant must target another project");
  }
  if (isMasterProject(source.id) || isMasterProject(target.id)) {
    throw new HandoffGrantError(
      "builtin_target_forbidden",
      "the master project cannot take part in a cross-project grant",
    );
  }
  if (source.deleting === 1 || target.deleting === 1) {
    throw new HandoffGrantError("deleting_target_forbidden", "project is being deleted");
  }

  const from = parseKey(input.fromAppKey);
  const to = parseKey(input.toAppKey);

  if (from.validGrammar && from.key !== "*" && appState(db, source.id, from.key)?.deleting === 1) {
    throw new HandoffGrantError("deleting_target_forbidden", "source app is being deleted");
  }
  if (to.validGrammar && to.key !== "*" && appState(db, target.id, to.key)?.deleting === 1) {
    throw new HandoffGrantError("deleting_target_forbidden", "target app is being deleted");
  }
  if (!from.validGrammar || !to.validGrammar) {
    throw new HandoffGrantError("invalid_app_key", "application key is not valid");
  }
  if (from.key !== "*" && appState(db, source.id, from.key) === undefined) {
    throw new HandoffGrantError("unknown_source_app", "source application not found");
  }
  if (to.key !== "*" && appState(db, target.id, to.key) === undefined) {
    throw new HandoffGrantError("unknown_target_app", "target application not found");
  }

  const dispatchMode = parseMode(input.dispatchMode, DEFAULT_GRANT_DISPATCH_MODE);
  if (dispatchMode === undefined) {
    throw new HandoffGrantError("invalid_mode", 'dispatch_mode must be "auto" or "approve"');
  }
  const replyMode = parseMode(input.replyMode, DEFAULT_GRANT_REPLY_MODE);
  if (replyMode === undefined) {
    throw new HandoffGrantError("invalid_mode", 'reply_mode must be "auto" or "approve"');
  }

  if (from.malformed || to.malformed) {
    throw new HandoffGrantError("invalid_grant", "malformed grant input");
  }

  const actor = input.actor ?? null;
  const run = db.transaction((): HandoffGrant => {
    const existing = db
      .prepare(
        `SELECT id FROM handoff_grants
         WHERE project_id = ? AND from_app_key = ? AND target_project_id = ? AND to_app_key = ?`,
      )
      .get(source.id, from.key, target.id, to.key) as { id: number } | undefined;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO handoff_grants
         (project_id, from_app_key, target_project_id, to_app_key, dispatch_mode, reply_mode,
          created_at, created_by, updated_at, updated_by)
       VALUES (@project_id, @from_app_key, @target_project_id, @to_app_key, @dispatch_mode,
               @reply_mode, @created_at, @created_by, @updated_at, @updated_by)
       ON CONFLICT(project_id, from_app_key, target_project_id, to_app_key) DO UPDATE SET
         dispatch_mode = excluded.dispatch_mode,
         reply_mode = excluded.reply_mode,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    ).run({
      project_id: source.id,
      from_app_key: from.key,
      target_project_id: target.id,
      to_app_key: to.key,
      dispatch_mode: dispatchMode,
      reply_mode: replyMode,
      created_at: now,
      created_by: actor,
      updated_at: now,
      updated_by: actor,
    });
    const row = db
      .prepare(
        `SELECT * FROM handoff_grants
         WHERE project_id = ? AND from_app_key = ? AND target_project_id = ? AND to_app_key = ?`,
      )
      .get(source.id, from.key, target.id, to.key) as HandoffGrantRow;
    const grant = rowToGrant(row);
    recordEvent(
      db,
      grant.projectId,
      existing === undefined ? "handoff.grant.created" : "handoff.grant.updated",
      {
        grantId: grant.id,
        projectId: grant.projectId,
        targetProjectId: grant.targetProjectId,
        fromAppKey: grant.fromAppKey,
        toAppKey: grant.toAppKey,
        dispatchMode: grant.dispatchMode,
        replyMode: grant.replyMode,
        actor,
      },
    );
    return grant;
  });
  return run();
}

/**
 * Delete one exact grant. Returns `false` when the row does not exist; the deleted audit event is
 * written only when a row was actually removed.
 */
export function deleteHandoffGrant(
  db: SqliteDatabase,
  projectId: string,
  fromAppKey: string,
  targetProjectId: string,
  toAppKey: string,
  actor?: string | null,
): boolean {
  const run = db.transaction((): boolean => {
    const row = db
      .prepare(
        `SELECT * FROM handoff_grants
         WHERE project_id = ? AND from_app_key = ? AND target_project_id = ? AND to_app_key = ?`,
      )
      .get(projectId, fromAppKey, targetProjectId, toAppKey) as HandoffGrantRow | undefined;
    if (row === undefined) {
      return false;
    }
    db.prepare("DELETE FROM handoff_grants WHERE id = ?").run(row.id);
    recordEvent(db, projectId, "handoff.grant.deleted", {
      grantId: row.id,
      projectId: row.project_id,
      targetProjectId: row.target_project_id,
      fromAppKey: row.from_app_key,
      toAppKey: row.to_app_key,
      actor: actor ?? null,
    });
    return true;
  });
  return run();
}

/**
 * Remove exact-app grants on both sides when an app is deleted. Wildcard grants remain because the
 * app key was only one possible target of the wildcard.
 */
export function deleteAppHandoffGrants(
  db: SqliteDatabase,
  projectId: string,
  appKey: string,
): number {
  const result = db
    .prepare(
      `DELETE FROM handoff_grants
       WHERE (project_id = ? AND from_app_key = ?)
          OR (target_project_id = ? AND to_app_key = ?)`,
    )
    .run(projectId, appKey, projectId, appKey);
  return result.changes;
}

export interface CrossProjectDeniedPayload {
  projectId: string;
  targetProjectId: string;
  fromAppKey: string;
  toAppKey: string;
}

/**
 * Record one content-free cross-project denial for the source app. At most one event is written per
 * app per rate window; repeated denials still count toward the security-failure limiter.
 */
export function recordCrossProjectDenied(
  db: SqliteDatabase,
  sourceAppId: string,
  payload: CrossProjectDeniedPayload,
): void {
  const windowStart = new Date(Date.now() - HANDOFF_THREAD_RATE_WINDOW_MS).toISOString();
  const recent = db
    .prepare(
      `SELECT 1 FROM events
       WHERE scope = ? AND type = 'handoff.cross_project.denied' AND created_at > ?
       LIMIT 1`,
    )
    .get(sourceAppId, windowStart);
  if (recent !== undefined) {
    return;
  }
  recordEvent(db, sourceAppId, "handoff.cross_project.denied", {
    projectId: payload.projectId,
    targetProjectId: payload.targetProjectId,
    fromAppKey: payload.fromAppKey,
    toAppKey: payload.toAppKey,
  });
}
