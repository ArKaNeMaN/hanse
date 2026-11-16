import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handleMemory, isMemoryRoute } from "../src/http/memory.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { insertMemorySamples } from "../src/store/memory-samples.js";

const NOW = "2026-11-16T12:00:00.000Z";
const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  humanToken: string;
  agentToken: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-memory-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const when = NOW;
  for (const project of [
    { id: "p", name: "Alpha", root: "/workspace/p" },
    { id: "q", name: "Beta", root: "/workspace/q" },
  ]) {
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?, 'main', ?, ?, ?)",
    ).run(project.id, project.name, project.root, when, when);
  }
  for (const app of [
    { id: "p:web", project: "p", key: "web" },
    { id: "p:other", project: "p", key: "other" },
    { id: "q:web", project: "q", key: "web" },
  ]) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES (?,?,?, 'apps/x', 'app', 'AGENTS.md', ?)",
    ).run(app.id, app.project, app.key, when);
  }
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

function insertSample(
  db: SqliteDatabase,
  appId: string,
  at: string,
  workingSetBytes: number,
  limitBytes = 2_048,
): void {
  insertMemorySamples(
    db,
    [
      {
        appId,
        usageBytes: workingSetBytes + 100,
        workingSetBytes,
        limitBytes,
        anonBytes: null,
        fileBytes: null,
      },
    ],
    at,
  );
}

