import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import {
  insertMemorySamples,
  MEMORY_SAMPLE_INTERVAL_MS,
  MEMORY_SAMPLE_PRUNE_BATCH,
  MEMORY_SAMPLE_RETENTION_MS,
  pruneMemorySamples,
  readLatestMemorySample,
  readMemoryBuckets,
  readMemorySummary,
} from "../src/store/memory-samples.js";
import { MIGRATIONS } from "../src/store/migrations.js";

const now = "2026-11-16T00:00:00.000Z";

function seedApp(db: SqliteDatabase, appId = "a1", projectId = "p"): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?, 'P', 'main', '/tmp', ?, ?)",
  ).run(projectId, now, now);
  db.prepare(
    "INSERT OR IGNORE INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, ?, ?, 'apps/x', 'AGENTS.md', ?)",
  ).run(appId, projectId, appId, now);
}

interface SampleInput {
  usageBytes?: number;
  workingSetBytes?: number;
  limitBytes?: number;
  anonBytes?: number | null;
  fileBytes?: number | null;
}

function sample(
  appId: string,
  input: SampleInput = {},
): {
  appId: string;
  usageBytes: number;
  workingSetBytes: number;
  limitBytes: number;
  anonBytes: number | null;
  fileBytes: number | null;
} {
  return {
    appId,
    usageBytes: input.usageBytes ?? 1_000,
    workingSetBytes: input.workingSetBytes ?? 800,
    limitBytes: input.limitBytes ?? 2_048,
    anonBytes: input.anonBytes ?? null,
    fileBytes: input.fileBytes ?? null,
  };
}

function insertAt(
  db: SqliteDatabase,
  appId: string,
  sampledAt: string,
  input: SampleInput = {},
): void {
  insertMemorySamples(db, [sample(appId, input)], sampledAt);
}

function tableColumns(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe("migration v29 app memory samples", () => {
  it("applies fresh migrations, defines the table, PK, and prune index", () => {
    const db = openDatabase(":memory:");
    expect(runMigrations(db)).toBe(29);
    expect(runMigrations(db)).toBe(0);

    expect(tableColumns(db, "app_memory_samples")).toEqual([
      "app_id",
      "sampled_at",
      "usage_bytes",
      "working_set_bytes",
      "limit_bytes",
      "anon_bytes",
      "file_bytes",
    ]);

    const primaryKey = (
      db.prepare("PRAGMA table_info(app_memory_samples)").all() as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    expect(primaryKey).toEqual(["app_id", "sampled_at"]);

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'app_memory_samples_sampled_at'",
      )
      .get();
    expect(index).toBeDefined();

    expect(MIGRATIONS.find((migration) => migration.version === 29)).toMatchObject({
      name: "app-memory-samples",
      backwardCompatible: true,
      requiresExclusive: false,
    });
    db.close();
  });

  it("rejects invalid usage, working set, limit, breakdown, and timestamp values", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedApp(db);

    const insert = db.prepare(
      `INSERT INTO app_memory_samples
         (app_id, sampled_at, usage_bytes, working_set_bytes, limit_bytes, anon_bytes, file_bytes)
       VALUES ('a1', ?, ?, ?, ?, ?, ?)`,
    );
    const valid = ["2026-11-16T00:00:00.000Z", 1, 1, 1, null, null];
    expect(() => insert.run(...valid)).not.toThrow();

    expect(() => insert.run("2026-11-16T00:00:01.000Z", -1, 1, 1, null, null)).toThrow();
    expect(() => insert.run("2026-11-16T00:00:02.000Z", 1, -1, 1, null, null)).toThrow();
    expect(() => insert.run("2026-11-16T00:00:03.000Z", 1, 1, 0, null, null)).toThrow();
    expect(() => insert.run("2026-11-16T00:00:04.000Z", 1, 1, 1, -1, null)).toThrow();
    expect(() => insert.run("2026-11-16T00:00:05.000Z", 1, 1, 1, null, -1)).toThrow();
    expect(() => insert.run("2026-11-16 00:00:06", 1, 1, 1, null, null)).toThrow();
    expect(() => insert.run("2026-11-16T00:00:06Z", 1, 1, 1, null, null)).toThrow();

    // The store uses ON CONFLICT, not INSERT OR IGNORE: a CHECK violation must surface.
    expect(() =>
      insertMemorySamples(db, [sample("a1", { usageBytes: -1 })], "2026-11-16T00:01:00.000Z"),
    ).toThrow();
    db.close();
  });

  it("does not swallow a real foreign-key failure", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);

    const insert = db.prepare(
      `INSERT INTO app_memory_samples
         (app_id, sampled_at, usage_bytes, working_set_bytes, limit_bytes)
       VALUES ('ghost', ?, 1, 1, 1)
       ON CONFLICT(app_id, sampled_at) DO NOTHING`,
    );
    expect(() => insert.run(now)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("is idempotent for a replayed batch timestamp", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedApp(db);

    expect(insertMemorySamples(db, [sample("a1")], now)).toEqual({ inserted: 1, skipped: 0 });
    expect(insertMemorySamples(db, [sample("a1")], now)).toEqual({ inserted: 0, skipped: 0 });
    const count = db.prepare("SELECT COUNT(*) AS count FROM app_memory_samples").get() as {
      count: number;
    };
    expect(count.count).toBe(1);
    db.close();
  });

  it("skips an unknown app without aborting the batch and logs it once", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedApp(db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = insertMemorySamples(db, [sample("a1"), sample("ghost"), sample("ghost")], now);
      expect(result).toEqual({ inserted: 1, skipped: 2 });
      const rows = db
        .prepare("SELECT app_id FROM app_memory_samples ORDER BY app_id")
        .all() as Array<{ app_id: string }>;
      expect(rows).toEqual([{ app_id: "a1" }]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("memory_sample_unknown_app"));
    } finally {
      warn.mockRestore();
    }
    db.close();
  });

  it("cascades samples when the application is deleted", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedApp(db, "a1");
    seedApp(db, "a2");

    insertAt(db, "a1", now);
    insertAt(db, "a2", now);
    db.prepare("DELETE FROM apps WHERE id = 'a1'").run();

    const rows = db
      .prepare("SELECT app_id FROM app_memory_samples ORDER BY app_id")
      .all() as Array<{ app_id: string }>;
    expect(rows).toEqual([{ app_id: "a2" }]);
    db.close();
  });
});

