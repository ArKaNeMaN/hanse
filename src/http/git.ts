import { GitError, type GitErrorCode } from "../git/service.js";
import { appDir, findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

type GitAction = "status" | "fetch" | "update" | "push" | "commit" | "switch";

const GIT_PATH = /^\/api\/projects\/([^/]+)\/apps\/([^/]+)\/git(?:\/(.*))?$/;

function mutationFor(subpath: string): Exclude<GitAction, "status"> | undefined {
  switch (subpath) {
    case "fetch":
      return "fetch";
    case "update":
      return "update";
    case "push":
      return "push";
    case "commit":
      return "commit";
    case "branches/switch":
      return "switch";
    default:
      return undefined;
  }
}

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  const media = header.split(";")[0]?.trim().toLowerCase();
  return media === "application/json";
}

function parseJsonBody(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined || body.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function errorStatus(code: GitErrorCode, action: GitAction): number {
  switch (code) {
    case "invalid_input":
      return 400;
    case "outside_workspace":
      return 403;
    case "not_git":
    case "not_root":
    case "missing_path":
    case "busy":
    case "git_locked":
    case "no_upstream":
    case "detached":
    case "conflicts":
    case "operation_in_progress":
    case "nothing_to_commit":
    case "branch_not_found":
    case "diverged":
    case "worktree_dirty":
    case "push_rejected":
      return 409;
    case "auth_failed":
      return 502;
    case "timeout":
    case "output_too_large":
      return 500;
    case "git_failed":
      return action === "fetch" || action === "update" || action === "push" ? 502 : 500;
  }
}

function errorResponse(error: GitError, action: GitAction): HttpResponse {
  return json(errorStatus(error.code, action), { error: error.message, code: error.code });
}

function failed(action: GitAction, error: unknown): HttpResponse {
  if (error instanceof GitError) {
    return errorResponse(error, action);
  }
  return json(500, { error: "git operation failed", code: "git_failed" });
}

function methodNotAllowed(): HttpResponse {
  return json(405, { error: "method not allowed", code: "method_not_allowed" });
}

/** Human-only JSON API for one application repository. */
export async function handleGit(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required", code: "unauthorized" });
  }
  if (principal.kind !== "human") {
    return json(403, {
      error: "only a human operator may use git actions",
      code: "forbidden",
    });
  }

  const match = GIT_PATH.exec(request.path);
  if (match === null) {
    return json(404, { error: "not found", code: "not_found" });
  }
  const projectId = safeDecode(match[1] ?? "");
  const appKey = safeDecode(match[2] ?? "");
  const subpath = (match[3] ?? "").replace(/\/+$/, "");

  const found = findApp(deps, projectId, appKey);
  if (found === undefined) {
    return json(404, { error: "not found", code: "not_found" });
  }
  const folder = appDir(found.project, found.app);

  if (subpath === "status") {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }
    try {
      const status = await deps.git.statusFor(found.project.rootPath, folder);
      return json(200, { status });
    } catch (error) {
      return failed("status", error);
    }
  }

  const action = mutationFor(subpath);
  if (action === undefined) {
    return json(404, { error: "not found", code: "not_found" });
  }
  if (request.method !== "POST") {
    return methodNotAllowed();
  }
  if (!isJsonContentType(request.headers["content-type"])) {
    return json(400, {
      error: "content-type must be application/json",
      code: "invalid_input",
    });
  }
  const body = parseJsonBody(request.body);
  if (body === undefined) {
    return json(400, { error: "invalid JSON body", code: "invalid_input" });
  }

  try {
    const resolved = await deps.git.resolveRepository(found.project.rootPath, folder);
    if (action === "fetch") {
      return json(200, await deps.git.fetch(resolved));
    }
    if (action === "update") {
      return json(200, await deps.git.update(resolved));
    }
    if (action === "push") {
      return json(200, await deps.git.push(resolved));
    }
    if (action === "commit") {
      if (typeof body.message !== "string") {
        return json(400, { error: "message is required", code: "invalid_input" });
      }
      return json(200, await deps.git.commitAll(resolved, body.message));
    }
    if (typeof body.branch !== "string") {
      return json(400, { error: "branch is required", code: "invalid_input" });
    }
    return json(200, await deps.git.switchBranch(resolved, body.branch));
  } catch (error) {
    return failed(action, error);
  }
}
