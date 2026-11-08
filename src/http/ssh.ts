import type { Principal } from "../identity/principals.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import { SshError, type SshHostView } from "../ssh/types.js";
import { findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const JSON_HEADERS = { "cache-control": "no-store" };

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { ...JSON_HEADERS },
  };
}

function redirect(
  location: string,
  message?: string,
  tone: "success" | "error" = "success",
): HttpResponse {
  let target = location;
  if (message !== undefined) {
    const hashIndex = target.indexOf("#");
    const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
    const base = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const [pathname, query = ""] = base.split("?", 2);
    const params = new URLSearchParams(query);
    params.set("notice", message);
    params.set("tone", tone);
    target = `${pathname}?${params.toString()}${hash}`;
  }
  return {
    status: 303,
    contentType: "text/plain",
    body: "",
    headers: { location: target, ...JSON_HEADERS },
  };
}

function requestPath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.set(key, value);
  }
  const query = params.toString();
  return query.length === 0 ? request.path : `${request.path}?${query}`;
}

function wantsHtml(request: HttpRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function auth(
  deps: HttpDeps,
  request: HttpRequest,
): { principal: Principal } | { response: HttpResponse } {
  const principal = principalFrom(deps, request);
  if (principal?.kind === "human") {
    return { principal };
  }
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (
    bearer !== undefined &&
    bearer.length > 0 &&
    verifyAgentToken(deps.db, bearer) !== undefined
  ) {
    return { response: json(403, { error: "agent tokens may not use the SSH API" }) };
  }
  if (wantsHtml(request) || request.path === "/ssh") {
    return { response: redirect(`/login?next=${encodeURIComponent(requestPath(request))}`) };
  }
  return { response: json(principal === undefined ? 401 : 403, { error: "unauthorized" }) };
}

function apiHostView(host: SshHostView): unknown {
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    port: host.port,
    username: host.username,
    hostKeyFingerprint: host.hostKeyFingerprint,
    hostKeyPinnedAt: host.hostKeyPinnedAt,
    hostKeyMismatchAt: host.hostKeyMismatchAt,
    requireApproval: host.requireApproval,
    approvalIdleSec: host.approvalIdleSec,
    remoteRoot: host.remoteRoot,
    credential: host.credential,
    allowed: host.allowed,
    grant: host.grant,
    pendingApprovals: host.pendingApprovals,
  };
}

function asInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isSshRoute(_method: string, pathname: string): boolean {
  if (pathname === "/api/ssh" || pathname.startsWith("/api/ssh/")) return true;
  if (/^\/api\/projects\/[^/]+\/apps\/[^/]+\/ssh(?:\/|$)/.test(pathname)) return true;
  if (/^\/api\/apps\/[^/]+\/ssh(?:\/|$)/.test(pathname)) return true;
  return false;
}

function resolveApp(
  deps: HttpDeps,
  request: HttpRequest,
): { appId: string; projectId: string; appKey: string } | undefined {
  const match = /^\/api\/apps\/([^/]+)\/ssh\//.exec(request.path);
  if (match !== null) {
    const found = findApp(deps, request.query?.project, decodeURIComponent(match[1] as string));
    return found === undefined
      ? undefined
      : { appId: found.app.id, projectId: found.project.id, appKey: found.app.appKey };
  }
  const projectMatch = /^\/api\/projects\/([^/]+)\/apps\/([^/]+)\/ssh(?:\/|$)/.exec(request.path);
  if (projectMatch !== null) {
    const found = findApp(
      deps,
      decodeURIComponent(projectMatch[1] as string),
      decodeURIComponent(projectMatch[2] as string),
    );
    return found === undefined
      ? undefined
      : { appId: found.app.id, projectId: found.project.id, appKey: found.app.appKey };
  }
  return undefined;
}

