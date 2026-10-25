/**
 * Pure chat-core helpers.
 *
 * Browser ESM only: no DOM, network, storage, timers, or Node APIs. The module is also imported
 * directly by Vitest. Store shapes are expressed with JSDoc so they stay plain objects/Maps at
 * runtime.
 *
 * @typedef {"text" | "reasoning" | "tool" | "step-start" | "step-finish" | "patch" | "file" |
 *   "subtask" | "retry" | "compaction" | "snapshot" | "agent"} PartType
 */

/**
 * @typedef {Object} PartRecord
 * @property {string} id
 * @property {PartType | string} type
 * @property {Record<string, unknown>} data Bounded snapshot as received.
 * @property {boolean} [provisional] Created by a delta before a snapshot arrived.
 * @property {boolean} [partial] Truncated snapshot or omitted event.
 * @property {boolean} [sealed] Set on snapshot/idle for text/reasoning parts.
 * @property {number} version
 */

/**
 * @typedef {"System reminder" | "Background task" | "Task result" | "Continuation" | "System"} OmoKind
 */

/**
 * @typedef {Object} OmoSystemMeta
 * @property {OmoKind} kind
 * @property {"neutral" | "info" | "success" | "warning" | "error"} tone
 * @property {string[]} headers Extracted leading header lines.
 * @property {string} title headers.join(" · "), bounded to 240 characters.
 * @property {string} body Markers stripped and system-reminder tags unwrapped.
 */

/**
 * One attachment as the server projects it (upload, draft, history, or typed event).
 *
 * @typedef {Object} AttachmentView
 * @property {string} id
 * @property {string} name
 * @property {string} mime
 * @property {number} size
 * @property {"image" | "video" | "pdf" | "file"} kind
 * @property {"auto" | "inline" | "file"} mode
 * @property {"draft" | "in_flight" | "sent" | "missing"} state
 * @property {string} downloadURL
 * @property {boolean} inline
 */

/**
 * @typedef {Object} MessageRecord
 * @property {string} id
 * @property {"user" | "assistant"} role
 * @property {string} [parentID] Assistant -> last consumed user message.
 * @property {string} [finish] Assistant finish reason.
 * @property {{ created?: number, completed?: number }} [time]
 * @property {"sending" | "queued" | "accepted" | "unknown" | "failed"} [optimistic] Presentation only.
 * @property {OmoSystemMeta} [system] Derived, never persisted.
 * @property {HandoffMessageMeta} [handoff] Dispatcher-inserted request/reply; renders as an agent message.
 * @property {AttachmentView[]} [attachments] File-only strip; history info.hanse.attachments.
 * @property {string[]} partOrder
 * @property {Map<string, PartRecord>} parts
 * @property {boolean} [classificationPending] Live OMO buffer flag (optional).
 * @property {boolean} [needsReconcile]
 * @property {number} version
 */

/**
 * @typedef {Object} ThreadStore
 * @property {string | null} sessionID
 * @property {number} generation
 * @property {number} turnGeneration Increments on send acceptance and busy/idle.
 * @property {string[]} order
 * @property {Map<string, MessageRecord>} messages
 * @property {string | null} activePromptID Current/active trailing operator row; never in queue.
 * @property {string[]} queue Queued message IDs, chronological; derived, never persisted.
 * @property {Set<string>} openParts
 * @property {Map<string, number>} lastSeqByStream
 * @property {string | null} currentStreamID
 * @property {Map<string, string>} pendingDeltas partID -> unapplied text.
 * @property {{ type?: string } | null} agentStatus
 * @property {"live" | "reconnecting" | "paused" | "connecting"} connection
 */

const INITIATOR_DETECT = /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/;
const INITIATOR_STRIP = /\n*<!--\s*OMO_INTERNAL_INITIATOR\s*-->\s*/g;
const NOREPLY_STRIP = /\n*<!--\s*OMO_INTERNAL_NOREPLY\s*-->\s*/g;
const SYSTEM_REMINDER_TAG = /<\/?system-reminder>/gi;

const VISIBLE_NON_TEXT_TYPES = new Set([
  "tool",
  "reasoning",
  "patch",
  "file",
  "subtask",
]);

const TASK_SUCCESS = Object.freeze({
  kind: "Task result",
  tone: "success",
});
const TASK_ERROR = Object.freeze({
  kind: "Task result",
  tone: "error",
});
const BACKGROUND_WARNING = Object.freeze({
  kind: "Background task",
  tone: "warning",
});
const BACKGROUND_INFO = Object.freeze({
  kind: "Background task",
  tone: "info",
});
const CONTINUATION = Object.freeze({
  kind: "Continuation",
  tone: "neutral",
});
const SYSTEM_REMINDER = Object.freeze({
  kind: "System reminder",
  tone: "neutral",
});
const SYSTEM = Object.freeze({
  kind: "System",
  tone: "neutral",
});

const OMO_TITLE_LIMIT = 240;
const TABLE_MAX_COLUMNS = 16;
const TABLE_MAX_ROWS = 200;
const TABLE_MAX_CELL_CHARS = 2000;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asString(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * @param {Record<string, unknown>} part
 * @returns {Record<string, unknown>}
 */
function partData(part) {
  const data = part.data;
  return isRecord(data) ? data : part;
}

/**
 * @param {Record<string, unknown>} part
 * @returns {string | undefined}
 */
function partText(part) {
  const data = partData(part);
  return asString(data.text) ?? asString(part.text);
}

/**
 * @param {Record<string, unknown>} part
 * @returns {boolean}
 */
function isIgnoredPart(part) {
  return part.ignored === true || partData(part).ignored === true;
}

/**
 * @param {Record<string, unknown>} part
 * @returns {boolean}
 */
function isSyntheticPart(part) {
  return part.synthetic === true || partData(part).synthetic === true;
}

const ATTACHMENT_KINDS = new Set(["image", "video", "pdf", "file"]);
const ATTACHMENT_MODES = new Set(["auto", "inline", "file"]);
const ATTACHMENT_STATES = new Set(["draft", "in_flight", "sent", "missing"]);
const INLINE_ATTACHMENT_KINDS = new Set(["image", "video", "pdf"]);
const MANIFEST_MARKER = "attachment-manifest";
const SYNTHETIC_READ_PREFIX = "Called the Read tool";
const ATTACHMENT_WARNING_TEXT = Object.freeze({
  attachment_inline_unsupported:
    "This model cannot display this attachment inline; it was sent as a file instead.",
  attachment_inline_too_large:
    "This attachment is too large to send inline; it was sent as a file instead.",
  attachment_capability_unknown:
    "The model capabilities could not be confirmed; the attachment was sent as a file instead.",
  attachment_context_large:
    "This message is large for the model context; it was sent anyway.",
});
const ATTACHMENT_DOWNGRADE_CODES = new Set([
  "attachment_inline_unsupported",
  "attachment_inline_too_large",
  "attachment_capability_unknown",
]);
const STREAM_WARNING_TEXT = Object.freeze({
  stream_limit:
    "Too many live streams are open for this app (8). Close another chat tab, then retry; history still loads here.",
  frame_too_large: "A live update was too large and was skipped; refreshing it from history.",
  delta_too_large: "A very large text update was skipped; refreshing it from history.",
  invalid_json: "A live update could not be read; refreshing from history.",
});

/**
 * The coordinator's synthetic manifest text part is never part of the feed.
 *
 * @param {Record<string, unknown>} part
 * @returns {boolean}
 */
export function isAttachmentManifestPart(part) {
  if (!isRecord(part)) return false;
  const data = partData(part);
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  return (
    (data.synthetic === true || part.synthetic === true) &&
    metadata !== undefined &&
    metadata.hanse === MANIFEST_MARKER
  );
}

/**
 * Text parts the feed never shows: the synthetic attachment manifest and opencode's synthetic
 * `Called the Read tool...` text added for `file:` inline parts. Both arrive as `synthetic: true`.
 *
 * @param {Record<string, unknown>} part
 * @returns {boolean}
 */
export function isHiddenSyntheticTextPart(part) {
  if (!isRecord(part)) return false;
  if (part.type !== "text" && partData(part).type !== "text") return false;
  if (isAttachmentManifestPart(part)) return true;
  if (!isSyntheticPart(part)) return false;
  const text = partText(part);
  return text === undefined || text.startsWith(SYNTHETIC_READ_PREFIX) || text.length === 0;
}

/**
 * @param {unknown} value
 * @returns {"image" | "video" | "pdf" | "file"}
 */
export function attachmentKindForMime(value) {
  const mime = typeof value === "string" ? value.toLowerCase() : "";
  if (
    mime === "image/png" ||
    mime === "image/jpeg" ||
    mime === "image/gif" ||
    mime === "image/webp"
  ) {
    return "image";
  }
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "file";
}

/**
 * Normalize one server attachment view (or a local optimistic clone). Invalid ids are dropped.
 *
 * @param {unknown} value
 * @returns {AttachmentView | null}
 */
export function normalizeAttachment(value) {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (id === undefined || id.length === 0) return null;
  const kind = ATTACHMENT_KINDS.has(value.kind) ? value.kind : attachmentKindForMime(value.mime);
  const mode = ATTACHMENT_MODES.has(value.mode) ? value.mode : "auto";
  const state = ATTACHMENT_STATES.has(value.state) ? value.state : "draft";
  const mime = asString(value.mime) ?? "";
  return {
    id,
    name: asString(value.name) ?? "",
    mime,
    size: typeof value.size === "number" && Number.isFinite(value.size)
      ? Math.max(0, value.size)
      : 0,
    kind,
    mode,
    state,
    downloadURL: asString(value.downloadURL) ?? "",
    inline: value.inline === true,
  };
}

/**
 * @param {unknown} value
 * @returns {AttachmentView[]}
 */
export function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const attachment = normalizeAttachment(raw);
    if (attachment === null || seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    out.push(attachment);
  }
  return out;
}

/**
 * Pending-send rows carry only `[{id, mode?}]`, not a full view.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, mode?: "auto" | "inline" | "file" }>}
 */
export function normalizeAttachmentRefs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const id = typeof raw === "string" ? raw : isRecord(raw) ? asString(raw.id) : undefined;
    if (id === undefined || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const mode = isRecord(raw) && ATTACHMENT_MODES.has(raw.mode) ? raw.mode : undefined;
    out.push(mode === undefined ? { id } : { id, mode });
  }
  return out;
}

/**
 * A draft attachment is mutable (remove/PATCH) only while nothing has been delivered.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function attachmentIsMutable(value) {
  return isRecord(value) && value.state === "draft";
}

/**
 * @param {unknown} value Chips or attachment views.
 * @returns {boolean}
 */
export function attachmentsUploading(value) {
  if (!Array.isArray(value)) return false;
  return value.some(
    (item) => isRecord(item) && (item.status === "uploading" || item.state === "in_flight"),
  );
}

/**
 * Only image/video/PDF attachments may be sent to the model inline.
 *
 * @param {unknown} kind
 * @returns {boolean}
 */
export function attachmentSupportsInlineMode(kind) {
  return INLINE_ATTACHMENT_KINDS.has(kind);
}

/**
 * Composer mode choices. Empty for file-only kinds, which show a static "File only" badge.
 *
 * @param {unknown} kind
 * @returns {Array<{ value: "auto" | "inline" | "file", label: string }>}
 */
export function attachmentModeOptions(kind) {
  if (!attachmentSupportsInlineMode(kind)) return [];
  return [
    { value: "auto", label: "Auto" },
    { value: "inline", label: "Send to model" },
    { value: "file", label: "File only" },
  ];
}

/**
 * Resolve a control value to a legal mode for the attachment kind.
 *
 * @param {unknown} kind
 * @param {unknown} value
 * @returns {"auto" | "inline" | "file"}
 */
export function attachmentModeValue(kind, value) {
  if (!attachmentSupportsInlineMode(kind)) return "file";
  if (value === "inline" || value === "file") return value;
  return "auto";
}

/**
 * @param {unknown} kind
 * @param {unknown} mode
 * @returns {string}
 */
export function attachmentModeLabel(kind, mode) {
  if (!attachmentSupportsInlineMode(kind)) return "File only";
  if (mode === "inline") return "Inline";
  if (mode === "file") return "File only";
  return "Auto";
}

