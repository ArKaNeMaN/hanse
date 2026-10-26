import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getApproval } from "../src/coordinator/approval.js";
import { getHandoff, transitionHandoff } from "../src/coordinator/handoff.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): { db: SqliteDatabase; service: CoordinatorService } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-svc-"));
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
  return { db, service: new CoordinatorService(db, "p") };
}

describe("CoordinatorService", () => {
  it("returns a handoff id immediately and is idempotent", () => {
    const { db, service } = fixture();
    const first = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "need X",
      spec: "do X",
      idempotencyKey: "k1",
    });
    const second = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "need X",
      spec: "do X",
      idempotencyKey: "k1",
    });
    expect(second.handoffId).toBe(first.handoffId);
    expect(getHandoff(db, first.handoffId)?.state).toBe("queued");
    db.close();
  });

  it("opens an approval when approval is required", () => {
    const { db, service } = fixture();
    const { handoffId } = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "need X",
      spec: "do X",
      requiresApproval: true,
    });
    const handoff = getHandoff(db, handoffId);
    expect(handoff?.state).toBe("awaiting_approval");
    const approval = db.prepare("SELECT id FROM approvals WHERE handoff_id = ?").get(handoffId) as {
      id: string;
    };
    expect(getApproval(db, approval.id)?.state).toBe("pending");
    db.close();
  });

  it("delivers a dispatched handoff idempotently", () => {
    const { db, service } = fixture();
    const { handoffId } = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "need X",
      spec: "do X",
    });
    transitionHandoff(db, handoffId, "dispatching");
    const delivered = service.deliverHandoff(handoffId, "done");
    expect(delivered.state).toBe("delivered");
    expect(delivered.result).toBe("done");
    const again = service.deliverHandoff(handoffId, "different");
    expect(again.result).toBe("done");
    db.close();
  });

  it("rejects requests for unknown applications", () => {
    const { db, service } = fixture();
    expect(() =>
      service.requestSiblingChange({ fromAppKey: "a", toAppKey: "nope", summary: "s", spec: "x" }),
    ).toThrow();
    db.close();
  });

  it("returns durable build fields without a filesystem check or status heuristic", () => {
    const { db, service } = fixture();
    db.prepare(
      `UPDATE apps SET build_configured = 1, image_status = 'error', image_error = 'build failed',
         image_base_ref = 'agent-base:tag', image_base_kind = 'base', image_hash_version = 2,
         image_build_id = 'build-1', image_build_ref = 'hanse-app:build-1',
         image_build_started_at = '2026-10-26T00:00:00.000Z',
         image_build_rejected_ref = 'hanse-app:rejected'
       WHERE id = 'p:a'`,
    ).run();
    db.prepare(
      "UPDATE apps SET image_status = 'ready', image_ref = 'default-ref' WHERE id = 'p:b'",
    ).run();

    const apps = service.listApps();
    expect(apps.find((app) => app.appKey === "a")).toMatchObject({
      buildConfigured: true,
      imageStatus: "error",
      imageError: "build failed",
      imageBaseRef: "agent-base:tag",
      imageBaseKind: "base",
      imageHashVersion: 2,
      imageBuildId: "build-1",
      imageBuildRef: "hanse-app:build-1",
      imageBuildStartedAt: "2026-10-26T00:00:00.000Z",
      imageBuildRejectedRef: "hanse-app:rejected",
    });
    expect(apps.find((app) => app.appKey === "b")).toMatchObject({
      buildConfigured: false,
      imageStatus: "ready",
      imageRef: "default-ref",
    });
    db.close();
  });

  it("does not infer build_configured from a stored image hash or reference", () => {
    const { db, service } = fixture();
    db.prepare(
      `UPDATE apps SET image_hash = 'abc123', image_ref = 'default-ref',
         image_status = 'ready', build_configured = 0
       WHERE id = 'p:a'`,
    ).run();

    const app = service.listApps().find((entry) => entry.appKey === "a");
    expect(app).toMatchObject({
      buildConfigured: false,
      imageHash: "abc123",
      imageRef: "default-ref",
    });
    db.close();
  });
});
