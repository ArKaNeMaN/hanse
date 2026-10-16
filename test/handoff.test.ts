import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHandoff,
  expireDueHandoffs,
  HandoffTransitionError,
  transitionHandoff,
} from "../src/coordinator/handoff.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): SqliteDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ho-"));
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

const base = {
  projectId: "p",
  fromAppId: "p:a",
  toAppId: "p:b",
  summary: "need X",
  spec: "do X",
};

describe("handoff", () => {
  it("is idempotent on the idempotency key", () => {
    const db = fixture();
    const first = createHandoff(db, { ...base, idempotencyKey: "k1" });
    const second = createHandoff(db, { ...base, idempotencyKey: "k1" });
    expect(second.id).toBe(first.id);
    expect((db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("starts in awaiting_approval when approval is required", () => {
    const db = fixture();
    const handoff = createHandoff(db, { ...base, idempotencyKey: "k2", requiresApproval: true });
    expect(handoff.state).toBe("awaiting_approval");
    db.close();
  });

  it("applies valid transitions and rejects invalid ones", () => {
    const db = fixture();
    const handoff = createHandoff(db, { ...base, idempotencyKey: "k3" });
    transitionHandoff(db, handoff.id, "dispatching");
    transitionHandoff(db, handoff.id, "in_progress");
    const done = transitionHandoff(db, handoff.id, "delivered", { result: "ok" });
    expect(done.state).toBe("delivered");
    expect(done.result).toBe("ok");
    expect(() => transitionHandoff(db, handoff.id, "queued")).toThrow(HandoffTransitionError);
    db.close();
  });

  it("expires handoffs past their expiry", () => {
    const db = fixture();
    createHandoff(db, {
      ...base,
      idempotencyKey: "k4",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(expireDueHandoffs(db)).toBe(1);
    db.close();
  });
});
