import type { SqliteDatabase } from "../store/index.js";
import type {
  HandoffMessageAuthorSide,
  HandoffMessageKind,
  HandoffOrigin,
  HandoffOutcome,
  HandoffReplyState,
  HandoffState,
} from "./handoff.js";

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
  /** Thread marker. One-shot metadata never sets any of the thread fields below. */
  mode?: "thread";
  kind?: "request" | "message" | "reply";
  authorSide?: "source" | "target";
  messageId?: number;
  seq?: number;
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

interface HandoffThreadMessageRow {
  message_pk: number;
  handoff_id: string;
  kind: HandoffMessageKind;
  author_side: HandoffMessageAuthorSide;
  author_app_id: string | null;
  body: string;
  outcome: HandoffOutcome | null;
  seq: number;
  delivery_message_id: string | null;
  header_state: HandoffState;
  header_summary: string;
  header_origin: HandoffOrigin;
  header_reply_state: HandoffReplyState;
  from_app_id: string;
  to_app_id: string;
  author_key: string;
  from_key: string;
  to_key: string;
}

type HandoffThreadKind = "request" | "message" | "reply";
type HandoffThreadSide = "source" | "target";

type ValidHandoffThreadRow = HandoffThreadMessageRow & {
  kind: HandoffThreadKind;
  author_side: HandoffThreadSide;
};

const THREAD_PAGE_CHUNK = 500;

const THREAD_SELECT_COLUMNS = `m.id AS message_pk, m.handoff_id, m.kind, m.author_side,
  m.author_app_id, m.body, m.outcome, m.seq, m.delivery_message_id,
  h.state AS header_state, h.summary AS header_summary, h.origin AS header_origin,
  h.reply_state AS header_reply_state, h.from_app_id, h.to_app_id,
  COALESCE(
    a.app_key,
    CASE m.author_side WHEN 'source' THEN f.app_key ELSE t.app_key END,
    CASE m.author_side WHEN 'source' THEN h.from_app_id ELSE h.to_app_id END
  ) AS author_key,
  COALESCE(f.app_key, h.from_app_id) AS from_key,
  COALESCE(t.app_key, h.to_app_id) AS to_key`;

const THREAD_SELECT_FROM = `FROM handoff_messages m
  JOIN handoffs h ON h.id = m.handoff_id
  LEFT JOIN apps a ON a.id = m.author_app_id
  LEFT JOIN apps f ON f.id = h.from_app_id
  LEFT JOIN apps t ON t.id = h.to_app_id`;

const THREAD_SELECT_FILTER = `m.kind IN ('request', 'message', 'reply')
  AND m.author_side IN ('source', 'target')`;

function isThreadKind(value: HandoffMessageKind): value is HandoffThreadKind {
  return value === "request" || value === "message" || value === "reply";
}

function isThreadSide(value: HandoffMessageAuthorSide): value is HandoffThreadSide {
  return value === "source" || value === "target";
}

function threadMetaFor(row: ValidHandoffThreadRow, includeBody: boolean): HandoffMessageMeta {
  const meta: HandoffMessageMeta = {
    id: row.handoff_id,
    direction: row.author_side === "target" ? "reply" : "request",
    agent: row.author_key,
    from: row.from_key,
    to: row.to_key,
    state: row.header_state,
    summary: boundedSummary(row.header_summary),
    outcome: row.kind === "reply" ? row.outcome : null,
    replyState: row.header_reply_state,
    origin: row.header_origin,
    mode: "thread",
    kind: row.kind,
    authorSide: row.author_side,
    messageId: row.message_pk,
    seq: row.seq,
  };
  if (includeBody) {
    meta.body = capUtf8(row.body, BODY_MAX_BYTES);
  }
  return meta;
}

function threadMessageMap(
  rows: HandoffThreadMessageRow[],
  includeBody: boolean,
): Map<string, HandoffMessageMeta> {
  const result = new Map<string, HandoffMessageMeta>();
  for (const row of rows) {
    if (row.delivery_message_id === null) continue;
    const kind = row.kind;
    const authorSide = row.author_side;
    if (!isThreadKind(kind) || !isThreadSide(authorSide)) continue;
    result.set(
      row.delivery_message_id,
      threadMetaFor({ ...row, kind, author_side: authorSide }, includeBody),
    );
  }
  return result;
}

function threadRowsForSessionPage(
  db: SqliteDatabase,
  sessionId: string,
  messageIds: string[],
): HandoffThreadMessageRow[] {
  const rows: HandoffThreadMessageRow[] = [];
  for (let index = 0; index < messageIds.length; index += THREAD_PAGE_CHUNK) {
    const chunk = messageIds.slice(index, index + THREAD_PAGE_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const part = db
      .prepare(
        `SELECT ${THREAD_SELECT_COLUMNS} ${THREAD_SELECT_FROM}
         WHERE m.delivery_session_id = ?
           AND m.delivery_message_id IN (${placeholders})
           AND ${THREAD_SELECT_FILTER}`,
      )
      .all(sessionId, ...chunk) as HandoffThreadMessageRow[];
    rows.push(...part);
  }
  return rows;
}

function threadRowForDelivery(
  db: SqliteDatabase,
  messageId: string,
): HandoffThreadMessageRow | undefined {
  return db
    .prepare(
      `SELECT ${THREAD_SELECT_COLUMNS} ${THREAD_SELECT_FROM}
       WHERE m.delivery_message_id = ?
         AND ${THREAD_SELECT_FILTER}
       LIMIT 1`,
    )
    .get(messageId) as HandoffThreadMessageRow | undefined;
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
  const includeBody = options.includeBody !== false;
  const oneShotMap = messageMap(rows, includeBody);
  const threadMap = threadMessageMap(
    threadRowsForSessionPage(
      db,
      sessionId,
      Array.from(new Set(messages.map((message) => message.info.id))),
    ),
    includeBody,
  );
  for (const message of messages) {
    if (message.info.role !== "user") continue;
    const meta = threadMap.get(message.info.id) ?? oneShotMap.get(message.info.id);
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
      const threadRow = threadRowForDelivery(db, messageId);
      let meta =
        threadRow === undefined ? undefined : threadMessageMap([threadRow], false).get(messageId);
      if (meta === undefined) {
        const rows = db
          .prepare(
            `SELECT ${SELECT_COLUMNS} ${SELECT_JOINS}
             WHERE h.dispatch_message_id = ? OR h.reply_message_id = ?`,
          )
          .all(messageId, messageId) as HandoffMessageRow[];
        meta = messageMap(rows, false).get(messageId);
      }
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
