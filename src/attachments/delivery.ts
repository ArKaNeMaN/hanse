import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import type { OpencodePart } from "../opencode/client.js";
import type { SqliteDatabase } from "../store/index.js";
import { inlinePartId } from "./inline.js";
import {
  buildAttachmentManifest,
  buildInlineFilePart,
  buildSendParts,
  type ManifestInput,
} from "./manifest.js";
import { type AttachmentPathMode, attachmentFilePath, attachmentReadPath } from "./paths.js";
import {
  deliveryStatesForAttachment,
  insertDelivery,
  markAttachmentMissing,
  readSessionAttachment,
} from "./store.js";
import {
  type AttachmentMode,
  type AttachmentRow,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  type RequestedAttachment,
} from "./types.js";

export interface RequestedAttachmentInput {
  id: string;
  mode?: AttachmentMode;
  /** True only when the client supplied `mode` for this item. */
  explicitMode: boolean;
}

export type ResolveSendResult =
  | {
      ok: true;
      rows: AttachmentRow[];
      refs: RequestedAttachment[];
      warnings: string[];
      /** True when at least one item is a redelivery with an explicit mode. */
      redelivery: boolean;
    }
  | { ok: false; status: number; code: string; message: string };

function isRegularFile(path: string, size: number | null): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return (stat?.isFile() && !stat.isSymbolicLink() && stat.size === size) === true;
}

export function attachmentFileMatches(appRoot: string, row: AttachmentRow): boolean {
  if (row.relPath === null || row.size === null) return false;
  const file = attachmentReadPath(appRoot, row.relPath);
  return file !== undefined && isRegularFile(file, row.size);
}

export function parseRequestedAttachments(value: unknown): RequestedAttachmentInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const items: RequestedAttachmentInput[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return undefined;
    const rawMode = record.mode;
    if (rawMode !== undefined && rawMode !== "auto" && rawMode !== "inline" && rawMode !== "file") {
      return undefined;
    }
    items.push({
      id: record.id,
      ...(rawMode === undefined ? {} : { mode: rawMode }),
      explicitMode: rawMode !== undefined,
    });
  }
  return items;
}

/**
 * Validate a send's attachment set against the same session. Cross-session and cross-app ids are
 * deliberately indistinguishable (`404 attachment_not_found`).
 */
export function resolveSendAttachments(
  db: SqliteDatabase,
  appRoot: string,
  input: {
    appId: string;
    sessionId: string;
    requested: RequestedAttachmentInput[];
    now: string;
  },
): ResolveSendResult {
  if (input.requested.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      ok: false,
      status: 400,
      code: "too_many_attachments",
      message: "too many attachments",
    };
  }
  const seen = new Set<string>();
  const rows: AttachmentRow[] = [];
  const refs: RequestedAttachment[] = [];
  const warnings: string[] = [];
  let redelivery = false;
  let total = 0;
  for (const item of input.requested) {
    if (seen.has(item.id)) {
      return {
        ok: false,
        status: 400,
        code: "invalid_attachment_item",
        message: "duplicate attachment id",
      };
    }
    seen.add(item.id);
    const row = readSessionAttachment(db, input.appId, input.sessionId, item.id);
    if (row === undefined) {
      return {
        ok: false,
        status: 404,
        code: "attachment_not_found",
        message: "attachment not found",
      };
    }
    if (row.state === "uploading") {
      return {
        ok: false,
        status: 409,
        code: "attachment_uploading",
        message: "attachment is still uploading",
      };
    }
    if (row.state === "missing") {
      return {
        ok: false,
        status: 409,
        code: "attachment_missing",
        message: "attachment file is missing",
      };
    }
    if (!attachmentFileMatches(appRoot, row)) {
      markAttachmentMissing(db, row.id, input.now);
      return {
        ok: false,
        status: 409,
        code: "attachment_missing",
        message: "attachment file is missing",
      };
    }
    const states = deliveryStatesForAttachment(db, input.appId, row.id);
    if (states.some((state) => state === "sending")) {
      return {
        ok: false,
        status: 409,
        code: "attachment_in_flight",
        message: "attachment delivery is in flight",
      };
    }
    if (states.some((state) => state === "unknown")) {
      return {
        ok: false,
        status: 409,
        code: "attachment_unknown",
        message: "attachment delivery outcome is unknown",
      };
    }
    if (states.some((state) => state === "sent")) {
      if (!item.explicitMode) {
        return {
          ok: false,
          status: 409,
          code: "attachment_sent",
          message: "attachment was already sent; supply a mode to redeliver",
        };
      }
      redelivery = true;
    }
    rows.push(row);
    refs.push(item.mode === undefined ? { id: row.id } : { id: row.id, mode: item.mode });
    total += row.size ?? 0;
  }
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) {
    return {
      ok: false,
      status: 400,
      code: "message_attachments_too_large",
      message: "attachment bytes exceed the message limit",
    };
  }
  return { ok: true, rows, refs, warnings, redelivery };
}

