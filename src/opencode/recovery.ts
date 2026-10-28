import { createHash, randomUUID } from "node:crypto";
import type { RuntimeAppState, RuntimeAppStatus } from "../agent/protocol.js";
import type { Logger } from "../logging/logger.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  OpencodeHttpError,
  type OpencodeMessage,
  type OpencodeMessagePage,
  type OpencodePart,
  type OpencodeRequestOptions,
  type OpencodeSession,
  type OpencodeSessionStatus,
  type OpencodeSessionStatusMap,
} from "./client.js";
import type { HanseSessionStatus } from "./events.js";

export const SESSION_RESUME_TTL_MS = 30 * 60 * 1000;
export const SESSION_NOTICE_PAYLOAD_MAX_BYTES = 4096;
export const SESSION_NOTICE_MAX_PER_SESSION = 50;
export const SESSION_NOTICE_DEFAULT_PAGE = 30;
export const SESSION_NOTICE_MAX_PAGE = 100;

/** How long a terminal `idle`/`error` event waits before it is confirmed as a real completion. */
export const TERMINAL_CONFIRMATION_MS = 5_000;
/** A stop intent older than this, or older than the previous runtime start, is stale. */
export const STOP_INTENT_MAX_AGE_MS = 10 * 60 * 1000;
/** A server-side operator-abort tombstone is trusted for this long. */
export const ABORT_TOMBSTONE_MS = 30_000;
/** Grace before a stopped app is terminalized by startup catch-up/reconcile. */
export const STOPPED_GRACE_MS = 10_000;
/** A session parent map is cached for this long. */
export const SESSION_MAP_TTL_MS = 30_000;
/** Bounded batch sizes for startup catch-up/reconcile. */
export const RECOVERY_BATCH_LIMIT = 100;
/** Bounded message tail used for the completed-tail cutoff. */
const TAIL_MESSAGE_LIMIT = 20;
const TAIL_MESSAGE_MAX_BYTES = 512 * 1024;
const TAIL_MESSAGE_TIMEOUT_MS = 5_000;

/** A dispatched resume holds this lease until busy/retry extends it. */
export const RESUME_LEASE_MS = 2 * 60 * 1000;
/** One `prompt_async` dispatch must not block the recovery pass indefinitely. */
export const RESUME_DISPATCH_TIMEOUT_MS = 15_000;
/** Text of the single synthetic continuation prompt. Model-visible by design. */
export const RESUME_PROMPT =
  "The previous turn was interrupted because the agent process stopped and restarted.\n" +
  "Continue the same task from the existing session state. Before acting, inspect the\n" +
  "current files and tool state; do not repeat side effects that already happened.\n" +
  "If a subagent was interrupted, re-check its work or retry it as needed.\n" +
  "If you cannot determine safe progress, explain what is missing and stop.";
export const RESUME_PART_MARKER = "agent-resume";

export type SessionObservedStatus = "busy" | "retry";

export type SessionResumeState =
  | "observing"
  | "resuming"
  | "resumed"
  | "completed"
  | "failed"
  | "ambiguous"
  | "superseded"
  | "deferred"
  | "skipped_stopped"
  | "skipped_stale"
  | "skipped_missing";

export type SessionDispatchState =
  | "none"
  | "prepared"
  | "sent"
  | "ambiguous"
  | "not_sent"
  | "failed";

export type SessionNoticeKind =
  | "agent_stopped"
  | "subagent_interrupted"
  | "resume_started"
  | "resume_failed"
  | "resume_completed"
  | "resume_unavailable";

export const SESSION_NOTICE_REASONS: ReadonlySet<string> = new Set([
  "process_exit",
  "operator_restart",
  "operator_stop",
  "deletion",
  "deployment",
  "unknown_restart",
  "unknown",
  "operator_abort",
  "subagent_abort",
  "stopped",
  "stale",
  "missing",
  "ttl_expired",
  "superseded",
  "completed",
  "ambiguous",
  "resume_failed",
  "resume_unavailable",
]);

const TERMINAL_RESUME_STATES: ReadonlySet<SessionResumeState> = new Set([
  "completed",
  "failed",
  "ambiguous",
  "superseded",
  "skipped_stopped",
  "skipped_stale",
  "skipped_missing",
]);

