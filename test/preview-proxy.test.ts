import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import {
  basePathFor,
  filterPreviewRequestHeaders,
  filterPreviewResponseHeaders,
  previewNotFoundPage,
  previewUnavailablePage,
  rewritePreviewLocation,
} from "../src/http/preview-proxy.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { PreviewService } from "../src/preview/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const servers: Server[] = [];
const clients: net.Socket[] = [];
const upgraded: Duplex[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const socket of upgraded.splice(0)) {
    socket.destroy();
  }
  for (const client of clients.splice(0)) {
    client.destroy();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

interface UpstreamState {
  requests: Array<{ url: string; headers: IncomingMessage["headers"] }>;
  upgrades: Array<{ url: string; headers: IncomingMessage["headers"]; head: string }>;
  streamRelease: () => void;
}

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function createUpstream(state: UpstreamState): Server {
  const handler: RequestListener = (request: IncomingMessage, response: ServerResponse) => {
    request.on("error", () => undefined);
    const parsed = new URL(request.url ?? "/", "http://localhost");
    state.requests.push({ url: request.url ?? "", headers: request.headers });

    if (parsed.pathname.endsWith("/echo")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ url: request.url ?? "", headers: request.headers }));
      return;
    }
    if (parsed.pathname.endsWith("/drop-headers")) {
      response.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": ["one=1; Path=/", "two=2; Path=/"],
        "clear-site-data": '"cache"',
        "service-worker-allowed": "/",
        "strict-transport-security": "max-age=31536000",
        "alt-svc": 'h3=":443"',
        "report-to": '{"group":"preview"}',
        "reporting-endpoints": 'default="/reports"',
        nel: '{"report_to":"preview"}',
        "www-authenticate": 'Basic realm="preview"',
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "DENY",
        "cross-origin-opener-policy": "same-origin",
      });
      response.end("headers");
      return;
    }
    if (parsed.pathname.endsWith("/location")) {
      response.writeHead(302, { location: parsed.searchParams.get("to") ?? "/" });
      response.end();
      return;
    }
    if (parsed.pathname.endsWith("/status")) {
      response.writeHead(418, { "content-type": "text/plain" });
      response.end("teapot");
      return;
    }
    if (parsed.pathname.endsWith("/stream")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first-chunk");
      state.streamRelease = () => response.end("second-chunk");
      return;
    }
    if (parsed.pathname.endsWith("/upstream-101")) {
      request.socket.on("error", () => undefined);
      request.socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      request.socket.end();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  };

  const server = createServer(handler);
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgraded.push(socket);
    socket.on("error", () => undefined);
    const parsed = new URL(request.url ?? "/", "http://localhost");
    state.upgrades.push({
      url: request.url ?? "",
      headers: request.headers,
      head: head.toString("utf8"),
    });

    if (parsed.pathname.endsWith("/ws")) {
      const key = String(request.headers["sec-websocket-key"] ?? "");
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "Sec-WebSocket-Protocol: chat",
          "Sec-WebSocket-Extensions: permessage-deflate",
          "Set-Cookie: session=evil; Path=/",
          'Clear-Site-Data: "cache"',
          'WWW-Authenticate: Basic realm="preview"',
          "Strict-Transport-Security: max-age=31536000",
          'Alt-Svc: h3=":443"',
          'Report-To: {"group":"preview"}',
          'Reporting-Endpoints: default="/reports"',
          'NEL: {"report_to":"preview"}',
          "",
          "",
        ].join("\r\n"),
      );
      socket.on("data", (chunk: Buffer) => socket.write(chunk));
      return;
    }
    if (parsed.pathname.endsWith("/ws-overflow")) {
      socket.write("Set-Cookie: leaked=1; Path=/\r\n");
      socket.write(`X-Flood: ${"a".repeat(70 * 1024)}`);
      return;
    }
    if (parsed.pathname.endsWith("/ws-non-101")) {
      socket.write(
        "HTTP/1.1 403 Forbidden\r\nSet-Cookie: leaked=1; Path=/\r\nContent-Length: 0\r\n\r\n",
      );
      socket.end();
      return;
    }
    if (parsed.pathname.endsWith("/ws-obsfold")) {
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Accept: abc",
          " folded-value",
          "",
          "",
        ].join("\r\n"),
      );
      return;
    }
    if (parsed.pathname.endsWith("/ws-crlf")) {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: abc\r\nX-Evil: a\rb\r\n\r\n",
      );
      return;
    }
    socket.destroy();
  });
  return server;
}