/**
 * Send payload: ready ids plus their per-delivery mode. Auto omits `mode`; file-only kinds are
 * forced to `file`. Never sends paths or parts.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, mode?: "inline" | "file" }>}
 */
export function attachmentSendPayload(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = asString(raw.id);
    if (id === undefined || id.length === 0 || seen.has(id)) continue;
    if (raw.status !== undefined && raw.status !== "ready") continue;
    seen.add(id);
    let mode = ATTACHMENT_MODES.has(raw.mode) ? raw.mode : undefined;
    if (raw.kind !== undefined && !attachmentSupportsInlineMode(raw.kind)) mode = "file";
    if (mode === "auto") mode = undefined;
    out.push(mode === undefined ? { id } : { id, mode });
  }
  return out;
}

/**
 * Normalize the send response's warning codes into visible, non-blocking messages.
 *
 * @param {unknown} value
 * @returns {Array<{ code: string, message: string, downgrade: boolean }>}
 */
export function normalizeAttachmentWarnings(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const code = typeof raw === "string" ? raw : isRecord(raw) ? asString(raw.code) : undefined;
    if (code === undefined || code.length === 0 || seen.has(code)) continue;
    seen.add(code);
    const supplied =
      isRecord(raw) && typeof raw.message === "string" ? raw.message.trim() : "";
    const message =
      supplied.length > 0
        ? supplied
        : (ATTACHMENT_WARNING_TEXT[code] ?? `Attachment warning: ${code}.`);
    const downgrade =
      (isRecord(raw) && raw.downgrade === true) || ATTACHMENT_DOWNGRADE_CODES.has(code);
    out.push({ code, message, downgrade });
  }
  return out;
}

/**
 * A sent or inline attachment can be delivered again as a file-only copy. A missing or in-flight
 * attachment cannot.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function canRedeliverAsFile(value) {
  if (!isRecord(value)) return false;
  const id = asString(value.id);
  if (id === undefined || id.length === 0) return false;
  if (value.state === "missing" || value.state === "in_flight") return false;
  return value.state === "sent" || value.inline === true || value.mode === "inline";
}

/**
 * Redelivery body: a new message with the same attachment forced to file mode.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, mode: "file" }>}
 */
export function redeliveryAttachmentPayload(value) {
  if (!canRedeliverAsFile(value)) return [];
  const id = asString(value.id);
  return id === undefined ? [] : [{ id, mode: "file" }];
}

/**
 * Map one projected inline `file` part to the attachment-card view. Returns null for parts without
 * trusted attachment metadata or with a data/unknown URL, so raw base64 is never rendered.
 *
 * @param {unknown} value
 * @returns {AttachmentView | null}
 */
export function attachmentViewFromFilePart(value) {
  if (!isRecord(value)) return null;
  const data = partData(value);
  if (value.type !== "file" && data.type !== "file") return null;
  const metadata = isRecord(data.attachment) ? data.attachment : null;
  if (metadata === null) return null;
  const id = asString(metadata.id);
  if (id === undefined || id.length === 0) return null;
  const downloadURL =
    safeAttachmentUrl(data.url) ?? safeAttachmentUrl(metadata.downloadURL) ?? null;
  if (downloadURL === null) return null;
  const mime = asString(data.mime) ?? asString(metadata.mime) ?? "";
  const name =
    asString(data.filename) ?? asString(data.name) ?? asString(metadata.name) ?? "";
  const kind =
    mime.length > 0
      ? attachmentKindForMime(mime)
      : ATTACHMENT_KINDS.has(metadata.kind)
        ? metadata.kind
        : "file";
  return normalizeAttachment({
    id,
    name,
    mime,
    size: metadata.size,
    kind,
    mode: metadata.mode,
    state: metadata.state ?? "sent",
    downloadURL,
    inline: true,
  });
}

/**
 * @param {unknown} value
 * @returns {{ code: string, message: string, limit: boolean, sessionID?: string } | null}
 */
export function normalizeStreamWarning(value) {
  if (!isRecord(value)) return null;
  const code = asString(value.code);
  if (code === undefined || code.length === 0) return null;
  const supplied = asString(value.message);
  const message =
    supplied !== undefined && supplied.trim().length > 0
      ? supplied.trim()
      : (STREAM_WARNING_TEXT[code] ?? "Live updates were interrupted; refreshing from history.");
  const sessionID = asString(value.sessionID);
  return {
    code,
    message,
    limit: code === "stream_limit",
    ...(sessionID === undefined ? {} : { sessionID }),
  };
}

/**
 * Normalize and apply one `message.part.omitted` event to a record. The placeholder is partial and
 * omitted; a later history snapshot replaces it with the projected part.
 *
 * @param {Record<string, unknown>} record
 * @param {unknown} value
 * @returns {{ part: Record<string, unknown>, created: boolean } | null}
 */
export function applyOmittedPart(record, value) {
  if (!isRecord(record) || !isRecord(value)) return null;
  const messageID = asString(value.messageID);
  const partID = asString(value.partID);
  if (messageID === undefined || partID === undefined) return null;
  const partType = asString(value.partType) ?? "text";
  if (!(record.parts instanceof Map)) record.parts = new Map();
  if (!Array.isArray(record.partOrder)) record.partOrder = [];
  let part = record.parts.get(partID);
  let created = false;
  if (part === undefined || !isRecord(part)) {
    part = {
      id: partID,
      type: partType,
      data: {
        id: partID,
        type: partType,
        text: "",
        provisional: partType === "text",
      },
      provisional: partType === "text",
      partial: true,
      omitted: true,
      sealed: false,
      version: 1,
    };
    record.parts.set(partID, part);
    if (!record.partOrder.includes(partID)) record.partOrder.push(partID);
    created = true;
  } else {
    part.partial = true;
    part.omitted = true;
    part.version = (asNumber(part.version) ?? 1) + 1;
  }
  return { part, created };
}

/**
 * Only same-origin paths and http(s) URLs may reach an href/src. Rejects `data:` and scripts.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeAttachmentUrl(value) {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.length === 0) return null;
  const lower = url.toLowerCase();
  if (lower.startsWith("data:") || lower.startsWith("javascript:") || lower.startsWith("blob:")) {
    return null;
  }
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (lower.startsWith("https://") || lower.startsWith("http://")) return url;
  return null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatAttachmentSize(value) {
  const bytes = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const rounded = size >= 10 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[index]}`;
}

/**
 * @param {Record<string, unknown>} part
 * @returns {boolean}
 */
function isTextPart(part) {
  return part.type === "text" && typeof partText(part) === "string";
}

/**
 * @param {unknown} message
 * @returns {Array<Record<string, unknown>>}
 */
function messageParts(message) {
  if (!isRecord(message)) {
    return [];
  }
  const parts = message.parts;
  if (parts instanceof Map) {
    return Array.from(parts.values()).filter(isRecord);
  }
  if (Array.isArray(parts)) {
    return parts.filter(isRecord);
  }
  const info = message.info;
  if (isRecord(info) && Array.isArray(info.parts)) {
    return info.parts.filter(isRecord);
  }
  return [];
}

/**
 * @param {unknown} message
 * @returns {string | undefined}
 */
