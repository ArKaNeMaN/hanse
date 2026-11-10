import { createHash } from "node:crypto";
import type { MessageProjector } from "../attachments/projection.js";
import {
  listMessagePage,
  listSessionStatusesStrict,
  type OpencodeMessage,
  type OpencodePart,
  type OpencodeSessionStatus,
  TURN_TAIL_MAX_BYTES,
} from "../opencode/client.js";

export type TurnStatusType = "idle" | "busy" | "retry" | "unknown";

export interface TurnStatus {
  type: TurnStatusType;
  attempt?: number;
  message?: string;
  next?: number;
}

/** The authoritative turn snapshot served by `GET .../turn` (design §4.1). */
export interface TurnSnapshot {
  sessionID: string;
  status: TurnStatus;
  /** The last visible assistant is unfinished or finished with `tool-calls`, and not idle. */
  turnContinues: boolean;
  /** `queuedPromptIDs[0]` only when the status is busy and the turn is not continuing. */
  runningPromptID: string | null;
  /** The running prompt when busy, the queue head when idle, otherwise null. */
  activePromptID: string | null;
  /** Every pending prompt after the boundary, including the head. */
  queuedPromptIDs: string[];
  /** The page budget was exhausted before the boundary was found. */
  queuedTruncated: boolean;
  /** The status changed across the history read even after one retry; suppress the idle queue once. */
  settling: boolean;
  /** Stable hash of the derived turn state. */
  revision: string;
}

export interface DeriveTurnOptions {
  /** A subagent absent from the status map is `unknown`, never idle. */
  isSubagent: boolean;
  /** Status/history were still inconsistent after the bounded retry. */
  settling: boolean;
  /** The tail page budget ended before a boundary was found. */
  queuedTruncated: boolean;
}

const VISIBLE_NON_TEXT_TYPES = new Set(["tool", "reasoning", "patch", "file", "subtask"]);
const ATTACHMENT_MANIFEST_MARKER = "attachment-manifest";
const RESUME_MARKER = "agent-resume";
const SYNTHETIC_READ_PREFIX = "Called the Read tool";
const OMO_INITIATOR_DETECT = /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function partData(part: OpencodePart): Record<string, unknown> {
  return asRecord((part as Record<string, unknown>).data) ?? (part as Record<string, unknown>);
}

function partType(part: OpencodePart): string | undefined {
  return asString(part.type) ?? asString(partData(part).type);
}

function partText(part: OpencodePart): string | undefined {
  return asString(partTextValue(part));
}

function partTextValue(part: OpencodePart): unknown {
  return partData(part).text ?? (part as Record<string, unknown>).text;
}

function partMetadata(part: OpencodePart): Record<string, unknown> | undefined {
  return asRecord(partData(part).metadata);
}

function isIgnoredPart(part: OpencodePart): boolean {
  return part.ignored === true || partData(part).ignored === true;
}

function isSyntheticPart(part: OpencodePart): boolean {
  return part.synthetic === true || partData(part).synthetic === true;
}

function isAttachmentManifestPart(part: OpencodePart): boolean {
  const metadata = partMetadata(part);
  return isSyntheticPart(part) && metadata?.hanse === ATTACHMENT_MANIFEST_MARKER;
}

function isResumePart(part: OpencodePart): boolean {
  return partMetadata(part)?.hanse === RESUME_MARKER;
}

/** Text parts the feed never shows: manifest, auto-resume prompt, and synthetic read text. */
function isHiddenSyntheticTextPart(part: OpencodePart): boolean {
  if (partType(part) !== "text") return false;
  if (isAttachmentManifestPart(part) || isResumePart(part)) return true;
  if (!isSyntheticPart(part)) return false;
  const text = partText(part);
  return text === undefined || text.length === 0 || text.startsWith(SYNTHETIC_READ_PREFIX);
}

function isVisibleTextPart(part: OpencodePart): boolean {
  if (partType(part) !== "text") return false;
  if (isIgnoredPart(part) || isSyntheticPart(part) || isHiddenSyntheticTextPart(part)) {
    return false;
  }
  const text = partText(part);
  return text !== undefined && text.trim().length > 0;
}

function isVisiblePart(part: OpencodePart): boolean {
  if (isVisibleTextPart(part)) return true;
  const type = partType(part);
  return type !== undefined && type !== "text" && VISIBLE_NON_TEXT_TYPES.has(type);
}

