import { appStreamBudget, type RawStreamBudget } from "../attachments/budget.js";
import type { EventAttachmentResolver } from "../attachments/projection.js";
import type { AttachmentView } from "../attachments/types.js";
import type { HandoffEventResolver, HandoffMessageMeta } from "../coordinator/handoff-messages.js";
import type { ContextSnapshot } from "./context.js";
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
import type { SessionNoticeView } from "./recovery.js";

export const MAX_SSE_FRAME_BYTES = 1024 * 1024;
/** App-stream parser frame cap: a 20 MiB inline PDF/video fits after base64 (design §D5). */
export const APP_STREAM_MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Post-normalization budget for one typed app event. */
export const MAX_TYPED_EVENT_BYTES = 256 * 1024;
export const MAX_DELTA_BYTES = 64 * 1024;
export const MAX_TEXT_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_PART_EVENT_BYTES = 256 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_PATCH_BYTES = 64 * 1024;
export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_DIFF_EVENT_BYTES = 128 * 1024;
export const MAX_WRITE_CONTENT_BYTES = 64 * 1024;
export const MAX_PATCH_INPUT_BYTES = 64 * 1024;
export const MAX_DIFF_FILES = 50;
export const MAX_DIFF_PATH_BYTES = 1024;
export const MAX_DIFF_PATH_TOTAL_BYTES = 16 * 1024;
export const MAX_TRUNCATED_FIELDS = 32;
export const MAX_TRUNCATED_FIELD_BYTES = 8 * 1024;
export const MAX_PART_STRING_BYTES = 8 * 1024;
export const MAX_PART_ARRAY_ITEMS = 200;
export const MAX_STATUS_MESSAGE = 2_000;
export const MAX_ERROR_NAME_LENGTH = 200;
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

export type SseWarningCode = "frame_too_large" | "stream_budget";
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
  /** Raw bytes reserved for these frames; release after projection. */
  reservedBytes?: number;
}

