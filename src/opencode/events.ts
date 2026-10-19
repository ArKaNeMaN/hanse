import {
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTION_DESCRIPTION_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LENGTH,
  MAX_QUESTIONS,
  MAX_TODO_CONTENT,
  MAX_TODOS,
  type NormalizedPermissionRequest,
  type NormalizedQuestion,
  type NormalizedQuestionRequest,
  type NormalizedTodo,
  normalizePermissionRequest,
  normalizeQuestionRequest,
  normalizeTodos,
  type PromptSource,
} from "./prompts.js";

export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
/** App-stream parser frame cap: large enough for a full upstream bash snapshot to reach the caps. */
export const APP_STREAM_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Post-normalization budget for one typed app event. */
export const MAX_TYPED_EVENT_BYTES = 256 * 1024;
export const MAX_DELTA_BYTES = 64 * 1024;
export const MAX_TEXT_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_PART_EVENT_BYTES = 256 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_PATCH_BYTES = 64 * 1024;
export const MAX_PART_STRING_BYTES = 8 * 1024;
export const MAX_PART_ARRAY_ITEMS = 200;
export const MAX_STATUS_MESSAGE = 2_000;
export const MAX_STATUS_ACTION_BYTES = 2 * 1024;
export const MAX_MESSAGE_INFO_BYTES = 8 * 1024;
export const IDENTITY_SALVAGE_PREFIX_BYTES = 64 * 1024;
/** Per-connection bound for part/status tracking maps. */
export const MAX_TRACKED_PART_IDS = 5_000;

const SNAPSHOT_THROTTLE_MS = 100;
const MAX_REASON_LENGTH = 200;
const MAX_ANSWER_GROUPS = 100;
const MAX_ANSWER_VALUES = 100;
const MAX_ANSWER_LENGTH = 2_000;

export type SseWarningCode = "frame_too_large";
export type StreamWarningCode = SseWarningCode | "invalid_json" | "delta_too_large";

export interface SseFrame {
  data: string;
}

export interface SseWarning {
  code: SseWarningCode;
  message: string;
  /** Bounded prefix of the dropped frame, used for best-effort identity salvage. */
  prefix?: string;
}

export interface SseParseBatch {
  frames: SseFrame[];
  warnings: SseWarning[];
}

export interface SseParserOptions {
  maxFrameBytes?: number;
}

export type PartType =
  | "text"
  | "reasoning"
  | "tool"
  | "step-start"
  | "step-finish"
  | "patch"
  | "file"
  | "subtask"
  | "retry"
  | "compaction"
  | "snapshot"
  | "agent";

export interface Truncation {
  /** Dotted paths that were shortened, for example `state.metadata.output`. */
  fields: string[];
  omittedBytes: number;
}

export type BoundedQuestionRequest = NormalizedQuestionRequest & { summary?: string };

export type BoundedPermissionRequest = NormalizedPermissionRequest & {
  tooLarge?: boolean;
  tooLargeReason?: string;
  summary?: string;
};

export interface HanseSessionStatus {
  type: "idle" | "busy" | "retry";
  attempt?: number;
  message?: string;
  next?: number;
  action?: unknown;
}

export type HanseActivityCause = "message" | "status" | "removed" | "unknown";

export type HanseEvent =
  | { type: "stream.ready" }
  | { type: "question.asked"; request: BoundedQuestionRequest }
  | {
      type: "question.replied";
      sessionID: string;
      requestID: string;
      source: PromptSource;
    }
  | {
      type: "question.rejected";
      sessionID: string;
      requestID: string;
      source: PromptSource;
    }
  | { type: "permission.asked"; request: BoundedPermissionRequest }
  | {
      type: "permission.replied";
      sessionID: string;
      requestID: string;
      reply: string;
      source: PromptSource;
    }
  | {
      type: "todo.updated";
      sessionID: string;
      todos: NormalizedTodo[];
      truncated: boolean;
    }
  | {
      type: "message.updated";
      sessionID: string;
      messageID: string;
      role: "user" | "assistant";
      parentID?: string;
      finish?: string;
      time?: { created?: number; completed?: number };
    }
  | {
      type: "message.part.updated";
      sessionID: string;
      messageID: string;
      partID: string;
      partType: PartType;
      part: Record<string, unknown>;
      truncated?: Truncation;
    }
  | {
      type: "message.part.delta";
      sessionID: string;
      messageID: string;
      partID: string;
      field: "text";
      delta: string;
      partType?: "text" | "reasoning";
    }
  | {
      type: "message.part.omitted";
      sessionID: string;
      messageID: string;
      partID: string;
      partType?: PartType;
      reason: "too_large";
    }
  | {
      type: "session.status";
      sessionID: string;
      status: HanseSessionStatus;
      truncated?: Truncation;
    }
  | { type: "session.activity"; sessionID: string; cause?: HanseActivityCause }
  | {
      type: "stream.warning";
      code: StreamWarningCode;
      message?: string;
      sessionID?: string;
    };

/** Wire form: every frame carries the per-connection sequence and stream identity. */
export type EnvelopedHanseEvent = HanseEvent & { seq: number; streamID: string };

