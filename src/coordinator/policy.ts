import type { SqliteDatabase } from "../store/index.js";
import type { HandoffDispatchMode, HandoffReplyMode } from "./handoff.js";

export interface HandoffPolicy {
  id: number;
  projectId: string;
  fromAppKey: string;
  toAppKey: string;
  dispatchMode: HandoffDispatchMode;
  replyMode: HandoffReplyMode;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ResolvedHandoffPolicy {
  dispatchMode: HandoffDispatchMode;
  replyMode: HandoffReplyMode;
  /** The matching stored rule, or null when the built-in defaults apply. */
  rule: HandoffPolicy | null;
}

export const DEFAULT_HANDOFF_POLICY: ResolvedHandoffPolicy = {
  dispatchMode: "auto",
  replyMode: "auto",
  rule: null,
};

export class HandoffPolicyError extends Error {
  readonly code = "invalid_handoff_policy";

  constructor(message: string) {
    super(message);
    this.name = "HandoffPolicyError";
  }
}

interface HandoffPolicyRow {
  id: number;
  project_id: string;
  from_app_key: string;
  to_app_key: string;
  dispatch_mode: HandoffDispatchMode;
  reply_mode: HandoffReplyMode;
  updated_at: string;
  updated_by: string | null;
}

function rowToPolicy(row: HandoffPolicyRow): HandoffPolicy {
  return {
    id: row.id,
    projectId: row.project_id,
    fromAppKey: row.from_app_key,
    toAppKey: row.to_app_key,
    dispatchMode: row.dispatch_mode,
    replyMode: row.reply_mode,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function isDispatchMode(value: unknown): value is HandoffDispatchMode {
  return value === "auto" || value === "approve" || value === "deny";
}

function isReplyMode(value: unknown): value is HandoffReplyMode {
  return value === "auto" || value === "approve";
}

function normalizeAppKey(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return "*";
  }
  if (typeof value !== "string") {
    throw new HandoffPolicyError(`${field} must be a string`);
  }
  const key = value.trim();
  if (key.length === 0) {
    return "*";
  }
  if (key !== "*" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    throw new HandoffPolicyError(`${field} is not a valid application key`);
  }
  return key;
}

function assertAppExists(db: SqliteDatabase, projectId: string, appKey: string): void {
  if (appKey === "*") {
    return;
  }
  const row = db
    .prepare("SELECT 1 AS ok FROM apps WHERE project_id = ? AND app_key = ?")
    .get(projectId, appKey) as { ok: number } | undefined;
  if (row === undefined) {
    throw new HandoffPolicyError(`unknown application "${appKey}" in project ${projectId}`);
  }
}

function specificity(policy: HandoffPolicy, fromAppKey: string, toAppKey: string): number | null {
  const fromExact = policy.fromAppKey === fromAppKey;
  const toExact = policy.toAppKey === toAppKey;
  const fromMatches = fromExact || policy.fromAppKey === "*";
  const toMatches = toExact || policy.toAppKey === "*";
  if (!fromMatches || !toMatches) {
    return null;
  }
  // Exact pair (4) beats one wildcard (2) beats the project default (0).
  return (fromExact ? 2 : 0) + (toExact ? 2 : 0);
}

/**
 * Resolve the effective policy for one directed pair.
 *
 * Precedence is deterministic: exact pair, then a rule with an exact `from`, then an exact `to`,
 * then the project default. A stored rule always wins over the built-in defaults.
 */
export function resolveHandoffPolicy(
  db: SqliteDatabase,
  projectId: string,
  fromAppKey: string,
  toAppKey: string,
): ResolvedHandoffPolicy {
  const rows = db
    .prepare("SELECT * FROM handoff_policies WHERE project_id = ? ORDER BY id")
    .all(projectId) as HandoffPolicyRow[];
  const candidates = rows
    .map((row) => {
      const policy = rowToPolicy(row);
      return { policy, score: specificity(policy, fromAppKey, toAppKey) };
    })
    .filter((entry): entry is { policy: HandoffPolicy; score: number } => entry.score !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aFrom = a.policy.fromAppKey === fromAppKey ? 1 : 0;
      const bFrom = b.policy.fromAppKey === fromAppKey ? 1 : 0;
      if (bFrom !== aFrom) return bFrom - aFrom;
      const aTo = a.policy.toAppKey === toAppKey ? 1 : 0;
      const bTo = b.policy.toAppKey === toAppKey ? 1 : 0;
      if (bTo !== aTo) return bTo - aTo;
      return a.policy.id - b.policy.id;
    });
  const best = candidates[0];
  if (best === undefined) {
    return DEFAULT_HANDOFF_POLICY;
  }
  return {
    dispatchMode: best.policy.dispatchMode,
    replyMode: best.policy.replyMode,
    rule: best.policy,
  };
}

export function listHandoffPolicies(db: SqliteDatabase, projectId: string): HandoffPolicy[] {
  const rows = db
    .prepare(
      "SELECT * FROM handoff_policies WHERE project_id = ? ORDER BY from_app_key, to_app_key, id",
    )
    .all(projectId) as HandoffPolicyRow[];
  return rows.map(rowToPolicy);
}

export interface SetHandoffPolicyInput {
  projectId: string;
  fromAppKey?: string;
  toAppKey?: string;
  dispatchMode?: string;
  replyMode?: string;
  updatedBy?: string | null;
}

/** Create or replace one rule. `*` is the wildcard for either side. */
export function setHandoffPolicy(db: SqliteDatabase, input: SetHandoffPolicyInput): HandoffPolicy {
  const project = db.prepare("SELECT 1 AS ok FROM projects WHERE id = ?").get(input.projectId) as
    | { ok: number }
    | undefined;
  if (project === undefined) {
    throw new HandoffPolicyError(`unknown project: ${input.projectId}`);
  }
  const fromAppKey = normalizeAppKey(input.fromAppKey, "from");
  const toAppKey = normalizeAppKey(input.toAppKey, "to");
  const dispatchMode = input.dispatchMode ?? "auto";
  const replyMode = input.replyMode ?? "auto";
  if (!isDispatchMode(dispatchMode)) {
    throw new HandoffPolicyError('dispatch_mode must be "auto", "approve", or "deny"');
  }
  if (!isReplyMode(replyMode)) {
    throw new HandoffPolicyError('reply_mode must be "auto" or "approve"');
  }
  assertAppExists(db, input.projectId, fromAppKey);
  assertAppExists(db, input.projectId, toAppKey);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO handoff_policies
       (project_id, from_app_key, to_app_key, dispatch_mode, reply_mode, updated_at, updated_by)
     VALUES (@project_id, @from_app_key, @to_app_key, @dispatch_mode, @reply_mode, @updated_at, @updated_by)
     ON CONFLICT(project_id, from_app_key, to_app_key) DO UPDATE SET
       dispatch_mode = excluded.dispatch_mode,
       reply_mode = excluded.reply_mode,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run({
    project_id: input.projectId,
    from_app_key: fromAppKey,
    to_app_key: toAppKey,
    dispatch_mode: dispatchMode,
    reply_mode: replyMode,
    updated_at: now,
    updated_by: input.updatedBy ?? null,
  });
  const row = db
    .prepare(
      "SELECT * FROM handoff_policies WHERE project_id = ? AND from_app_key = ? AND to_app_key = ?",
    )
    .get(input.projectId, fromAppKey, toAppKey) as HandoffPolicyRow;
  return rowToPolicy(row);
}

export function deleteHandoffPolicy(
  db: SqliteDatabase,
  projectId: string,
  fromAppKey: string,
  toAppKey: string,
): boolean {
  const result = db
    .prepare(
      "DELETE FROM handoff_policies WHERE project_id = ? AND from_app_key = ? AND to_app_key = ?",
    )
    .run(projectId, fromAppKey, toAppKey);
  return result.changes > 0;
}

/** Remove pair rules that reference a deleted application (project deletion cascades separately). */
export function deleteAppHandoffPolicies(
  db: SqliteDatabase,
  projectId: string,
  appKey: string,
): number {
  const result = db
    .prepare(
      "DELETE FROM handoff_policies WHERE project_id = ? AND (from_app_key = ? OR to_app_key = ?)",
    )
    .run(projectId, appKey, appKey);
  return result.changes;
}