function hasVisiblePart(message: OpencodeMessage): boolean {
  return message.parts.some((part) => isVisiblePart(part));
}

function hasContentPart(message: OpencodeMessage): boolean {
  for (const part of message.parts) {
    if (isIgnoredPart(part)) continue;
    if (isVisibleTextPart(part)) return true;
    if (isHiddenSyntheticTextPart(part)) continue;
    const type = partType(part);
    if (type !== undefined && VISIBLE_NON_TEXT_TYPES.has(type)) return true;
  }
  return false;
}

function hasAttachmentPart(message: OpencodeMessage): boolean {
  const hanse = asRecord(message.info.hanse);
  const attachments = hanse?.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) return true;
  return message.parts.some((part) => partType(part) === "file");
}

function isHandoffRow(message: OpencodeMessage): boolean {
  const hanse = asRecord(message.info.hanse);
  return hanse?.handoff !== undefined && hanse.handoff !== null;
}

function isEmptyRow(message: OpencodeMessage): boolean {
  return !hasContentPart(message) && !hasAttachmentPart(message);
}

function isResumeRow(message: OpencodeMessage): boolean {
  return message.parts.some((part) => isResumePart(part));
}

/**
 * Mirrors the client's OMO classification for queue semantics only: a user row whose text parts
 * are all synthetic or carry the OMO internal marker is operator-injected, never a prompt.
 */
function isOmoInternalRow(message: OpencodeMessage): boolean {
  if (isResumeRow(message)) return false;
  const textParts = message.parts.filter((part) => {
    if (partType(part) !== "text" || partText(part) === undefined) return false;
    return !isAttachmentManifestPart(part);
  });
  if (textParts.length === 0) return false;
  return textParts.every((part) => {
    if (isSyntheticPart(part)) return true;
    return OMO_INITIATOR_DETECT.test(partText(part) ?? "");
  });
}

function isNormalUserRow(message: OpencodeMessage): boolean {
  return (
    message.info.role === "user" &&
    !isHandoffRow(message) &&
    !isResumeRow(message) &&
    !isEmptyRow(message) &&
    !isOmoInternalRow(message)
  );
}

function messageID(message: OpencodeMessage): string | undefined {
  const id = message.info.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function normalizeStatus(
  status: OpencodeSessionStatus | undefined,
  isSubagent: boolean,
): TurnStatus {
  if (status === undefined) {
    return isSubagent ? { type: "unknown" } : { type: "idle" };
  }
  const fields: Omit<TurnStatus, "type"> = {
    ...(typeof status.attempt === "number" ? { attempt: status.attempt } : {}),
    ...(typeof status.message === "string" ? { message: status.message } : {}),
    ...(typeof status.next === "number" ? { next: status.next } : {}),
  };
  if (status.type === "idle" || status.type === "busy" || status.type === "retry") {
    return { type: status.type, ...fields };
  }
  return { type: "unknown", ...fields };
}

function sessionIdOf(messages: OpencodeMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = asString(messages[index]?.info.sessionID);
    if (value !== undefined && value.length > 0) return value;
  }
  return "";
}

/** Whether the tail contains any visible assistant; the route pages until this is true. */
export function hasVisibleAssistant(messages: OpencodeMessage[]): boolean {
  return messages.some((message) => message.info.role === "assistant" && hasVisiblePart(message));
}

function turnRevision(input: {
  status: TurnStatus;
  turnContinues: boolean;
  activePromptID: string | null;
  runningPromptID: string | null;
  queuedPromptIDs: string[];
  queuedTruncated: boolean;
}): string {
  const status: unknown[] = [
    input.status.type,
    input.status.attempt ?? null,
    input.status.message ?? null,
    input.status.next ?? null,
  ];
  return createHash("sha256")
    .update(
      JSON.stringify([
        status,
        input.turnContinues,
        input.activePromptID,
        input.runningPromptID,
        input.queuedPromptIDs,
        input.queuedTruncated,
      ]),
    )
    .digest("hex");
}

/**
 * Derive the authoritative turn snapshot from the projected history tail and the upstream status
 * entry. Pure: no I/O, no clock, no database.
 */