export async function handleSsh(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const ssh = deps.ssh;
  if (ssh === undefined) return json(503, { error: "ssh_unavailable" });
  const authorization = auth(deps, request);
  if ("response" in authorization) return authorization.response;
  const principal = authorization.principal;

  if (request.method === "GET" && request.path === "/api/ssh/hosts") {
    return json(200, {
      hosts: ssh
        .listAllHosts()
        .map(({ host, credential }) =>
          apiHostView({ ...host, credential, allowed: false, grant: null, pendingApprovals: 0 }),
        ),
    });
  }
  if (request.method === "GET" && request.path === "/api/ssh/approvals/count") {
    return json(200, { count: ssh.countPending() });
  }
  if (request.method === "POST" && request.path === "/api/ssh/hosts") {
    try {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      const created = ssh.createHost(
        {
          name: String(body.name ?? ""),
          address: String(body.address ?? ""),
          ...(typeof body.port === "number" ? { port: body.port } : {}),
          username: String(body.username ?? ""),
          privateKey: String(body.privateKey ?? ""),
          ...(typeof body.requireApproval === "boolean"
            ? { requireApproval: body.requireApproval }
            : {}),
          ...(typeof body.approvalIdleSec === "number"
            ? { approvalIdleSec: body.approvalIdleSec }
            : {}),
          ...(body.remoteRoot === null || typeof body.remoteRoot === "string"
            ? { remoteRoot: body.remoteRoot as string | null }
            : {}),
        },
        principal.name,
      );
      return json(201, { host: apiHostView(created) });
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const hostMatch = /^\/api\/ssh\/hosts\/([^/]+)(?:\/(test|re-pin))?$/.exec(request.path);
  if (hostMatch !== null) {
    const hostId = decodeURIComponent(hostMatch[1] as string);
    const action = hostMatch[2];
    try {
      if (request.method === "PATCH" && action === undefined) {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        return json(200, {
          host: apiHostView(
            ssh.updateHost(
              hostId,
              {
                ...(typeof body.name === "string" ? { name: body.name } : {}),
                ...(typeof body.address === "string" ? { address: body.address } : {}),
                ...(typeof body.port === "number" ? { port: body.port } : {}),
                ...(typeof body.username === "string" ? { username: body.username } : {}),
                ...(typeof body.privateKey === "string" ? { privateKey: body.privateKey } : {}),
                ...(typeof body.requireApproval === "boolean"
                  ? { requireApproval: body.requireApproval }
                  : {}),
                ...(typeof body.approvalIdleSec === "number"
                  ? { approvalIdleSec: body.approvalIdleSec }
                  : {}),
                ...(body.remoteRoot === null || typeof body.remoteRoot === "string"
                  ? { remoteRoot: body.remoteRoot as string | null }
                  : {}),
              },
              principal.name,
            ),
          ),
        });
      }
      if (request.method === "DELETE" && action === undefined) {
        ssh.deleteHost(hostId, principal.name);
        return json(200, { deleted: true });
      }
      if (request.method === "POST" && action === "test") {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        return json(200, {
          result: await ssh.testHost(hostId, { ignorePin: body.ignorePin === true }),
        });
      }
      if (request.method === "POST" && action === "re-pin") {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        return json(200, {
          host: apiHostView(ssh.rePin(hostId, String(body.fingerprint ?? ""), principal.name)),
        });
      }
      return json(405, { error: "method_not_allowed" });
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(code === "ssh_host_not_allowed" ? 404 : 400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const appApprovals = /^\/api\/apps\/[^/]+\/ssh\/approvals(?:\/([^/]+)\/decision)?$/.exec(
    request.path,
  );
  if (appApprovals !== null) {
    const resolved = resolveApp(deps, request);
    if (resolved === undefined) return json(404, { error: "app_not_found" });
    try {
      if (request.method === "GET" && appApprovals[1] === undefined) {
        return json(200, { approvals: ssh.listPending(resolved.appId) });
      }
      if (request.method === "POST" && appApprovals[1] !== undefined) {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        const decision = body.decision === "reject" ? "reject" : "approve";
        return json(200, {
          approval: ssh.decideApproval(
            decodeURIComponent(appApprovals[1] as string),
            resolved.appId,
            decision,
            principal.name,
          ),
        });
      }
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(code === "ssh_approval_expired" ? 409 : 400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return json(405, { error: "method_not_allowed" });
  }

  const appAudit = /^\/api\/apps\/[^/]+\/ssh\/audit$/.test(request.path);
  if (appAudit && request.method === "GET") {
    const resolved = resolveApp(deps, request);
    if (resolved === undefined) return json(404, { error: "app_not_found" });
    const limit = asInt(request.query?.limit) ?? 50;
    const before = asInt(request.query?.before);
    return json(200, {
      audit: ssh.listAudit(resolved.appId, Math.min(Math.max(limit, 1), 200), before),
    });
  }

  const projectGrants =
    /^\/api\/projects\/[^/]+\/apps\/[^/]+\/ssh(?:\/grants\/([^/]+)\/revoke)?$/.exec(request.path);
  if (projectGrants !== null) {
    const resolved = resolveApp(deps, request);
    if (resolved === undefined) return json(404, { error: "app_not_found" });
    try {
      if (request.method === "GET" && projectGrants[1] === undefined) {
        const agent = {
          appId: resolved.appId,
          projectId: resolved.projectId,
          appKey: resolved.appKey,
        };
        return json(200, {
          hosts: ssh.listHosts(agent).map(apiHostView),
          grants: ssh.listGrants(resolved.appId),
        });
      }
      if (request.method === "POST" && projectGrants[1] === undefined) {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        const hostIds = Array.isArray(body.hostIds)
          ? body.hostIds.filter((value): value is string => typeof value === "string")
          : [];
        ssh.replaceAppHosts(resolved.appId, hostIds, principal.name);
        return json(200, {
          hosts: ssh
            .listHosts({
              appId: resolved.appId,
              projectId: resolved.projectId,
              appKey: resolved.appKey,
            })
            .map(apiHostView),
        });
      }
      if (request.method === "POST" && projectGrants[1] !== undefined) {
        ssh.revokeGrant(decodeURIComponent(projectGrants[1] as string), principal.name);
        return json(200, { revoked: true });
      }
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return json(405, { error: "method_not_allowed" });
  }

  return json(404, { error: "not_found" });
}