describe("memory buckets", () => {
  it("groups samples with integer bucket division and computes min/max/average", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedApp(db);

    insertAt(db, "a1", "2026-11-16T00:10:00.000Z", { workingSetBytes: 100 });
    insertAt(db, "a1", "2026-11-16T00:10:01.000Z", { workingSetBytes: 200 });
    insertAt(db, "a1", "2026-11-16T00:20:00.000Z", { workingSetBytes: 300 });

    const buckets = readMemoryBuckets(
      db,
      "a1",
      "2026-11-16T00:00:00.000Z",
      "2026-11-16T00:30:00.000Z",
      1_800,
    );
    // REAL division (one bucket per second) would return three groups here.
    expect(buckets).toEqual([
      {
        start: "2026-11-16T00:00:00.000Z",
        minBytes: 100,
        maxBytes: 300,
        averageBytes: 200,
        samples: 3,
      },
    ]);
    db.close();
  });

  it("keeps from inclusive and to exclusive across adjacent buckets", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedApp(db);

    insertAt(db, "a1", "2026-11-16T00:10:00.000Z", { workingSetBytes: 100 });
    insertAt(db, "a1", "2026-11-16T00:20:00.000Z", { workingSetBytes: 300 });
    insertAt(db, "a1", "2026-11-16T00:40:00.000Z", { workingSetBytes: 500 });

    const partial = readMemoryBuckets(
      db,
      "a1",
      "2026-11-16T00:00:00.000Z",
      "2026-11-16T00:30:00.000Z",
      1_800,
    );
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ start: "2026-11-16T00:00:00.000Z", samples: 2 });

    const both = readMemoryBuckets(
      db,
      "a1",
      "2026-11-16T00:00:00.000Z",
      "2026-11-16T01:00:00.000Z",
      1_800,
    );
    expect(both).toEqual([
      {
        start: "2026-11-16T00:00:00.000Z",
        minBytes: 100,
        maxBytes: 300,
        averageBytes: 200,
        samples: 2,
      },
      {
        start: "2026-11-16T00:30:00.000Z",
        minBytes: 500,
        maxBytes: 500,
        averageBytes: 500,
        samples: 1,
      },
    ]);

    const empty = readMemoryBuckets(
      db,
      "a1",
      "2026-11-16T02:00:00.000Z",
      "2026-11-16T03:00:00.000Z",
      1_800,
    );
    expect(empty).toEqual([]);
    db.close();
  });
});