async function reserveDeadPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  servers.splice(servers.indexOf(server), 1);
  return port;
}

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  previews: PreviewService;
  token: string;
  agentToken: string;
  coordinatorPort: number;
  upstreamPort: number;
  upstream: UpstreamState;
}

async function fixture(): Promise<Fixture> {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Alpha','main','/tmp/p1',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p1:a','p1','a','apps/a','AGENTS.md',?)",
  ).run(now);

  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "agent" }).token;
  const previews = new PreviewService();
  const upstream: UpstreamState = {
    requests: [],
    upgrades: [],
    streamRelease: () => undefined,
  };
  const upstreamServer = createUpstream(upstream);
  const upstreamPort = await listen(upstreamServer);
  const deadPort = await reserveDeadPort();

  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    previews,
    getProjects: () => [
      {
        id: "p1",
        name: "Alpha",
        rootPath: "/tmp/p1",
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, "p1"),
      },
    ],
  };
  const server = createHttpServer(deps);
  server.on("upgrade", (_request: IncomingMessage, socket: Duplex) => {
    upgraded.push(socket);
  });
  const coordinatorPort = await listen(server);

  previews.open({
    appId: "p1:a",
    projectId: "p1",
    appKey: "a",
    key: "web",
    name: "Web",
    port: upstreamPort,
    targetHost: "127.0.0.1",
  });
  previews.open({
    appId: "p1:a",
    projectId: "p1",
    appKey: "a",
    key: "dead",
    name: "Dead",
    port: deadPort,
    targetHost: "127.0.0.1",
  });

  return {
    db,
    deps,
    previews,
    token,
    agentToken,
    coordinatorPort,
    upstreamPort,
    upstream,
  };
}

function cookieHeader(token: string): string {
  return `hanse_token=${encodeURIComponent(token)}`;
}

function proxyFetch(f: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) {
    headers.set("cookie", cookieHeader(f.token));
  }
  return fetch(`http://127.0.0.1:${f.coordinatorPort}${path}`, {
    ...init,
    redirect: "manual",
    headers,
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for data")), timeoutMs),
    ),
  ]);
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const result = await withTimeout(reader.read());
  return result.value === undefined ? "" : Buffer.from(result.value).toString("utf8");
}

interface RawUpgradeResult {
  status: number;
  headers: Record<string, string>;
  rest: Buffer;
  raw: string;
  socket: net.Socket;
}

function rawUpgrade(options: {
  port: number;
  path: string;
  host?: string;
  headers?: Record<string, string>;
  head?: string;
}): Promise<RawUpgradeResult> {
  const key = randomBytes(16).toString("base64");
  const host = options.host ?? `coordinator.example:${options.port}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect(options.port, "127.0.0.1");
    clients.push(socket);
    socket.on("error", () => undefined);
    socket.setTimeout(3000);

    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("connect", onConnect);
    };
    const onTimeout = (): void => {
      cleanup();
      socket.destroy();
      reject(new Error("timed out waiting for an upgrade response"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        return;
      }
      cleanup();
      socket.setTimeout(0);
      const block = buffer.subarray(0, end).toString("latin1");
      const lines = block.split("\r\n");
      const status = Number.parseInt((lines[0] ?? "").split(" ")[1] ?? "0", 10);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const separator = line.indexOf(":");
        if (separator < 0) {
          continue;
        }
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
      }
      resolve({ status, headers, rest: buffer.subarray(end + 4), raw: block, socket });
    };
    const onConnect = (): void => {
      const lines = [
        `GET ${options.path} HTTP/1.1`,
        `Host: ${host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
      ];
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        lines.push(`${name}: ${value}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n${options.head ?? ""}`);
    };

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("timeout", onTimeout);
  });
}

