import type { Principal } from "../identity/principals.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import { SshError, type SshHostView, type SshTestResult } from "../ssh/types.js";
import { findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import { buildSite, type PageChrome } from "./dashboard.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import { appShell, escapeHtml, icon, pageHeader, safeLocalPath } from "./ui.js";

const JSON_HEADERS = { "cache-control": "no-store" };

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { ...JSON_HEADERS },
  };
}

function html(status: number, body: string): HttpResponse {
  return {
    status,
    contentType: "text/html; charset=utf-8",
    body,
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

function form(body: string | undefined): URLSearchParams {
  return new URLSearchParams(body ?? "");
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

function noticeFrom(request: HttpRequest): PageChrome["notice"] {
  const message = request.query?.notice;
  if (message === undefined || message.trim().length === 0) return undefined;
  return {
    message,
    tone: request.query?.tone === "error" ? ("error" as const) : ("success" as const),
  };
}

function hostRow(host: SshHostView, projectId: string, appKey: string): string {
  const credential = host.credential;
  const grant = host.grant;
  const pin = host.hostKeyFingerprint ?? "unpinned";
  return `<tr>
    <td><strong>${escapeHtml(host.name)}</strong><p class="mono small">${escapeHtml(host.address)}:${host.port} · ${escapeHtml(host.username)}</p></td>
    <td><span class="mono small">${escapeHtml(pin)}</span>${host.hostKeyMismatchAt === null ? "" : `<p class="small"><span class="badge badge-warning">key mismatch</span></p>`}</td>
    <td><span class="mono small">${escapeHtml(credential?.fingerprint ?? "no key")}</span></td>
    <td>${host.requireApproval ? '<span class="badge">approval</span>' : '<span class="badge badge-ghost">direct</span>'}${grant === null ? "" : `<p class="small">granted until ${escapeHtml(grant.idleExpiresAt)}</p>`}${host.pendingApprovals > 0 ? `<p class="small">${host.pendingApprovals} pending</p>` : ""}</td>
    <td>
      <div class="cluster">
        <form method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/test">
          <input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" />
          <button class="btn btn-ghost btn-sm" type="submit">${icon("activity")}Test</button>
        </form>
        <form method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/test">
          <input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" />
          <input type="hidden" name="ignorePin" value="1" />
          <button class="btn btn-ghost btn-sm" type="submit">${icon("refresh")}Test &amp; prepare re-pin</button>
        </form>
        <form method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/delete" data-ssh-confirm="Delete this SSH host?">
          <input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" />
          <button class="btn btn-ghost btn-sm" type="submit">${icon("trash")}Delete</button>
        </form>
      </div>
      <details class="stack--tight">
        <summary class="small">Edit / re-pin</summary>
        <form class="stack--tight" method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/update">
          <input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" />
          <label class="field"><span class="field__label">Name</span><input class="input" name="name" value="${escapeHtml(host.name)}" required /></label>
          <label class="field"><span class="field__label">Address</span><input class="input" name="address" value="${escapeHtml(host.address)}" required /></label>
          <label class="field"><span class="field__label">Port</span><input class="input" name="port" type="number" min="1" max="65535" value="${host.port}" required /></label>
          <label class="field"><span class="field__label">User</span><input class="input" name="username" value="${escapeHtml(host.username)}" required /></label>
          <label class="field"><span class="field__label">Remote root</span><input class="input" name="remoteRoot" value="${escapeHtml(host.remoteRoot ?? "")}" placeholder="/srv/app" /></label>
          <label class="field"><span class="field__label">New private key (optional)</span><textarea class="textarea" name="privateKey" rows="3" spellcheck="false"></textarea></label>
          <label class="check"><input type="checkbox" name="requireApproval" value="1" ${host.requireApproval ? "checked" : ""} /><span>Ask for approval</span></label>
          <label class="field"><span class="field__label">Idle grant</span><select class="select" name="approvalIdleSec">${[300, 900, 1800, 3600, 7200].map((seconds) => `<option value="${seconds}" ${seconds === host.approvalIdleSec ? "selected" : ""}>${seconds / 60} min</option>`).join("")}</select></label>
          <button class="btn btn-primary btn-sm" type="submit">Save host</button>
        </form>
        <form class="cluster" method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/re-pin">
          <input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" />
          <label class="field"><span class="field__label">Re-pin fingerprint</span><input class="input mono" name="fingerprint" placeholder="SHA256:..." required /></label>
          <button class="btn btn-secondary btn-sm" type="submit">Re-pin</button>
        </form>
      </details>
    </td>
  </tr>`;
}

function renderPage(
  deps: HttpDeps,
  request: HttpRequest,
  principal: Principal,
  extra?: { test?: SshTestResult & { hostName: string }; error?: string },
): HttpResponse {
  const ssh = deps.ssh;
  if (ssh === undefined) return html(503, "SSH is not configured");
  const site = buildSite(deps);
  const projectId = request.query?.project ?? "";
  const appKey = request.query?.app ?? "";
  const found =
    projectId.length > 0 && appKey.length > 0 ? findApp(deps, projectId, appKey) : undefined;
  const agent =
    found === undefined
      ? undefined
      : { appId: found.app.id, projectId: found.project.id, appKey: found.app.appKey };
  const hosts = ssh.listAllHosts();
  const views = agent === undefined ? [] : ssh.listHosts(agent);
  const allowed = new Set(views.map((host) => host.id));
  const grants = found === undefined ? [] : ssh.listGrants(found.app.id);
  const pending = ssh.listPending(found?.app.id);
  const audit = ssh.listAudit(found?.app.id, 30);
  const projectOptions = deps
    .getProjects()
    .map(
      (project) =>
        `<option value="${escapeHtml(project.id)}" ${project.id === projectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`,
    )
    .join("");
  const appOptions = deps
    .getProjects()
    .flatMap((project) => project.service.listApps().map((app) => ({ project, app })))
    .filter(({ project }) => projectId.length === 0 || project.id === projectId)
    .map(
      ({ project, app }) =>
        `<option value="${escapeHtml(app.appKey)}" data-project="${escapeHtml(project.id)}" ${app.appKey === appKey && project.id === projectId ? "selected" : ""}>${escapeHtml(project.name)} / ${escapeHtml(app.appKey)}</option>`,
    )
    .join("");
  const testCard =
    extra?.test === undefined
      ? ""
      : `<section class="card section" id="ssh-test-result"><div class="card__body stack--tight"><h2 class="card__title">Test ${escapeHtml(extra.test.hostName)}</h2><p class="small">${extra.test.ok ? "Authenticated." : escapeHtml(extra.test.message ?? "Failed.")}</p>${extra.test.fingerprint === undefined ? "" : `<p class="mono small">${escapeHtml(extra.test.fingerprint)}</p>${extra.test.previousFingerprint === null || extra.test.previousFingerprint === undefined ? "" : `<p class="mono small">previous: ${escapeHtml(extra.test.previousFingerprint)}</p>`}`}</div></section>`;
  const errorCard =
    extra?.error === undefined
      ? ""
      : `<section class="card section" id="ssh-error"><div class="card__body"><p class="field-error">${escapeHtml(extra.error)}</p></div></section>`;
  const hostRows = hosts
    .map(({ host }) => {
      const view: SshHostView = {
        ...host,
        credential: hosts.find((entry) => entry.host.id === host.id)?.credential ?? null,
        allowed: agent === undefined ? false : allowed.has(host.id),
        grant: views.find((entry) => entry.id === host.id)?.grant ?? null,
        pendingApprovals: views.find((entry) => entry.id === host.id)?.pendingApprovals ?? 0,
      };
      return hostRow(view, projectId, appKey);
    })
    .join("");
  const grantRows = grants
    .map(
      (grant) =>
        `<tr><td class="mono small">${escapeHtml(grant.hostId)}</td><td class="small">${escapeHtml(grant.grantedBy)}</td><td class="small">${escapeHtml(grant.idleExpiresAt)}</td><td>${grant.revokedAt === null ? "active" : "revoked"}</td><td>${grant.revokedAt === null ? `<form method="post" action="/ssh/grants/${encodeURIComponent(grant.id)}/revoke"><input type="hidden" name="appId" value="${escapeHtml(grant.appId)}" /><input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" /><button class="btn btn-ghost btn-sm" type="submit">Revoke</button></form>` : ""}</td></tr>`,
    )
    .join("");
  const pendingRows = pending
    .map(
      (approval) =>
        `<tr><td><strong>${escapeHtml(approval.hostName)}</strong><p class="small">${escapeHtml(approval.appKey)} · ${escapeHtml(approval.action)}</p></td><td><pre class="ssh-command">${escapeHtml(approval.commandPreview)}</pre></td><td class="small">${escapeHtml(approval.expiresAt)}</td><td><div class="cluster"><form method="post" action="/ssh/approvals/${encodeURIComponent(approval.id)}/decision"><input type="hidden" name="appId" value="${escapeHtml(approval.appId)}" /><input type="hidden" name="decision" value="approve" /><input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" /><button class="btn btn-primary btn-sm" type="submit">Approve</button></form><form method="post" action="/ssh/approvals/${encodeURIComponent(approval.id)}/decision"><input type="hidden" name="appId" value="${escapeHtml(approval.appId)}" /><input type="hidden" name="decision" value="reject" /><input type="hidden" name="return_to" value="${escapeHtml(`/ssh?project=${projectId}&app=${appKey}`)}" /><button class="btn btn-ghost btn-sm" type="submit">Reject</button></form></div></td></tr>`,
    )
    .join("");
  const auditRows = audit
    .map(
      (entry) =>
        `<tr><td class="small">${escapeHtml(entry.startedAt)}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.hostName)}</td><td class="mono small">${escapeHtml(entry.commandPreview ?? "")}</td><td class="small">${entry.exitCode ?? ""} ${escapeHtml(entry.errorCode ?? "")}</td></tr>`,
    )
    .join("");
  const body = `${pageHeader({ overline: "Operator", title: "SSH hosts", description: "Global hosts, per-application grants, approvals, and audit.", actions: `<a class="btn btn-secondary" href="/ssh">Refresh</a>` })}
    ${errorCard}${testCard}
    <section class="card section" id="ssh-add-host"><div class="card__body"><h2 class="card__title">Add host</h2><p class="hint">Do not target the coordinator host or a host that can read coordinator state or the Docker socket.</p><form class="stack" method="post" action="/ssh/hosts">
      <div class="grid grid--2"><label class="field"><span class="field__label">Name</span><input class="input" name="name" required /></label><label class="field"><span class="field__label">Address</span><input class="input" name="address" required /></label><label class="field"><span class="field__label">Port</span><input class="input" name="port" type="number" min="1" max="65535" value="22" /></label><label class="field"><span class="field__label">User</span><input class="input" name="username" required /></label></div>
      <label class="field"><span class="field__label">Private key</span><textarea class="textarea mono" name="privateKey" rows="5" required spellcheck="false"></textarea></label>
      <label class="field"><span class="field__label">Remote root (optional)</span><input class="input" name="remoteRoot" placeholder="/srv/app" /></label>
      <label class="check"><input type="checkbox" name="requireApproval" value="1" checked /><span>Ask for approval</span></label>
      <button class="btn btn-primary" type="submit">Add host</button>
    </form></div></section>
    <section class="card section" id="ssh-hosts"><div class="card__head"><h2 class="card__title">Hosts</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>Host</th><th>Host key</th><th>Client key</th><th>Access</th><th>Actions</th></tr></thead><tbody>${hostRows || '<tr><td colspan="5" class="small">No hosts configured.</td></tr>'}</tbody></table></div></section>
    <section class="card section" id="ssh-grants"><div class="card__head"><h2 class="card__title">Application grants</h2></div><div class="card__body"><form class="cluster" method="get" action="/ssh"><label class="field"><span class="field__label">Project</span><select class="select" name="project">${projectOptions}<option value="">All</option></select></label><label class="field"><span class="field__label">Application</span><select class="select" name="app">${appOptions}</select></label><button class="btn btn-secondary btn-sm" type="submit">Select</button></form>${found === undefined ? '<p class="small">Select an application to manage its allowlist.</p>' : `<form class="stack--tight" method="post" action="/ssh/grants"><input type="hidden" name="project" value="${escapeHtml(found.project.id)}" /><input type="hidden" name="app" value="${escapeHtml(found.app.appKey)}" /><div class="stack--tight">${hosts.map(({ host }) => `<label class="check"><input type="checkbox" name="hostIds" value="${escapeHtml(host.id)}" ${allowed.has(host.id) ? "checked" : ""} /><span>${escapeHtml(host.name)} <span class="mono small">${escapeHtml(host.address)}</span></span></label>`).join("")}</div><button class="btn btn-primary btn-sm" type="submit">Save allowlist</button></form>`}</div>${grants.length > 0 ? `<div class="table-wrap"><table class="table"><thead><tr><th>Host</th><th>Granted by</th><th>Idle until</th><th>State</th><th></th></tr></thead><tbody>${grantRows}</tbody></table></div>` : ""}</section>
    <section class="card section" id="ssh-approvals"><div class="card__head"><h2 class="card__title">Pending approvals</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>Request</th><th>Command</th><th>Expires</th><th></th></tr></thead><tbody>${pendingRows || '<tr><td colspan="4" class="small">No pending approvals.</td></tr>'}</tbody></table></div></section>
    <section class="card section" id="ssh-audit"><div class="card__head"><h2 class="card__title">Audit</h2></div><div class="table-wrap"><table class="table"><thead><tr><th>Started</th><th>Action</th><th>Host</th><th>Preview</th><th>Result</th></tr></thead><tbody>${auditRows || '<tr><td colspan="5" class="small">No SSH activity.</td></tr>'}</tbody></table></div></section>`;
  return html(
    200,
    appShell({
      title: "SSH",
      active: "ssh",
      breadcrumb: [{ label: "Settings", href: "/settings" }, { label: "SSH" }],
      projects: site.projects.map((project) => ({
        id: project.id,
        name: project.name,
        appCount: project.apps.length,
      })),
      pendingCount: site.pendingCount,
      sshPendingCount: site.sshPendingCount,
      operatorName: principal.name,
      notice: noticeFrom(request),
      header: "",
      scripts: ["/assets/ssh.js"],
      body,
    }),
  );
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

function asBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "1" || value === "true" || value === "on";
}

function asInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isSshRoute(_method: string, pathname: string): boolean {
  if (pathname === "/ssh" || pathname.startsWith("/ssh/")) return true;
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

  if (request.method === "GET" && request.path === "/ssh") {
    return renderPage(deps, request, principal);
  }

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

  const pageAction = /^\/ssh\/hosts\/([^/]+)\/(test|update|delete|re-pin)$/.exec(request.path);
  if (request.method === "POST" && pageAction !== null) {
    const hostId = decodeURIComponent(pageAction[1] as string);
    const action = pageAction[2];
    const fields = form(request.body);
    const returnTo = safeLocalPath(fields.get("return_to") ?? "/ssh", "/ssh");
    try {
      if (action === "test") {
        const result = await ssh.testHost(hostId, { ignorePin: fields.get("ignorePin") === "1" });
        const host = ssh.getHostView(hostId);
        return renderPage(
          deps,
          {
            ...request,
            query: Object.fromEntries(new URLSearchParams(returnTo.split("?")[1] ?? "")),
          },
          principal,
          { test: { ...result, hostName: host?.name ?? hostId } },
        );
      }
      if (action === "update") {
        ssh.updateHost(
          hostId,
          {
            name: fields.get("name") ?? undefined,
            address: fields.get("address") ?? undefined,
            port: asInt(fields.get("port") ?? undefined),
            username: fields.get("username") ?? undefined,
            ...(fields.get("privateKey")?.trim()
              ? { privateKey: fields.get("privateKey") as string }
              : {}),
            requireApproval: asBool(fields.get("requireApproval") ?? undefined),
            approvalIdleSec: asInt(fields.get("approvalIdleSec") ?? undefined),
            ...(fields.get("remoteRoot") === null
              ? {}
              : { remoteRoot: fields.get("remoteRoot")?.trim() || null }),
          },
          principal.name,
        );
        return redirect(returnTo, "Host updated");
      }
      if (action === "delete") {
        ssh.deleteHost(hostId, principal.name);
        return redirect(returnTo, "Host deleted");
      }
      if (action === "re-pin") {
        ssh.rePin(hostId, fields.get("fingerprint") ?? "", principal.name);
        return redirect(returnTo, "Host key re-pinned");
      }
    } catch (error) {
      return renderPage(deps, request, principal, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (request.method === "POST" && request.path === "/ssh/hosts") {
    const fields = form(request.body);
    try {
      ssh.createHost(
        {
          name: fields.get("name") ?? "",
          address: fields.get("address") ?? "",
          port: asInt(fields.get("port") ?? undefined),
          username: fields.get("username") ?? "",
          privateKey: fields.get("privateKey") ?? "",
          requireApproval: asBool(fields.get("requireApproval") ?? undefined),
          ...(fields.get("remoteRoot") === null
            ? {}
            : { remoteRoot: fields.get("remoteRoot")?.trim() || null }),
        },
        principal.name,
      );
      return redirect("/ssh", "Host added");
    } catch (error) {
      return renderPage(deps, request, principal, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (request.method === "POST" && request.path === "/ssh/grants") {
    const fields = form(request.body);
    const found = findApp(deps, fields.get("project") ?? undefined, fields.get("app") ?? "");
    if (found === undefined)
      return renderPage(deps, request, principal, { error: "Application not found" });
    try {
      ssh.replaceAppHosts(found.app.id, fields.getAll("hostIds"), principal.name);
      return redirect(
        `/ssh?project=${encodeURIComponent(found.project.id)}&app=${encodeURIComponent(found.app.appKey)}`,
        "Allowlist saved",
      );
    } catch (error) {
      return renderPage(deps, request, principal, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (request.method === "POST" && request.path.startsWith("/ssh/grants/")) {
    const match = /^\/ssh\/grants\/([^/]+)\/revoke$/.exec(request.path);
    if (match !== null) {
      try {
        ssh.revokeGrant(decodeURIComponent(match[1] as string), principal.name);
        return redirect(
          safeLocalPath(form(request.body).get("return_to") ?? "/ssh", "/ssh"),
          "Grant revoked",
        );
      } catch (error) {
        return renderPage(deps, request, principal, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (request.method === "POST" && request.path.startsWith("/ssh/approvals/")) {
    const match = /^\/ssh\/approvals\/([^/]+)\/decision$/.exec(request.path);
    if (match !== null) {
      const fields = form(request.body);
      try {
        ssh.decideApproval(
          decodeURIComponent(match[1] as string),
          fields.get("appId") ?? "",
          fields.get("decision") === "reject" ? "reject" : "approve",
          principal.name,
        );
        return redirect(
          safeLocalPath(fields.get("return_to") ?? "/ssh", "/ssh"),
          "Approval recorded",
        );
      } catch (error) {
        return renderPage(deps, request, principal, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return json(404, { error: "not_found" });
}
