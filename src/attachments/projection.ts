import type { SqliteDatabase } from "../store/index.js";
import { readAttachment, readDeliveriesForMessages, readDeliveryByPartId } from "./store.js";
import type { AttachmentRow, AttachmentView, DeliveryRow } from "./types.js";
import { attachmentView, attachmentViewsForMessages, downloadUrl } from "./views.js";

/** Minimal structural view of an opencode message; avoids importing the HTTP client here. */
export interface ProjectablePart {
  type: string;
  url?: unknown;
  truncated?: unknown;
  [key: string]: unknown;
}

export interface ProjectableMessage {
  info: { id: string; [key: string]: unknown };
  parts: ProjectablePart[];
}

export type MessageProjector = (messages: ProjectableMessage[]) => void;

export interface ProjectionTarget {
  db: SqliteDatabase;
  appId: string;
  appKey: string;
  projectId: string;
}

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

function partId(part: ProjectablePart): string | undefined {
  return typeof part.id === "string" && part.id.length > 0 ? part.id : undefined;
}

/** Replace every `data:` URL with an empty URL plus a truncated marker before any bounding. */
export function stripDataUrlParts(messages: ProjectableMessage[]): void {
  for (const message of messages) {
    for (const part of message.parts) {
      if (isDataUrl(part.url)) {
        part.url = "";
        part.truncated = true;
      }
    }
  }
}

function projectedFilePart(
  part: ProjectablePart,
  row: AttachmentRow,
  target: { appKey: string; projectId: string },
): ProjectablePart {
  const view: AttachmentView = attachmentView(row, {
    appKey: target.appKey,
    projectId: target.projectId,
    inline: true,
  });
  const projected: ProjectablePart = {
    ...part,
    type: "file",
    mime: row.mime ?? "application/octet-stream",
    filename: row.originalName,
    url: downloadUrl(target.appKey, target.projectId, row.id),
    attachment: { id: row.id, size: view.size, mode: "inline", kind: view.kind, inline: true },
  };
  delete projected.truncated;
  return projected;
}

/**
 * History projector: rewrite delivery-owned file parts to the short download route, strip every
 * other data URL, and attach `info.hanse.attachments` for all deliveries of each message.
 */
export function createMessageProjector(target: ProjectionTarget): MessageProjector {
  return (messages) => {
    const deliveries = readDeliveriesForMessages(
      target.db,
      target.appId,
      messages.map((message) => message.info.id),
    );
    const byPartId = new Map<string, DeliveryRow>();
    for (const delivery of deliveries) {
      if (delivery.partId !== null) byPartId.set(delivery.partId, delivery);
    }
    const rows = new Map<string, AttachmentRow>();
    for (const delivery of deliveries) {
      if (rows.has(delivery.attachmentId)) continue;
      const row = readAttachment(target.db, target.appId, delivery.attachmentId);
      if (row !== undefined) rows.set(delivery.attachmentId, row);
    }
    for (const message of messages) {
      for (let index = 0; index < message.parts.length; index += 1) {
        const part = message.parts[index];
        if (part === undefined || part.type !== "file") continue;
        const id = partId(part);
        const delivery = id === undefined ? undefined : byPartId.get(id);
        const row = delivery === undefined ? undefined : rows.get(delivery.attachmentId);
        if (row !== undefined) {
          message.parts[index] = projectedFilePart(part, row, target);
          continue;
        }
        if (isDataUrl(part.url)) {
          part.url = "";
          part.truncated = true;
        }
      }
      const attachments = attachmentViewsForMessages(
        target.db,
        target.appId,
        [message],
        target,
      ).get(message.info.id);
      if (attachments === undefined || attachments.length === 0) continue;
      const info = message.info;
      const hanse =
        typeof info.hanse === "object" && info.hanse !== null && !Array.isArray(info.hanse)
          ? (info.hanse as Record<string, unknown>)
          : {};
      info.hanse = { ...hanse, attachments };
    }
  };
}

/** Default projector for internal readers: no attachment metadata, but never a data URL. */
export const defaultMessageProjector: MessageProjector = stripDataUrlParts;

export interface EventAttachmentResolver {
  /** Project one raw `message.part.updated` file part before bounding. */
  projectFilePart(part: Record<string, unknown>): Record<string, unknown>;
  /** Top-level attachment metadata for a typed `message.updated`. */
  attachmentsForMessage(messageId: string): AttachmentView[] | undefined;
}

const RESOLVER_CACHE_LIMIT = 1_000;

/** DB-backed resolver used by the typed and legacy SSE projectors (sync, snapshot-cached). */
export function createEventAttachmentResolver(target: ProjectionTarget): EventAttachmentResolver {
  const parts = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, AttachmentView[]>();
  const remember = <K, V>(map: Map<K, V>, key: K, value: V): V => {
    map.set(key, value);
    if (map.size > RESOLVER_CACHE_LIMIT) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    return value;
  };
  return {
    projectFilePart(part) {
      const id = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined;
      if (id !== undefined) {
        const cached = parts.get(id);
        if (cached !== undefined) return { ...cached };
      }
      let projected: Record<string, unknown> | undefined;
      if (id !== undefined) {
        const delivery = readDeliveryByPartId(target.db, target.appId, id);
        const row =
          delivery === undefined
            ? undefined
            : readAttachment(target.db, target.appId, delivery.attachmentId);
        if (row !== undefined) {
          projected = projectedFilePart(part as ProjectablePart, row, target) as Record<
            string,
            unknown
          >;
        }
      }
      if (projected === undefined) {
        projected = { ...part };
        if (isDataUrl(projected.url)) {
          projected.url = "";
          projected.truncated = true;
        }
      }
      if (id !== undefined) remember(parts, id, projected);
      return { ...projected };
    },
    attachmentsForMessage(messageId) {
      if (messageId.length === 0) return undefined;
      const cached = messages.get(messageId);
      if (cached !== undefined) return cached;
      const views = attachmentViewsForMessages(
        target.db,
        target.appId,
        [{ info: { id: messageId } }],
        target,
      ).get(messageId);
      return views === undefined ? undefined : remember(messages, messageId, views);
    },
  };
}