export interface EventStreamOptions {
  signal?: AbortSignal;
  maxFrameBytes?: number;
  /** Called after the upstream reader is attached, before any frame is read. */
  onAttached?: () => void;
}

export interface EventStream {
  events: AsyncGenerator<HanseEvent>;
  close(): void;
}

const PART_TYPES = new Set<PartType>([
  "text",
  "reasoning",
  "tool",
  "step-start",
  "step-finish",
  "patch",
  "file",
  "subtask",
  "retry",
  "compaction",
  "snapshot",
  "agent",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPartType(value: string): value is PartType {
  return PART_TYPES.has(value as PartType);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? "");
}

/** Keep the first `maxBytes` UTF-8 bytes without splitting a code point. */
function headBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end] ?? 0) >> 6 === 0b10) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/** Keep the last `maxBytes` UTF-8 bytes without splitting a code point. */
function tailBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] ?? 0) >> 6 === 0b10) start += 1;
  return buffer.subarray(start).toString("utf8");
}

interface Bounds {
  fields: string[];
  omittedBytes: number;
}

function markTruncated(bounds: Bounds, path: string, omittedBytes: number): void {
  if (omittedBytes > 0) bounds.omittedBytes += omittedBytes;
  if (!bounds.fields.includes(path)) bounds.fields.push(path);
}

function boundHeadString(value: string, maxBytes: number, path: string, bounds: Bounds): string {
  const kept = headBytes(value, maxBytes);
  if (kept.length !== value.length) {
    markTruncated(bounds, path, utf8Bytes(value) - utf8Bytes(kept));
  }
  return kept;
}

function boundTailString(value: string, maxBytes: number, path: string, bounds: Bounds): string {
  const kept = tailBytes(value, maxBytes);
  if (kept.length !== value.length) {
    markTruncated(bounds, path, utf8Bytes(value) - utf8Bytes(kept));
  }
  return kept;
}

function boundChars(value: string, maxChars: number, path: string, bounds: Bounds): string {
  if (value.length <= maxChars) return value;
  const kept = value.slice(0, maxChars);
  markTruncated(bounds, path, utf8Bytes(value) - utf8Bytes(kept));
  return kept;
}

function boundQuestions(value: unknown, path: string, bounds: Bounds): unknown {
  if (!Array.isArray(value)) return boundGeneric(value, path, bounds, undefined);
  let questions = value;
  if (value.length > MAX_QUESTIONS) {
    markTruncated(bounds, `${path}.length`, jsonBytes(value.slice(MAX_QUESTIONS)));
    questions = value.slice(0, MAX_QUESTIONS);
  }
  return questions.map((raw, questionIndex) => {
    const question = asRecord(raw);
    const base = `${path}[${questionIndex}]`;
    if (question === undefined) return boundGeneric(raw, base, bounds, undefined);
    const output: Record<string, unknown> = {};
    if (typeof question.header === "string") {
      output.header = boundChars(question.header, MAX_HEADER_LENGTH, `${base}.header`, bounds);
    }
    if (typeof question.question === "string") {
      output.question = boundChars(
        question.question,
        MAX_QUESTION_LENGTH,
        `${base}.question`,
        bounds,
      );
    }
    if (question.options !== undefined) {
      const options = Array.isArray(question.options) ? question.options : [];
      let keptOptions = options;
      if (options.length > MAX_OPTIONS) {
        markTruncated(bounds, `${base}.options.length`, jsonBytes(options.slice(MAX_OPTIONS)));
        keptOptions = options.slice(0, MAX_OPTIONS);
      }
      output.options = keptOptions.map((rawOption, optionIndex) => {
        const option = asRecord(rawOption);
        const optionPath = `${base}.options[${optionIndex}]`;
        if (option === undefined) return boundGeneric(rawOption, optionPath, bounds, undefined);
        const boundedOption: Record<string, unknown> = {};
        if (typeof option.label === "string") {
          boundedOption.label = boundChars(
            option.label,
            MAX_LABEL_LENGTH,
            `${optionPath}.label`,
            bounds,
          );
        }
        if (typeof option.description === "string") {
          boundedOption.description = boundChars(
            option.description,
            MAX_OPTION_DESCRIPTION_LENGTH,
            `${optionPath}.description`,
            bounds,
          );
        }
        for (const [key, item] of Object.entries(option)) {
          if (key !== "label" && key !== "description") {
            boundedOption[key] = boundGeneric(item, `${optionPath}.${key}`, bounds, undefined);
          }
        }
        return boundedOption;
      });
    }
    if (typeof question.multiple === "boolean") output.multiple = question.multiple;
    if (typeof question.custom === "boolean") output.custom = question.custom;
    for (const [key, item] of Object.entries(question)) {
      if (["header", "question", "options", "multiple", "custom"].includes(key)) continue;
      output[key] = boundGeneric(item, `${base}.${key}`, bounds, undefined);
    }
    return output;
  });
}