describe("memory summary and latest sample", () => {
  function seedSummary(db: SqliteDatabase): void {
    seedApp(db);
    insertAt(db, "a1", "2026-11-16T00:00:00.000Z", {
      workingSetBytes: 50,
      limitBytes: 1_024,
    });
    insertAt(db, "a1", "2026-11-16T01:10:00.000Z", {
      workingSetBytes: 100,
      limitBytes: 2_048,
    });
    insertAt(db, "a1", "2026-11-16T01:20:00.000Z", {
      workingSetBytes: 300,
      limitBytes: 4_096,
    });
  }

  it("summarizes the in-window extrema while reporting the global last sample", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedSummary(db);

    const summary = readMemorySummary(
      db,
      "a1",
      "2026-11-16T01:00:00.000Z",
      "2026-11-16T02:00:00.000Z",
    );
    expect(summary).toEqual({
      currentBytes: 300,
      minBytes: 100,
      peakBytes: 300,
      averageBytes: 200,
      limitBytes: 4_096,
      samples: 2,
      lastSampleAt: "2026-11-16T01:20:00.000Z",
    });

    const empty = readMemorySummary(
      db,
      "a1",
      "2026-11-16T03:00:00.000Z",
      "2026-11-16T04:00:00.000Z",
    );
    expect(empty).toEqual({
      currentBytes: null,
      minBytes: null,
      peakBytes: null,
      averageBytes: null,
      limitBytes: null,
      samples: 0,
      lastSampleAt: "2026-11-16T01:20:00.000Z",
    });
    db.close();
  });

  it("bounds the latest sample by to", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedSummary(db);

    expect(readLatestMemorySample(db, "a1", "2026-11-16T00:00:00.000Z")).toMatchObject({
      appId: "a1",
      sampledAt: "2026-11-16T00:00:00.000Z",
      workingSetBytes: 50,
    });
    expect(readLatestMemorySample(db, "a1", "2026-11-16T00:15:00.000Z")?.sampledAt).toBe(
      "2026-11-16T00:00:00.000Z",
    );
    expect(readLatestMemorySample(db, "a1", "2026-11-16T01:20:00.000Z")).toMatchObject({
      sampledAt: "2026-11-16T01:20:00.000Z",
      limitBytes: 4_096,
    });
    expect(readLatestMemorySample(db, "a1", "2026-11-15T23:59:59.999Z")).toBeNull();
    db.close();
  });
});

describe("memory retention", () => {
  it("prunes rows older than the retention window in batches and is idempotent", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    seedApp(db);

    expect(MEMORY_SAMPLE_RETENTION_MS).toBe(72 * 60 * 60 * 1_000);
    expect(MEMORY_SAMPLE_INTERVAL_MS).toBe(30_000);
    expect(MEMORY_SAMPLE_PRUNE_BATCH).toBe(500);

    const pruneNow = "2026-11-20T00:00:00.000Z";
    const cutoff = "2026-11-17T00:00:00.000Z";
    const insert = db.prepare(
      `INSERT INTO app_memory_samples
         (app_id, sampled_at, usage_bytes, working_set_bytes, limit_bytes)
       VALUES ('a1', ?, 1, 1, 2_048)`,
    );
    const batch = db.transaction(() => {
      const base = Date.parse("2026-11-16T00:00:00.000Z");
      for (let index = 0; index < 1_100; index += 1) {
        insert.run(new Date(base + index * 1_000).toISOString());
      }
      // Exactly at the cutoff is retained; strictly older is removed.
      insert.run(cutoff);
      insert.run("2026-11-19T00:00:00.000Z");
    });
    batch();

    expect(pruneMemorySamples(db, pruneNow)).toBe(1_100);
    const remaining = db
      .prepare("SELECT sampled_at FROM app_memory_samples ORDER BY sampled_at")
      .all() as Array<{ sampled_at: string }>;
    expect(remaining.map((row) => row.sampled_at)).toEqual([cutoff, "2026-11-19T00:00:00.000Z"]);

    expect(pruneMemorySamples(db, pruneNow)).toBe(0);
    db.close();
  });
});
