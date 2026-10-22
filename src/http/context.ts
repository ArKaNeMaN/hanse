import { OpencodeHttpError } from "../opencode/client.js";
import {
  AgentNotRunningError,
  CompactInProgressError,
  ModelUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
} from "../opencode/context.js";
import { DeletionPendingError } from "../opencode/manager.js";
import { findApp, toManagedApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import { lifecycleErrorResponse } from "./errors.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const CONTEXT_PATH = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/context$/;
const COMPACT_PATH = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/compact$/;

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

function projectParam(request: HttpRequest): string | undefined {
  const project = request.query?.project?.trim();
  return project === undefined || project.length === 0 ? undefined : project;
}

function deletionPending(): HttpResponse {
  return json(409, { error: "application is pending deletion", code: "deletion_pending" });
}

function agentNotRunning(): HttpResponse {
  return json(503, { error: "agent is not running", code: "agent_not_running" });
}

function sessionNotFound(): HttpResponse {
  return json(404, { error: "session not found", code: "session_not_found" });
}

function isMissingSession(error: unknown): boolean {
  return (
    error instanceof SessionNotFoundError ||
    (error instanceof OpencodeHttpError && error.status === 404)
  );
}

/** Route matcher for the human-only context endpoints. */
export function isContextRoute(_method: string, path: string): boolean {
  return CONTEXT_PATH.test(path) || COMPACT_PATH.test(path);
}

export async function handleContext(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const contextMatch = CONTEXT_PATH.exec(request.path);
  const compactMatch = COMPACT_PATH.exec(request.path);
  if (contextMatch === null && compactMatch === null) {
    return json(404, { error: "not found" });
  }
  const read = contextMatch !== null;

  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, {
      error: read
        ? "only a human principal may read context"
        : "only a human principal may compact a session",
      code: "human_only",
    });
  }
  if ((read && request.method !== "GET") || (!read && request.method !== "POST")) {
    return json(405, { error: "method not allowed" });
  }
  if (deps.manager === undefined) {
    return json(503, { error: "agent runtime is not configured" });
  }

  const match = contextMatch ?? compactMatch;
  const appKey = safeDecode(match?.[1] ?? "");
  const sessionId = safeDecode(match?.[2] ?? "");
  const found = findApp(deps, projectParam(request), appKey);
  if (found === undefined) {
    return json(404, { error: `unknown application: ${appKey}`, code: "unknown_app" });
  }

  if (read) {
    try {
      return json(200, await deps.manager.contextSnapshot(found.app.id, sessionId));
    } catch (error) {
      if (error instanceof AgentNotRunningError) {
        return agentNotRunning();
      }
      if (error instanceof DeletionPendingError) {
        return deletionPending();
      }
      if (isMissingSession(error)) {
        return sessionNotFound();
      }
      return json(502, { error: "context is unavailable", code: "context_unavailable" });
    }
  }

  try {
    await deps.manager.ensure(toManagedApp(found));
  } catch (error) {
    if (error instanceof DeletionPendingError) {
      return deletionPending();
    }
    const mapped = lifecycleErrorResponse(error);
    if (mapped !== undefined) {
      return mapped;
    }
    return json(502, { error: "agent unavailable", code: "agent_unavailable" });
  }

  try {
    await deps.manager.compactSession(found.app.id, sessionId);
  } catch (error) {
    if (error instanceof SessionBusyError) {
      return json(409, { error: "session is busy", code: "session_busy" });
    }
    if (error instanceof CompactInProgressError) {
      return json(409, {
        error: "a compaction is already in progress",
        code: "compact_in_progress",
      });
    }
    if (error instanceof ModelUnavailableError) {
      return json(409, {
        error: "no model is available for compaction",
        code: "model_unavailable",
      });
    }
    if (isMissingSession(error)) {
      return sessionNotFound();
    }
    if (error instanceof AgentNotRunningError) {
      return agentNotRunning();
    }
    return json(502, { error: "compaction is unavailable", code: "compaction_unavailable" });
  }

  return json(202, { accepted: true, sessionID: sessionId });
}