function messageRole(message) {
  if (!isRecord(message)) {
    return undefined;
  }
  const role = message.role;
  if (typeof role === "string") {
    return role;
  }
  const info = message.info;
  if (isRecord(info)) {
    return asString(info.role);
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} part
 * @returns {boolean}
 */
function isVisiblePart(part) {
  if (part.type === "text") {
    if (isIgnoredPart(part)) {
      return false;
    }
    const text = partText(part);
    return typeof text === "string" && text.trim().length > 0;
  }
  return typeof part.type === "string" && VISIBLE_NON_TEXT_TYPES.has(part.type);
}

/**
 * @param {MessageRecord} record
 * @returns {boolean}
 */
function hasVisiblePart(record) {
  const seen = new Set();
  const order = Array.isArray(record.partOrder) ? record.partOrder : [];
  for (const id of order) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const part = record.parts instanceof Map ? record.parts.get(id) : undefined;
    if (part !== undefined && isVisiblePart(part)) {
      return true;
    }
  }
  if (record.parts instanceof Map) {
    for (const part of record.parts.values()) {
      if (isVisiblePart(part)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} text
 * @returns {{ headers: string[], bodyStart: number, tagConsumed: boolean }}
 */
function extractOmoHeaders(text) {
  const lines = text.split("\n");
  let cursor = 0;
  while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") {
    cursor++;
  }
  if (cursor >= lines.length) {
    return { headers: [], bodyStart: 0, tagConsumed: false };
  }
  let tagConsumed = false;
  if ((lines[cursor] ?? "").trim().toLowerCase() === "<system-reminder>") {
    cursor++;
    tagConsumed = true;
  }
  if (cursor >= lines.length) {
    return { headers: [], bodyStart: cursor, tagConsumed };
  }
  const firstContent = (lines[cursor] ?? "").trim();
  if (/^BOULDER COMPLETE/i.test(firstContent)) {
    return { headers: [firstContent], bodyStart: cursor + 1, tagConsumed };
  }
  const headers = [];
  while (cursor < lines.length) {
    const line = (lines[cursor] ?? "").trim();
    if (
      line === "" ||
      line.toLowerCase() === "</system-reminder>" ||
      !/^\[[^\]]+\]$/.test(line)
    ) {
      break;
    }
    headers.push(line);
    cursor++;
  }
  const bodyStart = headers.length > 0 || tagConsumed ? cursor : 0;
  return { headers, bodyStart, tagConsumed };
}

/**
 * @param {string} header
 * @returns {{ kind: OmoKind, tone: OmoSystemMeta["tone"] } | null}
 */
function kindForHeader(header) {
  const upper = header.trim().toUpperCase();
  if (upper.startsWith("BOULDER COMPLETE")) {
    return CONTINUATION;
  }
  if (
    upper === "[BACKGROUND TASK RESULT READY]" ||
    upper === "[BACKGROUND TASK COMPLETED]" ||
    upper === "[ALL BACKGROUND TASKS COMPLETE]"
  ) {
    return TASK_SUCCESS;
  }
  if (
    upper === "[BACKGROUND TASK ERROR]" ||
    (upper.startsWith("[ALL BACKGROUND TASKS FINISHED") && upper.endsWith("]"))
  ) {
    return TASK_ERROR;
  }
  if (
    upper === "[BACKGROUND TASK CANCELLED]" ||
    upper === "[BACKGROUND TASK INTERRUPTED]" ||
    upper === "[BACKGROUND TASK RETRYING]"
  ) {
    return BACKGROUND_WARNING;
  }
  if (upper.startsWith("[SYSTEM DIRECTIVE: OH-MY-OPENCODE")) {
    if (
      upper.includes("TODO CONTINUATION") ||
      upper.includes("BOULDER CONTINUATION") ||
      upper.includes("RALPH LOOP") ||
      upper.includes("ULTRAWORK")
    ) {
      return CONTINUATION;
    }
    return SYSTEM_REMINDER;
  }
  if (upper.startsWith("[SYSTEM REMINDER")) {
    return SYSTEM_REMINDER;
  }
  if (upper.startsWith("[BACKGROUND TASK ") && upper.endsWith("]")) {
    return BACKGROUND_INFO;
  }
  if (upper.includes("RALPH LOOP") || upper.includes("ULTRAWORK")) {
    return CONTINUATION;
  }
  return null;
}

/**
 * Classify an OMO-injected operator-role message. Mirrors OMO's
 * `isSyntheticOrInternalUserMessage` plus the header/tone table from the design.
 *
 * @param {unknown} message Upstream `{info, parts}` or a chat-core MessageRecord.
 * @returns {OmoSystemMeta | null}
 */
export function classifyOmo(message) {
  if (messageRole(message) !== "user") {
    return null;
  }
  const parts = messageParts(message);
  const textParts = parts
    .filter(isTextPart)
    .filter((part) => !isAttachmentManifestPart(part));
  if (textParts.length === 0) {
    return null;
  }
  const synthetic = textParts.every((part) => {
    if (isSyntheticPart(part)) {
      return true;
    }
    const text = partText(part);
    return typeof text === "string" && INITIATOR_DETECT.test(text);
  });
  if (!synthetic) {
    return null;
  }

  const rendered = textParts
    .filter((part) => !isIgnoredPart(part))
    .map((part) => (partText(part) ?? "").replace(INITIATOR_STRIP, "").replace(NOREPLY_STRIP, ""))
    .join("\n");

  const extracted = extractOmoHeaders(rendered);
  const bodySource =
    extracted.headers.length > 0 || extracted.tagConsumed
      ? rendered.split("\n").slice(extracted.bodyStart).join("\n")
      : rendered;
  const body = bodySource.replace(SYSTEM_REMINDER_TAG, "").trim();

  let classification = null;
  for (const header of extracted.headers) {
    const found = kindForHeader(header);
    if (found !== null) {
      classification = found;
      break;
    }
  }
  if (classification === null) {
    const firstBodyLine =
      body
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? "";
    if (/^(RALPH LOOP|ULTRAWORK)\b/i.test(firstBodyLine)) {
      classification = CONTINUATION;
    } else {
      classification = SYSTEM;
    }
  }

  const titleSource = extracted.headers.length > 0 ? extracted.headers.join(" · ") : classification.kind;
  return {
    kind: classification.kind,
    tone: classification.tone,
    headers: extracted.headers,
    title: titleSource.slice(0, OMO_TITLE_LIMIT),
    body,
  };
}

/**
 * Derive the active/queued prompt boundary from feed order, `parentID`, and turn state.
 *
 * @param {ThreadStore} store
 * @param {{ sessionStatusType?: string, allowPromotion?: boolean }} [status]
 * @returns {{
 *   activeID: string | null,
 *   queuedIDs: string[],
 *   turnContinues: boolean,
 *   nextActivePromptID: string | null
 * }}
 */
export function deriveQueue(store, status = {}) {
  const order = Array.isArray(store?.order) ? store.order : [];
  const messages = store?.messages instanceof Map ? store.messages : new Map();
  const sessionStatusType = asString(status?.sessionStatusType);

  let lastVisible = null;
  let lastVisibleIndex = -1;
  for (let index = 0; index < order.length; index++) {
    const record = messages.get(order[index]);
    if (record !== undefined && record.role === "assistant" && hasVisiblePart(record)) {
      lastVisible = record;
      lastVisibleIndex = index;
    }
  }

  let boundary = -1;
  if (lastVisible !== null) {
    boundary = lastVisibleIndex;
    const parentID = asString(lastVisible.parentID);
    if (parentID !== undefined && parentID.length > 0) {
      const parentIndex = order.indexOf(parentID);
      const parent = parentIndex >= 0 ? messages.get(parentID) : undefined;
      if (
        parentIndex >= 0 &&
        parent !== undefined &&
        parent.role === "user" &&
        (parent.system === undefined || parent.system === null) &&
        (parent.handoff === undefined || parent.handoff === null)
      ) {
        boundary = parentIndex;
      }
    }
  }

  const pending = [];
  for (let index = boundary + 1; index < order.length; index++) {
    const record = messages.get(order[index]);
    if (record === undefined || record.role !== "user") {
      continue;
    }
    if (record.system !== undefined && record.system !== null) {
      continue;
    }
    if (record.handoff !== undefined && record.handoff !== null) {
      continue;
    }
    if (record.classificationPending === true) {
      continue;
    }
    if (record.optimistic === "failed") {
      continue;
    }
    pending.push(record.id);
  }

  const turnContinues =
    lastVisible !== null &&
    (lastVisible.time?.completed === undefined ||
      lastVisible.time?.completed === null ||
      lastVisible.finish === "tool-calls") &&
    sessionStatusType !== "idle";

  if (turnContinues) {
    return {
      activeID: null,
      queuedIDs: pending,
      turnContinues: true,
      nextActivePromptID: null,
    };
  }

  if (pending.length === 0) {
    return {
      activeID: null,
      queuedIDs: [],
      turnContinues: false,
      nextActivePromptID: null,
    };
  }

  if (status?.allowPromotion === false) {
    return {
      activeID: null,
      queuedIDs: pending,
      turnContinues: false,
      nextActivePromptID: null,
    };
  }

  const tracked = asString(store?.activePromptID);
  let activeID;
  if (tracked !== undefined && pending.includes(tracked)) {
    activeID = tracked;
  } else {
    activeID = pending[0];
  }

  return {
    activeID,
    queuedIDs: pending.slice(pending.indexOf(activeID) + 1),
    turnContinues: false,
    nextActivePromptID: activeID,
  };
}

/**
 * @param {unknown} value
 * @returns {PartRecord | null}
 */
function clonePart(value) {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  const type = asString(value.type);
  if (id === undefined || type === undefined) {
    return null;
  }
  const data = isRecord(value.data) ? { ...value.data } : { ...value };
  return {
    id,
    type,
    data,
    provisional: value.provisional === true,
    partial: value.partial === true,
    sealed: value.sealed === true,
    version: asNumber(value.version) ?? 1,
  };
}

/**
 * @param {unknown} value
 * @returns {MessageRecord | null}
 */
function cloneMessage(value) {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  const role = asString(value.role);
  if (id === undefined || (role !== "user" && role !== "assistant")) {
    return null;
  }
  const parts = new Map();
  if (value.parts instanceof Map) {
    for (const [key, part] of value.parts) {
      const cloned = clonePart(part);
      if (cloned !== null) {
        parts.set(typeof key === "string" ? key : cloned.id, cloned);
      }
    }
  } else if (Array.isArray(value.parts)) {
    for (const part of value.parts) {
      const cloned = clonePart(part);
      if (cloned !== null) {
        parts.set(cloned.id, cloned);
      }
    }
  }
  const partOrder = Array.isArray(value.partOrder)
    ? value.partOrder.filter((partID) => typeof partID === "string")
    : [];
  const attachments = Array.isArray(value.attachments)
    ? normalizeAttachments(value.attachments)
    : undefined;
  return {
    id,
    role,
    parentID: asString(value.parentID),
    finish: asString(value.finish),
    time: isRecord(value.time)
      ? {
          created: asNumber(value.time.created),
          completed: asNumber(value.time.completed),
        }
      : undefined,
    optimistic: asString(value.optimistic),
    system: isRecord(value.system) ? value.system : undefined,
    ...(attachments === undefined ? {} : { attachments }),
    partOrder,
    parts,
    classificationPending: value.classificationPending === true ? true : undefined,
    needsReconcile: value.needsReconcile === true ? true : undefined,
    version: asNumber(value.version) ?? 1,
  };
}

/**
 * @param {string} id
 * @param {MessageRecord} record
 * @returns {boolean}
 */
function isLocalOptimistic(id, record) {
  return (typeof record.optimistic === "string" && record.optimistic.length > 0) || id.startsWith("local_");
}

/**
 * A row that exists only in the client until the server confirms it. Accepted/queued server-backed
 * rows are normal history and keep their chronological position when they are absent from a page.
 *
 * @param {string} id
 * @param {MessageRecord} record
 * @returns {boolean}
 */
function isTransientLocal(id, record) {
  return (
    id.startsWith("local_") ||
    record.optimistic === "sending" ||
    record.optimistic === "unknown" ||
    record.optimistic === "failed"
  );
}

/**
 * Merge a server row with the matching local optimistic row. Server data wins; local in-flight
 * acceptance is preserved.
 *
 * @param {MessageRecord} server
 * @param {MessageRecord} local
 * @returns {MessageRecord}
 */
function mergeOptimisticRecord(server, local) {
  const merged = cloneMessage(server) ?? server;
  if (local.optimistic === "sending" || local.optimistic === "unknown") {
    merged.optimistic = local.optimistic;
  } else {
    merged.optimistic = local.optimistic;
  }

  const serverAttachments = Array.isArray(server.attachments) ? server.attachments : undefined;
  const localAttachments = Array.isArray(local.attachments) ? local.attachments : undefined;
  const attachments =
    serverAttachments !== undefined && serverAttachments.length > 0
      ? serverAttachments
      : localAttachments !== undefined && localAttachments.length > 0
        ? localAttachments
        : serverAttachments;
  if (attachments !== undefined) merged.attachments = normalizeAttachments(attachments);
  else delete merged.attachments;

  const serverHasText = Array.from(server.parts.values()).some((part) => part.type === "text");
  const orderedIDs = [];
  const seen = new Set();
  for (const id of local.partOrder) {
    const part = local.parts.get(id);
    if (part === undefined) {
      continue;
    }
    if (part.type === "text" && part.provisional === true && serverHasText) {
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      orderedIDs.push(id);
    }
  }
  for (const id of server.partOrder) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIDs.push(id);
    }
  }
  const parts = new Map();
  for (const id of orderedIDs) {
    const part = server.parts.get(id) ?? local.parts.get(id);
    const cloned = clonePart(part);
    if (cloned !== null) {
      parts.set(id, cloned);
    }
  }
  merged.partOrder = orderedIDs;
  merged.parts = parts;
  merged.version = Math.max(server.version, local.version) + 1;
  return merged;
}

/**
 * Handoff metadata projected by the coordinator onto either `info.hanse.handoff` (history) or a
 * typed `message.updated` frame. The dispatcher sends these as ordinary user prompts, so the chat
 * uses this marker to render them as messages from the sending agent instead of the operator.
 *
 * @typedef {Object} HandoffMessageMeta
 * @property {string} id
 * @property {"request" | "reply"} direction
 * @property {string} agent Sending application key.
 * @property {string} from
 * @property {string} to
 * @property {string} [state]
 * @property {string} summary
 * @property {string} [body] Full spec/result on history projections.
 * @property {"completed" | "blocked" | "failed" | null} [outcome]
 * @property {string} [replyState]
 * @property {"agent" | "operator"} [origin]
 * @property {string | null} [operatorNote]
 */

const HANDOFF_KEY_MAX = 200;
const HANDOFF_SUMMARY_MAX = 500;
const HANDOFF_BODY_MAX = 64 * 1024;
const HANDOFF_NOTE_MAX = 4 * 1024;

