import { ImageServiceError } from "../images/service.js";
import { findApp, toManagedApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const BUILD_PATH = /^\/api\/apps\/([^/]+)\/build$/;
const IMAGE_PATH = /^\/api\/apps\/([^/]+)\/image$/;
const ROLLBACK_PATH = /^\/api\/apps\/([^/]+)\/image\/rollback$/;
const LOGS_PATH = /^\/api\/apps\/([^/]+)\/image\/logs$/;

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function redirect(location: string): HttpResponse {
  return { status: 303, contentType: "text/plain", body: "", headers: { location } };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function wantsHtml(request: HttpRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function isFormContentType(header: string | undefined): boolean {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function isJsonContentType(header: string | undefined): boolean {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

function decodeField(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
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
    fields[decodeField(pair.slice(0, index))] = decodeField(pair.slice(index + 1));
  }
  return fields;
}

function parseJsonBody(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined || body.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function appHref(projectId: string, appKey: string): string {
  return `/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appKey)}`;
}

function appHrefWithNotice(
  projectId: string,
  appKey: string,
  message: string,
  tone: "success" | "error",
): string {
  const params = new URLSearchParams({ notice: message, tone });
  return `${appHref(projectId, appKey)}?${params.toString()}`;
}

function failure(error: ImageServiceError): HttpResponse {
  return json(error.status, { error: error.message, code: error.code });
}

function unknown(): HttpResponse {
  return json(404, { error: "not found", code: "not_found" });
}

function methodNotAllowed(): HttpResponse {
  return json(405, { error: "method not allowed", code: "method_not_allowed" });
}

function invalidMutationContentType(request: HttpRequest): HttpResponse | undefined {
  if (
    !isFormContentType(request.headers["content-type"]) &&
    !isJsonContentType(request.headers["content-type"]) &&
    (request.body ?? "").trim().length > 0
  ) {
    return json(400, {
      error: "content-type must be application/json or application/x-www-form-urlencoded",
      code: "invalid_input",
    });
  }
  return undefined;
}

/**
 * Human-only coordinator routes for the per-app image lifecycle.
 *
 * Builds are always explicit: these routes never enqueue work from registration or file changes.
 * Browser form posts redirect back to the application page with a notice; API callers get JSON.
 */
export async function handleImages(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required", code: "unauthorized" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human operator may manage app images", code: "forbidden" });
  }

  const buildMatch = BUILD_PATH.exec(request.path);
  const rollbackMatch = ROLLBACK_PATH.exec(request.path);
  const imageMatch = IMAGE_PATH.exec(request.path);
  const logsMatch = LOGS_PATH.exec(request.path);
  const match = buildMatch ?? rollbackMatch ?? imageMatch ?? logsMatch;
  if (match === null) {
    return unknown();
  }
  if (deps.images === undefined) {
    return json(503, { error: "image builds are not configured", code: "images_unavailable" });
  }

  const appKey = safeDecode(match[1] ?? "");
  const body = request.body;
  const form = parseForm(isFormContentType(request.headers["content-type"]) ? body : undefined);
  let projectId = request.query?.project ?? form.project;
  if (isJsonOrEmpty(request.headers["content-type"]) && body !== undefined) {
    const parsed = parseJsonBody(body);
    if (parsed === undefined) {
      return json(400, { error: "invalid JSON body", code: "invalid_input" });
    }
    if (typeof parsed.project === "string" && parsed.project.length > 0) {
      projectId = parsed.project;
    }
  }

  const found = findApp(deps, projectId, appKey);
  if (found === undefined) {
    return unknown();
  }

  if (buildMatch !== null) {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const invalid = invalidMutationContentType(request);
    if (invalid !== undefined) {
      return invalid;
    }
    try {
      const result = await deps.images.build(found.app.id, found.app.appKey);
      if (wantsHtml(request) || isFormContentType(request.headers["content-type"])) {
        return redirect(
          appHrefWithNotice(found.project.id, found.app.appKey, "Image build started.", "success"),
        );
      }
      return json(202, result);
    } catch (error) {
      if (error instanceof ImageServiceError) {
        if (wantsHtml(request) || isFormContentType(request.headers["content-type"])) {
          return redirect(
            appHrefWithNotice(found.project.id, found.app.appKey, error.message, "error"),
          );
        }
        return failure(error);
      }
      throw error;
    }
  }

  if (rollbackMatch !== null) {
    if (request.method !== "POST") {
      return methodNotAllowed();
    }
    const invalid = invalidMutationContentType(request);
    if (invalid !== undefined) {
      return invalid;
    }
    try {
      const result = await deps.images.rollback(found.app.id, found.app.appKey);
      let restarted = false;
      let restartWarning: string | undefined;
      if (deps.manager !== undefined) {
        const refreshed = findApp(deps, found.project.id, found.app.appKey) ?? found;
        try {
          restarted = await deps.manager.restartIfRunning(toManagedApp(refreshed));
        } catch (error) {
          restartWarning = error instanceof Error ? error.message : String(error);
        }
      }
      if (wantsHtml(request) || isFormContentType(request.headers["content-type"])) {
        const message =
          restartWarning === undefined
            ? "Image rolled back."
            : `Image rolled back, but the agent did not restart: ${restartWarning}`;
        return redirect(
          appHrefWithNotice(
            found.project.id,
            found.app.appKey,
            message,
            restartWarning === undefined ? "success" : "error",
          ),
        );
      }
      return json(200, {
        ...result,
        restarted,
        ...(restartWarning === undefined ? {} : { restartWarning }),
      });
    } catch (error) {
      if (error instanceof ImageServiceError) {
        if (wantsHtml(request) || isFormContentType(request.headers["content-type"])) {
          return redirect(
            appHrefWithNotice(found.project.id, found.app.appKey, error.message, "error"),
          );
        }
        return failure(error);
      }
      throw error;
    }
  }

  if (request.method !== "GET") {
    return methodNotAllowed();
  }

  try {
    if (logsMatch !== null) {
      return json(200, await deps.images.logs(found.app.id));
    }
    return json(200, await deps.images.status(found.app.id));
  } catch (error) {
    if (error instanceof ImageServiceError) {
      return failure(error);
    }
    throw error;
  }
}

function isJsonOrEmpty(type: string | undefined): boolean {
  return type === undefined || isJsonContentType(type);
}
