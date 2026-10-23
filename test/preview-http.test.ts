import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleChat } from "../src/http/chat.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handlePreviews } from "../src/http/previews.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import { PreviewService } from "../src/preview/service.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

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
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  token: string;
  agentToken: string;
  previews: PreviewService;
}

function addProject(db: SqliteDatabase, id: string, name: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?,'main',?,?,?)",
  ).run(id, name, `/tmp/${id}`, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?,?,'a','apps/a','AGENTS.md',?)",
  ).run(`${id}:a`, id, now);
}

function fixture(options: { previews?: boolean } = {}): Fixture {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  addProject(db, "p1", "Alpha");
  addProject(db, "p2", "Beta");
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "agent" }).token;
  const previews = new PreviewService();
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    settings: new SettingsService({ db, secretKey: randomBytes(32) }),
    ...(options.previews === false ? {} : { previews }),
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
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, row.id),
      })),
  };
  return { db, deps, token, agentToken, previews };
}

function seed(previews: PreviewService, projectId: string, key: string): void {
  previews.open({
    appId: `${projectId}:a`,
    projectId,
    appKey: "a",
    key,
    name: key,
    port: 3000,
    targetHost: "app-container",
  });
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    path: "/api/apps/a/previews",
    headers: {},
    query: {},
    ...overrides,
  };
}

function closeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return request({ method: "POST", path: "/api/apps/a/previews/one/close", ...overrides });
}

function previewKeys(body: string): string[] {
  const parsed = JSON.parse(body) as { previews: Array<{ key: string }> };
  return parsed.previews.map((preview) => preview.key);
}

describe("handlePreviews list", () => {
  it("lists only the requested project's previews", async () => {
    const f = fixture();
    seed(f.previews, "p1", "one");
    seed(f.previews, "p2", "two");

    const p1 = await handlePreviews(
      f.deps,
      request({ headers: auth(f.token), query: { project: "p1" } }),
    );
    expect(p1.status).toBe(200);
    expect(p1.contentType).toBe("application/json; charset=utf-8");
    expect(p1.headers).toEqual({ "cache-control": "no-store" });
    expect(previewKeys(p1.body)).toEqual(["one"]);
    const body = JSON.parse(p1.body) as { previews: Array<{ url: string }> };
    expect(body.previews[0]?.url).toBe("/preview/p1/a/one/");

    const p2 = await handlePreviews(
      f.deps,
      request({ headers: auth(f.token), query: { project: "p2" } }),
    );
    expect(p2.status).toBe(200);
    expect(previewKeys(p2.body)).toEqual(["two"]);
  });

  it("requires a project query", async () => {
    const f = fixture();
    const response = await handlePreviews(f.deps, request({ headers: auth(f.token) }));
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: "project is required",
      code: "project_required",
    });
  });

  it("returns 404 for an unknown application", async () => {
    const f = fixture();
    const response = await handlePreviews(
      f.deps,
      request({
        path: "/api/apps/missing/previews",
        headers: auth(f.token),
        query: { project: "p1" },
      }),
    );
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: "unknown application",
      code: "unknown_app",
    });
  });

  it("returns 503 when the preview service is not configured", async () => {
    const f = fixture({ previews: false });
    const response = await handlePreviews(
      f.deps,
      request({ headers: auth(f.token), query: { project: "p1" } }),
    );
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "previews are not configured",
      code: "preview_unavailable",
    });
  });

  it("rejects agent and invalid tokens", async () => {
    const f = fixture();
    for (const headers of [auth(f.agentToken), auth("not-a-token"), {}]) {
      const response = await handlePreviews(f.deps, request({ headers, query: { project: "p1" } }));
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: "sign in required" });
    }
  });
});

describe("handlePreviews close", () => {
  it("closes a preview without an Origin and reports idempotence", async () => {
    const f = fixture();
    seed(f.previews, "p1", "one");

    const first = await handlePreviews(
      f.deps,
      closeRequest({ headers: auth(f.token), query: { project: "p1" } }),
    );
    expect(first.status).toBe(200);
    expect(first.headers).toEqual({ "cache-control": "no-store" });
    expect(JSON.parse(first.body)).toEqual({ ok: true, closed: true });

    const second = await handlePreviews(
      f.deps,
      closeRequest({ headers: auth(f.token), query: { project: "p1" } }),
    );
    expect(JSON.parse(second.body)).toEqual({ ok: true, closed: false });
  });

  it("allows a same-origin close", async () => {
    const f = fixture();
    seed(f.previews, "p1", "one");
    const response = await handlePreviews(
      f.deps,
      closeRequest({
        headers: auth(f.token),
        query: { project: "p1" },
        origin: "http://coordinator.example:8787",
        host: "coordinator.example:8787",
      }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, closed: true });
  });

  it("rejects a cross-origin or null Origin without closing", async () => {
    const f = fixture();
    seed(f.previews, "p1", "one");
    for (const origin of ["http://evil.example", "null"]) {
      const response = await handlePreviews(
        f.deps,
        closeRequest({
          headers: auth(f.token),
          query: { project: "p1" },
          origin,
          host: "coordinator.example:8787",
        }),
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({
        error: "cross-origin request rejected",
        code: "origin_rejected",
      });
    }
    expect(f.previews.views("p1:a")).toHaveLength(1);
  });

  it("does not close another application's key", async () => {
    const f = fixture();
    seed(f.previews, "p2", "one");
    const response = await handlePreviews(
      f.deps,
      closeRequest({ headers: auth(f.token), query: { project: "p1" } }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, closed: false });
    expect(f.previews.views("p2:a")).toHaveLength(1);
  });
});

describe("server dispatch", () => {
  it("routes the preview list before the /api/apps chat catch-all", async () => {
    const f = fixture();
    seed(f.previews, "p1", "one");
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/apps/a/previews?project=p1`,
      { headers: auth(f.token) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(previewKeys(await response.text())).toEqual(["one"]);
  });
});

describe("operator host capture", () => {
  it("records the latest human chat host per app", async () => {
    const f = fixture();
    const first = await handleChat(
      f.deps,
      request({
        path: "/chat",
        headers: auth(f.token),
        query: { app: "a", project: "p1" },
        host: "coordinator.example:8787",
      }),
    );
    expect(first.status).toBe(200);
    expect(f.previews.operatorHost("p1:a")).toEqual({
      host: "coordinator.example:8787",
      hostname: "coordinator.example",
    });
    expect(f.previews.operatorHost("p2:a")).toBeUndefined();

    await handleChat(
      f.deps,
      request({
        path: "/chat",
        headers: auth(f.token),
        query: { app: "a", project: "p2" },
        host: "second.example:8787",
      }),
    );
    await handleChat(
      f.deps,
      request({
        path: "/chat",
        headers: auth(f.token),
        query: { app: "a", project: "p1" },
        host: "latest.example:8787",
      }),
    );

    expect(f.previews.operatorHost("p1:a")?.host).toBe("latest.example:8787");
    expect(f.previews.operatorHost("p2:a")?.host).toBe("second.example:8787");
  });

  it("does not record the host for a non-human request", async () => {
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request({
        path: "/chat",
        headers: auth(f.agentToken),
        query: { app: "a", project: "p1" },
        host: "coordinator.example:8787",
      }),
    );
    expect(response.status).toBe(303);
    expect(f.previews.operatorHost("p1:a")).toBeUndefined();
  });
});