export interface SessionResumeRow {
  appId: string;
  sessionId: string;
  parentSessionId: string | null;
  observedStatus: SessionObservedStatus;
  observedAt: string;
  lastBusySeenAt: string;
  interruptedAt: string | null;
  interruptionEpoch: string | null;
  interruptionKey: string | null;
  reason: string | null;
  runtimeStartedAt: string | null;
  runtimeRestartCount: number | null;
  resumeState: SessionResumeState;
  deferReason: string | null;
  dispatchState: SessionDispatchState;
  autoDispatchRetries: number;
  autoAttempts: number;
  lastAttemptAt: string | null;
  resumeMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBusyInput {
  appId: string;
  sessionId: string;
  status: SessionObservedStatus;
  observedAt: string;
  parentSessionId?: string | null;
  runtimeStartedAt?: string | null;
  runtimeRestartCount?: number | null;
  preserveCycle?: boolean;
}

export interface MarkSessionInterruptedInput {
  appId: string;
  sessionId: string;
  interruptedAt: string;
  interruptionEpoch: string;
  interruptionKey: string;
  reason?: string | null;
  runtimeStartedAt?: string | null;
  runtimeRestartCount?: number | null;
}

export interface SetSessionResumeStateOptions {
  at?: string;
  deferReason?: string | null;
  dispatchState?: SessionDispatchState;
  lastError?: string | null;
  lastAttemptAt?: string | null;
  resumeMessageId?: string | null;
  autoAttempts?: number;
  autoDispatchRetries?: number;
}

export interface TransitionSessionResumeOptions extends SetSessionResumeStateOptions {
  fromDispatch?: SessionDispatchState[];
  requireInterrupted?: boolean;
}

export interface PrepareResumeDispatchInput {
  appId: string;
  sessionId: string;
  messageId: string;
  at: string;
}

export interface MarkResumeSentInput {
  appId: string;
  sessionId: string;
  messageId: string;
  at: string;
}

export interface MarkResumeNotSentInput extends MarkResumeSentInput {
  error: string | null;
}

export interface ListEligibleResumeOptions {
  now?: string;
  ttlMs?: number;
  limit?: number;
}

export interface SessionNoticeView {
  id: string;
  appId: string;
  sessionId: string;
  parentSessionId?: string;
  kind: SessionNoticeKind;
  reason?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SessionNoticeInput {
  appId: string;
  sessionId: string;
  parentSessionId?: string | null;
  dedupeKey: string;
  kind: SessionNoticeKind;
  reason?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: string;
  /**
   * Upstream session existence resolved by the caller under the session lock. `false` suppresses
   * the write; omit when the store-level predicate is configured.
   */
  sessionExists?: boolean;
}

export interface ListSessionNoticesOptions {
  before?: string | null;
  limit?: number;
}

export interface SessionNoticePage {
  notices: SessionNoticeView[];
  nextCursor: string | null;
}

export interface RuntimeEpoch {
  startedAt: string | null;
  restartCount: number | null;
}

export interface RuntimeObservation extends RuntimeEpoch {
  state: RuntimeAppState;
  exitCode?: number | null;
  oomKilled?: boolean;
  finishedAt?: string | null;
  stopReason?: string | null;
  stopAt?: string | null;
}

export interface RecoveryApp {
  id: string;
}

export interface ObserveSessionStatusInput {
  sessionID: string;
  status: HanseSessionStatus | OpencodeSessionStatus | null | undefined;
  parentID?: string | null;
  epoch?: RuntimeEpoch | null;
}

export interface ProcessRecoveryDeps {
  db: SqliteDatabase;
  runtimeStatus: (appId: string) => Promise<RuntimeAppStatus | undefined>;
  endpointFor: (appId: string) => string | undefined;
  listSessionsBounded: (endpoint: string) => Promise<OpencodeSession[]>;
  listSessionStatuses: (endpoint: string) => Promise<OpencodeSessionStatusMap>;
  listMessages: (
    endpoint: string,
    sessionId: string,
    options?: { maxBytes?: number; timeoutMs?: number },
  ) => Promise<OpencodeMessage[]>;
  listMessagePage?: (
    endpoint: string,
    sessionId: string,
    options: { limit: number; before?: string; maxBytes?: number; timeoutMs?: number },
  ) => Promise<OpencodeMessagePage>;
  sendPromptAsync: (
    endpoint: string,
    sessionId: string,
    text: string,
    messageID: string,
    options?: OpencodeRequestOptions,
    model?: string,
    parts?: OpencodePart[],
  ) => Promise<void>;
  waitForReady?: (appId: string, endpoint: string) => Promise<void>;
  isRestarting: (appId: string) => boolean;
  isDeploymentLocked: () => boolean;
  now: () => number;
  logger?: Logger;
  onNotice?: (appId: string, notice: SessionNoticeView) => void;
  stoppedGraceMs?: number;
  terminalConfirmationMs?: number;
}

export type StopIntentReason = "restart" | "stop" | "delete";

interface PendingTerminal {
  appId: string;
  sessionId: string;
  epochKey: string | null;
  tailComplete: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const STOP_INTENT_REASON: Record<StopIntentReason, string> = {
  restart: "operator_restart",
  stop: "operator_stop",
  delete: "deletion",
};

export function runtimeEpochKey(epoch: RuntimeEpoch | null | undefined): string {
  if (epoch === null || epoch === undefined) return "unknown";
  return `${epoch.startedAt ?? "null"}#${epoch.restartCount ?? "null"}`;
}

export function runtimeEpochKnown(epoch: RuntimeEpoch | null | undefined): boolean {
  return (
    epoch !== null &&
    epoch !== undefined &&
    (epoch.startedAt !== null || epoch.restartCount !== null)
  );
}

/** Deterministic `msg_` + 32 lowercase hex id for one resume attempt. */
export function deterministicResumeMessageId(
  appId: string,
  sessionId: string,
  interruptionKey: string,
  attempt: number,
): string {
  const hex = createHash("sha256")
    .update(`${appId}\u0000${sessionId}\u0000${interruptionKey}\u0000${attempt}`)
    .digest("hex")
    .slice(0, 32);
  return `msg_${hex}`;
}

function epochOfStatus(status: RuntimeAppStatus | undefined): RuntimeEpoch {
  return {
    startedAt: status?.startedAt ?? null,
    restartCount: status?.restartCount ?? null,
  };
}

function isBusyStatus(
  status: HanseSessionStatus | OpencodeSessionStatus | null | undefined,
): status is { type: "busy" | "retry" } {
  return status?.type === "busy" || status?.type === "retry";
}

function roleOf(message: OpencodeMessage): "user" | "assistant" | undefined {
  return message.info.role;
}

function assistantCompleted(message: OpencodeMessage): boolean {
  const time = message.info.time;
  return (
    typeof time === "object" &&
    time !== null &&
    typeof (time as { completed?: unknown }).completed === "number"
  );
}

function messageCreatedAt(message: OpencodeMessage): number | undefined {
  const time = message.info.time;
  if (typeof time !== "object" || time === null) return undefined;
  const created = (time as { created?: unknown }).created;
  return typeof created === "number" && Number.isFinite(created) ? created : undefined;
}

function isProvablyNotSent(error: unknown): boolean {
  return error instanceof OpencodeHttpError && error.status >= 400 && error.status < 500;
}

export function sessionTailComplete(messages: OpencodeMessage[]): boolean {
  if (messages.length === 0) return false;
  let lastUser = -1;
  for (const [index, message] of messages.entries()) {
    if (roleOf(message) === "user") lastUser = index;
  }
  if (lastUser < 0 || lastUser === messages.length - 1) return false;
  let sawAssistant = false;
  for (const [index, message] of messages.entries()) {
    if (index <= lastUser) continue;
    if (roleOf(message) !== "assistant") continue;
    sawAssistant = true;
    if (message.info.finish === "tool-calls") return false;
    if (!assistantCompleted(message)) return false;
  }
  return sawAssistant;
}

export interface SessionNoticeStoreOptions {
  /** Upstream session existence check performed under the caller's session lock before a write. */
  sessionExists?: (appId: string, sessionId: string) => boolean;
}

const RESUME_COLUMNS = `app_id AS appId,
  session_id AS sessionId,
  parent_session_id AS parentSessionId,
  observed_status AS observedStatus,
  observed_at AS observedAt,
  last_busy_seen_at AS lastBusySeenAt,
  interrupted_at AS interruptedAt,
  interruption_epoch AS interruptionEpoch,
  interruption_key AS interruptionKey,
  reason AS reason,
  runtime_started_at AS runtimeStartedAt,
  runtime_restart_count AS runtimeRestartCount,
  resume_state AS resumeState,
  defer_reason AS deferReason,
  dispatch_state AS dispatchState,
  auto_dispatch_retries AS autoDispatchRetries,
  auto_attempts AS autoAttempts,
  last_attempt_at AS lastAttemptAt,
  resume_message_id AS resumeMessageId,
  last_error AS lastError,
  created_at AS createdAt,
  updated_at AS updatedAt`;

const NOTICE_COLUMNS = `id AS id,
  app_id AS appId,
  session_id AS sessionId,
  parent_session_id AS parentSessionId,
  kind AS kind,
  reason AS reason,
  payload_json AS payloadJson,
  created_at AS createdAt`;

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

function encodeNoticeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

function parseNoticeCursor(before: string): { createdAt: string; id: string | null } {
  const separator = before.indexOf("|");
  if (separator <= 0) return { createdAt: before, id: null };
  const id = before.slice(separator + 1);
  return { createdAt: before.slice(0, separator), id: id.length === 0 ? null : id };
}

function parseNoticePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function serializeNoticePayload(payload: Record<string, unknown> | undefined): string {
  const value = payload ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session notice payload must be a JSON object");
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("session notice payload is not JSON-serializable");
  }
  if (serialized === undefined) {
    throw new Error("session notice payload is not JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > SESSION_NOTICE_PAYLOAD_MAX_BYTES) {
    throw new Error(`session notice payload exceeds ${SESSION_NOTICE_PAYLOAD_MAX_BYTES} bytes`);
  }
  return serialized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validateDedupeKey(value: string): void {
  if (value.length === 0 || value.length > 256 || hasControlCharacter(value)) {
    throw new Error("invalid session notice dedupe key");
  }
}

function validateReason(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (!SESSION_NOTICE_REASONS.has(value)) {
    throw new Error(`unknown session notice reason: ${value}`);
  }
  return value;
}

function noticeView(row: {
  id: string;
  appId: string;
  sessionId: string;
  parentSessionId: string | null;
  kind: string;
  reason: string | null;
  payloadJson: string;
  createdAt: string;
}): SessionNoticeView {
  return {
    id: row.id,
    appId: row.appId,
    sessionId: row.sessionId,
    ...(row.parentSessionId === null ? {} : { parentSessionId: row.parentSessionId }),
    kind: row.kind as SessionNoticeKind,
    ...(row.reason === null ? {} : { reason: row.reason }),
    payload: parseNoticePayload(row.payloadJson),
    createdAt: row.createdAt,
  };
}

function resumeStateAssignments(
  state: SessionResumeState,
  options: SetSessionResumeStateOptions,
  at: string,
): { assignments: string[]; params: Record<string, unknown> } {
  const assignments: string[] = ["resume_state = @state", "updated_at = @at"];
  const params: Record<string, unknown> = { state, at };
  if (options.deferReason !== undefined) {
    assignments.push("defer_reason = @deferReason");
    params.deferReason = options.deferReason;
  } else if (state !== "deferred") {
    assignments.push("defer_reason = NULL");
  }
  if (options.dispatchState !== undefined) {
    assignments.push("dispatch_state = @dispatchState");
    params.dispatchState = options.dispatchState;
  }
  if (options.lastError !== undefined) {
    assignments.push("last_error = @lastError");
    params.lastError = options.lastError;
  }
  if (options.lastAttemptAt !== undefined) {
    assignments.push("last_attempt_at = @lastAttemptAt");
    params.lastAttemptAt = options.lastAttemptAt;
  }
  if (options.resumeMessageId !== undefined) {
    assignments.push("resume_message_id = @resumeMessageId");
    params.resumeMessageId = options.resumeMessageId;
  }
  if (options.autoAttempts !== undefined) {
    assignments.push("auto_attempts = @autoAttempts");
    params.autoAttempts = options.autoAttempts;
  }
  if (options.autoDispatchRetries !== undefined) {
    assignments.push("auto_dispatch_retries = @autoDispatchRetries");
    params.autoDispatchRetries = options.autoDispatchRetries;
  }
  return { assignments, params };
}

function resumeAttemptNumber(row: SessionResumeRow): number {
  return row.dispatchState === "sent" ? Math.max(row.autoAttempts, 1) : row.autoAttempts + 1;
}

function resumeInterruptionKey(row: SessionResumeRow): string {
  return row.interruptionKey ?? row.interruptionEpoch ?? "unknown";
}

export class SessionResumeStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  get(appId: string, sessionId: string): SessionResumeRow | undefined {
    return this.#db
      .prepare(`SELECT ${RESUME_COLUMNS} FROM session_resume WHERE app_id = ? AND session_id = ?`)
      .get(appId, sessionId) as SessionResumeRow | undefined;
  }

  upsertBusy(input: SessionBusyInput): SessionResumeRow {
    const run = this.#db.transaction(() => {
      const existing = this.get(input.appId, input.sessionId);
      if (existing === undefined) {
        this.#db
          .prepare(
            `INSERT INTO session_resume
               (app_id, session_id, parent_session_id, observed_status, observed_at,
                last_busy_seen_at, runtime_started_at, runtime_restart_count,
                resume_state, dispatch_state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'observing', 'none', ?, ?)`,
          )
          .run(
            input.appId,
            input.sessionId,
            input.parentSessionId ?? null,
            input.status,
            input.observedAt,
            input.observedAt,
            input.runtimeStartedAt ?? null,
            input.runtimeRestartCount ?? null,
            input.observedAt,
            input.observedAt,
          );
        return this.get(input.appId, input.sessionId) as SessionResumeRow;
      }

      const reset =
        input.preserveCycle !== true &&
        (TERMINAL_RESUME_STATES.has(existing.resumeState) || existing.interruptedAt !== null);

      if (reset) {
        this.#db
          .prepare(
            `UPDATE session_resume SET
               parent_session_id = COALESCE(?, parent_session_id),
               observed_status = ?,
               observed_at = ?,
               last_busy_seen_at = ?,
               interrupted_at = NULL,
               interruption_epoch = NULL,
               interruption_key = NULL,
               reason = NULL,
               runtime_started_at = ?,
               runtime_restart_count = ?,
               resume_state = 'observing',
               defer_reason = NULL,
               dispatch_state = 'none',
               auto_dispatch_retries = 0,
               auto_attempts = 0,
               last_attempt_at = NULL,
               resume_message_id = NULL,
               last_error = NULL,
               updated_at = ?
             WHERE app_id = ? AND session_id = ?`,
          )
          .run(
            input.parentSessionId ?? null,
            input.status,
            input.observedAt,
            input.observedAt,
            input.runtimeStartedAt ?? null,
            input.runtimeRestartCount ?? null,
            input.observedAt,
            input.appId,
            input.sessionId,
          );
        return this.get(input.appId, input.sessionId) as SessionResumeRow;
      }

      const runtimeStartedAt =
        input.runtimeStartedAt !== undefined && existing.runtimeStartedAt === null
          ? input.runtimeStartedAt
          : null;
      const runtimeRestartCount =
        input.runtimeRestartCount !== undefined && existing.runtimeRestartCount === null
          ? input.runtimeRestartCount
          : null;
      this.#db
        .prepare(
          `UPDATE session_resume SET
             parent_session_id = COALESCE(?, parent_session_id),
             observed_status = ?,
             observed_at = CASE WHEN observed_status <> ? THEN ? ELSE observed_at END,
             last_busy_seen_at = ?,
             runtime_started_at = COALESCE(?, runtime_started_at),
             runtime_restart_count = COALESCE(?, runtime_restart_count),
             updated_at = ?
           WHERE app_id = ? AND session_id = ?`,
        )
        .run(
          input.parentSessionId ?? null,
          input.status,
          input.status,
          input.observedAt,
          input.observedAt,
          runtimeStartedAt,
          runtimeRestartCount,
          input.observedAt,
          input.appId,
          input.sessionId,
        );
      return this.get(input.appId, input.sessionId) as SessionResumeRow;
    });
    return run();
  }

