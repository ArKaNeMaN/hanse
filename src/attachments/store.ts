import type { SqliteDatabase } from "../store/index.js";
import type {
  AttachmentKind,
  AttachmentMode,
  AttachmentRow,
  AttachmentState,
  DeliveryRow,
  DeliveryState,
} from "./types.js";

const ATTACHMENT_COLUMNS = `
  id, app_id AS appId, session_id AS sessionId, original_name AS originalName,
  stored_name AS storedName, rel_path AS relPath, temp_rel_path AS tempRelPath,
  mime, size, declared_size AS declaredSize, kind, mode, state,
  created_at AS createdAt, updated_at AS updatedAt`;

const DELIVERY_COLUMNS = `
  id, attachment_id AS attachmentId, app_id AS appId, session_id AS sessionId,
  part_id AS partId, message_id AS messageId, state, error_code AS errorCode,
  created_at AS createdAt, updated_at AS updatedAt`;

export function readAttachment(
  db: SqliteDatabase,
  appId: string,
  id: string,
): AttachmentRow | undefined {
  return db
    .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM app_attachments WHERE app_id = ? AND id = ?`)
    .get(appId, id) as AttachmentRow | undefined;
}

export function readSessionAttachment(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  id: string,
): AttachmentRow | undefined {
  return db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS}
       FROM app_attachments WHERE app_id = ? AND session_id = ? AND id = ?`,
    )
    .get(appId, sessionId, id) as AttachmentRow | undefined;
}

export function readSessionAttachments(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): AttachmentRow[] {
  return db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS}
       FROM app_attachments WHERE app_id = ? AND session_id = ? ORDER BY created_at, id`,
    )
    .all(appId, sessionId) as AttachmentRow[];
}

/** Draft attachments: available and without a sent/sending/unknown delivery (failed allowed). */
export function readDraftAttachments(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): AttachmentRow[] {
  return db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS}
         FROM app_attachments a
        WHERE a.app_id = ? AND a.session_id = ? AND a.state = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM attachment_deliveries d
             WHERE d.attachment_id = a.id AND d.state IN ('sent', 'sending', 'unknown')
          )
        ORDER BY a.created_at, a.id`,
    )
    .all(appId, sessionId) as AttachmentRow[];
}

export function deliveryStatesForAttachment(
  db: SqliteDatabase,
  appId: string,
  attachmentId: string,
): DeliveryState[] {
  return (
    db
      .prepare(
        "SELECT state FROM attachment_deliveries WHERE app_id = ? AND attachment_id = ? ORDER BY created_at, id",
      )
      .all(appId, attachmentId) as Array<{ state: DeliveryState }>
  ).map((row) => row.state);
}

export function readAttachmentDeliveries(
  db: SqliteDatabase,
  appId: string,
  attachmentId: string,
): DeliveryRow[] {
  return db
    .prepare(
      `SELECT ${DELIVERY_COLUMNS}
       FROM attachment_deliveries WHERE app_id = ? AND attachment_id = ?
       ORDER BY created_at, id`,
    )
    .all(appId, attachmentId) as DeliveryRow[];
}

export function readDeliveriesForMessages(
  db: SqliteDatabase,
  appId: string,
  messageIds: string[],
): DeliveryRow[] {
  if (messageIds.length === 0) return [];
  const result: DeliveryRow[] = [];
  for (let offset = 0; offset < messageIds.length; offset += 400) {
    const chunk = messageIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    result.push(
      ...(db
        .prepare(
          `SELECT ${DELIVERY_COLUMNS}
           FROM attachment_deliveries WHERE app_id = ? AND message_id IN (${placeholders})
           ORDER BY created_at, id`,
        )
        .all(appId, ...chunk) as DeliveryRow[]),
    );
  }
  return result;
}

export function readDeliveriesForMessage(
  db: SqliteDatabase,
  appId: string,
  messageId: string,
): DeliveryRow[] {
  return db
    .prepare(
      `SELECT ${DELIVERY_COLUMNS}
       FROM attachment_deliveries WHERE app_id = ? AND message_id = ?
       ORDER BY created_at, id`,
    )
    .all(appId, messageId) as DeliveryRow[];
}

/** The delivery that owns a persisted inline part id (unique per app). */
export function readDeliveryByPartId(
  db: SqliteDatabase,
  appId: string,
  partId: string,
): DeliveryRow | undefined {
  return db
    .prepare(
      `SELECT ${DELIVERY_COLUMNS}
       FROM attachment_deliveries WHERE app_id = ? AND part_id = ?`,
    )
    .get(appId, partId) as DeliveryRow | undefined;
}