function boundedString(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function boundedNullableString(value, limit) {
  if (value === null) return null;
  return boundedString(value, limit);
}

/**
 * Validate and bound one handoff metadata object. Returns null for malformed input.
 *
 * @param {unknown} value
 * @returns {HandoffMessageMeta | null}
 */
export function normalizeHandoffMeta(value) {
  if (!isRecord(value)) return null;
  const direction = value.direction === "request" || value.direction === "reply" ? value.direction : null;
  const id = boundedString(value.id, HANDOFF_KEY_MAX);
  const agent = boundedString(value.agent, HANDOFF_KEY_MAX);
  const from = boundedString(value.from, HANDOFF_KEY_MAX);
  const to = boundedString(value.to, HANDOFF_KEY_MAX);
  const summary = boundedString(value.summary, HANDOFF_SUMMARY_MAX);
  if (direction === null || !id || !agent || !from || !to || summary === undefined) return null;
  const meta = { id, direction, agent, from, to, summary };
  const state = boundedString(value.state, 40);
  if (state !== undefined) meta.state = state;
  const body = boundedString(value.body, HANDOFF_BODY_MAX);
  if (body !== undefined) meta.body = body;
  if (value.outcome === "completed" || value.outcome === "blocked" || value.outcome === "failed") {
    meta.outcome = value.outcome;
  } else if (value.outcome === null) {
    meta.outcome = null;
  }
  const replyState = boundedString(value.replyState, 40);
  if (replyState !== undefined) meta.replyState = replyState;
  if (value.origin === "agent" || value.origin === "operator") meta.origin = value.origin;
  const operatorNote = boundedNullableString(value.operatorNote, HANDOFF_NOTE_MAX);
  if (operatorNote !== undefined) meta.operatorNote = operatorNote;
  return meta;
}

/**
 * Read handoff metadata from a history message `info.hanse.handoff`.
 *
 * @param {unknown} info
 * @returns {HandoffMessageMeta | null}
 */
export function handoffFromInfo(info) {
  if (!isRecord(info)) return null;
  const hanse = isRecord(info.hanse) ? info.hanse : null;
  if (hanse === null) return null;
  return normalizeHandoffMeta(hanse.handoff);
}

/**
 * Extract the human body from a dispatcher-generated handoff prompt. The envelopes are stable
 * (`[Hanse handoff request]` / `[Hanse handoff reply]`); this is the live-event fallback because
 * typed events carry only lightweight handoff metadata.
 *
 * @param {string} text
 * @param {"request" | "reply"} direction
 * @returns {string}
 */
export function handoffBodyFromText(text, direction) {
  const source = typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  if (source.length === 0) return "";
  if (direction === "request") {
    const marker = "\nSpecification:\n";
    const start = source.indexOf(marker);
    if (start < 0) return "";
    const from = start + marker.length;
    const end = source.indexOf("\n\nWhen the work is finished", from);
    return (end < 0 ? source.slice(from) : source.slice(from, end)).trim();
  }
  const marker = "\nResult:\n";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const from = start + marker.length;
  let end = source.length;
  for (const stop of [
    "\n\nOperator note (trusted):\n",
    "\n\nContinue your work with this reply in mind.",
  ]) {
    const index = source.indexOf(stop, from);
    if (index >= 0) end = Math.min(end, index);
  }
  return source.slice(from, end).trim();
}

/** Operator note embedded in a relaunched reply prompt, when the live event omits it. */
export function handoffNoteFromText(text) {
  const source = typeof text === "string" ? text.replace(/\r\n?/g, "\n") : "";
  const marker = "\nOperator note (trusted):\n";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const from = start + marker.length;
  const end = source.indexOf("\n\nContinue your work with this reply in mind.", from);
  return (end < 0 ? source.slice(from) : source.slice(from, end)).trim();
}

/** Same initials rules as the server-rendered `initials()` helper. */
export function agentInitials(name) {
  const words = String(name ?? "")
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return "AG";
  if (words.length === 1) return (words[0] ?? "AG").slice(0, 2).toUpperCase();
  return `${(words[0] ?? "").slice(0, 1)}${(words[1] ?? "").slice(0, 1)}`.toUpperCase();
}

/**
 * History snapshots carry file-only attachments on `info.hanse.attachments`.
 *
 * @param {unknown} info
 * @returns {AttachmentView[] | undefined}
 */
function attachmentsFromInfo(info) {
  if (!isRecord(info)) return undefined;
  const hanse = isRecord(info.hanse) ? info.hanse : undefined;
  if (hanse !== undefined && Array.isArray(hanse.attachments)) {
    return normalizeAttachments(hanse.attachments);
  }
  if (Array.isArray(info.attachments)) return normalizeAttachments(info.attachments);
  return undefined;
}

/**
 * @param {Array<Record<string, unknown>>} snapshotMessages
 * @param {Map<string, MessageRecord>} currentMessages
 * @returns {{
 *   order: string[],
 *   messages: Map<string, MessageRecord>,
 *   snapshotIDs: Set<string>,
 *   snapshotPartIDs: Set<string>
 * }}
 */
function buildSnapshotMessages(snapshotMessages, currentMessages) {
  const order = [];
  const messages = new Map();
  const snapshotIDs = new Set();
  const snapshotPartIDs = new Set();
  for (const entry of snapshotMessages) {
    if (!isRecord(entry)) {
      continue;
    }
    const info = isRecord(entry.info) ? entry.info : entry;
    const id = asString(info.id);
    if (id === undefined) {
      continue;
    }
    const role = asString(info.role);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    if (snapshotIDs.has(id)) {
      continue;
    }
    const previous = currentMessages.get(id);
    const sourceParts = messageParts(entry);
    const partOrder = [];
    const parts = new Map();
    sourceParts.forEach((sourcePart, index) => {
      const partID = asString(sourcePart.id) ?? `${id}:part:${index}`;
      const type = asString(sourcePart.type) ?? "text";
      const data = isRecord(sourcePart.data) ? { ...sourcePart.data } : { ...sourcePart };
      const record = {
        id: partID,
        type,
        data,
        provisional: sourcePart.provisional === true || data.provisional === true,
        partial: sourcePart.partial === true || data.partial === true,
        sealed: false,
        version: (asNumber(previous?.parts.get(partID)?.version) ?? 0) + 1,
      };
      if (!parts.has(partID)) {
        partOrder.push(partID);
      }
      parts.set(partID, record);
      snapshotPartIDs.add(partID);
    });
    const parentID = asString(info.parentID);
    const finish = asString(info.finish);
    const time = isRecord(info.time)
      ? {
          created: asNumber(info.time.created),
          completed: asNumber(info.time.completed),
        }
      : undefined;
    const record = {
      id,
      role,
      parentID,
      finish,
      time,
      partOrder,
      parts,
      version: (asNumber(previous?.version) ?? 0) + 1,
    };
    if (role === "user") {
      const handoff = handoffFromInfo(info);
      if (handoff !== null) {
        record.handoff = handoff;
      } else {
        const system = classifyOmo(entry);
        if (system !== null) {
          record.system = system;
        }
      }
      const attachments = attachmentsFromInfo(info);
      if (attachments !== undefined) record.attachments = attachments;
    }
    messages.set(id, record);
    snapshotIDs.add(id);
    order.push(id);
  }
  return { order, messages, snapshotIDs, snapshotPartIDs };
}

/**
 * @param {string[]} order
 * @param {Map<string, MessageRecord>} messages
 * @param {Set<string>} snapshotIDs
 */
function applySnapshotSealing(order, messages, snapshotIDs) {
  let lastAssistantID = null;
  let lastUncompletedAssistantID = null;
  for (const id of order) {
    const record = messages.get(id);
    if (record === undefined || record.role !== "assistant") {
      continue;
    }
    lastAssistantID = id;
    if (record.time?.completed === undefined || record.time?.completed === null) {
      lastUncompletedAssistantID = id;
    }
  }
  let runningTool = false;
  for (const id of snapshotIDs) {
    const record = messages.get(id);
    if (record === undefined) {
      continue;
    }
    for (const part of record.parts.values()) {
      if (part.type === "tool" && partData(part).state?.status === "running") {
        runningTool = true;
      }
    }
  }
  const lastAssistant = lastAssistantID === null ? undefined : messages.get(lastAssistantID);
  const sealAll =
    lastAssistant !== undefined &&
    lastAssistant.time?.completed !== undefined &&
    lastAssistant.time?.completed !== null &&
    !runningTool;

  for (const id of snapshotIDs) {
    const record = messages.get(id);
    if (record === undefined) {
      continue;
    }
    for (const part of record.parts.values()) {
      if (part.type === "text" || part.type === "reasoning") {
        if (sealAll || id !== lastUncompletedAssistantID) {
          part.sealed = true;
        } else {
          part.sealed = false;
        }
      } else if (part.type === "tool") {
        const status = partData(part).state?.status;
        part.sealed = sealAll || (status !== "running" && status !== "pending");
      } else if (sealAll) {
        part.sealed = true;
      }
    }
  }
}

/**
 * Seal a preserved record that predates the newest snapshot message. Tool parts keep their own
 * running/pending state; every other record part is terminal.
 *
 * @param {MessageRecord} record
 */
function sealPreservedRecord(record) {
  for (const part of record.parts.values()) {
    if (
      part.type === "text" ||
      part.type === "reasoning" ||
      part.type === "patch" ||
      part.type === "file" ||
      part.type === "subtask"
    ) {
      part.sealed = true;
    } else if (part.type === "tool") {
      const status = partData(part).state?.status;
      part.sealed = status !== "running" && status !== "pending";
    }
  }
}

/**
 * @param {ThreadStore} base
 * @param {string[]} order
 * @param {Map<string, MessageRecord>} messages
 * @param {Set<string>} currentOpenParts
 * @returns {Set<string>}
 */
function preservedOpenParts(base, order, messages, currentOpenParts) {
  const known = new Set();
  for (const id of order) {
    const record = messages.get(id);
    if (record === undefined) {
      continue;
    }
    for (const partID of record.parts.keys()) {
      known.add(partID);
    }
  }
  const preserved = new Set();
  for (const partID of currentOpenParts) {
    if (known.has(partID)) {
      preserved.add(partID);
    }
  }
  return preserved;
}

/**
 * @param {ThreadStore} store
 * @param {string} id
 * @param {{ activeID: string | null, queuedIDs: string[] }} derived
 * @param {boolean} [preserveInFlight]
 * @returns {"sending" | "queued" | "accepted" | "unknown" | "failed"}
 */
function presentationState(store, id, derived, preserveInFlight = true) {
  const record = store.messages.get(id);
  const current = record?.optimistic;
  if (current === "failed") {
    return current;
  }
  if (preserveInFlight && (current === "sending" || current === "unknown")) {
    return current;
  }
  if (derived.activeID === id) {
    return "accepted";
  }
  if (derived.queuedIDs.includes(id)) {
    return "queued";
  }
  return "accepted";
}

/**
 * Apply a complete message snapshot atomically.
 *
 * @param {ThreadStore} currentStore
 * @param {Array<Record<string, unknown>>} snapshotMessages
 * @param {{
 *   capturedTurnGeneration?: number,
 *   turnGeneration?: number,
 *   sessionStatusType?: string,
 *   contentDiscarded?: boolean,
 *   discardedContent?: boolean,
 *   sessionID?: string,
 *   position?: "replace" | "tail" | "older",
 *   keepOptimistic?: "all" | "transient",
 *   allowPromotion?: boolean
 * }} [options]
 * @returns {{ store: ThreadStore, contentDiscarded: boolean, turnChanged: boolean }}
 */
export function applySnapshot(currentStore, snapshotMessages, options = {}) {
  const base = currentStore;
  const snapshotSource = Array.isArray(snapshotMessages)
    ? snapshotMessages
    : isRecord(snapshotMessages) && Array.isArray(snapshotMessages.messages)
      ? snapshotMessages.messages
      : [];
  const currentOrder = Array.isArray(base?.order) ? base.order : [];
  const currentMessages = base?.messages instanceof Map ? base.messages : new Map();
  const position =
    options?.position === "tail" || options?.position === "older" ? options.position : "replace";
  const built = buildSnapshotMessages(snapshotSource, currentMessages);
  const snapshotIDs = built.snapshotIDs;
  const snapshotPartIDs = built.snapshotPartIDs;
  const adoptedIDs = new Set();
  const emptyPage =
    built.order.length === 0 && (position === "tail" || position === "older");

  let order;
  let messages;
  if (emptyPage) {
    order = [...currentOrder];
    messages = new Map();
    for (const [id, record] of currentMessages) {
      const cloned = cloneMessage(record);
      if (cloned !== null) {
        messages.set(id, cloned);
      }
    }
  } else if (position === "tail") {
    const currentIndex = new Map();
    for (let index = 0; index < currentOrder.length; index++) {
      currentIndex.set(currentOrder[index], index);
    }
    let anchor = -1;
    for (const id of built.order) {
      const index = currentIndex.get(id);
      if (index !== undefined) {
        anchor = index;
        break;
      }
    }
    const prefixEnd = anchor < 0 ? currentOrder.length : anchor;
    const seen = new Set();
    const prefixIDs = [];
    for (let index = 0; index < prefixEnd; index++) {
      const id = currentOrder[index];
      if (seen.has(id) || snapshotIDs.has(id)) {
        continue;
      }
      const record = currentMessages.get(id);
      if (record === undefined || isTransientLocal(id, record)) {
        continue;
      }
      seen.add(id);
      prefixIDs.push(id);
    }
    const suffixIDs = [];
    if (anchor >= 0) {
      for (let index = anchor + 1; index < currentOrder.length; index++) {
        const id = currentOrder[index];
        if (seen.has(id) || snapshotIDs.has(id)) {
          continue;
        }
        const record = currentMessages.get(id);
        if (record === undefined || isTransientLocal(id, record)) {
          continue;
        }
        seen.add(id);
        suffixIDs.push(id);
      }
    }
    order = [];
    messages = new Map(built.messages);
    for (const id of prefixIDs) {
      const cloned = cloneMessage(currentMessages.get(id));
      if (cloned === null) {
        continue;
      }
      sealPreservedRecord(cloned);
      messages.set(id, cloned);
      order.push(id);
    }
    for (const id of built.order) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      order.push(id);
    }
    for (const id of suffixIDs) {
      const cloned = cloneMessage(currentMessages.get(id));
      if (cloned === null) {
        continue;
      }
      messages.set(id, cloned);
      order.push(id);
    }
  } else if (position === "older") {
    const seen = new Set();
    order = [];
    messages = new Map(built.messages);
    for (const id of built.order) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      order.push(id);
    }
    for (const id of currentOrder) {
      if (seen.has(id) || snapshotIDs.has(id)) {
        continue;
      }
      const record = currentMessages.get(id);
      if (record === undefined || isTransientLocal(id, record)) {
        continue;
      }
      const cloned = cloneMessage(record);
      if (cloned === null) {
        continue;
      }
      seen.add(id);
      messages.set(id, cloned);
      order.push(id);
    }
  } else {
    order = [...built.order];
    messages = new Map(built.messages);
  }

  if (!emptyPage) {
    const keepTransientOnly =
      position !== "replace" || options?.keepOptimistic === "transient";
    for (const id of currentOrder) {
      const local = currentMessages.get(id);
      if (local === undefined) {
        continue;
      }
      if (keepTransientOnly) {
        if (!isTransientLocal(id, local)) {
          continue;
        }
      } else if (!isLocalOptimistic(id, local)) {
        continue;
      }
      const server = messages.get(id);
      if (server !== undefined) {
        messages.set(id, mergeOptimisticRecord(server, local));
        adoptedIDs.add(id);
        continue;
      }
      const cloned = cloneMessage(local);
      if (cloned === null) {
        continue;
      }
      if (position !== "replace" && order.includes(id)) {
        continue;
      }
      messages.set(id, cloned);
      order.push(id);
    }
  }

  applySnapshotSealing(order, messages, snapshotIDs);

  let contentDiscarded = options?.contentDiscarded === true || options?.discardedContent === true;
  let nextPendingDeltas = new Map();
  if (base?.pendingDeltas instanceof Map) {
    const partIDs = new Set();
    for (const record of messages.values()) {
      for (const partID of record.parts.keys()) {
        partIDs.add(partID);
      }
    }
    for (const [partID, text] of base.pendingDeltas) {
      if (snapshotPartIDs.has(partID) || !partIDs.has(partID)) {
        contentDiscarded = true;
        continue;
      }
      nextPendingDeltas.set(partID, text);
    }
  } else {
    nextPendingDeltas = new Map();
  }

  const openParts = preservedOpenParts(
    base,
    order,
    messages,
    base?.openParts instanceof Set ? base.openParts : new Set(),
  );

  const sessionID = asString(options?.sessionID) ?? base?.sessionID ?? null;
  const capturedTurnGeneration = asNumber(
    options?.capturedTurnGeneration ?? options?.turnGeneration,
  );
  const turnChanged =
    capturedTurnGeneration !== undefined &&
    capturedTurnGeneration !== (asNumber(base?.turnGeneration) ?? 0);

  const generation = (asNumber(base?.generation) ?? 0) + 1;
  const store = {
    sessionID,
    generation,
    turnGeneration: asNumber(base?.turnGeneration) ?? 0,
    order,
    messages,
    activePromptID: base?.activePromptID ?? null,
    queue: [],
    openParts,
    lastSeqByStream:
      base?.lastSeqByStream instanceof Map ? new Map(base.lastSeqByStream) : new Map(),
    currentStreamID: base?.currentStreamID ?? null,
    pendingDeltas: nextPendingDeltas,
    agentStatus: base?.agentStatus ?? null,
    connection: base?.connection ?? "live",
  };

  const sessionStatusType =
    asString(options?.sessionStatusType) ?? asString(store.agentStatus?.type);
  const derived = deriveQueue(store, {
    sessionStatusType,
    allowPromotion: options?.allowPromotion,
  });
  store.queue = [...derived.queuedIDs];
  store.activePromptID = derived.nextActivePromptID;
  for (const id of order) {
    const record = messages.get(id);
    if (record === undefined || record.optimistic === undefined) {
      continue;
    }
    record.optimistic = presentationState(store, id, derived, !adoptedIDs.has(id));
  }

  return { store, contentDiscarded, turnChanged };
}

