import type { HttpRequest, HttpResponse } from "./handler.js";

/** The SPA bundle generation. Bump this when an `/api/ui/*` shape changes incompatibly. */
export const UI_VERSION = "2";

export const UI_VERSION_HEADER = "x-hanse-ui-version";

/**
 * The hard-cutover gate for the SPA surface. Returns the `409` reload response when the request
 * carries a missing or different UI version; the caller runs it after authentication so a signed-out
 * request keeps its `401`/`403`.
 */
export function requireUiVersion(request: HttpRequest): HttpResponse | undefined {
  if (request.headers[UI_VERSION_HEADER] === UI_VERSION) {
    return undefined;
  }
  return {
    status: 409,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ error: "UI reload required", code: "ui_reload_required" }),
    headers: { "cache-control": "no-store" },
  };
}
