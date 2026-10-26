import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { createEventAttachmentResolver } from "../attachments/projection.js";
import { appStreams } from "../attachments/streams.js";
import { createHandoffEventResolver } from "../coordinator/handoff-messages.js";
import {
  deleteSavedPermission,
  listPermissions,
  listPermissionsV2,
  listQuestions,
  listQuestionsV2,
  listSavedPermissions,
  listTodos,
  type OpencodePermissionReply,
  rejectQuestion,
  rejectQuestionV2,
  replyPermission,
  replyPermissionV2,
  replyQuestion,
  replyQuestionV2,
  OpencodeHttpError as UpstreamError,
} from "../opencode/client.js";
import { authorizationFor } from "../opencode/endpoint-auth.js";
import {
  APP_STREAM_MAX_FRAME_BYTES,
  createEventStream,
  type HanseEvent,
} from "../opencode/events.js";
import { DeletionPendingError } from "../opencode/manager.js";
import {
  MAX_FEEDBACK_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LABELS,
  MAX_QUESTIONS,
  type NormalizedPermissionRequest,
  type NormalizedQuestion,
  type NormalizedQuestionRequest,
  normalizePermissionList,
  normalizeQuestionList,
  normalizeSavedPermissions,
  normalizeTodos,
  type PromptSource,
} from "../opencode/prompts.js";
import { appDir, type FoundApp, findApp, toManagedApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import { lifecycleErrorResponse, mapLifecycleHttpError } from "./errors.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const MAX_ANSWER_BYTES = 32 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;

type RouteKind =
  | "prompts"
  | "question-reply"
  | "question-reject"
  | "permission-reply"
  | "saved-permissions"
  | "saved-permission"
  | "todo";

interface RouteMatch {
  kind: RouteKind;
  method: "GET" | "POST" | "DELETE";
  appKey: string;
  id?: string;
}

const ROUTES: Array<{ pattern: RegExp; kind: RouteKind; method: RouteMatch["method"] }> = [
  { pattern: /^\/api\/apps\/([^/]+)\/prompts$/, kind: "prompts", method: "GET" },
  {
    pattern: /^\/api\/apps\/([^/]+)\/questions\/([^/]+)\/reply$/,
    kind: "question-reply",
    method: "POST",
  },
  {
    pattern: /^\/api\/apps\/([^/]+)\/questions\/([^/]+)\/reject$/,
    kind: "question-reject",
    method: "POST",
  },
  {
    pattern: /^\/api\/apps\/([^/]+)\/permissions\/([^/]+)\/reply$/,
    kind: "permission-reply",
    method: "POST",
  },
  {
    pattern: /^\/api\/apps\/([^/]+)\/permissions\/saved$/,
    kind: "saved-permissions",
    method: "GET",
  },
  {
    pattern: /^\/api\/apps\/([^/]+)\/permissions\/saved\/([^/]+)$/,
    kind: "saved-permission",
    method: "DELETE",
  },
  {
    pattern: /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/todo$/,
    kind: "todo",
    method: "GET",
  },
];

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function errorResponse(status: number, message: string, code?: string): HttpResponse {
  return json(status, code === undefined ? { error: message } : { error: message, code });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function projectParam(request: HttpRequest): string | undefined {
  const project = request.query?.project?.trim();
  return project === undefined || project.length === 0 ? undefined : project;
}

function routeFor(pathname: string): RouteMatch | undefined {
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (match === null) {
      continue;
    }
    return {
      kind: route.kind,
      method: route.method,
      appKey: safeDecode(match[1] ?? ""),
      ...(match[2] === undefined ? {} : { id: safeDecode(match[2]) }),
    };
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sourceFrom(value: unknown): PromptSource | undefined {
  return value === "v1" || value === "v2" ? value : undefined;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const [type] = value.split(";");
  return type?.trim().toLowerCase() === "application/json";
}

type ParsedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: HttpResponse };

function parseBody(request: HttpRequest): ParsedBody {
  if (!isJsonContentType(request.headers["content-type"])) {
    return {
      ok: false,
      response: errorResponse(415, "content-type must be application/json"),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(request.body ?? "");
  } catch {
    return { ok: false, response: errorResponse(400, "request body must be valid JSON") };
  }
  const body = asRecord(value);
  if (body === undefined) {
    return { ok: false, response: errorResponse(400, "request body must be a JSON object") };
  }
  return { ok: true, body };
}

function startFailureMessage(error: unknown): string {
  return `agent failed to start: ${error instanceof Error ? error.message : String(error)}`;
}

function startFailure(error: unknown): HttpResponse {
  if (error instanceof DeletionPendingError) {
    return errorResponse(409, error.message, error.code);
  }
  const mapped = lifecycleErrorResponse(error);
  if (mapped !== undefined) {
    return mapped;
  }
  return errorResponse(502, startFailureMessage(error));
}

function promptFailure(error: unknown): HttpResponse {
  if (error instanceof UpstreamError && error.status === 404) {
    return errorResponse(404, "prompt expired", "prompt_expired");
  }
  return errorResponse(502, error instanceof Error ? error.message : String(error));
}

async function loadQuestions(
  endpoint: string,
  directory: string,
  source: PromptSource,
): Promise<NormalizedQuestionRequest[]> {
  const raw =
    source === "v1" ? await listQuestions(endpoint) : await listQuestionsV2(endpoint, directory);
  return normalizeQuestionList(raw, source).items;
}

async function locateQuestion(
  endpoint: string,
  directory: string,
  source: PromptSource,
  requestId: string,
): Promise<{ request?: NormalizedQuestionRequest; mismatch?: boolean }> {
  const items = await loadQuestions(endpoint, directory, source);
  const request = items.find((candidate) => candidate.id === requestId);
  if (request !== undefined) {
    return { request };
  }
  const otherSource: PromptSource = source === "v1" ? "v2" : "v1";
  const other = await loadQuestions(endpoint, directory, otherSource).catch(() => undefined);
  return other?.some((candidate) => candidate.id === requestId) === true ? { mismatch: true } : {};
}

async function loadPermissions(
  endpoint: string,
  directory: string,
  source: PromptSource,
): Promise<NormalizedPermissionRequest[]> {
  const raw =
    source === "v1"
      ? await listPermissions(endpoint)
      : await listPermissionsV2(endpoint, directory);
  return normalizePermissionList(raw, source).items;
}

async function locatePermission(
  endpoint: string,
  directory: string,
  source: PromptSource,
  requestId: string,
): Promise<{ request?: NormalizedPermissionRequest; mismatch?: boolean }> {
  const items = await loadPermissions(endpoint, directory, source);
  const request = items.find((candidate) => candidate.id === requestId);
  if (request !== undefined) {
    return { request };
  }
  const otherSource: PromptSource = source === "v1" ? "v2" : "v1";
  const other = await loadPermissions(endpoint, directory, otherSource).catch(() => undefined);
  return other?.some((candidate) => candidate.id === requestId) === true ? { mismatch: true } : {};
}

type AnswersCheck = { ok: true; answers: string[][] } | { ok: false; message: string };

function parseAnswers(value: unknown): AnswersCheck {
  if (!Array.isArray(value)) {
    return { ok: false, message: "answers must be an array of string arrays" };
  }
  if (value.length > MAX_QUESTIONS) {
    return { ok: false, message: `answers may not exceed ${MAX_QUESTIONS} questions` };
  }
  const answers: string[][] = [];
  for (const answer of value) {
    if (!Array.isArray(answer)) {
      return { ok: false, message: "answers must be an array of string arrays" };
    }
    if (answer.length > MAX_LABELS) {
      return { ok: false, message: `each answer may not exceed ${MAX_LABELS} labels` };
    }
    const labels: string[] = [];
    for (const label of answer) {
      if (typeof label !== "string") {
        return { ok: false, message: "answer labels must be strings" };
      }
      if (label.length > MAX_LABEL_LENGTH) {
        return {
          ok: false,
          message: `answer labels may not exceed ${MAX_LABEL_LENGTH} characters`,
        };
      }
      labels.push(label);
    }
    answers.push(labels);
  }
  if (Buffer.byteLength(JSON.stringify(answers), "utf8") > MAX_ANSWER_BYTES) {
    return { ok: false, message: `answers may not exceed ${MAX_ANSWER_BYTES} bytes` };
  }
  return { ok: true, answers };
}

function validateAnswers(
  answers: string[][],
  questions: NormalizedQuestion[],
): { ok: true; answers: string[][] } | { ok: false; message: string } {
  if (answers.length !== questions.length) {
    return {
      ok: false,
      message: `answers must contain one entry per question (${questions.length})`,
    };
  }
  const output: string[][] = [];
  for (const [index, rawLabels] of answers.entries()) {
    const question = questions[index];
    if (question === undefined) {
      return { ok: false, message: "answers do not match the pending questions" };
    }
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const rawLabel of rawLabels) {
      const label = rawLabel.trim();
      if (label.length === 0) {
        return { ok: false, message: "answer labels may not be empty" };
      }
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    }
    if (labels.length > 0) {
      const optionLabels = new Set(question.options.map((option) => option.label));
      const hasCustom = labels.some((label) => !optionLabels.has(label));
      if (!question.custom && hasCustom) {
        return { ok: false, message: "this question does not accept a custom answer" };
      }
      if (!question.multiple && labels.length !== 1) {
        return { ok: false, message: "this question accepts exactly one answer" };
      }
    }
    output.push(labels);
  }
  return { ok: true, answers: output };
}

async function handleQuestionReply(
  request: HttpRequest,
  match: RouteMatch,
  found: FoundApp,
  endpoint: string,
): Promise<HttpResponse> {
  const parsed = parseBody(request);
  if (!parsed.ok) {
    return parsed.response;
  }
  const source = sourceFrom(parsed.body.source);
  if (source === undefined) {
    return errorResponse(400, "source must be v1 or v2", "invalid_source");
  }
  const answers = parseAnswers(parsed.body.answers);
  if (!answers.ok) {
    return errorResponse(400, answers.message, "invalid_answers");
  }
  const directory = appDir(found.project, found.app);
  try {
    const located = await locateQuestion(endpoint, directory, source, match.id ?? "");
    if (located.mismatch === true) {
      return errorResponse(400, "source does not match the pending request", "invalid_source");
    }
    if (located.request === undefined) {
      return errorResponse(404, "prompt expired", "prompt_expired");
    }
    const pending = located.request;
    if (pending.tooLarge) {
      return errorResponse(
        400,
        pending.tooLargeReason ?? "this prompt is too large to answer",
        "invalid_answers",
      );
    }
    const validated = validateAnswers(answers.answers, pending.questions);
    if (!validated.ok) {
      return errorResponse(400, validated.message, "invalid_answers");
    }
    if (source === "v1") {
      await replyQuestion(endpoint, pending.id, validated.answers);
    } else {
      await replyQuestionV2(endpoint, pending.sessionID, pending.id, validated.answers);
    }
    return json(200, { ok: true });
  } catch (error) {
    return promptFailure(error);
  }
}

async function handleQuestionReject(
  request: HttpRequest,
  match: RouteMatch,
  found: FoundApp,
  endpoint: string,
): Promise<HttpResponse> {
  const parsed = parseBody(request);
  if (!parsed.ok) {
    return parsed.response;
  }
  const source = sourceFrom(parsed.body.source);
  if (source === undefined) {
    return errorResponse(400, "source must be v1 or v2", "invalid_source");
  }
  const directory = appDir(found.project, found.app);
  try {
    const located = await locateQuestion(endpoint, directory, source, match.id ?? "");
    if (located.mismatch === true) {
      return errorResponse(400, "source does not match the pending request", "invalid_source");
    }
    if (located.request === undefined) {
      return errorResponse(404, "prompt expired", "prompt_expired");
    }
    const pending = located.request;
    if (source === "v1") {
      await rejectQuestion(endpoint, pending.id);
    } else {
      await rejectQuestionV2(endpoint, pending.sessionID, pending.id);
    }
    return json(200, { ok: true });
  } catch (error) {
    return promptFailure(error);
  }
}

async function handlePermissionReply(
  request: HttpRequest,
  match: RouteMatch,
  found: FoundApp,
  endpoint: string,
): Promise<HttpResponse> {
  const parsed = parseBody(request);
  if (!parsed.ok) {
    return parsed.response;
  }
  const source = sourceFrom(parsed.body.source);
  if (source === undefined) {
    return errorResponse(400, "source must be v1 or v2", "invalid_source");
  }
  const reply = parsed.body.reply;
  const validReply: OpencodePermissionReply | undefined =
    reply === "once" || reply === "always" || reply === "reject" ? reply : undefined;
  if (validReply === undefined) {
    return errorResponse(400, "reply must be once, always, or reject", "invalid_permission_reply");
  }
  const messageValue = parsed.body.message;
  if (messageValue !== undefined) {
    if (typeof messageValue !== "string") {
      return errorResponse(400, "message must be a string", "invalid_permission_reply");
    }
    if (messageValue.length > MAX_FEEDBACK_LENGTH) {
      return errorResponse(
        400,
        `message may not exceed ${MAX_FEEDBACK_LENGTH} characters`,
        "invalid_permission_reply",
      );
    }
    if (validReply !== "reject") {
      return errorResponse(
        400,
        "message is only valid with a reject reply",
        "invalid_permission_reply",
      );
    }
  }
  const message = typeof messageValue === "string" ? messageValue : undefined;
  const directory = appDir(found.project, found.app);
  try {
    const located = await locatePermission(endpoint, directory, source, match.id ?? "");
    if (located.mismatch === true) {
      return errorResponse(400, "source does not match the pending request", "invalid_source");
    }
    if (located.request === undefined) {
      return errorResponse(404, "prompt expired", "prompt_expired");
    }
    const pending = located.request;
    if (source === "v1") {
      await replyPermission(endpoint, pending.id, validReply, message);
    } else {
      await replyPermissionV2(endpoint, pending.sessionID, pending.id, validReply, message);
    }
    return json(200, { ok: true });
  } catch (error) {
    return promptFailure(error);
  }
}

async function handlePromptsList(
  deps: HttpDeps,
  found: FoundApp,
  endpoint: string,
): Promise<HttpResponse> {
  const directory = appDir(found.project, found.app);
  const results = await Promise.allSettled([
    listQuestions(endpoint),
    listPermissions(endpoint),
    listQuestionsV2(endpoint, directory),
    listPermissionsV2(endpoint, directory),
  ]);
  const [v1Questions, v1Permissions, v2Questions, v2Permissions] = results;
  const questions: NormalizedQuestionRequest[] = [];
  const permissions: NormalizedPermissionRequest[] = [];
  const warnings: string[] = [];
  let truncated = false;
  let failed = 0;

  if (v1Questions.status === "fulfilled") {
    const list = normalizeQuestionList(v1Questions.value, "v1");
    questions.push(...list.items);
    truncated = truncated || list.truncated;
  } else {
    failed += 1;
    warnings.push("v1 questions are unavailable");
  }
  if (v1Permissions.status === "fulfilled") {
    const list = normalizePermissionList(v1Permissions.value, "v1");
    permissions.push(...list.items);
    truncated = truncated || list.truncated;
  } else {
    failed += 1;
    warnings.push("v1 permissions are unavailable");
  }
  if (v2Questions.status === "fulfilled") {
    const list = normalizeQuestionList(v2Questions.value, "v2");
    questions.push(...list.items);
    truncated = truncated || list.truncated;
  } else {
    failed += 1;
    warnings.push("v2 questions are unavailable");
  }
  if (v2Permissions.status === "fulfilled") {
    const list = normalizePermissionList(v2Permissions.value, "v2");
    permissions.push(...list.items);
    truncated = truncated || list.truncated;
  } else {
    failed += 1;
    warnings.push("v2 permissions are unavailable");
  }

  if (failed === 4) {
    return errorResponse(502, "prompt sources are unavailable", "prompts_unavailable");
  }
  const policyWarnings = deps.manager?.policyWarnings(found.app.id) ?? [];
  warnings.push(...policyWarnings);
  const visibleWarnings = warnings.filter(
    (warning) => !warning.trim().startsWith("policy_unverified:"),
  );
  return json(200, {
    questions,
    permissions,
    truncated,
    ...(visibleWarnings.length === 0 ? {} : { warnings: visibleWarnings }),
  });
}

/** Handle the human-only prompt, Todo, and saved-permission routes for one app. */
export async function handlePrompts(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const match = routeFor(request.path);
  if (match === undefined) {
    return errorResponse(404, "not found");
  }
  if (request.method !== match.method) {
    return errorResponse(405, "method not allowed");
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return errorResponse(401, "sign in required");
  }
  if (principal.kind !== "human") {
    return errorResponse(403, "only a human principal may manage prompts");
  }
  if (deps.manager === undefined) {
    return errorResponse(503, "agent runtime is not configured");
  }
  const found = findApp(deps, projectParam(request), match.appKey);
  if (found === undefined) {
    return errorResponse(404, `unknown application: ${match.appKey}`);
  }

  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure(toManagedApp(found));
  } catch (error) {
    return startFailure(error);
  }

  switch (match.kind) {
    case "prompts":
      return handlePromptsList(deps, found, endpoint);
    case "question-reply":
      return handleQuestionReply(request, match, found, endpoint);
    case "question-reject":
      return handleQuestionReject(request, match, found, endpoint);
    case "permission-reply":
      return handlePermissionReply(request, match, found, endpoint);
    case "saved-permissions":
      try {
        return json(200, {
          permissions: normalizeSavedPermissions(await listSavedPermissions(endpoint)),
        });
      } catch (error) {
        return errorResponse(502, error instanceof Error ? error.message : String(error));
      }
    case "saved-permission":
      try {
        await deleteSavedPermission(endpoint, match.id ?? "");
        return json(200, { ok: true });
      } catch (error) {
        return errorResponse(502, error instanceof Error ? error.message : String(error));
      }
    case "todo":
      try {
        const sessionId = match.id ?? "";
        return json(200, normalizeTodos(await listTodos(endpoint, sessionId)));
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) {
          return errorResponse(404, "session not found", "session_not_found");
        }
        return errorResponse(502, error instanceof Error ? error.message : String(error));
      }
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function writeChunk(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return Promise.resolve();
  }
  if (response.write(chunk)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

function heartbeatInterval(): number {
  const override = Number(process.env.HANSE_EVENT_HEARTBEAT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_HEARTBEAT_MS;
}

/**
 * Stream the typed app-scoped event feed. The caller owns the raw response and must not have sent
 * headers; this function writes them once the upstream reader is attached.
 */
export async function streamAppEvents(
  deps: HttpDeps,
  request: HttpRequest,
  response: ServerResponse,
): Promise<void> {
  const match = /^\/api\/apps\/([^/]+)\/events$/.exec(request.path);
  if (match === null) {
    writeJson(response, 404, { error: "not found" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method not allowed" });
    return;
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    writeJson(response, 401, { error: "sign in required" });
    return;
  }
  if (principal.kind !== "human") {
    writeJson(response, 403, { error: "only a human principal may read app events" });
    return;
  }
  if (deps.manager === undefined) {
    writeJson(response, 503, { error: "agent runtime is not configured" });
    return;
  }
  const appKey = safeDecode(match[1] ?? "");
  const found = findApp(deps, projectParam(request), appKey);
  if (found === undefined) {
    writeJson(response, 404, { error: `unknown application: ${appKey}` });
    return;
  }
  const releaseSlot = appStreams.acquireBrowser(found.app.id);
  if (releaseSlot === undefined) {
    writeJson(response, 429, {
      error: "too many event streams for this application",
      code: "stream_limit",
    });
    return;
  }
  let slotReleased = false;
  const releaseOnce = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlot();
  };
  response.once?.("close", releaseOnce);
  response.once?.("finish", releaseOnce);
  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure(toManagedApp(found));
  } catch (error) {
    if (error instanceof DeletionPendingError) {
      writeJson(response, 409, { error: error.message, code: error.code });
      releaseOnce();
      return;
    }
    const mapped = mapLifecycleHttpError(error);
    if (mapped !== undefined) {
      response.writeHead(mapped.status, {
        "content-type": "application/json; charset=utf-8",
        ...(mapped.headers ?? {}),
      });
      response.end(JSON.stringify(mapped.body));
      releaseOnce();
      return;
    }
    writeJson(response, 502, { error: startFailureMessage(error) });
    releaseOnce();
    return;
  }
  if (response.destroyed || response.writableEnded) {
    releaseOnce();
    return;
  }

  const controller = new AbortController();
  const streamID = randomUUID();
  let seq = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribeContext: (() => void) | undefined;
  let queue: Promise<void> = Promise.resolve();
  const emit = (event: HanseEvent): string => {
    seq += 1;
    return `data: ${JSON.stringify({ ...event, seq, streamID })}\n\n`;
  };
  const ready = `data: ${JSON.stringify({ type: "stream.ready", seq: 0, streamID })}\n\n`;
  const write = (chunk: string): Promise<void> => {
    queue = queue.then(() => writeChunk(response, chunk));
    return queue;
  };
  const cleanup = (): void => {
    controller.abort();
    unsubscribeContext?.();
    unsubscribeContext = undefined;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };
  response.on("close", cleanup);

  try {
    const authorization = authorizationFor(endpoint);
    const upstream = await fetch(`${endpoint}/event`, {
      headers: {
        accept: "text/event-stream",
        ...(authorization === undefined ? {} : { authorization }),
      },
      signal: controller.signal,
    });
    if (!upstream.ok || upstream.body === null) {
      cleanup();
      writeJson(response, 502, { error: `event stream failed with status ${upstream.status}` });
      releaseOnce();
      return;
    }
    const resolver = createEventAttachmentResolver({
      db: deps.db,
      appId: found.app.id,
      appKey: found.app.appKey,
      projectId: found.project.id,
    });
    const stream = createEventStream(upstream.body, {
      signal: controller.signal,
      maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES,
      attachments: resolver,
      handoffs: createHandoffEventResolver(deps.db),
      isPriority: () => appStreams.isActive(found.app.id, streamID),
      onAttached: () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        void write(ready);
        heartbeat = setInterval(() => {
          void write(": ping\n\n");
        }, heartbeatInterval());
      },
    });
    if (typeof deps.manager.subscribeContext === "function") {
      unsubscribeContext = deps.manager.subscribeContext(found.app.id, (snapshot) => {
        if (response.destroyed || response.writableEnded) return;
        void write(
          emit({
            type: "context.updated",
            sessionID: snapshot.sessionID,
            context: snapshot,
          }),
        );
      });
    }
    for await (const event of stream.events) {
      if (response.destroyed || response.writableEnded) {
        break;
      }
      await write(emit(event));
    }
    cleanup();
    await queue;
  } catch {
    if (!response.headersSent) {
      writeJson(response, 502, { error: "event stream is unavailable" });
    }
  } finally {
    cleanup();
    response.off("close", cleanup);
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
    releaseOnce();
  }
}
