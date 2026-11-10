import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DrainController } from "../src/coordinator/drain.js";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
import { runGracefulShutdown } from "../src/coordinator/shutdown.js";
import { createLogger } from "../src/logging/logger.js";
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
  lifecycle: LifecycleActivity;
  drain: DrainController;
  logger: ReturnType<typeof createLogger>;
  phases: string[];
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-shutdown-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const lifecycle = new LifecycleActivity();
  const phases: string[] = [];
  const logger = createLogger((line) => {
    const parsed = JSON.parse(line) as { message?: string; phase?: string };
    if (parsed.message === "shutdown_phase" && parsed.phase !== undefined) {
      phases.push(parsed.phase);
    }
  });
  const drain = new DrainController({ db, lifecycle, logger });
  drain.initialize();
  return { db, lifecycle, drain, logger, phases };
}

function serverSpy(): {
  close: () => void;
  closeIdleConnections: () => void;
  closeAllConnections: () => void;
  closed: () => boolean;
  idleClosed: () => boolean;
} {
  let closed = false;
  let idleClosed = false;
  return {
    close: () => {
      closed = true;
    },
    closeIdleConnections: () => {
      idleClosed = true;
    },
    closeAllConnections: () => undefined,
    closed: () => closed,
    idleClosed: () => idleClosed,
  };
}

describe("runGracefulShutdown", () => {
  it("drains within the grace and checkpoints before closing the database", async () => {
    const f = fixture();
    const end = f.lifecycle.begin("ensure");
    const server = serverSpy();
    let dbClosed = false;
    const pending = runGracefulShutdown({
      drain: f.drain,
      server,
      graceMs: 1_000,
      logger: f.logger,
      closeDb: () => {
        dbClosed = true;
        f.db.close();
      },
    });
    setTimeout(end, 60);
    const result = await pending;
    expect(result.drained).toBe(true);
    expect(result.checkpoint).toMatchObject({
      busy: expect.any(Number),
      log: expect.any(Number),
      checkpointed: expect.any(Number),
    });
    expect(server.closed()).toBe(true);
    expect(server.idleClosed()).toBe(true);
    expect(dbClosed).toBe(true);
    expect(f.phases).toEqual([
      "readiness_false",
      "stop_accepting",
      "background_stopped",
      "drained",
      "wal_checkpoint",
      "closed",
    ]);
  });

  it("closes the server before awaiting stopBackground", async () => {
    const f = fixture();
    const server = serverSpy();
    let closedWhenStopped: boolean | undefined;
    await runGracefulShutdown({
      drain: f.drain,
      server,
      graceMs: 1_000,
      logger: f.logger,
      closeDb: () => f.db.close(),
      stopBackground: async () => {
        closedWhenStopped = server.closed();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    expect(closedWhenStopped).toBe(true);
    expect(f.phases.indexOf("background_stopped")).toBeGreaterThan(
      f.phases.indexOf("stop_accepting"),
    );
  });

  it("subtracts the stopBackground elapsed time from the drain grace", async () => {
    let clock = 0;
    const budgets: number[] = [];
    let backgroundDone = false;
    const drain = {
      shutdownAt: new Date(0).toISOString(),
      inFlightHttp: 0,
      beginShutdown: () => undefined,
      awaitQuiescence: async (timeoutMs: number) => {
        expect(backgroundDone).toBe(true);
        budgets.push(timeoutMs);
        return true;
      },
      checkpoint: () => ({ busy: 0, log: 0, checkpointed: 0 }),
    } as unknown as DrainController;
    await runGracefulShutdown({
      drain,
      server: serverSpy(),
      graceMs: 5_000,
      now: () => clock,
      closeDb: () => undefined,
      stopBackground: async () => {
        clock += 1_200;
        backgroundDone = true;
      },
    });
    expect(budgets).toEqual([3_300]);
  });

  it("exits within the grace even when work does not quiesce", async () => {
    const f = fixture();
    const end = f.lifecycle.begin("ensure");
    const started = Date.now();
    const result = await runGracefulShutdown({
      drain: f.drain,
      server: serverSpy(),
      graceMs: 120,
      closeDb: () => f.db.close(),
    });
    expect(result.drained).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    end();
  });
});
