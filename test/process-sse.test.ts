import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps } from "../src/http/handler.js";
import { isProcessEventsRoute, processStreams } from "../src/http/process.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { processEvents } from "../src/opencode/process-events.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { type ProcessEvent, readProcessEvents } from "../src/store/process.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

beforeEach(() => {
  processEvents.reset();
  processStreams.resetForTests();
});

afterEach(async () => {
  const closing = servers.splice(0);
  for (const server of closing) {
    server.closeAllConnections?.();
  }
  await Promise.all(
    closing.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  processEvents.reset();
  processStreams.resetForTests();
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

const now = "2026-11-07T12:00:00.000Z";
const WEB_ID = "p:web";
const EMPTY_ID = "p:empty";

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  humanToken: string;
  agentToken: string;
  base: string;
  webEventIds: number[];
}

function insertApp(db: SqliteDatabase, projectId: string, appKey: string, kind = "app"): string {
  const appId = `${projectId}:${appKey}`;
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES (?,?,?,?,?, 'AGENTS.md', ?)",
  ).run(appId, projectId, appKey, `apps/${appKey}`, kind, now);
  return appId;
}

function insertEvent(
  db: SqliteDatabase,
  appId: string,
  seq: number,
  state: string,
  phase: string,
  createdAt = now,
): number {
  const result = db
    .prepare(
      `INSERT INTO agent_run_events
         (app_id, attempt_id, seq, state, phase, source, reason, error_code, message, created_at)
       VALUES (?, 'a1', ?, ?, ?, 'runtime', NULL, NULL, NULL, ?)`,
    )
    .run(appId, seq, state, phase, createdAt);
  return Number(result.lastInsertRowid);
}

function eventOf(id: number, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    id,
    attemptId: "a1",
    seq: 1,
    state: "starting",
    phase: "requested",
    source: "runtime",
    reason: null,
    errorCode: null,
    message: null,
    createdAt: now,
    ...overrides,
  };
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-process-sse-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);

  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Alpha','main','/workspace/p',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('q','Beta','main','/workspace/q',?,?)",
  ).run(now, now);
  insertApp(db, "p", "web");
  insertApp(db, "q", "web");
  insertApp(db, "p", "other");
  insertApp(db, "p", "empty");
  insertApp(db, "p", "deleting");
  db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p:deleting'").run();

  db.prepare(
    `INSERT INTO instances
       (id, app_id, state, runtime_state, endpoint, updated_at, process_attempt_id, process_phase,
        process_started_at, process_updated_at)
     VALUES ('i-p-web', 'p:web', 'stopped', 'stopped', NULL, ?, 'a1', 'stopped',
             '2026-11-07T10:00:00.000Z', '2026-11-07T10:05:00.000Z')`,
  ).run(now);

  const webEventIds = [
    insertEvent(db, WEB_ID, 1, "starting", "requested", "2026-11-07T10:00:00.000Z"),
    insertEvent(db, WEB_ID, 2, "running", "ready", "2026-11-07T10:03:00.000Z"),
    insertEvent(db, WEB_ID, 3, "stopped", "stopped", "2026-11-07T10:05:00.000Z"),
  ];
  insertEvent(db, "p:other", 1, "starting", "requested", "2026-11-07T10:01:00.000Z");

  const projects = [
    { id: "p", name: "Alpha", rootPath: "/workspace/p", workspaceRoot: "/workspace" },
    { id: "q", name: "Beta", rootPath: "/workspace/q", workspaceRoot: "/workspace" },
  ];
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/workspace",
    git: new GitService({ workspaceRoot: "/workspace" }),
    getProjects: () =>
      projects.map((project) => ({
        ...project,
        service: new CoordinatorService(db, project.id),
      })),
  };
  return {
    db,
    deps,
    humanToken: createPrincipal(db, { kind: "human", name: "alice" }).token,
    agentToken: createPrincipal(db, { kind: "agent", name: "bot" }).token,
    base: "",
    webEventIds,
  };
}

