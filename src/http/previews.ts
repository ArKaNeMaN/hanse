import { findApp } from "./apps.js";
import { humanFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const LIST_PATH = /^\/api\/apps\/([^/]+)\/previews$/;
const CLOSE_PATH = /^\/api\/apps\/([^/]+)\/previews\/([^/]+)\/close$/;

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { "cache-control": "no-store" },
  };
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Absent Origin is allowed; a literal `null`, a malformed value, or a host mismatch is not. */
function sameOrigin(request: HttpRequest): boolean {
  const origin = request.origin;
  if (origin === undefined) {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  const host = request.host;
  if (host === undefined || host.length === 0) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** True only for the human preview list and close API routes. */
export function isPreviewsRoute(method: string, pathname: string): boolean {
  return (
    (method === "GET" && LIST_PATH.test(pathname)) ||
    (method === "POST" && CLOSE_PATH.test(pathname))
  );
}

/**
 * Human-only preview list/close API.
 *
 * The preview registry is in-memory and runner-only; without a configured service the route
 * reports `preview_unavailable` so supervisor mode stays explicit.
 */
export async function handlePreviews(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  if (humanFrom(deps, request) === undefined) {
    return json(401, { error: "sign in required" });
  }
  const previews = deps.previews;
  if (previews === undefined) {
    return json(503, { error: "previews are not configured", code: "preview_unavailable" });
  }
  const projectId = request.query?.project?.trim();
  if (projectId === undefined || projectId.length === 0) {
    return json(400, { error: "project is required", code: "project_required" });
  }

  const listMatch = LIST_PATH.exec(request.path);
  const closeMatch = CLOSE_PATH.exec(request.path);
  const match = listMatch ?? closeMatch;
  if (match === null) {
    return json(404, { error: "not found" });
  }
  const appKey = decodePathSegment(match[1] ?? "");
  if (appKey === undefined) {
    return json(404, { error: "unknown application", code: "unknown_app" });
  }
  const found = findApp(deps, projectId, appKey);
  if (found === undefined) {
    return json(404, { error: "unknown application", code: "unknown_app" });
  }

  if (listMatch !== null) {
    return json(200, { previews: previews.views(found.app.id) });
  }

  if (!sameOrigin(request)) {
    return json(403, { error: "cross-origin request rejected", code: "origin_rejected" });
  }
  const key = decodePathSegment(closeMatch?.[2] ?? "");
  const closed = key === undefined ? false : previews.close(found.app.id, key);
  return json(200, { ok: true, closed });
}
