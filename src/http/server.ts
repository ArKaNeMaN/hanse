import http, {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { isHumanCookie } from "./auth.js";
import { handleChat, streamSessionEvents } from "./chat.js";
import { handleGit } from "./git.js";
import { type HttpDeps, handleRequest } from "./handler.js";
import { handleImages } from "./images.js";
import { handleInternalMcp } from "./internal-mcp.js";
import { handlePrompts, streamAppEvents } from "./prompts.js";
import { handleSettings, isSettingsRoute } from "./settings.js";
import { handleSsh, isSshRoute } from "./ssh.js";
import { proxyTerminalUpgrade } from "./terminal.js";

const IDE_PORT = Number(process.env.HANSE_IDE_PORT ?? 8080);
const IDE_HOST = process.env.HANSE_IDE_HOST ?? "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {
  constructor() {
    super("request body too large");
    this.name = "PayloadTooLargeError";
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

    void readBody(request)
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
          },
          body,
        };
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
        const isInternalMcp =
          (httpRequest.method ?? "GET") === "POST" && url.pathname === "/internal/mcp";
        const isSsh = isSshRoute(httpRequest.method, url.pathname);
        const isRuntime = /^\/api\/apps\/[^/]+\/runtime$/.test(url.pathname);
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
                : isInternalMcp
                  ? await handleInternalMcp(deps, httpRequest)
                  : isSsh
                    ? await handleSsh(deps, httpRequest)
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
