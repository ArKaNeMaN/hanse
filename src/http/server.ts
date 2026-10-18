import http, {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { authenticate } from "../identity/auth.js";
import { handleChat, streamSessionEvents } from "./chat.js";
import { type HttpDeps, handleRequest } from "./handler.js";

const IDE_PORT = Number(process.env.HANSE_IDE_PORT ?? 8080);
const IDE_HOST = process.env.HANSE_IDE_HOST ?? "127.0.0.1";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function cookieToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key === "hanse_token" && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function isAuthed(deps: HttpDeps, request: IncomingMessage): boolean {
  const token = cookieToken(request.headers.cookie);
  if (token === undefined || token.length === 0) {
    return false;
  }
  try {
    authenticate(deps.db, `Bearer ${token}`);
    return true;
  } catch {
    return false;
  }
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
      if (!isAuthed(deps, request)) {
        response.writeHead(302, { location: "/login" });
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
          },
          body,
        };
        const isEvents = /^\/api\/apps\/[^/]+\/sessions\/[^/]+\/events$/.test(url.pathname);
        if (isEvents && (request.method ?? "GET") === "GET") {
          await streamSessionEvents(deps, httpRequest, response);
          return;
        }
        const isChat = url.pathname === "/chat" || url.pathname.startsWith("/api/apps/");
        const result = isChat
          ? await handleChat(deps, httpRequest)
          : handleRequest(deps, httpRequest);
        response.writeHead(result.status, {
          "content-type": result.contentType,
          ...(result.headers ?? {}),
        });
        response.end(result.body);
      })
      .catch((error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url ?? "";
    if (!url.startsWith("/ide") || !isAuthed(deps, request)) {
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