export function deriveTurn(
  messages: OpencodeMessage[],
  status: OpencodeSessionStatus | undefined,
  options: DeriveTurnOptions,
): TurnSnapshot {
  let lastVisibleAssistantIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined && message.info.role === "assistant" && hasVisiblePart(message)) {
      lastVisibleAssistantIndex = index;
    }
  }
  const lastVisibleAssistant =
    lastVisibleAssistantIndex >= 0 ? messages[lastVisibleAssistantIndex] : undefined;

  let boundary = lastVisibleAssistantIndex;
  if (lastVisibleAssistant !== undefined) {
    const parentID = asString(lastVisibleAssistant.info.parentID);
    if (parentID !== undefined && parentID.length > 0) {
      const parentIndex = messages.findIndex((message) => message.info.id === parentID);
      if (parentIndex >= 0 && parentIndex < lastVisibleAssistantIndex) {
        const parent = messages[parentIndex];
        if (parent !== undefined && isNormalUserRow(parent)) boundary = parentIndex;
      }
    }
  }

  const queuedPromptIDs: string[] = [];
  for (let index = boundary + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined || message.info.role !== "user") continue;
    if (isHandoffRow(message)) continue;
    if (isResumeRow(message)) {
      queuedPromptIDs.pop();
      continue;
    }
    if (isEmptyRow(message)) continue;
    if (isOmoInternalRow(message)) continue;
    const id = messageID(message);
    if (id !== undefined) queuedPromptIDs.push(id);
  }

  const normalized = normalizeStatus(status, options.isSubagent);
  const time = asRecord(lastVisibleAssistant?.info.time);
  const completed = time?.completed;
  const finish = asString(lastVisibleAssistant?.info.finish);
  const turnContinues =
    lastVisibleAssistant !== undefined &&
    (completed === undefined || completed === null || finish === "tool-calls") &&
    normalized.type !== "idle";

  const runningPromptID =
    normalized.type === "busy" && !turnContinues ? (queuedPromptIDs[0] ?? null) : null;
  const activePromptID =
    normalized.type === "busy"
      ? runningPromptID
      : normalized.type === "idle"
        ? (queuedPromptIDs[0] ?? null)
        : null;

  return {
    sessionID: sessionIdOf(messages),
    status: normalized,
    turnContinues,
    runningPromptID,
    activePromptID,
    queuedPromptIDs,
    queuedTruncated: options.queuedTruncated,
    settling: options.settling,
    revision: turnRevision({
      status: normalized,
      turnContinues,
      activePromptID,
      runningPromptID,
      queuedPromptIDs,
      queuedTruncated: options.queuedTruncated,
    }),
  };
}

const TURN_PAGE_LIMIT = 50;
const TURN_PAGE_BUDGET = 3;

export interface TurnAnswer {
  answerMessageId: string | null;
  answerText: string;
}

export interface CurrentTurnPrompt {
  id: string;
  createdAt?: number;
}

export interface ReadTurnSnapshotOptions {
  /**
   * A known value avoids a second session-list read. A resolver is used by `/turn` when an absent
   * status entry may mean a subagent.
   */
  isSubagent: boolean | ((status: OpencodeSessionStatus | undefined) => Promise<boolean>);
  /** History projector shared with `/turn`; composes attachment and handoff projection. */
  projector?: MessageProjector;
}

export interface TurnSnapshotRead {
  snapshot: TurnSnapshot;
  messages: OpencodeMessage[];
  answerMessageId: string | null;
  answerText: string;
}

interface TurnTail {
  messages: OpencodeMessage[];
  truncated: boolean;
}

function statusPhase(status: OpencodeSessionStatus | undefined): string {
  if (status === undefined) return "idle";
  if (status.type === "idle" || status.type === "busy" || status.type === "retry") {
    return status.type;
  }
  return "unknown";
}

function currentTurnBoundary(
  messages: OpencodeMessage[],
  lastVisibleAssistantIndex: number,
): number {
  const assistant = messages[lastVisibleAssistantIndex];
  const parentID = asString(assistant?.info.parentID);
  if (parentID !== undefined && parentID.length > 0) {
    const parentIndex = messages.findIndex((message) => message.info.id === parentID);
    const parent = parentIndex >= 0 ? messages[parentIndex] : undefined;
    if (
      parent !== undefined &&
      parentIndex < lastVisibleAssistantIndex &&
      isNormalUserRow(parent)
    ) {
      return parentIndex;
    }
  }
  for (let index = lastVisibleAssistantIndex; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && isNormalUserRow(message)) return index;
  }
  return 0;
}

function hasVisibleTextAssistant(messages: OpencodeMessage[]): boolean {
  return messages.some(
    (message) =>
      message.info.role === "assistant" && message.parts.some((part) => isVisibleTextPart(part)),
  );
}