/**
 * @param {Record<string, unknown>} record
 * @returns {string | null}
 */
function placeholderPartID(record) {
  for (const id of record.partOrder) {
    const part = record.parts.get(id);
    if (part === undefined || part.type !== "text") {
      continue;
    }
    const data = partData(part);
    if (part.provisional === true || data.provisional === true || data.placeholder === true) {
      return id;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string | undefined}
 */
function bufferedEventMessageID(event) {
  if (!isRecord(event)) {
    return undefined;
  }
  const direct = asString(event.messageID);
  if (direct !== undefined) {
    return direct;
  }
  const properties = isRecord(event.properties) ? event.properties : undefined;
  if (properties === undefined) {
    return undefined;
  }
  const info = isRecord(properties.info) ? properties.info : undefined;
  if (info !== undefined) {
    const id = asString(info.id);
    if (id !== undefined) {
      return id;
    }
  }
  const part = isRecord(properties.part) ? properties.part : undefined;
  if (part !== undefined) {
    const messageID = asString(part.messageID);
    if (messageID !== undefined) {
      return messageID;
    }
  }
  return asString(properties.messageID);
}

/**
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown> | undefined}
 */
function bufferedEventInfo(event) {
  const properties = isRecord(event.properties) ? event.properties : undefined;
  if (properties !== undefined && isRecord(properties.info)) {
    return properties.info;
  }
  if (isRecord(event.info)) {
    return event.info;
  }
  if (isRecord(event.message)) {
    return event.message;
  }
  if (asString(event.messageID) !== undefined) {
    return event;
  }
  return undefined;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown> | undefined}
 */
function bufferedEventPart(event) {
  const properties = isRecord(event.properties) ? event.properties : undefined;
  if (properties !== undefined && isRecord(properties.part)) {
    return properties.part;
  }
  return isRecord(event.part) ? event.part : undefined;
}

/**
 * @param {MessageRecord} record
 * @param {Record<string, unknown>} event
 * @param {string | null} placeholderID
 * @returns {string | null}
 */
function applyBufferedEvent(record, event, placeholderID) {
  const type = asString(event.type);
  if (type === "message.updated") {
    const info = bufferedEventInfo(event);
    if (info === undefined) {
      return placeholderID;
    }
    const role = asString(info.role);
    if (role === "user" || role === "assistant") {
      record.role = role;
    }
    const parentID = asString(info.parentID);
    if (parentID !== undefined) {
      record.parentID = parentID;
    }
    const finish = asString(info.finish);
    if (finish !== undefined) {
      record.finish = finish;
    }
    if (isRecord(info.time)) {
      record.time = {
        created: asNumber(info.time.created),
        completed: asNumber(info.time.completed),
      };
    }
    if (Array.isArray(info.attachments) && info.attachments.length > 0) {
      record.attachments = normalizeAttachments(info.attachments);
    }
    return placeholderID;
  }
  if (type !== "message.part.updated" && type !== "message.part.delta") {
    return placeholderID;
  }

  const part = bufferedEventPart(event);
  if (part === undefined) {
    return placeholderID;
  }
  const partID = asString(part.id) ?? asString(event.partID) ?? placeholderID;
  if (partID === null || partID === undefined) {
    return placeholderID;
  }
  const partType = asString(part.type) ?? asString(event.partType) ?? "text";

  if (partType === "text" && placeholderID !== null) {
    const oldIndex = record.partOrder.indexOf(placeholderID);
    const placeholder = record.parts.get(placeholderID);
    record.parts.delete(placeholderID);
    record.partOrder = record.partOrder.filter((id) => id !== placeholderID);
    const data = isRecord(part.data) ? { ...part.data } : { ...part };
    const replacement = {
      id: partID,
      type: partType,
      data,
      provisional: false,
      partial: part.partial === true,
      sealed: placeholder?.sealed === true,
      version: (placeholder?.version ?? 0) + 1,
    };
    record.parts.delete(partID);
    record.parts.set(partID, replacement);
    const insertAt = oldIndex < 0 ? record.partOrder.length : oldIndex;
    record.partOrder.splice(insertAt, 0, partID);
    return null;
  }

  const existing = record.parts.get(partID);
  const data = isRecord(part.data) ? { ...part.data } : { ...part };
  if (partType === "text" && type === "message.part.delta") {
    const previousText = existing === undefined ? "" : (partText(existing) ?? "");
    data.text = `${previousText}${asString(part.delta) ?? ""}`;
  }
  record.parts.set(partID, {
    id: partID,
    type: partType,
    data,
    provisional: part.provisional === true,
    partial: part.partial === true,
    sealed: existing?.sealed === true,
    version: (existing?.version ?? 0) + 1,
  });
  if (!record.partOrder.includes(partID)) {
    record.partOrder.push(partID);
  }
  return placeholderID === partID ? null : placeholderID;
}

/**
 * Rekey a local optimistic user row to its server message ID in one store mutation.
 *
 * @param {ThreadStore} store
 * @param {{
 *   tempID: string,
 *   serverID: string,
 *   bufferedEvents?: Array<Record<string, unknown>>,
 *   sessionStatusType?: string,
 *   allowPromotion?: boolean
 * }} options
 * @returns {{ store: ThreadStore, consumed: boolean }}
 */
export function rekeyOptimistic(store, options) {
  const tempID = asString(options?.tempID);
  const serverID = asString(options?.serverID);
  if (tempID === undefined || serverID === undefined) {
    return { store, consumed: false };
  }
  const currentMessages = store?.messages instanceof Map ? store.messages : new Map();
  const temp = currentMessages.get(tempID);
  if (temp === undefined) {
    return { store, consumed: false };
  }
  if (tempID === serverID) {
    return { store, consumed: false };
  }

  const currentOrder = Array.isArray(store?.order) ? store.order : [];
  const existing = currentMessages.get(serverID);
  let merged;
  if (existing !== undefined) {
    merged = mergeOptimisticRecord(existing, temp);
    merged.id = serverID;
  } else {
    merged = cloneMessage(temp);
    if (merged === null) {
      return { store, consumed: false };
    }
    merged.id = serverID;
  }
  merged.version = Math.max(temp.version, existing?.version ?? 0) + 1;

  let placeholderID = placeholderPartID(merged);
  if (Array.isArray(options?.bufferedEvents)) {
    for (const event of options.bufferedEvents) {
      if (bufferedEventMessageID(event) !== serverID) {
        continue;
      }
      placeholderID = applyBufferedEvent(merged, event, placeholderID);
    }
  }

  const tempIndex = currentOrder.indexOf(tempID);
  const remaining = currentOrder.filter((id) => id !== tempID && id !== serverID);
  const insertAt =
    tempIndex < 0
      ? remaining.length
      : currentOrder.slice(0, tempIndex).filter((id) => id !== serverID).length;
  remaining.splice(Math.min(insertAt, remaining.length), 0, serverID);

  const messages = new Map(currentMessages);
  messages.delete(tempID);
  messages.set(serverID, merged);

  const nextStore = {
    sessionID: store?.sessionID ?? null,
    generation: asNumber(store?.generation) ?? 0,
    turnGeneration: asNumber(store?.turnGeneration) ?? 0,
    order: remaining,
    messages,
    activePromptID: store?.activePromptID ?? null,
    queue: Array.isArray(store?.queue) ? [...store.queue] : [],
    openParts: store?.openParts instanceof Set ? new Set(store.openParts) : new Set(),
    lastSeqByStream:
      store?.lastSeqByStream instanceof Map ? new Map(store.lastSeqByStream) : new Map(),
    currentStreamID: store?.currentStreamID ?? null,
    pendingDeltas:
      store?.pendingDeltas instanceof Map ? new Map(store.pendingDeltas) : new Map(),
    agentStatus: store?.agentStatus ?? null,
    connection: store?.connection ?? "live",
  };

  const sessionStatusType =
    asString(options?.sessionStatusType) ?? asString(nextStore.agentStatus?.type);
  const derived = deriveQueue(nextStore, {
    sessionStatusType,
    allowPromotion: options?.allowPromotion,
  });
  nextStore.queue = [...derived.queuedIDs];
  nextStore.activePromptID = derived.nextActivePromptID;

  const serverIndex = remaining.indexOf(serverID);
  let consumed = false;
  for (const record of messages.values()) {
    if (record.role !== "assistant" || typeof record.parentID !== "string") {
      continue;
    }
    if (!hasVisiblePart(record)) {
      continue;
    }
    const parentIndex = remaining.indexOf(record.parentID);
    if (parentIndex >= 0 && parentIndex >= serverIndex) {
      consumed = true;
      break;
    }
  }

  if (merged.optimistic === "unknown") {
    merged.optimistic = "unknown";
  } else if (consumed || derived.activeID === serverID) {
    merged.optimistic = "accepted";
  } else if (derived.queuedIDs.includes(serverID)) {
    merged.optimistic = "queued";
  } else {
    merged.optimistic = "accepted";
  }
  return { store: nextStore, consumed };
}

/**
 * @param {string} line
 * @returns {{
 *   cells: string[],
 *   sawSeparator: boolean
 * }}
 */
function splitTableCells(line) {
  const cells = [];
  let current = "";
  let inCode = false;
  let codeRun = 0;
  let sawSeparator = false;
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "`") {
      let run = 1;
      while (line[index + run] === "`") {
        run++;
      }
      if (inCode && run === codeRun) {
        inCode = false;
        codeRun = 0;
      } else if (!inCode) {
        inCode = true;
        codeRun = run;
      }
      current += "`".repeat(run);
      index += run;
      continue;
    }
    if (char === "\\" && line[index + 1] === "|" && !inCode) {
      current += "|";
      index += 2;
      continue;
    }
    if (char === "|" && !inCode) {
      sawSeparator = true;
      cells.push(current);
      current = "";
      index++;
      continue;
    }
    current += char;
    index++;
  }
  cells.push(current);

  const trimmedStart = line.trimStart();
  const trimmedEnd = line.trimEnd();
  let start = 0;
  let end = cells.length;
  if (trimmedStart.startsWith("|") && end - start >= 2 && (cells[start] ?? "").trim() === "") {
    start++;
  }
  if (
    trimmedEnd.endsWith("|") &&
    end - start >= 2 &&
    (cells[end - 1] ?? "").trim() === ""
  ) {
    end--;
  }
  return {
    cells: cells.slice(start, end).map((cell) => cell.trim()),
    sawSeparator,
  };
}

