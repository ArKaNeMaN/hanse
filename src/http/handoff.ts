import { getHandoff } from "../coordinator/handoff.js";
import {
  deleteHandoffPolicy,
  HandoffPolicyError,
  listHandoffPolicies,
  setHandoffPolicy,
} from "../coordinator/policy.js";
import { CoordinatorService } from "../coordinator/service.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import { safeLocalPath } from "./ui.js";

const MAX_NOTE_BYTES = 4 * 1024;

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { "cache-control": "no-store" },
  };
}

function redirect(location: string): HttpResponse {
  return { status: 303, contentType: "text/plain", body: "", headers: { location } };
}

function withNotice(location: string, message: string, tone: "success" | "error"): string {
  const separator = location.includes("?") ? "&" : "?";
  return `${location}${separator}notice=${encodeURIComponent(message)}&tone=${tone}`;
}

function redirectWithNotice(
  location: string,
  message: string,
  tone: "success" | "error",
): HttpResponse {
  return redirect(withNotice(location, message, tone));
}

function wantsHtml(request: HttpRequest): boolean {
  return (request.headers.accept ?? "").toLowerCase().includes("text/html");
}

function parseForm(body: string | undefined): Record<string, string> {
  const params = new URLSearchParams(body ?? "");
  const fields: Record<string, string> = {};
  for (const [key, value] of params) {
    fields[key] = value;
  }
  return fields;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fail(
  request: HttpRequest,
  returnTo: string,
  status: number,
  message: string,
  code?: string,
): HttpResponse {
  if (wantsHtml(request)) {
    return redirectWithNotice(returnTo, message, "error");
  }
  return json(status, code === undefined ? { error: message } : { error: message, code });
}

/**
 * Human-only handoff actions that need the running dispatcher (relaunch, retry, cancel) and the
 * handoff policy editor. Returns undefined for every other request so the main router can continue.
 */
export async function handleHandoffHttp(
  deps: HttpDeps,
  request: HttpRequest,
): Promise<HttpResponse | undefined> {
  const policyMatch = /^\/api\/projects\/([^/]+)\/handoff-policy(\/delete)?$/.exec(request.path);
  if (policyMatch !== null && (request.method === "POST" || request.method === "GET")) {
    return handlePolicy(deps, request, policyMatch);
  }
  const replyMatch = /^\/api\/handoffs\/([^/]+)\/reply\/(relaunch|deliver|cancel)$/.exec(
    request.path,
  );
  if (replyMatch !== null && request.method === "POST") {
    return handleReplyAction(deps, request, replyMatch);
  }
  const cancelMatch = /^\/api\/handoffs\/([^/]+)\/cancel$/.exec(request.path);
  if (cancelMatch !== null && request.method === "POST") {
    return handleHandoffCancel(deps, request, cancelMatch);
  }
  return undefined;
}

function handlePolicy(deps: HttpDeps, request: HttpRequest, match: RegExpExecArray): HttpResponse {
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may manage handoff policy" });
  }
  const projectId = safeDecode(match[1] ?? "");
  const project = deps.getProjects().find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return json(404, { error: "project not found" });
  }
  const returnTo = safeLocalPath(
    request.query?.return_to ?? parseForm(request.body).return_to,
    `/projects/${encodeURIComponent(project.id)}`,
  );
  if (request.method === "GET") {
    return json(200, { policies: listHandoffPolicies(deps.db, project.id) });
  }
  const fields = parseForm(request.body);
  try {
    if (match[2] === "/delete") {
      deleteHandoffPolicy(deps.db, project.id, fields.from ?? "*", fields.to ?? "*");
      return wantsHtml(request)
        ? redirectWithNotice(returnTo, "Handoff policy rule deleted.", "success")
        : json(200, { ok: true });
    }
    const policy = setHandoffPolicy(deps.db, {
      projectId: project.id,
      fromAppKey: fields.from,
      toAppKey: fields.to,
      dispatchMode: fields.dispatch_mode,
      replyMode: fields.reply_mode,
      updatedBy: principal.id,
    });
    return wantsHtml(request)
      ? redirectWithNotice(returnTo, "Handoff policy saved.", "success")
      : json(200, { policy });
  } catch (error) {
    if (error instanceof HandoffPolicyError) {
      return fail(request, returnTo, 400, error.message, error.code);
    }
    const message = error instanceof Error ? error.message : String(error);
    return fail(request, returnTo, 500, message);
  }
}

function handleHandoffCancel(
  deps: HttpDeps,
  request: HttpRequest,
  match: RegExpExecArray,
): HttpResponse {
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may cancel a handoff" });
  }
  const fields = parseForm(request.body);
  const returnTo = safeLocalPath(fields.return_to, "/handoffs");
  const handoff = getHandoff(deps.db, safeDecode(match[1] ?? ""));
  if (handoff === undefined) {
    return fail(request, returnTo, 404, "Handoff not found.");
  }
  try {
    new CoordinatorService(deps.db, handoff.projectId).cancelHandoff(handoff.id, principal);
    return wantsHtml(request)
      ? redirectWithNotice(returnTo, "Handoff cancelled.", "success")
      : json(200, { ok: true });
  } catch (error) {
    return fail(request, returnTo, 409, error instanceof Error ? error.message : String(error));
  }
}

async function handleReplyAction(
  deps: HttpDeps,
  request: HttpRequest,
  match: RegExpExecArray,
): Promise<HttpResponse> {
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may route a handoff reply" });
  }
  const fields = parseForm(request.body);
  const returnTo = safeLocalPath(fields.return_to, "/handoffs");
  const handoffId = safeDecode(match[1] ?? "");
  const action = match[2];
  if (deps.dispatcher === undefined) {
    return fail(
      request,
      returnTo,
      503,
      "The handoff dispatcher is not configured.",
      "dispatcher_unavailable",
    );
  }
  const note = (fields.note ?? "").trim();
  if (Buffer.byteLength(note, "utf8") > MAX_NOTE_BYTES) {
    return fail(request, returnTo, 400, "The note is too large.");
  }
  try {
    if (action === "relaunch") {
      const result = await deps.dispatcher.relaunchReply(handoffId, note);
      return wantsHtml(request)
        ? redirectWithNotice(returnTo, "Reply started in a new session.", "success")
        : json(200, { ok: true, ...result });
    }
    if (action === "deliver") {
      deps.dispatcher.retryReplyDelivery(handoffId);
      return wantsHtml(request)
        ? redirectWithNotice(returnTo, "Reply delivery queued.", "success")
        : json(200, { ok: true });
    }
    deps.dispatcher.cancelReply(handoffId);
    return wantsHtml(request)
      ? redirectWithNotice(returnTo, "Reply delivery cancelled.", "success")
      : json(200, { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message)
      ? 404
      : /not waiting|no reply/i.test(message)
        ? 409
        : 502;
    return fail(request, returnTo, status, message);
  }
}
