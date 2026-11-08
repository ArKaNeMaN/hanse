import { SkillSourceError } from "../skill-sources/types.js";
import { SkillValidationError } from "../skills/validation.js";
import { principalFrom } from "./auth.js";
import { crossSiteMutation } from "./chat.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { "cache-control": "no-store" },
  };
}

function bodyObject(request: HttpRequest): Record<string, unknown> {
  if (request.body === undefined || request.body.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    throw new SkillValidationError("request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillValidationError("request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

export function isSkillSourcesRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/skill-sources") {
    return method === "GET" || method === "POST";
  }
  return (
    (method !== "GET" &&
      /^\/api\/skill-sources\/[^/]+\/(?:sync|check|pin|unpin|delete|secret|secret\/clear)$/.test(
        pathname,
      )) ||
    (method === "GET" && /^\/api\/skill-sources\/[^/]+\/skills$/.test(pathname))
  );
}

function authorize(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may manage skill sources" });
  }
  return undefined;
}

function sourceError(error: unknown): HttpResponse {
  if (error instanceof SkillValidationError) {
    return json(400, { error: error.message, code: "VALIDATION", field: error.field });
  }
  if (error instanceof SkillSourceError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "disabled"
          ? 409
          : error.code === "deletion_guard"
            ? 409
            : error.code === "unauthorized"
              ? 502
              : error.code.startsWith("invalid") || error.code.startsWith("missing")
                ? 400
                : 502;
    return json(status, { error: error.message, code: error.code });
  }
  return json(500, { error: error instanceof Error ? error.message : String(error) });
}

export async function handleSkillSources(
  deps: HttpDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const sources = deps.skillSources;
  if (sources === undefined) {
    return json(503, { error: "skill sources are not configured" });
  }
  const denied = authorize(deps, request);
  if (denied !== undefined) {
    return denied;
  }
  if (request.method !== "GET" && crossSiteMutation(request)) {
    return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  const actor = principal.name;

  try {
    if (request.path === "/api/skill-sources" && request.method === "GET") {
      return json(200, { sources: sources.list() });
    }
    if (request.path === "/api/skill-sources" && request.method === "POST") {
      const body = bodyObject(request);
      const action = stringField(body, "action") ?? "create";
      const id = stringField(body, "id");
      switch (action) {
        case "create":
          return json(201, { source: sources.create(body, actor) });
        case "update": {
          if (id === undefined) throw new SkillValidationError("id is required");
          return json(200, { source: sources.update(id, body, actor) });
        }
        case "delete": {
          if (id === undefined) throw new SkillValidationError("id is required");
          sources.remove(id, { hard: body.hard === true }, actor);
          return json(200, { ok: true });
        }
        case "enable": {
          if (id === undefined) throw new SkillValidationError("id is required");
          return json(200, { source: sources.enable(id, actor) });
        }
        case "disable": {
          if (id === undefined) throw new SkillValidationError("id is required");
          sources.remove(id, { hard: false }, actor);
          return json(200, { source: sources.get(id) });
        }
        case "secret": {
          if (id === undefined) throw new SkillValidationError("id is required");
          sources.setSecret(id, stringField(body, "token") ?? null, actor);
          return json(200, { source: sources.get(id) });
        }
        case "clear-secret": {
          if (id === undefined) throw new SkillValidationError("id is required");
          sources.clearSecret(id, actor);
          return json(200, { source: sources.get(id) });
        }
        case "sync": {
          if (id === undefined) throw new SkillValidationError("id is required");
          return json(200, { result: await sources.sync(id, { force: body.force === true }) });
        }
        case "check": {
          if (id === undefined) throw new SkillValidationError("id is required");
          return json(200, { result: await sources.check(id) });
        }
        case "pin": {
          if (id === undefined) throw new SkillValidationError("id is required");
          return json(200, { source: sources.pin(id, actor) });
        }
        case "unpin": {
          if (id === undefined) throw new SkillValidationError("id is required");
          return json(200, { source: sources.unpin(id, actor) });
        }
        default:
          throw new SkillValidationError(`unknown action ${action}`);
      }
    }

    const match = /^\/api\/skill-sources\/([^/]+)\/([^/]+)$/.exec(request.path);
    if (match !== null) {
      const id = decodeURIComponent(match[1] ?? "");
      const action = match[2] ?? "";
      if (request.method === "GET" && action === "skills") {
        return json(200, { source: sources.get(id), skills: sources.skills(id) });
      }
      if (request.method !== "POST") {
        return json(405, { error: "method not allowed" });
      }
      const body = bodyObject(request);
      switch (action) {
        case "sync":
          return json(200, { result: await sources.sync(id, { force: body.force === true }) });
        case "check":
          return json(200, { result: await sources.check(id) });
        case "pin":
          return json(200, { source: sources.pin(id, actor) });
        case "unpin":
          return json(200, { source: sources.unpin(id, actor) });
        case "delete":
          sources.remove(id, { hard: body.hard === true }, actor);
          return json(200, { ok: true });
        case "secret":
          sources.setSecret(id, stringField(body, "token") ?? null, actor);
          return json(200, { source: sources.get(id) });
        default:
          return json(404, { error: "not found" });
      }
    }
    const clearMatch = /^\/api\/skill-sources\/([^/]+)\/secret\/clear$/.exec(request.path);
    if (clearMatch !== null && request.method === "POST") {
      const id = decodeURIComponent(clearMatch[1] ?? "");
      sources.clearSecret(id, actor);
      return json(200, { source: sources.get(id) });
    }
    return json(404, { error: "not found" });
  } catch (error) {
    return sourceError(error);
  }
}
