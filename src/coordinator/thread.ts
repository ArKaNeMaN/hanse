import { randomUUID } from "node:crypto";
import { recordEvent } from "../store/events.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  canTransitionHandoffMessage,
  getHandoff,
  type Handoff,
  type HandoffDispatchMode,
  type HandoffMessage,
  type HandoffMessageAuthorSide,
  type HandoffMessageKind,
  type HandoffMessageState,
  type HandoffOrigin,
  type HandoffOutcome,
  type HandoffReplyMode,
  HandoffTransitionConflictError,
  HandoffTransitionError,
  isTerminalHandoffState,
} from "./handoff.js";

interface HandoffMessageRow {
  id: number;
  handoff_id: string;
  author_principal: string | null;
  kind: HandoffMessageKind;
  body: string;
  created_at: string;
  seq: number;
  author_app_id: string | null;
  author_side: HandoffMessageAuthorSide;
  state: HandoffMessageState;
  outcome: HandoffOutcome | null;
  delivery_session_id: string | null;
  delivery_message_id: string | null;
  delivered_at: string | null;
  claimed_at: string | null;
  client_message_id: string | null;
  binding_nonce: string | null;
  bound_session_id: string | null;
  bound_at: string | null;
  invoking_session_id: string | null;
  reply_to_message_id: number | null;
  error_code: string | null;
  updated_at: string | null;
}

function rowToHandoffMessage(row: HandoffMessageRow): HandoffMessage {
  return {
    id: row.id,
    handoffId: row.handoff_id,
    authorPrincipal: row.author_principal,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
    seq: row.seq,
    authorAppId: row.author_app_id,
    authorSide: row.author_side,
    state: row.state,
    outcome: row.outcome,
    deliverySessionId: row.delivery_session_id,
    deliveryMessageId: row.delivery_message_id,
    deliveredAt: row.delivered_at,
    claimedAt: row.claimed_at,
    clientMessageId: row.client_message_id,
    bindingNonce: row.binding_nonce,
    boundSessionId: row.bound_session_id,
    boundAt: row.bound_at,
    invokingSessionId: row.invoking_session_id,
    replyToMessageId: row.reply_to_message_id,
    errorCode: row.error_code,
    updatedAt: row.updated_at,
  };
}

function requireHandoffMessage(db: SqliteDatabase, id: number): HandoffMessage {
  const message = getHandoffMessage(db, id);
  if (message === undefined) {
    throw new Error(`Handoff message not found: ${id}`);
  }
  return message;
}

export function getHandoffMessage(db: SqliteDatabase, id: number): HandoffMessage | undefined {
  const row = db.prepare("SELECT * FROM handoff_messages WHERE id = ?").get(id) as
    | HandoffMessageRow
    | undefined;
  return row === undefined ? undefined : rowToHandoffMessage(row);
}

export function listHandoffMessages(db: SqliteDatabase, handoffId: string): HandoffMessage[] {
  const rows = db
    .prepare("SELECT * FROM handoff_messages WHERE handoff_id = ? ORDER BY seq, id")
    .all(handoffId) as HandoffMessageRow[];
  return rows.map(rowToHandoffMessage);
}

export interface InsertHandoffMessageInput {
  handoffId: string;
  seq: number;
  kind: HandoffMessageKind;
  body: string;
  authorPrincipal?: string | null;
  authorAppId?: string | null;
  authorSide?: HandoffMessageAuthorSide;
  state?: HandoffMessageState;
  outcome?: HandoffOutcome | null;
  deliverySessionId?: string | null;
  deliveryMessageId?: string | null;
  deliveredAt?: string | null;
  claimedAt?: string | null;
  clientMessageId?: string | null;
  bindingNonce?: string | null;
  boundSessionId?: string | null;
  boundAt?: string | null;
  invokingSessionId?: string | null;
  replyToMessageId?: number | null;
  errorCode?: string | null;
  createdAt?: string;
}

