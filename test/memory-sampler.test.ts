import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeClient } from "../src/agent/client.js";
import type { RuntimeAppMemoryStat, RuntimeAppStats } from "../src/agent/protocol.js";
import type { Logger } from "../src/logging/logger.js";
import {
  AppMemorySampler,
  MEMORY_SAMPLER_BASE_BACKOFF_MS,
  MEMORY_SAMPLER_MAX_BACKOFF_MS,
  MEMORY_SAMPLER_PRUNE_INTERVAL_MS,
} from "../src/opencode/memory-sampler.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { insertMemorySamples } from "../src/store/memory-samples.js";

const BASE_NOW = "2026-11-16T12:00:00.000Z";
const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

function loggerStub(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function runtimeWith(appStats: AgentRuntimeClient["appStats"]): AgentRuntimeClient {
  return { appStats } as unknown as AgentRuntimeClient;
}

function fixture(appIds: string[]): { db: SqliteDatabase; logger: Logger } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-memory-sampler-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(BASE_NOW, BASE_NOW);
  for (const appId of appIds) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, 'apps/x', 'AGENTS.md', ?)",
    ).run(appId, appId, BASE_NOW);
  }
  return { db, logger: loggerStub() };
}

function stat(appId: string, overrides: Partial<RuntimeAppMemoryStat> = {}): RuntimeAppMemoryStat {
  return {
    appId,
    usageBytes: 1_000,
    workingSetBytes: 700,
    limitBytes: 2_048,
    anonBytes: 500,
    fileBytes: 200,
    ...overrides,
  };
}

function sampleInput(appId: string): {
  appId: string;
  usageBytes: number;
  workingSetBytes: number;
  limitBytes: number;
  anonBytes: number | null;
  fileBytes: number | null;
} {
  return {
    appId,
    usageBytes: 1_000,
    workingSetBytes: 700,
    limitBytes: 2_048,
    anonBytes: null,
    fileBytes: null,
  };
}

function rowCount(db: SqliteDatabase): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM app_memory_samples").get() as {
    count: number;
  };
  return row.count;
}