function boundAnswers(value: unknown, path: string, bounds: Bounds): unknown {
  if (!Array.isArray(value)) return boundGeneric(value, path, bounds, undefined);
  let groups = value;
  if (value.length > MAX_ANSWER_GROUPS) {
    markTruncated(bounds, `${path}.length`, jsonBytes(value.slice(MAX_ANSWER_GROUPS)));
    groups = value.slice(0, MAX_ANSWER_GROUPS);
  }
  return groups.map((group, groupIndex) => {
    if (!Array.isArray(group)) {
      return boundGeneric(group, `${path}[${groupIndex}]`, bounds, undefined);
    }
    let answers = group;
    if (group.length > MAX_ANSWER_VALUES) {
      markTruncated(
        bounds,
        `${path}[${groupIndex}].length`,
        jsonBytes(group.slice(MAX_ANSWER_VALUES)),
      );
      answers = group.slice(0, MAX_ANSWER_VALUES);
    }
    return answers.map((answer, answerIndex) => {
      const answerPath = `${path}[${groupIndex}][${answerIndex}]`;
      if (typeof answer === "string") {
        return boundChars(answer, MAX_ANSWER_LENGTH, answerPath, bounds);
      }
      return boundGeneric(answer, answerPath, bounds, undefined);
    });
  });
}

function boundTodos(value: unknown, path: string, bounds: Bounds): unknown {
  if (!Array.isArray(value)) return boundGeneric(value, path, bounds, undefined);
  let todos = value;
  if (value.length > MAX_TODOS) {
    markTruncated(bounds, `${path}.length`, jsonBytes(value.slice(MAX_TODOS)));
    todos = value.slice(0, MAX_TODOS);
  }
  return todos.map((raw, index) => {
    const todo = asRecord(raw);
    const todoPath = `${path}[${index}]`;
    if (todo === undefined) return boundGeneric(raw, todoPath, bounds, undefined);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(todo)) {
      if (key === "content" && typeof item === "string") {
        output.content = boundChars(item, MAX_TODO_CONTENT, `${todoPath}.content`, bounds);
      } else {
        output[key] = boundGeneric(item, `${todoPath}.${key}`, bounds, undefined);
      }
    }
    return output;
  });
}