export interface SseParserOptions {
  maxFrameBytes?: number;
  budget?: RawStreamBudget;
  isPriority?: () => boolean;
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

export type TruncationLimit = "per-file" | "total" | "content" | "patch" | "output" | "files";

export interface Truncation {
  /** Dotted paths that were shortened, for example `state.metadata.output`. */
  fields: string[];
  omittedBytes: number;
  /** Most severe budget that was hit; additive to the existing wire shape. */
  limit?: TruncationLimit;
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

export interface HanseMessageUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

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
      usage?: HanseMessageUsage;
      model?: { providerID: string; modelID: string };
      summary?: boolean;
      attachments?: AttachmentView[];
      handoff?: HandoffMessageMeta;
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
  | {
      type: "session.error";
      sessionID: string;
      name?: string;
      message: string;
    }
  | { type: "session.compacted"; sessionID: string }
  | { type: "notice.created"; notice: SessionNoticeView }
  | { type: "context.updated"; sessionID: string; context: ContextSnapshot }
  | { type: "session.activity"; sessionID: string; cause?: HanseActivityCause }
  | {
      type: "stream.warning";
      code: StreamWarningCode;
      message?: string;
      sessionID?: string;
    };

/** Wire form: every frame carries the per-connection sequence and stream identity. */
export type EnvelopedHanseEvent = HanseEvent & { seq: number; streamID: string };

export interface EventProjectorOptions {
  includeUsage?: boolean;
  attachments?: EventAttachmentResolver;
  handoffs?: HandoffEventResolver;
}

export interface EventStreamOptions {
  signal?: AbortSignal;
  maxFrameBytes?: number;
  includeUsage?: boolean;
  attachments?: EventAttachmentResolver;
  handoffs?: HandoffEventResolver;
  budget?: RawStreamBudget;
  isPriority?: () => boolean;
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

function asTokenCount(value: unknown): number | undefined {
  const count = asFiniteNumber(value);
  return count !== undefined && count >= 0 ? count : undefined;
}

function boundedUsage(tokens: unknown): HanseMessageUsage | undefined {
  const record = asRecord(tokens);
  if (record === undefined) return undefined;
  const input = asTokenCount(record.input);
  const output = asTokenCount(record.output);
  const reasoning = asTokenCount(record.reasoning);
  const cache = asRecord(record.cache);
  const cacheRead = asTokenCount(cache?.read);
  const cacheWrite = asTokenCount(cache?.write);
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return { input, output, reasoning, cacheRead, cacheWrite };
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
  limit?: TruncationLimit;
}

const TRUNCATION_LIMIT_SEVERITY: Record<TruncationLimit, number> = {
  output: 1,
  patch: 2,
  content: 3,
  files: 4,
  "per-file": 5,
  total: 6,
};

function markLimit(bounds: Bounds, limit: TruncationLimit): void {
  if (bounds.limit === undefined) {
    bounds.limit = limit;
    return;
  }
  if (TRUNCATION_LIMIT_SEVERITY[limit] > TRUNCATION_LIMIT_SEVERITY[bounds.limit]) {
    bounds.limit = limit;
  }
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

interface PathBudget {
  remaining: number;
}

/** Cap one path to the per-field limit, then to the remaining total path budget. */
function boundPath(value: string, path: string, bounds: Bounds, budget: PathBudget): string {
  const fieldCapped = boundHeadString(value, MAX_DIFF_PATH_BYTES, path, bounds);
  if (budget.remaining <= 0) {
    if (fieldCapped.length > 0) {
      markTruncated(bounds, path, utf8Bytes(fieldCapped));
      return "";
    }
    return fieldCapped;
  }
  const kept = boundHeadString(fieldCapped, budget.remaining, path, bounds);
  budget.remaining -= utf8Bytes(kept);
  return kept;
}

/** Shorten one diff field and record the matching budget severity. */
function boundDiffString(
  value: string,
  maxBytes: number,
  path: string,
  bounds: Bounds,
  limit: TruncationLimit,
): string {
  const kept = headBytes(value, maxBytes);
  if (kept.length !== value.length) {
    markTruncated(bounds, path, utf8Bytes(value) - utf8Bytes(kept));
    markLimit(bounds, limit);
  }
  return kept;
}

function capTruncatedFields(fields: string[]): string[] {
  if (fields.length <= MAX_TRUNCATED_FIELDS && jsonBytes(fields) <= MAX_TRUNCATED_FIELD_BYTES) {
    return fields;
  }
  const kept: string[] = [];
  for (const field of fields) {
    const candidate = [...kept, field, "more"];
    if (candidate.length > MAX_TRUNCATED_FIELDS) break;
    if (jsonBytes(candidate) > MAX_TRUNCATED_FIELD_BYTES) break;
    kept.push(field);
  }
  return [...kept, "more"];
}

function truncationFor(bounds: Bounds): Truncation | undefined {
  const fields = capTruncatedFields(bounds.fields);
  if (fields.length === 0 && bounds.limit === undefined) return undefined;
  return {
    fields,
    omittedBytes: bounds.omittedBytes,
    ...(bounds.limit === undefined ? {} : { limit: bounds.limit }),
  };
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

function preservesDiffString(path: string, tool: string | undefined): boolean {
  if (path === "state.metadata.diff") {
    return tool === "edit" || tool === "apply_patch";
  }
  if (path === "state.metadata.filediff.patch") return tool === "edit";
  if (/^state\.metadata\.files\[\d+\]\.patch$/.test(path)) return tool === "apply_patch";
  if (path === "state.input.content") return tool === "write";
  if (path === "state.input.patchText") return tool === "apply_patch";
  return path === "data.patch";
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
    if (preservesDiffString(path, tool)) return value;
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

type DiffKind = "per-file" | "combined" | "single" | "write" | "patch" | "none";

interface DiffInfo {
  kind: DiffKind;
}

const DIFF_TOOLS = new Set(["edit", "apply_patch", "write"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return record === undefined ? undefined : { ...record };
}

function sanitizeFileRecord(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of [
    "type",
    "relativePath",
    "movePath",
    "filePath",
    "path",
    "file",
    "oldPath",
    "newPath",
    "additions",
    "deletions",
    "status",
    "index",
  ]) {
    if (record[key] !== undefined) output[key] = record[key];
  }
  if (nonEmptyString(record.patch)) output.patch = record.patch;
  return output;
}

function sanitizeFilediff(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["file", "path", "filePath", "additions", "deletions", "type", "status"]) {
    if (record[key] !== undefined) output[key] = record[key];
  }
  if (nonEmptyString(record.patch)) output.patch = record.patch;
  return output;
}

function selectApplyPatch(metadata: Record<string, unknown>): DiffKind {
  const rawFiles = Array.isArray(metadata.files) ? metadata.files : [];
  const records = rawFiles.map(cloneRecord);
  const everyPatched =
    records.length > 0 &&
    records.every((record) => record !== undefined && nonEmptyString(record.patch));
  const combined = nonEmptyString(metadata.diff);
  if (everyPatched) {
    delete metadata.diff;
  } else if (combined) {
    for (const record of records) {
      if (record !== undefined) delete record.patch;
    }
  }
  const files = records
    .filter((record): record is Record<string, unknown> => record !== undefined)
    .map(sanitizeFileRecord);
  if (Array.isArray(metadata.files) || files.length > 0) metadata.files = files;
  if (everyPatched) return "per-file";
  if (combined) return "combined";
  return files.some((record) => nonEmptyString(record.patch)) ? "per-file" : "none";
}

function selectEdit(metadata: Record<string, unknown>): DiffKind {
  const filediff = asRecord(metadata.filediff);
  const patch = filediff !== undefined && nonEmptyString(filediff.patch);
  const usablePath =
    filediff !== undefined &&
    [filediff.file, filediff.path, filediff.filePath].some(nonEmptyString);
  const combined = nonEmptyString(metadata.diff);
  if (patch && usablePath) {
    delete metadata.diff;
  } else if (combined && filediff !== undefined) {
    delete filediff.patch;
  }
  if (filediff !== undefined) {
    delete filediff.before;
    delete filediff.after;
    const clean = sanitizeFilediff(filediff);
    if (Object.keys(clean).length === 0) delete metadata.filediff;
    else metadata.filediff = clean;
  }
  const keptPatch = filediff !== undefined && nonEmptyString(filediff.patch);
  return combined || keptPatch ? "single" : "none";
}

function sanitizeDiffMetadata(
  metadata: Record<string, unknown>,
  tool: string,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["filepath", "filePath"]) {
    if (typeof metadata[key] === "string") output[key] = metadata[key];
  }
  if (typeof metadata.exists === "boolean") output.exists = metadata.exists;
  if (nonEmptyString(metadata.diff)) output.diff = metadata.diff;
  if (tool === "edit") {
    const filediff = asRecord(metadata.filediff);
    if (filediff !== undefined) {
      const clean = sanitizeFilediff(filediff);
      if (Object.keys(clean).length > 0) output.filediff = clean;
    }
  }
  if (tool === "apply_patch") {
    const files = metadata.files;
    if (Array.isArray(files)) {
      output.files = files.map((record) => {
        const clean = cloneRecord(record);
        return clean === undefined ? record : sanitizeFileRecord(clean);
      });
    }
  }
  return output;
}

function sanitizeDiffInput(
  input: Record<string, unknown>,
  tool: string,
  hasDiff: boolean,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of ["filePath", "path"]) {
    if (typeof input[key] === "string") output[key] = input[key];
  }
  if (tool === "write" && typeof input.content === "string") output.content = input.content;
  if (tool === "apply_patch" && !hasDiff && typeof input.patchText === "string") {
    output.patchText = input.patchText;
  }
  if (tool === "edit") {
    if (input.rename !== undefined) output.rename = input.rename;
    if (input.delete !== undefined) output.delete = input.delete;
  }
  return output;
}

function boundStatePaths(state: Record<string, unknown>, budget: PathBudget, bounds: Bounds): void {
  if (typeof state.title === "string") {
    state.title = boundPath(state.title, "state.title", bounds, budget);
  }
  const input = asRecord(state.input);
  if (input !== undefined) {
    for (const key of ["filePath", "path", "rename"]) {
      if (typeof input[key] === "string") {
        input[key] = boundPath(input[key], `state.input.${key}`, bounds, budget);
      }
    }
  }
  const metadata = asRecord(state.metadata);
  if (metadata !== undefined) {
    for (const key of ["filepath", "filePath"]) {
      if (typeof metadata[key] === "string") {
        metadata[key] = boundPath(metadata[key], `state.metadata.${key}`, bounds, budget);
      }
    }
    const filediff = asRecord(metadata.filediff);
    if (filediff !== undefined) {
      for (const key of ["file", "path", "filePath"]) {
        if (typeof filediff[key] === "string") {
          filediff[key] = boundPath(
            filediff[key],
            `state.metadata.filediff.${key}`,
            bounds,
            budget,
          );
        }
      }
    }
    const files = metadata.files;
    if (Array.isArray(files)) {
      files.forEach((raw, index) => {
        const record = asRecord(raw);
        if (record === undefined) return;
        for (const key of [
          "relativePath",
          "movePath",
          "filePath",
          "path",
          "file",
          "oldPath",
          "newPath",
        ]) {
          if (typeof record[key] === "string") {
            record[key] = boundPath(
              record[key],
              `state.metadata.files[${index}].${key}`,
              bounds,
              budget,
            );
          }
        }
      });
    }
  }
}

function applyDiffCaps(
  state: Record<string, unknown>,
  kind: DiffKind,
  tool: string,
  bounds: Bounds,
): DiffKind {
  const metadata = asRecord(state.metadata);
  const input = asRecord(state.input);
  if (tool === "apply_patch" && metadata !== undefined) {
    const rawFiles = metadata.files;
    let files = Array.isArray(rawFiles) ? rawFiles : [];
    if (files.length > MAX_DIFF_FILES) {
      markTruncated(bounds, "state.metadata.files.length", jsonBytes(files.slice(MAX_DIFF_FILES)));
      files = files.slice(0, MAX_DIFF_FILES);
      metadata.files = files;
      markLimit(bounds, "files");
    }
    if (kind === "combined") {
      if (typeof metadata.diff === "string") {
        metadata.diff = boundDiffString(
          metadata.diff,
          MAX_DIFF_EVENT_BYTES,
          "state.metadata.diff",
          bounds,
          "total",
        );
      }
    } else {
      let sum = 0;
      files.forEach((raw, index) => {
        const record = asRecord(raw);
        if (record === undefined || typeof record.patch !== "string") return;
        const patch = boundDiffString(
          record.patch,
          MAX_DIFF_BYTES,
          `state.metadata.files[${index}].patch`,
          bounds,
          "per-file",
        );
        record.patch = patch;
        sum += utf8Bytes(patch);
      });
      if (sum > MAX_DIFF_EVENT_BYTES) {
        let end = files.length;
        while (end > 0 && sum > MAX_DIFF_EVENT_BYTES) {
          const removed = files[end - 1];
          const record = asRecord(removed);
          if (record !== undefined && typeof record.patch === "string") {
            sum -= utf8Bytes(record.patch);
          }
          end -= 1;
          markTruncated(bounds, "state.metadata.files.length", jsonBytes(removed));
        }
        if (end < files.length) {
          metadata.files = files.slice(0, end);
          markLimit(bounds, "total");
        }
      }
    }
    if (input !== undefined && typeof input.patchText === "string") {
      input.patchText = boundDiffString(
        input.patchText,
        MAX_PATCH_INPUT_BYTES,
        "state.input.patchText",
        bounds,
        "patch",
      );
    }
  }
  if (tool === "edit") {
    if (metadata !== undefined && typeof metadata.diff === "string") {
      metadata.diff = boundDiffString(
        metadata.diff,
        MAX_DIFF_BYTES,
        "state.metadata.diff",
        bounds,
        "per-file",
      );
    }
    const filediff = metadata === undefined ? undefined : asRecord(metadata.filediff);
    if (filediff !== undefined && typeof filediff.patch === "string") {
      filediff.patch = boundDiffString(
        filediff.patch,
        MAX_DIFF_BYTES,
        "state.metadata.filediff.patch",
        bounds,
        "per-file",
      );
    }
  }
  if (tool === "write" && input !== undefined && typeof input.content === "string") {
    input.content = boundDiffString(
      input.content,
      MAX_WRITE_CONTENT_BYTES,
      "state.input.content",
      bounds,
      "content",
    );
  }
  if (tool === "apply_patch" && kind === "none" && input !== undefined) {
    if (typeof input.patchText === "string") return "patch";
  }
  return kind;
}

function normalizeDiffPart(
  part: Record<string, unknown>,
  tool: string,
  bounds: Bounds,
): { part: Record<string, unknown>; diff: DiffInfo } {
  const rawState = asRecord(part.state);
  if (rawState === undefined) return { part, diff: { kind: "none" } };
  const state: Record<string, unknown> = { ...rawState };
  const rawMetadata = asRecord(rawState.metadata);
  const metadata: Record<string, unknown> = rawMetadata === undefined ? {} : { ...rawMetadata };
  if (rawMetadata !== undefined) {
    const filediff = asRecord(rawMetadata.filediff);
    if (filediff !== undefined) metadata.filediff = { ...filediff };
    if (Array.isArray(rawMetadata.files)) {
      metadata.files = rawMetadata.files.map((record) => cloneRecord(record));
    }
  }
  let kind: DiffKind = "none";
  if (tool === "apply_patch") kind = selectApplyPatch(metadata);
  else if (tool === "edit") kind = selectEdit(metadata);
  const hasDiff = kind === "per-file" || kind === "combined" || kind === "single";
  const rawInput = asRecord(rawState.input);
  if (rawInput !== undefined) {
    state.input = sanitizeDiffInput(rawInput, tool, hasDiff);
  }
  state.metadata = sanitizeDiffMetadata(metadata, tool);
  if (tool === "write") {
    const input = asRecord(state.input);
    kind = input !== undefined && typeof input.content === "string" ? "write" : "none";
  }
  const budget: PathBudget = { remaining: MAX_DIFF_PATH_TOTAL_BYTES };
  boundStatePaths(state, budget, bounds);
  kind = applyDiffCaps(state, kind, tool, bounds);
  return { part: { ...part, state }, diff: { kind } };
}

function normalizePatchPart(
  part: Record<string, unknown>,
  bounds: Bounds,
): { part: Record<string, unknown>; diff: DiffInfo } {
  let kind: DiffKind = nonEmptyString(part.patch) ? "patch" : "none";
  const rawData = asRecord(part.data);
  if (rawData === undefined) return { part, diff: { kind } };
  const data: Record<string, unknown> = { ...rawData };
  if (typeof data.patch === "string") {
    data.patch = boundDiffString(data.patch, MAX_PATCH_BYTES, "data.patch", bounds, "patch");
    kind = "patch";
  }
  if (Array.isArray(data.files)) {
    const budget: PathBudget = { remaining: MAX_DIFF_PATH_TOTAL_BYTES };
    let files = data.files;
    if (files.length > MAX_DIFF_FILES) {
      markTruncated(bounds, "data.files.length", jsonBytes(files.slice(MAX_DIFF_FILES)));
      files = files.slice(0, MAX_DIFF_FILES);
      markLimit(bounds, "files");
    }
    data.files = files.map((entry, index) =>
      typeof entry === "string" ? boundPath(entry, `data.files[${index}]`, bounds, budget) : entry,
    );
  }
  return { part: { ...part, data }, diff: { kind } };
}

function boundPart(
  part: Record<string, unknown>,
  partType: PartType,
): { part: Record<string, unknown>; bounds: Bounds; diff: DiffInfo } {
  const tool = asString(part.tool);
  const bounds: Bounds = { fields: [], omittedBytes: 0 };
  let working = part;
  let diff: DiffInfo = { kind: "none" };
  if (partType === "patch") {
    const normalized = normalizePatchPart(working, bounds);
    working = normalized.part;
    diff = normalized.diff;
  } else if (tool !== undefined && DIFF_TOOLS.has(tool)) {
    const normalized = normalizeDiffPart(working, tool, bounds);
    working = normalized.part;
    diff = normalized.diff;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(working)) {
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
        if (typeof value === "string") {
          output.patch = boundHeadString(value, MAX_PATCH_BYTES, key, bounds);
          if (utf8Bytes(value) > MAX_PATCH_BYTES) markLimit(bounds, "patch");
        } else {
          output.patch = boundGeneric(value, key, bounds, tool);
        }
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
  return { part: output, bounds, diff };
}

function dropDiffOutput(part: Record<string, unknown>, bounds: Bounds): boolean {
  const state = asRecord(part.state);
  if (state === undefined) return false;
  let dropped = false;
  if (state.output !== undefined) {
    markTruncated(bounds, "state.output", jsonBytes(state.output));
    delete state.output;
    markLimit(bounds, "output");
    dropped = true;
  }
  const metadata = asRecord(state.metadata);
  if (metadata !== undefined && metadata.output !== undefined) {
    markTruncated(bounds, "state.metadata.output", jsonBytes(metadata.output));
    delete metadata.output;
    markLimit(bounds, "output");
    dropped = true;
  }
  return dropped;
}

function dropLastFileRecord(part: Record<string, unknown>, bounds: Bounds): boolean {
  const state = asRecord(part.state);
  const metadata = state === undefined ? undefined : asRecord(state.metadata);
  const files = metadata === undefined ? undefined : metadata.files;
  if (!Array.isArray(files) || files.length === 0) return false;
  const removed = files.pop();
  markTruncated(bounds, "state.metadata.files.length", jsonBytes(removed));
  markLimit(bounds, "total");
  return true;
}

function boundedReason(reason: string): string {
  if (reason.length <= MAX_REASON_LENGTH) return reason;
  return `${reason.slice(0, MAX_REASON_LENGTH - 3)}...`;
}

/** First line with content; stack traces must never reach the UI. */
function firstNonEmptyLine(value: string): string {
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/** Drop a leading error-class prefix so the short and stack-trace variants dedupe. */
function normalizeErrorMessage(value: string): string {
  return firstNonEmptyLine(value).replace(/^[A-Za-z_$][\w.$]*Error:\s*/, "");
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
  private readonly budget: RawStreamBudget | undefined;
  private readonly isPriority: () => boolean;
  private readonly decoder = new TextDecoder("utf-8");
  private parts: string[] = [];
  private pendingBytes = 0;
  private pendingHasNewline = false;
  private discarding = false;

  constructor(options: SseParserOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
    this.budget = options.budget;
    this.isPriority = options.isPriority ?? (() => false);
  }

  push(chunk: Uint8Array | string): SseParseBatch {
    const chunkBytes =
      typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text.length === 0) return { frames: [], warnings: [] };

    if (this.discarding) {
      return this.resumeAfterSkip(text);
    }

    if (!this.reserve(chunkBytes)) {
      const prefix = headBytes(`${this.parts.join("")}${text}`, IDENTITY_SALVAGE_PREFIX_BYTES);
      const tooLarge = this.pendingBytes + chunkBytes > this.maxFrameBytes;
      this.dropPending();
      this.discarding = true;
      const warnings: SseWarning[] = [
        {
          code: tooLarge ? "frame_too_large" : "stream_budget",
          message: tooLarge
            ? `dropped an SSE frame larger than ${this.maxFrameBytes} bytes`
            : "skipped an SSE frame larger than the stream budget",
          prefix,
        },
      ];
      const resumed = this.resumeAfterSkip(text);
      return { frames: resumed.frames, warnings: [...warnings, ...resumed.warnings] };
    }

    this.parts.push(text);
    this.pendingBytes += chunkBytes;
    if (text.includes("\n")) this.pendingHasNewline = true;
    const batch = this.drain();
    if (this.pendingBytes > this.maxFrameBytes) {
      const prefix = headBytes(this.parts.join(""), IDENTITY_SALVAGE_PREFIX_BYTES);
      this.dropPending();
      this.discarding = true;
      batch.warnings.push({
        code: "frame_too_large",
        message: `dropped an SSE frame larger than ${this.maxFrameBytes} bytes`,
        prefix,
      });
    }
    return batch;
  }

  dispose(): void {
    this.dropPending();
    this.discarding = false;
  }

  flush(): SseParseBatch {
    const tail = this.decoder.decode();
    if (tail.length > 0) {
      this.parts.push(tail);
      this.pendingBytes += Buffer.byteLength(tail, "utf8");
    }
    if (this.parts.length === 0) return { frames: [], warnings: [] };
    if (this.discarding) {
      this.discarding = false;
      this.dropPending();
      return { frames: [], warnings: [] };
    }
    const text = this.takeBuffer();
    const warnings: SseWarning[] = [];
    const frame = this.frameFromBlock(text, warnings);
    const batch: SseParseBatch = { frames: [], warnings };
    if (frame !== undefined) batch.frames.push(frame);
    if (this.budget !== undefined) batch.reservedBytes = Buffer.byteLength(text, "utf8");
    return batch;
  }

  private resumeAfterSkip(text: string): SseParseBatch {
    const normalized = text.replaceAll("\r\n", "\n");
    const index = normalized.indexOf("\n\n");
    if (index < 0) return { frames: [], warnings: [] };
    this.discarding = false;
    const rest = normalized.slice(index + 2);
    if (rest.length === 0) return { frames: [], warnings: [] };
    const bytes = Buffer.byteLength(rest, "utf8");
    if (!this.reserve(bytes)) return { frames: [], warnings: [] };
    this.parts.push(rest);
    this.pendingBytes += bytes;
    return this.drain();
  }

  private drain(): SseParseBatch {
    if (!this.hasSeparator()) {
      this.normalizeCrlfInPending();
      return { frames: [], warnings: [] };
    }
    const text = this.takeBuffer();
    const frames: SseFrame[] = [];
    const warnings: SseWarning[] = [];
    let reservedBytes = 0;
    let cursor = 0;
    for (;;) {
      const index = text.indexOf("\n\n", cursor);
      if (index < 0) break;
      const block = text.slice(cursor, index);
      reservedBytes += Buffer.byteLength(block, "utf8") + 2;
      const frame = this.frameFromBlock(block, warnings);
      if (frame !== undefined) frames.push(frame);
      cursor = index + 2;
    }
    const tail = text.slice(cursor);
    if (tail.length > 0) {
      this.parts = [tail];
      this.pendingBytes = Buffer.byteLength(tail, "utf8");
      this.pendingHasNewline = tail.includes("\n");
    }
    return {
      frames,
      warnings,
      ...(reservedBytes === 0 || this.budget === undefined ? {} : { reservedBytes }),
    };
  }

  private hasSeparator(): boolean {
    if (this.parts.length === 0 || !this.pendingHasNewline) return false;
    return this.parts.join("").replaceAll("\r\n", "\n").includes("\n\n");
  }

  private normalizeCrlfInPending(): void {
    if (this.parts.length === 0) return;
    const last = this.parts[this.parts.length - 1] ?? "";
    if (!last.includes("\r")) return;
    const normalized = this.parts.join("").replaceAll("\r\n", "\n");
    this.parts = [normalized];
    this.pendingBytes = Buffer.byteLength(normalized, "utf8");
  }

  private takeBuffer(): string {
    const text = this.parts.join("").replaceAll("\r\n", "\n");
    this.parts = [];
    this.pendingBytes = 0;
    this.pendingHasNewline = false;
    return text;
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

  private reserve(bytes: number): boolean {
    if (this.budget === undefined) return true;
    return this.budget.tryReserve(bytes, this.isPriority());
  }

  private release(bytes: number): void {
    this.budget?.release(bytes);
  }

  private dropPending(): void {
    if (this.pendingBytes > 0) this.release(this.pendingBytes);
    this.parts = [];
    this.pendingBytes = 0;
    this.pendingHasNewline = false;
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
  private readonly includeUsage: boolean;
  private readonly attachments: EventAttachmentResolver | undefined;
  private readonly handoffs: HandoffEventResolver | undefined;
  private readonly eventIds = new Set<string>();
  private readonly askedKeys = new Set<string>();
  private readonly partTypes = new Map<string, PartType>();
  private readonly sawDelta = new Set<string>();
  private readonly textForwarded = new Set<string>();
  private readonly textSnapshotAt = new Map<string, number>();
  private readonly runningSnapshotAt = new Map<string, number>();
  private readonly toolStatus = new Map<string, string>();
  private readonly lastStatus = new Map<string, HanseSessionStatus["type"]>();
  private readonly lastError = new Map<string, string>();
  private readonly deltaWarned = new Set<string>();

  constructor(options: EventProjectorOptions = {}) {
    this.includeUsage = options.includeUsage === true;
    this.attachments = options.attachments;
    this.handoffs = options.handoffs;
  }

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
      case "session.error":
        return this.sessionError(properties);
      case "session.idle":
        return this.sessionIdle(properties);
      case "session.compacted":
        return this.sessionCompacted(properties);
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
    const event: Extract<HanseEvent, { type: "message.updated" }> = {
      type: "message.updated",
      ...derived,
    };
    if (this.includeUsage) {
      const usage = boundedUsage(info.tokens);
      if (usage !== undefined) event.usage = usage;
      const providerID = asString(info.providerID);
      const modelID = asString(info.modelID);
      if (providerID !== undefined && modelID !== undefined) {
        event.model = {
          providerID: providerID.slice(0, 200),
          modelID: modelID.slice(0, 200),
        };
      }
      if (typeof info.summary === "boolean") event.summary = info.summary;
      if (jsonBytes(event) > MAX_MESSAGE_INFO_BYTES) {
        return this.activity(properties, "unknown");
      }
    }
    const attachments = this.attachments?.attachmentsForMessage(messageID);
    const handoff = role === "user" ? this.handoffs?.handoffForMessage(messageID) : undefined;
    if ((attachments !== undefined && attachments.length > 0) || handoff !== undefined) {
      const enriched: Extract<HanseEvent, { type: "message.updated" }> = { ...event };
      if (attachments !== undefined && attachments.length > 0) enriched.attachments = attachments;
      if (handoff !== undefined) enriched.handoff = handoff;
      if (jsonBytes(enriched) <= MAX_MESSAGE_INFO_BYTES) {
        return [enriched, { type: "session.activity", sessionID, cause: "message" }];
      }
    }
    return [event, { type: "session.activity", sessionID, cause: "message" }];
  }

  private sessionCompacted(properties: Record<string, unknown>): HanseEvent[] {
    const info = asRecord(properties.info);
    const sessionID = asString(properties.sessionID) ?? asString(info?.sessionID);
    if (sessionID === undefined) return this.activity(properties, "unknown");
    return [
      { type: "session.compacted", sessionID },
      { type: "session.activity", sessionID, cause: "status" },
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
    if (type === "busy") this.lastError.delete(sessionID);
    return [event, { type: "session.activity", sessionID, cause: "status" }];
  }

  private sessionError(properties: Record<string, unknown>): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    if (sessionID === undefined) return this.activity(properties, "unknown");

    const error = asRecord(properties.error);
    const errorName = asString(error?.name);
    const errorData = asRecord(error?.data);
    const rawMessage =
      asString(errorData?.message) ??
      asString(error?.message) ??
      asString(properties.message) ??
      errorName ??
      "Agent failed";
    const bounds: Bounds = { fields: [], omittedBytes: 0 };
    const message = boundChars(
      normalizeErrorMessage(rawMessage) || "Agent failed",
      MAX_STATUS_MESSAGE,
      "error.message",
      bounds,
    );
    if (this.lastError.get(sessionID) === message) return [];
    this.rememberMap(this.lastError, sessionID, message);

    const name =
      errorName === undefined
        ? undefined
        : boundChars(errorName, MAX_ERROR_NAME_LENGTH, "error.name", bounds);
    return [
      {
        type: "session.error",
        sessionID,
        message,
        ...(name === undefined ? {} : { name }),
      },
    ];
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

    const sourcePart =
      rawPartType === "file" && this.attachments !== undefined
        ? this.attachments.projectFilePart(part)
        : part;
    const bounded = boundPart(sourcePart, rawPartType);
    const buildEvent = (): HanseEvent => {
      const truncated = truncationFor(bounded.bounds);
      return {
        type: "message.part.updated",
        sessionID,
        messageID,
        partID,
        partType: rawPartType,
        part: bounded.part,
        ...(truncated === undefined ? {} : { truncated }),
      };
    };
    let event = buildEvent();
    if (jsonBytes(event) > MAX_PART_EVENT_BYTES && bounded.diff.kind !== "none") {
      if (dropDiffOutput(bounded.part, bounded.bounds)) event = buildEvent();
    }
    if (jsonBytes(event) > MAX_PART_EVENT_BYTES && bounded.diff.kind !== "none") {
      while (jsonBytes(event) > MAX_PART_EVENT_BYTES) {
        if (!dropLastFileRecord(bounded.part, bounded.bounds)) break;
        event = buildEvent();
      }
    }
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
  const budget = options.budget ?? appStreamBudget;
  const parser = new SseParser({
    maxFrameBytes: options.maxFrameBytes,
    budget,
    isPriority: options.isPriority ?? (() => false),
  });
  const projector = new EventProjector({
    includeUsage: options.includeUsage,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.handoffs === undefined ? {} : { handoffs: options.handoffs }),
  });
  const reader = body.getReader();
  const warned = new Set<string>();
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    parser.dispose();
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
    try {
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
    } finally {
      if (batch.reservedBytes !== undefined) budget.release(batch.reservedBytes);
    }
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

/** Project a raw opencode event envelope without changing its shape. */
export function projectRawEnvelope(
  raw: unknown,
  attachments: EventAttachmentResolver | undefined,
): unknown {
  const event = asRecord(raw);
  if (event === undefined || attachments === undefined) return raw;
  if (asString(event.type) !== "message.part.updated") return raw;
  const properties = asRecord(event.properties);
  const part = asRecord(properties?.part);
  if (properties === undefined || part === undefined) return raw;
  if (asString(part.type) !== "file") return raw;
  return {
    ...event,
    properties: { ...properties, part: attachments.projectFilePart(part) },
  };
}

export interface RawEventStreamOptions extends EventStreamOptions {
  attachments?: EventAttachmentResolver;
}

export interface RawEventStream {
  events: AsyncGenerator<unknown>;
  close(): void;
}

/**
 * Legacy raw-envelope stream: preserves opencode's `{type, properties}` shape while projecting
 * file parts and enforcing the same frame/budget caps as the typed app stream.
 */
export function createRawEventStream(
  body: ReadableStream<Uint8Array>,
  options: RawEventStreamOptions = {},
): RawEventStream {
  const budget = options.budget ?? appStreamBudget;
  const parser = new SseParser({
    maxFrameBytes: options.maxFrameBytes,
    budget,
    isPriority: options.isPriority ?? (() => false),
  });
  const reader = body.getReader();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    parser.dispose();
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => close();
  if (options.signal !== undefined) {
    if (options.signal.aborted) close();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  options.onAttached?.();

  const produce = (batch: SseParseBatch): unknown[] => {
    const output: unknown[] = [];
    try {
      for (const warning of batch.warnings) {
        const identity = warning.prefix === undefined ? {} : salvageIdentity(warning.prefix);
        if (
          identity.sessionID !== undefined &&
          identity.messageID !== undefined &&
          identity.partID !== undefined
        ) {
          output.push({
            type: "message.part.omitted",
            properties: {
              sessionID: identity.sessionID,
              messageID: identity.messageID,
              partID: identity.partID,
              reason: "too_large",
            },
          });
          continue;
        }
        output.push({
          type: "stream.warning",
          properties: {
            code: warning.code,
            message: warning.message,
            ...(identity.sessionID === undefined ? {} : { sessionID: identity.sessionID }),
          },
        });
      }
      for (const frame of batch.frames) {
        let raw: unknown;
        try {
          raw = JSON.parse(frame.data);
        } catch {
          output.push({
            type: "stream.warning",
            properties: { code: "invalid_json", message: "dropped an SSE frame with invalid JSON" },
          });
          continue;
        }
        output.push(projectRawEnvelope(raw, options.attachments));
      }
      return output;
    } finally {
      if (batch.reservedBytes !== undefined) budget.release(batch.reservedBytes);
    }
  };

  async function* iterate(): AsyncGenerator<unknown> {
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