function insertRunEvent(
  db: SqliteDatabase,
  appId: string,
  seq: number,
  reason: string | null,
  errorCode: string | null,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO agent_run_events
       (app_id, attempt_id, seq, state, phase, source, reason, error_code, message, created_at)
     VALUES (?, 'a1', ?, 'error', 'failed', 'runtime', ?, ?, ?, ?)`,
  ).run(appId, seq, reason, errorCode, reason === "oom_killed" ? "old oom" : null, createdAt);
}

describe("GET /api/apps/:app/memory", () => {
  it("matches only GET requests to the memory path", () => {
    expect(isMemoryRoute("GET", "/api/apps/web/memory")).toBe(true);
    expect(isMemoryRoute("POST", "/api/apps/web/memory")).toBe(false);
    expect(isMemoryRoute("GET", "/api/apps/web/memory/events")).toBe(false);
  });

  it("enforces human-only auth and project/app semantics with no-store", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const f = fixture();
    const pathname = "/api/apps/web/memory";

    expect(handleMemory(f.deps, request(pathname, undefined, cookies())).status).toBe(401);
    expect(handleMemory(f.deps, request(pathname, f.agentToken, cookies())).status).toBe(403);
    expect(handleMemory(f.deps, request(pathname, f.humanToken)).status).toBe(400);
    expect(
      handleMemory(f.deps, request(pathname, f.humanToken, { project: "missing" })).status,
    ).toBe(404);
    expect(
      handleMemory(f.deps, request("/api/apps/missing/memory", f.humanToken, cookies())).status,
    ).toBe(404);
    expect(
      handleMemory(f.deps, request("/api/apps/other/memory", f.humanToken, { project: "q" }))
        .status,
    ).toBe(404);

    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p:web'").run();
    const deleting = handleMemory(f.deps, request(pathname, f.humanToken, cookies()));
    expect(deleting.status).toBe(409);
    expect(body(deleting)).toMatchObject({ code: "deletion_pending" });

    f.db.prepare("UPDATE apps SET deleting = 0 WHERE id = 'p:web'").run();
    const ok = handleMemory(f.deps, request(pathname, f.humanToken, cookies()));
    expect(ok.status).toBe(200);
    expect(ok.headers?.["cache-control"]).toBe("no-store");
    expect(body(ok)).toMatchObject({ appId: "p:web" });
  });

  it("validates window and bucket, rejecting 10m buckets with a 72h window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const f = fixture();
    const pathname = "/api/apps/web/memory";

    for (const query of [
      { window: "1h" },
      { window: "24" },
      { window: "abc" },
      { bucket: "5m" },
      { bucket: "60m" },
      { bucket: "abc" },
      { window: "72h", bucket: "10m" },
    ]) {
      const response = handleMemory(f.deps, request(pathname, f.humanToken, cookies(query)));
      expect(response.status, JSON.stringify(query)).toBe(400);
    }

    const sixHours = handleMemory(
      f.deps,
      request(pathname, f.humanToken, cookies({ window: "6h", bucket: "10m" })),
    );
    expect(sixHours.status).toBe(200);
    expect((body(sixHours).window as { bucketSeconds: number }).bucketSeconds).toBe(600);

    const seventyTwo = handleMemory(
      f.deps,
      request(pathname, f.humanToken, cookies({ window: "72h", bucket: "30m" })),
    );
    expect(seventyTwo.status).toBe(200);
    const window = body(seventyTwo).window as { from: string; to: string; bucketSeconds: number };
    expect(window.bucketSeconds).toBe(1_800);
    expect(Date.parse(window.to) - Date.parse(window.from)).toBeGreaterThanOrEqual(
      72 * 60 * 60 * 1_000,
    );

    const defaults = handleMemory(f.deps, request(pathname, f.humanToken, cookies()));
    const defaultWindow = body(defaults).window as {
      from: string;
      to: string;
      bucketSeconds: number;
    };
    expect(defaultWindow.bucketSeconds).toBe(1_800);
    expect(Date.parse(defaultWindow.to) - Date.parse(defaultWindow.from)).toBeGreaterThanOrEqual(
      24 * 60 * 60 * 1_000,
    );
  });

  it("aligns from down to a bucket boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:17:43.200Z"));
    const f = fixture();
    const response = handleMemory(
      f.deps,
      request("/api/apps/web/memory", f.humanToken, cookies({ window: "6h", bucket: "30m" })),
    );
    const window = body(response).window as { from: string; to: string; bucketSeconds: number };
    expect(window.from).toBe("2026-11-16T06:00:00.000Z");
    expect(window.to).toBe("2026-11-16T12:17:43.200Z");
    expect(Date.parse(window.from) % (window.bucketSeconds * 1_000)).toBe(0);
  });

  it("returns integer buckets grouping two samples and omits gaps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const f = fixture();
    insertSample(f.db, "p:web", "2026-11-16T11:00:00.000Z", 100, 1_000);
    insertSample(f.db, "p:web", "2026-11-16T11:10:00.000Z", 300, 1_000);
    insertSample(f.db, "p:web", "2026-11-16T11:40:00.000Z", 200, 1_000);

    const response = handleMemory(
      f.deps,
      request("/api/apps/web/memory", f.humanToken, cookies({ window: "6h", bucket: "30m" })),
    );
    expect(response.status).toBe(200);
    const buckets = body(response).buckets as Array<Record<string, number | string>>;
    expect(buckets).toEqual([
      {
        start: "2026-11-16T11:00:00.000Z",
        minBytes: 100,
        maxBytes: 300,
        averageBytes: 200,
        samples: 2,
      },
      {
        start: "2026-11-16T11:30:00.000Z",
        minBytes: 200,
        maxBytes: 200,
        averageBytes: 200,
        samples: 1,
      },
    ]);
    for (const bucket of buckets) {
      expect(Number.isInteger(bucket.minBytes)).toBe(true);
      expect(Number.isInteger(bucket.maxBytes)).toBe(true);
      expect(Number.isInteger(bucket.averageBytes)).toBe(true);
    }
  });

  it("returns an empty window as no buckets and null summary fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const f = fixture();
    const response = handleMemory(
      f.deps,
      request("/api/apps/other/memory", f.humanToken, cookies({ window: "6h" })),
    );
    expect(response.status).toBe(200);
    expect(body(response).buckets).toEqual([]);
    expect(body(response).summary).toEqual({
      currentBytes: null,
      minBytes: null,
      peakBytes: null,
      averageBytes: null,
      limitBytes: null,
      samples: 0,
      lastSampleAt: null,
    });
    expect(body(response).events).toEqual([]);
  });

  it("reports in-window current/limit/extrema but a global lastSampleAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const f = fixture();
    insertSample(f.db, "p:web", "2026-11-16T05:00:00.000Z", 50, 900);
    insertSample(f.db, "p:web", "2026-11-16T10:00:00.000Z", 100, 2_000);
    insertSample(f.db, "p:web", "2026-11-16T11:00:00.000Z", 500, 2_000);
    insertSample(f.db, "p:web", "2026-11-16T11:30:00.000Z", 300, 2_000);

    const response = handleMemory(
      f.deps,
      request("/api/apps/web/memory", f.humanToken, cookies({ window: "6h", bucket: "30m" })),
    );
    expect(body(response).summary).toEqual({
      currentBytes: 300,
      minBytes: 100,
      peakBytes: 500,
      averageBytes: 300,
      limitBytes: 2_000,
      samples: 3,
      lastSampleAt: "2026-11-16T11:30:00.000Z",
    });

    // A sample older than the window sets lastSampleAt but never current/limit.
    insertSample(f.db, "p:other", "2026-11-16T05:00:00.000Z", 50, 900);
    const empty = handleMemory(
      f.deps,
      request("/api/apps/other/memory", f.humanToken, cookies({ window: "6h" })),
    );
    expect(body(empty).summary).toEqual({
      currentBytes: null,
      minBytes: null,
      peakBytes: null,
      averageBytes: null,
      limitBytes: null,
      samples: 0,
      lastSampleAt: "2026-11-16T05:00:00.000Z",
    });
  });

  it("returns only in-window OOM events from reason or error_code", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const f = fixture();
    insertRunEvent(f.db, "p:web", 1, "oom_killed", null, "2026-11-16T11:10:00.000Z");
    insertRunEvent(f.db, "p:web", 2, null, "oom_killed", "2026-11-16T11:20:00.000Z");
    insertRunEvent(
      f.db,
      "p:web",
      3,
      "readiness_timeout",
      "readiness_timeout",
      "2026-11-16T11:15:00.000Z",
    );
    insertRunEvent(f.db, "p:web", 4, "oom_killed", null, "2026-11-16T04:00:00.000Z");

    const response = handleMemory(
      f.deps,
      request("/api/apps/web/memory", f.humanToken, cookies({ window: "6h" })),
    );
    expect(body(response).events).toEqual([
      { at: "2026-11-16T11:10:00.000Z", kind: "oom_killed", message: "old oom" },
      { at: "2026-11-16T11:20:00.000Z", kind: "oom_killed", message: null },
    ]);
  });

  it("is dispatched before the /api/apps/ chat catch-all", async () => {
    const f = fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/apps/web/memory?project=p`, {
      headers: { authorization: `Bearer ${f.humanToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ appId: "p:web" });
  });
});