/**
 * @param {string} cell
 * @returns {"left" | "center" | "right"}
 */
function alignmentFor(cell) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) {
    return "center";
  }
  if (right) {
    return "right";
  }
  return "left";
}

/**
 * @param {string} cell
 * @returns {string}
 */
function boundedCell(cell) {
  return cell.slice(0, TABLE_MAX_CELL_CHARS);
}

/**
 * Parse a GFM pipe table starting at `startIndex`.
 *
 * Delimiters use GFM `-+` with optional alignment colons. Header/delimiter cell counts must match;
 * escaped pipes and pipes inside backtick code spans do not split cells. Outer leading/trailing
 * pipes are optional. The parser ignores a prose line with a pipe when the following delimiter line
 * has a different cell count. Caps: 16 columns (not a table), 200 body rows (`truncated`), and
 * 2,000 characters per cell. An unmarked delimiter defaults to left alignment.
 *
 * @param {string[]} lines
 * @param {number} startIndex
 * @returns {{
 *   headers: Array<{ text: string, align: "left" | "center" | "right" }>,
 *   rows: string[][],
 *   truncated: boolean,
 *   nextIndex: number
 * } | null}
 */
export function parseMarkdownTable(lines, startIndex) {
  if (!Array.isArray(lines) || !Number.isInteger(startIndex) || startIndex < 0) {
    return null;
  }
  const headerLine = lines[startIndex];
  const delimiterLine = lines[startIndex + 1];
  if (typeof headerLine !== "string" || typeof delimiterLine !== "string") {
    return null;
  }

  const header = splitTableCells(headerLine);
  if (!header.sawSeparator) {
    return null;
  }
  const delimiter = splitTableCells(delimiterLine);
  if (delimiter.cells.length !== header.cells.length) {
    return null;
  }
  if (header.cells.length === 1 && (!header.sawSeparator || !delimiter.sawSeparator)) {
    return null;
  }
  if (header.cells.length > TABLE_MAX_COLUMNS) {
    return null;
  }
  const aligns = [];
  for (const cell of delimiter.cells) {
    if (!/^:?-+:?$/.test(cell)) {
      return null;
    }
    aligns.push(alignmentFor(cell));
  }

  const headers = header.cells.map((text, index) => ({
    text: boundedCell(text),
    align: aligns[index],
  }));

  const rows = [];
  let index = startIndex + 2;
  let truncated = false;
  while (index < lines.length) {
    const line = lines[index];
    if (typeof line !== "string") {
      break;
    }
    const split = splitTableCells(line);
    if (line.trim() === "" || !split.sawSeparator) {
      break;
    }
    if (rows.length < TABLE_MAX_ROWS) {
      const row = [];
      for (let column = 0; column < headers.length; column++) {
        row.push(boundedCell(split.cells[column] ?? ""));
      }
      rows.push(row);
    } else {
      truncated = true;
    }
    index++;
  }

  return { headers, rows, truncated, nextIndex: index };
}

function unknownChip() {
  return { state: "cancelled", icon: "slash", label: "Unknown" };
}

export function runtimeChip(state) {
  switch (state === "failed" ? "error" : state) {
    case "starting":
      return { state: "dispatching", icon: "loader", label: "Starting" };
    case "running":
      return { state: "in_progress", icon: "activity", label: "Running" };
    case "stopped":
      return { state: "queued", icon: "clock", label: "Stopped" };
    case "error":
      return { state: "failed", icon: "alert-triangle", label: "Error" };
    default:
      return unknownChip();
  }
}

/**
 * Built-in coordinator MCP tools reach opencode as `hanse_<name>`; managed web tools as
 * `hanse_web_<name>`. Rendering keys off the normalized name so one renderer covers both the
 * prefixed runtime id and any unprefixed fixture.
 */
export function normalizeToolName(tool) {
  const value = String(tool ?? "");
  return value.startsWith("hanse_") ? value.slice("hanse_".length) : value;
}

export function isHanseTool(tool) {
  return String(tool ?? "").startsWith("hanse_");
}

const HANSE_TOOL_LABELS = {
  ssh_exec: "SSH exec",
  ssh_upload: "SSH upload",
  ssh_download: "SSH download",
  ssh_list_hosts: "SSH hosts",
  request_sibling_change: "Handoff request",
  list_apps: "Apps",
  handoff_status: "Handoff status",
  deliver_handoff: "Handoff reply",
  create_skill: "Create skill",
  list_skills: "Skills",
  get_skill: "Skill",
  update_skill: "Update skill",
  set_skill_enabled: "Toggle skill",
  override_skill: "Override skill",
  preview_open: "Preview",
  preview_close: "Preview close",
  preview_list: "Previews",
  web_search: "Web search",
  web_fetch: "Web fetch",
  list_projects: "Projects",
  get_app: "App",
  get_settings: "Settings",
  set_setting: "Set setting",
  inherit_setting: "Inherit setting",
  start_app: "Start app",
  restart_app: "Restart app",
  create_project: "Create project",
  add_app: "Add app",
  list_dir: "List directory",
  read_file: "Read file",
  write_file: "Write file",
};

export function toolDisplayName(tool) {
  const raw = String(tool ?? "tool");
  if (!isHanseTool(raw)) return raw;
  const name = normalizeToolName(raw);
  return HANSE_TOOL_LABELS[name] ?? name.replaceAll("_", " ");
}

export function parseToolJsonOutput(output) {
  if (typeof output !== "string") return null;
  const trimmed = output.trim();
  if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try {
    const value = JSON.parse(trimmed);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function toolFailure(value) {
  if (!isRecord(value) || value.ok !== false) return null;
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  if (code.length === 0 && message.length === 0) return null;
  return { code, message };
}

export function formatByteCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} ${units[index]}`;
}

export function shortIdentifier(value, length = 8) {
  const text = String(value ?? "");
  return text.length <= length ? text : text.slice(0, length);
}

function inputString(input, key) {
  return isRecord(input) && typeof input[key] === "string" ? input[key] : "";
}

function outputArray(value, key) {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : null;
}

export function toolSummaryText(tool, input, output) {
  const name = normalizeToolName(tool);
  const out = isRecord(output) ? output : null;
  const skill = out !== null && isRecord(out.skill) ? out.skill : null;
  const host = inputString(input, "host_id");
  const withHost = (value) => (host.length > 0 ? `${value} @ ${host}` : value);
  switch (name) {
    case "ssh_exec": {
      const command = inputString(input, "command");
      return command.length > 0 ? withHost(command) : host.length > 0 ? `on ${host}` : null;
    }
    case "ssh_upload": {
      const local = inputString(input, "local_path");
      const remote = inputString(input, "remote_path");
      if (local.length === 0 && remote.length === 0) return null;
      return withHost(`${local || "?"} → ${remote || "?"}`);
    }
    case "ssh_download": {
      const local = inputString(input, "local_path");
      const remote = inputString(input, "remote_path");
      if (local.length === 0 && remote.length === 0) return null;
      return withHost(`${remote || "?"} → ${local || "?"}`);
    }
    case "ssh_list_hosts": {
      if (Array.isArray(output)) return `${output.length} host${output.length === 1 ? "" : "s"}`;
      return "SSH hosts";
    }
    case "request_sibling_change": {
      const to = inputString(input, "to");
      const summary = inputString(input, "summary");
      if (to.length === 0 && summary.length === 0) return null;
      return [to, summary].filter((part) => part.length > 0).join(": ");
    }
    case "list_apps": {
      const apps = out === null ? null : outputArray(out, "apps");
      return apps === null ? "Applications" : `${apps.length} application${apps.length === 1 ? "" : "s"}`;
    }
    case "handoff_status": {
      const handoff = out !== null && isRecord(out.handoff) ? out.handoff : null;
      const id = handoff !== null && typeof handoff.id === "string" ? handoff.id : inputString(input, "id");
      return id.length > 0 ? `#${shortIdentifier(id)}` : null;
    }
    case "deliver_handoff": {
      const id = inputString(input, "id");
      const outcome = inputString(input, "outcome");
      return id.length > 0
        ? `#${shortIdentifier(id)}${outcome.length > 0 ? ` · ${outcome}` : ""}`
        : null;
    }
    case "create_skill":
      return inputString(input, "name") || (skill !== null && typeof skill.name === "string" ? skill.name : null);
    case "get_skill":
    case "update_skill":
    case "set_skill_enabled":
    case "override_skill": {
      if (skill !== null && typeof skill.name === "string" && skill.name.length > 0) return skill.name;
      const id = inputString(input, "skill_id") || inputString(input, "source_skill_id");
      return id.length > 0 ? `skill #${id}` : null;
    }
    case "list_skills": {
      const effective = out === null ? null : outputArray(out, "effective");
      return effective === null
        ? "Skills"
        : `${effective.length} skill${effective.length === 1 ? "" : "s"}`;
    }
    case "preview_list": {
      const previews = out === null ? null : outputArray(out, "previews");
      return previews === null
        ? "Previews"
        : `${previews.length} preview${previews.length === 1 ? "" : "s"}`;
    }
    case "web_search":
      return (out !== null && typeof out.query === "string" ? out.query : "") || inputString(input, "query") || null;
    case "web_fetch":
      return (out !== null && typeof out.url === "string" ? out.url : "") || inputString(input, "url") || null;
    case "list_projects": {
      const projects = out === null ? null : outputArray(out, "projects");
      return projects === null
        ? "Projects"
        : `${projects.length} project${projects.length === 1 ? "" : "s"}`;
    }
    case "get_app": {
      const app = out !== null && isRecord(out.app) ? out.app : null;
      return app !== null && typeof app.appKey === "string"
        ? app.appKey
        : inputString(input, "app_key") || inputString(input, "project_id") || null;
    }
    case "get_settings":
      return inputString(input, "app_key") || inputString(input, "project_id") || "Settings";
    case "set_setting":
    case "inherit_setting":
      return inputString(input, "key") || null;
    case "start_app":
    case "restart_app":
      return inputString(input, "app_key") || inputString(input, "project_id") || null;
    case "create_project": {
      const project = out !== null && isRecord(out.project) ? out.project : null;
      return project !== null && typeof project.name === "string"
        ? project.name
        : inputString(input, "name") || null;
    }
    case "add_app": {
      const app = out !== null && isRecord(out.app) ? out.app : null;
      return app !== null && typeof app.appKey === "string"
        ? app.appKey
        : inputString(input, "app_key") || inputString(input, "name") || null;
    }
    case "list_dir":
      return inputString(input, "path") || "workspace";
    case "read_file":
    case "write_file":
      return inputString(input, "path") || null;
    default:
      return null;
  }
}

