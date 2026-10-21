import { type DeleteOptions, DeletionError } from "../coordinator/deletion.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import { principalFrom } from "./auth.js";
import {
  agentTokenFor,
  type HttpDeps,
  type HttpRequest,
  type HttpResponse,
  loginRedirectTo,
  redirectWithNotice,
  safeDecode,
  wantsHtml,
} from "./handler.js";
import { safeLocalPath } from "./ui.js";

const APP_POST_PATH = /^\/api\/projects\/([^/]+)\/apps\/([^/]+)\/delete$/;
const PROJECT_POST_PATH = /^\/api\/projects\/([^/]+)\/delete$/;
const APP_DELETE_PATH = /^\/api\/projects\/([^/]+)\/apps\/([^/]+)$/;
const PROJECT_DELETE_PATH = /^\/api\/projects\/([^/]+)$/;

interface DeletionTarget {
  kind: "app" | "project";
  projectId: string;
  appKey?: string;
}

function targetFor(method: string, pathname: string): DeletionTarget | undefined {
  if (method === "POST") {
    const app = APP_POST_PATH.exec(pathname);
    if (app !== null) {
      return {
        kind: "app",
        projectId: safeDecode(app[1] ?? ""),
        appKey: safeDecode(app[2] ?? ""),
      };
    }
    const project = PROJECT_POST_PATH.exec(pathname);
    if (project !== null) {
      return { kind: "project", projectId: safeDecode(project[1] ?? "") };
    }
    return undefined;
  }
  if (method === "DELETE") {
    const app = APP_DELETE_PATH.exec(pathname);
    if (app !== null) {
      return {
        kind: "app",
        projectId: safeDecode(app[1] ?? ""),
        appKey: safeDecode(app[2] ?? ""),
      };
    }
    const project = PROJECT_DELETE_PATH.exec(pathname);
    if (project !== null) {
      return { kind: "project", projectId: safeDecode(project[1] ?? "") };
    }
  }
  return undefined;
}

/** True only for the four destructive deletion routes; used by the server dispatcher. */
export function isDeletionRoute(method: string, pathname: string): boolean {
  return targetFor(method, pathname) !== undefined;
}

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function html(status: number, body: string): HttpResponse {
  return { status, contentType: "text/html; charset=utf-8", body };
}

function parseForm(body: string | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  if (body === undefined) {
    return fields;
  }
  for (const pair of body.split("&")) {
    const index = pair.indexOf("=");
    if (index < 0) {
      continue;
    }
    fields[safeDecode(pair.slice(0, index))] = safeDecode(pair.slice(index + 1));
  }
  return fields;
}

function parseJsonFields(body: string | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  if (body === undefined || body.trim().length === 0) {
    return fields;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fields;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        fields[key] = value;
      } else if (typeof value === "boolean" || typeof value === "number") {
        fields[key] = String(value);
      }
    }
  } catch {
    // A malformed JSON body leaves confirm undefined; the service then returns 400.
  }
  return fields;
}

function contentType(request: HttpRequest): string {
  return (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function mutationFields(request: HttpRequest): Record<string, string> {
  const type = contentType(request);
  if (type === "application/json") {
    return parseJsonFields(request.body);
  }
  return parseForm(request.body);
}

function booleanField(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "on";
}

function crossSiteRequest(request: HttpRequest): boolean {
  const origin = request.origin?.trim();
  if (origin === undefined || origin.length === 0) {
    return false;
  }
  if (origin === "null") {
    return true;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host = request.host?.trim();
  if (host === undefined || host.length === 0) {
    return true;
  }
  return originHost.toLowerCase() !== host.toLowerCase();
}

function defaultLocation(target: DeletionTarget): string {
  return target.kind === "project"
    ? "/projects"
    : `/projects/${encodeURIComponent(target.projectId)}`;
}

function deletionFailure(
  request: HttpRequest,
  error: DeletionError,
  location: string,
): HttpResponse {
  if (wantsHtml(request)) {
    return redirectWithNotice(location, error.message, "error");
  }
  return json(error.status, { error: error.message, code: error.code });
}

function deletionUnavailable(request: HttpRequest): HttpResponse {
  if (wantsHtml(request)) {
    return html(
      503,
      "<!doctype html><html><head><title>Deletion unavailable</title></head><body><p>Deletion is not configured on this coordinator.</p></body></html>",
    );
  }
  return json(503, { error: "deletion is not configured", code: "deletion_unavailable" });
}

/**
 * Async human-only deletion routes.
 *
 * Dispatched from `server.ts` before the synchronous `handleRequest`/`handleChat` paths because the
 * deletion service performs filesystem, runtime, and database work across awaits. Returns
 * `undefined` for any path it does not own so normal dispatch continues.
 */
export async function handleDeletion(
  deps: HttpDeps,
  request: HttpRequest,
): Promise<HttpResponse | undefined> {
  const target = targetFor(request.method, request.path);
  if (target === undefined) {
    return undefined;
  }
  if (deps.deletion === undefined) {
    return deletionUnavailable(request);
  }

  const fields = mutationFields(request);
  const confirm = fields.confirm ?? request.query?.confirm;
  const deleteFiles = booleanField(fields.deleteFiles ?? request.query?.deleteFiles);
  const location = safeLocalPath(
    fields.return_to ?? request.query?.return_to,
    defaultLocation(target),
  );

  if (crossSiteRequest(request)) {
    const message = "Cross-site deletion requests are not allowed.";
    return wantsHtml(request)
      ? redirectWithNotice(location, message, "error")
      : json(403, { error: message, code: "cross_site_request" });
  }

  const presentedAgentToken = agentTokenFor(request);
  if (
    presentedAgentToken !== undefined &&
    verifyAgentToken(deps.db, presentedAgentToken) !== undefined
  ) {
    return json(403, {
      error: "agent tokens may only call the MCP endpoint",
      code: "forbidden",
    });
  }

  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return wantsHtml(request)
      ? loginRedirectTo(location)
      : json(401, { error: "sign in required", code: "unauthorized" });
  }
  if (principal.kind !== "human") {
    const message = "Only a human operator may delete a project or application.";
    return wantsHtml(request)
      ? redirectWithNotice(location, message, "error")
      : json(403, { error: message, code: "forbidden" });
  }

  const options: DeleteOptions = {
    confirm: confirm ?? "",
    deleteFiles,
  };

  try {
    const result =
      target.kind === "app" && target.appKey !== undefined
        ? await deps.deletion.deleteApp(target.projectId, target.appKey, options)
        : await deps.deletion.deleteProject(target.projectId, options);
    if (wantsHtml(request)) {
      const successLocation =
        result.kind === "project"
          ? "/projects"
          : `/projects/${encodeURIComponent(result.projectId)}`;
      const deletedMessage =
        result.kind === "project" ? "Project deleted." : "Application deleted.";
      const warningCount = result.warnings.length;
      const message =
        warningCount === 0
          ? deletedMessage
          : `${deletedMessage} Completed with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`;
      return redirectWithNotice(successLocation, message, warningCount === 0 ? "success" : "error");
    }
    return json(200, result);
  } catch (error) {
    if (error instanceof DeletionError) {
      return deletionFailure(request, error, location);
    }
    const message = "Deletion failed; retry or check the coordinator logs.";
    return wantsHtml(request)
      ? redirectWithNotice(location, message, "error")
      : json(500, { error: message, code: "deletion_failed" });
  }
}
