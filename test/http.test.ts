import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHandoff } from "../src/coordinator/handoff.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { handleRequest } from "../src/http/handler.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  service: CoordinatorService;
  handoffId: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-http-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/x',?,?)",
  ).run(now, now);
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
  return { db, service, handoffId };
}

function deps(db: SqliteDatabase, service: CoordinatorService) {
  return {
    db,
    workspaceRoot: "/tmp",
    getProjects: () => [{ id: "p", name: "P", rootPath: "/x", service }],
  };
}

describe("http handler", () => {
  it("renders the dashboard with apps and handoffs", () => {
    const { db, service, handoffId } = fixture();
    const response = handleRequest(deps(db, service), { method: "GET", path: "/", headers: {} });
    expect(response.status).toBe(200);
    expect(response.body).toContain(handoffId.slice(0, 8));
    expect(response.body).toContain("apps/a");
    db.close();
  });

  it("lists projects as JSON", () => {
    const { db, service } = fixture();
    const response = handleRequest(deps(db, service), {
      method: "GET",
      path: "/api/projects",
      headers: {},
    });
    const projects = (JSON.parse(response.body) as { projects: { apps: unknown[] }[] }).projects;
    expect(projects[0]?.apps).toHaveLength(2);
    db.close();
  });

  it("rejects an unauthenticated mutation with 401", () => {
    const { db, service, handoffId } = fixture();
    const response = handleRequest(deps(db, service), {
      method: "POST",
      path: `/api/handoffs/${handoffId}/approve`,
      headers: {},
    });
    expect(response.status).toBe(401);
    db.close();
  });

  it("forbids an agent principal with 403", () => {
    const { db, service, handoffId } = fixture();
    const { token } = createPrincipal(db, { kind: "agent", name: "web" });
    const response = handleRequest(deps(db, service), {
      method: "POST",
      path: `/api/handoffs/${handoffId}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    db.close();
  });

  it("approves a handoff as a human principal", () => {
    const { db, service, handoffId } = fixture();
    const { token } = createPrincipal(db, { kind: "human", name: "alice" });
    const response = handleRequest(deps(db, service), {
      method: "POST",
      path: `/api/handoffs/${handoffId}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(303);
    expect(getHandoff(db, handoffId)?.state).toBe("dispatching");
    db.close();
  });

  it("creates a handoff through the API as a human", () => {
    const { db, service } = fixture();
    const { token } = createPrincipal(db, { kind: "human", name: "alice" });
    const response = handleRequest(deps(db, service), {
      method: "POST",
      path: "/api/handoffs",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "project=p&from=a&to=b&summary=s&spec=x",
    });
    expect(response.status).toBe(303);
    expect((db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number }).c).toBe(2);
    db.close();
  });
});