export function toolStatusChip(status) {
  switch (status) {
    case "running":
      return { state: "in_progress", icon: "activity", label: "Running" };
    case "completed":
      return { state: "delivered", icon: "check", label: "Completed" };
    case "error":
      return { state: "failed", icon: "alert-triangle", label: "Error" };
    case "pending":
      return { state: "queued", icon: "clock", label: "Pending" };
    default:
      return unknownChip();
  }
}

/**
 * @param {{
 *   waiting?: boolean,
 *   sending?: boolean,
 *   paused?: boolean,
 *   statusType?: string,
 *   runningTool?: string,
 *   unsealedReasoning?: boolean,
 *   unsealedText?: boolean,
 *   queueLength?: number,
 *   activePromptID?: string | null,
 *   queueBlocked?: boolean
 * }} [input]
 * @returns {string}
 */
export function resolveActiveStatusLabel(input) {
  const state = input === null || typeof input !== "object" ? {} : input;
  if (state.waiting === true) return "Waiting for you";
  if (state.sending === true) return "Sending";
  if (state.paused === true) return "Paused";
  if (state.statusType === "retry") return "Retrying";
  if (typeof state.runningTool === "string" && state.runningTool.length > 0) {
    return `Running ${state.runningTool}`;
  }
  if (state.unsealedReasoning === true) return "Thinking";
  if (state.statusType === "busy") {
    return state.unsealedText === true ? "Working" : "Thinking";
  }
  if (
    state.queueBlocked === true &&
    (state.statusType === "idle" ||
      state.statusType === undefined ||
      state.statusType === "unknown")
  ) {
    return "Ready";
  }
  if (
    (typeof state.queueLength === "number" && state.queueLength > 0) ||
    (state.activePromptID !== null && state.activePromptID !== undefined)
  ) {
    return "Working";
  }
  return "Ready";
}

/* ------------------------------------------------------------------------- */
/* Chat interaction helpers                                                  */
/* ------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeEpochMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

/**
 * Primary composer button mode and disabled state.
 *
 * @param {{
 *   turnActive?: boolean,
 *   hasDraft?: boolean,
 *   hasAttachments?: boolean,
 *   attachmentCount?: number,
 *   sessionId?: string | null,
 *   acceptanceBusy?: boolean,
 *   promptsWaiting?: boolean,
 *   abortPending?: boolean
 * }} [input]
 * @returns {{ mode: "stop" | "send", disabled: boolean }}
 */
export function composerAction(input) {
  const state = input === null || typeof input !== "object" ? {} : input;
  const hasAttachments =
    state.hasAttachments === true ||
    (typeof state.attachmentCount === "number" && state.attachmentCount > 0);
  const hasDraft = state.hasDraft === true || hasAttachments;
  const stop =
    state.turnActive === true &&
    hasDraft === false &&
    state.sessionId !== null &&
    state.acceptanceBusy === false;
  const disabled = stop
    ? state.abortPending === true
    : state.acceptanceBusy === true || state.promptsWaiting === true;
  return { mode: stop ? "stop" : "send", disabled };
}

const SLASH_COMMAND_ONLY = /^\/(?!\/)\S*$/;

/**
 * A draft that is only a slash-command token (or a bare `/`) never creates a session or a server
 * draft. A later argument (`/help x`) is ordinary input.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSlashCommandOnly(text) {
  if (typeof text !== "string") return false;
  return SLASH_COMMAND_ONLY.test(text.trim());
}

/**
 * Whitespace-only text is persisted as an empty draft so clearing the composer removes the row.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function draftTextForSave(text) {
  if (typeof text !== "string") return "";
  return text.trim().length === 0 ? "" : text;
}

/**
 * Stage A emptiness: no text and no attachments (attachments arrive in Stage B).
 *
 * @param {{ text?: unknown, attachmentCount?: unknown }} [input]
 * @returns {boolean}
 */
export function draftIsEmpty(input) {
  const state = input === null || typeof input !== "object" ? {} : input;
  const text = typeof state.text === "string" ? state.text.trim() : "";
  const count =
    typeof state.attachmentCount === "number" && Number.isFinite(state.attachmentCount)
      ? Math.max(0, state.attachmentCount)
      : 0;
  return text.length === 0 && count === 0;
}

/**
 * The send guard is `empty text && no attachments`, not empty text alone.
 *
 * @param {{ text?: unknown, attachmentCount?: unknown }} [input]
 * @returns {boolean}
 */
export function canSendDraft(input) {
  return !draftIsEmpty(input);
}

/**
 * Rail/composer badge for the sessions-list augmentation.
 * `emptyDraft` means session_state.has_messages=0 and a draft exists.
 *
 * @param {{ hasText?: unknown, attachmentCount?: unknown, emptyDraft?: unknown } | null} draft
 * @returns {{ label: string, dot: boolean }}
 */
export function sessionDraftBadge(draft) {
  if (draft === null || typeof draft !== "object") return { label: "", dot: false };
  const hasText = draft.hasText === true;
  const hasAttachments =
    typeof draft.attachmentCount === "number" && draft.attachmentCount > 0;
  const present = hasText || hasAttachments;
  return {
    label: present && draft.emptyDraft === true ? "Draft" : "",
    dot: present,
  };
}

/**
 * Normalize the GET /draft `pendingSends` array. Unknown entries and unknown states are dropped or
 * treated as `sending`; Stage A only needs id/text/state.
 *
 * @param {unknown} value
 * @returns {Array<{ id: string, messageID: string | null, text: string, attachments: Array<{ id: string, mode?: "auto" | "inline" | "file" }>, attachmentIDs: string[], state: "sending" | "failed" | "unknown", updatedAt: unknown }>}
 */
export function normalizePendingSends(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
    if (id === null) continue;
    const state =
      raw.state === "failed" || raw.state === "unknown" ? raw.state : "sending";
    const attachments = normalizeAttachmentRefs(
      Array.isArray(raw.attachments) ? raw.attachments : raw.attachmentIDs,
    );
    out.push({
      id,
      messageID: typeof raw.messageID === "string" ? raw.messageID : null,
      text: typeof raw.text === "string" ? raw.text : "",
      attachments,
      attachmentIDs: attachments.map((attachment) => attachment.id),
      state,
      updatedAt: raw.updatedAt ?? null,
    });
  }
  return out;
}

/**
 * Per-state pending-send actions. `sending` is read-only; `failed` can be retried directly;
 * `unknown` retries with `{force:true}` after the explicit "Retry anyway" choice.
 *
 * @param {unknown} state
 * @returns {{ readOnly: boolean, canRetry: boolean, canRestore: boolean, retryLabel: string, force: boolean }}
 */
export function pendingSendActions(state) {
  if (state === "failed") {
    return {
      readOnly: false,
      canRetry: true,
      canRestore: true,
      retryLabel: "Retry",
      force: false,
    };
  }
  if (state === "unknown") {
    return {
      readOnly: false,
      canRetry: true,
      canRestore: false,
      retryLabel: "Retry anyway",
      force: true,
    };
  }
  return {
    readOnly: true,
    canRetry: false,
    canRestore: false,
    retryLabel: "",
    force: false,
  };
}

/**
 * One-line banner label for a pending send.
 *
 * @param {{ state?: unknown, text?: unknown } | null} entry
 * @returns {string}
 */
export function pendingSendLabel(entry) {
  const state = entry === null || typeof entry !== "object" ? "sending" : entry.state;
  const raw = entry !== null && typeof entry === "object" && typeof entry.text === "string"
    ? entry.text.trim().replace(/\s+/g, " ")
    : "";
  const count =
    entry !== null &&
    typeof entry === "object" &&
    Array.isArray(entry.attachments) &&
    entry.attachments.length > 0
      ? entry.attachments.length
      : entry !== null &&
          typeof entry === "object" &&
          Array.isArray(entry.attachmentIDs) &&
          entry.attachmentIDs.length > 0
        ? entry.attachmentIDs.length
        : 0;
  let preview = raw.length === 0 ? "" : `: ${raw.slice(0, 120)}`;
  if (preview.length === 0 && count > 0) {
    preview = `: ${count} ${count === 1 ? "attachment" : "attachments"}`;
  }
  if (state === "failed") return `Failed to send${preview}`;
  if (state === "unknown") return `Delivery unknown${preview}`;
  return `Sending${preview}`;
}

/**
 * Client-side pre-check before POST delete-if-empty. The server re-checks everything; this only
 * avoids a pointless request and never treats a failed read as deletable.
 *
 * @param {{
 *   text?: unknown,
 *   attachmentCount?: unknown,
 *   hasPending?: boolean,
 *   acceptanceBusy?: boolean,
 *   draftLoaded?: boolean,
 *   hasHistory?: boolean
 * }} [input]
 * @returns {boolean}
 */
export function draftAutoDeleteEligible(input) {
  const state = input === null || typeof input !== "object" ? {} : input;
  return (
    draftIsEmpty(state) &&
    state.hasPending !== true &&
    state.acceptanceBusy !== true &&
    state.draftLoaded === true &&
    state.hasHistory !== true
  );
}

/**
 * A keepalive fetch is safe under the browser's ~64 KiB request cap; larger drafts use a normal
 * fetch while the page is alive.
 *
 * @param {unknown} payloadBytes
 * @param {number} [limitBytes]
 * @returns {"keepalive" | "fetch"}
 */
export function flushDraftTransport(payloadBytes, limitBytes = 64 * 1024) {
  if (typeof payloadBytes !== "number" || !Number.isFinite(payloadBytes)) return "fetch";
  return payloadBytes <= limitBytes ? "keepalive" : "fetch";
}

/**
 * Real turn-start time in ms: assistant creation first, activation fallback.
 *
 * @param {unknown} assistantCreated
 * @param {unknown} activated
 * @returns {number | null}
 */
export function elapsedSeed(assistantCreated, activated) {
  return normalizeEpochMs(assistantCreated) ?? normalizeEpochMs(activated);
}

/**
 * @param {unknown} partType
 * @returns {"text" | "reasoning" | null}
 */
export function provisionalPartType(partType) {
  return partType === "text" || partType === "reasoning" ? partType : null;
}

/**
 * Elapsed reasoning time in ms, or null without a finite start.
 *
 * @param {unknown} start
 * @param {unknown} end
 * @param {number} [now]
 * @returns {number | null}
 */
export function reasoningElapsedMs(start, end, now = Date.now()) {
  const startMs = normalizeEpochMs(start);
  if (startMs === null) return null;
  const endMs = normalizeEpochMs(end) ?? (Number.isFinite(now) ? now : Date.now());
  return Math.max(0, endMs - startMs);
}

/**
 * Follow the live bottom unless the frame is a prepend or the feed is unpinned.
 *
 * @param {{ prepend?: boolean, forceBottom?: boolean, pinned?: boolean }} [input]
 * @returns {boolean}
 */
export function autoscrollFollow(input) {
  const state = input === null || typeof input !== "object" ? {} : input;
  return state.prepend !== true && (state.forceBottom === true || state.pinned === true);
}

/**
 * One eased scroll step toward the target, never overshooting it.
 *
 * @param {number} current
 * @param {number} target
 * @param {number} [ease]
 * @returns {number}
 */
export function autoscrollStep(current, target, ease = 0.25) {
  const nextTarget = Number.isFinite(target) ? target : 0;
  const position = Number.isFinite(current) ? current : nextTarget;
  const ratio = Number.isFinite(ease) ? ease : 0.25;
  if (nextTarget - position <= 0.5) return nextTarget;
  return Math.min(nextTarget, position + Math.max(1, (nextTarget - position) * ratio));
}

/**
 * Whether a returning page must replace the app event stream.
 *
 * EventSource cannot prove a socket survived a suspended tab. A missing or CLOSED source is
 * always replaced. A source that stayed hidden long enough may be half-open, so it is replaced
 * too; a short hide leaves an OPEN source alone. A source still CONNECTING after the grace period
 * is replaced because the browser may have stopped retrying it.
 *
 * @param {{ hasSource?: boolean, readyState?: number | null, hiddenMs?: number,
 *   hiddenReconnectMs?: number, connectingReconnectMs?: number }} [input]
 * @returns {boolean}
 */
