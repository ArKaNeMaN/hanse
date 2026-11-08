import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrainController } from "../src/coordinator/drain.js";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
import { GitService } from "../src/git/service.js";
import { handleDeploy } from "../src/http/deploy.js";
import { type HttpDeps, handleRequest } from "../src/http/handler.js";
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

interface Fixture {
  db: SqliteDatabase;
  drain: DrainController;
  deps: HttpDeps;
  token: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-http-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "README.md"), "fixture\n", "utf8");
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const lifecycle = new LifecycleActivity();
  const drain = new DrainController({ db, lifecycle });
  drain.initialize();
  const { token } = createPrincipal(db, { kind: "human", name: "operator" });
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    git: new GitService({ workspaceRoot: workspace }),
    getProjects: () => [],
    lifecycleActivity: lifecycle,
    drain,
  };
  return { db, drain, deps, token };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("deploy drain HTTP contracts", () => {
  it("extends /readyz additively", () => {
    const f = fixture();
    const response = handleRequest(f.deps, { method: "GET", path: "/readyz", headers: {} });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      version: expect.any(String),
      revision: expect.any(String),
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
  });

  it("requires an operator and returns the documented drain report", async () => {
    const f = fixture();
    const unauthorized = await handleDeploy(f.deps, {
      method: "POST",
      path: "/api/deploy/drain",
      headers: {},
      body: JSON.stringify({ timeoutSeconds: 1 }),
    });
    expect(unauthorized?.status).toBe(401);

    const response = await handleDeploy(f.deps, {
      method: "POST",
      path: "/api/deploy/drain",
      headers: auth(f.token),
      body: JSON.stringify({ timeoutSeconds: 1 }),
    });
    expect(response?.status).toBe(200);
    const body = JSON.parse(response?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      drainId: expect.any(String),
      draining: true,
      drained: true,
      inFlightLifecycle: 0,
      inFlightHttp: 0,
      schemaVersion: 25,
      revision: expect.any(String),
      walCheckpoint: {
        busy: expect.any(Number),
        log: expect.any(Number),
        checkpointed: expect.any(Number),
      },
    });
  });

  it("rejects new mutations with 503 and keeps reads available", async () => {
    const f = fixture();
    await f.drain.drain({ timeoutSeconds: 0 });
    const blocked = handleRequest(f.deps, {
      method: "POST",
      path: "/api/projects",
      headers: auth(f.token),
      body: "",
    });
    expect(blocked.status).toBe(503);
    expect(blocked.headers?.["retry-after"]).toBe("5");
    expect(JSON.parse(blocked.body)).toMatchObject({ code: "draining", draining: true });

    const read = handleRequest(f.deps, { method: "GET", path: "/api/projects", headers: {} });
    expect(read.status).toBe(200);
    expect(handleRequest(f.deps, { method: "GET", path: "/healthz", headers: {} }).status).toBe(
      200,
    );
    expect(handleRequest(f.deps, { method: "GET", path: "/readyz", headers: {} }).status).toBe(200);
  });

  it("resumes and clears the persistent drain state", async () => {
    const f = fixture();
    await f.drain.drain({ timeoutSeconds: 1 });
    const response = await handleDeploy(f.deps, {
      method: "POST",
      path: "/api/deploy/resume",
      headers: auth(f.token),
    });
    expect(response?.status).toBe(200);
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({ draining: false });
    expect(f.drain.isDraining()).toBe(false);
  });

  it("answers /readyz 503 with status shutting_down after SIGTERM begins", async () => {
    const f = fixture();
    f.drain.beginShutdown();
    const response = handleRequest(f.deps, { method: "GET", path: "/readyz", headers: {} });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      status: "shutting_down",
      shutdownAt: expect.any(String),
    });
  });
});
