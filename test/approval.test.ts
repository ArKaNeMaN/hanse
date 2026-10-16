import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideApproval, requestApproval } from "../src/coordinator/approval.js";
import { createHandoff, getHandoff } from "../src/coordinator/handoff.js";
import { AuthError } from "../src/identity/auth.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): SqliteDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ap-"));
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
  return db;
}

function awaitingHandoff(db: SqliteDatabase, key: string): string {
  return createHandoff(db, {
    projectId: "p",
    fromAppId: "p:a",
    toAppId: "p:b",
    summary: "need X",
    spec: "do X",
    idempotencyKey: key,
    requiresApproval: true,
  }).id;
}

describe("approval", () => {
  it("requires a human principal to decide", () => {
    const db = fixture();
    const handoffId = awaitingHandoff(db, "k1");
    const approval = requestApproval(db, handoffId);
    const agent = createPrincipal(db, { kind: "agent", name: "web" }).principal;
    expect(() => decideApproval(db, approval.id, agent, "approved")).toThrow(AuthError);
    db.close();
  });

  it("approving dispatches the handoff", () => {
    const db = fixture();
    const handoffId = awaitingHandoff(db, "k2");
    const approval = requestApproval(db, handoffId);
    const human = createPrincipal(db, { kind: "human", name: "alice" }).principal;
    const decided = decideApproval(db, approval.id, human, "approved");
    expect(decided.state).toBe("approved");
    expect(getHandoff(db, handoffId)?.state).toBe("dispatching");
    db.close();
  });

  it("rejecting rejects the handoff", () => {
    const db = fixture();
    const handoffId = awaitingHandoff(db, "k3");
    const approval = requestApproval(db, handoffId);
    const human = createPrincipal(db, { kind: "human", name: "alice" }).principal;
    decideApproval(db, approval.id, human, "rejected", "not now");
    expect(getHandoff(db, handoffId)?.state).toBe("rejected");
    db.close();
  });
});