export function insertUploadingAttachment(
  db: SqliteDatabase,
  input: {
    id: string;
    appId: string;
    sessionId: string;
    originalName: string;
    tempRelPath: string;
    declaredSize: number;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO app_attachments
       (id, app_id, session_id, original_name, stored_name, rel_path, temp_rel_path, mime, size,
        declared_size, kind, mode, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL, 'auto', 'uploading', ?, ?)`,
  ).run(
    input.id,
    input.appId,
    input.sessionId,
    input.originalName,
    input.tempRelPath,
    input.declaredSize,
    input.now,
    input.now,
  );
}

export function writeUploadMetadata(
  db: SqliteDatabase,
  input: {
    id: string;
    storedName: string;
    relPath: string;
    mime: string;
    size: number;
    kind: AttachmentKind;
    now: string;
  },
): void {
  db.prepare(
    `UPDATE app_attachments
        SET stored_name = ?, rel_path = ?, mime = ?, size = ?, kind = ?, updated_at = ?
      WHERE id = ? AND state = 'uploading'`,
  ).run(input.storedName, input.relPath, input.mime, input.size, input.kind, input.now, input.id);
}

export function markAttachmentAvailable(db: SqliteDatabase, id: string, now: string): void {
  db.prepare(
    `UPDATE app_attachments
        SET state = 'available', temp_rel_path = NULL, declared_size = NULL, updated_at = ?
      WHERE id = ? AND state = 'uploading'`,
  ).run(now, id);
}

export function markAttachmentMissing(db: SqliteDatabase, id: string, now: string): void {
  db.prepare(
    "UPDATE app_attachments SET state = 'missing', updated_at = ? WHERE id = ? AND state = 'available'",
  ).run(now, id);
}

export function setAttachmentMode(
  db: SqliteDatabase,
  appId: string,
  id: string,
  mode: AttachmentMode,
  now: string,
): void {
  db.prepare("UPDATE app_attachments SET mode = ?, updated_at = ? WHERE app_id = ? AND id = ?").run(
    mode,
    now,
    appId,
    id,
  );
}

export function deleteAttachment(db: SqliteDatabase, appId: string, id: string): void {
  db.prepare("DELETE FROM app_attachments WHERE app_id = ? AND id = ?").run(appId, id);
}

export function listUploadingAttachments(
  db: SqliteDatabase,
  olderThanIso: string | undefined,
): AttachmentRow[] {
  const where = olderThanIso === undefined ? "" : "AND updated_at < ?";
  const statement = db.prepare(
    `SELECT ${ATTACHMENT_COLUMNS} FROM app_attachments
      WHERE state = 'uploading' ${where} ORDER BY created_at, id`,
  );
  return (
    olderThanIso === undefined ? statement.all() : statement.all(olderThanIso)
  ) as AttachmentRow[];
}

export function listAvailableAttachments(db: SqliteDatabase, appId: string): AttachmentRow[] {
  return db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS} FROM app_attachments
        WHERE app_id = ? AND state = 'available' ORDER BY created_at, id`,
    )
    .all(appId) as AttachmentRow[];
}

export function listAllAttachments(db: SqliteDatabase): AttachmentRow[] {
  return db
    .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM app_attachments ORDER BY created_at, id`)
    .all() as AttachmentRow[];
}

export function deleteAttachmentRowById(db: SqliteDatabase, id: string): void {
  db.prepare("DELETE FROM app_attachments WHERE id = ?").run(id);
}

export function attachmentStatesForSession(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): { state: AttachmentState }[] {
  return db
    .prepare("SELECT state FROM app_attachments WHERE app_id = ? AND session_id = ?")
    .all(appId, sessionId) as { state: AttachmentState }[];
}

export function countDraftAttachments(
  db: SqliteDatabase,
  appId: string,
  sessionIds: string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let offset = 0; offset < sessionIds.length; offset += 400) {
    const chunk = sessionIds.slice(offset, offset + 400);
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
    for (const row of rows) counts.set(row.sessionId, row.count);
  }
  return counts;
}

/** Mark deliveries of one attempt failed; never touches another attempt or a sent delivery. */
export function failDeliveriesForMessage(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  messageId: string,
  errorCode: string | null,
  now: string,
  from: readonly DeliveryState[] = ["sending", "unknown"],
): number {
  if (from.length === 0) return 0;
  const placeholders = from.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE attachment_deliveries
          SET state = 'failed', error_code = ?, updated_at = ?
        WHERE app_id = ? AND session_id = ? AND message_id = ? AND state IN (${placeholders})`,
    )
    .run(errorCode, now, appId, sessionId, messageId, ...from);
  return result.changes;
}

/** Mark an ambiguous attempt unknown; keeps the attachment in-flight and non-redeliverable. */
export function markDeliveriesUnknownForMessage(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  messageId: string,
  errorCode: string | null,
  now: string,
): number {
  const result = db
    .prepare(
      `UPDATE attachment_deliveries
          SET state = 'unknown', error_code = ?, updated_at = ?
        WHERE app_id = ? AND session_id = ? AND message_id = ? AND state = 'sending'`,
    )
    .run(errorCode, now, appId, sessionId, messageId);
  return result.changes;
}

export function markDeliveriesSentForMessage(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  messageId: string,
  now: string,
): void {
  db.prepare(
    `UPDATE attachment_deliveries SET state = 'sent', error_code = NULL, updated_at = ?
      WHERE app_id = ? AND session_id = ? AND message_id = ?`,
  ).run(now, appId, sessionId, messageId);
}

export function insertDelivery(
  db: SqliteDatabase,
  input: {
    id: string;
    attachmentId: string;
    appId: string;
    sessionId: string;
    partId: string | null;
    messageId: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO attachment_deliveries
       (id, attachment_id, app_id, session_id, part_id, message_id, state, error_code,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'sending', NULL, ?, ?)`,
  ).run(
    input.id,
    input.attachmentId,
    input.appId,
    input.sessionId,
    input.partId,
    input.messageId,
    input.now,
    input.now,
  );
}
