import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentLock } from "../src/coordinator/deployment-lock.js";
import { getHandoff, type HandoffState } from "../src/coordinator/handoff.js";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { isStartRoute } from "../src/http/chat.js";
import { type HttpDeps, handleRequest, provisioningDeps } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { safeLocalPath } from "../src/http/ui.js";
import { createPrincipal } from "../src/identity/principals.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed by an individual test
    }
  }
  databases.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  service: CoordinatorService;
  handoffId: string;
  workspace: string;
  projectRoot: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-http-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  const projectRoot = path.join(workspace, "p");
  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  writeFileSync(
    path.join(projectRoot, ".hanse", "project.yaml"),
    "id: p\nname: P\nbase_branch: main\napps: []\n",
    "utf8",
  );
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:b','p','b','apps/b','AGENTS.md',?)",
  ).run(now);
  const service = new CoordinatorService(db, "p");
  const { handoffId } = service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "need X",
    spec: "do X",
    requiresApproval: true,
  });
  return { db, service, handoffId, workspace, projectRoot };
}

function deps(f: Fixture): HttpDeps {
  return {
    db: f.db,
    workspaceRoot: f.workspace,
    git: new GitService({ workspaceRoot: f.workspace }),
    getProjects: () => {
      const row = f.db
        .prepare("SELECT name, root_path, deleting FROM projects WHERE id = 'p'")
        .get() as { name: string; root_path: string; deleting: number } | undefined;
      return [
        {
          id: "p",
          name: row?.name ?? "P",
          rootPath: row?.root_path ?? f.projectRoot,
          workspaceRoot: f.workspace,
          deleting: row?.deleting === 1,
          service: f.service,
        },
      ];
    },
  };
}

