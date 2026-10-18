import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { decideApproval } from "../coordinator/approval.js";
import { listHandoffs } from "../coordinator/handoff.js";
import type { CoordinatorService } from "../coordinator/service.js";
import { authenticate } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { InstanceManager } from "../opencode/manager.js";
import type { SqliteDatabase } from "../store/index.js";
import { type ProjectView, renderDashboard, renderLogin } from "./dashboard.js";

export interface ProjectContext {
  id: string;
  name: string;
  rootPath: string;
  service: CoordinatorService;
}

export interface HttpDeps {
  db: SqliteDatabase;
  workspaceRoot: string;
  getProjects: () => ProjectContext[];
  manager?: InstanceManager;
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
    const key = decodeURIComponent(pair.slice(0, index).replace(/\+/g, " "));
    fields[key] = decodeURIComponent(pair.slice(index + 1).replace(/\+/g, " "));
  }
  return fields;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === name && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function tokenFromRequest(request: HttpRequest): string | undefined {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (bearer !== undefined && bearer.length > 0) {
    return bearer;
  }
  return cookieValue(request.headers.cookie, "hanse_token");
}

function principalFrom(deps: HttpDeps, request: HttpRequest): Principal | undefined {
  const token = tokenFromRequest(request);
  if (token === undefined) {
    return undefined;
  }
  try {
    return authenticate(deps.db, `Bearer ${token}`);
  } catch {
    return undefined;
  }
}

function pendingApprovalId(db: SqliteDatabase, handoffId: string): string | undefined {
  const row = db
    .prepare("SELECT id FROM approvals WHERE handoff_id = ? AND state = 'pending'")
    .get(handoffId) as { id: string } | undefined;
  return row?.id;
}

function projectViews(deps: HttpDeps): ProjectView[] {
  return deps.getProjects().map((project) => ({
    id: project.id,
    name: project.name,
    apps: project.service.listApps(),
    handoffs: listHandoffs(deps.db, project.id),
  }));
}

function decisionFor(
  method: string,
  path: string,
): { handoffId: string; decision: "approved" | "rejected" } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/api\/handoffs\/([^/]+)\/(approve|reject)$/.exec(path);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return { handoffId: match[1], decision: match[2] === "approve" ? "approved" : "rejected" };
}

export function handleRequest(deps: HttpDeps, request: HttpRequest): HttpResponse {
  const principal = principalFrom(deps, request);

  if (request.method === "GET" && request.path === "/") {
    return html(200, renderDashboard(projectViews(deps), principal !== undefined));
  }
  if (request.method === "GET" && request.path === "/login") {
    return principal !== undefined ? redirect("/") : html(200, renderLogin());
  }
  if (request.method === "POST" && request.path === "/login") {
    const token = parseForm(request.body).token ?? "";
    return redirect("/", {
      "set-cookie": `hanse_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`,
    });
  }
  if (request.method === "GET" && request.path === "/api/projects") {
    return json(200, { projects: projectViews(deps) });
  }
  if (request.method === "GET" && request.path === "/api/handoffs") {
    return json(200, {
      handoffs: deps.getProjects().flatMap((project) => listHandoffs(deps.db, project.id)),
    });
  }

  if (request.method === "GET" && request.path === "/assets/app.css") {
    try {
      const assetsRoot = process.env.HANSE_ASSETS ?? path.join(process.cwd(), "assets");
      return {
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: readFileSync(path.join(assetsRoot, "app.css"), "utf8"),
      };
    } catch {
      return json(404, { error: "not found" });
    }
  }

  const decision = decisionFor(request.method, request.path);
  if (decision !== undefined) {
    if (principal === undefined) {
      return json(401, { error: "sign in required" });
    }
    if (principal.kind !== "human") {
      return json(403, { error: "only a human principal may decide an approval" });
    }
    const approvalId = pendingApprovalId(deps.db, decision.handoffId);
    if (approvalId === undefined) {
      return json(409, { error: "no pending approval" });
    }
    decideApproval(deps.db, approvalId, principal, decision.decision);
    return redirect("/");
  }

  if (request.method === "POST" && request.path === "/api/handoffs") {
    if (principal === undefined) {
      return json(401, { error: "sign in required" });
    }
    const fields = parseForm(request.body);
    const candidates = deps.getProjects();
    const project =
      candidates.find((candidate) => candidate.id === fields.project) ?? candidates[0];
    if (project === undefined) {
      return json(400, { error: "no project" });
    }
    try {
      project.service.requestSiblingChange({
        fromAppKey: fields.from ?? "",
        toAppKey: fields.to ?? "",
        summary: fields.summary ?? "(no summary)",
        spec: fields.spec ?? "",
        requiresApproval: fields.requires_approval === "1",
      });
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : String(error) });
    }
    return redirect("/");
  }

  if (request.method === "POST" && request.path === "/api/projects") {
    if (principal === undefined) {
      return json(401, { error: "sign in required" });
    }
    const name = (parseForm(request.body).name ?? "").trim();
    if (name.length === 0) {
      return json(400, { error: "project name is required" });
    }
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || `project-${Date.now()}`;
    const dir = path.join(deps.workspaceRoot, slug);
    const configPath = path.join(dir, ".hanse", "project.yaml");
    if (existsSync(configPath)) {
      return json(409, { error: "project already exists" });
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
    return redirect("/");
  }

  const addAppMatch = /^\/api\/projects\/([^/]+)\/apps$/.exec(request.path);
  if (request.method === "POST" && addAppMatch !== null) {
    if (principal === undefined) {
      return json(401, { error: "sign in required" });
    }
    const project = deps
      .getProjects()
      .find((candidate) => candidate.id === decodeURIComponent(addAppMatch[1] ?? ""));
    if (project === undefined) {
      return json(404, { error: "project not found" });
    }
    const fields = parseForm(request.body);
    const name = (fields.name ?? "").trim();
    if (name.length === 0) {
      return json(400, { error: "app name is required" });
    }
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || `app-${Date.now()}`;
    const appPath = (fields.path ?? "").trim() || `apps/${slug}`;
    const dir = path.resolve(project.rootPath, appPath);
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
      return json(502, {
        error: `failed to add application: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    try {
      const manifestPath = path.join(project.rootPath, ".hanse", "project.yaml");
      const manifest = parseYaml(readFileSync(manifestPath, "utf8")) as {
        apps?: Array<Record<string, unknown>>;
      } & Record<string, unknown>;
      manifest.apps = Array.isArray(manifest.apps) ? manifest.apps : [];
      if (!manifest.apps.some((entry) => entry?.["path"] === appPath)) {
        manifest.apps.push({ path: appPath, ...(remote.length > 0 ? { remote } : {}) });
      }
      writeFileSync(manifestPath, stringifyYaml(manifest), "utf8");
    } catch (error) {
      return json(500, {
        error: `failed to update manifest: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const appKey = path.basename(appPath);
    deps.db
      .prepare(
        "INSERT INTO apps (id, project_id, app_key, path, kind, contract, created_at) VALUES (?, ?, ?, ?, 'app', 'AGENTS.md', ?) ON CONFLICT(id) DO UPDATE SET path = excluded.path, kind = excluded.kind",
      )
      .run(`${project.id}:${appKey}`, project.id, appKey, appPath, new Date().toISOString());
    return redirect("/");
  }

  return json(404, { error: "not found" });
}
