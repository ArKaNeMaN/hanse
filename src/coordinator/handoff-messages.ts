import type { SqliteDatabase } from "../store/index.js";
import type { HandoffOrigin, HandoffOutcome, HandoffReplyState, HandoffState } from "./handoff.js";

/**
 * Chat-facing metadata for a message that the handoff dispatcher injected into an opencode
 * session. The dispatcher sends these messages as ordinary user prompts, so without this
 * projection the chat UI cannot tell them apart from operator input.
 *
 * `body` is present on history projections only. Typed live events carry the lightweight fields so
 * a `message.updated` frame stays inside its 8 KiB cap; the client extracts the body from the
 * message text parts.
 */
export interface HandoffMessageMeta {
  id: string;
  direction: "request" | "reply";
  /** Application key of the agent that sent this message (source for a request, target for a reply). */
  agent: string;
  from: string;
  to: string;
  state: HandoffState;
  summary: string;
  body?: string;
  outcome: HandoffOutcome | null;
  replyState: HandoffReplyState;
  origin: HandoffOrigin;
  operatorNote?: string | null;
}

/** Structural view of an opencode message; avoids importing the projection module here. */
export interface HandoffProjectableMessage {
  info: { id: string; role?: unknown; hanse?: unknown; [key: string]: unknown };
}

interface HandoffMessageRow {
  id: string;
  state: HandoffState;
  summary: string;
  spec: string;
  result: string | null;
  outcome: HandoffOutcome | null;
  reply_state: HandoffReplyState;
  origin: HandoffOrigin;
  operator_note: string | null;
  dispatch_message_id: string | null;
  reply_message_id: string | null;
  from_key: string | null;
  to_key: string | null;
  from_app_id: string;
  to_app_id: string;
}

const SUMMARY_MAX_CHARS = 500;
const BODY_MAX_BYTES = 32 * 1024;
const NOTE_MAX_BYTES = 4 * 1024;
const RESOLVER_CACHE_LIMIT = 1_000;

const SELECT_COLUMNS = `h.id, h.state, h.summary, h.spec, h.result, h.outcome, h.reply_state,
  h.origin, h.operator_note, h.dispatch_message_id, h.reply_message_id,
  h.from_app_id, h.to_app_id, f.app_key AS from_key, t.app_key AS to_key`;

const SELECT_JOINS = `FROM handoffs h
  LEFT JOIN apps f ON f.id = h.from_app_id
  LEFT JOIN apps t ON t.id = h.to_app_id`;

function capUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return `${text.slice(0, end)}\n\n[truncated at ${maxBytes} bytes]`;
}

function boundedSummary(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text;
}

function appKey(row: HandoffMessageRow, side: "from" | "to"): string {
  const key = side === "from" ? row.from_key : row.to_key;
  return key ?? (side === "from" ? row.from_app_id : row.to_app_id);
}

function metaFor(
  row: HandoffMessageRow,
  direction: "request" | "reply",
  includeBody: boolean,
): HandoffMessageMeta {
  const from = appKey(row, "from");
  const to = appKey(row, "to");
  const meta: HandoffMessageMeta = {
    id: row.id,
    direction,
    agent: direction === "request" ? from : to,
    from,
    to,
    state: row.state,
    summary: boundedSummary(row.summary),
    outcome: direction === "reply" ? row.outcome : null,
    replyState: row.reply_state,
    origin: row.origin,
  };
  if (includeBody) {
    const body = direction === "request" ? row.spec : (row.result ?? "");
    meta.body = capUtf8(body, BODY_MAX_BYTES);
    if (direction === "reply" && row.operator_note !== null) {
      meta.operatorNote = capUtf8(row.operator_note, NOTE_MAX_BYTES);
    }
  }
  return meta;
}

function messageMap(
  rows: HandoffMessageRow[],
  includeBody: boolean,
): Map<string, HandoffMessageMeta> {
  const result = new Map<string, HandoffMessageMeta>();
  for (const row of rows) {
    if (row.dispatch_message_id !== null) {
      result.set(row.dispatch_message_id, metaFor(row, "request", includeBody));
    }
    if (row.reply_message_id !== null) {
      result.set(row.reply_message_id, metaFor(row, "reply", includeBody));
    }
  }
  return result;
}

/**
 * Annotate a page of chat history in place with `info.hanse.handoff` for dispatcher-inserted
 * messages. Messages whose id does not match a stored handoff message are left untouched.
 */
export function projectHandoffMessages(
  db: SqliteDatabase,
  sessionId: string,
  messages: HandoffProjectableMessage[],
  options: { includeBody?: boolean } = {},
): void {
  if (messages.length === 0) return;
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} ${SELECT_JOINS}
       WHERE h.target_session_id = ? OR h.source_session_id = ?
          OR h.reply_delivered_session_id = ?`,
    )
    .all(sessionId, sessionId, sessionId) as HandoffMessageRow[];
  if (rows.length === 0) return;
  const byMessage = messageMap(rows, options.includeBody !== false);
  for (const message of messages) {
    if (message.info.role !== "user") continue;
    const meta = byMessage.get(message.info.id);
    if (meta === undefined) continue;
    const existing =
      typeof message.info.hanse === "object" &&
      message.info.hanse !== null &&
      !Array.isArray(message.info.hanse)
        ? (message.info.hanse as Record<string, unknown>)
        : {};
    message.info.hanse = { ...existing, handoff: meta };
  }
}

/** DB-backed resolver for typed `message.updated` projection (sync, positive-result cached). */
export interface HandoffEventResolver {
  handoffForMessage(messageId: string): HandoffMessageMeta | undefined;
}

export function createHandoffEventResolver(db: SqliteDatabase): HandoffEventResolver {
  const cache = new Map<string, HandoffMessageMeta>();
  return {
    handoffForMessage(messageId) {
      if (messageId.length === 0) return undefined;
      const cached = cache.get(messageId);
      if (cached !== undefined) return cached;
      const rows = db
        .prepare(
          `SELECT ${SELECT_COLUMNS} ${SELECT_JOINS}
           WHERE h.dispatch_message_id = ? OR h.reply_message_id = ?`,
        )
        .all(messageId, messageId) as HandoffMessageRow[];
      const meta = messageMap(rows, false).get(messageId);
      if (meta === undefined) return undefined;
      cache.set(messageId, meta);
      if (cache.size > RESOLVER_CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return meta;
    },
  };
}
