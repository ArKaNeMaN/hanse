import type { SkillSourceService } from "../skill-sources/service.js";
import { SkillSourceError } from "../skill-sources/types.js";
import { SkillValidationError } from "../skills/validation.js";
import { principalFrom } from "./auth.js";
import { crossSiteMutation } from "./chat.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const PREVIEW_TEXT_CAP = 64 * 1024;

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

function requireToken(body: Record<string, unknown>): string {
  const token = stringField(body, "token");
  if (token === undefined || token.trim().length === 0) {
    throw new SkillValidationError("token must be a non-empty string", "token");
  }
  return token;
}

function requiredQuery(query: Record<string, string>, key: string): string {
  const value = query[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillValidationError(`${key} is required`, key);
  }
  return value;
}

function decodeSourceFile(
  bytes: Uint8Array,
): { encoding: "text"; text: string; truncated: boolean } | { encoding: "binary" } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { encoding: "binary" };
  }
  let controls = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) {
      return { encoding: "binary" };
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      controls += 1;
    }
  }
  if (controls > Math.max(8, Math.floor(text.length * 0.05))) {
    return { encoding: "binary" };
  }
  let truncated = false;
  if (Buffer.byteLength(text, "utf8") > PREVIEW_TEXT_CAP) {
    let output = "";
    let size = 0;
    for (const char of text) {
      const width = Buffer.byteLength(char, "utf8");
      if (size + width > PREVIEW_TEXT_CAP) {
        truncated = true;
        break;
      }
      output += char;
      size += width;
    }
    text = output;
  }
  return { encoding: "text", text, truncated };
}

function previewResponse(
  sources: SkillSourceService,
  request: HttpRequest,
  id: string,
): HttpResponse {
  const query = request.query ?? {};
  const snapshotId = requiredQuery(query, "snapshotId");
  const bucket = requiredQuery(query, "bucket");
  const name = requiredQuery(query, "name");
  const filePath = requiredQuery(query, "path");
  const source = sources.get(id);
  if (source === undefined) {
    return json(404, { error: "skill source not found", code: "source_not_found" });
  }
  if (source.activeSnapshotId === null || snapshotId !== source.activeSnapshotId) {
    return json(404, { error: "snapshot is not the active snapshot", code: "snapshot_mismatch" });
  }
  const skill = sources.skills(id).find((entry) => entry.bucket === bucket && entry.name === name);
  if (skill === undefined) {
    return json(404, { error: "skill not found in the active snapshot", code: "skill_not_found" });
  }
  const file = skill.files.find((entry) => entry.path === filePath);
  if (file === undefined) {
    return json(404, { error: "file not found in the skill", code: "file_not_found" });
  }
  let content: Uint8Array;
  try {
    const [read] = sources.readFiles([file]);
    content = read?.content ?? new Uint8Array();
  } catch (error) {
    if (
      error instanceof SkillSourceError &&
      (error.code === "blob_missing" || error.code === "blob_corrupt")
    ) {
      return json(404, { error: error.message, code: error.code });
    }
    throw error;
  }
  const decoded = decodeSourceFile(content);
  return json(200, {
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    encoding: decoded.encoding,
    ...(decoded.encoding === "text"
      ? { text: decoded.text, ...(decoded.truncated ? { truncated: true } : {}) }
      : {}),
  });
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
    (method === "GET" && /^\/api\/skill-sources\/[^/]+\/(?:skills|files)$/.test(pathname))
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
            : error.code === "slug_taken"
              ? 409
              : error.code === "unauthorized"
                ? 502
                : error.code === "blob_missing" || error.code === "blob_corrupt"
                  ? 404
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
          sources.setSecret(id, requireToken(body), actor);
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
      if (request.method === "GET" && action === "files") {
        return previewResponse(sources, request, id);
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
          sources.setSecret(id, requireToken(body), actor);
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
