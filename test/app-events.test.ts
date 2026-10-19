import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  agentToken: string;
  base: string;
}

function addProject(db: SqliteDatabase, id: string, name: string, appKey: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?,'main',?,?,?)",
  ).run(id, name, `/tmp/${id}`, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?,?,?,?, 'AGENTS.md', ?)",
  ).run(`${id}:${appKey}`, id, appKey, `apps/${appKey}`, now);
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-events-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  addProject(db, "p1", "Alpha", "storefront");
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "bot" }).token;
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    getProjects: () =>
      (
        db.prepare("SELECT id, name, root_path FROM projects ORDER BY rowid").all() as Array<{
          id: string;
          name: string;
          root_path: string;
        }>
      ).map((row) => ({
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        service: new CoordinatorService(db, row.id),
      })),
  };
  const server = createHttpServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { db, deps, token, agentToken, base: `http://127.0.0.1:${address.port}` };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

interface EventUpstream {
  endpoint: string;
  requests: string[];
  send(chunk: string): void;
  close(): void;
  closed(): boolean;
}

async function fakeEventUpstream(status = 200): Promise<EventUpstream> {
  const requests: string[] = [];
  let respond: ServerResponse | undefined;
  let closedFlag = false;
  const server = createServer((incoming, outgoing) => {
    requests.push(incoming.url ?? "");
    if (incoming.url !== "/event") {
      outgoing.writeHead(404, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (status !== 200) {
      outgoing.writeHead(status, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "boom" }));
      return;
    }
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.flushHeaders();
    respond = outgoing;
    incoming.on("close", () => {
      closedFlag = true;
    });
    outgoing.on("close", () => {
      closedFlag = true;
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    send(chunk) {
      respond?.write(chunk);
    },
    close() {
      respond?.end();
    },
    closed() {
      return closedFlag;
    },
  };
}

function useUpstream(deps: HttpDeps, endpoint: string): void {
  deps.manager = {
    ensure: async () => endpoint,
    policyWarnings: () => [],
  } as unknown as InstanceManager;
}

interface Probe {
  waitFor(text: string, timeoutMs?: number): Promise<string>;
  text(): string;
  close(): Promise<void>;
}

function probe(response: Response): Probe {
  const body = response.body;
  if (body === null) throw new Error("stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async waitFor(text, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (!buffer.includes(text)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for ${text}; got ${buffer}`);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out reading stream`)), remaining);
        });
        try {
          const { done, value } = await Promise.race([reader.read(), timeout]);
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      if (!buffer.includes(text)) throw new Error(`missing ${text}; got ${buffer}`);
      return buffer;
    },
    text() {
      return buffer;
    },
    async close() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

function frames(buffer: string): unknown[] {
  return buffer
    .split("\n\n")
    .map((block) =>
      block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data.length > 0)
    .flatMap((data) => {
      try {
        return [JSON.parse(data) as unknown];
      } catch {
        return [];
      }
    });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("app event stream", () => {
  it("requires a human principal before starting the runtime", async () => {
    const f = await fixture();
    let ensured = 0;
    f.deps.manager = {
      ensure: async () => {
        ensured += 1;
        return "http://127.0.0.1:1";
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const missing = await fetch(`${f.base}/api/apps/storefront/events`);
    expect(missing.status).toBe(401);

    const agent = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.agentToken),
    });
    expect(agent.status).toBe(403);
    expect(ensured).toBe(0);
  });

  it("returns 503 without a runtime and 404 for an unknown app", async () => {
    const f = await fixture();
    const noRuntime = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(noRuntime.status).toBe(503);

    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const unknown = await fetch(`${f.base}/api/apps/nope/events`, {
      headers: auth(f.token),
    });
    expect(unknown.status).toBe(404);
  });

  it("writes SSE headers and stream.ready once the upstream reader is attached", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);

    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const stream = probe(response);
    try {
      const text = await stream.waitFor('data: {"type":"stream.ready"}');
      expect(frames(text)).toEqual([{ type: "stream.ready" }]);
    } finally {
      await stream.close();
    }
  });

  it("projects v1 and v2 frames and forwards warnings", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    const stream = probe(response);

    try {
      await stream.waitFor('data: {"type":"stream.ready"}');
      upstream.send(
        [
          "data: not-json\n\n",
          `data: ${JSON.stringify({
            id: "evt_v1_q",
            type: "question.asked",
            properties: {
              id: "q1",
              sessionID: "ses_1",
              questions: [
                {
                  header: "H",
                  question: "Q?",
                  options: [{ label: "A", description: "" }],
                },
              ],
            },
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "evt_v2_q",
            type: "question.v2.asked",
            properties: {
              id: "q2",
              sessionID: "ses_2",
              questions: [
                { header: "H", question: "Q?", options: [], multiple: true, custom: true },
              ],
            },
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "evt_v2_perm",
            type: "permission.v2.asked",
            properties: {
              id: "p2",
              sessionID: "ses_2",
              action: "bash",
              resources: ["ls*"],
              save: ["ls*"],
            },
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "evt_todo",
            type: "todo.updated",
            properties: {
              sessionID: "ses_2",
              todos: [{ content: "step", status: "blocked", priority: "urgent" }],
            },
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "evt_activity",
            type: "session.status",
            properties: { sessionID: "ses_3" },
          })}\n\n`,
        ].join(""),
      );

      const text = await stream.waitFor('"type":"session.activity"');
      const projected = frames(text) as Array<Record<string, unknown>>;
      expect(projected[0]).toEqual({ type: "stream.ready" });
      expect(projected).toContainEqual({
        type: "stream.warning",
        code: "invalid_json",
        message: "dropped an SSE frame with invalid JSON",
      });

      const asked = projected.filter((event) => event.type === "question.asked");
      expect(asked).toHaveLength(2);
      expect(asked.map((event) => (event.request as { key: string; source: string }).key)).toEqual([
        "v1:q1",
        "v2:q2",
      ]);
      expect(asked.map((event) => (event.request as { source: string }).source)).toEqual([
        "v1",
        "v2",
      ]);

      const permission = projected.find((event) => event.type === "permission.asked");
      if (permission === undefined) throw new Error("missing permission event");
      const permissionRequest = permission.request as { source: string; permission: string };
      expect(permissionRequest.source).toBe("v2");
      expect(permissionRequest.permission).toBe("bash");

      expect(projected).toContainEqual({
        type: "todo.updated",
        sessionID: "ses_2",
        todos: [{ content: "step", status: "unknown", priority: "unknown" }],
        truncated: false,
      });
      expect(projected).toContainEqual({ type: "session.activity", sessionID: "ses_3" });
    } finally {
      await stream.close();
    }
  });

  it("emits heartbeats while the upstream is idle", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const previous = process.env.HANSE_EVENT_HEARTBEAT_MS;
    process.env.HANSE_EVENT_HEARTBEAT_MS = "20";
    try {
      const response = await fetch(`${f.base}/api/apps/storefront/events`, {
        headers: auth(f.token),
      });
      const stream = probe(response);
      try {
        await stream.waitFor(": ping\n\n");
      } finally {
        await stream.close();
      }
    } finally {
      if (previous === undefined) delete process.env.HANSE_EVENT_HEARTBEAT_MS;
      else process.env.HANSE_EVENT_HEARTBEAT_MS = previous;
    }
  });

  it("aborts the upstream when the response closes", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream();
    useUpstream(f.deps, upstream.endpoint);
    const controller = new AbortController();
    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
      signal: controller.signal,
    });
    const stream = probe(response);
    await stream.waitFor('"stream.ready"');
    controller.abort();
    await waitUntil(() => upstream.closed());
    expect(upstream.requests).toEqual(["/event"]);
  });

  it("returns 502 when the upstream fails before headers", async () => {
    const f = await fixture();
    const upstream = await fakeEventUpstream(500);
    useUpstream(f.deps, upstream.endpoint);

    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("500");
  });

  it("returns 502 when the runtime fails to start", async () => {
    const f = await fixture();
    f.deps.manager = {
      ensure: async () => {
        throw new Error("did not start");
      },
      policyWarnings: () => [],
    } as unknown as InstanceManager;

    const response = await fetch(`${f.base}/api/apps/storefront/events`, {
      headers: auth(f.token),
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toContain("did not start");
  });
});
