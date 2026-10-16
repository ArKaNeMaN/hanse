import { decideApproval } from "../coordinator/approval.js";
import { getHandoff, listHandoffs } from "../coordinator/handoff.js";
import type { CoordinatorService } from "../coordinator/service.js";
import { AuthError, authenticate, requireKind } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { SqliteDatabase } from "../store/index.js";

export interface HttpDeps {
  db: SqliteDatabase;
  projectId: string;
  service: CoordinatorService;
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
}

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function html(body: string): HttpResponse {
  return { status: 200, contentType: "text/html; charset=utf-8", body };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDashboard(deps: HttpDeps): string {
  const apps = deps.service.listApps();
  const handoffs = listHandoffs(deps.db, deps.projectId);
  const appItems = apps
    .map((app) => `<li>${escapeHtml(app.appKey)} <span>${escapeHtml(app.path)}</span></li>`)
    .join("");
  const handoffItems = handoffs
    .map(
      (h) => `<li>${escapeHtml(h.id)} <b>${escapeHtml(h.state)}</b> ${escapeHtml(h.summary)}</li>`,
    )
    .join("");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    "<title>hanse</title></head><body>",
    "<h1>hanse</h1>",
    "<h2>Applications</h2>",
    `<ul>${appItems || "<li>(none)</li>"}</ul>`,
    "<h2>Handoffs</h2>",
    `<ul>${handoffItems || "<li>(none)</li>"}</ul>`,
    "</body></html>",
  ].join("");
}

interface Decision {
  handoffId: string;
  decision: "approved" | "rejected";
}

function matchDecision(method: string, path: string): Decision | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/api\/handoffs\/([^/]+)\/(approve|reject)$/.exec(path);
  if (match === null) {
    return undefined;
  }
  const [, handoffId, action] = match;
  if (handoffId === undefined || action === undefined) {
    return undefined;
  }
  return { handoffId, decision: action === "approve" ? "approved" : "rejected" };
}

function pendingApprovalId(db: SqliteDatabase, handoffId: string): string | undefined {
  const row = db
    .prepare("SELECT id FROM approvals WHERE handoff_id = ? AND state = 'pending'")
    .get(handoffId) as { id: string } | undefined;
  return row?.id;
}

function decide(
  deps: HttpDeps,
  headers: Record<string, string | undefined>,
  input: Decision,
): HttpResponse {
  let principal: Principal;
  try {
    principal = authenticate(deps.db, headers.authorization);
  } catch (error) {
    const message = error instanceof AuthError ? error.message : "unauthorized";
    return json(401, { error: message });
  }
  try {
    requireKind(principal, ["human"]);
  } catch (error) {
    const message = error instanceof AuthError ? error.message : "forbidden";
    return json(403, { error: message });
  }
  if (getHandoff(deps.db, input.handoffId) === undefined) {
    return json(404, { error: "handoff not found" });
  }
  const approvalId = pendingApprovalId(deps.db, input.handoffId);
  if (approvalId === undefined) {
    return json(409, { error: "no pending approval" });
  }
  const approval = decideApproval(deps.db, approvalId, principal, input.decision);
  return json(200, { approval });
}

export function handleRequest(deps: HttpDeps, request: HttpRequest): HttpResponse {
  const decision = matchDecision(request.method, request.path);
  if (decision !== undefined) {
    return decide(deps, request.headers, decision);
  }
  if (request.method === "GET" && request.path === "/") {
    return html(renderDashboard(deps));
  }
  if (request.method === "GET" && request.path === "/api/apps") {
    return json(200, { apps: deps.service.listApps() });
  }
  if (request.method === "GET" && request.path === "/api/handoffs") {
    return json(200, { handoffs: listHandoffs(deps.db, deps.projectId) });
  }
  return json(404, { error: "not found" });
}
