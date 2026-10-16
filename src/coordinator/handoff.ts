import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../store/index.js";

export type HandoffState =
  | "queued"
  | "awaiting_approval"
  | "dispatching"
  | "in_progress"
  | "delivered"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export const HANDOFF_STATES: readonly HandoffState[] = [
  "queued",
  "awaiting_approval",
  "dispatching",
  "in_progress",
  "delivered",
  "rejected",
  "failed",
  "expired",
  "cancelled",
];

const TRANSITIONS: Record<HandoffState, readonly HandoffState[]> = {
  queued: ["awaiting_approval", "dispatching", "cancelled", "expired"],
  awaiting_approval: ["dispatching", "rejected", "cancelled", "expired"],
  dispatching: ["in_progress", "failed", "cancelled"],
  in_progress: ["delivered", "failed", "cancelled"],
  delivered: [],
  rejected: [],
  failed: [],
  expired: [],
  cancelled: [],
};

export interface Handoff {
  id: string;
  projectId: string;
  fromAppId: string;
  toAppId: string;
  state: HandoffState;
  summary: string;
  spec: string;
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt: string | null;
  expiresAt: string | null;
  targetTaskId: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class HandoffTransitionError extends Error {
  constructor(from: HandoffState, to: HandoffState) {
    super(`Invalid handoff transition: ${from} -> ${to}`);
    this.name = "HandoffTransitionError";
  }
}

export function canTransition(from: HandoffState, to: HandoffState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CreateHandoffInput {
  projectId: string;
  fromAppId: string;
  toAppId: string;
  summary: string;
  spec: string;
  idempotencyKey: string;
  requiresApproval?: boolean;
  expiresAt?: string | null;
  id?: string;
}

export interface TransitionPatch {
  result?: string;
  error?: string;
  targetTaskId?: string;
  nextAttemptAt?: string | null;
}

interface HandoffRow {
  id: string;
  project_id: string;
  from_app_id: string;
  to_app_id: string;
  state: HandoffState;
  summary: string;
  spec: string;
  idempotency_key: string;
  attempts: number;
  next_attempt_at: string | null;
  expires_at: string | null;
  target_task_id: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    projectId: row.project_id,
    fromAppId: row.from_app_id,
    toAppId: row.to_app_id,
    state: row.state,
    summary: row.summary,
    spec: row.spec,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    expiresAt: row.expires_at,
    targetTaskId: row.target_task_id,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireHandoff(db: SqliteDatabase, id: string): Handoff {
  const handoff = getHandoff(db, id);
  if (handoff === undefined) {
    throw new Error(`Handoff not found: ${id}`);
  }
  return handoff;
}

export function getHandoff(db: SqliteDatabase, id: string): Handoff | undefined {
  const row = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as HandoffRow | undefined;
  return row === undefined ? undefined : rowToHandoff(row);
}

export function createHandoff(db: SqliteDatabase, input: CreateHandoffInput): Handoff {
  const id = input.id ?? randomUUID();
  const now = new Date().toISOString();
  const state: HandoffState = input.requiresApproval === true ? "awaiting_approval" : "queued";
  db.prepare(
    `INSERT INTO handoffs
       (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key, attempts, expires_at, created_at, updated_at)
     VALUES
       (@id, @project_id, @from_app_id, @to_app_id, @state, @summary, @spec, @idempotency_key, 0, @expires_at, @created_at, @updated_at)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  ).run({
    id,
    project_id: input.projectId,
    from_app_id: input.fromAppId,
    to_app_id: input.toAppId,
    state,
    summary: input.summary,
    spec: input.spec,
    idempotency_key: input.idempotencyKey,
    expires_at: input.expiresAt ?? null,
    created_at: now,
    updated_at: now,
  });
  const row = db
    .prepare("SELECT * FROM handoffs WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as HandoffRow;
  return rowToHandoff(row);
}

export function transitionHandoff(
  db: SqliteDatabase,
  id: string,
  to: HandoffState,
  patch: TransitionPatch = {},
): Handoff {
  const current = requireHandoff(db, id);
  if (!canTransition(current.state, to)) {
    throw new HandoffTransitionError(current.state, to);
  }
  db.prepare(
    `UPDATE handoffs SET
       state = @state,
       result = COALESCE(@result, result),
       error = COALESCE(@error, error),
       target_task_id = COALESCE(@target_task_id, target_task_id),
       next_attempt_at = COALESCE(@next_attempt_at, next_attempt_at),
       attempts = attempts + @bump_attempts,
       updated_at = @updated_at
     WHERE id = @id`,
  ).run({
    id,
    state: to,
    result: patch.result ?? null,
    error: patch.error ?? null,
    target_task_id: patch.targetTaskId ?? null,
    next_attempt_at: patch.nextAttemptAt ?? null,
    bump_attempts: to === "dispatching" ? 1 : 0,
    updated_at: new Date().toISOString(),
  });
  return requireHandoff(db, id);
}

export function listHandoffs(db: SqliteDatabase, projectId?: string): Handoff[] {
  const rows =
    projectId === undefined
      ? (db.prepare("SELECT * FROM handoffs ORDER BY created_at").all() as HandoffRow[])
      : (db
          .prepare("SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at")
          .all(projectId) as HandoffRow[]);
  return rows.map(rowToHandoff);
}

/** Move any handoff whose expiry has passed into `expired`. Returns the number expired. */
export function expireDueHandoffs(
  db: SqliteDatabase,
  now: string = new Date().toISOString(),
): number {
  const due = db
    .prepare(
      "SELECT id, state FROM handoffs WHERE expires_at IS NOT NULL AND expires_at <= ? AND state IN ('queued','awaiting_approval')",
    )
    .all(now) as { id: string; state: HandoffState }[];
  for (const row of due) {
    transitionHandoff(db, row.id, "expired");
  }
  return due.length;
}
