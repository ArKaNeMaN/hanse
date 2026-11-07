import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import {
  pruneAllProcessEvents,
  pruneProcessEvents,
  readProcess,
  readProcessEvents,
  readProcessSnapshot,
} from "../src/store/process.js";

const now = "2026-11-07T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;

function seedApp(db: SqliteDatabase, appId = "a1", projectId = "p"): void {
  db.prepare(
    "INSERT OR IGNORE INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?, 'P', 'main', '/tmp', ?, ?)",
  ).run(projectId, now, now);
  db.prepare(
    "INSERT OR IGNORE INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, ?, ?, 'apps/x', 'AGENTS.md', ?)",
  ).run(appId, projectId, appId, now);
}

interface EventInput {
  appId: string;
  attemptId: string;
  seq: number;
  state?: string;
  phase?: string | null;
  source?: string;
  reason?: string | null;
  errorCode?: string | null;
  message?: string | null;
  createdAt?: string;
}

function insertEvent(db: SqliteDatabase, input: EventInput): number {
  const result = db
    .prepare(
      `INSERT INTO agent_run_events
         (app_id, attempt_id, seq, state, phase, source, reason, error_code, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.appId,
      input.attemptId,
      input.seq,
      input.state ?? "starting",
      input.phase ?? "requested",
      input.source ?? "system",
      input.reason ?? null,
      input.errorCode ?? null,
      input.message ?? null,
      input.createdAt ?? now,
    );
  return Number(result.lastInsertRowid);
}

function insertInstance(
  db: SqliteDatabase,
  input: {
    appId: string;
    state: string;
    runtimeState?: string | null;
    attemptId?: string | null;
    phase?: string | null;
    startedAt?: string | null;
    updatedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    errorAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO instances
       (id, app_id, state, runtime_state, updated_at, process_attempt_id, process_phase,
        process_started_at, process_updated_at, process_error_code, process_error_message,
        process_error_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `i-${input.appId}`,
    input.appId,
    input.state,
    input.runtimeState === undefined ? input.state : input.runtimeState,
    now,
    input.attemptId ?? null,
    input.phase ?? null,
    input.startedAt ?? null,
    input.updatedAt ?? now,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    input.errorAt ?? null,
  );
}

function freshDb(): SqliteDatabase {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return db;
}

describe("process store", () => {
  it("returns a stopped default when the app has no instance row", () => {
    const db = freshDb();
    seedApp(db);

    expect(readProcess(db, "a1")).toEqual({
      state: "stopped",
      phase: null,
      attemptId: null,
      startedAt: null,
      updatedAt: null,
      error: null,
    });
    expect(readProcessSnapshot(db, "a1")).toEqual({
      state: "stopped",
      phase: null,
      attemptId: null,
      startedAt: null,
      updatedAt: null,
      error: null,
      lastEventId: 0,
    });
    db.close();
  });

  it("reads the current process and normalizes the legacy failed state", () => {
    const db = freshDb();
    seedApp(db);
    insertInstance(db, {
      appId: "a1",
      state: "failed",
      runtimeState: "failed",
      attemptId: "att-1",
      phase: "failed",
      startedAt: "2026-11-07T11:55:00.000Z",
      updatedAt: "2026-11-07T11:59:00.000Z",
      errorCode: "readiness_timeout",
      errorMessage: "OpenCode did not answer its readiness probe",
      errorAt: "2026-11-07T11:59:00.000Z",
    });

    expect(readProcess(db, "a1")).toEqual({
      state: "error",
      phase: "failed",
      attemptId: "att-1",
      startedAt: "2026-11-07T11:55:00.000Z",
      updatedAt: "2026-11-07T11:59:00.000Z",
      error: {
        code: "readiness_timeout",
        message: "OpenCode did not answer its readiness probe",
        at: "2026-11-07T11:59:00.000Z",
      },
    });
    db.close();
  });

  it("reads current and lastEventId from one snapshot query", () => {
    const db = freshDb();
    seedApp(db);
    insertInstance(db, {
      appId: "a1",
      state: "running",
      attemptId: "att-1",
      phase: "ready",
      updatedAt: "2026-11-07T12:00:00.000Z",
    });
    insertEvent(db, {
      appId: "a1",
      attemptId: "att-1",
      seq: 1,
      state: "starting",
      phase: "requested",
    });
    const lastEventId = insertEvent(db, {
      appId: "a1",
      attemptId: "att-1",
      seq: 2,
      state: "running",
      phase: "ready",
      source: "runtime",
    });

    expect(readProcessSnapshot(db, "a1")).toEqual({
      state: "running",
      phase: "ready",
      attemptId: "att-1",
      startedAt: null,
      updatedAt: "2026-11-07T12:00:00.000Z",
      error: null,
      lastEventId,
    });

    const nextEventId = insertEvent(db, {
      appId: "a1",
      attemptId: "att-1",
      seq: 3,
      state: "error",
      phase: "failed",
      source: "runtime",
      errorCode: "readiness_timeout",
    });
    expect(readProcessSnapshot(db, "a1").lastEventId).toBe(nextEventId);
    db.close();
  });

  it("paginates newest-first without duplicates or skips across interleaved apps", () => {
    const db = freshDb();
    seedApp(db, "a1");
    seedApp(db, "a2");

    const a1Ids: number[] = [];
    for (let seq = 1; seq <= 7; seq += 1) {
      a1Ids.push(insertEvent(db, { appId: "a1", attemptId: "att-a1", seq }));
      if (seq % 2 === 0) {
        insertEvent(db, { appId: "a2", attemptId: "att-a2", seq: seq / 2 });
      }
    }

    const seen: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page = readProcessEvents(db, "a1", { limit: 3, before });
      seen.push(...page.events.map((event) => event.id));
      if (page.events.length === 0) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).toBe(page.events.at(-1)?.id);
      before = page.nextCursor ?? undefined;
    }

    expect(seen).toEqual([...a1Ids].reverse());
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(7);

    expect(() => readProcessEvents(db, "a1", { before: 0 })).toThrow(RangeError);
    expect(() => readProcessEvents(db, "a1", { before: -1 })).toThrow(RangeError);
    expect(() => readProcessEvents(db, "a1", { before: 1.5 })).toThrow(RangeError);
    expect(() => readProcessEvents(db, "a1", { before: Number.NaN })).toThrow(RangeError);
    expect(() => readProcessEvents(db, "a1", { limit: 0 })).toThrow(RangeError);
    expect(() => readProcessEvents(db, "a1", { limit: 101 })).toThrow(RangeError);
    expect(() => readProcessEvents(db, "a1", { limit: 2.5 })).toThrow(RangeError);
    db.close();
  });

  it("defaults the page size to 50 and caps it at 100", () => {
    const db = freshDb();
    seedApp(db);
    for (let seq = 1; seq <= 120; seq += 1) {
      insertEvent(db, { appId: "a1", attemptId: "att-1", seq });
    }

    expect(readProcessEvents(db, "a1").events).toHaveLength(50);
    expect(readProcessEvents(db, "a1", { limit: 100 }).events).toHaveLength(100);
    db.close();
  });

  it("keeps the newest 1,000 events for one app", () => {
    const db = freshDb();
    seedApp(db, "a1");
    seedApp(db, "a2");
    const a1Ids: number[] = [];
    const write = db.transaction(() => {
      for (let seq = 1; seq <= 1_005; seq += 1) {
        a1Ids.push(insertEvent(db, { appId: "a1", attemptId: "att-a1", seq }));
      }
      for (let seq = 1; seq <= 3; seq += 1) {
        insertEvent(db, { appId: "a2", attemptId: "att-a2", seq });
      }
    });
    write();

    expect(pruneProcessEvents(db, "a1")).toBe(5);
    expect(pruneProcessEvents(db, "a1")).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM agent_run_events WHERE app_id = 'a1'").get(),
    ).toEqual({ count: 1_000 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM agent_run_events WHERE app_id = 'a2'").get(),
    ).toEqual({ count: 3 });
    expect(
      db.prepare("SELECT MIN(id) AS id FROM agent_run_events WHERE app_id = 'a1'").get(),
    ).toEqual({ id: a1Ids[5] });
    db.close();
  });

  it("prunes events older than 30 days for every app in batches", () => {
    const db = freshDb();
    seedApp(db, "a1");
    seedApp(db, "a2");
    insertInstance(db, { appId: "a1", state: "stopped" });
    insertInstance(db, { appId: "a2", state: "running" });
    const old = new Date(Date.parse(now) - 31 * DAY_MS).toISOString();
    const fresh = new Date(Date.parse(now) - 1 * DAY_MS).toISOString();
    const write = db.transaction(() => {
      for (let seq = 1; seq <= 600; seq += 1) {
        insertEvent(db, { appId: "a1", attemptId: "att-old", seq, createdAt: old });
      }
      insertEvent(db, { appId: "a2", attemptId: "att-old", seq: 1, createdAt: old });
      insertEvent(db, {
        appId: "a1",
        attemptId: "att-new",
        seq: 1,
        state: "stopped",
        phase: "stopped",
        createdAt: fresh,
      });
      insertEvent(db, {
        appId: "a2",
        attemptId: "att-new",
        seq: 1,
        state: "running",
        phase: "ready",
        createdAt: fresh,
      });
    });
    write();

    expect(pruneAllProcessEvents(db, now)).toBe(601);
    expect(pruneAllProcessEvents(db, now)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM agent_run_events").get()).toEqual({
      count: 2,
    });
    expect(
      db
        .prepare(
          "SELECT app_id AS appId, created_at AS createdAt FROM agent_run_events ORDER BY app_id",
        )
        .all(),
    ).toEqual([
      { appId: "a1", createdAt: fresh },
      { appId: "a2", createdAt: fresh },
    ]);
    db.close();
  });
});
