import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export type NotificationKind =
  | "turn_completed"
  | "question"
  | "permission"
  | "ssh_approval"
  | "handoff_approval"
  | "handoff_waiting_operator"
  | "handoff_failed"
  | "thread_message_waiting"
  | "agent_interrupted";

export type NotificationFormat = "rich" | "plain";
export type NotificationScope = "global" | "project" | "app";
export type NotificationState = "pending" | "sending" | "sent" | "dead";
export type NotificationChannelStatus = "ok" | "error";

export interface NotificationOutboxRow {
  id: string;
  groupId: string;
  chunkIndex: number;
  chunkCount: number;
  dedupeKey: string;
  kind: NotificationKind;
  format: NotificationFormat;
  scope: NotificationScope;
  projectId: string | null;
  appKey: string | null;
  appId: string | null;
  sessionId: string | null;
  payloadJson: string;
  state: NotificationState;
  attempts: number;
  nextAttemptAt: string;
  errorCode: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

interface NotificationOutboxDbRow {
  id: string;
  group_id: string;
  chunk_index: number;
  chunk_count: number;
  dedupe_key: string;
  kind: NotificationKind;
  format: NotificationFormat;
  scope: NotificationScope;
  project_id: string | null;
  app_key: string | null;
  app_id: string | null;
  session_id: string | null;
  payload_json: string;
  state: NotificationState;
  attempts: number;
  next_attempt_at: string;
  error_code: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface NotificationWatermarkRow {
  appId: string;
  sessionId: string;
  lastNotifiedMessageId: string | null;
  initializedAt: string;
  updatedAt: string;
}

interface NotificationWatermarkDbRow {
  app_id: string;
  session_id: string;
  last_notified_message_id: string | null;
  initialized_at: string;
  updated_at: string;
}

export interface NotificationMetaRow {
  key: string;
  value: string;
  updatedAt: string;
}

interface NotificationMetaDbRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface NotificationChannelStateRow {
  channel: string;
  state: NotificationChannelStatus;
  lastError: string | null;
  updatedAt: string;
}

interface NotificationChannelStateDbRow {
  channel: string;
  state: NotificationChannelStatus;
  last_error: string | null;
  updated_at: string;
}

export interface NotificationChunkInput {
  id?: string;
  chunkIndex?: number;
  dedupeKey: string;
  kind: NotificationKind;
  format?: NotificationFormat;
  scope: NotificationScope;
  projectId?: string | null;
  appKey?: string | null;
  appId?: string | null;
  sessionId?: string | null;
  payloadJson: string;
  nextAttemptAt?: string;
}

export interface NotificationGroupInput {
  groupId?: string;
  chunks: readonly NotificationChunkInput[];
  createdAt?: string;
}

export interface InsertedNotificationGroup {
  groupId: string;
  rows: NotificationOutboxRow[];
  inserted: number;
}

function rowToOutbox(row: NotificationOutboxDbRow): NotificationOutboxRow {
  return {
    id: row.id,
    groupId: row.group_id,
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    dedupeKey: row.dedupe_key,
    kind: row.kind,
    format: row.format,
    scope: row.scope,
    projectId: row.project_id,
    appKey: row.app_key,
    appId: row.app_id,
    sessionId: row.session_id,
    payloadJson: row.payload_json,
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

function rowToWatermark(row: NotificationWatermarkDbRow): NotificationWatermarkRow {
  return {
    appId: row.app_id,
    sessionId: row.session_id,
    lastNotifiedMessageId: row.last_notified_message_id,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

function rowToMeta(row: NotificationMetaDbRow): NotificationMetaRow {
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}

function rowToChannelState(row: NotificationChannelStateDbRow): NotificationChannelStateRow {
  return {
    channel: row.channel,
    state: row.state,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert every chunk of one notification group in a single transaction.
 *
 * The `(group_id, chunk_index)` unique index and the per-chunk `dedupe_key` keep a repeated
 * enqueue idempotent: an existing chunk is skipped and the returned `inserted` count reports it.
 */
export function insertNotificationGroup(
  db: SqliteDatabase,
  group: NotificationGroupInput,
): InsertedNotificationGroup {
  if (group.chunks.length === 0) {
    throw new Error("a notification group needs at least one chunk");
  }
  const groupId = group.groupId ?? randomUUID();
  const now = group.createdAt ?? new Date().toISOString();
  const chunkCount = group.chunks.length;
  const existing = db.prepare("SELECT 1 AS present FROM notification_outbox WHERE dedupe_key = ?");
  const insert = db.prepare(
    `INSERT INTO notification_outbox (
       id, group_id, chunk_index, chunk_count, dedupe_key, kind, format, scope,
       project_id, app_key, app_id, session_id, payload_json, state, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
     )`,
  );
  const run = db.transaction(() => {
    let inserted = 0;
    group.chunks.forEach((chunk, index) => {
      if (existing.get(chunk.dedupeKey) !== undefined) {
        return;
      }
      const result = insert.run(
        chunk.id ?? randomUUID(),
        groupId,
        chunk.chunkIndex ?? index,
        chunkCount,
        chunk.dedupeKey,
        chunk.kind,
        chunk.format ?? "rich",
        chunk.scope,
        chunk.projectId ?? null,
        chunk.appKey ?? null,
        chunk.appId ?? null,
        chunk.sessionId ?? null,
        chunk.payloadJson,
        chunk.nextAttemptAt ?? now,
        now,
        now,
      );
      inserted += result.changes;
    });
    return inserted;
  });
  const inserted = run();
  return { groupId, rows: listNotificationGroupRows(db, groupId), inserted };
}

export function getNotificationOutboxRow(
  db: SqliteDatabase,
  id: string,
): NotificationOutboxRow | undefined {
  const row = db.prepare("SELECT * FROM notification_outbox WHERE id = ?").get(id) as
    | NotificationOutboxDbRow
    | undefined;
  return row === undefined ? undefined : rowToOutbox(row);
}

export function listNotificationGroupRows(
  db: SqliteDatabase,
  groupId: string,
): NotificationOutboxRow[] {
  const rows = db
    .prepare("SELECT * FROM notification_outbox WHERE group_id = ? ORDER BY chunk_index")
    .all(groupId) as NotificationOutboxDbRow[];
  return rows.map(rowToOutbox);
}

/**
 * Claim the next eligible chunk atomically.
 *
 * A chunk is eligible only when every earlier chunk of its group is already `sent`; a `dead`
 * earlier chunk blocks the group until the group-dead helper closes it.
 */
export function claimNextNotificationChunk(
  db: SqliteDatabase,
  now = new Date().toISOString(),
): NotificationOutboxRow | undefined {
  const row = db
    .prepare(
      `UPDATE notification_outbox
       SET state = 'sending', updated_at = :now
       WHERE id = (
         SELECT o.id FROM notification_outbox o
         WHERE o.state = 'pending' AND o.next_attempt_at <= :now
           AND NOT EXISTS (
             SELECT 1 FROM notification_outbox p
             WHERE p.group_id = o.group_id AND p.chunk_index < o.chunk_index
               AND p.state <> 'sent'
           )
         ORDER BY o.created_at, o.group_id, o.chunk_index
         LIMIT 1
       )
       RETURNING *`,
    )
    .get({ now }) as NotificationOutboxDbRow | undefined;
  return row === undefined ? undefined : rowToOutbox(row);
}

export function markNotificationChunkSent(
  db: SqliteDatabase,
  id: string,
  now = new Date().toISOString(),
): NotificationOutboxRow | undefined {
  const row = db
    .prepare(
      `UPDATE notification_outbox
       SET state = 'sent', sent_at = :now, updated_at = :now,
           payload_json = '{}', error_code = NULL, last_error = NULL
       WHERE id = :id
       RETURNING *`,
    )
    .get({ id, now }) as NotificationOutboxDbRow | undefined;
  return row === undefined ? undefined : rowToOutbox(row);
}

function closeGroupRows(
  db: SqliteDatabase,
  groupId: string,
  errorCode: string,
  now: string,
): number {
  return db
    .prepare(
      `UPDATE notification_outbox
       SET state = 'dead', error_code = :errorCode, payload_json = '{}', updated_at = :now
       WHERE group_id = :groupId AND state NOT IN ('sent', 'dead')`,
    )
    .run({ groupId, errorCode, now }).changes;
}

/** Close every remaining non-sent chunk of a group; a `sent` chunk is never changed. */
export function closeNotificationGroup(
  db: SqliteDatabase,
  groupId: string,
  errorCode = "chunk_failed",
  now = new Date().toISOString(),
): number {
  return closeGroupRows(db, groupId, errorCode, now);
}

/**
 * Mark one chunk `dead` with its own error code and close the rest of its group with
 * `chunk_failed` in the same transaction. A `sent` chunk is never marked dead.
 */
export function markNotificationChunkDead(
  db: SqliteDatabase,
  id: string,
  errorCode: string,
  lastError: string | null = null,
  now = new Date().toISOString(),
): NotificationOutboxRow | undefined {
  const run = db.transaction(() => {
    const row = db
      .prepare(
        `UPDATE notification_outbox
         SET state = 'dead', error_code = :errorCode, last_error = :lastError,
             payload_json = '{}', updated_at = :now
         WHERE id = :id AND state <> 'sent'
         RETURNING *`,
      )
      .get({ id, errorCode, lastError, now }) as NotificationOutboxDbRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    closeGroupRows(db, row.group_id, "chunk_failed", now);
    return rowToOutbox(row);
  });
  return run();
}

/** Crash recovery: a `sending` row whose sender died becomes claimable again. */
export function resetSendingNotifications(
  db: SqliteDatabase,
  now = new Date().toISOString(),
): number {
  return db
    .prepare(
      "UPDATE notification_outbox SET state = 'pending', updated_at = ? WHERE state = 'sending'",
    )
    .run(now).changes;
}

/** Prune individual `sent`/`dead` rows older than the retention window (default 30 days). */
export function pruneSentAndDeadNotifications(
  db: SqliteDatabase,
  options: { now?: string; retentionMs?: number } = {},
): number {
  const now = options.now ?? new Date().toISOString();
  const cutoff = new Date(
    new Date(now).getTime() - (options.retentionMs ?? 30 * 24 * 60 * 60 * 1000),
  ).toISOString();
  return db
    .prepare("DELETE FROM notification_outbox WHERE state IN ('sent', 'dead') AND updated_at < ?")
    .run(cutoff).changes;
}

/**
 * Cap the outbox by whole groups (default 500).
 *
 * Groups that still have a `sending` or `sent` chunk are never deleted, and a group is never
 * partially deleted. Eligible `turn_completed` groups go first, oldest-first, then any kind.
 * Returns the number of groups removed.
 */
export function capNotificationGroups(
  db: SqliteDatabase,
  options: { maxGroups?: number } = {},
): number {
  const maxGroups = options.maxGroups ?? 500;
  const run = db.transaction(() => {
    let groups = (
      db.prepare("SELECT COUNT(DISTINCT group_id) AS count FROM notification_outbox").get() as {
        count: number;
      }
    ).count;
    let removed = 0;
    while (groups > maxGroups) {
      const candidate = db
        .prepare(
          `SELECT o.group_id AS groupId, MIN(o.created_at) AS oldest
           FROM notification_outbox o
           GROUP BY o.group_id
           HAVING SUM(CASE WHEN o.state IN ('sending', 'sent') THEN 1 ELSE 0 END) = 0
           ORDER BY
             CASE
               WHEN SUM(CASE WHEN o.kind = 'turn_completed' THEN 1 ELSE 0 END) = COUNT(*)
               THEN 0 ELSE 1
             END,
             oldest,
             o.group_id
           LIMIT 1`,
        )
        .get() as { groupId: string; oldest: string } | undefined;
      if (candidate === undefined) {
        break;
      }
      db.prepare("DELETE FROM notification_outbox WHERE group_id = ?").run(candidate.groupId);
      groups -= 1;
      removed += 1;
    }
    return removed;
  });
  return run();
}

/**
 * Expire `pending` rows older than 7 days: mark them `dead` with `error_code = "expired"`,
 * clear the payload, and close the rest of each group (never a `sent` chunk).
 */
export function expirePendingNotifications(
  db: SqliteDatabase,
  options: { now?: string; ttlMs?: number } = {},
): number {
  const now = options.now ?? new Date().toISOString();
  const cutoff = new Date(
    new Date(now).getTime() - (options.ttlMs ?? 7 * 24 * 60 * 60 * 1000),
  ).toISOString();
  const run = db.transaction(() => {
    const rows = db
      .prepare(
        "SELECT id, group_id AS groupId FROM notification_outbox WHERE state = 'pending' AND created_at < ?",
      )
      .all(cutoff) as Array<{ id: string; groupId: string }>;
    let expired = 0;
    for (const row of rows) {
      const result = db
        .prepare(
          `UPDATE notification_outbox
           SET state = 'dead', error_code = 'expired', payload_json = '{}', updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(now, row.id);
      if (result.changes === 0) {
        continue;
      }
      expired += 1;
      closeGroupRows(db, row.groupId, "chunk_failed", now);
    }
    return expired;
  });
  return run();
}

export function getNotificationWatermark(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): NotificationWatermarkRow | undefined {
  const row = db
    .prepare("SELECT * FROM notification_watermarks WHERE app_id = ? AND session_id = ?")
    .get(appId, sessionId) as NotificationWatermarkDbRow | undefined;
  return row === undefined ? undefined : rowToWatermark(row);
}

export function writeNotificationWatermark(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  lastNotifiedMessageId: string | null,
  now = new Date().toISOString(),
): NotificationWatermarkRow {
  db.prepare(
    `INSERT INTO notification_watermarks
       (app_id, session_id, last_notified_message_id, initialized_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (app_id, session_id) DO UPDATE SET
       last_notified_message_id = excluded.last_notified_message_id,
       updated_at = excluded.updated_at`,
  ).run(appId, sessionId, lastNotifiedMessageId, now, now);
  const row = getNotificationWatermark(db, appId, sessionId);
  if (row === undefined) {
    throw new Error("notification watermark write did not persist");
  }
  return row;
}

export function deleteNotificationWatermark(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): number {
  return db
    .prepare("DELETE FROM notification_watermarks WHERE app_id = ? AND session_id = ?")
    .run(appId, sessionId).changes;
}

export function getNotificationMeta(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM notification_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function getNotificationMetaRow(
  db: SqliteDatabase,
  key: string,
): NotificationMetaRow | undefined {
  const row = db.prepare("SELECT * FROM notification_meta WHERE key = ?").get(key) as
    | NotificationMetaDbRow
    | undefined;
  return row === undefined ? undefined : rowToMeta(row);
}

export function writeNotificationMeta(
  db: SqliteDatabase,
  key: string,
  value: string,
  now = new Date().toISOString(),
): NotificationMetaRow {
  db.prepare(
    `INSERT INTO notification_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
  const row = getNotificationMetaRow(db, key);
  if (row === undefined) {
    throw new Error("notification meta write did not persist");
  }
  return row;
}

export function getNotificationChannelState(
  db: SqliteDatabase,
  channel: string,
): NotificationChannelStateRow | undefined {
  const row = db
    .prepare("SELECT * FROM notification_channel_state WHERE channel = ?")
    .get(channel) as NotificationChannelStateDbRow | undefined;
  return row === undefined ? undefined : rowToChannelState(row);
}

export function writeNotificationChannelState(
  db: SqliteDatabase,
  channel: string,
  state: NotificationChannelStatus,
  lastError: string | null,
  now = new Date().toISOString(),
): NotificationChannelStateRow {
  db.prepare(
    `INSERT INTO notification_channel_state (channel, state, last_error, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (channel) DO UPDATE SET
       state = excluded.state,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(channel, state, lastError, now);
  const row = getNotificationChannelState(db, channel);
  if (row === undefined) {
    throw new Error("notification channel state write did not persist");
  }
  return row;
}
