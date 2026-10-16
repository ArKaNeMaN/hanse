import { decideApproval } from "../coordinator/approval.js";
import { listHandoffs } from "../coordinator/handoff.js";
import type { CoordinatorService } from "../coordinator/service.js";
import { authenticate } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { SqliteDatabase } from "../store/index.js";
import { type ProjectView, renderDashboard, renderLogin } from "./dashboard.js";

export interface ProjectContext {
  id: string;
  name: string;
  service: CoordinatorService;
}

export interface HttpDeps {
  db: SqliteDatabase;
  projects: ProjectContext[];
}

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
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
  return deps.projects.map((project) => ({
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
      handoffs: deps.projects.flatMap((project) => listHandoffs(deps.db, project.id)),
    });
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
    const project =
      deps.projects.find((candidate) => candidate.id === fields.project) ?? deps.projects[0];
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

  return json(404, { error: "not found" });
}