describe("AppMemorySampler", () => {
  it("runs one immediate tick and inserts every app with one shared sampled_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_NOW));
    const f = fixture(["p:a", "p:b"]);
    const appStats = vi.fn(async () => ({ apps: [stat("p:a"), stat("p:b")] }));
    const sampler = new AppMemorySampler({
      db: f.db,
      runtime: runtimeWith(appStats),
      logger: f.logger,
    });

    sampler.start();
    expect(appStats).toHaveBeenCalledTimes(1);
    await sampler.runOnce();
    await sampler.stop();

    const rows = f.db
      .prepare(
        "SELECT app_id AS appId, sampled_at AS sampledAt, working_set_bytes AS workingSetBytes FROM app_memory_samples ORDER BY app_id",
      )
      .all();
    expect(rows).toEqual([
      { appId: "p:a", sampledAt: BASE_NOW, workingSetBytes: 700 },
      { appId: "p:b", sampledAt: BASE_NOW, workingSetBytes: 700 },
    ]);
  });

  it("uses one timestamp for the whole batch and ignores a replayed tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_NOW));
    const f = fixture(["p:a"]);
    const appStats = vi.fn(async () => ({ apps: [stat("p:a")] }));
    const sampler = new AppMemorySampler({
      db: f.db,
      runtime: runtimeWith(appStats),
      logger: f.logger,
    });

    await sampler.runOnce();
    expect(rowCount(f.db)).toBe(1);
    const first = f.db.prepare("SELECT sampled_at AS sampledAt FROM app_memory_samples").get() as {
      sampledAt: string;
    };
    expect(first.sampledAt).toBe(BASE_NOW);

    await sampler.runOnce();
    expect(rowCount(f.db)).toBe(1);
    expect(appStats).toHaveBeenCalledTimes(2);
  });

  it("skips an app id that disappeared without failing the batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_NOW));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = fixture(["p:a"]);
    const appStats = vi.fn(async () => ({ apps: [stat("p:a"), stat("p:ghost")] }));
    const sampler = new AppMemorySampler({
      db: f.db,
      runtime: runtimeWith(appStats),
      logger: f.logger,
    });

    await sampler.runOnce();

    const rows = f.db.prepare("SELECT app_id AS appId FROM app_memory_samples").all();
    expect(rows).toEqual([{ appId: "p:a" }]);
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it("backs off 30s -> 5m on an unavailable runner and logs once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_NOW));
    const f = fixture(["p:a"]);
    const callTimes: number[] = [];
    const appStats = vi.fn(async () => {
      callTimes.push(Date.now());
      return undefined;
    });
    const sampler = new AppMemorySampler({
      db: f.db,
      runtime: runtimeWith(appStats),
      logger: f.logger,
      intervalMs: 30_000,
    });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callTimes).toHaveLength(1);

    const gaps = [
      MEMORY_SAMPLER_BASE_BACKOFF_MS,
      MEMORY_SAMPLER_BASE_BACKOFF_MS * 2,
      MEMORY_SAMPLER_BASE_BACKOFF_MS * 4,
      MEMORY_SAMPLER_BASE_BACKOFF_MS * 8,
      MEMORY_SAMPLER_MAX_BACKOFF_MS,
    ];
    for (const gap of gaps) {
      const before = callTimes.length;
      await vi.advanceTimersByTimeAsync(gap);
      expect(callTimes.length).toBe(before + 1);
    }

    const observed = callTimes.slice(1).map((time, index) => time - (callTimes[index] ?? 0));
    expect(observed).toEqual(gaps);
    // Log only on the transition into failure, not on every retry.
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledWith(
      "app_memory_sampler_unavailable",
      expect.objectContaining({ error: expect.any(String) }),
    );

    await sampler.stop();
  });

  it("recovers on the first success and resumes the normal interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_NOW));
    const f = fixture(["p:a"]);
    let healthy = false;
    const callTimes: number[] = [];
    const appStats = vi.fn(async (): Promise<RuntimeAppStats | undefined> => {
      callTimes.push(Date.now());
      return healthy ? { apps: [stat("p:a")] } : undefined;
    });
    const sampler = new AppMemorySampler({
      db: f.db,
      runtime: runtimeWith(appStats),
      logger: f.logger,
      intervalMs: 30_000,
    });

    sampler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MEMORY_SAMPLER_BASE_BACKOFF_MS);
    expect(callTimes).toHaveLength(2);
    expect(rowCount(f.db)).toBe(0);

    healthy = true;
    // Next attempt is at +60s after the second failure.
    await vi.advanceTimersByTimeAsync(MEMORY_SAMPLER_BASE_BACKOFF_MS * 2);
    expect(rowCount(f.db)).toBe(1);
    expect(f.logger.info).toHaveBeenCalledWith("app_memory_sampler_recovered");

    const afterRecovery = callTimes.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callTimes.length).toBe(afterRecovery + 1);
    expect(rowCount(f.db)).toBe(2);

    await sampler.stop();
  });

  it("awaits an in-flight tick and never writes after stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_NOW));
    const f = fixture(["p:a"]);
    let resolveStats: ((value: RuntimeAppStats) => void) | undefined;
    const appStats = vi.fn(
      () =>
        new Promise<RuntimeAppStats>((resolve) => {
          resolveStats = resolve;
        }),
    );
    const sampler = new AppMemorySampler({
      db: f.db,
      runtime: runtimeWith(appStats),
      logger: f.logger,
    });

    const tick = sampler.runOnce();
    let stopResolved = false;
    const stopped = sampler.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    resolveStats?.({ apps: [stat("p:a")] });
    await stopped;
    await tick;

    expect(rowCount(f.db)).toBe(0);

    // A later manual tick is a no-op, even after the database has closed.
    f.db.close();
    await expect(sampler.runOnce()).resolves.toBeUndefined();
  });

  it("prunes at most once per hour", async () => {
    const start = Date.parse(BASE_NOW);
    let now = start;
    const f = fixture(["p:a"]);
    const appStats = vi.fn(async () => ({ apps: [] as RuntimeAppMemoryStat[] }));
    const sampler = new AppMemorySampler({
      db: f.db,
      runtime: runtimeWith(appStats),
      logger: f.logger,
      now: () => now,
    });
    const expiredAt = new Date(start - 73 * 60 * 60 * 1_000).toISOString();

    insertMemorySamples(f.db, [sampleInput("p:a")], expiredAt);
    await sampler.runOnce();
    expect(rowCount(f.db)).toBe(0);

    insertMemorySamples(f.db, [sampleInput("p:a")], expiredAt);
    await sampler.runOnce();
    expect(rowCount(f.db)).toBe(1);

    now = start + MEMORY_SAMPLER_PRUNE_INTERVAL_MS;
    await sampler.runOnce();
    expect(rowCount(f.db)).toBe(0);
  });
});