function readSocket(socket: net.Socket): Promise<Buffer> {
  return withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      const cleanup = (): void => {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
      };
      const onData = (chunk: Buffer): void => {
        cleanup();
        resolve(chunk);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      socket.on("data", onData);
      socket.on("error", onError);
    }),
  );
}

describe("basePathFor", () => {
  it("builds an encoded base path with a trailing slash", () => {
    expect(basePathFor({ projectId: "p1", appKey: "a", key: "web" })).toBe("/preview/p1/a/web/");
    expect(basePathFor({ projectId: "p 1", appKey: "a/1", key: "web key" })).toBe(
      "/preview/p%201/a%2F1/web%20key/",
    );
  });
});

describe("rewritePreviewLocation", () => {
  const base = "/preview/p/a/web/";

  it("prefixes a single-slash root-relative path and preserves query and fragment", () => {
    expect(rewritePreviewLocation("/login?next=/x#frag", base)).toBe(
      "/preview/p/a/web/login?next=/x#frag",
    );
    expect(rewritePreviewLocation("/a?b=1#c", base)).toBe("/preview/p/a/web/a?b=1#c");
    expect(rewritePreviewLocation("/", base)).toBe("/preview/p/a/web/");
  });

  it("does not double-prefix either base spelling or an already-prefixed path", () => {
    expect(rewritePreviewLocation("/preview/p/a/web", base)).toBe("/preview/p/a/web");
    expect(rewritePreviewLocation("/preview/p/a/web/", base)).toBe("/preview/p/a/web/");
    expect(rewritePreviewLocation("/preview/p/a/web/assets/x.js?v=1", base)).toBe(
      "/preview/p/a/web/assets/x.js?v=1",
    );
  });

  it("accepts a base without a trailing slash", () => {
    expect(rewritePreviewLocation("/preview/p/a/web", "/preview/p/a/web")).toBe("/preview/p/a/web");
    expect(rewritePreviewLocation("/login", "/preview/p/a/web")).toBe("/preview/p/a/web/login");
  });

  it("does not mistake a sibling preview for the base", () => {
    expect(rewritePreviewLocation("/preview/p/a/k2", base)).toBe("/preview/p/a/web/preview/p/a/k2");
    expect(rewritePreviewLocation("/preview/p/a/web2", base)).toBe(
      "/preview/p/a/web/preview/p/a/web2",
    );
  });

  it("leaves protocol-relative, relative, and absolute locations untouched", () => {
    expect(rewritePreviewLocation("//evil.example/x", base)).toBe("//evil.example/x");
    expect(rewritePreviewLocation("https://evil.example/x", base)).toBe("https://evil.example/x");
    expect(rewritePreviewLocation("relative/path", base)).toBe("relative/path");
  });
});

describe("filterPreviewRequestHeaders", () => {
  it("strips credentials and hop-by-hop headers and adds forwarding hints", () => {
    const filtered = filterPreviewRequestHeaders(
      {
        cookie: "hanse_token=secret",
        authorization: "Bearer secret",
        "proxy-authorization": "Basic secret",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "proxy-authenticate": "Basic",
        te: "trailers",
        trailer: "x",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        host: "coordinator.example:8787",
        origin: "http://coordinator.example:8787",
        accept: "text/html",
        "x-forwarded-proto": "https",
      },
      "/preview/p/a/web/",
    );

    expect(filtered.cookie).toBeUndefined();
    expect(filtered.authorization).toBeUndefined();
    expect(filtered["proxy-authorization"]).toBeUndefined();
    expect(filtered.connection).toBeUndefined();
    expect(filtered["keep-alive"]).toBeUndefined();
    expect(filtered["proxy-authenticate"]).toBeUndefined();
    expect(filtered.te).toBeUndefined();
    expect(filtered.trailer).toBeUndefined();
    expect(filtered["transfer-encoding"]).toBeUndefined();
    expect(filtered.upgrade).toBeUndefined();

    expect(filtered.host).toBe("coordinator.example:8787");
    expect(filtered.origin).toBe("http://coordinator.example:8787");
    expect(filtered.accept).toBe("text/html");
    expect(filtered["x-forwarded-host"]).toBe("coordinator.example:8787");
    expect(filtered["x-forwarded-prefix"]).toBe("/preview/p/a/web/");
    expect(filtered["x-forwarded-proto"]).toBe("https");
  });

  it("defaults x-forwarded-proto to http", () => {
    const filtered = filterPreviewRequestHeaders(
      { host: "coordinator.example" },
      "/preview/p/a/web/",
    );
    expect(filtered["x-forwarded-proto"]).toBe("http");
  });
});