export function shouldResubscribe(input) {
  const state = input === null || typeof input !== "object" ? {} : input;
  if (state.hasSource !== true) return true;
  if (state.readyState === 2) return true; // EventSource.CLOSED
  const hiddenMs =
    typeof state.hiddenMs === "number" && Number.isFinite(state.hiddenMs)
      ? Math.max(0, state.hiddenMs)
      : 0;
  const hiddenReconnectMs =
    typeof state.hiddenReconnectMs === "number" && Number.isFinite(state.hiddenReconnectMs)
      ? state.hiddenReconnectMs
      : 30000;
  const connectingReconnectMs =
    typeof state.connectingReconnectMs === "number" &&
    Number.isFinite(state.connectingReconnectMs)
      ? state.connectingReconnectMs
      : 5000;
  if (hiddenMs >= hiddenReconnectMs) return true;
  return state.readyState === 0 && hiddenMs >= connectingReconnectMs; // EventSource.CONNECTING
}

/* ------------------------------------------------------------------------- */
/* Context usage                                                             */
/* ------------------------------------------------------------------------- */

/**
 * @typedef {Object} ContextModel
 * @property {string} [providerID]
 * @property {string} [modelID]
 */

/**
 * @typedef {Object} ContextAutoCompact
 * @property {boolean} [enabled]
 * @property {number} [percent]
 * @property {string} [source]
 * @property {string} [percentSource]
 */

/**
 * Design D4 snapshot, read defensively so a missing or partial payload renders as unknown.
 *
 * @typedef {Object} ContextSnapshot
 * @property {"ready" | "unknown" | "compacting" | string} [state]
 * @property {number | null} [used]
 * @property {number | null} [limit]
 * @property {number | null} [percent]
 * @property {ContextModel | null} [model]
 * @property {ContextAutoCompact | null} [autoCompact]
 * @property {string | null} [lastError]
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} snapshot
 * @returns {ContextSnapshot}
 */
function asSnapshot(snapshot) {
  return snapshot !== null && typeof snapshot === "object" ? snapshot : {};
}

/**
 * True when the snapshot carries a usable percentage, computed from used/limit when the
 * server omitted it. May exceed 100; callers clamp only the meter.
 *
 * @param {ContextSnapshot} snapshot
 * @returns {number | null}
 */
function snapshotPercent(snapshot) {
  if (isFiniteNumber(snapshot.percent)) return snapshot.percent;
  if (
    isFiniteNumber(snapshot.used) &&
    isFiniteNumber(snapshot.limit) &&
    snapshot.limit > 0
  ) {
    return Math.round((snapshot.used / snapshot.limit) * 100);
  }
  return null;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatScaled(value) {
  if (value < 10) return value.toFixed(1).replace(/\.0$/, "");
  return String(Math.round(value));
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatFullNumber(value) {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}${String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/**
 * @param {ContextModel | null | undefined} model
 * @returns {string | null}
 */
function contextModelLabel(model) {
  if (model === null || model === undefined || typeof model !== "object") return null;
  const provider = typeof model.providerID === "string" ? model.providerID.trim() : "";
  const id = typeof model.modelID === "string" ? model.modelID.trim() : "";
  if (provider.length === 0 && id.length === 0) return null;
  if (provider.length === 0) return id;
  if (id.length === 0) return provider;
  return `${provider}/${id}`;
}

/**
 * Compact token text: `0`, `999`, `1.2k`, `124k`, `1.2m`. Missing values render as an em dash.
 *
 * @param {number | null | undefined} value
 * @returns {string}
 */
export function formatTokenCount(value) {
  if (!isFiniteNumber(value) || value < 0) return "—";
  const rounded = Math.round(value);
  if (rounded < 1000) return String(rounded);
  if (rounded < 1_000_000) {
    const thousands = rounded / 1000;
    if (thousands < 999.5) return `${formatScaled(thousands)}k`;
  }
  return `${formatScaled(rounded / 1_000_000)}m`;
}

/**
 * Meter width clamped to an integer 0..100. Unknown usage renders as 0.
 *
 * @param {ContextSnapshot | null | undefined} snapshot
 * @returns {number}
 */
export function contextMeterPercent(snapshot) {
  const percent = snapshotPercent(asSnapshot(snapshot));
  if (percent === null) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/**
 * Chip label: `Context 62%`, `Context 124k` when the limit is unknown, `Context —` without usage,
 * or `Compacting` while a summarization is in flight.
 *
 * @param {ContextSnapshot | null | undefined} snapshot
 * @returns {string}
 */
export function contextChipLabel(snapshot) {
  const value = asSnapshot(snapshot);
  if (value.state === "compacting") return "Compacting";
  if (value.state === "unknown") return "Context —";
  const percent = snapshotPercent(value);
  if (percent !== null) return `Context ${Math.round(percent)}%`;
  if (isFiniteNumber(value.used)) return `Context ${formatTokenCount(value.used)}`;
  return "Context —";
}

/**
 * State token used for meter/chip styling: `ok`, `warning` (>=70), `danger` (>=90),
 * `compacting`, or `unknown`.
 *
 * @param {ContextSnapshot | null | undefined} snapshot
 * @returns {"ok" | "warning" | "danger" | "compacting" | "unknown"}
 */
export function contextStateClass(snapshot) {
  const value = asSnapshot(snapshot);
  if (value.state === "compacting") return "compacting";
  if (value.state === "unknown") return "unknown";
  const percent = snapshotPercent(value);
  if (percent === null) return "unknown";
  if (percent >= 90) return "danger";
  if (percent >= 70) return "warning";
  return "ok";
}

/**
 * Rail summary: `62% of 200k`, `124k tokens` when the limit is unknown, or an em dash.
 *
 * @param {ContextSnapshot | null | undefined} snapshot
 * @returns {string}
 */
export function contextSummary(snapshot) {
  const value = asSnapshot(snapshot);
  if (value.state === "unknown") return "—";
  const percent = snapshotPercent(value);
  if (percent !== null && isFiniteNumber(value.limit) && value.limit > 0) {
    return `${Math.round(percent)}% of ${formatTokenCount(value.limit)}`;
  }
  if (isFiniteNumber(value.used)) return `${formatTokenCount(value.used)} tokens`;
  return "—";
}

/**
 * Detail line: `124,000 / 200,000 tokens · provider/model` (tokens only without a limit).
 *
 * @param {ContextSnapshot | null | undefined} snapshot
 * @returns {string}
 */
export function contextDetail(snapshot) {
  const value = asSnapshot(snapshot);
  if (value.state === "unknown" || !isFiniteNumber(value.used)) return "—";
  let tokens = `${formatFullNumber(value.used)} tokens`;
  if (isFiniteNumber(value.limit) && value.limit > 0) {
    tokens = `${formatFullNumber(value.used)} / ${formatFullNumber(value.limit)} tokens`;
  }
  const model = contextModelLabel(value.model);
  return model === null ? tokens : `${tokens} · ${model}`;
}

/**
 * Auto-compaction line: `Auto-compact at 80%` or `Auto-compact off`.
 *
 * @param {ContextSnapshot | null | undefined} snapshot
 * @returns {string}
 */
export function autoCompactText(snapshot) {
  const value = asSnapshot(snapshot);
  const auto = value.autoCompact;
  if (auto === null || auto === undefined || typeof auto !== "object" || auto.enabled !== true) {
    return "Auto-compact off";
  }
  if (isFiniteNumber(auto.percent)) return `Auto-compact at ${Math.round(auto.percent)}%`;
  return "Auto-compact on";
}

const CONTEXT_ERROR_TEXT = {
  compaction_failed: "Compaction failed. Try again.",
  compaction_timeout: "Compaction timed out. Try again.",
  compaction_unavailable: "Compaction unavailable for this session.",
};

/**
 * Map a fixed `lastError` code to human text.
 *
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function contextErrorText(code) {
  if (typeof code === "string" && Object.hasOwn(CONTEXT_ERROR_TEXT, code)) {
    return CONTEXT_ERROR_TEXT[code];
  }
  return "Compaction failed.";
}

/**
 * One session row as the sessions rail consumes it. Extra fields are preserved untouched.
 *
 * @typedef {Object} TreeSession
 * @property {string} id
 * @property {string} [parentID]
 * @property {string} [title]
 * @property {{ created?: number, updated?: number }} [time]
 */

/**
 * @typedef {Object} SessionTree
 * @property {Map<string, TreeSession>} nodes First occurrence per valid string id.
 * @property {Map<string, string[]>} childrenByParent Child ids per parent id, in upstream order.
 * @property {string[]} roots Top-level ids in upstream order; cycle nodes are promoted.
 */

/**
 * A parent link is usable only when it is a non-blank string that is not the node's own id.
 *
 * @param {unknown} value
 * @param {string} id
 * @returns {string | undefined}
 */
function usableParentID(value, id) {
  if (!isRecord(value)) return undefined;
  const parentID = asString(value.parentID);
  if (parentID === undefined || parentID.trim().length === 0 || parentID === id) return undefined;
  return parentID;
}

/**
 * Group a flat session list into a parent/child tree.
 *
 * Invalid ids are skipped and the first occurrence of a duplicate id wins. A node is a root when
 * its `parentID` is missing, blank, not a string, points at itself, or points at an unknown id.
 * Cycles are promoted at the first unreachable node in upstream order, so every valid node is
 * reachable from `roots` and no node is visited twice.
 *
 * @param {unknown} sessions
 * @returns {SessionTree}
 */
export function buildSessionTree(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const nodes = new Map();
  const order = [];
  for (const session of list) {
    if (!isRecord(session)) continue;
    const id = asString(session.id);
    if (id === undefined || id.length === 0 || nodes.has(id)) continue;
    nodes.set(id, session);
    order.push(id);
  }

  const childrenByParent = new Map();
  const rootIDs = new Set();
  for (const id of order) {
    const parentID = usableParentID(nodes.get(id), id);
    if (parentID === undefined || !nodes.has(parentID)) {
      rootIDs.add(id);
      continue;
    }
    const children = childrenByParent.get(parentID);
    if (children === undefined) childrenByParent.set(parentID, [id]);
    else children.push(id);
  }

  const visited = new Set();
  const walk = (start) => {
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      const children = childrenByParent.get(current);
      if (!Array.isArray(children)) continue;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
  };

  for (const id of order) {
    if (rootIDs.has(id)) walk(id);
  }
  for (const id of order) {
    if (visited.has(id)) continue;
    rootIDs.add(id);
    walk(id);
  }

  return {
    nodes,
    childrenByParent,
    roots: order.filter((id) => rootIDs.has(id)),
  };
}

/**
 * The first root in upstream order, or null for an empty or malformed tree.
 *
 * @param {SessionTree | null | undefined} tree
 * @returns {string | null}
 */
export function firstRootId(tree) {
  const roots = tree?.roots;
  if (!Array.isArray(roots) || roots.length === 0) return null;
  return asString(roots[0]) ?? null;
}

/**
 * Ancestor ids of a session, ordered root -> immediate parent. Empty when the id is unknown.
 *
 * @param {SessionTree | null | undefined} tree
 * @param {unknown} id
 * @returns {string[]}
 */
export function ancestorIds(tree, id) {
  const nodes = tree?.nodes instanceof Map ? tree.nodes : new Map();
  const nodeID = asString(id);
  if (nodeID === undefined || nodeID.length === 0 || !nodes.has(nodeID)) return [];
  const ancestors = [];
  const seen = new Set([nodeID]);
  let current = nodeID;
  while (true) {
    const parentID = usableParentID(nodes.get(current), current);
    if (parentID === undefined || !nodes.has(parentID) || seen.has(parentID)) break;
    ancestors.push(parentID);
    seen.add(parentID);
    current = parentID;
  }
  return ancestors.reverse();
}

/**
 * A session id followed by its descendants in upstream order, cycle-safe. The id is always first,
 * even when it is absent from the tree.
 *
 * @param {SessionTree | null | undefined} tree
 * @param {unknown} id
 * @returns {string[]}
 */
export function collectSubtreeIds(tree, id) {
  const nodeID = asString(id);
  if (nodeID === undefined || nodeID.length === 0) return [];
  const childrenByParent = tree?.childrenByParent instanceof Map ? tree.childrenByParent : new Map();
  const collected = [];
  const seen = new Set();
  const stack = [nodeID];
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    collected.push(current);
    const children = childrenByParent.get(current);
    if (!Array.isArray(children)) continue;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return collected;
}
