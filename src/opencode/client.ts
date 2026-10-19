export interface OpencodeSession {
  id: string;
  title?: string;
  [key: string]: unknown;
}

export interface OpencodePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpencodeMessage {
  info: { id: string; role: "user" | "assistant"; [key: string]: unknown };
  parts: OpencodePart[];
}

export type OpencodeToolRef = Record<string, unknown>;

export interface OpencodeQuestionOption {
  label: string;
  description?: string;
  [key: string]: unknown;
}

export interface OpencodeQuestionInfo {
  header: string;
  question: string;
  options: OpencodeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
  [key: string]: unknown;
}

export interface OpencodeQuestionRequest {
  id: string;
  sessionID: string;
  questions: OpencodeQuestionInfo[];
  tool?: OpencodeToolRef;
  [key: string]: unknown;
}

export interface OpencodePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always: string[];
  tool?: OpencodeToolRef;
  [key: string]: unknown;
}

export interface OpencodePermissionV2Request {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: OpencodeToolRef;
  [key: string]: unknown;
}

export type OpencodePermissionReply = "once" | "always" | "reject";

export interface OpencodeTodo {
  content: string;
  status: string;
  priority: string;
  [key: string]: unknown;
}

export interface OpencodeSavedPermission {
  id: string;
  projectID: string;
  action: string;
  resource: string;
  [key: string]: unknown;
}

export interface OpencodeV2List<T> {
  location?: { directory?: string; workspace?: string };
  data: T[];
}

/** Typed upstream failure. `status` is 0 for transport failures (timeout, oversized body). */
export class OpencodeHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly bodyExcerpt: string;
  readonly code?: string;

  constructor(path: string, status: number, bodyExcerpt: string, code?: string) {
    super(`opencode ${path} -> ${status}: ${bodyExcerpt}`);
    this.name = "OpencodeHttpError";
    this.status = status;
    this.path = path;
    this.bodyExcerpt = bodyExcerpt;
    this.code = code;
  }
}

export interface OpencodeRequestOptions {
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Response body cap in bytes. */
  maxBytes?: number;
}

export const OPENCODE_READ_TIMEOUT_MS = 5_000;
export const OPENCODE_REPLY_TIMEOUT_MS = 10_000;
export const OPENCODE_MAX_BODY_BYTES = 1024 * 1024;
export const MESSAGES_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const MESSAGES_RESPONSE_TIMEOUT_MS = 30_000;
const ERROR_EXCERPT_BYTES = 4_096;
const ERROR_EXCERPT_CHARS = 300;

async function call<T>(endpoint: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`opencode ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

export function listSessions(endpoint: string): Promise<OpencodeSession[]> {
  return call<OpencodeSession[]>(endpoint, "/session");
}

export function createSession(endpoint: string, title?: string): Promise<OpencodeSession> {
  return call<OpencodeSession>(endpoint, "/session", {
    method: "POST",
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
}

export async function deleteSession(endpoint: string, sessionId: string): Promise<void> {
  const path = `/session/${encodeURIComponent(sessionId)}`;
  const response = await fetch(`${endpoint}${path}`, { method: "DELETE" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`opencode DELETE ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
}

export async function listMessages(
  endpoint: string,
  sessionId: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodeMessage[]> {
  const path = `/session/${encodeURIComponent(sessionId)}/message`;
  const response = await requestResponse(
    endpoint,
    path,
    { method: "GET" },
    MESSAGES_RESPONSE_TIMEOUT_MS,
    options,
  );
  const maxBytes = options?.maxBytes ?? MESSAGES_RESPONSE_MAX_BYTES;
  const { text, tooLarge } = await readCapped(response, maxBytes);
  if (tooLarge) {
    throw new OpencodeHttpError(
      path,
      0,
      `response body exceeded ${maxBytes} bytes`,
      "messages_too_large",
    );
  }
  return JSON.parse(text) as OpencodeMessage[];
}

export function sendPrompt(
  endpoint: string,
  sessionId: string,
  text: string,
): Promise<OpencodeMessage> {
  return call<OpencodeMessage>(endpoint, `/session/${sessionId}/message`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  });
}

