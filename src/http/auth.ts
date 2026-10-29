import { authenticate } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { HttpDeps, HttpRequest } from "./handler.js";

function decodeCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Read a cookie value from a raw `Cookie` header. Defaults to the session cookie. */
export function cookieToken(header: string | undefined, name = "hanse_token"): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const index = trimmed.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (trimmed.slice(0, index) === name) {
      return decodeCookie(trimmed.slice(index + 1));
    }
  }
  return undefined;
}

/** Authenticate a request via bearer token or the session cookie. */
export function principalFrom(
  deps: Pick<HttpDeps, "db">,
  request: HttpRequest,
): Principal | undefined {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  const token =
    bearer !== undefined && bearer.length > 0 ? bearer : cookieToken(request.headers.cookie);
  if (token === undefined || token.length === 0) {
    return undefined;
  }
  try {
    return authenticate(deps.db, `Bearer ${token}`);
  } catch {
    return undefined;
  }
}

/** Authenticate a request that must belong to a human operator. */
export function humanFrom(deps: Pick<HttpDeps, "db">, request: HttpRequest): Principal | undefined {
  const principal = principalFrom(deps, request);
  return principal?.kind === "human" ? principal : undefined;
}

/**
 * Authenticate a human operator from the session cookie only.
 *
 * The SPA document and `/api/ui/*` use this instead of `humanFrom`: a bearer token is deliberately
 * not accepted there, so a leaked operator bearer cannot read SPA page props. Agent cookies are
 * rejected as well because only `kind === "human"` is returned.
 */
export function humanFromCookie(
  deps: Pick<HttpDeps, "db">,
  request: HttpRequest,
): Principal | undefined {
  const token = cookieToken(request.headers.cookie);
  if (token === undefined || token.length === 0) {
    return undefined;
  }
  try {
    const principal = authenticate(deps.db, `Bearer ${token}`);
    return principal.kind === "human" ? principal : undefined;
  } catch {
    return undefined;
  }
}

/** Human check for cookie-only surfaces such as the IDE and the operator terminal. */
export function isHumanCookie(
  deps: Pick<HttpDeps, "db">,
  cookieHeader: string | undefined,
): boolean {
  const token = cookieToken(cookieHeader);
  if (token === undefined || token.length === 0) {
    return false;
  }
  try {
    return authenticate(deps.db, `Bearer ${token}`).kind === "human";
  } catch {
    return false;
  }
}
