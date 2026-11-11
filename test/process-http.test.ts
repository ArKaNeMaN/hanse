import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { handleProcess, isProcessRoute } from "../src/http/process.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
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

const now = "2026-11-07T12:00:00.000Z";

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  humanToken: string;
  agentToken: string;
  webEventIds: number[];
}

function insertEvent(
  db: SqliteDatabase,
  appId: string,
  seq: number,
  state: string,
  phase: string,
  createdAt: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO agent_run_events
         (app_id, attempt_id, seq, state, phase, source, reason, error_code, message, created_at)
       VALUES (?, 'a1', ?, ?, ?, 'runtime', 'readiness_timeout', 'readiness_timeout', 'agent did not answer', ?)`,
    )
    .run(appId, seq, state, phase, createdAt);
  return Number(result.lastInsertRowid);
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-process-http-"));
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
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:web','p','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:other','p','other','apps/other','app','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('q:web','q','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    `INSERT INTO instances
       (id, app_id, state, runtime_state, endpoint, updated_at, process_attempt_id, process_phase,
        process_started_at, process_updated_at, process_error_code, process_error_message,
        process_error_at)
     VALUES ('i-p-web', 'p:web', 'error', 'error', NULL, ?, 'a1', 'failed',
             '2026-11-07T10:00:00.000Z', '2026-11-07T10:05:00.000Z', 'readiness_timeout',
             'agent did not answer', '2026-11-07T10:05:00.000Z')`,
  ).run(now);

  const webEventIds = [
    insertEvent(db, "p:web", 1, "starting", "requested", "2026-11-07T10:00:00.000Z"),
    insertEvent(db, "p:web", 2, "starting", "creating", "2026-11-07T10:01:00.000Z"),
    insertEvent(db, "p:web", 3, "starting", "waiting_ready", "2026-11-07T10:02:00.000Z"),
    insertEvent(db, "p:web", 4, "running", "ready", "2026-11-07T10:03:00.000Z"),
    insertEvent(db, "p:web", 5, "error", "failed", "2026-11-07T10:05:00.000Z"),
  ];
  insertEvent(db, "p:other", 1, "starting", "requested", "2026-11-07T10:04:00.000Z");

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
    webEventIds,
  };
}

function request(
  pathname: string,
  token: string | undefined,
  query?: Record<string, string>,
): HttpRequest {
  return {
    method: "GET",
    path: pathname,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(query === undefined ? {} : { query }),
  };
}

function cookies(query: Record<string, string> = {}): Record<string, string> {
  return { project: "p", ...query };
}

function body(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("GET /api/apps/:app/runtime process block", () => {
  it("keeps every existing field and adds the process snapshot", () => {
    const f = fixture();
    const response = handleRequest(
      f.deps,
      request("/api/apps/web/runtime", f.humanToken, cookies()),
    );

    expect(response.status).toBe(200);
    expect(body(response)).toEqual({
      appId: "p:web",
      state: "error",
      endpoint: null,
      specHash: null,
      containerId: null,
      containerName: null,
      imageRef: null,
      startedAt: null,
      updatedAt: now,
      restarting: false,
      process: {
        attemptId: "a1",
        phase: "failed",
        startedAt: "2026-11-07T10:00:00.000Z",
        updatedAt: "2026-11-07T10:05:00.000Z",
        error: {
          code: "readiness_timeout",
          message: "agent did not answer",
          at: "2026-11-07T10:05:00.000Z",
        },
        lastEventId: f.webEventIds[4],
      },
    });
  });

  it("keeps the in-memory restarting flag", () => {
    const f = fixture();
    const manager = {
      isRestarting: () => true,
    } as unknown as HttpDeps["manager"];
    const response = handleRequest(
      { ...f.deps, manager },
      request("/api/apps/web/runtime", f.humanToken, cookies()),
    );

    expect(response.status).toBe(200);
    expect(body(response)).toMatchObject({ state: "error", restarting: true });
  });
});

describe("GET /api/apps/:app/process", () => {
  it("returns current, newest-first events, and a string cursor", () => {
    const f = fixture();
    const response = handleProcess(
      f.deps,
      request("/api/apps/web/process", f.humanToken, cookies()),
    );

    expect(response.status).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    const payload = body(response);
    expect(payload.current).toEqual({
      state: "error",
      phase: "failed",
      attemptId: "a1",
      startedAt: "2026-11-07T10:00:00.000Z",
      updatedAt: "2026-11-07T10:05:00.000Z",
      error: {
        code: "readiness_timeout",
        message: "agent did not answer",
        at: "2026-11-07T10:05:00.000Z",
      },
      lastEventId: f.webEventIds[4],
    });
    const events = payload.events as Array<Record<string, unknown>>;
    expect(events.map((event) => event.id)).toEqual([...f.webEventIds].reverse());
    expect(events.every((event) => event.attemptId === "a1")).toBe(true);
    expect(events[0]).toMatchObject({
      id: f.webEventIds[4],
      seq: 5,
      state: "error",
      phase: "failed",
      source: "runtime",
      reason: "readiness_timeout",
      errorCode: "readiness_timeout",
      message: "agent did not answer",
      createdAt: "2026-11-07T10:05:00.000Z",
    });
    expect(payload.nextCursor).toBe(String(f.webEventIds[0]));
  });

  it("returns system auto-stop and auto-update history entries", () => {
    const f = fixture();
    f.db
      .prepare(
        `INSERT INTO agent_run_events
           (app_id, attempt_id, seq, state, phase, source, reason, error_code, message, created_at)
         VALUES ('p:web', 'a-auto-stop', 1, 'stopped', 'stopped', 'system', 'auto_stop',
                 NULL, NULL, '2026-11-07T10:06:00.000Z')`,
      )
      .run();
    f.db
      .prepare(
        `INSERT INTO agent_run_events
           (app_id, attempt_id, seq, state, phase, source, reason, error_code, message, created_at)
         VALUES ('p:web', 'a-auto-update', 1, 'running', 'ready', 'system', 'auto_update',
                 NULL, NULL, '2026-11-07T10:07:00.000Z')`,
      )
      .run();

    const response = handleProcess(
      f.deps,
      request("/api/apps/web/process", f.humanToken, cookies()),
    );

    expect(response.status).toBe(200);
    const events = body(response).events as Array<Record<string, unknown>>;
    expect(events.find((event) => event.reason === "auto_stop")).toMatchObject({
      source: "system",
      reason: "auto_stop",
      state: "stopped",
      phase: "stopped",
    });
    expect(events.find((event) => event.reason === "auto_update")).toMatchObject({
      source: "system",
      reason: "auto_update",
      state: "running",
      phase: "ready",
    });
  });

  it("reports 401 for no principal and 403 for an agent principal", () => {
    const f = fixture();
    const anonymous = handleProcess(f.deps, request("/api/apps/web/process", undefined, cookies()));
    expect(anonymous.status).toBe(401);

    const agent = handleProcess(f.deps, request("/api/apps/web/process", f.agentToken, cookies()));
    expect(agent.status).toBe(403);
  });

  it("rejects a missing project, unknown project, unknown app, and a cross-project app", () => {
    const f = fixture();
    const missingProject = handleProcess(f.deps, request("/api/apps/web/process", f.humanToken));
    expect(missingProject.status).toBe(400);

    const unknownProject = handleProcess(
      f.deps,
      request("/api/apps/web/process", f.humanToken, { project: "missing" }),
    );
    expect(unknownProject.status).toBe(404);

    const unknownApp = handleProcess(
      f.deps,
      request("/api/apps/missing/process", f.humanToken, cookies()),
    );
    expect(unknownApp.status).toBe(404);

    const crossProject = handleProcess(
      f.deps,
      request("/api/apps/other/process", f.humanToken, { project: "q" }),
    );
    expect(crossProject.status).toBe(404);
  });

  it("returns 409 deletion_pending for a deleting app", () => {
    const f = fixture();
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p:web'").run();
    const response = handleProcess(
      f.deps,
      request("/api/apps/web/process", f.humanToken, cookies()),
    );
    expect(response.status).toBe(409);
    expect(body(response)).toMatchObject({ code: "deletion_pending" });
  });

  it("paginates with limit and before and returns a null cursor at the oldest row", () => {
    const f = fixture();
    const first = handleProcess(
      f.deps,
      request("/api/apps/web/process", f.humanToken, cookies({ limit: "2" })),
    );
    expect(first.status).toBe(200);
    const firstPayload = body(first);
    expect((firstPayload.events as Array<{ id: number }>).map((event) => event.id)).toEqual([
      f.webEventIds[4],
      f.webEventIds[3],
    ]);
    expect(firstPayload.nextCursor).toBe(String(f.webEventIds[3]));

    const second = handleProcess(
      f.deps,
      request(
        "/api/apps/web/process",
        f.humanToken,
        cookies({ limit: "2", before: firstPayload.nextCursor as string }),
      ),
    );
    const secondPayload = body(second);
    expect((secondPayload.events as Array<{ id: number }>).map((event) => event.id)).toEqual([
      f.webEventIds[2],
      f.webEventIds[1],
    ]);

    const oldest = handleProcess(
      f.deps,
      request(
        "/api/apps/web/process",
        f.humanToken,
        cookies({ limit: "2", before: String(f.webEventIds[1]) }),
      ),
    );
    expect(body(oldest).events).toHaveLength(1);
    expect(body(oldest).nextCursor).toBe(String(f.webEventIds[0]));

    const empty = handleProcess(
      f.deps,
      request("/api/apps/web/process", f.humanToken, cookies({ before: String(f.webEventIds[0]) })),
    );
    expect(body(empty).events).toEqual([]);
    expect(body(empty).nextCursor).toBeNull();
  });

  it("rejects invalid limit and before values", () => {
    const f = fixture();
    for (const query of [
      { limit: "0" },
      { limit: "101" },
      { limit: "-1" },
      { limit: "abc" },
      { limit: "1.5" },
      { before: "0" },
      { before: "-1" },
      { before: "abc" },
    ]) {
      const response = handleProcess(
        f.deps,
        request("/api/apps/web/process", f.humanToken, cookies(query)),
      );
      expect(response.status, JSON.stringify(query)).toBe(400);
    }
  });

  it("serves while stopped and never reads the runtime manager", () => {
    const f = fixture();
    f.db
      .prepare(
        `UPDATE instances SET state = 'stopped', runtime_state = 'stopped', process_phase = 'stopped',
           process_error_code = NULL, process_error_message = NULL, process_error_at = NULL
         WHERE app_id = 'p:web'`,
      )
      .run();
    const manager = new Proxy(
      {},
      {
        get: () => {
          throw new Error("runtime manager must not be read");
        },
      },
    ) as unknown as HttpDeps["manager"];
    const response = handleProcess(
      { ...f.deps, manager },
      request("/api/apps/web/process", f.humanToken, cookies()),
    );
    expect(response.status).toBe(200);
    expect(body(response).current).toMatchObject({ state: "stopped", phase: "stopped" });
  });

  it("matches only GET requests to the process path", () => {
    expect(isProcessRoute("GET", "/api/apps/web/process")).toBe(true);
    expect(isProcessRoute("POST", "/api/apps/web/process")).toBe(false);
    expect(isProcessRoute("GET", "/api/apps/web/process/events")).toBe(false);
  });

  it("is dispatched before the /api/apps/ chat catch-all", async () => {
    const f = fixture();
    const server = createHttpServer(f.deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/apps/web/process?project=p`, {
        headers: { authorization: `Bearer ${f.humanToken}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ current: { attemptId: "a1" } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