  sampleBusy(input: SessionBusyInput): SessionResumeRow {
    return this.upsertBusy(input);
  }

  markInterrupted(input: MarkSessionInterruptedInput): boolean {
    const run = this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE session_resume SET
             interrupted_at = ?,
             interruption_epoch = ?,
             interruption_key = ?,
             reason = COALESCE(?, reason),
             runtime_started_at = COALESCE(?, runtime_started_at),
             runtime_restart_count = COALESCE(?, runtime_restart_count),
             updated_at = ?
           WHERE app_id = ? AND session_id = ?
             AND (interruption_key IS NULL OR interruption_key IS NOT ?)`,
        )
        .run(
          input.interruptedAt,
          input.interruptionEpoch,
          input.interruptionKey,
          input.reason ?? null,
          input.runtimeStartedAt ?? null,
          input.runtimeRestartCount ?? null,
          input.interruptedAt,
          input.appId,
          input.sessionId,
          input.interruptionKey,
        );
      return result.changes === 1;
    });
    return run();
  }

  setResumeState(
    appId: string,
    sessionId: string,
    state: SessionResumeState,
    options: SetSessionResumeStateOptions = {},
  ): boolean {
    const at = options.at ?? new Date().toISOString();
    const { assignments, params } = resumeStateAssignments(state, options, at);
    params.appId = appId;
    params.sessionId = sessionId;
    const result = this.#db
      .prepare(
        `UPDATE session_resume SET ${assignments.join(", ")}
         WHERE app_id = @appId AND session_id = @sessionId`,
      )
      .run(params);
    return result.changes === 1;
  }

  /**
   * Conditional state transition. Used by the resume outcome machine so a concurrent user turn or a
   * duplicate event cannot overwrite a newer cycle.
   */
  transition(
    appId: string,
    sessionId: string,
    from: SessionResumeState[],
    state: SessionResumeState,
    options: TransitionSessionResumeOptions = {},
  ): boolean {
    if (from.length === 0) return false;
    const at = options.at ?? new Date().toISOString();
    const { assignments, params } = resumeStateAssignments(state, options, at);
    params.appId = appId;
    params.sessionId = sessionId;
    const statePlaceholders = from.map((_value, index) => `@from${index}`).join(", ");
    from.forEach((value, index) => {
      params[`from${index}`] = value;
    });
    const conditions = [
      "app_id = @appId",
      "session_id = @sessionId",
      `resume_state IN (${statePlaceholders})`,
    ];
    if (options.requireInterrupted === true) conditions.push("interrupted_at IS NOT NULL");
    const fromDispatch = options.fromDispatch;
    if (fromDispatch !== undefined && fromDispatch.length > 0) {
      const placeholders = fromDispatch.map((_value, index) => `@fromDispatch${index}`).join(", ");
      fromDispatch.forEach((value, index) => {
        params[`fromDispatch${index}`] = value;
      });
      conditions.push(`dispatch_state IN (${placeholders})`);
    }
    const result = this.#db
      .prepare(
        `UPDATE session_resume SET ${assignments.join(", ")}
         WHERE ${conditions.join(" AND ")}`,
      )
      .run(params);
    return result.changes === 1;
  }

  setDeferReason(
    appId: string,
    sessionId: string,
    reason: string | null,
    at = new Date().toISOString(),
  ): boolean {
    const result =
      reason === null
        ? this.#db
            .prepare(
              `UPDATE session_resume SET
                 defer_reason = NULL,
                 resume_state = CASE WHEN resume_state = 'deferred' THEN 'observing' ELSE resume_state END,
                 updated_at = ?
               WHERE app_id = ? AND session_id = ?`,
            )
            .run(at, appId, sessionId)
        : this.#db
            .prepare(
              `UPDATE session_resume SET resume_state = 'deferred', defer_reason = ?, updated_at = ?
               WHERE app_id = ? AND session_id = ?`,
            )
            .run(reason, at, appId, sessionId);
    return result.changes === 1;
  }

  listEligible(options: ListEligibleResumeOptions = {}): SessionResumeRow[] {
    const now = options.now ?? new Date().toISOString();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new Error("invalid resume eligibility clock");
    const ttlMs = options.ttlMs ?? SESSION_RESUME_TTL_MS;
    const cutoff = new Date(nowMs - ttlMs).toISOString();
    const limit = normalizeLimit(options.limit, 100, 500);
    return this.#db
      .prepare(
        `SELECT ${RESUME_COLUMNS} FROM session_resume
          WHERE observed_status IN ('busy', 'retry')
            AND interrupted_at IS NOT NULL
            AND resume_state = 'observing'
            AND parent_session_id IS NULL
            AND auto_attempts < 1
            AND last_busy_seen_at >= ?
          ORDER BY last_busy_seen_at ASC, session_id ASC
          LIMIT ?`,
      )
      .all(cutoff, limit) as SessionResumeRow[];
  }

  listDeferred(limit = 100): SessionResumeRow[] {
    return this.#db
      .prepare(
        `SELECT ${RESUME_COLUMNS} FROM session_resume
          WHERE resume_state = 'deferred'
          ORDER BY last_busy_seen_at ASC, session_id ASC
          LIMIT ?`,
      )
      .all(normalizeLimit(limit, 100, 500)) as SessionResumeRow[];
  }

  /** Top-level interrupted cycles that have not spent their auto attempt (TTL filtered by caller). */
  listResumeCandidates(limit = RECOVERY_BATCH_LIMIT): SessionResumeRow[] {
    return this.#db
      .prepare(
        `SELECT ${RESUME_COLUMNS} FROM session_resume
          WHERE observed_status IN ('busy', 'retry')
            AND interrupted_at IS NOT NULL
            AND resume_state = 'observing'
            AND parent_session_id IS NULL
            AND auto_attempts < 1
          ORDER BY last_busy_seen_at ASC, session_id ASC
          LIMIT ?`,
      )
      .all(normalizeLimit(limit, RECOVERY_BATCH_LIMIT, 500)) as SessionResumeRow[];
  }

  /** Rows whose dispatch outcome must be resolved on startup/reconcile. */
  listReconcilable(limit = RECOVERY_BATCH_LIMIT): SessionResumeRow[] {
    return this.#db
      .prepare(
        `SELECT ${RESUME_COLUMNS} FROM session_resume
          WHERE interrupted_at IS NOT NULL
            AND parent_session_id IS NULL
            AND dispatch_state <> 'sent'
            AND (resume_state IN ('resuming', 'ambiguous')
              OR dispatch_state IN ('prepared', 'ambiguous', 'not_sent'))
          ORDER BY last_busy_seen_at ASC, session_id ASC
          LIMIT ?`,
      )
      .all(normalizeLimit(limit, RECOVERY_BATCH_LIMIT, 500)) as SessionResumeRow[];
  }

  /** Dispatched but unfinished resume outcomes; the lease anchor is `last_attempt_at`. */
  listLeaseCandidates(limit = RECOVERY_BATCH_LIMIT): SessionResumeRow[] {
    return this.#db
      .prepare(
        `SELECT ${RESUME_COLUMNS} FROM session_resume
          WHERE dispatch_state = 'sent'
            AND parent_session_id IS NULL
            AND resume_state IN ('resuming', 'resumed')
          ORDER BY last_attempt_at ASC, session_id ASC
          LIMIT ?`,
      )
      .all(normalizeLimit(limit, RECOVERY_BATCH_LIMIT, 500)) as SessionResumeRow[];
  }

  /**
   * Pre-dispatch transaction. `auto_attempts` is deliberately untouched until dispatch is confirmed
   * so a crash before the prompt is sent does not spend the cycle's one attempt.
   */
  prepareDispatch(input: PrepareResumeDispatchInput): boolean {
    const result = this.#db
      .prepare(
        `UPDATE session_resume SET
           resume_state = 'resuming',
           dispatch_state = 'prepared',
           defer_reason = NULL,
           last_attempt_at = @at,
           resume_message_id = @messageId,
           last_error = NULL,
           updated_at = @at
         WHERE app_id = @appId AND session_id = @sessionId
           AND interrupted_at IS NOT NULL
           AND auto_attempts < 1
           AND dispatch_state IN ('none', 'prepared', 'not_sent', 'ambiguous', 'failed')`,
      )
      .run(input);
    return result.changes === 1;
  }

  /**
   * Confirm one accepted dispatch and increment the visible attempt counter in the same statement.
   * Returns false for a duplicate (already `sent`) confirmation.
   */
  markSent(input: MarkResumeSentInput): boolean {
    const result = this.#db
      .prepare(
        `UPDATE session_resume SET
           dispatch_state = 'sent',
           resume_state = 'resuming',
           auto_attempts = auto_attempts + 1,
           last_attempt_at = @at,
           last_error = NULL,
           updated_at = @at
         WHERE app_id = @appId AND session_id = @sessionId
           AND dispatch_state <> 'sent'
           AND resume_message_id = @messageId
           AND auto_attempts < 1`,
      )
      .run(input);
    return result.changes === 1;
  }

  /** Record a provably-not-sent dispatch and return the new retry counter (or -1 when unchanged). */
  markNotSent(input: MarkResumeNotSentInput): number {
    const run = this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE session_resume SET
             dispatch_state = 'not_sent',
             resume_state = 'observing',
             auto_dispatch_retries = auto_dispatch_retries + 1,
             defer_reason = NULL,
             last_error = @error,
             updated_at = @at
           WHERE app_id = @appId AND session_id = @sessionId
             AND dispatch_state <> 'sent'
             AND resume_message_id = @messageId`,
        )
        .run(input);
      if (result.changes !== 1) return -1;
      const row = this.#db
        .prepare(
          "SELECT auto_dispatch_retries AS retries FROM session_resume WHERE app_id = ? AND session_id = ?",
        )
        .get(input.appId, input.sessionId) as { retries: number } | undefined;
      return row?.retries ?? -1;
    });
    return run();
  }

  extendLease(appId: string, sessionId: string, at: string): boolean {
    const result = this.#db
      .prepare(
        `UPDATE session_resume SET last_attempt_at = ?, updated_at = ?
          WHERE app_id = ? AND session_id = ?
            AND dispatch_state = 'sent'
            AND resume_state IN ('resuming', 'resumed')`,
      )
      .run(at, at, appId, sessionId);
    return result.changes === 1;
  }

  /** Rows with an unfinished busy/retry cycle that no interruption has claimed yet. */
  listActive(appId: string): SessionResumeRow[] {
    return this.#db
      .prepare(
        `SELECT ${RESUME_COLUMNS} FROM session_resume
          WHERE app_id = ? AND observed_status IN ('busy', 'retry')
            AND interrupted_at IS NULL
          ORDER BY last_busy_seen_at ASC, session_id ASC`,
      )
      .all(appId) as SessionResumeRow[];
  }

  /** Open cycles for the bounded startup/reconcile pass: unclaimed or deferred. */
  listOpenCycles(limit = RECOVERY_BATCH_LIMIT): SessionResumeRow[] {
    return this.#db
      .prepare(
        `SELECT ${RESUME_COLUMNS} FROM session_resume
          WHERE observed_status IN ('busy', 'retry')
            AND (interrupted_at IS NULL OR resume_state = 'deferred')
          ORDER BY last_busy_seen_at ASC, session_id ASC
          LIMIT ?`,
      )
      .all(normalizeLimit(limit, RECOVERY_BATCH_LIMIT, 500)) as SessionResumeRow[];
  }

  deleteSessionRows(appId: string, sessionId: string): number {
    const run = this.#db.transaction(() => {
      const result = this.#db
        .prepare("DELETE FROM session_resume WHERE app_id = ? AND session_id = ?")
        .run(appId, sessionId);
      return result.changes;
    });
    return run();
  }
}