async function listen(f: Fixture, deps: HttpDeps = f.deps): Promise<string> {
  const server = createHttpServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function databaseWithSnapshotHook(db: SqliteDatabase, hook: () => void): SqliteDatabase {
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          if (!fired && sql.includes("MAX(e.id)")) {
            fired = true;
            hook();
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
          timer = setTimeout(() => reject(new Error("timed out reading stream")), remaining);
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

function frames(buffer: string): Array<Record<string, unknown>> {
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
        return [JSON.parse(data) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function frameOfType(buffer: string, type: string): Record<string, unknown> | undefined {
  return frames(buffer).find((event) => event.type === type);
}

function transitionIds(buffer: string): number[] {
  return frames(buffer)
    .filter((event) => event.type === "process.transition")
    .map((event) => (event.event as { id: number }).id);
}

async function fakeEventUpstream(): Promise<{ endpoint: string }> {
  let respond: ServerResponse | undefined;
  const server = createServer((incoming, outgoing) => {
    if (incoming.url !== "/event") {
      outgoing.writeHead(404, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "not found" }));
      return;
    }
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.flushHeaders();
    respond = outgoing;
    incoming.on("close", () => respond?.end());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}` };
}

describe("process event stream", () => {
  it("streams a stopped app's ready, snapshot, and live transition without a manager", async () => {
    const f = fixture();
    f.base = await listen(f, { ...f.deps, manager: undefined });

    const response = await fetch(`${f.base}/api/apps/empty/process/events?project=p`, {
      headers: auth(f.humanToken),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const stream = probe(response);
    try {
      await stream.waitFor('"type":"process.snapshot"');
      const ready = frameOfType(stream.text(), "stream.ready");
      const snapshot = frameOfType(stream.text(), "process.snapshot");
      expect(ready?.seq).toBe(0);
      expect(typeof ready?.streamID).toBe("string");
      expect(snapshot?.seq).toBe(1);
      expect(snapshot?.lastEventId).toBe(0);
      expect(snapshot?.current).toMatchObject({ state: "stopped", phase: null });

      const id = insertEvent(f.db, EMPTY_ID, 1, "starting", "requested");
      processEvents.emit(EMPTY_ID, eventOf(id, { state: "starting", phase: "requested" }));

      await stream.waitFor('"type":"process.transition"');
      const transition = frameOfType(stream.text(), "process.transition");
      expect(transition?.seq).toBe(2);
      if (transition === undefined) throw new Error("missing process transition");
      expect((transition.event as { id: number }).id).toBe(id);
    } finally {
      await stream.close();
    }
  });

  it("drops a transition emitted between subscribe and the snapshot read", async () => {
    const f = fixture();
    const duplicate = readProcessEvents(f.db, WEB_ID).events[0];
    if (duplicate === undefined) throw new Error("fixture has no events");
    let emitted = false;
    const deps: HttpDeps = {
      ...f.deps,
      db: databaseWithSnapshotHook(f.db, () => {
        emitted = true;
        processEvents.emit(WEB_ID, duplicate);
      }),
    };
    f.base = await listen(f, deps);

    const response = await fetch(`${f.base}/api/apps/web/process/events?project=p`, {
      headers: auth(f.humanToken),
    });
    const stream = probe(response);
    try {
      await stream.waitFor('"type":"process.snapshot"');
      expect(emitted).toBe(true);
      const liveId = f.webEventIds[2] + 10;
      processEvents.emit(WEB_ID, eventOf(liveId, { state: "starting", phase: "waiting_ready" }));
      await stream.waitFor('"type":"process.transition"');
      expect(transitionIds(stream.text())).toEqual([liveId]);
    } finally {
      await stream.close();
    }
  });

  it("accepts non-contiguous global ids and drops duplicate/out-of-order ids without warnings", async () => {
    const f = fixture();
    f.base = await listen(f);

    const response = await fetch(`${f.base}/api/apps/web/process/events?project=p`, {
      headers: auth(f.humanToken),
    });
    const stream = probe(response);
    try {
      await stream.waitFor('"type":"process.snapshot"');
      processEvents.emit(WEB_ID, eventOf(20, { state: "running", phase: "ready" }));
      processEvents.emit(WEB_ID, eventOf(15, { state: "starting", phase: "creating" }));
      processEvents.emit(WEB_ID, eventOf(20, { state: "running", phase: "ready" }));
      processEvents.emit(WEB_ID, eventOf(40, { state: "error", phase: "failed" }));
      await stream.waitFor('"id":40');
      expect(transitionIds(stream.text())).toEqual([20, 40]);
      expect(frameOfType(stream.text(), "stream.warning")).toBeUndefined();
    } finally {
      await stream.close();
    }
  });

  it("emits process_buffer_overflow when the pre-snapshot buffer exceeds 256", async () => {
    const f = fixture();
    const deps: HttpDeps = {
      ...f.deps,
      db: databaseWithSnapshotHook(f.db, () => {
        for (let index = 0; index < 300; index += 1) {
          processEvents.emit(WEB_ID, eventOf(100 + index));
        }
      }),
    };
    f.base = await listen(f, deps);

    const response = await fetch(`${f.base}/api/apps/web/process/events?project=p`, {
      headers: auth(f.humanToken),
    });
    const stream = probe(response);
    try {
      await stream.waitFor('"code":"process_buffer_overflow"');
      const warning = frameOfType(stream.text(), "stream.warning");
      expect(warning).toMatchObject({ type: "stream.warning", code: "process_buffer_overflow" });
      processEvents.emit(WEB_ID, eventOf(500, { state: "running", phase: "ready" }));
      await stream.waitFor('"id":500');
      expect(transitionIds(stream.text())).toEqual([500]);
    } finally {
      await stream.close();
    }
  });

  it("limits the fifth process stream with 429 while app-chat streams stay available", async () => {
    const f = fixture();
    const upstream = await fakeEventUpstream();
    f.deps.manager = {
      ensure: async () => upstream.endpoint,
      endpointFor: () => upstream.endpoint,
      policyWarnings: () => [],
    } as unknown as InstanceManager;
    f.base = await listen(f);

    const open: Probe[] = [];
    try {
      for (let index = 0; index < 4; index += 1) {
        const response = await fetch(`${f.base}/api/apps/web/process/events?project=p`, {
          headers: auth(f.humanToken),
        });
        expect(response.status).toBe(200);
        const stream = probe(response);
        await stream.waitFor('"type":"stream.ready"');
        open.push(stream);
      }
      const limited = await fetch(`${f.base}/api/apps/web/process/events?project=p`, {
        headers: auth(f.humanToken),
      });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: "stream_limit" });

      const chat = await fetch(`${f.base}/api/apps/web/events?project=p`, {
        headers: auth(f.humanToken),
      });
      expect(chat.status).toBe(200);
      const chatStream = probe(chat);
      try {
        await chatStream.waitFor('"type":"stream.ready"');
      } finally {
        await chatStream.close();
      }
    } finally {
      await Promise.all(open.map((stream) => stream.close()));
    }
  });

  it("rejects missing auth, agent principals, a missing project, unknown apps, and deletion", async () => {
    const f = fixture();
    f.base = await listen(f);
    const path = `${f.base}/api/apps/web/process/events`;

    const anonymous = await fetch(`${path}?project=p`);
    expect(anonymous.status).toBe(401);

    const agent = await fetch(`${path}?project=p`, { headers: auth(f.agentToken) });
    expect(agent.status).toBe(403);

    const missingProject = await fetch(path, { headers: auth(f.humanToken) });
    expect(missingProject.status).toBe(400);

    const unknownProject = await fetch(`${path}?project=missing`, {
      headers: auth(f.humanToken),
    });
    expect(unknownProject.status).toBe(404);

    const unknownApp = await fetch(`${f.base}/api/apps/nope/process/events?project=p`, {
      headers: auth(f.humanToken),
    });
    expect(unknownApp.status).toBe(404);

    const crossProject = await fetch(`${f.base}/api/apps/empty/process/events?project=q`, {
      headers: auth(f.humanToken),
    });
    expect(crossProject.status).toBe(404);

    const deleting = await fetch(`${f.base}/api/apps/deleting/process/events?project=p`, {
      headers: auth(f.humanToken),
    });
    expect(deleting.status).toBe(409);
    expect(await deleting.json()).toMatchObject({ code: "deletion_pending" });
  });

  it("matches only GET requests to the process events path", () => {
    expect(isProcessEventsRoute("GET", "/api/apps/web/process/events")).toBe(true);
    expect(isProcessEventsRoute("POST", "/api/apps/web/process/events")).toBe(false);
    expect(isProcessEventsRoute("GET", "/api/apps/web/process")).toBe(false);
  });
});
