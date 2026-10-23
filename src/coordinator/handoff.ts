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

/** Request outcomes a target agent can report through `deliver_handoff`. */
export type HandoffOutcome = "completed" | "blocked" | "failed";

/**
 * Reply routing state. This is deliberately orthogonal to {@link HandoffState}: a handoff can be
 * delivered by the target while its reply is still waiting for approval or for an operator relaunch.
 */
export type HandoffReplyState =
  | "none"
  | "pending"
  | "awaiting_approval"
  | "delivered"
  | "waiting_operator"
  | "failed"
  | "cancelled";

export const HANDOFF_REPLY_STATES: readonly HandoffReplyState[] = [
  "none",
  "pending",
  "awaiting_approval",
  "delivered",
  "waiting_operator",
  "failed",
  "cancelled",
];

export type HandoffOrigin = "agent" | "operator";
export type HandoffDispatchMode = "auto" | "approve" | "deny";
export type HandoffReplyMode = "auto" | "approve";

export function normalizeOutcome(value: unknown): HandoffOutcome {
  return value === "blocked" || value === "failed" ? value : "completed";
}

const TRANSITIONS: Record<HandoffState, readonly HandoffState[]> = {
  queued: ["awaiting_approval", "dispatching", "rejected", "failed", "cancelled", "expired"],
  awaiting_approval: ["dispatching", "rejected", "cancelled", "expired"],
  dispatching: ["in_progress", "failed", "cancelled"],
  in_progress: ["delivered", "failed", "cancelled"],
  delivered: [],
  rejected: [],
  failed: [],
  expired: [],
  cancelled: [],
};

const TERMINAL_STATES: readonly HandoffState[] = [
  "delivered",
  "rejected",
  "failed",
  "expired",
  "cancelled",
];

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
  outcome: HandoffOutcome | null;
  origin: HandoffOrigin;
  /** Session the request was created from. Null for operator-created handoffs and unbound events. */
  sourceSessionId: string | null;
  sourceSessionTitle: string | null;
  sourceSessionDeletedAt: string | null;
  /** Fresh session created on the target application for this handoff. */
  targetSessionId: string | null;
  targetSessionTitle: string | null;
  replyState: HandoffReplyState;
  replyMessageId: string | null;
  replyDeliveredSessionId: string | null;
  replyDeliveredAt: string | null;
  replyError: string | null;
  replyAttempts: number;
  dispatchMessageId: string | null;
  dispatchStartedAt: string | null;
  deadlineAt: string | null;
  operatorNote: string | null;
  deliveredVia: string | null;
  parentHandoffId: string | null;
  rootHandoffId: string | null;
  depth: number;
  policyDispatchMode: HandoffDispatchMode;
  policyReplyMode: HandoffReplyMode;
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

export function isTerminalHandoffState(state: HandoffState): boolean {
  return TERMINAL_STATES.includes(state);
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
  origin?: HandoffOrigin;
  policyDispatchMode?: HandoffDispatchMode;
  policyReplyMode?: HandoffReplyMode;
  sourceSessionId?: string | null;
}

/**
 * Mutable handoff fields. `undefined` means "leave unchanged"; `null` clears a nullable column.
 * State changes go through {@link transitionHandoff} so the transition table is always enforced.
 */
