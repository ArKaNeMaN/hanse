import { isPagePath, matchPage } from "../shared/routes.js";

export interface PageRequestLike {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

function acceptsHtml(request: PageRequestLike): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

/**
 * True for a browser page request. Known page routes bypass the `Accept` check so `/login` and
 * other pages still work for clients that send a wildcard or JSON accept; unknown paths need HTML
 * `Accept` and must not look like an API, asset, IDE, preview, internal, or health path.
 */
export function isHtmlPageRequest(request: PageRequestLike): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  if (!isPagePath(request.path)) {
    return false;
  }
  if (matchPage(request.path) !== undefined) {
    return true;
  }
  return acceptsHtml(request);
}