export function insertHandoffMessage(
  db: SqliteDatabase,
  input: InsertHandoffMessageInput,
): HandoffMessage {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO handoff_messages
         (handoff_id, seq, author_principal, kind, body, created_at, author_app_id, author_side,
          state, outcome, delivery_session_id, delivery_message_id, delivered_at, claimed_at,
          client_message_id, binding_nonce, bound_session_id, bound_at, invoking_session_id,
          reply_to_message_id, error_code, updated_at)
       VALUES
         (@handoff_id, @seq, @author_principal, @kind, @body, @created_at, @author_app_id,
          @author_side, @state, @outcome, @delivery_session_id, @delivery_message_id,
          @delivered_at, @claimed_at, @client_message_id, @binding_nonce, @bound_session_id,
          @bound_at, @invoking_session_id, @reply_to_message_id, @error_code, @updated_at)`,
    )
    .run({
      handoff_id: input.handoffId,
      seq: input.seq,
      author_principal: input.authorPrincipal ?? null,
      kind: input.kind,
      body: input.body,
      created_at: createdAt,
      author_app_id: input.authorAppId ?? null,
      author_side: input.authorSide ?? "system",
      state: input.state ?? "binding",
      outcome: input.outcome ?? null,
      delivery_session_id: input.deliverySessionId ?? null,
      delivery_message_id: input.deliveryMessageId ?? null,
      delivered_at: input.deliveredAt ?? null,
      claimed_at: input.claimedAt ?? null,
      client_message_id: input.clientMessageId ?? null,
      binding_nonce: input.bindingNonce ?? null,
      bound_session_id: input.boundSessionId ?? null,
      bound_at: input.boundAt ?? null,
      invoking_session_id: input.invokingSessionId ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
      error_code: input.errorCode ?? null,
      updated_at: createdAt,
    });
  return requireHandoffMessage(db, Number(result.lastInsertRowid));
}

export interface HandoffMessagePatch {
  outcome?: HandoffOutcome | null;
  deliverySessionId?: string | null;
  deliveryMessageId?: string | null;
  deliveredAt?: string | null;
  claimedAt?: string | null;
  clientMessageId?: string | null;
  bindingNonce?: string | null;
  boundSessionId?: string | null;
  boundAt?: string | null;
  invokingSessionId?: string | null;
  errorCode?: string | null;
}

const PATCH_COLUMNS: ReadonlyArray<readonly [keyof HandoffMessagePatch, string]> = [
  ["outcome", "outcome"],
  ["deliverySessionId", "delivery_session_id"],
  ["deliveryMessageId", "delivery_message_id"],
  ["deliveredAt", "delivered_at"],
  ["claimedAt", "claimed_at"],
  ["clientMessageId", "client_message_id"],
  ["bindingNonce", "binding_nonce"],
  ["boundSessionId", "bound_session_id"],
  ["boundAt", "bound_at"],
  ["invokingSessionId", "invoking_session_id"],
  ["errorCode", "error_code"],
];

/**
 * Compare-and-set a message state transition. Zero updated rows means another actor won the race and
 * throws {@link HandoffTransitionConflictError}.
 */
export function transitionHandoffMessage(
  db: SqliteDatabase,
  id: number,
  to: HandoffMessageState,
  patch: HandoffMessagePatch = {},
): HandoffMessage {
  const current = requireHandoffMessage(db, id);
  if (!canTransitionHandoffMessage(current.state, to)) {
    throw new HandoffTransitionError(current.state, to);
  }
  const sets: string[] = ["state = @to"];
  const params: Record<string, unknown> = {
    id,
    from: current.state,
    to,
    updated_at: new Date().toISOString(),
  };
  for (const [key, column] of PATCH_COLUMNS) {
    const value = patch[key];
    if (value === undefined) continue;
    sets.push(`${column} = @${key}`);
    params[key] = value;
  }
  sets.push("updated_at = @updated_at");
  const result = db
    .prepare(`UPDATE handoff_messages SET ${sets.join(", ")} WHERE id = @id AND state = @from`)
    .run(params);
  if (result.changes === 0) {
    throw new HandoffTransitionConflictError(id, current.state, to);
  }
  return requireHandoffMessage(db, id);
}

export interface ThreadCounterBumpInput {
  now: string;
  idleExpiresAt: string;
  maxMessages: number;
}

export interface ThreadCounterBump {
  messageSeq: number;
  messageCount: number;
}

/**
 * Allocate the next thread sequence and message count for an append. Returns `undefined` when the
 * header is not an open thread or the message cap is already reached; the caller owns the error.
 */
export function bumpThreadCounters(
  db: SqliteDatabase,
  handoffId: string,
  input: ThreadCounterBumpInput,
): ThreadCounterBump | undefined {
  const row = db
    .prepare(
      `UPDATE handoffs
       SET message_seq = message_seq + 1,
           message_count = message_count + 1,
           last_message_at = @now,
           thread_idle_expires_at = @idle,
           updated_at = @now
       WHERE id = @id AND mode = 'thread' AND state = 'in_progress'
         AND message_count < @maxMessages
       RETURNING message_seq, message_count`,
    )
    .get({
      id: handoffId,
      now: input.now,
      idle: input.idleExpiresAt,
      maxMessages: input.maxMessages,
    }) as { message_seq: number; message_count: number } | undefined;
  return row === undefined
    ? undefined
    : { messageSeq: row.message_seq, messageCount: row.message_count };
}

export type ThreadErrorCode =
  | "not_a_thread"
  | "thread_not_found"
  | "thread_not_started"
  | "thread_full"
  | "wrong_side"
  | "wrong_app"
  | "reply_to_required"
  | "invalid_reply_to"
  | "invalid_body"
  | "body_too_large"
  | "summary_too_large"
  | "spec_too_large"
  | "invalid_idempotency_key"
  | "invalid_client_message_id"
  | "idempotency_conflict"
  | "approval_stale"
  | "thread_quota"
  | "rate_limited"
  | "thread_terminal";

export class ThreadError extends Error {
  readonly code: ThreadErrorCode;

  constructor(code: ThreadErrorCode, message: string) {
    super(message);
    this.name = "ThreadError";
    this.code = code;
  }
}

export const HANDOFF_THREAD_MAX_MESSAGES = 32;
export const HANDOFF_THREAD_MAX_BODY_BYTES = 32 * 1024;
export const HANDOFF_THREAD_MAX_SPEC_BYTES = 32 * 1024;
export const HANDOFF_THREAD_MAX_SUMMARY_BYTES = 512;
export const HANDOFF_THREAD_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const HANDOFF_THREAD_MESSAGE_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;
export const HANDOFF_THREAD_MAX_ACTIVE_PER_SOURCE_APP = 8;
export const HANDOFF_THREAD_MAX_PENDING_PER_TARGET_APP = 32;
export const HANDOFF_THREAD_RATE_LIMIT_PER_APP = 10;
export const HANDOFF_THREAD_RATE_WINDOW_MS = 60 * 1000;
export const HANDOFF_THREAD_SECURITY_FAILURES_PER_APP = 20;
export const HANDOFF_THREAD_SECURITY_WINDOW_MS = 60 * 60 * 1000;
export const HANDOFF_THREAD_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const HANDOFF_THREAD_GC_BATCH = 100;

export interface ThreadLimits {
  idleTtlMs: number;
  maxMessages: number;
  maxBodyBytes: number;
  maxSpecBytes: number;
  maxSummaryBytes: number;
  messageDispatchTimeoutMs: number;
  maxActivePerSourceApp: number;
  maxPendingPerTargetApp: number;
  rateLimitPerApp: number;
  rateWindowMs: number;
  securityFailuresPerApp: number;
  securityWindowMs: number;
  terminalRetentionMs: number;
  gcBatch: number;
}

export const DEFAULT_THREAD_LIMITS: ThreadLimits = {
  idleTtlMs: HANDOFF_THREAD_IDLE_TTL_MS,
  maxMessages: HANDOFF_THREAD_MAX_MESSAGES,
  maxBodyBytes: HANDOFF_THREAD_MAX_BODY_BYTES,
  maxSpecBytes: HANDOFF_THREAD_MAX_SPEC_BYTES,
  maxSummaryBytes: HANDOFF_THREAD_MAX_SUMMARY_BYTES,
  messageDispatchTimeoutMs: HANDOFF_THREAD_MESSAGE_DISPATCH_TIMEOUT_MS,
  maxActivePerSourceApp: HANDOFF_THREAD_MAX_ACTIVE_PER_SOURCE_APP,
  maxPendingPerTargetApp: HANDOFF_THREAD_MAX_PENDING_PER_TARGET_APP,
  rateLimitPerApp: HANDOFF_THREAD_RATE_LIMIT_PER_APP,
  rateWindowMs: HANDOFF_THREAD_RATE_WINDOW_MS,
  securityFailuresPerApp: HANDOFF_THREAD_SECURITY_FAILURES_PER_APP,
  securityWindowMs: HANDOFF_THREAD_SECURITY_WINDOW_MS,
  terminalRetentionMs: HANDOFF_THREAD_TERMINAL_RETENTION_MS,
  gcBatch: HANDOFF_THREAD_GC_BATCH,
};

const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasDisallowedBodyControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      return true;
    }
  }
  return false;
}

function hasDisallowedSummaryControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function validateThreadSummary(summary: string, limits: ThreadLimits): void {
  if (
    summary.trim().length === 0 ||
    utf8Bytes(summary) > limits.maxSummaryBytes ||
    hasDisallowedSummaryControl(summary)
  ) {
    throw new ThreadError(
      "summary_too_large",
      "summary must be non-empty, single-line, and at most 512 UTF-8 bytes",
    );
  }
}

function validateThreadSpec(spec: string, limits: ThreadLimits): void {
  if (utf8Bytes(spec) > limits.maxSpecBytes || hasDisallowedBodyControl(spec)) {
    throw new ThreadError("spec_too_large", "spec must be at most 32768 UTF-8 bytes");
  }
}

function validateThreadBody(body: string, limits: ThreadLimits): void {
  if (body.trim().length === 0 || hasDisallowedBodyControl(body)) {
    throw new ThreadError(
      "invalid_body",
      "body must be non-empty and contain no control characters",
    );
  }
  if (utf8Bytes(body) > limits.maxBodyBytes) {
    throw new ThreadError("body_too_large", "body must be at most 32768 UTF-8 bytes");
  }
}

function normalizeClientMessageId(value: string | null | undefined): string {
  if (value === undefined || value === null || value.length === 0) {
    return `cm_${randomUUID()}`;
  }
  if (!CLIENT_MESSAGE_ID_PATTERN.test(value)) {
    throw new ThreadError(
      "invalid_client_message_id",
      "client_message_id must be 1-128 characters of [A-Za-z0-9._:-]",
    );
  }
  return value;
}

function normalizeUserKey(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return randomUUID();
  }
  if (!CLIENT_MESSAGE_ID_PATTERN.test(value)) {
    throw new ThreadError(
      "invalid_idempotency_key",
      "idempotency_key must be 1-128 characters of [A-Za-z0-9._:-]",
    );
  }
  return value;
}

export function buildThreadIdempotencyKey(
  projectId: string,
  fromAppId: string,
  toAppId: string,
  userKey: string,
): string {
  return `v1|${projectId}|${fromAppId}|${toAppId}|thread|${userKey}`;
}

function getInitialMessage(db: SqliteDatabase, handoffId: string): HandoffMessage | undefined {
  const row = db
    .prepare("SELECT id FROM handoff_messages WHERE handoff_id = ? AND seq = 1")
    .get(handoffId) as { id: number } | undefined;
  return row === undefined ? undefined : getHandoffMessage(db, row.id);
}

function requireInitialMessage(db: SqliteDatabase, handoffId: string): HandoffMessage {
  const message = getInitialMessage(db, handoffId);
  if (message === undefined) {
    throw new ThreadError("thread_not_started", `Thread ${handoffId} has no initial message`);
  }
  return message;
}

export interface ThreadInitialMessage {
  id: number;
  seq: number;
  clientMessageId: string;
  bindingNonce: string;
}

export interface ThreadMessageView {
  id: number;
  seq: number;
  state: HandoffMessageState;
  clientMessageId: string;
  bindingNonce: string;
}

function requireClientIdentity(message: HandoffMessage): {
  clientMessageId: string;
  bindingNonce: string;
} {
  if (message.clientMessageId === null || message.bindingNonce === null) {
    throw new Error(`Handoff message ${message.id} has no client identity`);
  }
  return { clientMessageId: message.clientMessageId, bindingNonce: message.bindingNonce };
}

export function toThreadInitialMessage(message: HandoffMessage): ThreadInitialMessage {
  const identity = requireClientIdentity(message);
  return {
    id: message.id,
    seq: message.seq,
    clientMessageId: identity.clientMessageId,
    bindingNonce: identity.bindingNonce,
  };
}

export function toThreadMessageView(message: HandoffMessage): ThreadMessageView {
  const identity = requireClientIdentity(message);
  return {
    id: message.id,
    seq: message.seq,
    state: message.state,
    clientMessageId: identity.clientMessageId,
    bindingNonce: identity.bindingNonce,
  };
}

export interface ThreadIdempotencyInput {
  projectId: string;
  fromAppId: string;
  toAppId: string;
  idempotencyKey: string;
  summary: string;
  spec: string;
}

export interface ThreadIdempotencyMatch {
  handoff: Handoff;
  initialMessage: HandoffMessage;
}

export function resolveThreadIdempotency(
  db: SqliteDatabase,
  input: ThreadIdempotencyInput,
): ThreadIdempotencyMatch | undefined {
  const namespacedKey = buildThreadIdempotencyKey(
    input.projectId,
    input.fromAppId,
    input.toAppId,
    input.idempotencyKey,
  );
  const namespaced = db
    .prepare("SELECT id FROM handoffs WHERE idempotency_key = ?")
    .get(namespacedKey) as { id: string } | undefined;
  const legacy =
    namespaced === undefined
      ? (db
          .prepare(
            `SELECT id FROM handoffs
             WHERE idempotency_key = ? AND project_id = ? AND from_app_id = ? AND to_app_id = ?
               AND mode = 'thread'`,
          )
          .get(input.idempotencyKey, input.projectId, input.fromAppId, input.toAppId) as
          | { id: string }
          | undefined)
      : undefined;
  const row = namespaced ?? legacy;
  if (row === undefined) {
    return undefined;
  }
  const handoff = getHandoff(db, row.id);
  if (handoff === undefined) {
    return undefined;
  }
  if (
    handoff.projectId !== input.projectId ||
    handoff.fromAppId !== input.fromAppId ||
    handoff.toAppId !== input.toAppId ||
    handoff.mode !== "thread"
  ) {
    throw new ThreadError(
      "idempotency_conflict",
      "idempotency_key is already used by a different thread",
    );
  }
  if (handoff.summary !== input.summary || handoff.spec !== input.spec) {
    throw new ThreadError(
      "idempotency_conflict",
      "idempotency_key was already used with different content",
    );
  }
  return { handoff, initialMessage: requireInitialMessage(db, handoff.id) };
}

type ThreadTool = "request_sibling_change" | "send_handoff_message" | "deliver_handoff";

function recordThreadAttempt(
  db: SqliteDatabase,
  appId: string,
  tool: ThreadTool,
  outcome: "ok" | "failure",
): void {
  recordEvent(db, appId, "handoff.thread.attempt", { appId, tool, outcome });
}

function sourceActiveCount(db: SqliteDatabase, appId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM handoffs
         WHERE from_app_id = ? AND mode = 'thread'
           AND state IN ('queued','awaiting_approval','dispatching','in_progress')`,
      )
      .get(appId) as { count: number }
  ).count;
}