function humanToken(db: SqliteDatabase): string {
  return createPrincipal(db, { kind: "human", name: "alice" }).token;
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function _seedStates(db: SqliteDatabase): void {
  const states: HandoffState[] = [
    "queued",
    "dispatching",
    "in_progress",
    "delivered",
    "rejected",
    "failed",
    "expired",
    "cancelled",
  ];
  const insert = db.prepare(
    `INSERT INTO handoffs
      (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key, attempts, result, error, created_at, updated_at)
     VALUES (?, 'p', 'p:a', 'p:b', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  states.forEach((state, index) => {
    const stamp = new Date(Date.now() - index * 60_000).toISOString();
    insert.run(
      `extra-${state}`,
      state,
      `Summary ${state}`,
      `Spec for ${state}`,
      `key-${state}`,
      state === "delivered" ? "Delivered result" : null,
      state === "failed" ? "Target repository unavailable." : null,
      stamp,
      stamp,
    );
  });
}

describe("http auth and login", () => {
  it("redirects an unauthenticated HTML page to login with next", () => {
    const f = fixture();
    const response = handleRequest(deps(f), { method: "GET", path: "/projects", headers: {} });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login?next=%2Fprojects");
  });

  it("redirects an agent principal away from HTML pages", () => {
    const f = fixture();
    const { token } = createPrincipal(f.db, { kind: "agent", name: "web" });
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/",
      headers: auth(token),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login?next=%2F");
  });

  it("rejects the removed form login with 405", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/login",
      headers: { accept: "text/html" },
      body: form({ token: humanToken(f.db), next: "/" }),
    });
    expect(response.status).toBe(405);
    expect(response.headers?.allow).toBe("GET, HEAD");
    expect(response.body).toContain("Sign-in changed");
    expect(response.headers?.["set-cookie"]).toBeUndefined();
  });

  it("clears the cookie on logout", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/logout",
      headers: {},
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login");
    expect(response.headers?.["set-cookie"]).toContain("Max-Age=0");
  });

  it("logs in the SPA with JSON and sets the session cookie", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/session",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, next: "/handoffs?filter=waiting" }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, next: "/handoffs?filter=waiting" });
    const setCookie = response.headers?.["set-cookie"] ?? "";
    expect(setCookie).toContain("hanse_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000");
  });

  it("rejects an invalid SPA login without setting a cookie", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/session",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong", next: "/" }),
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ code: "invalid_token" });
    expect(response.headers?.["set-cookie"]).toBeUndefined();
  });

  it("rejects a non-human principal on the SPA login", () => {
    const f = fixture();
    const { token } = createPrincipal(f.db, { kind: "agent", name: "web" });
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/session",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, next: "/" }),
    });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ code: "not_human" });
    expect(response.headers?.["set-cookie"]).toBeUndefined();
  });

  it("blocks open redirects and cross-origin SPA logins", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const open = handleRequest(deps(f), {
      method: "POST",
      path: "/api/session",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, next: "https://evil.example" }),
    });
    expect(JSON.parse(open.body)).toMatchObject({ next: "/" });

    const crossOrigin = handleRequest(deps(f), {
      method: "POST",
      path: "/api/session",
      headers: { "content-type": "application/json", host: "hanse.local" },
      origin: "https://evil.example",
      body: JSON.stringify({ token, next: "/" }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers?.["set-cookie"]).toBeUndefined();
  });
});

describe("http decisions and form mutations", () => {
  it("decides an approval through the shared decision endpoint", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: auth(token, { accept: "text/html" }),
      body: form({
        decision: "approved",
        reason: "looks good",
        return_to: "/handoffs?filter=waiting",
      }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("/handoffs?filter=waiting");
    expect(response.headers?.location).toContain("tone=success");
    expect(getHandoff(f.db, f.handoffId)?.state).toBe("dispatching");
    const approval = f.db
      .prepare("SELECT reason FROM approvals WHERE handoff_id = ?")
      .get(f.handoffId) as { reason: string };
    expect(approval.reason).toBe("looks good");
  });

  it("rejects a decision with no pending approval", () => {
    const f = fixture();
    const token = humanToken(f.db);
    handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: auth(token),
      body: form({ decision: "approved" }),
    });
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: auth(token),
      body: form({ decision: "approved" }),
    });
    expect(response.status).toBe(409);
  });

  it("keeps the legacy approve endpoint working with a reason", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/approve`,
      headers: auth(token, { accept: "text/html" }),
      body: form({ reason: "legacy ok", return_to: "/" }),
    });
    expect(response.status).toBe(303);
    expect(getHandoff(f.db, f.handoffId)?.state).toBe("dispatching");
    const approval = f.db
      .prepare("SELECT reason FROM approvals WHERE handoff_id = ?")
      .get(f.handoffId) as { reason: string };
    expect(approval.reason).toBe("legacy ok");
  });

  it("redirects a browser form mutation to its return path with a notice", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/handoffs",
      headers: auth(token, { accept: "text/html" }),
      body: form({
        project: "p",
        from: "a",
        to: "b",
        summary: "new route",
        spec: "spec",
        return_to: "/projects/p",
      }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("/projects/p");
    expect(response.headers?.location).toContain("notice=Handoff+created.");
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number }).c).toBe(2);
  });

  it("shows a validation notice instead of JSON for an empty browser handoff", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/handoffs",
      headers: auth(token, { accept: "text/html" }),
      body: form({ project: "p", from: "a", to: "b", summary: "", return_to: "/projects/p" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("tone=error");
    expect(response.headers?.location).toContain("Summary+is+required");
  });

  it("creates a project through the browser form and redirects to it", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/projects",
      headers: auth(token, { accept: "text/html" }),
      body: form({ name: "New Project" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toMatch(/^\/projects\/[^?]+\?notice=Project\+created/);
    const row = f.db.prepare("SELECT name FROM projects WHERE name = 'New Project'").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("New Project");
  });

  it("adds an application through the browser form", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/projects/p/apps",
      headers: auth(token, { accept: "text/html" }),
      body: form({ name: "c", path: "apps/c", return_to: "/projects/p" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("Application+added.");
    const row = f.db
      .prepare("SELECT app_key FROM apps WHERE project_id = 'p' AND app_key = 'c'")
      .get() as { app_key: string } | undefined;
    expect(row?.app_key).toBe("c");
  });

  it("rejects an application path that escapes the project", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/projects/p/apps",
      headers: auth(token),
      body: form({ name: "evil", path: "../../evil" }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_APP_PATH" });
    const row = f.db
      .prepare("SELECT app_key FROM apps WHERE project_id = 'p' AND app_key = 'evil'")
      .get() as { app_key: string } | undefined;
    expect(row).toBeUndefined();
  });

  it("redirects an unauthenticated browser decision to login", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: { accept: "text/html" },
      body: form({ decision: "approved", return_to: "/handoffs" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login?next=%2Fhandoffs");
  });
});

describe("http API and assets", () => {
  it("lists projects as JSON", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/api/projects",
      headers: {},
    });
    const projects = (JSON.parse(response.body) as { projects: { apps: unknown[] }[] }).projects;
    expect(projects[0]?.apps).toHaveLength(2);
  });

  it("projects only allowlisted handoff fields on public JSON routes", () => {
    const f = fixture();
    const expected = [
      "createdAt",
      "fromAppKey",
      "id",
      "lastMessageAt",
      "messageCount",
      "mode",
      "state",
      "summary",
      "threadIdleExpiresAt",
      "toAppKey",
      "updatedAt",
    ].sort();
    const forbidden = [
      "spec",
      "result",
      "operatorNote",
      "error",
      "sourceSessionId",
      "targetSessionId",
    ];

    const projects = handleRequest(deps(f), { method: "GET", path: "/api/projects", headers: {} });
    expect(projects.status).toBe(200);
    const projectHandoffs = (
      JSON.parse(projects.body) as {
        projects: { handoffs: Record<string, unknown>[] }[];
      }
    ).projects[0]?.handoffs;
    expect(projectHandoffs).toHaveLength(1);
    expect(Object.keys(projectHandoffs?.[0] ?? {}).sort()).toEqual(expected);
    for (const key of forbidden) {
      expect(projectHandoffs?.[0]).not.toHaveProperty(key);
    }

    const anonymous = handleRequest(deps(f), {
      method: "GET",
      path: "/api/handoffs",
      headers: {},
    });
    expect(anonymous.status).toBe(401);
    const agentToken = createPrincipal(f.db, { kind: "agent", name: "web" }).token;
    const agent = handleRequest(deps(f), {
      method: "GET",
      path: "/api/handoffs",
      headers: auth(agentToken),
    });
    expect(agent.status).toBe(403);
    const human = handleRequest(deps(f), {
      method: "GET",
      path: "/api/handoffs",
      headers: auth(humanToken(f.db)),
    });
    expect(human.status).toBe(200);
    const handoffs = (JSON.parse(human.body) as { handoffs: Record<string, unknown>[] }).handoffs;
    expect(handoffs).toHaveLength(1);
    expect(Object.keys(handoffs[0] ?? {}).sort()).toEqual(expected);
    for (const key of forbidden) {
      expect(handoffs[0]).not.toHaveProperty(key);
    }
  });

  it("rejects an unauthenticated mutation with 401", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/approve`,
      headers: {},
    });
    expect(response.status).toBe(401);
  });

  it("forbids an agent principal with 403", () => {
    const f = fixture();
    const { token } = createPrincipal(f.db, { kind: "agent", name: "web" });
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/approve`,
      headers: auth(token),
    });
    expect(response.status).toBe(403);
  });

  it("creates a handoff through the API as a human", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/handoffs",
      headers: auth(token, { "content-type": "application/x-www-form-urlencoded" }),
      body: form({ project: "p", from: "a", to: "b", summary: "s", spec: "x" }),
    });
    expect(response.status).toBe(303);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number }).c).toBe(2);
  });

  it("serves runtime status with a normalized legacy state and image ref", () => {
    const f = fixture();
    const token = humanToken(f.db);
    f.db
      .prepare(
        "INSERT INTO instances (id, app_id, endpoint, state, runtime_state, image_ref, updated_at) VALUES ('p:a','p:a','http://127.0.0.1:4100','failed','failed','sha256:app-image',?)",
      )
      .run(new Date().toISOString());

    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/api/apps/a/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      appId: "p:a",
      state: "error",
      endpoint: "http://127.0.0.1:4100",
      imageRef: "sha256:app-image",
    });

    const absent = handleRequest(deps(f), {
      method: "GET",
      path: "/api/apps/b/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(absent.status).toBe(200);
    expect(JSON.parse(absent.body)).toMatchObject({ state: "stopped", imageRef: null });
  });

  it("reports an in-memory restart claim on the runtime route without mutating state", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const d = deps(f);
    d.manager = {
      isRestarting: (appId: string) => appId === "p:a",
    } as unknown as NonNullable<HttpDeps["manager"]>;

    const running = handleRequest(d, {
      method: "GET",
      path: "/api/apps/a/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(running.status).toBe(200);
    expect(JSON.parse(running.body)).toMatchObject({ appId: "p:a", restarting: true });

    const idle = handleRequest(d, {
      method: "GET",
      path: "/api/apps/b/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(idle.status).toBe(200);
    expect(JSON.parse(idle.body)).toMatchObject({ appId: "p:b", restarting: false });
  });

  it("serves the readiness contract without auth and without mutating state", () => {
    const f = fixture();
    const d = deps(f);
    d.deploymentLock = new DeploymentLock(path.join(f.workspace, "deploy.lock"));
    d.lifecycleActivity = new LifecycleActivity();
    const previousRevision = process.env.HANSE_REVISION;
    delete process.env.HANSE_REVISION;
    try {
      const before = f.db.prepare("SELECT COUNT(*) AS count FROM instances").get() as {
        count: number;
      };
      const response = handleRequest(d, { method: "GET", path: "/readyz", headers: {} });
      expect(response.status).toBe(200);
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(JSON.parse(response.body)).toMatchObject({
        status: "ok",
        version: expect.any(String),
        revision: "unknown",
        schemaVersion: 25,
        deploying: false,
        inFlightLifecycle: 0,
        draining: false,
        dbReady: true,
        migrationPending: false,
        inFlightHttp: 0,
        startedAt: expect.any(String),
        shutdownAt: null,
        uptime: expect.any(Number),
      });
      const after = f.db.prepare("SELECT COUNT(*) AS count FROM instances").get() as {
        count: number;
      };
      expect(after).toEqual(before);
    } finally {
      if (previousRevision === undefined) delete process.env.HANSE_REVISION;
      else process.env.HANSE_REVISION = previousRevision;
    }
  });

  it("reports the revision, an active lock, and in-flight lifecycle work", () => {
    const f = fixture();
    const d = deps(f);
    const lockFile = path.join(f.workspace, "deploy.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        version: 1,
        id: "lock-1",
        phase: "switching",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8",
    );
    d.deploymentLock = new DeploymentLock(lockFile);
    d.lifecycleActivity = new LifecycleActivity();
    const end = d.lifecycleActivity.begin("ensure");
    const previousRevision = process.env.HANSE_REVISION;
    process.env.HANSE_REVISION = "abc123";
    try {
      const response = handleRequest(d, { method: "GET", path: "/readyz", headers: {} });
      expect(JSON.parse(response.body)).toMatchObject({
        status: "ok",
        revision: "abc123",
        deploying: true,
        inFlightLifecycle: 1,
      });
      end();
      const after = handleRequest(d, { method: "GET", path: "/readyz", headers: {} });
      expect(JSON.parse(after.body)).toMatchObject({ inFlightLifecycle: 0 });
    } finally {
      if (previousRevision === undefined) delete process.env.HANSE_REVISION;
      else process.env.HANSE_REVISION = previousRevision;
    }
  });

  it("treats an empty revision as unknown", () => {
    const f = fixture();
    const previousRevision = process.env.HANSE_REVISION;
    process.env.HANSE_REVISION = "";
    try {
      const response = handleRequest(deps(f), { method: "GET", path: "/readyz", headers: {} });
      expect(JSON.parse(response.body)).toMatchObject({ revision: "unknown" });
    } finally {
      if (previousRevision === undefined) delete process.env.HANSE_REVISION;
      else process.env.HANSE_REVISION = previousRevision;
    }
  });

  it("returns 503 when the readiness schema query fails", () => {
    const f = fixture();
    f.db.exec("DROP TABLE schema_migrations");
    const response = handleRequest(deps(f), { method: "GET", path: "/readyz", headers: {} });
    expect(response.status).toBe(503);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toMatchObject({
      status: "error",
      error: "database_unavailable",
      dbReady: false,
    });
  });

  it("supports the two-poll quiescence handshake", () => {
    const f = fixture();
    const d = deps(f);
    const lockFile = path.join(f.workspace, "deploy.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        version: 1,
        id: "lock-1",
        phase: "switching",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8",
    );
    d.deploymentLock = new DeploymentLock(lockFile);
    d.lifecycleActivity = new LifecycleActivity();
    const end = d.lifecycleActivity.begin("delete_app");

    const first = JSON.parse(
      handleRequest(d, { method: "GET", path: "/readyz", headers: {} }).body,
    ) as { deploying: boolean; inFlightLifecycle: number };
    expect(first).toMatchObject({ deploying: true, inFlightLifecycle: 1 });

    end();
    const second = JSON.parse(
      handleRequest(d, { method: "GET", path: "/readyz", headers: {} }).body,
    ) as { deploying: boolean; inFlightLifecycle: number };
    const third = JSON.parse(
      handleRequest(d, { method: "GET", path: "/readyz", headers: {} }).body,
    ) as { deploying: boolean; inFlightLifecycle: number };
    expect(second).toMatchObject({ deploying: true, inFlightLifecycle: 0 });
    expect(third).toMatchObject({ deploying: true, inFlightLifecycle: 0 });
  });

  it("serves an unauthenticated health check", () => {
    const f = fixture();
    const response = handleRequest(deps(f), { method: "GET", path: "/healthz", headers: {} });
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("serves the allowlisted assets without auth", () => {
    const f = fixture();
    for (const removed of ["/assets/app.js", "/assets/app-content.js"]) {
      const response = handleRequest(deps(f), {
        method: "GET",
        path: removed,
        headers: {},
      });
      expect(response.status, removed).toBe(404);
    }

    const favicon = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/favicon.svg",
      headers: {},
    });
    expect(favicon.status).toBe(200);
    expect(favicon.contentType).toBe("image/svg+xml");

    const markdownJs = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/markdown.js",
      headers: {},
    });
    expect(markdownJs.status).toBe(200);
    expect(markdownJs.contentType).toContain("text/javascript");
    expect(markdownJs.body).toContain("renderMarkdown");

    const removedSkillsJs = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/skills.js",
      headers: {},
    });
    expect(removedSkillsJs.status).toBe(404);

    const missing = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/missing.js",
      headers: {},
    });
    expect(missing.status).toBe(404);
  });

  it("serves built SPA assets with immutable caching and rejects traversal", () => {
    const f = fixture();
    const assets = mkdtempSync(path.join(tmpdir(), "hanse-ui-assets-"));
    dirs.push(assets);
    mkdirSync(path.join(assets, "ui", "nested"), { recursive: true });
    writeFileSync(path.join(assets, "ui", "main-test.js"), "export const x = 1;\n", "utf8");
    writeFileSync(path.join(assets, "ui", "app-test.css"), ".x{color:red}\n", "utf8");

    const previous = process.env.HANSE_ASSETS;
    process.env.HANSE_ASSETS = assets;
    try {
      const script = handleRequest(deps(f), {
        method: "GET",
        path: "/assets/ui/main-test.js",
        headers: {},
      });
      expect(script.status).toBe(200);
      expect(script.contentType).toContain("text/javascript");
      expect(script.headers?.["cache-control"]).toContain("immutable");
      expect(script.body).toContain("export const x");

      const style = handleRequest(deps(f), {
        method: "GET",
        path: "/assets/ui/app-test.css",
        headers: {},
      });
      expect(style.status).toBe(200);
      expect(style.contentType).toContain("text/css");

      const missing = handleRequest(deps(f), {
        method: "GET",
        path: "/assets/ui/missing.js",
        headers: {},
      });
      expect(missing.status).toBe(404);

      const traversal = handleRequest(deps(f), {
        method: "GET",
        path: "/assets/ui/../../../etc/passwd",
        headers: {},
      });
      expect(traversal.status).toBe(404);
    } finally {
      if (previous === undefined) {
        delete process.env.HANSE_ASSETS;
      } else {
        process.env.HANSE_ASSETS = previous;
      }
    }
  });

  it("serves the diff and highlight assets and rejects unknown worker paths", () => {
    const f = fixture();
    const paths = [
      "/assets/chat-diff.js",
      "/assets/chat-highlight.js",
      "/assets/chat-highlight-worker.js",
    ];
    for (const assetPath of paths) {
      const response = handleRequest(deps(f), {
        method: "GET",
        path: assetPath,
        headers: {},
      });
      expect(response.status).toBe(200);
      expect(response.contentType).toBe("text/javascript; charset=utf-8");
      expect(response.body.length).toBeGreaterThan(0);
    }

    const missing = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/chat-highlight-missing.js",
      headers: {},
    });
    expect(missing.status).toBe(404);
  });

  it("serves the vendored Prism bundle and rejects unknown vendor paths", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/vendor/prism/prism-1.30.0.min.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/javascript; charset=utf-8");
    expect(response.body).toContain("export default Prism;");

    const missing = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/vendor/prism/prism-9.9.9.min.js",
      headers: {},
    });
    expect(missing.status).toBe(404);
  });

  it("serves the vendored xterm assets and rejects unknown xterm paths", () => {
    const f = fixture();
    const assets = [
      {
        path: "/assets/vendor/xterm/xterm-6.0.0.css",
        contentType: "text/css; charset=utf-8",
        marker: ".xterm",
      },
      {
        path: "/assets/vendor/xterm/xterm-6.0.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "Terminal",
      },
      {
        path: "/assets/vendor/xterm/addon-fit-0.11.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "FitAddon",
      },
      {
        path: "/assets/vendor/xterm/addon-unicode11-0.9.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "Unicode11Addon",
      },
      {
        path: "/assets/vendor/xterm/addon-unicode-graphemes-0.4.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "UnicodeGraphemesAddon",
      },
    ];
    for (const asset of assets) {
      const response = handleRequest(deps(f), {
        method: "GET",
        path: asset.path,
        headers: {},
      });
      expect(response.status).toBe(200);
      expect(response.contentType).toBe(asset.contentType);
      expect(response.body).toContain(asset.marker);
    }

    for (const assetPath of [
      "/assets/vendor/xterm/xterm-9.9.9.js",
      "/assets/vendor/xterm/addon-fit-9.9.9.js",
      "/assets/vendor/xterm/addon-unicode11-9.9.9.js",
      "/assets/vendor/xterm/addon-unicode-graphemes-9.9.9.js",
      "/assets/vendor/xterm/unknown.css",
    ]) {
      const missing = handleRequest(deps(f), {
        method: "GET",
        path: assetPath,
        headers: {},
      });
      expect(missing.status).toBe(404);
    }
  });

  it("dispatches settings routes before the chat fallback", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const settings = new SettingsService({ db: f.db, secretKey: randomBytes(32) });
    const server = createHttpServer({ ...deps(f), settings });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const api = await fetch(`http://127.0.0.1:${port}/api/settings?scope=global`, {
        headers: auth(token),
      });
      expect(api.status).toBe(200);
      expect(api.headers.get("cache-control")).toBe("no-store");
      const payload = (await api.json()) as {
        effective: { llm: { model: { value: string } } };
        pendingRestart: unknown[];
      };
      expect(payload.effective.llm.model.value).toBe("deepseek/deepseek-flash");
      expect(payload.pendingRestart).toEqual([]);

      const restart = await fetch(`http://127.0.0.1:${port}/api/apps/a/restart?project=p`, {
        method: "POST",
        headers: auth(token),
      });
      expect(restart.status).toBe(503);

      const unknown = await fetch(`http://127.0.0.1:${port}/settings/nope`, {
        headers: auth(token),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("dispatches the start route explicitly before the chat fallback", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    expect(isStartRoute("POST", "/api/apps/a/start")).toBe(true);
    expect(isStartRoute("GET", "/api/apps/a/start")).toBe(false);

    const calls: string[] = [];
    const depsWithManager = {
      ...deps(f),
      manager: {
        ensure: async (app: { id: string }) => {
          calls.push(app.id);
          return "http://127.0.0.1:1";
        },
      } as unknown as HttpDeps["manager"],
    };
    const server = createHttpServer(depsWithManager);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const start = await fetch(`http://127.0.0.1:${port}/api/apps/a/start?project=p`, {
        method: "POST",
        headers: auth(token),
      });
      expect(start.status).toBe(200);
      expect(await start.json()).toEqual({ appId: "p:a", state: "running" });
      expect(calls).toEqual(["p:a"]);

      const restart = await fetch(`http://127.0.0.1:${port}/api/apps/a/restart?project=p`, {
        method: "POST",
        headers: auth(token),
      });
      expect(restart.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns a styled 404 for an unknown HTML route", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/nope",
      headers: { ...auth(token), accept: "text/html" },
    });
    expect(response.status).toBe(404);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("Page not found");
  });
});

describe("provisioning deps", () => {
  it("wires the project git auth resolver when settings are present", () => {
    const f = fixture();
    const plain = provisioningDeps(deps(f));
    expect(plain.resolveGitAuth).toBeUndefined();

    const settings = new SettingsService({ db: f.db, secretKey: randomBytes(32) });
    const spy = vi.spyOn(settings, "projectGitAuth");
    const wired = provisioningDeps({ ...deps(f), settings });
    expect(wired.resolveGitAuth).toBeDefined();
    wired.resolveGitAuth?.("p");
    expect(spy).toHaveBeenCalledWith("p");
  });
});

describe("safeLocalPath", () => {
  it("rejects control characters and protocol-relative redirects", () => {
    expect(safeLocalPath("/settings")).toBe("/settings");
    expect(safeLocalPath("/\t/evil.example")).toBe("/");
    expect(safeLocalPath("//evil.example")).toBe("/");
    expect(safeLocalPath("/\\evil.example")).toBe("/");
  });
});