export interface SendAttachment {
  row: AttachmentRow;
  mode: "inline" | "file";
  partId: string | null;
}

export interface PlannedDelivery {
  id: string;
  attachmentId: string;
  partId: string | null;
}

/** Create one unique delivery (and inline part id) per attachment for this attempt. */
export function planDeliveries(
  attachments: SendAttachment[],
  newId: () => string = newDeliveryId,
): PlannedDelivery[] {
  return attachments.map((attachment) => {
    const id = newId();
    return {
      id,
      attachmentId: attachment.row.id,
      partId: attachment.mode === "inline" ? inlinePartId(attachment.row.id, id) : null,
    };
  });
}

function manifestFor(input: {
  agentsHome: string;
  projectId: string;
  appKey: string;
  pathMode: AttachmentPathMode;
  sessionId: string;
  attachments: SendAttachment[];
}): ManifestInput {
  return {
    agentsHome: input.agentsHome,
    projectId: input.projectId,
    appKey: input.appKey,
    pathMode: input.pathMode,
    sessionId: input.sessionId,
    attachments: input.attachments.map((attachment) => attachment.row),
    modes: new Map(input.attachments.map((attachment) => [attachment.row.id, attachment.mode])),
  };
}

export function sendPartsForPlan(input: {
  text: string;
  agentsHome: string;
  projectId: string;
  appKey: string;
  pathMode: AttachmentPathMode;
  sessionId: string;
  attachments: SendAttachment[];
}): OpencodePart[] {
  const manifest = manifestFor(input);
  const inlineParts = input.attachments.flatMap((attachment) => {
    if (attachment.mode !== "inline" || attachment.partId === null) return [];
    return [buildInlineFilePart({ manifest, row: attachment.row, partId: attachment.partId })];
  });
  return buildSendParts(input.text, buildAttachmentManifest(manifest), inlineParts);
}

/** File-only projection retained for callers that have not resolved inline media. */
export function sendPartsForAttachments(input: {
  text: string;
  agentsHome: string;
  projectId: string;
  appKey: string;
  pathMode: AttachmentPathMode;
  sessionId: string;
  rows: AttachmentRow[];
}): OpencodePart[] {
  return sendPartsForPlan({
    ...input,
    attachments: input.rows.map((row) => ({ row, mode: "file" as const, partId: null })),
  });
}

export function newDeliveryId(): string {
  return `del_${randomUUID().replaceAll("-", "")}`;
}

export function insertDeliveries(
  db: SqliteDatabase,
  input: {
    appId: string;
    sessionId: string;
    messageId: string;
    attachments: Array<{ row: AttachmentRow; partId?: string | null }>;
    now: string;
  },
): void {
  for (const attachment of input.attachments) {
    insertDelivery(db, {
      id: newDeliveryId(),
      attachmentId: attachment.row.id,
      appId: input.appId,
      sessionId: input.sessionId,
      partId: attachment.partId ?? null,
      messageId: input.messageId,
      now: input.now,
    });
  }
}

/** Re-read attachments for a retried pending row; missing rows are skipped (never fabricated). */
export function attachmentsForRefs(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
  refs: RequestedAttachment[],
  appRoot: string,
): AttachmentRow[] {
  const rows: AttachmentRow[] = [];
  for (const ref of refs) {
    const row = readSessionAttachment(db, appId, sessionId, ref.id);
    if (row === undefined || row.state !== "available" || row.relPath === null) continue;
    if (!attachmentFileMatches(appRoot, row)) {
      markAttachmentMissing(db, row.id, new Date().toISOString());
      continue;
    }
    rows.push(row);
  }
  return rows;
}

export function fileExists(appRoot: string, row: AttachmentRow): boolean {
  if (row.relPath === null) return false;
  const file = attachmentFilePath(appRoot, row.relPath);
  return file !== undefined && existsSync(file);
}
