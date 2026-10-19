import type {
  OpencodePermissionRequest,
  OpencodePermissionV2Request,
  OpencodeQuestionRequest,
  OpencodeSavedPermission,
  OpencodeTodo,
  OpencodeToolRef,
} from "./client.js";

/** Where a prompt came from upstream. */
export type PromptSource = "v1" | "v2";

export const MAX_PROMPTS_PER_KIND = 50;
export const MAX_TODOS = 200;
export const MAX_TODO_CONTENT = 8_000;
export const MAX_QUESTIONS = 100;
export const MAX_OPTIONS = 100;
export const MAX_LABELS = 100;
export const MAX_LABEL_LENGTH = 2_000;
export const MAX_OPTION_DESCRIPTION_LENGTH = 4_000;
export const MAX_FEEDBACK_LENGTH = 4_000;
export const MAX_HEADER_LENGTH = 200;
export const MAX_QUESTION_LENGTH = 10_000;
export const MAX_METADATA_DEPTH = 3;
export const MAX_METADATA_KEYS = 50;
export const MAX_METADATA_ARRAY = 50;
export const MAX_METADATA_STRING = 4_000;
const MAX_TOO_LARGE_REASON = 200;

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled" | "unknown";
export type TodoPriority = "high" | "medium" | "low" | "unknown";

export interface NormalizedQuestionOption {
  label: string;
  description: string;
}

export interface NormalizedQuestion {
  header: string;
  question: string;
  options: NormalizedQuestionOption[];
  multiple: boolean;
  custom: boolean;
}

export interface NormalizedQuestionRequest {
  /** Stable key for maps/tombstones: `${source}:${id}`. */
  key: string;
  id: string;
  sessionID: string;
  questions: NormalizedQuestion[];
  source: PromptSource;
  tool?: OpencodeToolRef;
  tooLarge: boolean;
  tooLargeReason?: string;
}

export interface NormalizedPermissionRequest {
  /** Stable key for maps/tombstones: `${source}:${id}`. */
  key: string;
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, NormalizedMetadataValue>;
  always: string[];
  source: PromptSource;
  tool?: OpencodeToolRef;
}

