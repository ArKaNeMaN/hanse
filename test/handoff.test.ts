import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canTransitionThread,
  createHandoff,
  expireDueHandoffs,
  HandoffTransitionError,
  listHandoffs,
  transitionHandoff,
  updateHandoff,
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

  it("keeps the thread header state machine separate from one-shot", () => {
    expect(canTransitionThread("queued", "dispatching")).toBe(true);
    expect(canTransitionThread("queued", "expired")).toBe(false);
    expect(canTransitionThread("awaiting_approval", "rejected")).toBe(true);
    expect(canTransitionThread("dispatching", "in_progress")).toBe(true);
    expect(canTransitionThread("in_progress", "expired")).toBe(true);
    expect(canTransitionThread("in_progress", "delivered")).toBe(false);
    expect(canTransitionThread("in_progress", "failed")).toBe(false);
    expect(canTransitionThread("delivered", "in_progress")).toBe(false);
  });

  it("listHandoffs includes a row under both source and target projects", () => {
    const db = fixture();
    const same = createHandoff(db, { ...base, idempotencyKey: "list-same" });
    const cross = createHandoff(db, {
      ...base,
      idempotencyKey: "list-cross",
      targetProjectId: "q",
    });
    expect(cross.targetProjectId).toBe("q");
    expect(cross.grantId).toBeNull();

    const source = listHandoffs(db, "p").map((handoff) => handoff.id);
    expect(source).toContain(same.id);
    expect(source).toContain(cross.id);

    const target = listHandoffs(db, "q").map((handoff) => handoff.id);
    expect(target).toEqual([cross.id]);
    expect(target).not.toContain(same.id);
    db.close();
  });

  it("listHandoffs returns every row when projectId is undefined (m9)", () => {
    const db = fixture();
    const same = createHandoff(db, { ...base, idempotencyKey: "all-same" });
    const cross = createHandoff(db, {
      ...base,
      idempotencyKey: "all-cross",
      targetProjectId: "q",
    });
    expect(
      listHandoffs(db)
        .map((handoff) => handoff.id)
        .sort(),
    ).toEqual([same.id, cross.id].sort());
    db.close();
  });

  it("updateHandoff does not rewrite target_project_id or grant_id (M2)", () => {
    const db = fixture();
    const cross = createHandoff(db, {
      ...base,
      idempotencyKey: "snapshot",
      targetProjectId: "q",
      grantId: 7,
    });
    const updated = updateHandoff(db, cross.id, {
      operatorNote: "edited",
      policyDispatchMode: "approve",
    });
    expect(updated.operatorNote).toBe("edited");
    expect(updated.targetProjectId).toBe("q");
    expect(updated.grantId).toBe(7);
    const raw = db
      .prepare("SELECT target_project_id, grant_id FROM handoffs WHERE id = ?")
      .get(cross.id) as { target_project_id: string | null; grant_id: number | null };
    expect(raw).toEqual({ target_project_id: "q", grant_id: 7 });
    db.close();
  });
});
