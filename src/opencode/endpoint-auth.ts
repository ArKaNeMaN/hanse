/**
 * Process-local Basic authorization for managed `opencode serve` endpoints.
 *
 * The runtime protocol intentionally carries only the endpoint. The coordinator keeps the matching
 * password in memory after `ensure`, so every coordinator -> opencode call (JSON and SSE) can add
 * the header without persisting the secret in the manager entry or the spec.
 */

/** opencode's default Basic-auth username when `OPENCODE_SERVER_PASSWORD` is set. */
export const OPENCODE_BASIC_USERNAME = "opencode";

const authorizations = new Map<string, string>();

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "");
}

/** Register the Basic header for one endpoint. Re-registering replaces the previous header. */
export function setEndpointAuthorization(
  endpoint: string,
  username: string,
  password: string,
): void {
  const key = normalizeEndpoint(endpoint);
  if (key.length === 0) return;
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  authorizations.set(key, `Basic ${token}`);
}

/** Authorization header for an endpoint, or `undefined` when none is registered. */
export function authorizationFor(endpoint: string): string | undefined {
  return authorizations.get(normalizeEndpoint(endpoint));
}

/** Remove the authorization for an endpoint (stop, detach, or relaunch). */
export function clearEndpointAuthorization(endpoint: string): void {
  authorizations.delete(normalizeEndpoint(endpoint));
}
