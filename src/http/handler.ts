import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ConfigError } from "../config/load.js";
import { decideApproval } from "../coordinator/approval.js";
import type { CoordinatorService } from "../coordinator/service.js";
import type { GitService } from "../git/service.js";
import { authenticate } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { ImageService } from "../images/service.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import type { InstanceManager } from "../opencode/manager.js";
import { resolveAppPath } from "../runtime/app-path.js";
import type { SettingsService } from "../settings/index.js";
import type { SshService } from "../ssh/service.js";
import type { SqliteDatabase } from "../store/index.js";
import { renderApplication } from "./application.js";
import { humanFrom, principalFrom } from "./auth.js";
import {
  buildSite,
  type PageChrome,
  renderErrorPage,
  renderHandoffs,
  renderNotFound,
  renderOverview,
  renderProject,
  renderProjects,
} from "./dashboard.js";
import { renderTerminalPage } from "./terminal.js";
import { loginPage, type Notice, safeLocalPath } from "./ui.js";

export interface ProjectContext {
  id: string;
  name: string;
  rootPath: string;
  workspaceRoot: string;
  service: CoordinatorService;
}

export interface HttpDeps {
  db: SqliteDatabase;
  workspaceRoot: string;
  getProjects: () => ProjectContext[];
  git: GitService;
  manager?: InstanceManager;
  settings?: SettingsService;
  ssh?: SshService;
  runner?: { url: string; token: string };
  /** Present when the coordinator is wired to the runner; image routes 503 otherwise. */
  images?: ImageService;
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
  query?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const ASSETS: Record<string, { file: string; contentType: string }> = {
  "/assets/app.css": { file: "app.css", contentType: "text/css; charset=utf-8" },
  "/assets/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/assets/chat.js": { file: "chat.js", contentType: "text/javascript; charset=utf-8" },
  "/assets/chat-core.js": {
    file: "chat-core.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/chat-diff.js": {
    file: "chat-diff.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/chat-highlight.js": {
    file: "chat-highlight.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/chat-highlight-worker.js": {
    file: "chat-highlight-worker.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/git.js": { file: "git.js", contentType: "text/javascript; charset=utf-8" },
  "/assets/git-settings.js": {
    file: "git-settings.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/images.js": { file: "images.js", contentType: "text/javascript; charset=utf-8" },
  "/assets/vendor/prism/prism-1.30.0.min.js": {
    file: "vendor/prism/prism-1.30.0.min.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/ssh.js": { file: "ssh.js", contentType: "text/javascript; charset=utf-8" },
  "/assets/settings.js": {
    file: "settings.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/terminal.js": {
    file: "terminal.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
};

function json(status: number, value: unknown, headers?: Record<string, string>): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers,
  };
}

function html(status: number, body: string, headers?: Record<string, string>): HttpResponse {
  return { status, contentType: "text/html; charset=utf-8", body, headers };
}

function redirect(location: string, headers?: Record<string, string>): HttpResponse {
  return { status: 303, contentType: "text/plain", body: "", headers: { location, ...headers } };
}

function safeDecode(value: string): string {
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
    fields[safeDecode(pair.slice(0, index))] = safeDecode(pair.slice(index + 1));
  }
  return fields;
}

function wantsHtml(request: HttpRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function queryString(query: Record<string, string> | undefined): string {
  if (query === undefined) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, value);
  }
  const encoded = params.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
}

function requestPath(request: HttpRequest): string {
  return `${request.path}${queryString(request.query)}`;
}

function loginRedirect(request: HttpRequest): HttpResponse {
  return redirect(`/login?next=${encodeURIComponent(requestPath(request))}`);
}

function loginRedirectTo(next: string): HttpResponse {
  return redirect(`/login?next=${encodeURIComponent(safeLocalPath(next, "/"))}`);
}

function loginDestination(value: string | undefined): string {
  const target = safeLocalPath(value, "/");
  if (target === "/login" || target.startsWith("/login?")) {
    return "/";
  }
  return target;
}

function noticeFrom(query: Record<string, string> | undefined): Notice | undefined {
  const message = query?.notice;
  if (message === undefined || message.trim().length === 0) {
    return undefined;
  }
  return { message, tone: query?.tone === "error" ? "error" : "success" };
}

function pageChrome(principal: Principal, request: HttpRequest): PageChrome {
  return { operatorName: principal.name, notice: noticeFrom(request.query) };
}

function withNotice(location: string, message: string, tone: "success" | "error"): string {
  const hashIndex = location.indexOf("#");
  const hash = hashIndex >= 0 ? location.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? location.slice(0, hashIndex) : location;
  const queryIndex = base.indexOf("?");
  const pathname = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const params = new URLSearchParams(queryIndex >= 0 ? base.slice(queryIndex + 1) : "");
  params.set("notice", message);
  params.set("tone", tone);
  return `${pathname}?${params.toString()}${hash}`;
}

function redirectWithNotice(
  location: string,
  message: string,
  tone: "success" | "error",
): HttpResponse {
  return redirect(withNotice(location, message, tone));
}

function browserError(request: HttpRequest, location: string, message: string): HttpResponse {
  if (wantsHtml(request)) {
    return redirectWithNotice(location, message, "error");
  }
  return json(400, { error: message });
}

function asset(request: HttpRequest): HttpResponse | undefined {
  const entry = ASSETS[request.path];
  if (entry === undefined) {
    return undefined;
  }
  try {
    const root = process.env.HANSE_ASSETS ?? path.join(process.cwd(), "assets");
    return {
      status: 200,
      contentType: entry.contentType,
      body: readFileSync(path.join(root, entry.file), "utf8"),
    };
  } catch {
    return json(404, { error: "not found" });
  }
}

function bearerToken(request: HttpRequest): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization?.trim() ?? "");
  return match?.[1]?.trim();
}

function agentTokenFor(request: HttpRequest) {
  const token = bearerToken(request);
  return token === undefined || token.length === 0 ? undefined : token;
}

function pendingApprovalId(db: SqliteDatabase, handoffId: string): string | undefined {
  const row = db
    .prepare("SELECT id FROM approvals WHERE handoff_id = ? AND state = 'pending'")
    .get(handoffId) as { id: string } | undefined;
  return row?.id;
}

function projectViews(deps: HttpDeps): ReturnType<typeof buildSite>["projects"] {
  return buildSite(deps).projects;
}

function decisionFor(
  method: string,
  pathname: string,
): { handoffId: string; decision: "approved" | "rejected" } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const explicit = /^\/api\/handoffs\/([^/]+)\/decision$/.exec(pathname);
  if (explicit !== null && explicit[1] !== undefined) {
    return { handoffId: safeDecode(explicit[1]), decision: "approved" };
  }
  const legacy = /^\/api\/handoffs\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (legacy === null || legacy[1] === undefined || legacy[2] === undefined) {
    return undefined;
  }
  return {
    handoffId: safeDecode(legacy[1]),
    decision: legacy[2] === "approve" ? "approved" : "rejected",
  };
}

function routeDecision(deps: HttpDeps, request: HttpRequest): HttpResponse {
  const parsed = decisionFor(request.method, request.path);
  if (parsed === undefined) {
    return json(404, { error: "not found" });
  }
  const fields = parseForm(request.body);
  const browser = wantsHtml(request);
  const principal = principalFrom(deps, request);
  const returnTo = safeLocalPath(fields.return_to, browser ? "/handoffs" : "/");

  if (principal === undefined) {
    return browser ? loginRedirectTo(returnTo) : json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    if (browser) {
      return redirectWithNotice(returnTo, "Only a human operator can decide an approval.", "error");
    }
    return json(403, { error: "only a human principal may decide an approval" });
  }

  const explicitDecision = fields.decision;
  if (request.path.endsWith("/decision")) {
    if (explicitDecision !== "approved" && explicitDecision !== "rejected") {
      return browserError(request, returnTo, "Decision must be approved or rejected.");
    }
  }
  const decision: "approved" | "rejected" = request.path.endsWith("/decision")
    ? explicitDecision === "rejected"
      ? "rejected"
      : "approved"
    : parsed.decision;
  const reason = fields.reason?.trim();

  const approvalId = pendingApprovalId(deps.db, parsed.handoffId);
  if (approvalId === undefined) {
    const message = "No pending approval for this handoff.";
    return browser ? redirectWithNotice(returnTo, message, "error") : json(409, { error: message });
  }
  try {
    decideApproval(deps.db, approvalId, principal, decision, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return browser ? redirectWithNotice(returnTo, message, "error") : json(409, { error: message });
  }
  const message = decision === "approved" ? "Handoff approved." : "Handoff rejected.";
  return browser ? redirectWithNotice(returnTo, message, "success") : redirect(returnTo);
}

function routeMutation(
  deps: HttpDeps,
  request: HttpRequest,
  action: (fields: Record<string, string>) => HttpResponse,
): HttpResponse {
  const fields = parseForm(request.body);
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    if (!wantsHtml(request)) {
      return json(401, { error: "sign in required" });
    }
    const fallback = request.path === "/api/projects" ? "/projects" : "/";
    return loginRedirectTo(safeLocalPath(fields.return_to, fallback));
  }
  return action(fields);
}

function routeRuntimeStatus(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  const match = /^\/api\/apps\/([^/]+)\/runtime$/.exec(request.path);
  if (match === null || request.method !== "GET") {
    return undefined;
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may read runtime status" });
  }
  const appKey = safeDecode(match[1] ?? "");
  const projectId = request.query?.project;
  if (projectId === undefined || projectId.length === 0) {
    return json(400, { error: "project query is required" });
  }
  const project = deps.getProjects().find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return json(404, { error: "project not found" });
  }
  const app = deps.db
    .prepare("SELECT id FROM apps WHERE project_id = ? AND app_key = ?")
    .get(project.id, appKey) as { id: string } | undefined;
  if (app === undefined) {
    return json(404, { error: "application not found" });
  }
  const row = deps.db
    .prepare(
      `SELECT endpoint, state, runtime_state AS runtimeState, spec_hash AS specHash,
              container_id AS containerId, container_name AS containerName,
              image_ref AS imageRef, started_at AS startedAt, updated_at AS updatedAt
       FROM instances WHERE app_id = ?`,
    )
    .get(app.id) as
    | {
        endpoint: string | null;
        state: string;
        runtimeState: string | null;
        specHash: string | null;
        containerId: string | null;
        containerName: string | null;
        imageRef: string | null;
        startedAt: string | null;
        updatedAt: string | null;
      }
    | undefined;
  const storedState = row?.runtimeState ?? row?.state ?? "stopped";
  return json(200, {
    appId: app.id,
    state: storedState === "failed" ? "error" : storedState,
    endpoint: row?.endpoint ?? null,
    specHash: row?.specHash ?? null,
    containerId: row?.containerId ?? null,
    containerName: row?.containerName ?? null,
    imageRef: row?.imageRef ?? null,
    startedAt: row?.startedAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  });
}

function route(deps: HttpDeps, request: HttpRequest): HttpResponse {
  const assetResponse = asset(request);
  if (assetResponse !== undefined) {
    return assetResponse;
  }
  if (request.path.startsWith("/assets/")) {
    return json(404, { error: "not found" });
  }

  const presentedAgentToken = agentTokenFor(request);
  if (
    presentedAgentToken !== undefined &&
    verifyAgentToken(deps.db, presentedAgentToken) !== undefined
  ) {
    return json(403, { error: "agent tokens may only call the MCP endpoint" });
  }

  if (request.method === "GET" && request.path === "/healthz") {
    return json(200, { status: "ok" });
  }

  if (request.method === "GET" && request.path === "/login") {
    const human = humanFrom(deps, request);
    if (human !== undefined) {
      return redirect(loginDestination(request.query?.next));
    }
    return html(200, loginPage({ next: loginDestination(request.query?.next) }));
  }

  if (request.method === "POST" && request.path === "/login") {
    const fields = parseForm(request.body);
    const next = loginDestination(fields.next);
    const token = (fields.token ?? "").trim();
    if (token.length === 0) {
      return html(401, loginPage({ next, error: "missing token" }));
    }
    try {
      const principal = authenticate(deps.db, `Bearer ${token}`);
      if (principal.kind !== "human") {
        return html(401, loginPage({ next, error: "not a human principal" }));
      }
      return redirect(next, {
        "set-cookie": `hanse_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
      });
    } catch {
      return html(401, loginPage({ next, error: "invalid token" }));
    }
  }

  if (request.method === "POST" && request.path === "/logout") {
    return redirect("/login", {
      "set-cookie": "hanse_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
  }

  if (request.method === "GET" && request.path === "/api/projects") {
    return json(200, { projects: projectViews(deps) });
  }
  if (request.method === "GET" && request.path === "/api/handoffs") {
    const site = buildSite(deps);
    return json(200, { handoffs: site.projects.flatMap((project) => project.handoffs) });
  }

  if (request.method === "POST" && decisionFor(request.method, request.path) !== undefined) {
    return routeDecision(deps, request);
  }

  if (request.method === "POST" && request.path === "/api/handoffs") {
    return routeMutation(deps, request, (fields) => {
      const browser = wantsHtml(request);
      const returnTo = safeLocalPath(fields.return_to, "/");
      const candidates = deps.getProjects();
      const requested = fields.project;
      const project =
        requested === undefined || requested.length === 0
          ? candidates[0]
          : candidates.find((candidate) => candidate.id === requested);
      if (project === undefined) {
        return browserError(request, "/projects", "Project not found.");
      }
      const summary = fields.summary?.trim() ?? "";
      if (browser && summary.length === 0) {
        return redirectWithNotice(returnTo, "Summary is required.", "error");
      }
      try {
        project.service.requestSiblingChange({
          fromAppKey: fields.from ?? "",
          toAppKey: fields.to ?? "",
          summary: summary.length === 0 ? "(no summary)" : summary,
          spec: fields.spec ?? "",
          requiresApproval: fields.requires_approval === "1",
        });
      } catch (error) {
        return browserError(
          request,
          returnTo,
          error instanceof Error ? error.message : String(error),
        );
      }
      return browser ? redirectWithNotice(returnTo, "Handoff created.", "success") : redirect("/");
    });
  }

  const runtimeStatus = routeRuntimeStatus(deps, request);
  if (runtimeStatus !== undefined) {
    return runtimeStatus;
  }

  if (request.method === "POST" && request.path === "/api/projects") {
    return routeMutation(deps, request, (fields) => {
      const browser = wantsHtml(request);
      const name = (fields.name ?? "").trim();
      if (name.length === 0) {
        return browserError(request, "/projects", "Project name is required.");
      }
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "") || `project-${Date.now()}`;
      const dir = path.join(deps.workspaceRoot, slug);
      const configPath = path.join(dir, ".hanse", "project.yaml");
      if (existsSync(configPath)) {
        return browserError(request, "/projects", "Project already exists.");
      }
      const id = randomUUID();
      mkdirSync(path.dirname(configPath), { recursive: true });
      writeFileSync(configPath, `id: ${id}\nname: ${name}\nbase_branch: main\napps: []\n`, "utf8");
      const now = new Date().toISOString();
      deps.db
        .prepare(
          "INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at) VALUES (?, ?, 'main', ?, ?, ?)",
        )
        .run(id, name, dir, now, now);
      return browser
        ? redirectWithNotice(`/projects/${id}`, "Project created.", "success")
        : redirect("/");
    });
  }

  const addAppMatch = /^\/api\/projects\/([^/]+)\/apps$/.exec(request.path);
  if (request.method === "POST" && addAppMatch !== null) {
    return routeMutation(deps, request, (fields) => {
      const browser = wantsHtml(request);
      const projectId = safeDecode(addAppMatch[1] ?? "");
      const returnTo = safeLocalPath(fields.return_to, `/projects/${projectId}`);
      const project = deps.getProjects().find((candidate) => candidate.id === projectId);
      if (project === undefined) {
        return browserError(request, "/projects", "Project not found.");
      }
      const name = (fields.name ?? "").trim();
      if (name.length === 0) {
        return browserError(request, returnTo, "Application name is required.");
      }
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "") || `app-${Date.now()}`;
      const appPath = (fields.path ?? "").trim() || `apps/${slug}`;
      let dir: string;
      try {
        dir = resolveAppPath({
          appPath,
          projectRoot: project.rootPath,
          workspaceRoot: project.workspaceRoot,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return browser
          ? redirectWithNotice(returnTo, message, "error")
          : json(400, {
              error: message,
              ...(error instanceof ConfigError ? { code: error.code } : {}),
            });
      }
      const remote = (fields.remote ?? "").trim();
      try {
        if (remote.length > 0) {
          mkdirSync(path.dirname(dir), { recursive: true });
          execFileSync("git", ["clone", "--depth", "1", remote, dir], { stdio: "ignore" });
        } else {
          mkdirSync(dir, { recursive: true });
        }
        mkdirSync(path.join(dir, ".hanse"), { recursive: true });
        const appYaml = path.join(dir, ".hanse", "app.yaml");
        if (!existsSync(appYaml)) {
          writeFileSync(appYaml, `name: ${name}\nkind: app\ncontract: AGENTS.md\n`, "utf8");
        }
      } catch (error) {
        const message = `failed to add application: ${error instanceof Error ? error.message : String(error)}`;
        return browser
          ? redirectWithNotice(returnTo, message, "error")
          : json(502, { error: message });
      }
      try {
        const manifestPath = path.join(project.rootPath, ".hanse", "project.yaml");
        const manifest = parseYaml(readFileSync(manifestPath, "utf8")) as {
          apps?: Array<Record<string, unknown>>;
        } & Record<string, unknown>;
        manifest.apps = Array.isArray(manifest.apps) ? manifest.apps : [];
        if (!manifest.apps.some((entry) => entry?.path === appPath)) {
          manifest.apps.push({ path: appPath, ...(remote.length > 0 ? { remote } : {}) });
        }
        writeFileSync(manifestPath, stringifyYaml(manifest), "utf8");
      } catch (error) {
        const message = `failed to update manifest: ${error instanceof Error ? error.message : String(error)}`;
        return browser
          ? redirectWithNotice(returnTo, message, "error")
          : json(500, { error: message });
      }
      const appKey = path.basename(appPath);
      deps.db
        .prepare(
          "INSERT INTO apps (id, project_id, app_key, path, kind, contract, created_at) VALUES (?, ?, ?, ?, 'app', 'AGENTS.md', ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, kind = excluded.kind",
        )
        .run(`${project.id}:${appKey}`, project.id, appKey, appPath, new Date().toISOString());
      return browser
        ? redirectWithNotice(returnTo, "Application added.", "success")
        : redirect("/");
    });
  }

  if (isApiPath(request.path)) {
    return json(404, { error: "not found" });
  }

  if (request.method === "GET") {
    const human = humanFrom(deps, request);
    if (human === undefined) {
      return loginRedirect(request);
    }
    const chrome = pageChrome(human, request);
    try {
      if (request.path === "/") {
        return html(200, renderOverview(buildSite(deps), chrome));
      }
      if (request.path === "/projects") {
        return html(200, renderProjects(buildSite(deps), { q: request.query?.q, chrome }));
      }
      if (request.path === "/handoffs") {
        return html(
          200,
          renderHandoffs(buildSite(deps), {
            filter: request.query?.filter,
            q: request.query?.q,
            chrome,
          }),
        );
      }
      if (request.path === "/terminal") {
        const site = buildSite(deps);
        const page = renderTerminalPage(
          site,
          request.query?.project ?? "",
          request.query?.app ?? "",
          chrome,
        );
        if (page !== undefined) {
          return html(200, page);
        }
        return html(404, renderNotFound(site, chrome));
      }
      const applicationMatch = /^\/projects\/([^/]+)\/apps\/([^/]+)$/.exec(request.path);
      if (applicationMatch !== null) {
        const site = buildSite(deps);
        const page = renderApplication(
          site,
          safeDecode(applicationMatch[1] ?? ""),
          safeDecode(applicationMatch[2] ?? ""),
          chrome,
        );
        if (page !== undefined) {
          return html(200, page);
        }
        return html(404, renderNotFound(site, chrome));
      }
      const projectMatch = /^\/projects\/([^/]+)$/.exec(request.path);
      if (projectMatch !== null) {
        const site = buildSite(deps);
        const page = renderProject(site, safeDecode(projectMatch[1] ?? ""), chrome);
        if (page !== undefined) {
          return html(200, page);
        }
        return html(404, renderNotFound(site, chrome));
      }
      return html(404, renderNotFound(buildSite(deps), chrome));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return html(500, renderErrorPage(buildSite(deps), chrome, message));
    }
  }

  return json(404, { error: "not found" });
}

export function handleRequest(deps: HttpDeps, request: HttpRequest): HttpResponse {
  return route(deps, request);
}
