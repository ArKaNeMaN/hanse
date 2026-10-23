import { authorizationFor } from "./endpoint-auth.js";

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

export interface OpencodeMessagePage {
  messages: OpencodeMessage[];
  nextCursor?: string;
}

export type OpencodeToolRef = Record<string, unknown>;

export interface OpencodeModel {
  providerID: string;
  modelID: string;
}

export interface OpencodeModelLimit {
  context?: number;
  input?: number;
  output?: number;
}

export interface OpencodeProviderModel {
  id?: string;
  limit?: OpencodeModelLimit;
  [key: string]: unknown;
}

export interface OpencodeProvider {
  id: string;
  models: Record<string, OpencodeProviderModel>;
  [key: string]: unknown;
}

export interface OpencodeProviders {
  providers: OpencodeProvider[];
  default?: Record<string, string>;
}

export interface OpencodeCommand {
  name: string;
  description?: string;
  agent?: string;
  model?: string | { providerID: string; modelID: string };
  source?: "command" | "mcp" | "skill";
  /**
   * Optional on purpose: MCP prompts expose a non-string value that may serialize as `{}`, and the
   * reduced v2 shape omits it. The pure whitelist treats any non-string as absent and derives
   * `shell: "unknown"`; the client never retains or logs a non-string template.
   */
  template?: string;
  subtask?: boolean;
  hints?: string[];
}

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
export const PROVIDERS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const PROVIDERS_RESPONSE_TIMEOUT_MS = 10_000;
export const SESSIONS_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const SESSIONS_RESPONSE_TIMEOUT_MS = 5_000;
export const SUMMARIZE_RESPONSE_TIMEOUT_MS = 600_000;
export const COMMANDS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const COMMANDS_RESPONSE_TIMEOUT_MS = 10_000;
export const COMMAND_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const COMMAND_RESPONSE_DRAIN_BYTES = 1024 * 1024;
const ERROR_EXCERPT_BYTES = 4_096;
const ERROR_EXCERPT_CHARS = 300;

function requestHeaders(endpoint: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const authorization = authorizationFor(endpoint);
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return headers;
}

async function call<T>(endpoint: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: requestHeaders(endpoint, init),
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

export async function listSessionsBounded(endpoint: string): Promise<OpencodeSession[]> {
  const path = "/session";
  const options: OpencodeRequestOptions = {
    maxBytes: SESSIONS_RESPONSE_MAX_BYTES,
    timeoutMs: SESSIONS_RESPONSE_TIMEOUT_MS,
  };
  const response = await requestResponse(
    endpoint,
    path,
    { method: "GET" },
    SESSIONS_RESPONSE_TIMEOUT_MS,
    options,
  );
  return readJson<OpencodeSession[]>(response, path, options);
}

export async function listCommands(
  endpoint: string,
  options?: OpencodeRequestOptions,
): Promise<OpencodeCommand[]> {
  const path = "/command";
  const requestOptions: OpencodeRequestOptions = {
    maxBytes: options?.maxBytes ?? COMMANDS_RESPONSE_MAX_BYTES,
    timeoutMs: options?.timeoutMs ?? COMMANDS_RESPONSE_TIMEOUT_MS,
  };
  const body = await getJson<unknown>(endpoint, path, requestOptions);
  return coerceCommandList(body, path);
}

export async function runSessionCommand(
  endpoint: string,
  sessionId: string,
  name: string,
  args: string,
  messageID: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
  const path = `/session/${encodeURIComponent(sessionId)}/command`;
  const timeoutMs = options?.timeoutMs ?? COMMAND_RUN_TIMEOUT_MS;
  const requestOptions: OpencodeRequestOptions = {
    maxBytes: COMMAND_RESPONSE_DRAIN_BYTES,
    timeoutMs,
  };
  const response = await requestResponse(
    endpoint,
    path,
    {
      method: "POST",
      body: JSON.stringify({ command: name, arguments: args, messageID }),
    },
    timeoutMs,
    requestOptions,
    options?.signal,
  );
  await readCapped(response, COMMAND_RESPONSE_DRAIN_BYTES);
}

export async function listProviders(endpoint: string): Promise<OpencodeProviders> {
  const body = await getJson<unknown>(endpoint, "/config/providers", {
    maxBytes: PROVIDERS_RESPONSE_MAX_BYTES,
    timeoutMs: PROVIDERS_RESPONSE_TIMEOUT_MS,
  });
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { providers: [] };
  }
  const record = body as Record<string, unknown>;
  const result: OpencodeProviders = {
    providers: Array.isArray(record.providers) ? (record.providers as OpencodeProvider[]) : [],
  };
  const catalogDefault = record.default;
  if (
    typeof catalogDefault === "object" &&
    catalogDefault !== null &&
    !Array.isArray(catalogDefault)
  ) {
    result.default = catalogDefault as Record<string, string>;
  }
  return result;
}

