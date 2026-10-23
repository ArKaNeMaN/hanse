import http, {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { findApp } from "./apps.js";
import { isHumanCookie } from "./auth.js";
import { handleChat, streamSessionEvents } from "./chat.js";
import { handleCommands, isCommandsRoute } from "./commands.js";
import { handleContext, isContextRoute } from "./context.js";
import { handleDeletion, isDeletionRoute } from "./deletion.js";
import { handleGit } from "./git.js";
import { type HttpDeps, handleRequest } from "./handler.js";
import { handleHandoffHttp } from "./handoff.js";
import { handleImages } from "./images.js";
import { handleInternalMcp } from "./internal-mcp.js";
import {
  previewNotFoundPage,
  proxyPreviewHttp,
  proxyPreviewUpgrade,
  rejectUpgrade,
} from "./preview-proxy.js";
import { handlePreviews, isPreviewsRoute } from "./previews.js";
import { handlePrompts, streamAppEvents } from "./prompts.js";
import { handleSettings, isSettingsRoute } from "./settings.js";
import { handleSkills, isSkillsRoute } from "./skills.js";
import { handleSsh, isSshRoute } from "./ssh.js";
import { proxyTerminalUpgrade } from "./terminal.js";

const IDE_PORT = Number(process.env.HANSE_IDE_PORT ?? 8080);
const IDE_HOST = process.env.HANSE_IDE_HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
// A bundle can hold a 48,000-character body plus 192,000 characters of references;
// percent-encoded multi-byte text expands several-fold, so skills routes get 4 MiB.
const MAX_SKILLS_BODY_BYTES = 4 * 1024 * 1024;
// A master write_file carries up to 256 KiB of text plus JSON escaping and the RPC envelope.
const MAX_INTERNAL_MCP_BODY_BYTES = 1024 * 1024;
const PREVIEW_PATH = /^\/preview\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/;

function decodePreviewSegment(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function writePreviewNotFound(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  response.end(previewNotFoundPage());
}

function bodyLimitFor(url: string): number {
  if (url.startsWith("/api/skills")) {
    return MAX_SKILLS_BODY_BYTES;
  }
  if (url.startsWith("/internal/mcp")) {
    return MAX_INTERNAL_MCP_BODY_BYTES;
  }
  return MAX_BODY_BYTES;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

function proxyHttp(
  request: IncomingMessage,
  response: ServerResponse,
  workspaceRoot: string,
): void {
  const parsed = new URL(request.url ?? "/", "http://localhost");
  const folder = parsed.searchParams.get("folder");
  if (folder !== null) {
    const resolved = path.resolve(folder);
    const root = path.resolve(workspaceRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      parsed.searchParams.set("folder", root);
      process.stderr.write("hanse: ide folder outside workspace rejected\n");
    }
  }
  const stripped = parsed.pathname.replace(/^\/ide/, "");
  const target = `${stripped || "/"}${parsed.search}`;
  const upstream = http.request(
    {
      host: IDE_HOST,
      port: IDE_PORT,
      method: request.method,
      path: target,
      headers: { ...request.headers },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502);
    }
    response.end();
  });
  request.pipe(upstream);
}

export function createHttpServer(deps: HttpDeps): Server {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/ide" || url.pathname.startsWith("/ide/")) {
      if (!isHumanCookie(deps, request.headers.cookie)) {
        const next = encodeURIComponent(`${url.pathname}${url.search}`);
        response.writeHead(302, { location: `/login?next=${next}` });
        response.end();
        return;
      }
      proxyHttp(request, response, deps.workspaceRoot);
      return;
    }

    if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
      const match = PREVIEW_PATH.exec(url.pathname);
      if (match === null) {
        writePreviewNotFound(response);
        return;
      }
      if (!isHumanCookie(deps, request.headers.cookie)) {
        const method = request.method ?? "GET";
        if (method === "GET" || method === "HEAD") {
          const next = encodeURIComponent(`${url.pathname}${url.search}`);
          response.writeHead(302, { location: `/login?next=${next}` });
          response.end();
          return;
        }
        response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "sign in required", code: "preview_auth_required" }));
        return;
      }
      const previews = deps.previews;
      const projectId = decodePreviewSegment(match[1]);
      const appKey = decodePreviewSegment(match[2]);
      const key = decodePreviewSegment(match[3]);
      if (
        previews === undefined ||
        projectId === undefined ||
        appKey === undefined ||
        key === undefined
      ) {
        writePreviewNotFound(response);
        return;
      }
      const found = findApp(deps, projectId, appKey);
      const preview = found === undefined ? undefined : previews.get(found.app.id, key);
      if (
        found === undefined ||
        preview === undefined ||
        preview.appId !== found.app.id ||
        preview.projectId !== found.project.id ||
        preview.appKey !== found.app.appKey
      ) {
        writePreviewNotFound(response);
        return;
      }
      if (match[4] === undefined) {
        response.writeHead(302, { location: `${url.pathname}/${url.search}` });
        response.end();
        return;
      }
      proxyPreviewHttp(deps, request, response, preview);
      return;
    }

    void readBody(request, bodyLimitFor(request.url ?? ""))
      .then(async (body) => {
        const httpRequest = {
          method: request.method ?? "GET",
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: {
            authorization: request.headers.authorization,
            cookie: request.headers.cookie,
            accept: request.headers.accept,
            "content-type": request.headers["content-type"],
            "x-hanse-fragment": Array.isArray(request.headers["x-hanse-fragment"])
              ? request.headers["x-hanse-fragment"][0]
              : request.headers["x-hanse-fragment"],
          },
          body,
          origin: request.headers.origin,
          host: request.headers.host,
        };
        const handoffResult = await handleHandoffHttp(deps, httpRequest);
        if (handoffResult !== undefined) {
          response.writeHead(handoffResult.status, {
            "content-type": handoffResult.contentType,
            ...(handoffResult.headers ?? {}),
          });
          response.end(handoffResult.body);
          return;
        }
        if (isDeletionRoute(httpRequest.method, url.pathname)) {
          const deletionResult = await handleDeletion(deps, httpRequest);
          if (deletionResult !== undefined) {
            response.writeHead(deletionResult.status, {
              "content-type": deletionResult.contentType,
              ...(deletionResult.headers ?? {}),
            });
            response.end(deletionResult.body);
            return;
          }
        }
        const isEvents = /^\/api\/apps\/[^/]+\/sessions\/[^/]+\/events$/.test(url.pathname);
        if (isEvents && (request.method ?? "GET") === "GET") {
          await streamSessionEvents(deps, httpRequest, response);
          return;
        }
        const isAppEvents = /^\/api\/apps\/[^/]+\/events$/.test(url.pathname);
        if (isAppEvents) {
          await streamAppEvents(deps, httpRequest, response);
          return;
        }
        const isImages =
          url.pathname === "/api/images/usage" ||
          url.pathname === "/api/images/gc" ||
          /^\/api\/apps\/[^/]+\/(?:build|image(?:\/(?:logs|rollback))?)$/.test(url.pathname);
        const isGit = /^\/api\/projects\/[^/]+\/apps\/[^/]+\/git(?:\/|$)/.test(url.pathname);
        const isPrompts =
          /^\/api\/apps\/[^/]+\/(?:prompts|questions\/[^/]+\/(?:reply|reject)|permissions\/(?:[^/]+\/reply|saved(?:\/[^/]+)?)|sessions\/[^/]+\/todo)$/.test(
            url.pathname,
          );
        const isSettings = isSettingsRoute(httpRequest.method, url.pathname);
        const isSkills = isSkillsRoute(httpRequest.method, url.pathname);
        const isInternalMcp =
          (httpRequest.method ?? "GET") === "POST" && url.pathname === "/internal/mcp";
        const isSsh = isSshRoute(httpRequest.method, url.pathname);
        const isContext = isContextRoute(httpRequest.method, url.pathname);
        const isCommands = isCommandsRoute(httpRequest.method, url.pathname);
        const isRuntime = /^\/api\/apps\/[^/]+\/runtime$/.test(url.pathname);
        const isPreviews = isPreviewsRoute(httpRequest.method, url.pathname);
        const isChat =
          !isRuntime && (url.pathname === "/chat" || url.pathname.startsWith("/api/apps/"));
        const result = isImages
          ? await handleImages(deps, httpRequest)
          : isGit
            ? await handleGit(deps, httpRequest)
            : isPrompts
              ? await handlePrompts(deps, httpRequest)
              : isSettings
                ? await handleSettings(deps, httpRequest)
                : isSkills
                  ? await handleSkills(deps, httpRequest)
                  : isInternalMcp
                    ? await handleInternalMcp(deps, httpRequest)
                    : isSsh
                      ? await handleSsh(deps, httpRequest)
                      : isContext
                        ? await handleContext(deps, httpRequest)
                        : isCommands
                          ? await handleCommands(deps, httpRequest)
                          : isPreviews
                            ? await handlePreviews(deps, httpRequest)
                            : isChat
                              ? await handleChat(deps, httpRequest)
                              : handleRequest(deps, httpRequest);
        response.writeHead(result.status, {
          "content-type": result.contentType,
          ...(result.headers ?? {}),
        });
        response.end(result.body);
      })
      .catch((error: unknown) => {
        if (error instanceof PayloadTooLargeError) {
          response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
          response.end(
            JSON.stringify({
              error: "request body too large",
              code: "payload_too_large",
            }),
          );
          return;
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url ?? "";
    if (/^\/api\/apps\/[^/]+\/terminal(?:\?|$)/.test(url)) {
      void proxyTerminalUpgrade(deps, request, socket, head).catch(() => socket.destroy());
      return;
    }
    const upgradeUrl = new URL(url, "http://localhost");
    if (upgradeUrl.pathname === "/preview" || upgradeUrl.pathname.startsWith("/preview/")) {
      const match = PREVIEW_PATH.exec(upgradeUrl.pathname);
      if (match === null) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      if (!isHumanCookie(deps, request.headers.cookie)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }
      const previews = deps.previews;
      const projectId = decodePreviewSegment(match[1]);
      const appKey = decodePreviewSegment(match[2]);
      const key = decodePreviewSegment(match[3]);
      if (
        previews === undefined ||
        projectId === undefined ||
        appKey === undefined ||
        key === undefined
      ) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const found = findApp(deps, projectId, appKey);
      const preview = found === undefined ? undefined : previews.get(found.app.id, key);
      if (
        found === undefined ||
        preview === undefined ||
        preview.appId !== found.app.id ||
        preview.projectId !== found.project.id ||
        preview.appKey !== found.app.appKey
      ) {
        rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      const origin = request.headers.origin;
      if (origin !== undefined) {
        const host = request.headers.host;
        if (origin === "null" || host === undefined || host.length === 0) {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
        if (originHost !== host) {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
      }
      proxyPreviewUpgrade(deps, request, socket, head, preview);
      return;
    }
    if (!url.startsWith("/ide") || !isHumanCookie(deps, request.headers.cookie)) {
      socket.destroy();
      return;
    }
    const connection = net.connect(IDE_PORT, IDE_HOST, () => {
      const target = url.replace(/^\/ide/, "") || "/";
      const lines = [`${request.method} ${target} HTTP/${request.httpVersion}`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      connection.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) {
        connection.write(head);
      }
      socket.pipe(connection);
      connection.pipe(socket);
    });
    connection.on("error", () => socket.destroy());
    socket.on("error", () => connection.destroy());
  });

  return server;
}
