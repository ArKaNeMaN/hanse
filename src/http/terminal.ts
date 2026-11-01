import http, { type IncomingMessage, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { cookieToken, isHumanCookie } from "./auth.js";
import type { HttpDeps } from "./handler.js";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rejectSocket(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const payload = JSON.stringify({ error: message });
  socket.write(
    [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
      "content-type: application/json; charset=utf-8",
      `content-length: ${Buffer.byteLength(payload)}`,
      "cache-control: no-store",
      "connection: close",
      "",
      payload,
    ].join("\r\n"),
  );
  socket.end();
}

/** Proxy an operator terminal WebSocket to the runner with the runtime bearer token. */
export async function proxyTerminalUpgrade(
  deps: HttpDeps,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const parsed = new URL(request.url ?? "/", "http://localhost");
  const match = /^\/api\/apps\/([^/]+)\/terminal$/.exec(parsed.pathname);
  if (match === null) {
    rejectSocket(socket, 404, "not found");
    return;
  }
  if ((request.method ?? "GET") !== "GET") {
    rejectSocket(socket, 405, "method not allowed");
    return;
  }
  if (!isHumanCookie(deps, request.headers.cookie)) {
    rejectSocket(
      socket,
      cookieToken(request.headers.cookie) === undefined ? 401 : 403,
      "forbidden",
    );
    return;
  }

  const projectId = parsed.searchParams.get("project");
  if (projectId === null || projectId.length === 0) {
    rejectSocket(socket, 400, "project query is required");
    return;
  }
  const appKey = safeDecode(match[1] ?? "");
  const app = deps.db
    .prepare("SELECT id FROM apps WHERE project_id = ? AND app_key = ?")
    .get(projectId, appKey) as { id: string } | undefined;
  if (app === undefined) {
    rejectSocket(socket, 404, "application not found");
    return;
  }

  const runner = deps.runner;
  if (runner === undefined || runner.url.trim().length === 0 || runner.token.length === 0) {
    rejectSocket(socket, 503, "terminal runner is not configured");
    return;
  }
  let upstream: URL;
  try {
    upstream = new URL(runner.url);
  } catch {
    rejectSocket(socket, 503, "terminal runner is not configured");
    return;
  }
  if (upstream.protocol !== "http:") {
    rejectSocket(socket, 503, "terminal runner must use http");
    return;
  }

  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (typeof key !== "string" || typeof version !== "string") {
    rejectSocket(socket, 400, "invalid websocket handshake");
    return;
  }

  await new Promise<void>((resolve) => {
    const upstreamRequest = http.request({
      host: upstream.hostname,
      port: upstream.port.length > 0 ? Number(upstream.port) : 80,
      method: "GET",
      path: `/v1/apps/${encodeURIComponent(app.id)}/exec`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": version,
        authorization: `Bearer ${runner.token}`,
      },
    });

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      resolve();
    };

    upstreamRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      if (!socket.writable) {
        upstreamSocket.destroy();
        finish();
        return;
      }
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index];
        const value = response.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) {
          lines.push(`${name}: ${value}`);
        }
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
      socket.on("error", () => upstreamSocket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
      finish();
    });

    upstreamRequest.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (!socket.writable) {
          socket.destroy();
          finish();
          return;
        }
        const body = Buffer.concat(chunks);
        const lines = [
          `HTTP/1.1 ${response.statusCode ?? 502} ${
            STATUS_CODES[response.statusCode ?? 502] ?? "Error"
          }`,
        ];
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) {
            lines.push(`${name}: ${value}`);
          }
        }
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        socket.write(body);
        socket.end();
        finish();
      });
      response.on("error", () => {
        socket.destroy();
        finish();
      });
    });

    upstreamRequest.on("error", () => {
      rejectSocket(socket, 502, "terminal runner is unavailable");
      finish();
    });
    upstreamRequest.end();
  });
}
