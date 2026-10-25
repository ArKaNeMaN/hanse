import type { SqliteDatabase } from "../store/index.js";
import {
  deliveryStatesForAttachment,
  readDeliveriesForMessages,
  readSessionAttachments,
} from "./store.js";
import type {
  AttachmentRow,
  AttachmentView,
  AttachmentViewState,
  DeliveryState,
  RequestedAttachment,
} from "./types.js";

export interface AttachmentViewOptions {
  appKey: string;
  projectId: string;
  /** Delivery states to derive from; omitted for a fresh draft/upload response. */
  deliveryStates?: DeliveryState[];
  /** Explicit state for a fresh upload/draft row. */
  state?: AttachmentViewState;
  /** Whether this attachment was delivered as an inline part. */
  inline?: boolean;
}

export function downloadUrl(appKey: string, projectId: string, attachmentId: string): string {
  return `/api/apps/${encodeURIComponent(appKey)}/attachments/${encodeURIComponent(attachmentId)}?project=${encodeURIComponent(projectId)}`;
}

export function deriveAttachmentState(
  row: AttachmentRow,
  deliveryStates: readonly DeliveryState[],
): AttachmentViewState {
  if (row.state === "missing") return "missing";
  if (deliveryStates.some((state) => state === "sending" || state === "unknown")) {
    return "in_flight";
  }
  if (deliveryStates.some((state) => state === "sent")) return "sent";
  return "draft";
}

export function attachmentView(row: AttachmentRow, options: AttachmentViewOptions): AttachmentView {
  const states = options.deliveryStates ?? [];
  return {
    id: row.id,
    name: row.originalName,
    mime: row.mime ?? "application/octet-stream",
    size: row.size ?? row.declaredSize ?? 0,
    kind: row.kind ?? "file",
    mode: row.mode,
    state: options.state ?? deriveAttachmentState(row, states),
    downloadURL: downloadUrl(options.appKey, options.projectId, row.id),
    inline: options.inline ?? row.mode === "inline",
  };
}

export function draftAttachmentViews(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  target: { appKey: string; projectId: string },
): AttachmentView[] {
  return readSessionAttachments(db, appId, sessionId)
    .filter((row) => row.state === "available")
    .map((row) => ({ row, states: deliveryStatesForAttachment(db, appId, row.id) }))
    .filter(
      ({ states }) =>
        !states.some((state) => state === "sent" || state === "sending" || state === "unknown"),
    )
    .map(({ row, states }) =>
      attachmentView(row, {
        appKey: target.appKey,
        projectId: target.projectId,
        deliveryStates: states,
      }),
    );
}

/** History metadata: every delivery for the listed message ids, grouped by message. */
export function attachmentViewsForMessages(
  db: SqliteDatabase,
  appId: string,
  messages: Array<{ info: { id: string } }>,
  target: { appKey: string; projectId: string },
): Map<string, AttachmentView[]> {
  const messageIds = messages.map((message) => message.info.id);
  const deliveries = readDeliveriesForMessages(db, appId, messageIds);
  const result = new Map<string, AttachmentView[]>();
  if (deliveries.length === 0) return result;
  const rows = new Map<string, AttachmentRow>();
  for (const row of readSessionAttachmentsForIds(db, appId, [
    ...new Set(deliveries.map((delivery) => delivery.attachmentId)),
  ])) {
    rows.set(row.id, row);
  }
  for (const delivery of deliveries) {
    const row = rows.get(delivery.attachmentId);
    if (row === undefined) continue;
    const list = result.get(delivery.messageId) ?? [];
    const view = attachmentView(row, {
      appKey: target.appKey,
      projectId: target.projectId,
      deliveryStates: [delivery.state],
      inline: delivery.partId !== null,
    });
    view.mode = delivery.partId !== null ? "inline" : "file";
    list.push(view);
    result.set(delivery.messageId, list);
  }
  return result;
}

function readSessionAttachmentsForIds(
  db: SqliteDatabase,
  appId: string,
  ids: string[],
): AttachmentRow[] {
  if (ids.length === 0) return [];
  const result: AttachmentRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    result.push(
      ...(db
        .prepare(
          `SELECT id, app_id AS appId, session_id AS sessionId, original_name AS originalName,
                  stored_name AS storedName, rel_path AS relPath, temp_rel_path AS tempRelPath,
                  mime, size, declared_size AS declaredSize, kind, mode, state,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM app_attachments WHERE app_id = ? AND id IN (${placeholders})`,
        )
        .all(appId, ...chunk) as AttachmentRow[]),
    );
  }
  return result;
}

/** Parse `pending_sends.attachments_json` into validated references. */
export function parseAttachmentRefs(value: string): RequestedAttachment[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const refs: RequestedAttachment[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string") continue;
      const mode =
        record.mode === "auto" || record.mode === "inline" || record.mode === "file"
          ? record.mode
          : undefined;
      refs.push(mode === undefined ? { id: record.id } : { id: record.id, mode });
    }
    return refs;
  } catch {
    return [];
  }
}
