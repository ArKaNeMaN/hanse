import type { SqliteDatabase } from "./database.js";

/** Coarse process state; the legacy `failed` value is normalized to `error`. */
export type ProcessState = "starting" | "running" | "stopped" | "error";

/** Phase within the current attempt (design §6). */
export type ProcessPhase =
  | "requested"
  | "preparing"
  | "creating"
  | "waiting_ready"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"
  | "interrupted";

/** Who caused a process transition. */
export type ProcessSource = "operator" | "runtime" | "reconciler" | "system";

/** One append-only process transition. */
export interface ProcessEvent {
  id: number;
  attemptId: string;
  seq: number;
  state: ProcessState;
  phase: ProcessPhase | null;
  source: ProcessSource;
  reason: string | null;
  errorCode: string | null;
  message: string | null;
  createdAt: string;
}

/** Current process fields for one application. */
export interface ProcessCurrent {
  state: ProcessState;
  phase: ProcessPhase | null;
  attemptId: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  error: {
    code: string | null;
    message: string | null;
    at: string | null;
  } | null;
}

export interface ProcessEventPageOptions {
  /** Page size, 1..100 (default 50). */
  limit?: number;
  /** Return events with `id` strictly lower than this positive id. */
  before?: number;
}

export interface ProcessEventPage {
  events: ProcessEvent[];
  /** Last returned event id, or null for an empty page. */
  nextCursor: number | null;
}

export const PROCESS_EVENT_LIMIT_PER_APP = 1_000;

const PROCESS_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PROCESS_EVENT_PRUNE_BATCH = 500;
const DEFAULT_EVENT_PAGE_LIMIT = 50;
const MAX_EVENT_PAGE_LIMIT = 100;

interface CurrentRow {
  state: string | null;
  phase: string | null;
  attemptId: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorAt: string | null;
}

interface EventRow {
  id: number;
  attemptId: string;
  seq: number;
  state: string;
  phase: string | null;
  source: string;
  reason: string | null;
  errorCode: string | null;
  message: string | null;
  createdAt: string;
}

const CURRENT_COLUMNS = `
  COALESCE(runtime_state, state) AS state,
  process_phase AS phase,
  process_attempt_id AS attemptId,
  process_started_at AS startedAt,
  process_updated_at AS updatedAt,
  process_error_code AS errorCode,
  process_error_message AS errorMessage,
  process_error_at AS errorAt`;

const EVENT_COLUMNS = `
  id,
  attempt_id AS attemptId,
  seq,
  state,
  phase,
  source,
  reason,
  error_code AS errorCode,
  message,
  created_at AS createdAt`;

function normalizeProcessState(value: string | null | undefined): ProcessState {
  switch (value) {
    case "starting":
    case "running":
    case "stopped":
    case "error":
      return value;
    case "failed":
      return "error";
    default:
      return "stopped";
  }
}

function processFromRow(row: CurrentRow): ProcessCurrent {
  const error =
    row.errorCode === null && row.errorMessage === null && row.errorAt === null
      ? null
      : { code: row.errorCode, message: row.errorMessage, at: row.errorAt };
  return {
    state: normalizeProcessState(row.state),
    phase: row.phase === null ? null : (row.phase as ProcessPhase),
    attemptId: row.attemptId,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    error,
  };
}

function eventFromRow(row: EventRow): ProcessEvent {
  return {
    id: row.id,
    attemptId: row.attemptId,
    seq: row.seq,
    state: normalizeProcessState(row.state),
    phase: row.phase === null ? null : (row.phase as ProcessPhase),
    source: row.source as ProcessSource,
    reason: row.reason,
    errorCode: row.errorCode,
    message: row.message,
    createdAt: row.createdAt,
  };
}

/** Current process fields, or a stopped default when the app has no instance row. */
export function readProcess(db: SqliteDatabase, appId: string): ProcessCurrent {
  const row = db.prepare(`SELECT ${CURRENT_COLUMNS} FROM instances WHERE app_id = ?`).get(appId) as
    | CurrentRow
    | undefined;
  if (row === undefined) {
    return {
      state: "stopped",
      phase: null,
      attemptId: null,
      startedAt: null,
      updatedAt: null,
      error: null,
    };
  }
  return processFromRow(row);
}