function targetPendingCount(db: SqliteDatabase, appId: string): number {
  return (
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM handoffs
            WHERE to_app_id = @app AND mode = 'thread'
              AND state IN ('queued','awaiting_approval','dispatching'))
           +
           (SELECT COUNT(*) FROM handoff_messages m JOIN handoffs h ON h.id = m.handoff_id
            WHERE h.to_app_id = @app AND m.state = 'queued') AS count`,
      )
      .get({ app: appId }) as { count: number }
  ).count;
}

function appRateCount(db: SqliteDatabase, appId: string, windowStart: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM handoff_messages
         WHERE author_app_id = ? AND created_at > ?`,
      )
      .get(appId, windowStart) as { count: number }
  ).count;
}

function securityFailureCount(db: SqliteDatabase, appId: string, windowStart: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM events
         WHERE scope = ? AND type = 'handoff.thread.attempt'
           AND json_extract(payload, '$.outcome') = 'failure'
           AND created_at > ?`,
      )
      .get(appId, windowStart) as { count: number }
  ).count;
}

function assertThreadQuotas(
  db: SqliteDatabase,
  limits: ThreadLimits,
  input: {
    sourceAppId?: string;
    targetAppId: string;
    authorAppId: string;
    now: string;
  },
): void {
  if (
    input.sourceAppId !== undefined &&
    sourceActiveCount(db, input.sourceAppId) >= limits.maxActivePerSourceApp
  ) {
    throw new ThreadError("thread_quota", "source application has too many active threads");
  }
  if (targetPendingCount(db, input.targetAppId) >= limits.maxPendingPerTargetApp) {
    throw new ThreadError("thread_quota", "target application has too many pending messages");
  }
  const rateWindowStart = new Date(Date.parse(input.now) - limits.rateWindowMs).toISOString();
  if (appRateCount(db, input.authorAppId, rateWindowStart) >= limits.rateLimitPerApp) {
    throw new ThreadError("rate_limited", "application thread rate limit reached");
  }
  const securityWindowStart = new Date(
    Date.parse(input.now) - limits.securityWindowMs,
  ).toISOString();
  if (
    securityFailureCount(db, input.authorAppId, securityWindowStart) >=
    limits.securityFailuresPerApp
  ) {
    throw new ThreadError("rate_limited", "application thread failure limit reached");
  }
}

export type ThreadStartStatus = "queued" | "awaiting_approval" | "denied" | "existing";

export interface CreateThreadInput {
  projectId: string;
  fromAppId: string;
  toAppId: string;
  summary: string;
  spec: string;
  idempotencyKey?: string;
  requiresApproval?: boolean;
  policyDispatchMode: HandoffDispatchMode;
  policyReplyMode: HandoffReplyMode;
  origin?: HandoffOrigin;
}

export interface CreateThreadResult {
  handoff: Handoff;
  status: ThreadStartStatus;
  initialMessage: ThreadInitialMessage;
}

function insertThreadApproval(db: SqliteDatabase, handoffId: string, now: string): void {
  const approvalId = randomUUID();
  db.prepare(
    "INSERT INTO approvals (id, handoff_id, kind, state, requested_at) VALUES (?, ?, 'dispatch', 'pending', ?)",
  ).run(approvalId, handoffId, now);
  db.prepare("UPDATE handoffs SET approval_id = ?, updated_at = ? WHERE id = ?").run(
    approvalId,
    now,
    handoffId,
  );
}

export function createThread(
  db: SqliteDatabase,
  input: CreateThreadInput,
  limits: ThreadLimits = DEFAULT_THREAD_LIMITS,
): CreateThreadResult {
  try {
    const result = createThreadInternal(db, input, limits);
    recordThreadAttempt(
      db,
      input.fromAppId,
      "request_sibling_change",
      result.status === "denied" ? "failure" : "ok",
    );
    return result;
  } catch (error) {
    recordThreadAttempt(db, input.fromAppId, "request_sibling_change", "failure");
    throw error;
  }
}

function createThreadInternal(
  db: SqliteDatabase,
  input: CreateThreadInput,
  limits: ThreadLimits,
): CreateThreadResult {
  validateThreadSummary(input.summary, limits);
  validateThreadSpec(input.spec, limits);
  const userKey = normalizeUserKey(input.idempotencyKey);
  const dispatchMode =
    input.policyDispatchMode === "auto" && input.requiresApproval === true
      ? "approve"
      : input.policyDispatchMode;
  const requiresStartApproval =
    dispatchMode === "approve" || (dispatchMode !== "deny" && input.policyReplyMode === "approve");
  const initialState: Handoff["state"] =
    dispatchMode === "deny" ? "rejected" : requiresStartApproval ? "awaiting_approval" : "queued";

  const run = db.transaction((): CreateThreadResult => {
    const existing = resolveThreadIdempotency(db, {
      projectId: input.projectId,
      fromAppId: input.fromAppId,
      toAppId: input.toAppId,
      idempotencyKey: userKey,
      summary: input.summary,
      spec: input.spec,
    });
    if (existing !== undefined) {
      return {
        handoff: existing.handoff,
        status: "existing",
        initialMessage: toThreadInitialMessage(existing.initialMessage),
      };
    }

    const now = new Date().toISOString();
    assertThreadQuotas(db, limits, {
      sourceAppId: input.fromAppId,
      targetAppId: input.toAppId,
      authorAppId: input.fromAppId,
      now,
    });
    const id = randomUUID();
    const threadIdleExpiresAt = new Date(Date.parse(now) + limits.idleTtlMs).toISOString();
    const clientMessageId = `cm_${randomUUID()}`;
    const bindingNonce = `n_${randomUUID()}`;

    db.prepare(
      `INSERT INTO handoffs
         (id, project_id, from_app_id, to_app_id, state, mode, summary, spec, idempotency_key,
          attempts, origin, root_handoff_id, depth, policy_dispatch_mode, policy_reply_mode,
          message_seq, message_count, last_message_at, thread_idle_expires_at, created_at, updated_at)
       VALUES
         (@id, @project_id, @from_app_id, @to_app_id, @state, 'thread', @summary, @spec,
          @idempotency_key, 0, @origin, @id, 0, @policy_dispatch_mode, @policy_reply_mode,
          1, 1, @created_at, @thread_idle_expires_at, @created_at, @updated_at)`,
    ).run({
      id,
      project_id: input.projectId,
      from_app_id: input.fromAppId,
      to_app_id: input.toAppId,
      state: initialState,
      summary: input.summary,
      spec: input.spec,
      idempotency_key: buildThreadIdempotencyKey(
        input.projectId,
        input.fromAppId,
        input.toAppId,
        userKey,
      ),
      origin: input.origin ?? "agent",
      policy_dispatch_mode: dispatchMode,
      policy_reply_mode: input.policyReplyMode,
      created_at: now,
      thread_idle_expires_at: threadIdleExpiresAt,
      updated_at: now,
    });

    let message = insertHandoffMessage(db, {
      handoffId: id,
      seq: 1,
      kind: "request",
      body: input.spec,
      authorSide: "source",
      authorAppId: input.fromAppId,
      state: "binding",
      clientMessageId,
      bindingNonce,
      createdAt: now,
    });

    if (dispatchMode === "deny") {
      db.prepare("UPDATE handoffs SET error = ?, updated_at = ? WHERE id = ?").run(
        "denied by handoff policy",
        now,
        id,
      );
      message = transitionHandoffMessage(db, message.id, "cancelled", {
        errorCode: "start_rejected",
      });
    } else if (requiresStartApproval) {
      insertThreadApproval(db, id, now);
    }

    const handoff = getHandoff(db, id);
    if (handoff === undefined) {
      throw new Error(`Thread not found after insert: ${id}`);
    }
    const status: ThreadStartStatus =
      initialState === "rejected"
        ? "denied"
        : initialState === "awaiting_approval"
          ? "awaiting_approval"
          : "queued";
    return { handoff, status, initialMessage: toThreadInitialMessage(message) };
  });
  return run.immediate();
}

export interface AppendThreadMessageInput {
  handoffId: string;
  body: string;
  clientMessageId?: string | null;
  callerAppId?: string | null;
}

export interface ThreadAppendResult {
  handoff: Handoff;
  message: HandoffMessage;
}

function requireThreadHeader(db: SqliteDatabase, handoffId: string): Handoff {
  const handoff = getHandoff(db, handoffId);
  if (handoff === undefined) {
    throw new ThreadError("thread_not_found", `Handoff not found: ${handoffId}`);
  }
  return handoff;
}

function assertThreadMode(handoff: Handoff): void {
  if (handoff.mode !== "thread") {
    throw new ThreadError("not_a_thread", `Handoff ${handoff.id} is not a thread`);
  }
}

function assertAppendableThread(handoff: Handoff): void {
  if (handoff.state !== "in_progress") {
    throw new ThreadError(
      "thread_not_started",
      `Thread ${handoff.id} is not open (state: ${handoff.state})`,
    );
  }
}

function assertThreadFull(handoff: Handoff, limits: ThreadLimits): void {
  if (handoff.messageCount >= limits.maxMessages) {
    throw new ThreadError(
      "thread_full",
      `Thread ${handoff.id} has reached the ${limits.maxMessages}-message limit`,
    );
  }
}

function appendableThread(db: SqliteDatabase, handoffId: string): Handoff {
  const handoff = requireThreadHeader(db, handoffId);
  assertThreadMode(handoff);
  assertAppendableThread(handoff);
  return handoff;
}

function requireDestinationSession(handoff: Handoff, side: "source" | "target"): string {
  const sessionId = side === "source" ? handoff.sourceSessionId : handoff.targetSessionId;
  if (sessionId === null) {
    throw new ThreadError(
      "thread_not_started",
      `Thread ${handoff.id} has no ${side} session to deliver to`,
    );
  }
  return sessionId;
}

function findMessageByClientId(
  db: SqliteDatabase,
  handoffId: string,
  authorSide: HandoffMessageAuthorSide,
  clientMessageId: string,
): HandoffMessage | undefined {
  const row = db
    .prepare(
      `SELECT id FROM handoff_messages
       WHERE handoff_id = ? AND author_side = ? AND client_message_id = ?`,
    )
    .get(handoffId, authorSide, clientMessageId) as { id: number } | undefined;
  return row === undefined ? undefined : getHandoffMessage(db, row.id);
}

function bumpOrThrow(
  db: SqliteDatabase,
  handoff: Handoff,
  now: string,
  limits: ThreadLimits,
): ThreadCounterBump {
  const idleExpiresAt = new Date(Date.parse(now) + limits.idleTtlMs).toISOString();
  const bump = bumpThreadCounters(db, handoff.id, {
    now,
    idleExpiresAt,
    maxMessages: limits.maxMessages,
  });
  if (bump === undefined) {
    throw new ThreadError("thread_full", `Thread ${handoff.id} cannot accept another message`);
  }
  return bump;
}

export function appendThreadMessage(
  db: SqliteDatabase,
  input: AppendThreadMessageInput,
  limits: ThreadLimits = DEFAULT_THREAD_LIMITS,
): ThreadAppendResult {
  const handoffForAttempt = getHandoff(db, input.handoffId);
  const attemptAppId = input.callerAppId ?? handoffForAttempt?.fromAppId;
  try {
    const result = appendThreadMessageInternal(db, input, limits);
    if (attemptAppId !== undefined && attemptAppId !== null) {
      recordThreadAttempt(db, attemptAppId, "send_handoff_message", "ok");
    }
    return result;
  } catch (error) {
    if (attemptAppId !== undefined && attemptAppId !== null) {
      recordThreadAttempt(db, attemptAppId, "send_handoff_message", "failure");
    }
    throw error;
  }
}

function appendThreadMessageInternal(
  db: SqliteDatabase,
  input: AppendThreadMessageInput,
  limits: ThreadLimits,
): ThreadAppendResult {
  const run = db.transaction((): ThreadAppendResult => {
    const handoff = appendableThread(db, input.handoffId);
    if (input.callerAppId !== undefined && input.callerAppId !== null) {
      if (input.callerAppId !== handoff.fromAppId) {
        throw new ThreadError("wrong_side", "only the source application may append messages");
      }
    }
    const clientMessageId = normalizeClientMessageId(input.clientMessageId);
    const existing = findMessageByClientId(db, handoff.id, "source", clientMessageId);
    if (existing !== undefined) {
      if (existing.body !== input.body) {
        throw new ThreadError(
          "idempotency_conflict",
          "client_message_id was already used with different content",
        );
      }
      return { handoff, message: existing };
    }
    const now = new Date().toISOString();
    assertThreadQuotas(db, limits, {
      targetAppId: handoff.toAppId,
      authorAppId: handoff.fromAppId,
      now,
    });
    assertThreadFull(handoff, limits);
    validateThreadBody(input.body, limits);
    const deliverySessionId = requireDestinationSession(handoff, "target");
    const bump = bumpOrThrow(db, handoff, now, limits);
    const message = insertHandoffMessage(db, {
      handoffId: handoff.id,
      seq: bump.messageSeq,
      kind: "message",
      body: input.body,
      authorSide: "source",
      authorAppId: handoff.fromAppId,
      state: "binding",
      deliverySessionId,
      clientMessageId,
      bindingNonce: `n_${randomUUID()}`,
      createdAt: now,
    });
    const updated = getHandoff(db, handoff.id);
    if (updated === undefined) {
      throw new Error(`Thread not found after append: ${handoff.id}`);
    }
    return { handoff: updated, message };
  });
  return run.immediate();
}

export interface AppendThreadReplyInput {
  handoffId: string;
  body: string;
  outcome: HandoffOutcome;
  replyTo: unknown;
  clientMessageId?: string | null;
  callerAppId?: string | null;
}

export interface ThreadReplyAppendResult extends ThreadAppendResult {
  replyTo: { id: number; seq: number };
}

function requireReplyParent(
  db: SqliteDatabase,
  handoffId: string,
  replyTo: unknown,
): HandoffMessage {
  if (replyTo === undefined || replyTo === null) {
    throw new ThreadError("reply_to_required", "reply_to is required for a thread reply");
  }
  if (typeof replyTo !== "number" || !Number.isInteger(replyTo) || replyTo <= 0) {
    throw new ThreadError("invalid_reply_to", "reply_to must be a positive message id");
  }
  const row = db
    .prepare(
      `SELECT id FROM handoff_messages
       WHERE id = ? AND handoff_id = ? AND author_side = 'source'
         AND kind IN ('request','message') AND state IN ('dispatching','delivered')`,
    )
    .get(replyTo, handoffId) as { id: number } | undefined;
  if (row === undefined) {
    throw new ThreadError(
      "invalid_reply_to",
      "reply_to must reference a dispatching or delivered source message in the same thread",
    );
  }
  const message = getHandoffMessage(db, row.id);
  if (message === undefined) {
    throw new ThreadError("invalid_reply_to", "reply_to message was not found");
  }
  return message;
}

function findExistingReply(
  db: SqliteDatabase,
  handoffId: string,
  replyTo: number,
): HandoffMessage | undefined {
  const row = db
    .prepare(
      `SELECT id FROM handoff_messages
       WHERE handoff_id = ? AND kind = 'reply' AND reply_to_message_id = ? AND state <> 'cancelled'
       ORDER BY id LIMIT 1`,
    )
    .get(handoffId, replyTo) as { id: number } | undefined;
  return row === undefined ? undefined : getHandoffMessage(db, row.id);
}

export function appendThreadReply(
  db: SqliteDatabase,
  input: AppendThreadReplyInput,
  limits: ThreadLimits = DEFAULT_THREAD_LIMITS,
): ThreadReplyAppendResult {
  const handoffForAttempt = getHandoff(db, input.handoffId);
  const attemptAppId = input.callerAppId ?? handoffForAttempt?.toAppId;
  try {
    const result = appendThreadReplyInternal(db, input, limits);
    if (attemptAppId !== undefined && attemptAppId !== null) {
      recordThreadAttempt(db, attemptAppId, "deliver_handoff", "ok");
    }
    return result;
  } catch (error) {
    if (attemptAppId !== undefined && attemptAppId !== null) {
      recordThreadAttempt(db, attemptAppId, "deliver_handoff", "failure");
    }
    throw error;
  }
}

function appendThreadReplyInternal(
  db: SqliteDatabase,
  input: AppendThreadReplyInput,
  limits: ThreadLimits,
): ThreadReplyAppendResult {
  const run = db.transaction((): ThreadReplyAppendResult => {
    const handoff = appendableThread(db, input.handoffId);
    if (input.callerAppId !== undefined && input.callerAppId !== null) {
      if (input.callerAppId !== handoff.toAppId) {
        throw new ThreadError("wrong_side", "only the target application may reply");
      }
    }
    const parent = requireReplyParent(db, handoff.id, input.replyTo);
    const clientMessageId = normalizeClientMessageId(input.clientMessageId);
    const byClientId = findMessageByClientId(db, handoff.id, "target", clientMessageId);
    if (byClientId !== undefined) {
      if (byClientId.body !== input.body || byClientId.replyToMessageId !== parent.id) {
        throw new ThreadError(
          "idempotency_conflict",
          "client_message_id was already used with different content",
        );
      }
      return {
        handoff,
        message: byClientId,
        replyTo: { id: parent.id, seq: parent.seq },
      };
    }
    const existingReply = findExistingReply(db, handoff.id, parent.id);
    if (existingReply !== undefined) {
      return {
        handoff,
        message: existingReply,
        replyTo: { id: parent.id, seq: parent.seq },
      };
    }
    const now = new Date().toISOString();
    assertThreadQuotas(db, limits, {
      targetAppId: handoff.toAppId,
      authorAppId: handoff.toAppId,
      now,
    });
    assertThreadFull(handoff, limits);
    validateThreadBody(input.body, limits);
    const deliverySessionId = requireDestinationSession(handoff, "source");
    const bump = bumpOrThrow(db, handoff, now, limits);
    const message = insertHandoffMessage(db, {
      handoffId: handoff.id,
      seq: bump.messageSeq,
      kind: "reply",
      body: input.body,
      authorSide: "target",
      authorAppId: handoff.toAppId,
      state: "binding",
      outcome: input.outcome,
      deliverySessionId,
      replyToMessageId: parent.id,
      clientMessageId,
      bindingNonce: `n_${randomUUID()}`,
      createdAt: now,
    });
    const updated = getHandoff(db, handoff.id);
    if (updated === undefined) {
      throw new Error(`Thread not found after reply append: ${handoff.id}`);
    }
    return { handoff: updated, message, replyTo: { id: parent.id, seq: parent.seq } };
  });
  return run.immediate();
}

/** Expire idle in-progress threads unless an in-flight dispatch still exists. */
export function expireIdleThreads(
  db: SqliteDatabase,
  now: string = new Date().toISOString(),
): number {
  const rows = db
    .prepare(
      `SELECT id FROM handoffs h
       WHERE mode = 'thread' AND state = 'in_progress'
         AND thread_idle_expires_at IS NOT NULL AND thread_idle_expires_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM handoff_messages m
           WHERE m.handoff_id = h.id AND m.state = 'dispatching')
       ORDER BY id LIMIT 20`,
    )
    .all(now) as { id: string }[];
  let expired = 0;
  for (const row of rows) {
    const run = db.transaction(() => {
      const updated = db
        .prepare(
          `UPDATE handoffs SET state = 'expired', updated_at = ?
           WHERE id = ? AND mode = 'thread' AND state = 'in_progress'
             AND NOT EXISTS (
               SELECT 1 FROM handoff_messages m
               WHERE m.handoff_id = handoffs.id AND m.state = 'dispatching')`,
        )
        .run(now, row.id);
      if (updated.changes === 0) return false;
      db.prepare(
        `UPDATE handoff_messages
         SET state = 'cancelled', error_code = 'thread_expired', updated_at = ?
         WHERE handoff_id = ? AND state IN ('binding','queued','waiting_operator')`,
      ).run(now, row.id);
      return true;
    });
    if (run.immediate()) expired += 1;
  }
  return expired;
}

/** Human-only operator cancel: CAS the header and cancel every non-terminal message. */
export function cancelThread(db: SqliteDatabase, handoffId: string): Handoff {
  const handoff = requireThreadHeader(db, handoffId);
  assertThreadMode(handoff);
  if (isTerminalHandoffState(handoff.state)) {
    throw new ThreadError("thread_terminal", `Thread ${handoffId} is already closed`);
  }
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE handoffs SET state = 'cancelled', updated_at = ?
         WHERE id = ? AND mode = 'thread'
           AND state NOT IN ('delivered','rejected','failed','expired','cancelled')`,
      )
      .run(now, handoffId);
    if (updated.changes === 0) return false;
    db.prepare(
      `UPDATE handoff_messages
       SET state = 'cancelled', error_code = 'operator_cancel', updated_at = ?
       WHERE handoff_id = ? AND state IN ('binding','queued','dispatching','waiting_operator')`,
    ).run(now, handoffId);
    db.prepare(
      `UPDATE approvals SET state = 'expired', decided_at = ?
       WHERE handoff_id = ? AND state = 'pending'`,
    ).run(now, handoffId);
    return true;
  });
  if (!run.immediate()) {
    const current = getHandoff(db, handoffId);
    throw new ThreadError(
      "thread_terminal",
      `Thread ${handoffId} is already closed (state: ${current?.state ?? "missing"})`,
    );
  }
  return requireThreadHeader(db, handoffId);
}

/** Delete terminal thread headers older than retention, cascading their messages. */
export function gcTerminalThreads(
  db: SqliteDatabase,
  limits: ThreadLimits = DEFAULT_THREAD_LIMITS,
  now: string = new Date().toISOString(),
): number {
  const cutoff = new Date(Date.parse(now) - limits.terminalRetentionMs).toISOString();
  const result = db
    .prepare(
      `DELETE FROM handoffs
       WHERE id IN (
         SELECT id FROM handoffs
         WHERE mode = 'thread'
           AND state IN ('rejected','failed','expired','cancelled')
           AND updated_at <= ?
         ORDER BY updated_at, id
         LIMIT ?
       )`,
    )
    .run(cutoff, limits.gcBatch);
  return result.changes;
}
