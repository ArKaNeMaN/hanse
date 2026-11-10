import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrainController } from "../src/coordinator/drain.js";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
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
  dir: string;
  db: SqliteDatabase;
  lifecycle: LifecycleActivity;
  drain: DrainController;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-drain-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const lifecycle = new LifecycleActivity();
  const drain = new DrainController({ db, lifecycle });
  drain.initialize();
  return { dir, db, lifecycle, drain };
}

function drainRow(db: SqliteDatabase): { draining: number; drain_id: string | null } {
  return db.prepare("SELECT draining, drain_id FROM deploy_state WHERE id = 1").get() as {
    draining: number;
    drain_id: string | null;
  };
}

describe("DrainController", () => {
  it("persists drain state and reports quiescence plus a WAL checkpoint", async () => {
    const f = fixture();
    const report = await f.drain.drain({
      timeoutSeconds: 1,
      schemaVersion: 26,
      revision: "abc123",
    });
    expect(report).toMatchObject({
      draining: true,
      drained: true,
      inFlightLifecycle: 0,
      inFlightHttp: 0,
      schemaVersion: 26,
      revision: "abc123",
    });
    expect(report.drainId.length).toBeGreaterThan(0);
    expect(report.walCheckpoint.busy).toBeGreaterThanOrEqual(0);
    expect(drainRow(f.db)).toMatchObject({ draining: 1, drain_id: report.drainId });
  });

  it("is idempotent and reuses the drain id", async () => {
    const f = fixture();
    const first = await f.drain.drain({ timeoutSeconds: 1 });
    const second = await f.drain.drain({ timeoutSeconds: 1 });
    expect(second.drainId).toBe(first.drainId);
    expect(f.drain.isDraining()).toBe(true);
  });

  it("waits for in-flight lifecycle work", async () => {
    const f = fixture();
    const end = f.lifecycle.begin("restart");
    const started = Date.now();
    const pending = f.drain.drain({ timeoutSeconds: 2 });
    setTimeout(end, 60);
    const report = await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(report.drained).toBe(true);
    expect(report.inFlightLifecycle).toBe(0);
  });

  it("waits for in-flight HTTP work", async () => {
    const f = fixture();
    const end = f.drain.trackHttp();
    const pending = f.drain.drain({ timeoutSeconds: 2 });
    setTimeout(end, 60);
    const report = await pending;
    expect(report.drained).toBe(true);
    expect(report.inFlightHttp).toBe(0);
  });

  it("reports a timeout without dropping the draining state", async () => {
    const f = fixture();
    const end = f.lifecycle.begin("restart");
    const report = await f.drain.drain({ timeoutSeconds: 0 });
    expect(report.drained).toBe(false);
    expect(report.inFlightLifecycle).toBe(1);
    expect(f.drain.isDraining()).toBe(true);
    end();
  });

  it("closes registered streams when a drain starts", async () => {
    const f = fixture();
    let closed = false;
    f.drain.registerStream(() => {
      closed = true;
    });
    await f.drain.drain({ timeoutSeconds: 1 });
    expect(closed).toBe(true);
  });

  it("resumes on restart unless explicitly started drained", async () => {
    const f = fixture();
    await f.drain.drain({ timeoutSeconds: 1 });
    const resumed = new DrainController({ db: f.db, lifecycle: f.lifecycle });
    resumed.initialize({ startDrained: false });
    expect(resumed.isDraining()).toBe(false);
    expect(drainRow(f.db).draining).toBe(0);

    await resumed.drain({ timeoutSeconds: 1 });
    const drained = new DrainController({ db: f.db, lifecycle: f.lifecycle });
    drained.initialize({ startDrained: true });
    expect(drained.isDraining()).toBe(true);
  });

  it("persists resume across a restart", async () => {
    const f = fixture();
    await f.drain.drain({ timeoutSeconds: 1 });
    f.drain.resume();
    expect(drainRow(f.db).draining).toBe(0);
    const restarted = new DrainController({ db: f.db, lifecycle: f.lifecycle });
    restarted.initialize();
    expect(restarted.isDraining()).toBe(false);
  });

  it("marks shutdown and a checkpoint from the shutdown path", async () => {
    const f = fixture();
    f.drain.beginShutdown();
    expect(f.drain.isShuttingDown()).toBe(true);
    expect(f.drain.shutdownAt).not.toBeNull();
    const drained = await f.drain.awaitQuiescence(500);
    expect(drained).toBe(true);
    expect(f.drain.checkpoint()).toMatchObject({
      busy: expect.any(Number),
      log: expect.any(Number),
      checkpointed: expect.any(Number),
    });
  });
});
