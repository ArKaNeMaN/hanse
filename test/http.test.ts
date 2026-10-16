import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHandoff, getHandoff } from "../src/coordinator/handoff.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { type HttpResponse, handleRequest } from "../src/http/handler.js";
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

describe("http handler", () => {
  it("renders the dashboard", () => {
    const { db, service, handoffId } = fixture();
    const response = handleRequest(
      { db, projectId: "p", service },
      { method: "GET", path: "/", headers: {} },
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("Applications");
    expect(response.body).toContain(handoffId);
    db.close();
  });

  it("lists apps as JSON", () => {
    const { db, service } = fixture();
    const response = handleRequest(
      { db, projectId: "p", service },
      { method: "GET", path: "/api/apps", headers: {} },
    );
    expect(JSON.parse(response.body).apps).toHaveLength(2);
    db.close();
  });

  it("rejects an unauthenticated mutation with 401", () => {
    const { db, service, handoffId } = fixture();
    const response = handleRequest(
      { db, projectId: "p", service },
      { method: "POST", path: `/api/handoffs/${handoffId}/approve`, headers: {} },
    );
    expect(response.status).toBe(401);
    db.close();
  });

  it("forbids an agent principal with 403", () => {
    const { db, service, handoffId } = fixture();
    const { token } = createPrincipal(db, { kind: "agent", name: "web" });
    const response = handleRequest(
      { db, projectId: "p", service },
      {
        method: "POST",
        path: `/api/handoffs/${handoffId}/approve`,
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(403);
    db.close();
  });

  it("approves a handoff as a human principal", () => {
    const { db, service, handoffId } = fixture();
    const { token } = createPrincipal(db, { kind: "human", name: "alice" });
    const response: HttpResponse = handleRequest(
      { db, projectId: "p", service },
      {
        method: "POST",
        path: `/api/handoffs/${handoffId}/approve`,
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(200);
    expect(getHandoff(db, handoffId)?.state).toBe("dispatching");
    db.close();
  });
});