export interface HandoffPatch {
  state?: HandoffState;
  result?: string | null;
  error?: string | null;
  outcome?: HandoffOutcome | null;
  targetTaskId?: string | null;
  nextAttemptAt?: string | null;
  sourceSessionId?: string | null;
  sourceSessionTitle?: string | null;
  targetSessionId?: string | null;
  targetSessionTitle?: string | null;
  sourceSessionDeletedAt?: string | null;
  replyState?: HandoffReplyState;
  replyMessageId?: string | null;
  replyDeliveredSessionId?: string | null;
  replyDeliveredAt?: string | null;
  replyError?: string | null;
  replyAttempts?: number;
  dispatchMessageId?: string | null;
  dispatchStartedAt?: string | null;
  deadlineAt?: string | null;
  operatorNote?: string | null;
  deliveredVia?: string | null;
  policyDispatchMode?: HandoffDispatchMode;
  policyReplyMode?: HandoffReplyMode;
  parentHandoffId?: string | null;
  rootHandoffId?: string | null;
  depth?: number;
  bumpAttempts?: boolean;
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
  outcome: HandoffOutcome | null;
  origin: HandoffOrigin;
  source_session_id: string | null;
  source_session_title: string | null;
  source_session_deleted_at: string | null;
  target_session_id: string | null;
  target_session_title: string | null;
  reply_state: HandoffReplyState;
  reply_message_id: string | null;
  reply_delivered_session_id: string | null;
  reply_delivered_at: string | null;
  reply_error: string | null;
  reply_attempts: number;
  dispatch_message_id: string | null;
  dispatch_started_at: string | null;
  deadline_at: string | null;
  operator_note: string | null;
  delivered_via: string | null;
  parent_handoff_id: string | null;
  root_handoff_id: string | null;
  depth: number;
  policy_dispatch_mode: HandoffDispatchMode;
  policy_reply_mode: HandoffReplyMode;
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
    outcome: row.outcome,
    origin: row.origin,
    sourceSessionId: row.source_session_id,
    sourceSessionTitle: row.source_session_title,
    sourceSessionDeletedAt: row.source_session_deleted_at,
    targetSessionId: row.target_session_id,
    targetSessionTitle: row.target_session_title,
    replyState: row.reply_state,
    replyMessageId: row.reply_message_id,
    replyDeliveredSessionId: row.reply_delivered_session_id,
    replyDeliveredAt: row.reply_delivered_at,
    replyError: row.reply_error,
    replyAttempts: row.reply_attempts,
    dispatchMessageId: row.dispatch_message_id,
    dispatchStartedAt: row.dispatch_started_at,
    deadlineAt: row.deadline_at,
    operatorNote: row.operator_note,
    deliveredVia: row.delivered_via,
    parentHandoffId: row.parent_handoff_id,
    rootHandoffId: row.root_handoff_id,
    depth: row.depth,
    policyDispatchMode: row.policy_dispatch_mode,
    policyReplyMode: row.policy_reply_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PATCH_COLUMNS: ReadonlyArray<readonly [keyof HandoffPatch, string]> = [
  ["state", "state"],
  ["result", "result"],
  ["error", "error"],
  ["outcome", "outcome"],
  ["targetTaskId", "target_task_id"],
  ["nextAttemptAt", "next_attempt_at"],
  ["sourceSessionId", "source_session_id"],
  ["sourceSessionTitle", "source_session_title"],
  ["targetSessionId", "target_session_id"],
  ["targetSessionTitle", "target_session_title"],
  ["sourceSessionDeletedAt", "source_session_deleted_at"],
  ["replyState", "reply_state"],
  ["replyMessageId", "reply_message_id"],
  ["replyDeliveredSessionId", "reply_delivered_session_id"],
  ["replyDeliveredAt", "reply_delivered_at"],
  ["replyError", "reply_error"],
  ["replyAttempts", "reply_attempts"],
  ["dispatchMessageId", "dispatch_message_id"],
  ["dispatchStartedAt", "dispatch_started_at"],
  ["deadlineAt", "deadline_at"],
  ["operatorNote", "operator_note"],
  ["deliveredVia", "delivered_via"],
  ["policyDispatchMode", "policy_dispatch_mode"],
  ["policyReplyMode", "policy_reply_mode"],
  ["parentHandoffId", "parent_handoff_id"],
  ["rootHandoffId", "root_handoff_id"],
  ["depth", "depth"],
];

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
  const dispatchMode =
    input.policyDispatchMode ?? (input.requiresApproval === true ? "approve" : "auto");
  const replyMode = input.policyReplyMode ?? "auto";
  db.prepare(
    `INSERT INTO handoffs
       (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key, attempts,
        expires_at, origin, source_session_id, root_handoff_id, depth, policy_dispatch_mode,
        policy_reply_mode, created_at, updated_at)
     VALUES
       (@id, @project_id, @from_app_id, @to_app_id, @state, @summary, @spec, @idempotency_key, 0,
        @expires_at, @origin, @source_session_id, @root_handoff_id, 0, @policy_dispatch_mode,
        @policy_reply_mode, @created_at, @updated_at)
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
    origin: input.origin ?? "agent",
    source_session_id: input.sourceSessionId ?? null,
    root_handoff_id: id,
    policy_dispatch_mode: dispatchMode,
    policy_reply_mode: replyMode,
    created_at: now,
    updated_at: now,
  });
  const row = db
    .prepare("SELECT * FROM handoffs WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as HandoffRow;
  return rowToHandoff(row);
}

/** Apply mutable fields without changing the state machine. Returns the updated handoff. */
export function updateHandoff(db: SqliteDatabase, id: string, patch: HandoffPatch): Handoff {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, column] of PATCH_COLUMNS) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = value;
  }
  if (patch.bumpAttempts === true) {
    sets.push("attempts = attempts + 1");
  }
  if (sets.length === 0) {
    return requireHandoff(db, id);
  }
  sets.push("updated_at = @updated_at");
  params.updated_at = new Date().toISOString();
  db.prepare(`UPDATE handoffs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return requireHandoff(db, id);
}

export function transitionHandoff(
  db: SqliteDatabase,
  id: string,
  to: HandoffState,
  patch: HandoffPatch = {},
): Handoff {
  const current = requireHandoff(db, id);
  if (!canTransition(current.state, to)) {
    throw new HandoffTransitionError(current.state, to);
  }
  return updateHandoff(db, id, {
    ...patch,
    state: to,
    ...(to === "dispatching" && patch.bumpAttempts === undefined ? { bumpAttempts: true } : {}),
  });
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
      "SELECT id FROM handoffs WHERE expires_at IS NOT NULL AND expires_at <= ? AND state IN ('queued','awaiting_approval')",
    )
    .all(now) as { id: string }[];
  let expired = 0;
  for (const row of due) {
    try {
      transitionHandoff(db, row.id, "expired");
      expired += 1;
    } catch {
      // A concurrent state change (approval/dispatch/cancel) wins; the row is no longer expirable.
    }
  }
  return expired;
}

/** Fail dispatched or running handoffs whose deadline passed. Returns the number failed. */
export function failTimedOutHandoffs(
  db: SqliteDatabase,
  now: string = new Date().toISOString(),
): number {
  const due = db
    .prepare(
      `SELECT id FROM handoffs
       WHERE state IN ('dispatching','in_progress')
         AND deadline_at IS NOT NULL
         AND deadline_at <= ?`,
    )
    .all(now) as { id: string }[];
  let failed = 0;
  for (const row of due) {
    try {
      transitionHandoff(db, row.id, "failed", { error: "handoff timed out" });
      failed += 1;
    } catch {
      // Another actor changed the state first.
    }
  }
  return failed;
}
