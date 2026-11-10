/**
 * Durable notification outbox helpers.
 *
 * The storage layer (`src/store/notifications.ts`) owns the typed rows and SQL; this module is the
 * queue-facing surface used by the notifier router and sender. Every write is a single statement or
 * a `db.transaction`, so a crash can never leave a half-written group.
 */

import type { SqliteDatabase } from "../store/database.js";

export type {
  InsertedNotificationGroup,
  NotificationChannelStateRow,
  NotificationChannelStatus,
  NotificationChunkInput,
  NotificationFormat,
  NotificationGroupInput,
  NotificationKind,
  NotificationMetaRow,
  NotificationOutboxRow,
  NotificationScope,
  NotificationState,
  NotificationWatermarkRow,
} from "../store/notifications.js";
export {
  capNotificationGroups,
  claimNextNotificationChunk,
  closeNotificationGroup,
  deleteNotificationWatermark,
  expirePendingNotifications,
  getNotificationChannelState,
  getNotificationMeta,
  getNotificationMetaRow,
  getNotificationOutboxRow,
  getNotificationWatermark,
  insertNotificationGroup,
  listNotificationGroupRows,
  markNotificationChunkDead,
  markNotificationChunkSent,
  pruneSentAndDeadNotifications,
  resetSendingNotifications,
  writeNotificationChannelState,
  writeNotificationMeta,
  writeNotificationWatermark,
} from "../store/notifications.js";

export interface RescheduleNotificationChunkOptions {
  nextAttemptAt: string;
  /** New hard-failure count; omitted keeps the row's current count (429 retries). */
  attempts?: number;
  errorCode?: string | null;
  lastError?: string | null;
  now?: string;
}

/**
 * Put a claimed `sending` chunk back into `pending` with a later attempt time.
 *
 * The payload is deliberately kept: a retry must resend the same text. `attempts` is only
 * overwritten when provided, so a 429 does not count against the hard-failure budget.
 * Returns the number of changed rows; a `sent` row is never rescheduled.
 */
export function rescheduleNotificationChunk(
  db: SqliteDatabase,
  id: string,
  options: RescheduleNotificationChunkOptions,
): number {
  const now = options.now ?? new Date().toISOString();
  return db
    .prepare(
      `UPDATE notification_outbox
       SET state = 'pending',
           next_attempt_at = :nextAttemptAt,
           attempts = COALESCE(:attempts, attempts),
           error_code = :errorCode,
           last_error = :lastError,
           updated_at = :now
       WHERE id = :id AND state <> 'sent'`,
    )
    .run({
      id,
      nextAttemptAt: options.nextAttemptAt,
      attempts: options.attempts ?? null,
      errorCode: options.errorCode ?? null,
      lastError: options.lastError ?? null,
      now,
    }).changes;
}
