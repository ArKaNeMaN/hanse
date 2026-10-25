import { rmSync } from "node:fs";
import path from "node:path";
import { sanitizeAppKey } from "../opencode/instance.js";
import { resolveWithinRoot } from "../runtime/app-path.js";
import type { SqliteDatabase } from "../store/index.js";

/** Server-side draft text cap (design §D8 and §6.5). */
export const MAX_DRAFT_BYTES = 32 * 1024;
/** Upstream opencode session ids are safe path segments; anything else never reaches a query. */
export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;

export type PendingState = "sending" | "unknown" | "failed";

export interface DraftRow {
  text: string;
  updatedAt: string;
}

export interface SessionStateRow {
  hasMessages: 0 | 1;
  lastActivityAt: string;
}

export interface PendingSendRow {
  id: string;
  appId: string;
  sessionId: string;
  messageID: string;
  text: string;
  attachmentsJson: string;
  state: PendingState;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingSendView {
  id: string;
  messageID: string;
  text: string;
  attachments: unknown[];
  attachmentIDs: string[];
  state: PendingState;
  updatedAt: string;
}

export interface DraftSummary {
  hasText: boolean;
  attachmentCount: number;
  emptyDraft: boolean;
  updatedAt: string | null;
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function parseAttachments(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function pendingSendView(row: PendingSendRow): PendingSendView {
  const attachments = parseAttachments(row.attachmentsJson);
  return {
    id: row.id,
    messageID: row.messageID,
    text: row.text,
    attachments,
    attachmentIDs: attachments.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const id = (item as Record<string, unknown>).id;
      return typeof id === "string" ? [id] : [];
    }),
    state: row.state,
    updatedAt: row.updatedAt,
  };
}

export function readDraft(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): DraftRow | undefined {
  return db
    .prepare(
      `SELECT text AS text, updated_at AS updatedAt
       FROM message_drafts WHERE app_id = ? AND session_id = ?`,
    )
    .get(appId, sessionId) as DraftRow | undefined;
}

export function readSessionState(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): SessionStateRow | undefined {
  return db
    .prepare(
      `SELECT has_messages AS hasMessages, last_activity_at AS lastActivityAt
       FROM session_state WHERE app_id = ? AND session_id = ?`,
    )
    .get(appId, sessionId) as SessionStateRow | undefined;
}

export function readPendingSend(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  pendingId: string,
): PendingSendRow | undefined {
  return db
    .prepare(
      `SELECT id, app_id AS appId, session_id AS sessionId, message_id AS messageID,
              text, attachments_json AS attachmentsJson, state, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM pending_sends
       WHERE app_id = ? AND session_id = ? AND id = ?`,
    )
    .get(appId, sessionId, pendingId) as PendingSendRow | undefined;
}

export function readPendingByMessage(
  db: SqliteDatabase,
  appId: string,
  messageID: string,
): PendingSendRow | undefined {
  return db
    .prepare(
      `SELECT id, app_id AS appId, session_id AS sessionId, message_id AS messageID,
              text, attachments_json AS attachmentsJson, state, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM pending_sends WHERE app_id = ? AND message_id = ?`,
    )
    .get(appId, messageID) as PendingSendRow | undefined;
}

export function readPendingSends(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): PendingSendRow[] {
  return db
    .prepare(
      `SELECT id, app_id AS appId, session_id AS sessionId, message_id AS messageID,
              text, attachments_json AS attachmentsJson, state, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM pending_sends
       WHERE app_id = ? AND session_id = ?
       ORDER BY created_at, id`,
    )
    .all(appId, sessionId) as PendingSendRow[];
}

export function readPendingForApp(db: SqliteDatabase, appId: string): PendingSendRow[] {
  return db
    .prepare(
      `SELECT id, app_id AS appId, session_id AS sessionId, message_id AS messageID,
              text, attachments_json AS attachmentsJson, state, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM pending_sends WHERE app_id = ? ORDER BY created_at, id`,
    )
    .all(appId) as PendingSendRow[];
}

export function countPendingSends(db: SqliteDatabase, appId: string, sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM pending_sends WHERE app_id = ? AND session_id = ?")
    .get(appId, sessionId) as { count: number };
  return row.count;
}

export function writeDraft(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  text: string,
  now: string,
): void {
  if (text.length === 0) {
    deleteDraft(db, appId, sessionId);
    return;
  }
  db.prepare(
    `INSERT INTO message_drafts (app_id, session_id, text, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, session_id) DO UPDATE SET
       text = excluded.text,
       updated_at = excluded.updated_at`,
  ).run(appId, sessionId, text, now);
}

export function deleteDraft(db: SqliteDatabase, appId: string, sessionId: string): void {
  db.prepare("DELETE FROM message_drafts WHERE app_id = ? AND session_id = ?").run(
    appId,
    sessionId,
  );
}

/** Conditional last-activity bump: never creates a state row (GET/touch on a stopped app). */
export function bumpLastActivity(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  now: string,
): void {
  db.prepare(
    `UPDATE session_state SET last_activity_at = ?, updated_at = ?
     WHERE app_id = ? AND session_id = ?`,
  ).run(now, now, appId, sessionId);
}

/**
 * Ensure a state row for a reachable session: insert `has_messages=1` only when the row is missing
 * (a pre-existing upstream session), and otherwise only refresh activity. Never promotes an
 * existing Hanse-created `has_messages=0` row, so a first draft stays sweepable.
 */
export function ensureSessionState(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO session_state
       (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(app_id, session_id) DO UPDATE SET
       last_activity_at = excluded.last_activity_at,
       updated_at = excluded.updated_at`,
  ).run(appId, sessionId, now, now, now);
}

/**
 * Promote a known session to `has_messages=1` (confirmation/blocking send) and refresh activity.
 * Creates the row for a pre-existing upstream session that had no state row.
 */
export function upsertSessionState(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  hasMessages: 0 | 1,
  now: string,
): void {
  db.prepare(
    `INSERT INTO session_state
       (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id, session_id) DO UPDATE SET
       has_messages = CASE WHEN excluded.has_messages = 1 THEN 1 ELSE session_state.has_messages END,
       last_activity_at = excluded.last_activity_at,
       updated_at = excluded.updated_at`,
  ).run(appId, sessionId, hasMessages, now, now, now);
}

export function insertEmptySessionState(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  now: string,
): void {
  db.prepare(
    `INSERT INTO session_state
       (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(app_id, session_id) DO NOTHING`,
  ).run(appId, sessionId, now, now, now);
}

/**
 * Insert the durable pending row and remove the draft in one SQLite transaction.
 *
 * Callers hold {@link sessionLocks} for the session, so a concurrent draft write cannot resurrect
 * already-dispatched text between the two statements.
 */
export function insertPendingAndClearDraft(
  db: SqliteDatabase,
  input: {
    id: string;
    appId: string;
    sessionId: string;
    messageID: string;
    text: string;
    now: string;
    attachmentsJson?: string;
    deliveries?: Array<{ id: string; attachmentId: string; partId?: string | null }>;
    deletePendingId?: string;
    failMessageId?: string;
  },
): void {
  const run = db.transaction(() => {
    if (input.failMessageId !== undefined) {
      db.prepare(
        `UPDATE attachment_deliveries
            SET state = 'failed', error_code = 'retry_superseded', updated_at = ?
          WHERE app_id = ? AND session_id = ? AND message_id = ?
            AND state IN ('sending', 'unknown')`,
      ).run(input.now, input.appId, input.sessionId, input.failMessageId);
    }
    if (input.deletePendingId !== undefined) {
      db.prepare("DELETE FROM pending_sends WHERE id = ?").run(input.deletePendingId);
    }
    db.prepare(
      `INSERT INTO pending_sends
         (id, app_id, session_id, message_id, text, attachments_json, state, error_code,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sending', NULL, ?, ?)`,
    ).run(
      input.id,
      input.appId,
      input.sessionId,
      input.messageID,
      input.text,
      input.attachmentsJson ?? "[]",
      input.now,
      input.now,
    );
    for (const delivery of input.deliveries ?? []) {
      db.prepare(
        `INSERT INTO attachment_deliveries
           (id, attachment_id, app_id, session_id, part_id, message_id, state, error_code,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', NULL, ?, ?)`,
      ).run(
        delivery.id,
        delivery.attachmentId,
        input.appId,
        input.sessionId,
        delivery.partId ?? null,
        input.messageID,
        input.now,
        input.now,
      );
    }
    db.prepare("DELETE FROM message_drafts WHERE app_id = ? AND session_id = ?").run(
      input.appId,
      input.sessionId,
    );
    bumpLastActivity(db, input.appId, input.sessionId, input.now);
  });
  run();
}

export function insertPendingSend(
  db: SqliteDatabase,
  input: {
    id: string;
    appId: string;
    sessionId: string;
    messageID: string;
    text: string;
    now: string;
    attachmentsJson?: string;
    deliveries?: Array<{ id: string; attachmentId: string; partId?: string | null }>;
    deletePendingId?: string;
    failMessageId?: string;
  },
): void {
  const run = db.transaction(() => {
    if (input.failMessageId !== undefined) {
      db.prepare(
        `UPDATE attachment_deliveries
            SET state = 'failed', error_code = 'retry_superseded', updated_at = ?
          WHERE app_id = ? AND session_id = ? AND message_id = ?
            AND state IN ('sending', 'unknown')`,
      ).run(input.now, input.appId, input.sessionId, input.failMessageId);
    }
    if (input.deletePendingId !== undefined) {
      db.prepare("DELETE FROM pending_sends WHERE id = ?").run(input.deletePendingId);
    }
    db.prepare(
      `INSERT INTO pending_sends
         (id, app_id, session_id, message_id, text, attachments_json, state, error_code,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'sending', NULL, ?, ?)`,
    ).run(
      input.id,
      input.appId,
      input.sessionId,
      input.messageID,
      input.text,
      input.attachmentsJson ?? "[]",
      input.now,
      input.now,
    );
    for (const delivery of input.deliveries ?? []) {
      db.prepare(
        `INSERT INTO attachment_deliveries
           (id, attachment_id, app_id, session_id, part_id, message_id, state, error_code,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', NULL, ?, ?)`,
      ).run(
        delivery.id,
        delivery.attachmentId,
        input.appId,
        input.sessionId,
        delivery.partId ?? null,
        input.messageID,
        input.now,
        input.now,
      );
    }
    bumpLastActivity(db, input.appId, input.sessionId, input.now);
  });
  run();
}

export function setPendingState(
  db: SqliteDatabase,
  pendingId: string,
  state: PendingState,
  errorCode: string | null,
  now: string,
): void {
  db.prepare(`UPDATE pending_sends SET state = ?, error_code = ?, updated_at = ? WHERE id = ?`).run(
    state,
    errorCode,
    now,
    pendingId,
  );
}

export function deletePending(db: SqliteDatabase, pendingId: string): void {
  db.prepare("DELETE FROM pending_sends WHERE id = ?").run(pendingId);
}

/**
 * Confirmation: remove the pending row for the observed user message and mark the session active.
 * Scoped by app/session/message so a late event for another session cannot clear a different row.
 */
export function confirmPendingByMessage(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  messageID: string,
  now: string,
): boolean {
  let changed = false;
  const run = db.transaction(() => {
    const result = db
      .prepare("DELETE FROM pending_sends WHERE app_id = ? AND session_id = ? AND message_id = ?")
      .run(appId, sessionId, messageID);
    changed = result.changes > 0;
    db.prepare(
      `UPDATE attachment_deliveries
          SET state = 'sent', error_code = NULL, updated_at = ?
        WHERE app_id = ? AND session_id = ? AND message_id = ?`,
    ).run(now, appId, sessionId, messageID);
    db.prepare(
      `INSERT INTO session_state
         (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(app_id, session_id) DO UPDATE SET
         has_messages = 1,
         last_activity_at = excluded.last_activity_at,
         updated_at = excluded.updated_at`,
    ).run(appId, sessionId, now, now, now);
  });
  run();
  return changed;
}

/** Any user message observed for a known session clears its Draft label (design §D6.5). */
export function markSessionHasMessages(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  now: string,
): void {
  db.prepare(
    `UPDATE session_state SET has_messages = 1, last_activity_at = ?, updated_at = ?
     WHERE app_id = ? AND session_id = ?`,
  ).run(now, now, appId, sessionId);
}

export type LocalBlockReason = "has_messages" | "has_draft" | "pending" | "uploading" | "in_flight";

/** Shared lifecycle predicate for delete-if-empty and the sweep (fails closed). */
export function localSessionBlockReason(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): LocalBlockReason | undefined {
  const state = readSessionState(db, appId, sessionId);
  if (state !== undefined && state.hasMessages === 1) return "has_messages";
  if (readDraft(db, appId, sessionId) !== undefined) return "has_draft";
  const uploading = db
    .prepare(
      "SELECT 1 AS present FROM app_attachments WHERE app_id = ? AND session_id = ? AND state = 'uploading' LIMIT 1",
    )
    .get(appId, sessionId) as { present: number } | undefined;
  if (uploading !== undefined) return "uploading";
  const inFlight = db
    .prepare(
      `SELECT 1 AS present FROM attachment_deliveries
        WHERE app_id = ? AND session_id = ? AND state IN ('sending', 'unknown') LIMIT 1`,
    )
    .get(appId, sessionId) as { present: number } | undefined;
  if (inFlight !== undefined) return "in_flight";
  const draftAttachment = db
    .prepare(
      `SELECT 1 AS present FROM app_attachments a
        WHERE a.app_id = ? AND a.session_id = ? AND a.state = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM attachment_deliveries d
             WHERE d.attachment_id = a.id AND d.state IN ('sent', 'sending', 'unknown')
          )
        LIMIT 1`,
    )
    .get(appId, sessionId) as { present: number } | undefined;
  if (draftAttachment !== undefined) return "has_draft";
  if (countPendingSends(db, appId, sessionId) > 0) return "pending";
  return undefined;
}

/**
 * Session-scoped state cleanup used by manual delete, delete-if-empty, retry-on-vanished-session,
 * and the sweep. Attachment files are removed by the caller via the session folder.
 */
export function deleteSessionChatRows(db: SqliteDatabase, appId: string, sessionId: string): void {
  const run = db.transaction(() => {
    db.prepare("DELETE FROM attachment_deliveries WHERE app_id = ? AND session_id = ?").run(
      appId,
      sessionId,
    );
    db.prepare("DELETE FROM app_attachments WHERE app_id = ? AND session_id = ?").run(
      appId,
      sessionId,
    );
    db.prepare("DELETE FROM pending_sends WHERE app_id = ? AND session_id = ?").run(
      appId,
      sessionId,
    );
    db.prepare("DELETE FROM message_drafts WHERE app_id = ? AND session_id = ?").run(
      appId,
      sessionId,
    );
    db.prepare("DELETE FROM session_state WHERE app_id = ? AND session_id = ?").run(
      appId,
      sessionId,
    );
  });
  run();
}

/**
 * Per-session folders live under the app's agents root. The session id is validated before this
 * call and containment is re-checked so a stale/foreign id can never escape the app root.
 */
export function sessionFolder(
  agentsHome: string | undefined,
  projectId: string,
  appKey: string,
  sessionId: string,
): string | undefined {
  if (agentsHome === undefined || !isSessionId(sessionId)) {
    return undefined;
  }
  const appRoot = path.join(agentsHome, sanitizeAppKey(projectId), sanitizeAppKey(appKey));
  try {
    return resolveWithinRoot({
      target: path.join(appRoot, "attachments", sessionId),
      root: appRoot,
      label: "session folder",
    });
  } catch {
    return undefined;
  }
}

/** Best-effort folder removal; a filesystem failure is logged by the caller and repaired later. */
export function removeSessionFolder(folder: string | undefined): void {
  if (folder === undefined) {
    return;
  }
  try {
    rmSync(folder, { recursive: true, force: true });
  } catch {
    // The orphan sweep repairs leftovers; a failed removal must not undo a successful DB/upstream
    // delete.
  }
}

/** Batch draft/state summaries for GET /sessions (chunked to stay under SQLite's bind limit). */
export function draftSummaries(
  db: SqliteDatabase,
  appId: string,
  sessionIds: string[],
): Map<string, DraftSummary> {
  const summaries = new Map<string, DraftSummary>();
  const chunkSize = 400;
  const drafts = new Map<string, DraftRow>();
  const states = new Map<string, SessionStateRow>();
  for (let offset = 0; offset < sessionIds.length; offset += chunkSize) {
    const chunk = sessionIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const draftRows = db
      .prepare(
        `SELECT session_id AS sessionId, text AS text, updated_at AS updatedAt
         FROM message_drafts WHERE app_id = ? AND session_id IN (${placeholders})`,
      )
      .all(appId, ...chunk) as Array<DraftRow & { sessionId: string }>;
    for (const row of draftRows) {
      drafts.set(row.sessionId, { text: row.text, updatedAt: row.updatedAt });
    }
    const stateRows = db
      .prepare(
        `SELECT session_id AS sessionId, has_messages AS hasMessages,
                last_activity_at AS lastActivityAt
         FROM session_state WHERE app_id = ? AND session_id IN (${placeholders})`,
      )
      .all(appId, ...chunk) as Array<SessionStateRow & { sessionId: string }>;
    for (const row of stateRows) {
      states.set(row.sessionId, {
        hasMessages: row.hasMessages,
        lastActivityAt: row.lastActivityAt,
      });
    }
  }
  const attachmentCounts = new Map<string, number>();
  for (let offset = 0; offset < sessionIds.length; offset += chunkSize) {
    const chunk = sessionIds.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT a.session_id AS sessionId, COUNT(*) AS count
           FROM app_attachments a
          WHERE a.app_id = ? AND a.session_id IN (${placeholders}) AND a.state = 'available'
            AND NOT EXISTS (
              SELECT 1 FROM attachment_deliveries d
               WHERE d.attachment_id = a.id AND d.state IN ('sent', 'sending', 'unknown')
            )
          GROUP BY a.session_id`,
      )
      .all(appId, ...chunk) as Array<{ sessionId: string; count: number }>;
    for (const row of rows) attachmentCounts.set(row.sessionId, row.count);
  }
  for (const sessionId of sessionIds) {
    const draft = drafts.get(sessionId);
    summaries.set(sessionId, {
      hasText: (draft?.text.trim().length ?? 0) > 0,
      attachmentCount: attachmentCounts.get(sessionId) ?? 0,
      emptyDraft: draft !== undefined && (states.get(sessionId)?.hasMessages ?? 1) === 0,
      updatedAt: draft?.updatedAt ?? null,
    });
  }
  return summaries;
}
