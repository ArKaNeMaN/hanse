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
 * @typedef {Object} MessageRecord
 * @property {string} id
 * @property {"user" | "assistant"} role
 * @property {string} [parentID] Assistant -> last consumed user message.
 * @property {string} [finish] Assistant finish reason.
 * @property {{ created?: number, completed?: number }} [time]
 * @property {"sending" | "queued" | "accepted" | "unknown" | "failed"} [optimistic] Presentation only.
 * @property {OmoSystemMeta} [system] Derived, never persisted.
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
  const textParts = parts.filter(isTextPart);
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
 * @param {{ sessionStatusType?: string }} [status]
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
        (parent.system === undefined || parent.system === null)
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
      const system = classifyOmo(entry);
      if (system !== null) {
        record.system = system;
      }
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
 *   keepOptimistic?: "all" | "transient"
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
  const derived = deriveQueue(store, { sessionStatusType });
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
 *   sessionStatusType?: string
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
  const derived = deriveQueue(nextStore, { sessionStatusType });
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
    (typeof state.queueLength === "number" && state.queueLength > 0) ||
    (state.activePromptID !== null && state.activePromptID !== undefined)
  ) {
    return "Working";
  }
  return "Ready";
}