function boundGeneric(
  value: unknown,
  path: string,
  bounds: Bounds,
  tool: string | undefined,
): unknown {
  if (typeof value === "string") {
    if (path === "state.metadata.output") {
      return boundTailString(value, MAX_TOOL_OUTPUT_BYTES, path, bounds);
    }
    return boundHeadString(value, MAX_PART_STRING_BYTES, path, bounds);
  }
  if (Array.isArray(value)) {
    if (path === "state.input.questions" && tool === "question") {
      return boundQuestions(value, path, bounds);
    }
    if (path === "state.metadata.answers") return boundAnswers(value, path, bounds);
    if (path === "state.metadata.todos") return boundTodos(value, path, bounds);
    let kept = value;
    if (value.length > MAX_PART_ARRAY_ITEMS) {
      markTruncated(bounds, `${path}.length`, jsonBytes(value.slice(MAX_PART_ARRAY_ITEMS)));
      kept = value.slice(0, MAX_PART_ARRAY_ITEMS);
    }
    return kept.map((item, index) => boundGeneric(item, `${path}[${index}]`, bounds, tool));
  }
  const record = asRecord(value);
  if (record !== undefined) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`;
      output[key] = boundGeneric(item, childPath, bounds, tool);
    }
    return output;
  }
  return value;
}

function boundState(
  state: Record<string, unknown>,
  tool: string | undefined,
  bounds: Bounds,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    const path = `state.${key}`;
    switch (key) {
      case "status":
        output.status =
          typeof value === "string"
            ? boundHeadString(value, MAX_PART_STRING_BYTES, path, bounds)
            : boundGeneric(value, path, bounds, tool);
        break;
      case "title":
        output.title =
          typeof value === "string"
            ? boundHeadString(value, MAX_PART_STRING_BYTES, path, bounds)
            : boundGeneric(value, path, bounds, tool);
        break;
      case "output":
        output.output =
          typeof value === "string"
            ? boundHeadString(value, MAX_TOOL_OUTPUT_BYTES, path, bounds)
            : boundGeneric(value, path, bounds, tool);
        break;
      case "error":
        output.error =
          typeof value === "string"
            ? boundHeadString(value, MAX_PART_STRING_BYTES, path, bounds)
            : boundGeneric(value, path, bounds, tool);
        break;
      default:
        output[key] = boundGeneric(value, path, bounds, tool);
    }
  }
  return output;
}

function boundPart(
  part: Record<string, unknown>,
  partType: PartType,
): { part: Record<string, unknown>; truncated?: Truncation } {
  const tool = asString(part.tool);
  const bounds: Bounds = { fields: [], omittedBytes: 0 };
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(part)) {
    switch (key) {
      case "id":
      case "sessionID":
      case "messageID":
      case "callID":
      case "type":
      case "tool":
        output[key] = value;
        break;
      case "title":
        output.title =
          typeof value === "string"
            ? boundHeadString(value, MAX_PART_STRING_BYTES, key, bounds)
            : boundGeneric(value, key, bounds, tool);
        break;
      case "text":
        output.text =
          typeof value === "string"
            ? boundHeadString(value, MAX_TEXT_SNAPSHOT_BYTES, key, bounds)
            : boundGeneric(value, key, bounds, tool);
        break;
      case "patch":
        output.patch =
          typeof value === "string"
            ? boundHeadString(value, MAX_PATCH_BYTES, key, bounds)
            : boundGeneric(value, key, bounds, tool);
        break;
      case "synthetic":
      case "ignored":
        output[key] = value;
        break;
      case "state": {
        const state = asRecord(value);
        output.state =
          state === undefined
            ? boundGeneric(value, key, bounds, tool)
            : boundState(state, tool, bounds);
        break;
      }
      default:
        output[key] = boundGeneric(value, key, bounds, tool);
    }
  }
  if (partType === undefined) return { part: output };
  return bounds.fields.length === 0
    ? { part: output }
    : {
        part: output,
        truncated: { fields: bounds.fields, omittedBytes: bounds.omittedBytes },
      };
}

function boundedReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  return `${reason.slice(0, MAX_REASON_LENGTH - 3)}...`;
}

function questionSummary(questions: NormalizedQuestion[]): string {
  const first = questions[0];
  if (first === undefined) return "";
  const header = first.header.trim();
  const question = first.question.trim();
  if (header.length > 0 && question.length > 0) {
    return `${header}: ${question}`.slice(0, 500);
  }
  return (header.length > 0 ? header : question).slice(0, 500);
}

function permissionSummary(request: NormalizedPermissionRequest): string {
  const pattern = request.patterns[0] ?? "";
  return [request.permission, pattern]
    .filter((part) => part.length > 0)
    .join(" ")
    .slice(0, 500);
}

function insertBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size <= MAX_TRACKED_PART_IDS) return;
  const oldest = map.keys().next();
  if (!oldest.done) map.delete(oldest.value);
}

function insertBoundedSet(set: Set<string>, value: string): void {
  if (set.has(value)) return;
  set.add(value);
  if (set.size <= MAX_TRACKED_PART_IDS) return;
  const oldest = set.values().next();
  if (!oldest.done) set.delete(oldest.value);
}

/**
 * Parse an upstream SSE byte stream into data frames.
 *
 * The parser is incremental: it keeps the decoder and any partial frame between `push` calls, so
 * chunk boundaries, CRLF pairs, and UTF-8 sequences may split anywhere.
 */
export class SseParser {
  private readonly maxFrameBytes: number;
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private pendingBytes = 0;
  private discarding = false;

  constructor(options: SseParserOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
  }

  push(chunk: Uint8Array | string): SseParseBatch {
    const chunkBytes =
      typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    this.pendingBytes += chunkBytes;
    return this.drain();
  }

  flush(): SseParseBatch {
    const tail = this.decoder.decode();
    if (tail.length > 0) {
      this.buffer += tail;
      this.pendingBytes += Buffer.byteLength(tail, "utf8");
    }
    const batch = this.drain();
    if (this.buffer.length === 0) return batch;
    const block = this.buffer;
    this.buffer = "";
    this.pendingBytes = 0;
    if (this.discarding) {
      this.discarding = false;
      return batch;
    }
    const frame = this.frameFromBlock(block, batch.warnings);
    if (frame !== undefined) batch.frames.push(frame);
    return batch;
  }

  private drain(): SseParseBatch {
    const frames: SseFrame[] = [];
    const warnings: SseWarning[] = [];
    this.buffer = this.buffer.replaceAll("\r\n", "\n");

    for (;;) {
      if (this.discarding) {
        const index = this.buffer.indexOf("\n\n");
        if (index < 0) {
          this.buffer = this.buffer.endsWith("\n") ? "\n" : "";
          this.pendingBytes = Buffer.byteLength(this.buffer, "utf8");
          break;
        }
        this.buffer = this.buffer.slice(index + 2);
        this.pendingBytes = Buffer.byteLength(this.buffer, "utf8");
        this.discarding = false;
        continue;
      }

      const index = this.buffer.indexOf("\n\n");
      if (index < 0) {
        if (this.pendingBytes > this.maxFrameBytes) {
          this.discarding = true;
          warnings.push({
            code: "frame_too_large",
            message: `dropped an SSE frame larger than ${this.maxFrameBytes} bytes`,
            prefix: headBytes(this.buffer, IDENTITY_SALVAGE_PREFIX_BYTES),
          });
          this.buffer = "";
          this.pendingBytes = 0;
        }
        break;
      }

      const block = this.buffer.slice(0, index);
      const consumed = Buffer.byteLength(block, "utf8") + 2;
      this.buffer = this.buffer.slice(index + 2);
      this.pendingBytes = Math.max(0, this.pendingBytes - consumed);
      const frame = this.frameFromBlock(block, warnings);
      if (frame !== undefined) frames.push(frame);
    }

    this.pendingBytes = Buffer.byteLength(this.buffer, "utf8");
    return { frames, warnings };
  }

  private frameFromBlock(block: string, warnings: SseWarning[]): SseFrame | undefined {
    if (Buffer.byteLength(block, "utf8") > this.maxFrameBytes) {
      warnings.push({
        code: "frame_too_large",
        message: `dropped an SSE frame larger than ${this.maxFrameBytes} bytes`,
        prefix: headBytes(block, IDENTITY_SALVAGE_PREFIX_BYTES),
      });
      return undefined;
    }
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    return data.length === 0 ? undefined : { data: data.join("\n") };
  }
}

function matchJsonString(text: string, key: string): string | undefined {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = pattern.exec(text);
  if (match === null) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

interface SalvagedIdentity {
  sessionID?: string;
  messageID?: string;
  partID?: string;
}

/** Best-effort scan of a bounded dropped-frame prefix for part identity. */
function salvageIdentity(prefix: string): SalvagedIdentity {
  const identity: SalvagedIdentity = {};
  const sessionID = matchJsonString(prefix, "sessionID");
  const messageID = matchJsonString(prefix, "messageID");
  let partID = matchJsonString(prefix, "partID");
  if (partID === undefined) {
    const partIndex = prefix.indexOf('"part"');
    if (partIndex >= 0) {
      partID = matchJsonString(prefix.slice(partIndex), "id");
    }
  }
  if (sessionID !== undefined) identity.sessionID = sessionID;
  if (messageID !== undefined) identity.messageID = messageID;
  if (partID !== undefined) identity.partID = partID;
  return identity;
}

/**
 * Project raw `/event` payloads onto the bounded Hanse event vocabulary.
 *
 * v1 and v2 prompts are normalized to the same Hanse names; `source` and `${source}:${id}` keys
 * keep the two APIs from cross-wiring. Duplicate envelope IDs and duplicate asked requests are
 * dropped, and terminal events release the key.
 */
export class EventProjector {
  private readonly eventIds = new Set<string>();
  private readonly askedKeys = new Set<string>();
  private readonly partTypes = new Map<string, PartType>();
  private readonly sawDelta = new Set<string>();
  private readonly textForwarded = new Set<string>();
  private readonly textSnapshotAt = new Map<string, number>();
  private readonly runningSnapshotAt = new Map<string, number>();
  private readonly toolStatus = new Map<string, string>();
  private readonly lastStatus = new Map<string, HanseSessionStatus["type"]>();
  private readonly deltaWarned = new Set<string>();

  project(raw: unknown): HanseEvent[] {
    const event = asRecord(raw);
    if (event === undefined) return [];
    const type = asString(event.type);
    if (type === undefined) return [];

    const envelopeID = asString(event.id);
    if (envelopeID !== undefined) {
      if (this.eventIds.has(envelopeID)) return [];
      this.remember(this.eventIds, envelopeID);
    }

    const properties = asRecord(event.properties) ?? {};
    switch (type) {
      case "question.asked":
        return this.askedQuestion(properties, "v1");
      case "question.v2.asked":
        return this.askedQuestion(properties, "v2");
      case "permission.asked":
        return this.askedPermission(properties, "v1");
      case "permission.v2.asked":
        return this.askedPermission(properties, "v2");
      case "question.replied":
        return this.questionDone(properties, "question.replied", "v1");
      case "question.v2.replied":
        return this.questionDone(properties, "question.replied", "v2");
      case "question.rejected":
        return this.questionDone(properties, "question.rejected", "v1");
      case "question.v2.rejected":
        return this.questionDone(properties, "question.rejected", "v2");
      case "permission.replied":
        return this.permissionDone(properties, "v1");
      case "permission.v2.replied":
        return this.permissionDone(properties, "v2");
      case "todo.updated":
        return this.todoUpdated(properties);
      case "message.updated":
        return this.messageUpdated(properties);
      case "message.part.updated":
        return this.partUpdated(properties);
      case "message.part.delta":
        return this.partDelta(properties);
      case "session.status":
        return this.sessionStatus(properties);
      case "session.idle":
        return this.sessionIdle(properties);
      case "message.part.removed":
      case "message.removed":
        return this.activity(properties, "removed");
      default:
        return this.activity(properties, "unknown");
    }
  }

  private askedQuestion(properties: Record<string, unknown>, source: PromptSource): HanseEvent[] {
    const request = normalizeQuestionRequest(properties, source);
    if (request === undefined) return this.activity(properties, "unknown");
    if (this.askedKeys.has(request.key)) return [];
    this.remember(this.askedKeys, request.key);
    const candidate: HanseEvent = { type: "question.asked", request };
    if (jsonBytes(candidate) <= MAX_TYPED_EVENT_BYTES) return [candidate];

    const reason = boundedReason(
      request.tooLargeReason ?? `event exceeds ${MAX_TYPED_EVENT_BYTES} bytes`,
    );
    const bounded: BoundedQuestionRequest = {
      ...request,
      questions: [],
      tooLarge: true,
      tooLargeReason: reason,
      summary: questionSummary(request.questions),
    };
    const boundedEvent: HanseEvent = { type: "question.asked", request: bounded };
    if (jsonBytes(boundedEvent) <= MAX_TYPED_EVENT_BYTES) return [boundedEvent];

    const minimal: BoundedQuestionRequest = {
      ...request,
      questions: [],
      tooLarge: true,
      tooLargeReason: reason,
    };
    const minimalEvent: HanseEvent = { type: "question.asked", request: minimal };
    if (jsonBytes(minimalEvent) <= MAX_TYPED_EVENT_BYTES) return [minimalEvent];
    return this.activity({ sessionID: request.sessionID }, "unknown");
  }

  private askedPermission(properties: Record<string, unknown>, source: PromptSource): HanseEvent[] {
    const request = normalizePermissionRequest(properties, source);
    if (request === undefined) return this.activity(properties, "unknown");
    if (this.askedKeys.has(request.key)) return [];
    this.remember(this.askedKeys, request.key);
    const candidate: HanseEvent = { type: "permission.asked", request };
    if (jsonBytes(candidate) <= MAX_TYPED_EVENT_BYTES) return [candidate];

    const reason = boundedReason(`event exceeds ${MAX_TYPED_EVENT_BYTES} bytes`);
    const bounded: BoundedPermissionRequest = {
      ...request,
      patterns: [],
      always: [],
      metadata: {},
      tooLarge: true,
      tooLargeReason: reason,
      summary: permissionSummary(request),
    };
    const boundedEvent: HanseEvent = { type: "permission.asked", request: bounded };
    if (jsonBytes(boundedEvent) <= MAX_TYPED_EVENT_BYTES) return [boundedEvent];

    const minimal: BoundedPermissionRequest = {
      ...request,
      patterns: [],
      always: [],
      metadata: {},
      tooLarge: true,
      tooLargeReason: reason,
    };
    const minimalEvent: HanseEvent = { type: "permission.asked", request: minimal };
    if (jsonBytes(minimalEvent) <= MAX_TYPED_EVENT_BYTES) return [minimalEvent];
    return this.activity({ sessionID: request.sessionID }, "unknown");
  }

  private questionDone(
    properties: Record<string, unknown>,
    type: "question.replied" | "question.rejected",
    source: PromptSource,
  ): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    const requestID = asString(properties.requestID);
    if (sessionID === undefined || requestID === undefined) {
      return this.activity(properties, "unknown");
    }
    this.askedKeys.delete(`${source}:${requestID}`);
    return [{ type, sessionID, requestID, source }];
  }

  private permissionDone(properties: Record<string, unknown>, source: PromptSource): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    const requestID = asString(properties.requestID);
    const reply = asString(properties.reply);
    if (sessionID === undefined || requestID === undefined || reply === undefined) {
      return this.activity(properties, "unknown");
    }
    this.askedKeys.delete(`${source}:${requestID}`);
    return [{ type: "permission.replied", sessionID, requestID, reply, source }];
  }

  private todoUpdated(properties: Record<string, unknown>): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    if (sessionID === undefined) return this.activity(properties, "unknown");
    const { todos, truncated } = normalizeTodos(properties.todos);
    let kept = todos;
    let isTruncated = truncated;
    const build = (): HanseEvent => ({
      type: "todo.updated",
      sessionID,
      todos: kept,
      truncated: isTruncated,
    });
    while (kept.length > 0) {
      const size = jsonBytes(build());
      if (size <= MAX_TYPED_EVENT_BYTES) break;
      const overflow = size - MAX_TYPED_EVENT_BYTES;
      const itemSize = Math.max(1, jsonBytes(kept[kept.length - 1]));
      const drop = Math.max(1, Math.ceil(overflow / itemSize));
      kept = kept.slice(0, Math.max(0, kept.length - drop));
      isTruncated = true;
    }
    if (jsonBytes(build()) > MAX_TYPED_EVENT_BYTES) {
      return this.activity({ sessionID }, "unknown");
    }
    return [build()];
  }

  private messageUpdated(properties: Record<string, unknown>): HanseEvent[] {
    const info = asRecord(properties.info);
    if (info === undefined) return this.activity(properties, "unknown");
    const messageID = asString(info.id);
    const role = info.role === "user" || info.role === "assistant" ? info.role : undefined;
    const sessionID = asString(info.sessionID) ?? asString(properties.sessionID);
    if (messageID === undefined || role === undefined || sessionID === undefined) {
      return this.activity(properties, "unknown");
    }

    const parentID = asString(info.parentID);
    const finish = asString(info.finish);
    const time = asRecord(info.time);
    const created = asFiniteNumber(time?.created);
    const completed = asFiniteNumber(time?.completed);
    const derived: {
      sessionID: string;
      messageID: string;
      role: "user" | "assistant";
      parentID?: string;
      finish?: string;
      time?: { created?: number; completed?: number };
    } = { sessionID, messageID, role };
    if (parentID !== undefined) derived.parentID = parentID.slice(0, 200);
    if (finish !== undefined) derived.finish = finish.slice(0, 32);
    if (created !== undefined || completed !== undefined) {
      const boundedTime: { created?: number; completed?: number } = {};
      if (created !== undefined) boundedTime.created = created;
      if (completed !== undefined) boundedTime.completed = completed;
      derived.time = boundedTime;
    }
    if (jsonBytes(derived) > MAX_MESSAGE_INFO_BYTES) {
      return this.activity(properties, "unknown");
    }
    return [
      { type: "message.updated", ...derived },
      { type: "session.activity", sessionID, cause: "message" },
    ];
  }

  private sessionStatus(properties: Record<string, unknown>): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    if (sessionID === undefined) return this.activity(properties, "unknown");
    const raw = asRecord(properties.status);
    if (raw === undefined) return this.activity(properties, "unknown");
    const type = raw.type;
    if (type !== "idle" && type !== "busy" && type !== "retry") {
      return this.activity(properties, "unknown");
    }
    const bounds: Bounds = { fields: [], omittedBytes: 0 };
    const status: HanseSessionStatus = { type };
    const attempt = asFiniteNumber(raw.attempt);
    if (attempt !== undefined) status.attempt = attempt;
    const next = asFiniteNumber(raw.next);
    if (next !== undefined) status.next = next;
    const message = asString(raw.message);
    if (message !== undefined) {
      status.message = boundChars(message, MAX_STATUS_MESSAGE, "status.message", bounds);
    }
    if (raw.action !== undefined) {
      const actionBytes = jsonBytes(raw.action);
      if (actionBytes > MAX_STATUS_ACTION_BYTES) {
        markTruncated(bounds, "status.action", actionBytes);
      } else {
        status.action = raw.action;
      }
    }
    const event: HanseEvent =
      bounds.fields.length === 0
        ? { type: "session.status", sessionID, status }
        : {
            type: "session.status",
            sessionID,
            status,
            truncated: { fields: bounds.fields, omittedBytes: bounds.omittedBytes },
          };
    this.rememberStatus(sessionID, type);
    return [event, { type: "session.activity", sessionID, cause: "status" }];
  }

  private sessionIdle(properties: Record<string, unknown>): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    if (sessionID === undefined) return this.activity(properties, "unknown");
    if (this.lastStatus.get(sessionID) === "idle") return [];
    this.rememberStatus(sessionID, "idle");
    return [
      { type: "session.status", sessionID, status: { type: "idle" } },
      { type: "session.activity", sessionID, cause: "status" },
    ];
  }

  private partUpdated(properties: Record<string, unknown>): HanseEvent[] {
    const part = asRecord(properties.part);
    if (part === undefined) return this.activity(properties, "unknown");
    const partID = asString(part.id);
    const rawPartType = asString(part.type);
    const propertySessionID = asString(properties.sessionID);
    const partSessionID = asString(part.sessionID);
    const propertyMessageID = asString(properties.messageID);
    const partMessageID = asString(part.messageID);
    const sessionID = partSessionID;
    const messageID = partMessageID;
    if (partID === undefined || rawPartType === undefined) {
      return this.activity(properties, "unknown");
    }
    if (sessionID === undefined || messageID === undefined) {
      return this.activity(properties, "unknown");
    }
    if (propertySessionID !== undefined && propertySessionID !== partSessionID) {
      return this.activity(properties, "unknown");
    }
    if (
      propertyMessageID !== undefined &&
      partMessageID !== undefined &&
      propertyMessageID !== partMessageID
    ) {
      return this.activity(properties, "unknown");
    }
    if (!isPartType(rawPartType)) return this.activity(properties, "unknown");

    this.rememberMap(this.partTypes, partID, rawPartType);
    const textual = rawPartType === "text" || rawPartType === "reasoning";
    if (
      textual &&
      typeof part.text === "string" &&
      utf8Bytes(part.text) > MAX_TEXT_SNAPSHOT_BYTES
    ) {
      return [];
    }
    if (!this.shouldForwardSnapshot(part, rawPartType, partID)) return [];

    const { part: boundedPart, truncated } = boundPart(part, rawPartType);
    const event: HanseEvent = {
      type: "message.part.updated",
      sessionID,
      messageID,
      partID,
      partType: rawPartType,
      part: boundedPart,
      ...(truncated === undefined ? {} : { truncated }),
    };
    if (jsonBytes(event) > MAX_PART_EVENT_BYTES) {
      return [
        {
          type: "message.part.omitted",
          sessionID,
          messageID,
          partID,
          partType: rawPartType,
          reason: "too_large",
        },
      ];
    }
    return [event];
  }

  private partDelta(properties: Record<string, unknown>): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    const messageID = asString(properties.messageID);
    const partID = asString(properties.partID);
    if (sessionID === undefined || messageID === undefined || partID === undefined) {
      return this.activity(properties, "unknown");
    }
    if (properties.field !== "text") return [];
    const delta = asString(properties.delta);
    if (delta === undefined) return [];
    if (utf8Bytes(delta) > MAX_DELTA_BYTES) {
      if (this.deltaWarned.has(sessionID)) return [];
      this.rememberSet(this.deltaWarned, sessionID);
      return [
        {
          type: "stream.warning",
          code: "delta_too_large",
          sessionID,
          message: `dropped a text delta larger than ${MAX_DELTA_BYTES} bytes`,
        },
      ];
    }
    this.rememberSet(this.sawDelta, partID);
    const partType = this.partTypes.get(partID);
    return [
      {
        type: "message.part.delta",
        sessionID,
        messageID,
        partID,
        field: "text",
        delta,
        ...(partType === "text" || partType === "reasoning" ? { partType } : {}),
      },
    ];
  }

  private shouldForwardSnapshot(
    part: Record<string, unknown>,
    partType: PartType,
    partID: string,
  ): boolean {
    const now = Date.now();
    if (partType === "text" || partType === "reasoning") {
      const completion = asFiniteNumber(asRecord(part.time)?.end) !== undefined;
      const forwarded = this.textForwarded.has(partID);
      if (this.sawDelta.has(partID)) {
        if (completion || !forwarded) {
          this.rememberSet(this.textForwarded, partID);
          return true;
        }
        return false;
      }
      if (completion) {
        this.rememberSet(this.textForwarded, partID);
        return true;
      }
      const last = this.textSnapshotAt.get(partID);
      if (last !== undefined && now - last < SNAPSHOT_THROTTLE_MS) return false;
      this.rememberMap(this.textSnapshotAt, partID, now);
      return true;
    }

    const state = asRecord(part.state);
    const status = asString(state?.status);
    if (status === "completed" || status === "error") {
      this.rememberMap(this.toolStatus, partID, status);
      return true;
    }
    const lastStatus = this.toolStatus.get(partID);
    if (status !== lastStatus) {
      this.rememberMap(this.toolStatus, partID, status ?? "");
      if (status === "running") this.rememberMap(this.runningSnapshotAt, partID, now);
      return true;
    }
    if (status === "running" || status === undefined) {
      const last = this.runningSnapshotAt.get(partID);
      if (last !== undefined && now - last < SNAPSHOT_THROTTLE_MS) return false;
      this.rememberMap(this.runningSnapshotAt, partID, now);
      return true;
    }
    return false;
  }

  private rememberStatus(sessionID: string, status: HanseSessionStatus["type"]): void {
    this.rememberMap(this.lastStatus, sessionID, status);
  }

  private activity(properties: Record<string, unknown>, cause: HanseActivityCause): HanseEvent[] {
    const sessionID = extractSessionID(properties);
    return sessionID === undefined ? [] : [{ type: "session.activity", sessionID, cause }];
  }

  private remember(set: Set<string>, value: string): void {
    this.rememberSet(set, value);
  }

  private rememberSet(set: Set<string>, value: string): void {
    insertBoundedSet(set, value);
  }

  private rememberMap<K, V>(map: Map<K, V>, key: K, value: V): void {
    insertBounded(map, key, value);
  }
}

function extractSessionID(properties: Record<string, unknown>): string | undefined {
  const direct = asString(properties.sessionID);
  if (direct !== undefined) return direct;
  const info = asRecord(properties.info);
  const infoSession = asString(info?.sessionID);
  if (infoSession !== undefined) return infoSession;
  const infoID = asString(info?.id);
  if (infoID !== undefined) return infoID;
  const part = asRecord(properties.part);
  return asString(part?.sessionID);
}

/**
 * Consume an upstream SSE body and yield projected Hanse events.
 *
 * The reader is attached synchronously, so `onAttached` is the correct place for a route to emit
 * `stream.ready`. Aborting the signal cancels the upstream reader.
 */
export function createEventStream(
  body: ReadableStream<Uint8Array>,
  options: EventStreamOptions = {},
): EventStream {
  const parser = new SseParser({ maxFrameBytes: options.maxFrameBytes });
  const projector = new EventProjector();
  const reader = body.getReader();
  const warned = new Set<string>();
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => close();
  if (options.signal !== undefined) {
    if (options.signal.aborted) close();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  options.onAttached?.();

  const warningKey = (code: StreamWarningCode, sessionID: string | undefined): string =>
    `${code}:${sessionID ?? ""}`;

  const produce = (batch: SseParseBatch): HanseEvent[] => {
    const output: HanseEvent[] = [];
    for (const warning of batch.warnings) {
      const identity = warning.prefix === undefined ? {} : salvageIdentity(warning.prefix);
      if (
        identity.sessionID !== undefined &&
        identity.messageID !== undefined &&
        identity.partID !== undefined
      ) {
        output.push({
          type: "message.part.omitted",
          sessionID: identity.sessionID,
          messageID: identity.messageID,
          partID: identity.partID,
          reason: "too_large",
        });
        continue;
      }
      const key = warningKey(warning.code, identity.sessionID);
      if (warned.has(key)) continue;
      warned.add(key);
      output.push({
        type: "stream.warning",
        code: warning.code,
        message: warning.message,
        ...(identity.sessionID === undefined ? {} : { sessionID: identity.sessionID }),
      });
    }
    for (const frame of batch.frames) {
      let raw: unknown;
      try {
        raw = JSON.parse(frame.data);
      } catch {
        const key = warningKey("invalid_json", undefined);
        if (warned.has(key)) continue;
        warned.add(key);
        output.push({
          type: "stream.warning",
          code: "invalid_json",
          message: "dropped an SSE frame with invalid JSON",
        });
        continue;
      }
      output.push(...projector.project(raw));
    }
    return output;
  };

  async function* iterate(): AsyncGenerator<HanseEvent> {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        for (const event of produce(parser.push(value))) yield event;
      }
      if (!closed) {
        for (const event of produce(parser.flush())) yield event;
      }
    } catch {
      // Abort and upstream read failures both end the stream.
    } finally {
      close();
    }
  }

  return { events: iterate(), close };
}