/**
 * Current process fields plus the newest event id, read in one statement so the current row and
 * the history cursor cannot diverge.
 */
export function readProcessSnapshot(
  db: SqliteDatabase,
  appId: string,
): ProcessCurrent & { lastEventId: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(i.runtime_state, i.state) AS state,
         i.process_phase AS phase,
         i.process_attempt_id AS attemptId,
         i.process_started_at AS startedAt,
         i.process_updated_at AS updatedAt,
         i.process_error_code AS errorCode,
         i.process_error_message AS errorMessage,
         i.process_error_at AS errorAt,
         (SELECT MAX(e.id) FROM agent_run_events e WHERE e.app_id = ?) AS lastEventId
       FROM (SELECT ? AS app_id) AS target
       LEFT JOIN instances i ON i.app_id = target.app_id`,
    )
    .get(appId, appId) as (CurrentRow & { lastEventId: number | null }) | undefined;
  if (row === undefined) {
    return {
      state: "stopped",
      phase: null,
      attemptId: null,
      startedAt: null,
      updatedAt: null,
      error: null,
      lastEventId: 0,
    };
  }
  return {
    ...processFromRow(row),
    lastEventId: row.lastEventId ?? 0,
  };
}

/** Newest-first event history for one application. */
export function readProcessEvents(
  db: SqliteDatabase,
  appId: string,
  options: ProcessEventPageOptions = {},
): ProcessEventPage {
  const limit = options.limit ?? DEFAULT_EVENT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_EVENT_PAGE_LIMIT}`);
  }
  const before = options.before;
  if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
    throw new RangeError("before must be a positive integer");
  }

  const rows = (
    before === undefined
      ? db
          .prepare(
            `SELECT ${EVENT_COLUMNS} FROM agent_run_events
             WHERE app_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(appId, limit)
      : db
          .prepare(
            `SELECT ${EVENT_COLUMNS} FROM agent_run_events
             WHERE app_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
          )
          .all(appId, before, limit)
  ) as EventRow[];

  const events = rows.map(eventFromRow);
  return { events, nextCursor: events.at(-1)?.id ?? null };
}

/** Keep only the newest {@link PROCESS_EVENT_LIMIT_PER_APP} events for one application. */
export function pruneProcessEvents(db: SqliteDatabase, appId: string): number {
  let removed = 0;
  while (true) {
    const result = db
      .prepare(
        `DELETE FROM agent_run_events
         WHERE id IN (
           SELECT id FROM agent_run_events
           WHERE app_id = ?
             AND id NOT IN (
               SELECT id FROM agent_run_events
               WHERE app_id = ?
               ORDER BY id DESC
               LIMIT ?
             )
           ORDER BY id ASC
           LIMIT ?
         )`,
      )
      .run(appId, appId, PROCESS_EVENT_LIMIT_PER_APP, PROCESS_EVENT_PRUNE_BATCH);
    removed += result.changes;
    if (result.changes < PROCESS_EVENT_PRUNE_BATCH) return removed;
  }
}

/** Delete events older than 30 days for every application, in batches. */
export function pruneAllProcessEvents(db: SqliteDatabase, now: string): number {
  const cutoff = new Date(Date.parse(now) - PROCESS_EVENT_RETENTION_MS).toISOString();
  let removed = 0;
  while (true) {
    const result = db
      .prepare(
        `DELETE FROM agent_run_events
         WHERE id IN (
           SELECT id FROM agent_run_events
           WHERE created_at < ?
           ORDER BY id ASC
           LIMIT ?
         )`,
      )
      .run(cutoff, PROCESS_EVENT_PRUNE_BATCH);
    removed += result.changes;
    if (result.changes < PROCESS_EVENT_PRUNE_BATCH) return removed;
  }
}
