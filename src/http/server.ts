import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleChat, streamSessionEvents } from "./chat.js";
import type { HttpDeps } from "./handler.js";
import { handleRequest } from "./handler.js";

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Create the coordinator HTTP server. Binds locally by default. */
export function createHttpServer(deps: HttpDeps): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void readBody(request)
      .then(async (body) => {
        const url = new URL(request.url ?? "/", "http://localhost");
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
}