function visibleAssistantText(message: OpencodeMessage): string | undefined {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (!isVisibleTextPart(part)) continue;
    const text = partText(part);
    if (text !== undefined) texts.push(text);
  }
  if (texts.length === 0) return undefined;
  const joined = texts.join("\n\n");
  return joined.trim().length > 0 ? joined : undefined;
}

/**
 * The last assistant with visible text inside the current turn. A trailing tool/reasoning-only
 * assistant is never the answer, and a new turn with no text does not reuse the previous answer.
 */
export function readFinalAnswer(messages: OpencodeMessage[]): TurnAnswer {
  let lastVisibleAssistantIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined && message.info.role === "assistant" && hasVisiblePart(message)) {
      lastVisibleAssistantIndex = index;
    }
  }
  if (lastVisibleAssistantIndex < 0) return { answerMessageId: null, answerText: "" };

  const boundary = currentTurnBoundary(messages, lastVisibleAssistantIndex);
  for (let index = messages.length - 1; index >= boundary; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.info.role !== "assistant") continue;
    const text = visibleAssistantText(message);
    const id = messageID(message);
    if (text !== undefined && id !== undefined) {
      return { answerMessageId: id, answerText: text };
    }
  }
  return { answerMessageId: null, answerText: "" };
}

/** The last non-handoff, non-synthetic user prompt; anchors a tool-only turn occurrence. */
export function currentTurnPrompt(messages: OpencodeMessage[]): CurrentTurnPrompt | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || !isNormalUserRow(message)) continue;
    const id = messageID(message);
    if (id === undefined) continue;
    const created = asRecord(message.info.time)?.created;
    return typeof created === "number" ? { id, createdAt: created } : { id };
  }
  return undefined;
}

async function readTurnTail(
  endpoint: string,
  sessionId: string,
  projector: MessageProjector | undefined,
): Promise<TurnTail> {
  let messages: OpencodeMessage[] = [];
  let before: string | undefined;
  let boundaryFound = false;
  for (let pageIndex = 0; pageIndex < TURN_PAGE_BUDGET; pageIndex += 1) {
    const page = await listMessagePage(endpoint, sessionId, {
      limit: TURN_PAGE_LIMIT,
      ...(before === undefined ? {} : { before }),
      maxBytes: TURN_TAIL_MAX_BYTES,
      ...(projector === undefined ? {} : { project: projector }),
    });
    messages = [...page.messages, ...messages];
    if (hasVisibleTextAssistant(messages)) return { messages, truncated: false };
    if (hasVisibleAssistant(messages)) boundaryFound = true;
    if (page.nextCursor === undefined) return { messages, truncated: false };
    if (pageIndex === TURN_PAGE_BUDGET - 1) break;
    before = page.nextCursor;
  }
  return { messages, truncated: !boundaryFound };
}

/**
 * The single status -> history -> status read shared by `/turn` and the notifier. It pages back to
 * the visible-assistant boundary within the fixed budget and derives both the snapshot and answer
 * from the same message list, so the answer id and body cannot disagree.
 */
export async function readTurnSnapshot(
  endpoint: string,
  sessionId: string,
  options: ReadTurnSnapshotOptions,
): Promise<TurnSnapshotRead> {
  let tail: TurnTail = { messages: [], truncated: false };
  let status: OpencodeSessionStatus | undefined;
  let settling = false;
  for (let attempt = 0; ; attempt += 1) {
    const before = await listSessionStatusesStrict(endpoint);
    tail = await readTurnTail(endpoint, sessionId, options.projector);
    const after = await listSessionStatusesStrict(endpoint);
    const changed = statusPhase(before[sessionId]) !== statusPhase(after[sessionId]);
    status = after[sessionId];
    if (!changed || attempt >= 1) {
      settling = changed && statusPhase(status) === "idle";
      break;
    }
  }

  const isSubagent =
    typeof options.isSubagent === "boolean" ? options.isSubagent : await options.isSubagent(status);
  const snapshot: TurnSnapshot = {
    ...deriveTurn(tail.messages, status, {
      isSubagent,
      settling,
      queuedTruncated: tail.truncated,
    }),
    sessionID: sessionId,
  };
  const answer = readFinalAnswer(tail.messages);
  return {
    snapshot,
    messages: tail.messages,
    answerMessageId: answer.answerMessageId,
    answerText: answer.answerText,
  };
}