describe("filterPreviewResponseHeaders", () => {
  it("drops origin-wide and hop-by-hop headers, keeps per-document headers, rewrites Location", () => {
    const filtered = filterPreviewResponseHeaders(
      {
        "set-cookie": ["one=1", "two=2"],
        "clear-site-data": '"cache"',
        "service-worker-allowed": "/",
        "strict-transport-security": "max-age=31536000",
        "alt-svc": 'h3=":443"',
        "report-to": '{"group":"preview"}',
        "reporting-endpoints": 'default="/reports"',
        nel: '{"report_to":"preview"}',
        "www-authenticate": 'Basic realm="preview"',
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        location: "/login?next=/x#frag",
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "DENY",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
        "permissions-policy": "camera=()",
      },
      "/preview/p/a/web/",
    );

    for (const name of [
      "set-cookie",
      "clear-site-data",
      "service-worker-allowed",
      "strict-transport-security",
      "alt-svc",
      "report-to",
      "reporting-endpoints",
      "nel",
      "www-authenticate",
      "connection",
      "keep-alive",
    ]) {
      expect(filtered[name]).toBeUndefined();
    }
    expect(filtered.location).toBe("/preview/p/a/web/login?next=/x#frag");
    expect(filtered["content-security-policy"]).toBe("default-src 'self'");
    expect(filtered["x-frame-options"]).toBe("DENY");
    expect(filtered["cross-origin-opener-policy"]).toBe("same-origin");
    expect(filtered["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(filtered["cross-origin-resource-policy"]).toBe("same-origin");
    expect(filtered["permissions-policy"]).toBe("camera=()");
  });
});

describe("preview error pages", () => {
  it("renders the design copy without scripts or external assets", () => {
    const notFound = previewNotFoundPage();
    expect(notFound).toContain("<title>Preview not found</title>");
    expect(notFound).toContain(
      "This preview has expired or was closed. Open it again from the agent's message.",
    );
    expect(notFound).not.toContain("<script");

    const unavailable = previewUnavailablePage();
    expect(unavailable).toContain("<title>Preview unavailable</title>");
    expect(unavailable).toContain(
      "The dev server is not responding. Start it in the agent, then reload.",
    );
    expect(unavailable).toContain('href=""');
    expect(unavailable).not.toContain("<script");
  });
});

describe("preview HTTP proxy", () => {
  it("forwards the full path and query and strips credentials", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/web/echo?x=1", {
      headers: { authorization: "Bearer operator-secret" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      url: string;
      headers: Record<string, string | string[] | undefined>;
    };
    expect(body.url).toBe("/preview/p1/a/web/echo?x=1");
    expect(body.headers.cookie).toBeUndefined();
    expect(body.headers.authorization).toBeUndefined();
    expect(body.headers["proxy-authorization"]).toBeUndefined();
    expect(body.headers.host).toBe(`127.0.0.1:${f.coordinatorPort}`);
    expect(body.headers["x-forwarded-host"]).toBe(`127.0.0.1:${f.coordinatorPort}`);
    expect(body.headers["x-forwarded-prefix"]).toBe("/preview/p1/a/web/");
    expect(body.headers["x-forwarded-proto"]).toBe("http");
  });

  it("keeps an incoming x-forwarded-proto", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/web/echo", {
      headers: { "x-forwarded-proto": "https" },
    });
    const body = (await response.json()) as {
      headers: Record<string, string | string[] | undefined>;
    };
    expect(body.headers["x-forwarded-proto"]).toBe("https");
  });

  it("redirects a missing trailing slash and preserves the query", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/web?x=1");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/preview/p1/a/web/?x=1");
  });

  it("redirects unauthorized GET/HEAD to login and rejects other methods with 401", async () => {
    const f = await fixture();
    const base = `http://127.0.0.1:${f.coordinatorPort}`;

    const get = await fetch(`${base}/preview/p1/a/web/?x=1`, { redirect: "manual" });
    expect(get.status).toBe(302);
    expect(get.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent("/preview/p1/a/web/?x=1")}`,
    );

    const head = await fetch(`${base}/preview/p1/a/web/`, { method: "HEAD", redirect: "manual" });
    expect(head.status).toBe(302);

    const post = await fetch(`${base}/preview/p1/a/web/`, { method: "POST", redirect: "manual" });
    expect(post.status).toBe(401);
    expect(await post.json()).toEqual({
      error: "sign in required",
      code: "preview_auth_required",
    });
  });

  it("does not accept an agent token cookie", async () => {
    const f = await fixture();
    const response = await fetch(`http://127.0.0.1:${f.coordinatorPort}/preview/p1/a/web/`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(f.agentToken) },
    });
    expect(response.status).toBe(302);
    expect(f.upstream.requests).toHaveLength(0);
  });

  it("returns the 404 page for malformed, unknown, expired, and mismatched previews", async () => {
    const f = await fixture();

    const malformed = await proxyFetch(f, "/preview/p1/a");
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toContain("Preview not found");

    const unknown = await proxyFetch(f, "/preview/p1/a/missing/");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("Preview not found");

    f.previews.open({
      appId: "p1:a",
      projectId: "p2",
      appKey: "a",
      key: "mismatch",
      name: "Mismatch",
      port: f.upstreamPort,
      targetHost: "127.0.0.1",
    });
    const mismatch = await proxyFetch(f, "/preview/p1/a/mismatch/");
    expect(mismatch.status).toBe(404);
    expect(await mismatch.text()).toContain("Preview not found");
  });

  it("returns the 404 page when the preview service is not configured", async () => {
    const f = await fixture();
    f.deps.previews = undefined;
    const response = await proxyFetch(f, "/preview/p1/a/web/");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Preview not found");
  });

  it("returns a 502 page when the target refuses connections", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/dead/");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Preview unavailable");
  });

  it("passes upstream status codes through", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/web/status");
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("teapot");
  });

  it("drops origin-wide response headers and keeps per-document headers", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/web/drop-headers");
    expect(response.status).toBe(200);
    for (const name of [
      "set-cookie",
      "clear-site-data",
      "service-worker-allowed",
      "strict-transport-security",
      "alt-svc",
      "report-to",
      "reporting-endpoints",
      "nel",
      "www-authenticate",
    ]) {
      expect(response.headers.get(name)).toBeNull();
    }
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  it("rewrites a relative Location into the preview base path", async () => {
    const f = await fixture();
    const response = await proxyFetch(
      f,
      `/preview/p1/a/web/location?to=${encodeURIComponent("/login?next=/x#frag")}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/preview/p1/a/web/login?next=/x#frag");
  });

  it("streams the upstream body without buffering it", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/web/stream");
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("expected a streaming body");
    }
    let text = "";
    while (!text.includes("first-chunk")) {
      text += await readChunk(reader);
    }
    f.upstream.streamRelease();
    while (!text.includes("second-chunk")) {
      text += await readChunk(reader);
    }
    expect(text).toBe("first-chunksecond-chunk");
  });

  it("never forwards an upstream 101 on a normal HTTP request", async () => {
    const f = await fixture();
    const response = await proxyFetch(f, "/preview/p1/a/web/upstream-101");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Preview unavailable");
  });
});

describe("preview WebSocket proxy", () => {
  it("proxies a valid upgrade, filters the 101 headers, and pipes both directions", async () => {
    const f = await fixture();
    const host = `coordinator.example:${f.coordinatorPort}`;
    const result = await rawUpgrade({
      port: f.coordinatorPort,
      path: "/preview/p1/a/web/ws?x=1",
      host,
      headers: { cookie: cookieHeader(f.token), origin: `http://${host}` },
      head: "HEAD",
    });

    expect(result.status).toBe(101);
    expect(result.headers.connection).toBe("Upgrade");
    expect(result.headers.upgrade).toBe("websocket");
    expect(result.headers["sec-websocket-accept"]).toBeDefined();
    expect(result.headers["sec-websocket-protocol"]).toBe("chat");
    expect(result.headers["sec-websocket-extensions"]).toBe("permessage-deflate");
    for (const name of [
      "set-cookie",
      "clear-site-data",
      "www-authenticate",
      "strict-transport-security",
      "alt-svc",
      "report-to",
      "reporting-endpoints",
      "nel",
    ]) {
      expect(result.headers[name]).toBeUndefined();
    }

    expect(f.upstream.upgrades).toHaveLength(1);
    const upstream = f.upstream.upgrades[0];
    expect(upstream?.url).toBe("/preview/p1/a/web/ws?x=1");
    expect(upstream?.headers.cookie).toBeUndefined();
    expect(upstream?.headers.authorization).toBeUndefined();
    expect(upstream?.headers["proxy-authorization"]).toBeUndefined();
    expect(upstream?.headers.host).toBe(host);
    expect(upstream?.headers["sec-websocket-key"]).toBeDefined();
    expect(upstream?.head).toBe("HEAD");

    const echo = readSocket(result.socket);
    result.socket.write("Z");
    expect((await echo).toString("utf8")).toContain("Z");
  });

  it("allows an absent Origin and rejects a mismatched origin or the literal null", async () => {
    const f = await fixture();
    const path = "/preview/p1/a/web/ws";

    const absent = await rawUpgrade({
      port: f.coordinatorPort,
      path,
      headers: { cookie: cookieHeader(f.token) },
    });
    expect(absent.status).toBe(101);
    absent.socket.destroy();

    const mismatched = await rawUpgrade({
      port: f.coordinatorPort,
      path,
      headers: { cookie: cookieHeader(f.token), origin: "http://evil.example" },
    });
    expect(mismatched.status).toBe(403);
    mismatched.socket.destroy();

    const nullOrigin = await rawUpgrade({
      port: f.coordinatorPort,
      path,
      headers: { cookie: cookieHeader(f.token), origin: "null" },
    });
    expect(nullOrigin.status).toBe(403);
    nullOrigin.socket.destroy();
  });

  it("rejects upgrades without a cookie or for an unknown preview", async () => {
    const f = await fixture();

    const anonymous = await rawUpgrade({ port: f.coordinatorPort, path: "/preview/p1/a/web/ws" });
    expect(anonymous.status).toBe(401);
    anonymous.socket.destroy();

    const unknown = await rawUpgrade({
      port: f.coordinatorPort,
      path: "/preview/p1/a/missing/ws",
      headers: { cookie: cookieHeader(f.token) },
    });
    expect(unknown.status).toBe(404);
    unknown.socket.destroy();
  });

  it("caps the upstream header block at 64 KiB and never forwards unfiltered bytes", async () => {
    const f = await fixture();
    const result = await rawUpgrade({
      port: f.coordinatorPort,
      path: "/preview/p1/a/web/ws-overflow",
      headers: { cookie: cookieHeader(f.token) },
    });
    expect(result.status).toBe(502);
    expect(result.raw.toLowerCase()).not.toContain("set-cookie");
    expect(result.raw.toLowerCase()).not.toContain("leaked");
    result.socket.destroy();
  });

  it("rejects a non-101 upstream response and malformed header blocks", async () => {
    const f = await fixture();
    for (const path of ["/ws-non-101", "/ws-obsfold", "/ws-crlf"]) {
      const result = await rawUpgrade({
        port: f.coordinatorPort,
        path: `/preview/p1/a/web${path}`,
        headers: { cookie: cookieHeader(f.token) },
      });
      expect(result.status, path).toBe(502);
      expect(result.raw.toLowerCase(), path).not.toContain("leaked");
      result.socket.destroy();
    }
  });

  it("returns a 502 handshake when the target refuses connections", async () => {
    const f = await fixture();
    const result = await rawUpgrade({
      port: f.coordinatorPort,
      path: "/preview/p1/a/dead/ws",
      headers: { cookie: cookieHeader(f.token) },
    });
    expect(result.status).toBe(502);
    result.socket.destroy();
  });
});