export function sendPromptAsync(
  endpoint: string,
  sessionId: string,
  text: string,
  messageID: string,
  options?: OpencodeRequestOptions,
): Promise<void> {
  return sendVoid(
    endpoint,
    `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    { parts: [{ type: "text", text }], messageID },
    "POST",
    options,
  );
}

function v2LocationQuery(appDir: string): string {
  return new URLSearchParams({ "location[directory]": appDir }).toString();
}

function transportExcerpt(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `request timed out after ${timeoutMs}ms`;
  }
  if (error instanceof Error) return error.message.slice(0, ERROR_EXCERPT_CHARS);
  return "request failed";
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; tooLarge: boolean }> {
  if (response.body === null) return { text: "", tooLarge: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (tooLarge) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    tooLarge,
  };
}

async function requestResponse(
  endpoint: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  options: OpencodeRequestOptions | undefined,
): Promise<Response> {
  const timeout = options?.timeoutMs ?? timeoutMs;
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new OpencodeHttpError(path, 0, transportExcerpt(error, timeout));
  }
  if (!response.ok) {
    const excerpt = await readCapped(response, ERROR_EXCERPT_BYTES);
    throw new OpencodeHttpError(path, response.status, excerpt.text.slice(0, ERROR_EXCERPT_CHARS));
  }
  return response;
}

async function readJson<T>(
  response: Response,
  path: string,
  options: OpencodeRequestOptions | undefined,
): Promise<T> {
  const maxBytes = options?.maxBytes ?? OPENCODE_MAX_BODY_BYTES;
  const { text, tooLarge } = await readCapped(response, maxBytes);
  if (tooLarge) throw new OpencodeHttpError(path, 0, `response body exceeded ${maxBytes} bytes`);
  return JSON.parse(text) as T;
}

async function getJson<T>(
  endpoint: string,
  path: string,
  options: OpencodeRequestOptions | undefined,
  timeoutMs = OPENCODE_READ_TIMEOUT_MS,
): Promise<T> {
  const response = await requestResponse(endpoint, path, { method: "GET" }, timeoutMs, options);
  return readJson<T>(response, path, options);
}

async function sendJson<T>(
  endpoint: string,
  path: string,
  body: unknown,
  options: OpencodeRequestOptions | undefined,
): Promise<T> {
  const init: RequestInit =
    body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) };
  const response = await requestResponse(endpoint, path, init, OPENCODE_REPLY_TIMEOUT_MS, options);
  return readJson<T>(response, path, options);
}

async function sendVoid(
  endpoint: string,
  path: string,
  body: unknown,
  method: "POST" | "DELETE",
  options: OpencodeRequestOptions | undefined,
): Promise<void> {
  const init: RequestInit =
    body === undefined ? { method } : { method, body: JSON.stringify(body) };
  const response = await requestResponse(endpoint, path, init, OPENCODE_REPLY_TIMEOUT_MS, options);
  await readCapped(response, options?.maxBytes ?? OPENCODE_MAX_BODY_BYTES);
}

export function listQuestions(
  endpoint: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodeQuestionRequest[]> {
  return getJson<OpencodeQuestionRequest[]>(endpoint, "/question", options);
}

export function replyQuestion(
  endpoint: string,
  requestId: string,
  answers: string[][],
  options?: OpencodeRequestOptions,
): Promise<boolean> {
  return sendJson<boolean>(
    endpoint,
    `/question/${encodeURIComponent(requestId)}/reply`,
    { answers },
    options,
  );
}

export function rejectQuestion(
  endpoint: string,
  requestId: string,
  options?: OpencodeRequestOptions,
): Promise<boolean> {
  return sendJson<boolean>(
    endpoint,
    `/question/${encodeURIComponent(requestId)}/reject`,
    undefined,
    options,
  );
}

export function listPermissions(
  endpoint: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodePermissionRequest[]> {
  return getJson<OpencodePermissionRequest[]>(endpoint, "/permission", options);
}

export function replyPermission(
  endpoint: string,
  requestId: string,
  reply: OpencodePermissionReply,
  message?: string,
  options?: OpencodeRequestOptions,
): Promise<boolean> {
  return sendJson<boolean>(
    endpoint,
    `/permission/${encodeURIComponent(requestId)}/reply`,
    message === undefined ? { reply } : { reply, message },
    options,
  );
}

export function listTodos(
  endpoint: string,
  sessionId: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodeTodo[]> {
  return getJson<OpencodeTodo[]>(
    endpoint,
    `/session/${encodeURIComponent(sessionId)}/todo`,
    options,
  );
}

export async function listQuestionsV2(
  endpoint: string,
  appDir: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodeQuestionRequest[]> {
  const path = `/api/question/request?${v2LocationQuery(appDir)}`;
  const body = await getJson<OpencodeV2List<OpencodeQuestionRequest>>(endpoint, path, options);
  return Array.isArray(body.data) ? body.data : [];
}

export function replyQuestionV2(
  endpoint: string,
  sessionId: string,
  requestId: string,
  answers: string[][],
  options?: OpencodeRequestOptions,
): Promise<void> {
  return sendVoid(
    endpoint,
    `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply`,
    { answers },
    "POST",
    options,
  );
}

export function rejectQuestionV2(
  endpoint: string,
  sessionId: string,
  requestId: string,
  options?: OpencodeRequestOptions,
): Promise<void> {
  return sendVoid(
    endpoint,
    `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`,
    undefined,
    "POST",
    options,
  );
}

export async function listPermissionsV2(
  endpoint: string,
  appDir: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodePermissionV2Request[]> {
  const path = `/api/permission/request?${v2LocationQuery(appDir)}`;
  const body = await getJson<OpencodeV2List<OpencodePermissionV2Request>>(endpoint, path, options);
  return Array.isArray(body.data) ? body.data : [];
}

export function replyPermissionV2(
  endpoint: string,
  sessionId: string,
  requestId: string,
  reply: OpencodePermissionReply,
  message?: string,
  options?: OpencodeRequestOptions,
): Promise<void> {
  return sendVoid(
    endpoint,
    `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
    message === undefined ? { reply } : { reply, message },
    "POST",
    options,
  );
}

export async function listSavedPermissions(
  endpoint: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodeSavedPermission[]> {
  const body = await getJson<{ data?: OpencodeSavedPermission[] }>(
    endpoint,
    "/api/permission/saved",
    options,
  );
  return Array.isArray(body.data) ? body.data : [];
}

export function deleteSavedPermission(
  endpoint: string,
  savedId: string,
  options?: OpencodeRequestOptions,
): Promise<void> {
  return sendVoid(
    endpoint,
    `/api/permission/saved/${encodeURIComponent(savedId)}`,
    undefined,
    "DELETE",
    options,
  );
}