export class SessionNoticeStore {
  readonly #db: SqliteDatabase;
  readonly #sessionExists: ((appId: string, sessionId: string) => boolean) | undefined;

  constructor(db: SqliteDatabase, options: SessionNoticeStoreOptions = {}) {
    this.#db = db;
    this.#sessionExists = options.sessionExists;
  }

  record(input: SessionNoticeInput): SessionNoticeView | undefined {
    validateDedupeKey(input.dedupeKey);
    const reason = validateReason(input.reason);
    const payloadJson = serializeNoticePayload(input.payload);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const exists =
      input.sessionExists ?? this.#sessionExists?.(input.appId, input.sessionId) ?? true;
    if (!exists) return undefined;
    const id = `notice_${randomUUID()}`;
    const run = this.#db.transaction(() => {
      const app = this.#db
        .prepare(
          `SELECT a.deleting AS appDeleting, p.deleting AS projectDeleting
             FROM apps a JOIN projects p ON p.id = a.project_id
            WHERE a.id = ?`,
        )
        .get(input.appId) as { appDeleting: number; projectDeleting: number } | undefined;
      if (app === undefined || app.appDeleting === 1 || app.projectDeleting === 1) {
        return undefined;
      }
      const dedupe = this.#db
        .prepare(
          `INSERT OR IGNORE INTO session_notice_dedupe
             (app_id, session_id, dedupe_key, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.appId, input.sessionId, input.dedupeKey, createdAt);
      if (dedupe.changes !== 1) return undefined;
      this.#db
        .prepare(
          `INSERT INTO session_notices
             (id, app_id, session_id, parent_session_id, dedupe_key, kind, reason,
              payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.appId,
          input.sessionId,
          input.parentSessionId ?? null,
          input.dedupeKey,
          input.kind,
          reason,
          payloadJson,
          createdAt,
        );
      this.#db
        .prepare(
          `DELETE FROM session_notices
            WHERE app_id = ? AND session_id = ?
              AND id NOT IN (
                SELECT id FROM session_notices
                 WHERE app_id = ? AND session_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?
              )`,
        )
        .run(
          input.appId,
          input.sessionId,
          input.appId,
          input.sessionId,
          SESSION_NOTICE_MAX_PER_SESSION,
        );
      const present = this.#db
        .prepare("SELECT 1 AS present FROM session_notices WHERE id = ?")
        .get(id) as { present: number } | undefined;
      if (present === undefined) return undefined;
      return noticeView({
        id,
        appId: input.appId,
        sessionId: input.sessionId,
        parentSessionId: input.parentSessionId ?? null,
        kind: input.kind,
        reason,
        payloadJson,
        createdAt,
      });
    });
    return run();
  }

  list(
    appId: string,
    sessionId: string,
    options: ListSessionNoticesOptions = {},
  ): SessionNoticePage {
    const limit = normalizeLimit(
      options.limit,
      SESSION_NOTICE_DEFAULT_PAGE,
      SESSION_NOTICE_MAX_PAGE,
    );
    const pageSize = limit + 1;
    let rows: Array<{
      id: string;
      appId: string;
      sessionId: string;
      parentSessionId: string | null;
      kind: string;
      reason: string | null;
      payloadJson: string;
      createdAt: string;
    }>;
    const before = options.before ?? null;
    if (before === null) {
      rows = this.#db
        .prepare(
          `SELECT ${NOTICE_COLUMNS} FROM session_notices
            WHERE app_id = ? AND session_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
        )
        .all(appId, sessionId, pageSize) as typeof rows;
    } else {
      const cursor = parseNoticeCursor(before);
      if (cursor.id === null) {
        rows = this.#db
          .prepare(
            `SELECT ${NOTICE_COLUMNS} FROM session_notices
              WHERE app_id = ? AND session_id = ? AND created_at < ?
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          )
          .all(appId, sessionId, cursor.createdAt, pageSize) as typeof rows;
      } else {
        rows = this.#db
          .prepare(
            `SELECT ${NOTICE_COLUMNS} FROM session_notices
              WHERE app_id = ? AND session_id = ?
                AND (created_at < ? OR (created_at = ? AND id < ?))
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
          )
          .all(
            appId,
            sessionId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            pageSize,
          ) as typeof rows;
      }
    }
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      notices: pageRows.map(noticeView),
      nextCursor:
        hasMore && last !== undefined ? encodeNoticeCursor(last.createdAt, last.id) : null,
    };
  }

  prune(appId: string, sessionId: string, keep = SESSION_NOTICE_MAX_PER_SESSION): number {
    const limit = Math.min(Math.max(Math.trunc(keep), 0), SESSION_NOTICE_MAX_PER_SESSION);
    const run = this.#db.transaction(() => {
      const result = this.#db
        .prepare(
          `DELETE FROM session_notices
            WHERE app_id = ? AND session_id = ?
              AND id NOT IN (
                SELECT id FROM session_notices
                 WHERE app_id = ? AND session_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?
              )`,
        )
        .run(appId, sessionId, appId, sessionId, limit);
      return result.changes;
    });
    return run();
  }

  deleteSessionRows(appId: string, sessionId: string): number {
    const run = this.#db.transaction(() => {
      const notices = this.#db
        .prepare("DELETE FROM session_notices WHERE app_id = ? AND session_id = ?")
        .run(appId, sessionId);
      const dedupe = this.#db
        .prepare("DELETE FROM session_notice_dedupe WHERE app_id = ? AND session_id = ?")
        .run(appId, sessionId);
      return notices.changes + dedupe.changes;
    });
    return run();
  }
}

/**
 * Runtime-epoch and active-turn detection for `session_resume`/`session_notices`.
 *
 * It only reads runtime/session status and writes coordinator state: it never starts an app and
 * never calls `ensure`. All timestamps come from the injected clock so tests can drive the grace
 * and confirmation windows deterministically.
 */
export class ProcessRecovery {
  readonly #deps: ProcessRecoveryDeps;
  readonly #resumes: SessionResumeStore;
  readonly #notices: SessionNoticeStore;
  readonly #pending = new Map<string, PendingTerminal>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #stoppedSince = new Map<string, number>();
  readonly #sessions = new Map<string, { at: number; value: OpencodeSession[] }>();
  readonly #tombstones = new Map<string, number>();
  readonly #resuming = new Set<string>();
  #resumeScheduled = false;

  constructor(deps: ProcessRecoveryDeps) {
    this.#deps = deps;
    this.#resumes = new SessionResumeStore(deps.db);
    this.#notices = new SessionNoticeStore(deps.db);
  }

  start(): void {
    this.#stoppedSince.clear();
  }

  stop(): void {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#stoppedSince.clear();
    this.#sessions.clear();
    this.#tombstones.clear();
    this.#resuming.clear();
    this.#resumeScheduled = false;
  }

  listActiveSessions(appId: string): SessionResumeRow[] {
    return this.#resumes.listActive(appId);
  }

  recordOperatorAbort(appId: string, sessionId: string): void {
    const now = this.#deps.now();
    for (const [key, at] of this.#tombstones) {
      if (now - at > ABORT_TOMBSTONE_MS) this.#tombstones.delete(key);
    }
    this.#tombstones.set(this.#tombstoneKey(appId, sessionId), now);
  }

  async observeSessionStatus(app: RecoveryApp, input: ObserveSessionStatusInput): Promise<void> {
    const key = this.#pendingKey(app.id, input.sessionID);
    const row = this.#resumes.get(app.id, input.sessionID);
    if (isBusyStatus(input.status)) {
      if (row !== undefined && row.parentSessionId === null) {
        const outcome = await this.#resumeBusyOutcome(row, app.id);
        if (outcome === "preserve") {
          this.#cancelPending(key);
          this.#stoppedSince.delete(key);
          const epoch = input.epoch ?? (await this.#liveEpoch(app.id));
          const parentID = await this.#parentFor(app.id, input.sessionID, input.parentID);
          this.#resumes.upsertBusy({
            appId: app.id,
            sessionId: input.sessionID,
            status: input.status.type,
            observedAt: this.#iso(),
            parentSessionId: parentID,
            runtimeStartedAt: epoch.startedAt,
            runtimeRestartCount: epoch.restartCount,
            preserveCycle: true,
          });
          return;
        }
      }
      this.#cancelPending(key);
      this.#stoppedSince.delete(key);
      const epoch = input.epoch ?? (await this.#liveEpoch(app.id));
      const parentID = await this.#parentFor(app.id, input.sessionID, input.parentID);
      this.#resumes.upsertBusy({
        appId: app.id,
        sessionId: input.sessionID,
        status: input.status.type,
        observedAt: this.#iso(),
        parentSessionId: parentID,
        runtimeStartedAt: epoch.startedAt,
        runtimeRestartCount: epoch.restartCount,
      });
      return;
    }

    const idle =
      input.status === null || input.status === undefined || input.status.type === "idle";
    if (
      row !== undefined &&
      row.parentSessionId === null &&
      idle &&
      row.dispatchState === "sent" &&
      (row.resumeState === "resuming" || row.resumeState === "resumed")
    ) {
      await this.#resumeIdleOutcome(row, app.id);
      return;
    }

    if (this.#pending.has(key)) return;
    const pendingRow = this.#resumes.get(app.id, input.sessionID);
    if (pendingRow === undefined || pendingRow.interruptedAt !== null) return;
    const tailComplete = await this.#tailComplete(app.id, input.sessionID);
    const rowEpoch: RuntimeEpoch = {
      startedAt: pendingRow.runtimeStartedAt,
      restartCount: pendingRow.runtimeRestartCount,
    };
    const epochKey = runtimeEpochKnown(rowEpoch)
      ? runtimeEpochKey(rowEpoch)
      : input.epoch !== undefined && input.epoch !== null
        ? runtimeEpochKey(input.epoch)
        : null;
    const timer = setTimeout(() => {
      void this.#confirmTerminal(app.id, input.sessionID).catch(() => undefined);
    }, this.#deps.terminalConfirmationMs ?? TERMINAL_CONFIRMATION_MS);
    timer.unref?.();
    this.#pending.set(key, {
      appId: app.id,
      sessionId: input.sessionID,
      epochKey,
      tailComplete,
      timer,
    });
  }

  async observeSessionError(
    app: RecoveryApp,
    event: { sessionID: string; name?: string; message?: string },
  ): Promise<void> {
    const row = this.#resumes.get(app.id, event.sessionID);
    if (row !== undefined && row.parentSessionId === null && !this.#isAbortError(event)) {
      await this.#failResumeOnError(app.id, row, event);
    }
    if (!this.#isAbortError(event)) return;
    const parentID = await this.#parentFor(app.id, event.sessionID, undefined);
    if (parentID === null || parentID === undefined) return;
    const epoch = await this.#liveEpoch(app.id);
    await this.handleChildAbort(app, event.sessionID, parentID, epoch);
  }

  async handleChildAbort(
    app: RecoveryApp,
    childSessionID: string,
    parentID: string,
    epoch: RuntimeEpoch,
    reason?: "operator_abort" | "subagent_abort",
  ): Promise<void> {
    const parentAlive = await this.#parentAlive(app.id, parentID);
    const resolvedReason =
      reason ??
      ((await this.#hasOperatorTombstone(app.id, childSessionID, parentID))
        ? "operator_abort"
        : "subagent_abort");
    const epochKey = runtimeEpochKey(epoch);
    const createdAt = this.#iso();
    const childNotice = this.#recordNotice(app.id, childSessionID, {
      parentSessionId: parentID,
      kind: "subagent_interrupted",
      reason: resolvedReason,
      dedupeKey: `subagent_interrupted:${epochKey}`,
      payload: { childSessionID, runtimeEpoch: epochKey },
      createdAt,
    });
    if (childNotice !== undefined) this.#emitNotice(app.id, childNotice);
    if (!parentAlive) return;
    const parentNotice = this.#recordNotice(app.id, parentID, {
      kind: "subagent_interrupted",
      reason: resolvedReason,
      dedupeKey: `subagent_interrupted:${childSessionID}:${epochKey}`,
      payload: { childSessionID, runtimeEpoch: epochKey },
      createdAt,
    });
    if (parentNotice !== undefined) this.#emitNotice(app.id, parentNotice);
  }

  async recordStopIntent(appId: string, reason: StopIntentReason): Promise<void> {
    const rows = this.#resumes.listActive(appId);
    if (rows.length === 0) return;
    const epoch = await this.#persistedEpoch(appId);
    await this.#interruptRows(appId, rows, {
      epoch,
      reason: STOP_INTENT_REASON[reason],
      writeNotice: true,
      resumeState: reason === "restart" ? undefined : "skipped_stopped",
    });
  }

  async observeRuntime(
    appId: string,
    previous: RuntimeObservation | null | undefined,
    current: RuntimeObservation,
  ): Promise<void> {
    if (previous === null || previous === undefined || previous.startedAt === null) return;
    const epochChanged = runtimeEpochKey(previous) !== runtimeEpochKey(current);
    const stateChanged = previous.state !== current.state;
    if (!epochChanged && !stateChanged) return;
    const active = this.#resumes.listActive(appId);
    if (active.length === 0) return;

    const stopped = current.state === "stopped" || current.state === "error";
    if (!epochChanged && !stopped) return;
    const fresh = this.#freshIntent(previous);
    const epoch: RuntimeEpoch = {
      startedAt: previous.startedAt,
      restartCount: previous.restartCount,
    };

    if (stopped) {
      if (fresh === null) {
        if (this.#deps.isRestarting(appId)) {
          await this.#defer(appId, active, "restart_claim", epoch);
          return;
        }
        if (this.#deps.isDeploymentLocked()) {
          await this.#defer(appId, active, "deployment_lock", epoch);
          return;
        }
      }
      const reason =
        fresh ??
        (current.exitCode === null || current.exitCode === undefined
          ? "unknown_restart"
          : "process_exit");
      await this.#interruptRows(appId, active, {
        epoch,
        reason,
        writeNotice: true,
        resumeState: fresh === "operator_restart" ? undefined : "skipped_stopped",
      });
      return;
    }

    if (fresh !== null) {
      await this.#interruptRows(appId, active, {
        epoch,
        reason: fresh,
        writeNotice: true,
        resumeState: fresh === "operator_restart" ? undefined : "skipped_stopped",
        scheduleResume: fresh === "operator_restart",
      });
      return;
    }
    if (this.#deps.isRestarting(appId)) {
      await this.#defer(appId, active, "restart_claim", epoch);
      return;
    }
    if (this.#deps.isDeploymentLocked()) {
      await this.#defer(appId, active, "deployment_lock", epoch);
      return;
    }
    await this.#interruptRows(appId, active, {
      epoch,
      reason:
        current.exitCode === null || current.exitCode === undefined
          ? "unknown_restart"
          : "process_exit",
      writeNotice: true,
      scheduleResume: true,
    });
  }

  async startupCatchUp(): Promise<void> {
    await this.#runPass("startup");
  }

  async reconcile(): Promise<void> {
    await this.#runPass("reconcile");
  }

  /** One bounded resume/reconciliation pass; also driven by the reconciler and startup catch-up. */
  async resumePass(): Promise<void> {
    await this.#resumePass();
  }

  async #runPass(mode: "startup" | "reconcile"): Promise<void> {
    const rows = this.#resumes.listOpenCycles(RECOVERY_BATCH_LIMIT);
    for (const row of rows) {
      try {
        await this.#evaluateCycle(row, mode);
      } catch (error) {
        this.#warn("recovery_pass_failed", row.appId, error);
      }
    }
    await this.#resumePass();
  }

  async #evaluateCycle(row: SessionResumeRow, mode: "startup" | "reconcile"): Promise<void> {
    if (this.#appDeleting(row.appId)) return;
    const now = this.#deps.now();
    const key = this.#pendingKey(row.appId, row.sessionId);

    if (row.resumeState === "deferred") {
      if (row.deferReason === "restart_claim" && this.#deps.isRestarting(row.appId)) return;
      if (row.deferReason === "deployment_lock" && this.#deps.isDeploymentLocked()) return;
      if (this.#ttlExpired(row, now)) {
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["deferred"],
          "skipped_stale",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "ttl_expired");
        return;
      }
      this.#resumes.setDeferReason(row.appId, row.sessionId, null, this.#iso());
      row = this.#resumes.get(row.appId, row.sessionId) ?? row;
    }

    const status = await this.#safeRuntimeStatus(row.appId);
    if (status === undefined) return;
    if (status.state === "running" || status.state === "starting") {
      this.#stoppedSince.delete(key);
      const live: RuntimeEpoch = {
        startedAt: status.startedAt ?? null,
        restartCount: status.restartCount ?? null,
      };
      const stored: RuntimeEpoch = {
        startedAt: row.runtimeStartedAt,
        restartCount: row.runtimeRestartCount,
      };
      if (
        row.interruptedAt === null &&
        runtimeEpochKnown(stored) &&
        runtimeEpochKnown(live) &&
        runtimeEpochKey(stored) !== runtimeEpochKey(live)
      ) {
        if (this.#deps.isRestarting(row.appId)) {
          await this.#defer(row.appId, [row], "restart_claim", stored);
          return;
        }
        if (this.#deps.isDeploymentLocked()) {
          await this.#defer(row.appId, [row], "deployment_lock", stored);
          return;
        }
        await this.#interruptRows(row.appId, [row], {
          epoch: stored,
          reason: "unknown_restart",
          writeNotice: true,
          scheduleResume: true,
        });
      }
      return;
    }

    if (this.#deps.isRestarting(row.appId)) {
      await this.#defer(row.appId, [row], "restart_claim", this.#rowEpoch(row));
      return;
    }
    if (this.#deps.isDeploymentLocked()) {
      await this.#defer(row.appId, [row], "deployment_lock", this.#rowEpoch(row));
      return;
    }

    const graceMs = this.#deps.stoppedGraceMs ?? STOPPED_GRACE_MS;
    const since = this.#stoppedSince.get(key);
    if (since === undefined) {
      this.#stoppedSince.set(key, now);
      if (mode === "startup" && graceMs > 0) this.#scheduleCycleRecheck(row);
      if (graceMs > 0) return;
    } else if (now - since < graceMs) {
      return;
    }

    if (row.interruptedAt !== null) {
      this.#resumes.setResumeState(row.appId, row.sessionId, "skipped_stopped", {
        at: this.#iso(),
      });
      return;
    }
    await this.#interruptRows(row.appId, [row], {
      epoch: this.#rowEpoch(row),
      reason: "unknown_restart",
      writeNotice: true,
      resumeState: "skipped_stopped",
    });
  }

  #scheduleCycleRecheck(row: SessionResumeRow): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.#evaluateCycle(row, "reconcile").catch(() => undefined);
    }, this.#deps.stoppedGraceMs ?? STOPPED_GRACE_MS);
    timer.unref?.();
    this.#timers.add(timer);
  }

  async #interruptRows(
    appId: string,
    rows: SessionResumeRow[],
    options: {
      epoch: RuntimeEpoch;
      reason: string;
      writeNotice: boolean;
      resumeState?: SessionResumeState;
      scheduleResume?: boolean;
    },
  ): Promise<void> {
    const epochKey = runtimeEpochKey(options.epoch);
    const at = this.#iso();
    for (const row of rows) {
      if (row.interruptedAt !== null && row.resumeState !== "deferred") continue;
      if (await this.#tailComplete(appId, row.sessionId)) {
        this.#cancelPending(this.#pendingKey(appId, row.sessionId));
        this.#resumes.deleteSessionRows(appId, row.sessionId);
        continue;
      }
      const cycle = row.observedAt;
      const interruptionKey = `${epochKey}|${cycle}`;
      const emitted: SessionNoticeView[] = [];
      const write = this.#deps.db.transaction(() => {
        this.#resumes.markInterrupted({
          appId,
          sessionId: row.sessionId,
          interruptedAt: at,
          interruptionEpoch: epochKey,
          interruptionKey,
          reason: options.reason,
          runtimeStartedAt: options.epoch.startedAt,
          runtimeRestartCount: options.epoch.restartCount,
        });
        if (options.writeNotice) {
          emitted.push(
            ...this.#writeInterruptionNotices(appId, row, {
              reason: options.reason,
              epochKey,
              cycle,
              createdAt: at,
            }),
          );
        }
        if (options.resumeState !== undefined) {
          this.#resumes.setResumeState(appId, row.sessionId, options.resumeState, { at });
        }
      });
      write();
      for (const notice of emitted) this.#emitNotice(appId, notice);
    }
    if (options.scheduleResume === true) this.#scheduleResumePass();
  }

  #scheduleResumePass(): void {
    if (this.#resumeScheduled) return;
    this.#resumeScheduled = true;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#resumeScheduled = false;
      void this.#resumePass().catch(() => undefined);
    }, 0);
    timer.unref?.();
    this.#timers.add(timer);
  }

  async #resumePass(): Promise<void> {
    for (const row of this.#resumes.listReconcilable(RECOVERY_BATCH_LIMIT)) {
      try {
        await this.#reconcileResume(row);
      } catch (error) {
        this.#warn("resume_reconcile_failed", row.appId, error);
      }
    }
    for (const row of this.#resumes.listResumeCandidates(RECOVERY_BATCH_LIMIT)) {
      try {
        await this.#resumeOne(row);
      } catch (error) {
        this.#warn("resume_pass_failed", row.appId, error);
      }
    }
    await this.#expireResumeLeases();
  }

  async #resumeOne(row: SessionResumeRow): Promise<void> {
    if (row.parentSessionId !== null) return;
    const key = this.#pendingKey(row.appId, row.sessionId);
    if (this.#resuming.has(key)) return;
    this.#resuming.add(key);
    try {
      const now = this.#deps.now();
      if (this.#appDeleting(row.appId)) {
        this.#resumes.setResumeState(row.appId, row.sessionId, "skipped_missing", {
          at: this.#iso(),
        });
        return;
      }
      if (this.#ttlExpired(row, now)) {
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing"],
          "skipped_stale",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "ttl_expired");
        return;
      }
      if (this.#deps.isRestarting(row.appId)) {
        this.#deferResume(row, "restart_claim");
        return;
      }
      if (this.#deps.isDeploymentLocked()) {
        this.#deferResume(row, "deployment_lock");
        return;
      }
      const status = await this.#safeRuntimeStatus(row.appId);
      if (status === undefined) return;
      if (status.state === "starting") return;
      if (status.state === "stopped" || status.state === "error") {
        const graceMs = this.#deps.stoppedGraceMs ?? STOPPED_GRACE_MS;
        const since = this.#stoppedSince.get(key);
        if (graceMs > 0 && (since === undefined || now - since < graceMs)) {
          if (since === undefined) this.#stoppedSince.set(key, now);
          return;
        }
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing"],
          "skipped_stopped",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "stopped");
        return;
      }
      if (status.state !== "running") return;
      this.#stoppedSince.delete(key);
      const endpoint = this.#deps.endpointFor(row.appId) ?? status.endpoint ?? undefined;
      if (endpoint === undefined || endpoint === null) return;
      if (!(await this.#readyForResume(row.appId, endpoint))) return;
      const sessions = await this.#sessionMap(row.appId);
      if (sessions === undefined) return;
      if (!sessions.some((session) => session.id === row.sessionId)) {
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing"],
          "skipped_missing",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "missing");
        return;
      }
      const statuses = await this.#safeSessionStatuses(endpoint);
      if (statuses !== undefined && isBusyStatus(statuses[row.sessionId])) {
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing"],
          "superseded",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "superseded");
        return;
      }
      const messages = await this.#fetchTail(row.appId, row.sessionId);
      if (messages === undefined) return;
      const tail = this.#classifyResumeTail(row, messages);
      if (tail === "completed") {
        this.#resumes.transition(row.appId, row.sessionId, ["observing"], "completed", {
          at: this.#iso(),
        });
        return;
      }
      if (tail === "newer") {
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing"],
          "superseded",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "superseded");
        return;
      }
      await this.#dispatchResume(row, endpoint);
    } finally {
      this.#resuming.delete(key);
    }
  }

  #classifyResumeTail(
    row: SessionResumeRow,
    messages: OpencodeMessage[],
  ): "completed" | "newer" | "resumable" {
    if (sessionTailComplete(messages)) return "completed";
    const last = messages.at(-1);
    if (
      last !== undefined &&
      last.info.role === "assistant" &&
      last.info.finish !== "tool-calls" &&
      assistantCompleted(last)
    ) {
      return "completed";
    }
    const cutoff = Date.parse(row.lastBusySeenAt);
    if (!Number.isFinite(cutoff)) return "resumable";
    for (const message of messages) {
      const created = messageCreatedAt(message);
      if (created === undefined || created <= cutoff) continue;
      if (message.info.role === "user") return "newer";
    }
    return "resumable";
  }

  async #dispatchResume(row: SessionResumeRow, endpoint: string): Promise<void> {
    const attempt = Math.max(row.autoAttempts, 0) + 1;
    const interruptionKey = resumeInterruptionKey(row);
    const messageId =
      row.resumeMessageId ??
      deterministicResumeMessageId(row.appId, row.sessionId, interruptionKey, attempt);
    for (;;) {
      const prepared = this.#resumes.prepareDispatch({
        appId: row.appId,
        sessionId: row.sessionId,
        messageId,
        at: this.#iso(),
      });
      if (!prepared) return;
      try {
        await this.#deps.sendPromptAsync(
          endpoint,
          row.sessionId,
          RESUME_PROMPT,
          messageId,
          { timeoutMs: RESUME_DISPATCH_TIMEOUT_MS },
          undefined,
          [
            {
              type: "text",
              text: RESUME_PROMPT,
              synthetic: true,
              metadata: { hanse: RESUME_PART_MARKER },
            },
          ],
        );
      } catch (error) {
        const bounded = this.#boundedError(error);
        if (isProvablyNotSent(error)) {
          const retries = this.#resumes.markNotSent({
            appId: row.appId,
            sessionId: row.sessionId,
            messageId,
            at: this.#iso(),
            error: bounded,
          });
          if (retries < 0) return;
          if (retries <= 1) continue;
          const changed = this.#resumes.transition(
            row.appId,
            row.sessionId,
            ["observing", "resuming", "ambiguous"],
            "failed",
            {
              at: this.#iso(),
              dispatchState: "failed",
              lastError: bounded,
              fromDispatch: ["prepared", "not_sent"],
            },
          );
          if (changed) this.#resumeFailedNotice(row, "resume_failed");
          return;
        }
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing", "resuming", "ambiguous"],
          "ambiguous",
          {
            at: this.#iso(),
            dispatchState: "ambiguous",
            lastError: bounded,
            fromDispatch: ["prepared"],
          },
        );
        if (changed) this.#resumeFailedNotice(row, "ambiguous");
        return;
      }
      const sent = this.#resumes.markSent({
        appId: row.appId,
        sessionId: row.sessionId,
        messageId,
        at: this.#iso(),
      });
      if (sent) this.#resumeStartedNotice(row, attempt, messageId);
      return;
    }
  }

  async #reconcileResume(row: SessionResumeRow): Promise<void> {
    if (row.parentSessionId !== null) return;
    const key = this.#pendingKey(row.appId, row.sessionId);
    if (this.#resuming.has(key)) return;
    this.#resuming.add(key);
    try {
      const now = this.#deps.now();
      if (this.#appDeleting(row.appId)) {
        this.#resumes.setResumeState(row.appId, row.sessionId, "skipped_missing", {
          at: this.#iso(),
        });
        return;
      }
      if (row.dispatchState === "sent" || row.autoAttempts >= 1) return;
      if (this.#ttlExpired(row, now)) {
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing", "resuming", "ambiguous"],
          "skipped_stale",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "ttl_expired");
        return;
      }
      if (this.#deps.isRestarting(row.appId)) {
        this.#deferResume(row, "restart_claim");
        return;
      }
      if (this.#deps.isDeploymentLocked()) {
        this.#deferResume(row, "deployment_lock");
        return;
      }
      const status = await this.#safeRuntimeStatus(row.appId);
      if (status === undefined) return;
      if (status.state === "starting") return;
      if (status.state === "stopped" || status.state === "error") {
        const graceMs = this.#deps.stoppedGraceMs ?? STOPPED_GRACE_MS;
        const since = this.#stoppedSince.get(key);
        if (graceMs > 0 && (since === undefined || now - since < graceMs)) {
          if (since === undefined) this.#stoppedSince.set(key, now);
          return;
        }
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing", "resuming", "ambiguous"],
          "skipped_stopped",
          { at: this.#iso() },
        );
        if (changed) this.#resumeUnavailableNotice(row, "stopped");
        return;
      }
      if (status.state !== "running") return;
      this.#stoppedSince.delete(key);
      const endpoint = this.#deps.endpointFor(row.appId) ?? status.endpoint ?? undefined;
      if (endpoint === undefined || endpoint === null) return;
      if (!(await this.#readyForResume(row.appId, endpoint))) return;
      const attempt = Math.max(row.autoAttempts, 0) + 1;
      const messageId =
        row.resumeMessageId ??
        deterministicResumeMessageId(row.appId, row.sessionId, resumeInterruptionKey(row), attempt);
      const messages = await this.#fetchTail(row.appId, row.sessionId);
      if (messages === undefined) {
        const changed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["observing", "resuming", "ambiguous"],
          "ambiguous",
          {
            at: this.#iso(),
            dispatchState: "ambiguous",
            lastError: "probe_unavailable",
            fromDispatch: ["prepared", "ambiguous", "not_sent"],
          },
        );
        if (changed) this.#resumeFailedNotice(row, "ambiguous");
        return;
      }
      if (messages.some((message) => message.info.id === messageId)) {
        const sent = this.#resumes.markSent({
          appId: row.appId,
          sessionId: row.sessionId,
          messageId,
          at: this.#iso(),
        });
        if (sent) this.#resumeStartedNotice(row, attempt, messageId);
        return;
      }
      if (row.autoDispatchRetries >= 1) {
        await this.#dispatchResume(row, endpoint);
        return;
      }
      const retries = this.#resumes.markNotSent({
        appId: row.appId,
        sessionId: row.sessionId,
        messageId,
        at: this.#iso(),
        error: "message_absent",
      });
      if (retries < 0) return;
      if (retries <= 1) {
        await this.#dispatchResume(row, endpoint);
        return;
      }
      const changed = this.#resumes.transition(
        row.appId,
        row.sessionId,
        ["observing", "resuming", "ambiguous"],
        "failed",
        {
          at: this.#iso(),
          dispatchState: "failed",
          lastError: "message_absent",
          fromDispatch: ["not_sent"],
        },
      );
      if (changed) this.#resumeFailedNotice(row, "resume_failed");
    } finally {
      this.#resuming.delete(key);
    }
  }

  async #expireResumeLeases(): Promise<void> {
    const now = this.#deps.now();
    for (const row of this.#resumes.listLeaseCandidates(RECOVERY_BATCH_LIMIT)) {
      if (this.#resuming.has(this.#pendingKey(row.appId, row.sessionId))) continue;
      const anchor = Date.parse(row.lastAttemptAt ?? row.updatedAt);
      if (!Number.isFinite(anchor) || now - anchor < RESUME_LEASE_MS) continue;
      const endpoint = this.#deps.endpointFor(row.appId);
      if (endpoint !== undefined) {
        const statuses = await this.#safeSessionStatuses(endpoint);
        if (statuses !== undefined && isBusyStatus(statuses[row.sessionId])) {
          this.#resumes.extendLease(row.appId, row.sessionId, this.#iso());
          continue;
        }
      }
      const outcome = await this.#resumeTailOutcome(row, row.appId);
      if (outcome === "newer") {
        this.#markSuperseded(row);
        continue;
      }
      if (outcome === "completed") {
        const completed = this.#resumes.transition(
          row.appId,
          row.sessionId,
          ["resuming", "resumed"],
          "completed",
          { at: this.#iso() },
        );
        if (completed) this.#resumeCompletedNotice(row);
        continue;
      }
      const changed = this.#resumes.transition(
        row.appId,
        row.sessionId,
        ["resuming", "resumed"],
        "ambiguous",
        { at: this.#iso(), lastError: "lease_expired" },
      );
      if (changed) this.#resumeFailedNotice(row, "ambiguous");
    }
  }

  async #resumeBusyOutcome(
    row: SessionResumeRow,
    appId: string,
  ): Promise<"preserve" | "superseded" | "none"> {
    if (row.parentSessionId !== null) return "none";
    const active =
      row.resumeState === "resuming" ||
      row.resumeState === "resumed" ||
      (row.resumeState === "ambiguous" && row.dispatchState === "sent");
    if (!active) return "none";
    if (row.resumeMessageId !== null) {
      const messages = await this.#fetchTail(appId, row.sessionId);
      if (
        messages !== undefined &&
        this.#hasNewerUser(messages, row.resumeMessageId, row.lastAttemptAt)
      ) {
        this.#markSuperseded(row);
        return "superseded";
      }
    }
    if (row.dispatchState === "sent") {
      const at = this.#iso();
      this.#resumes.transition(
        row.appId,
        row.sessionId,
        ["resuming", "resumed", "ambiguous"],
        "resumed",
        { at, lastAttemptAt: at, fromDispatch: ["sent"] },
      );
    }
    return "preserve";
  }

  async #resumeIdleOutcome(row: SessionResumeRow, appId: string): Promise<void> {
    if (row.parentSessionId !== null || row.dispatchState !== "sent") return;
    if (row.resumeState !== "resuming" && row.resumeState !== "resumed") return;
    const outcome = await this.#resumeTailOutcome(row, appId);
    if (outcome === "newer") {
      this.#markSuperseded(row);
      return;
    }
    if (outcome === "completed") {
      const changed = this.#resumes.transition(
        row.appId,
        row.sessionId,
        ["resuming", "resumed"],
        "completed",
        { at: this.#iso() },
      );
      if (changed) this.#resumeCompletedNotice(row);
    }
  }

  async #resumeTailOutcome(
    row: SessionResumeRow,
    appId: string,
  ): Promise<"completed" | "newer" | "pending"> {
    if (row.resumeMessageId === null) return "pending";
    const messages = await this.#fetchTail(appId, row.sessionId);
    if (messages === undefined) return "pending";
    const index = messages.findIndex((message) => message.info.id === row.resumeMessageId);
    if (index < 0) {
      // The resume prompt fell outside the bounded tail, so the whole tail is after it: any user
      // message means a newer turn, and a completed final assistant means the resumed turn finished.
      if (messages.some((message) => message.info.role === "user")) return "newer";
      const last = messages.filter((message) => message.info.role === "assistant").at(-1);
      if (last === undefined) return "pending";
      if (last.info.finish === "tool-calls") return "pending";
      return assistantCompleted(last) ? "completed" : "pending";
    }
    const after = messages.slice(index + 1);
    if (after.some((message) => message.info.role === "user")) return "newer";
    const assistants = after.filter((message) => message.info.role === "assistant");
    const last = assistants.at(-1);
    if (last === undefined) return "pending";
    if (last.info.finish === "tool-calls") return "pending";
    if (!assistantCompleted(last)) return "pending";
    return "completed";
  }

  async #failResumeOnError(
    appId: string,
    row: SessionResumeRow,
    event: { name?: string; message?: string },
  ): Promise<void> {
    if (row.dispatchState !== "sent") return;
    if (row.resumeState !== "resuming" && row.resumeState !== "resumed") return;
    if (row.resumeMessageId !== null) {
      const messages = await this.#fetchTail(appId, row.sessionId);
      if (
        messages !== undefined &&
        this.#hasNewerUser(messages, row.resumeMessageId, row.lastAttemptAt)
      ) {
        this.#markSuperseded(row);
        return;
      }
    }
    const detail = `${event.name ?? "error"}: ${event.message ?? ""}`.slice(0, 200);
    const changed = this.#resumes.transition(
      row.appId,
      row.sessionId,
      ["resuming", "resumed"],
      "failed",
      { at: this.#iso(), lastError: detail },
    );
    if (changed) this.#resumeFailedNotice(row, "resume_failed");
  }

  #markSuperseded(row: SessionResumeRow): void {
    const changed = this.#resumes.transition(
      row.appId,
      row.sessionId,
      ["observing", "resuming", "resumed", "ambiguous"],
      "superseded",
      { at: this.#iso() },
    );
    if (changed) this.#resumeUnavailableNotice(row, "superseded");
  }

  #hasNewerUser(
    messages: OpencodeMessage[],
    resumeMessageId: string,
    attemptAt: string | null,
  ): boolean {
    const index = messages.findIndex((message) => message.info.id === resumeMessageId);
    if (index >= 0) {
      return messages.slice(index + 1).some((message) => message.info.role === "user");
    }
    const cutoff = Date.parse(attemptAt ?? "");
    if (!Number.isFinite(cutoff)) return false;
    return messages.some((message) => {
      if (message.info.role !== "user" || message.info.id === resumeMessageId) return false;
      const created = messageCreatedAt(message);
      return created !== undefined && created > cutoff;
    });
  }

  #deferResume(row: SessionResumeRow, reason: string): void {
    this.#resumes.transition(
      row.appId,
      row.sessionId,
      ["observing", "resuming", "ambiguous", "deferred"],
      "deferred",
      { at: this.#iso(), deferReason: reason },
    );
  }

  async #readyForResume(appId: string, endpoint: string): Promise<boolean> {
    const waitForReady = this.#deps.waitForReady;
    if (waitForReady === undefined) return true;
    try {
      await waitForReady(appId, endpoint);
      return true;
    } catch {
      return false;
    }
  }

  #resumeStartedNotice(row: SessionResumeRow, attempt: number, messageId: string): void {
    this.#emitResumeNotice(row, "resume_started", null, attempt, {
      attempt,
      messageID: messageId,
      interruptionKey: resumeInterruptionKey(row),
    });
  }

  #resumeFailedNotice(row: SessionResumeRow, reason: string): void {
    const attempt = resumeAttemptNumber(row);
    this.#emitResumeNotice(row, "resume_failed", reason, attempt, {
      attempt,
      interruptionKey: resumeInterruptionKey(row),
    });
  }

  #resumeCompletedNotice(row: SessionResumeRow): void {
    const attempt = resumeAttemptNumber(row);
    this.#emitResumeNotice(row, "resume_completed", "completed", attempt, {
      attempt,
      interruptionKey: resumeInterruptionKey(row),
    });
  }

  #resumeUnavailableNotice(row: SessionResumeRow, reason: string): void {
    const attempt = resumeAttemptNumber(row);
    this.#emitResumeNotice(row, "resume_unavailable", reason, attempt, {
      attempt,
      interruptionKey: resumeInterruptionKey(row),
    });
  }

  #emitResumeNotice(
    row: SessionResumeRow,
    kind: SessionNoticeKind,
    reason: string | null,
    attempt: number,
    payload: Record<string, unknown>,
  ): void {
    const notice = this.#recordNotice(row.appId, row.sessionId, {
      parentSessionId: row.parentSessionId,
      kind,
      reason,
      dedupeKey: `${kind}:${resumeInterruptionKey(row)}:${attempt}${reason === null ? "" : `:${reason}`}`,
      payload,
      createdAt: this.#iso(),
    });
    if (notice !== undefined) this.#emitNotice(row.appId, notice);
  }

  #boundedError(error: unknown): string {
    return (error instanceof Error ? error.message : "unknown error").slice(0, 200);
  }

  async #fetchTail(appId: string, sessionId: string): Promise<OpencodeMessage[] | undefined> {
    const endpoint = this.#deps.endpointFor(appId);
    if (endpoint === undefined) return undefined;
    const options = {
      limit: TAIL_MESSAGE_LIMIT,
      maxBytes: TAIL_MESSAGE_MAX_BYTES,
      timeoutMs: TAIL_MESSAGE_TIMEOUT_MS,
    };
    try {
      return this.#deps.listMessagePage === undefined
        ? await this.#deps.listMessages(endpoint, sessionId, options)
        : (await this.#deps.listMessagePage(endpoint, sessionId, options)).messages;
    } catch {
      return undefined;
    }
  }

  async #safeSessionStatuses(endpoint: string): Promise<OpencodeSessionStatusMap | undefined> {
    try {
      return await this.#deps.listSessionStatuses(endpoint);
    } catch {
      return undefined;
    }
  }

  async #defer(
    appId: string,
    rows: SessionResumeRow[],
    deferReason: string,
    epoch: RuntimeEpoch,
  ): Promise<void> {
    const at = this.#iso();
    const epochKey = runtimeEpochKey(epoch);
    for (const row of rows) {
      if (row.interruptedAt === null) {
        this.#resumes.markInterrupted({
          appId,
          sessionId: row.sessionId,
          interruptedAt: at,
          interruptionEpoch: epochKey,
          interruptionKey: `${epochKey}|${row.observedAt}`,
          reason: deferReason === "deployment_lock" ? "deployment" : "unknown",
          runtimeStartedAt: epoch.startedAt,
          runtimeRestartCount: epoch.restartCount,
        });
      }
      this.#resumes.setResumeState(appId, row.sessionId, "deferred", {
        at,
        deferReason,
      });
    }
  }

  #writeInterruptionNotices(
    appId: string,
    row: SessionResumeRow,
    detail: { reason: string; epochKey: string; cycle: string; createdAt: string },
  ): SessionNoticeView[] {
    const notices: SessionNoticeView[] = [];
    const child = this.#recordNotice(appId, row.sessionId, {
      parentSessionId: row.parentSessionId,
      kind: "agent_stopped",
      reason: detail.reason,
      dedupeKey: `agent_stopped:${detail.epochKey}:${detail.cycle}`,
      payload: { runtimeEpoch: detail.epochKey, cycle: detail.cycle },
      createdAt: detail.createdAt,
    });
    if (child !== undefined) notices.push(child);
    if (row.parentSessionId === null) return notices;
    const parent = this.#recordNotice(appId, row.parentSessionId, {
      kind: "subagent_interrupted",
      reason: detail.reason,
      dedupeKey: `subagent_interrupted:${row.sessionId}:${detail.epochKey}`,
      payload: { childSessionID: row.sessionId, runtimeEpoch: detail.epochKey },
      createdAt: detail.createdAt,
    });
    if (parent !== undefined) notices.push(parent);
    return notices;
  }

  #recordNotice(
    appId: string,
    sessionId: string,
    input: Omit<SessionNoticeInput, "appId" | "sessionId" | "sessionExists">,
  ): SessionNoticeView | undefined {
    return this.#notices.record({
      appId,
      sessionId,
      sessionExists: true,
      ...input,
    });
  }

  #emitNotice(appId: string, notice: SessionNoticeView): void {
    try {
      this.#deps.onNotice?.(appId, notice);
    } catch {
      // A closed SSE listener must not affect detection.
    }
  }

  async #confirmTerminal(appId: string, sessionId: string): Promise<void> {
    const key = this.#pendingKey(appId, sessionId);
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    this.#pending.delete(key);
    const endpoint = this.#deps.endpointFor(appId);
    if (endpoint === undefined) return;
    let statuses: OpencodeSessionStatusMap;
    try {
      statuses = await this.#deps.listSessionStatuses(endpoint);
    } catch {
      return;
    }
    const status = statuses[sessionId];
    if (isBusyStatus(status)) {
      await this.observeSessionStatus({ id: appId }, { sessionID: sessionId, status });
      return;
    }
    const live = await this.#safeRuntimeStatus(appId);
    if (live === undefined) return;
    if (pending.tailComplete) {
      this.#resumes.deleteSessionRows(appId, sessionId);
      this.#stoppedSince.delete(key);
      return;
    }
    if (live.state !== "running" && live.state !== "starting") return;
    if (pending.epochKey !== null) {
      const liveKey = runtimeEpochKey({
        startedAt: live.startedAt ?? null,
        restartCount: live.restartCount ?? null,
      });
      if (liveKey !== pending.epochKey) return;
    }
  }

  #cancelPending(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(key);
  }

  async #tailComplete(appId: string, sessionId: string): Promise<boolean> {
    const messages = await this.#fetchTail(appId, sessionId);
    return messages === undefined ? false : sessionTailComplete(messages);
  }

  async #parentFor(
    appId: string,
    sessionId: string,
    provided: string | null | undefined,
  ): Promise<string | null> {
    if (provided !== undefined) return provided ?? null;
    const sessions = await this.#sessionMap(appId);
    if (sessions === undefined) return null;
    const session = sessions.find((candidate) => candidate.id === sessionId);
    return session?.parentID ?? null;
  }

  async #parentAlive(appId: string, parentID: string): Promise<boolean> {
    const sessions = await this.#sessionMap(appId);
    if (sessions === undefined) return false;
    return sessions.some((candidate) => candidate.id === parentID);
  }

  async #hasOperatorTombstone(
    appId: string,
    childSessionID: string,
    parentID: string | null,
  ): Promise<boolean> {
    const now = this.#deps.now();
    const seen = new Set<string>();
    let current: string | null = childSessionID;
    let next: string | null = parentID;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const at = this.#tombstones.get(this.#tombstoneKey(appId, current));
      if (at !== undefined && now - at <= ABORT_TOMBSTONE_MS) return true;
      current = next;
      next = current === null ? null : await this.#parentFor(appId, current, undefined);
    }
    return false;
  }

  async #sessionMap(appId: string): Promise<OpencodeSession[] | undefined> {
    const now = this.#deps.now();
    const cached = this.#sessions.get(appId);
    if (cached !== undefined && now - cached.at <= SESSION_MAP_TTL_MS) return cached.value;
    const endpoint = this.#deps.endpointFor(appId);
    if (endpoint === undefined) return undefined;
    try {
      const value = await this.#deps.listSessionsBounded(endpoint);
      this.#sessions.set(appId, { at: now, value });
      return value;
    } catch {
      return undefined;
    }
  }

  async #liveEpoch(appId: string): Promise<RuntimeEpoch> {
    const status = await this.#safeRuntimeStatus(appId);
    return epochOfStatus(status);
  }

  async #safeRuntimeStatus(appId: string): Promise<RuntimeAppStatus | undefined> {
    try {
      return await this.#deps.runtimeStatus(appId);
    } catch {
      return undefined;
    }
  }

  async #persistedEpoch(appId: string): Promise<RuntimeEpoch> {
    const status = await this.#safeRuntimeStatus(appId);
    if (status !== undefined) return epochOfStatus(status);
    const row = this.#deps.db
      .prepare(
        `SELECT runtime_started_at AS startedAt, runtime_restart_count AS restartCount
           FROM instances WHERE app_id = ?`,
      )
      .get(appId) as { startedAt: string | null; restartCount: number | null } | undefined;
    return {
      startedAt: row?.startedAt ?? null,
      restartCount: row?.restartCount ?? null,
    };
  }

  #rowEpoch(row: SessionResumeRow): RuntimeEpoch {
    return { startedAt: row.runtimeStartedAt, restartCount: row.runtimeRestartCount };
  }

  #freshIntent(previous: RuntimeObservation): string | null {
    const intent = previous.stopReason;
    if (intent !== "restart" && intent !== "stop" && intent !== "delete") return null;
    if (previous.stopAt === null || previous.stopAt === undefined) return null;
    const at = Date.parse(previous.stopAt);
    if (!Number.isFinite(at)) return null;
    if (this.#deps.now() - at > STOP_INTENT_MAX_AGE_MS) return null;
    if (previous.startedAt !== null) {
      const start = Date.parse(previous.startedAt);
      if (Number.isFinite(start) && at < start) return null;
    }
    return STOP_INTENT_REASON[intent];
  }

  #ttlExpired(row: SessionResumeRow, now: number): boolean {
    const at = Date.parse(row.lastBusySeenAt);
    return !Number.isFinite(at) || now - at >= SESSION_RESUME_TTL_MS;
  }

  #appDeleting(appId: string): boolean {
    const row = this.#deps.db
      .prepare(
        `SELECT a.deleting AS appDeleting, p.deleting AS projectDeleting
           FROM apps a JOIN projects p ON p.id = a.project_id
          WHERE a.id = ?`,
      )
      .get(appId) as { appDeleting: number; projectDeleting: number } | undefined;
    return row === undefined || row.appDeleting === 1 || row.projectDeleting === 1;
  }

  #isAbortError(event: { name?: string; message?: string }): boolean {
    if (event.name === "MessageAbortedError") return true;
    return event.message?.toLowerCase().includes("aborted") === true;
  }

  #pendingKey(appId: string, sessionId: string): string {
    return `${appId}\u0000${sessionId}`;
  }

  #tombstoneKey(appId: string, sessionId: string): string {
    return `${appId}\u0000${sessionId}`;
  }

  #iso(): string {
    return new Date(this.#deps.now()).toISOString();
  }

  #warn(message: string, appId: string, error: unknown): void {
    this.#deps.logger?.warn(message, {
      appId,
      error: (error instanceof Error ? error.message : "unknown error").slice(0, 200),
    });
  }
}