export interface NormalizedTodo {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export interface NormalizedSavedPermission {
  id: string;
  projectID: string;
  action: string;
  resource: string;
}

export type NormalizedMetadataValue =
  | string
  | number
  | boolean
  | null
  | NormalizedMetadataValue[]
  | { [key: string]: NormalizedMetadataValue };

export interface NormalizedList<T> {
  items: T[];
  truncated: boolean;
}

export interface NormalizedTodos {
  todos: NormalizedTodo[];
  truncated: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function toolRef(value: unknown): OpencodeToolRef | undefined {
  const record = asRecord(value);
  return record === undefined ? undefined : { ...record };
}

function boundedReason(reason: string): string {
  if (reason.length <= MAX_TOO_LARGE_REASON) return reason;
  return `${reason.slice(0, MAX_TOO_LARGE_REASON - 3)}...`;
}

/**
 * Normalize a v1/v2 question request.
 *
 * Text and option/question lists are never truncated: a request that exceeds a documented cap is
 * marked `tooLarge` so callers can render a Dismiss-only card instead of sending misaligned answers.
 * Returns `undefined` when the minimum identity fields are missing.
 */
export function normalizeQuestionRequest(
  input: unknown,
  source: PromptSource,
): NormalizedQuestionRequest | undefined {
  const request = asRecord(input);
  if (request === undefined) return undefined;
  const id = asString(request.id);
  const sessionID = asString(request.sessionID);
  if (id === undefined || sessionID === undefined) return undefined;

  const questions: NormalizedQuestion[] = [];
  const rawQuestions = Array.isArray(request.questions) ? request.questions : [];
  let reason: string | undefined;
  if (rawQuestions.length > MAX_QUESTIONS) {
    reason ??= `request has more than ${MAX_QUESTIONS} questions`;
  }

  rawQuestions.forEach((rawQuestion, index) => {
    const question = asRecord(rawQuestion) ?? {};
    const header = asString(question.header) ?? "";
    const text = asString(question.question) ?? "";
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    if (rawOptions.length > MAX_OPTIONS) {
      reason ??= `question ${index + 1} has more than ${MAX_OPTIONS} options`;
    }
    if (header.length > MAX_HEADER_LENGTH) {
      reason ??= `question ${index + 1} header exceeds ${MAX_HEADER_LENGTH} characters`;
    }
    if (text.length > MAX_QUESTION_LENGTH) {
      reason ??= `question ${index + 1} text exceeds ${MAX_QUESTION_LENGTH} characters`;
    }
    const options: NormalizedQuestionOption[] = rawOptions.map((rawOption) => {
      const option = asRecord(rawOption) ?? {};
      const label = asString(option.label) ?? "";
      const description = asString(option.description) ?? "";
      if (label.length > MAX_LABEL_LENGTH) {
        reason ??= `question ${index + 1} option label exceeds ${MAX_LABEL_LENGTH} characters`;
      }
      if (description.length > MAX_OPTION_DESCRIPTION_LENGTH) {
        reason ??= `question ${index + 1} option description exceeds ${MAX_OPTION_DESCRIPTION_LENGTH} characters`;
      }
      return { label, description };
    });
    questions.push({
      header,
      question: text,
      options,
      multiple: asBoolean(question.multiple) ?? false,
      custom: asBoolean(question.custom) ?? true,
    });
  });

  return {
    key: `${source}:${id}`,
    id,
    sessionID,
    questions,
    source,
    tool: toolRef(request.tool),
    tooLarge: reason !== undefined,
    ...(reason === undefined ? {} : { tooLargeReason: boundedReason(reason) }),
  };
}

/**
 * Normalize a v1 permission request or a v2 permission request.
 *
 * v2 maps `action` -> `permission`, `resources` -> `patterns`, `save` -> `always`, and
 * `source` -> `tool`.
 */
export function normalizePermissionRequest(
  input: unknown,
  source: PromptSource,
): NormalizedPermissionRequest | undefined {
  const request = asRecord(input);
  if (request === undefined) return undefined;
  const id = asString(request.id);
  const sessionID = asString(request.sessionID);
  if (id === undefined || sessionID === undefined) return undefined;
  const v2 = source === "v2";
  const permission =
    asString(v2 ? request.action : request.permission) ??
    asString(v2 ? request.permission : request.action);
  if (permission === undefined) return undefined;
  const patterns = asStringArray(v2 ? request.resources : request.patterns) ?? [];
  const always = asStringArray(v2 ? request.save : request.always) ?? [];
  return {
    key: `${source}:${id}`,
    id,
    sessionID,
    permission,
    patterns,
    metadata: normalizeMetadata(request.metadata),
    always,
    source,
    tool: toolRef(v2 ? request.source : request.tool),
  };
}

export function normalizeQuestionList(
  input: unknown,
  source: PromptSource,
): NormalizedList<NormalizedQuestionRequest> {
  const requests = Array.isArray(input) ? input : [];
  const capped = requests.slice(0, MAX_PROMPTS_PER_KIND);
  return {
    items: capped.flatMap((request) => {
      const normalized = normalizeQuestionRequest(request, source);
      return normalized === undefined ? [] : [normalized];
    }),
    truncated: requests.length > MAX_PROMPTS_PER_KIND,
  };
}

export function normalizePermissionList(
  input: unknown,
  source: PromptSource,
): NormalizedList<NormalizedPermissionRequest> {
  const requests = Array.isArray(input) ? input : [];
  const capped = requests.slice(0, MAX_PROMPTS_PER_KIND);
  return {
    items: capped.flatMap((request) => {
      const normalized = normalizePermissionRequest(request, source);
      return normalized === undefined ? [] : [normalized];
    }),
    truncated: requests.length > MAX_PROMPTS_PER_KIND,
  };
}

export function normalizeSavedPermissions(input: unknown): NormalizedSavedPermission[] {
  const value = asRecord(input);
  const list = Array.isArray(input) ? input : Array.isArray(value?.data) ? value.data : [];
  return list.flatMap((raw) => {
    const record = asRecord(raw);
    if (record === undefined) return [];
    const id = asString(record.id);
    if (id === undefined) return [];
    return [
      {
        id,
        projectID: asString(record.projectID) ?? "",
        action: asString(record.action) ?? "",
        resource: asString(record.resource) ?? "",
      },
    ];
  });
}

export function normalizeTodos(input: unknown): NormalizedTodos {
  const list = Array.isArray(input) ? input : [];
  const truncatedByLength = list.length > MAX_TODOS;
  let truncatedText = false;
  const todos = list.slice(0, MAX_TODOS).map((raw): NormalizedTodo => {
    const todo = asRecord(raw) ?? {};
    let content = asString(todo.content) ?? "";
    if (content.length > MAX_TODO_CONTENT) {
      content = content.slice(0, MAX_TODO_CONTENT);
      truncatedText = true;
    }
    return {
      content,
      status: normalizeTodoStatus(asString(todo.status)),
      priority: normalizeTodoPriority(asString(todo.priority)),
    };
  });
  return { todos, truncated: truncatedByLength || truncatedText };
}

export function normalizeTodoStatus(value: string | undefined): TodoStatus {
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "cancelled":
      return value;
    default:
      return "unknown";
  }
}

export function normalizeTodoPriority(value: string | undefined): TodoPriority {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return "unknown";
  }
}

/**
 * Bound untrusted permission metadata by depth, key count, array length, and string size.
 * Non-JSON values are dropped.
 */
export function normalizeMetadata(input: unknown): Record<string, NormalizedMetadataValue> {
  const record = asRecord(input);
  return record === undefined ? {} : normalizeMetadataObject(record, 0);
}

function normalizeMetadataObject(
  record: Record<string, unknown>,
  depth: number,
): Record<string, NormalizedMetadataValue> {
  const output: Record<string, NormalizedMetadataValue> = {};
  let count = 0;
  for (const key of Object.keys(record)) {
    if (count >= MAX_METADATA_KEYS) break;
    const value = normalizeMetadataValue(record[key], depth);
    if (value === undefined) continue;
    output[key] = value;
    count += 1;
  }
  return output;
}

function normalizeMetadataValue(
  value: unknown,
  depth: number,
): NormalizedMetadataValue | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    return value.length > MAX_METADATA_STRING ? value.slice(0, MAX_METADATA_STRING) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_METADATA_DEPTH) return "[truncated]";
    return value.slice(0, MAX_METADATA_ARRAY).flatMap((item) => {
      const normalized = normalizeMetadataValue(item, depth + 1);
      return normalized === undefined ? [] : [normalized];
    });
  }
  if (typeof value === "object") {
    if (depth >= MAX_METADATA_DEPTH) return "[truncated]";
    return normalizeMetadataObject(value as Record<string, unknown>, depth + 1);
  }
  return undefined;
}

// Re-export the upstream raw shapes used by the normalizers for callers that only import this module.
export type {
  OpencodePermissionRequest,
  OpencodePermissionV2Request,
  OpencodeQuestionRequest,
  OpencodeSavedPermission,
  OpencodeTodo,
};
