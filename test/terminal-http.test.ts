import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import {
  encodeServerFrame,
  type ParsedFrame,
  parseFrame,
  requestUpgrade,
  WsClient,
} from "./ws-client.js";

const servers: Server[] = [];
const upgrades: Duplex[] = [];
const databases: SqliteDatabase[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const socket of upgrades.splice(0)) socket.destroy();
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
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const RUNTIME_TOKEN = "runtime-secret-token";

interface UpstreamState {
  paths: string[];
  authorizations: Array<string | undefined>;
  cookies: Array<string | undefined>;
  frames: ParsedFrame[];
}

async function startRunnerUpstream(): Promise<{ port: number; state: UpstreamState }> {
  const state: UpstreamState = {
    paths: [],
    authorizations: [],
    cookies: [],
    frames: [],
  };
  let buffered = Buffer.alloc(0);
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
  });
  server.on("upgrade", (_request, socket) => upgrades.push(socket));
  servers.push(server);
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    state.paths.push(request.url ?? "");
    state.authorizations.push(request.headers.authorization);
    state.cookies.push(request.headers.cookie);
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
        "",
        "",
      ].join("\r\n"),
    );
    if (head.length > 0) buffered = Buffer.concat([buffered, head]);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const frame = parseFrame(buffered, true);
        if (frame === undefined) return;
        buffered = frame.rest;
        state.frames.push(frame);
        socket.write(encodeServerFrame(0x1, Buffer.from("upstream-ok")));
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { port: address.port, state };
}

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  humanToken: string;
  agentToken: string;
  upstream: UpstreamState;
  port: number;
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-terminal-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(path.join(dir, "p"), now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);

  const humanToken = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "agent" }).token;
  const { port, state } = await startRunnerUpstream();
  const deps: HttpDeps = {
    db,
    workspaceRoot: dir,
    git: new GitService({ workspaceRoot: dir }),
    getProjects: () => [
      {
        id: "p",
        name: "P",
        rootPath: path.join(dir, "p"),
        workspaceRoot: dir,
        service: new CoordinatorService(db, "p"),
      },
    ],
    runner: { url: `http://127.0.0.1:${port}`, token: RUNTIME_TOKEN },
  };
  const server = createHttpServer(deps);
  server.on("upgrade", (_request, socket) => upgrades.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { db, deps, humanToken, agentToken, upstream: state, port: address.port };
}

function get(pathname: string, query: Record<string, string>): HttpRequest {
  return { method: "GET", path: pathname, query, headers: {} };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("operator terminal page", () => {
  it("renders for humans and links the terminal from the application page", async () => {
    const f = await fixture();
    const human = { authorization: `Bearer ${f.humanToken}` };
    const terminal = handleRequest(f.deps, {
      ...get("/terminal", { app: "a", project: "p" }),
      headers: human,
    });
    expect(terminal.status).toBe(200);
    expect(terminal.contentType).toContain("text/html");
    expect(terminal.body).toContain('data-terminal-ws="/api/apps/a/terminal?project=p"');
    expect(terminal.body).toContain("/assets/terminal.js");
    expect(terminal.body).toContain("Operator shell");
    expect(terminal.body).not.toContain(RUNTIME_TOKEN);

    const application = handleRequest(f.deps, {
      ...get("/projects/p/apps/a", {}),
      headers: human,
    });
    expect(application.status).toBe(200);
    expect(application.body).toContain('href="/terminal?app=a&amp;project=p"');
  });

  it("redirects agents and unauthenticated visitors, and 404s unknown apps", async () => {
    const f = await fixture();
    const agent = handleRequest(f.deps, {
      ...get("/terminal", { app: "a", project: "p" }),
      headers: { authorization: `Bearer ${f.agentToken}` },
    });
    expect(agent.status).toBe(303);
    expect(agent.headers?.location).toContain("/login?next=");

    const anonymous = handleRequest(f.deps, get("/terminal", { app: "a", project: "p" }));
    expect(anonymous.status).toBe(303);

    const unknown = handleRequest(f.deps, {
      ...get("/terminal", { app: "missing", project: "p" }),
      headers: { authorization: `Bearer ${f.humanToken}` },
    });
    expect(unknown.status).toBe(404);
  });
});

describe("operator terminal websocket proxy", () => {
  it("proxies the handshake with the runtime token and pipes both directions", async () => {
    const f = await fixture();
    const client = await WsClient.connect({
      port: f.port,
      path: "/api/apps/a/terminal?project=p",
      headers: { cookie: `hanse_token=${f.humanToken}` },
    });

    expect(f.upstream.paths).toEqual(["/v1/apps/p%3Aa/exec"]);
    expect(f.upstream.authorizations).toEqual([`Bearer ${RUNTIME_TOKEN}`]);
    expect(f.upstream.cookies).toEqual([undefined]);

    client.send("ls\r");
    expect(await client.nextText()).toBe("upstream-ok");
    await waitFor(() => f.upstream.frames.length === 1);
    expect(f.upstream.frames[0]?.payload.toString("utf8")).toBe("ls\r");
    client.destroy();
  });

  it("rejects missing cookies, agent cookies, bearer-only humans, and unknown apps", async () => {
    const f = await fixture();
    const pathname = "/api/apps/a/terminal?project=p";

    const anonymous = await requestUpgrade({ port: f.port, path: pathname });
    expect(anonymous.status).toBe(401);

    const agent = await requestUpgrade({
      port: f.port,
      path: pathname,
      headers: { cookie: `hanse_token=${f.agentToken}` },
    });
    expect(agent.status).toBe(403);

    const bearer = await requestUpgrade({
      port: f.port,
      path: pathname,
      headers: { authorization: `Bearer ${f.humanToken}` },
    });
    expect(bearer.status).toBe(401);

    const unknown = await requestUpgrade({
      port: f.port,
      path: "/api/apps/missing/terminal?project=p",
      headers: { cookie: `hanse_token=${f.humanToken}` },
    });
    expect(unknown.status).toBe(404);
    expect(f.upstream.paths).toEqual([]);
  });

  it("rejects terminal upgrades when the runner is not configured", async () => {
    const f = await fixture();
    delete f.deps.runner;
    const result = await requestUpgrade({
      port: f.port,
      path: "/api/apps/a/terminal?project=p",
      headers: { cookie: `hanse_token=${f.humanToken}` },
    });
    expect(result.status).toBe(503);
    expect(f.upstream.paths).toEqual([]);
  });
});