export async function summarizeSession(
  endpoint: string,
  sessionId: string,
  model: OpencodeModel,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  const path = `/session/${encodeURIComponent(sessionId)}/summarize`;
  const timeout = options?.timeoutMs ?? SUMMARIZE_RESPONSE_TIMEOUT_MS;
  const requestOptions: OpencodeRequestOptions = {
    maxBytes: OPENCODE_MAX_BODY_BYTES,
    timeoutMs: timeout,
  };
  const response = await requestResponse(
    endpoint,
    path,
    {
      method: "POST",
      body: JSON.stringify({
        providerID: model.providerID,
        modelID: model.modelID,
        auto: false,
      }),
    },
    timeout,
    requestOptions,
    options?.signal,
  );
  const body = await readJson<unknown>(response, path, requestOptions);
  if (typeof body !== "boolean") {
    throw new OpencodeHttpError(path, 0, "response body is not a boolean");
  }
  return body;
}

export function createSession(endpoint: string, title?: string): Promise<OpencodeSession> {
  return call<OpencodeSession>(endpoint, "/session", {
    method: "POST",
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
}

export async function deleteSession(endpoint: string, sessionId: string): Promise<void> {
  const path = `/session/${encodeURIComponent(sessionId)}`;
  const response = await fetch(`${endpoint}${path}`, {
    method: "DELETE",
    headers: requestHeaders(endpoint),
  });
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
  return readMessageList(response, path, maxBytes);
}

export async function listMessagePage(
  endpoint: string,
  sessionId: string,
  options: { limit: number; before?: string; maxBytes?: number; timeoutMs?: number },
): Promise<OpencodeMessagePage> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.before !== undefined) params.set("before", options.before);
  const path = `/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`;
  const response = await requestResponse(
    endpoint,
    path,
    { method: "GET" },
    MESSAGES_RESPONSE_TIMEOUT_MS,
    options,
  );
  const maxBytes = options.maxBytes ?? MESSAGES_RESPONSE_MAX_BYTES;
  const messages = await readMessageList(response, path, maxBytes);
  const cursor = response.headers.get("x-next-cursor");
  return cursor === null || cursor.length === 0 ? { messages } : { messages, nextCursor: cursor };
}

async function readMessageList(
  response: Response,
  path: string,
  maxBytes: number,
): Promise<OpencodeMessage[]> {
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
  model?: string,
): Promise<OpencodeMessage> {
  const parsedModel = parseOpencodeModel(model);
  return call<OpencodeMessage>(endpoint, `/session/${sessionId}/message`, {
    method: "POST",
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      ...(parsedModel === undefined ? {} : { model: parsedModel }),
    }),
  });
}

export function sendPromptAsync(
  endpoint: string,
  sessionId: string,
  text: string,
  messageID: string,
  options?: OpencodeRequestOptions,
  model?: string,
): Promise<void> {
  const parsedModel = parseOpencodeModel(model);
  return sendVoid(
    endpoint,
    `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    {
      parts: [{ type: "text", text }],
      messageID,
      ...(parsedModel === undefined ? {} : { model: parsedModel }),
    },
    "POST",
    options,
  );
}

function parseOpencodeModel(model: string | undefined): OpencodeModel | undefined {
  if (model === undefined || model.length === 0) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function coerceCommandList(body: unknown, path: string): OpencodeCommand[] {
  if (!Array.isArray(body)) {
    throw new OpencodeHttpError(path, 0, "response body is not an array");
  }
  const commands: OpencodeCommand[] = [];
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new OpencodeHttpError(path, 0, "response body contains a non-object command");
    }
    commands.push(coerceCommandEntry(entry as Record<string, unknown>));
  }
  return commands;
}

function coerceCommandEntry(record: Record<string, unknown>): OpencodeCommand {
  const command: OpencodeCommand = {
    name: typeof record.name === "string" ? record.name : "",
  };
  if (typeof record.description === "string") command.description = record.description;
  if (typeof record.agent === "string") command.agent = record.agent;
  const model = coerceCommandModel(record.model);
  if (model !== undefined) command.model = model;
  if (record.source === "command" || record.source === "mcp" || record.source === "skill") {
    command.source = record.source;
  }
  if (typeof record.template === "string") command.template = record.template;
  if (typeof record.subtask === "boolean") command.subtask = record.subtask;
  if (Array.isArray(record.hints)) {
    command.hints = record.hints.filter((hint): hint is string => typeof hint === "string");
  }
  return command;
}

function coerceCommandModel(
  value: unknown,
): string | { providerID: string; modelID: string } | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.providerID !== "string" || typeof record.modelID !== "string") {
    return undefined;
  }
  return { providerID: record.providerID, modelID: record.modelID };
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

function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, signal]);
  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (signal.aborted) abort(signal.reason);
  else signal.addEventListener("abort", () => abort(signal.reason), { once: true });
  if (!controller.signal.aborted) {
    timeout.addEventListener("abort", () => abort(timeout.reason), { once: true });
  }
  return controller.signal;
}

async function requestResponse(
  endpoint: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  options: OpencodeRequestOptions | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = options?.timeoutMs ?? timeoutMs;
  let response: Response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: requestHeaders(endpoint, init),
      signal: timeoutSignal(timeout, signal),
    });
  } catch (error) {
    throw new OpencodeHttpError(
      path,
      0,
      signal?.aborted === true ? "request aborted" : transportExcerpt(error, timeout),
    );
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
