import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openAgentMediaFile } from "../agent-media/paths.js";
import { AgentMediaService } from "../agent-media/service.js";
import { markAgentMediaMissing, readAgentMedia } from "../agent-media/store.js";
import { isInlineSafeMime } from "../attachments/mime.js";
import { encodeContentDisposition } from "../attachments/names.js";
import { appStateRoot } from "../attachments/paths.js";
import { appDir, type FoundApp, findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest } from "./handler.js";

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function projectParam(request: HttpRequest): string | undefined {
  const value = request.query?.project;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function agentMediaServiceFor(
  deps: HttpDeps,
  found: FoundApp,
): AgentMediaService | undefined {
  if (
    deps.agentsHome === undefined ||
    deps.manager === undefined ||
    typeof deps.manager.attachmentsPathMode !== "function"
  ) {
    return undefined;
  }
  return new AgentMediaService(deps.db, {
    appId: found.app.id,
    projectId: found.project.id,
    appKey: found.app.appKey,
    appDir: appDir(found.project, found.app),
    appRoot: appStateRoot(deps.agentsHome, found.project.id, found.app.appKey),
    workspaceRoot: found.project.workspaceRoot,
    pathMode: deps.manager.attachmentsPathMode() === "host" ? "runner" : "supervisor",
  });
}

export async function handleAgentMediaDownload(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const match = /^\/api\/apps\/([^/]+)\/agent-media\/([^/]+)$/.exec(url.pathname);
  if (match === null) {
    json(response, 404, { error: "not found" });
    return;
  }
  const httpRequest: HttpRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: {
      authorization: headerValue(request.headers.authorization),
      cookie: headerValue(request.headers.cookie),
    },
    host: headerValue(request.headers.host),
  };
  const principal = principalFrom(deps, httpRequest);
  if (principal === undefined) {
    json(response, 401, { error: "sign in required" });
    return;
  }
  if (principal.kind !== "human") {
    json(response, 403, { error: "only a human principal may download agent media" });
    return;
  }
  const found = findApp(deps, projectParam(httpRequest), decode(match[1] ?? ""));
  if (found === undefined || deps.agentsHome === undefined) {
    json(response, 404, { error: "image not found", code: "agent_media_not_found" });
    return;
  }
  const appRoot = appStateRoot(deps.agentsHome, found.project.id, found.app.appKey);
  const row = readAgentMedia(deps.db, found.app.id, decode(match[2] ?? ""));
  if (row === undefined || row.state !== "attached") {
    json(response, 404, { error: "image not found", code: "agent_media_not_found" });
    return;
  }
  const opened = openAgentMediaFile(appRoot, row);
  if (opened === undefined) {
    markAgentMediaMissing(deps.db, row.id, new Date().toISOString());
    json(response, 404, { error: "image not found", code: "agent_media_not_found" });
    return;
  }
  const disposition = isInlineSafeMime(row.mime) ? "inline" : "attachment";
  response.writeHead(200, {
    "content-type": row.mime,
    "content-length": String(opened.size),
    "content-disposition": encodeContentDisposition(disposition, row.originalName),
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=3600",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream("", {
    fd: opened.fd,
    start: 0,
    end: opened.size - 1,
    autoClose: true,
  });
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
  stream.pipe(response);
}
