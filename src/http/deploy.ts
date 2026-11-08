import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { humanFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const NO_STORE = { "cache-control": "no-store" };
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEPLOY_PATHS = new Set(["/api/deploy/drain", "/api/deploy/resume"]);
const LONG_LIVED_PATHS = [
  /^\/api\/apps\/[^/]+\/events$/,
  /^\/api\/apps\/[^/]+\/sessions\/[^/]+\/events$/,
  /^\/api\/apps\/[^/]+\/process\/events$/,
];

function json(status: number, value: unknown, headers?: Record<string, string>): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    ...(headers === undefined ? {} : { headers }),
  };
}

function sameOrigin(request: HttpRequest): boolean {
  const origin = request.origin;
  if (origin === undefined || origin.length === 0) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = request.host ?? request.headers.host;
  return host !== undefined && parsed.host.toLowerCase() === host.toLowerCase();
}

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function isDeployRoute(pathname: string): boolean {
  return DEPLOY_PATHS.has(pathname);
}

export function isLongLivedStreamPath(pathname: string): boolean {
  return LONG_LIVED_PATHS.some((pattern) => pattern.test(pathname));
}

/** A `503` response for a mutation attempted while the coordinator is draining. */
export function drainingResponse(
  deps: Pick<HttpDeps, "drain">,
  request: Pick<HttpRequest, "method" | "path">,
): HttpResponse | undefined {
  const drain = deps.drain;
  if (drain === undefined || (!drain.isDraining() && !drain.isShuttingDown())) {
    return undefined;
  }
  if (!isMutatingMethod(request.method) || isDeployRoute(request.path)) {
    return undefined;
  }
  return json(
    503,
    {
      error: "coordinator is draining for a deployment; retry shortly",
      code: "draining",
      draining: true,
      drainId: drain.state().drainId,
    },
    { ...NO_STORE, "retry-after": "5" },
  );
}

function schemaVersionOf(db: HttpDeps["db"]): number | null {
  try {
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? null;
  } catch {
    return null;
  }
}

function revisionOf(): string {
  const revision = process.env.HANSE_REVISION?.trim();
  return revision === undefined || revision.length === 0 ? "unknown" : revision;
}

export async function handleDeploy(
  deps: Pick<HttpDeps, "db" | "drain">,
  request: HttpRequest,
): Promise<HttpResponse | undefined> {
  if (!isDeployRoute(request.path)) {
    return undefined;
  }
  if (request.method !== "POST") {
    return json(405, { error: "method not allowed" }, { ...NO_STORE, allow: "POST" });
  }
  if (!sameOrigin(request)) {
    return json(403, { error: "cross-site request rejected", code: "cross_origin" }, NO_STORE);
  }
  const principal = humanFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" }, NO_STORE);
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only the operator may control deployment draining" }, NO_STORE);
  }
  const drain = deps.drain;
  if (drain === undefined) {
    return json(
      503,
      { error: "deployment drain is not configured", code: "drain_unavailable" },
      NO_STORE,
    );
  }
  if (request.path === "/api/deploy/resume") {
    const state = drain.resume();
    return json(200, { draining: state.draining, drainId: state.drainId }, NO_STORE);
  }
  let payload: unknown = {};
  if (request.body !== undefined && request.body.trim().length > 0) {
    try {
      payload = JSON.parse(request.body);
    } catch {
      return json(400, { error: "invalid request", code: "invalid_body" }, NO_STORE);
    }
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return json(400, { error: "invalid request", code: "invalid_body" }, NO_STORE);
  }
  const rawTimeout = (payload as Record<string, unknown>).timeoutSeconds;
  if (
    rawTimeout !== undefined &&
    (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout < 0)
  ) {
    return json(
      400,
      { error: "timeoutSeconds must be a non-negative number", code: "invalid_timeout" },
      NO_STORE,
    );
  }
  const report = await drain.drain({
    ...(rawTimeout === undefined ? {} : { timeoutSeconds: rawTimeout }),
    schemaVersion: schemaVersionOf(deps.db),
    revision: revisionOf(),
  });
  return json(200, report, NO_STORE);
}

/** Register an SSE response so a drain closes it with a `deploy` event. */
export function registerSseDrain(
  deps: Pick<HttpDeps, "drain">,
  response: ServerResponse,
): () => void {
  const drain = deps.drain;
  if (drain === undefined) {
    return () => undefined;
  }
  return drain.registerStream(() => {
    if (response.destroyed || response.writableEnded) {
      return;
    }
    const payload = JSON.stringify({
      type: "deploy",
      draining: true,
      drainId: drain.state().drainId,
    });
    try {
      if (response.headersSent) {
        response.write(`event: deploy\ndata: ${payload}\n\n`);
      } else {
        response.writeHead(503, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "retry-after": "5",
        });
      }
    } catch {
      // The stream may already be gone; closing it is still the required outcome.
    }
    response.end();
  });
}

/** Send a WebSocket close frame with code 1012 (service restart) and end the socket. */
export function closeWebSocket(socket: Duplex, code = 1012): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  try {
    socket.write(Buffer.concat([Buffer.from([0x88, 0x02]), payload]));
  } catch {
    // Fall through to end/destroy.
  }
  socket.end();
}
