import { describe, expect, it } from "vitest";
import {
  decideWatermark,
  noticeReasonNotifies,
  scanMissedNotices,
} from "../src/notifications/catch-up.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const T0 = "2026-11-10T00:00:00.000Z";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function at(deltaMs: number, base = T0): string {
  return new Date(Date.parse(base) + deltaMs).toISOString();
}

function createDb(): SqliteDatabase {
  const db = openDatabase(":memory:");
  runMigrations(db);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(T0, T0);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a1','p','a','apps/a','AGENTS.md',?)",
  ).run(T0);
  return db;
}

function insertNotice(
  db: SqliteDatabase,
  input: {
    id: string;
    kind: string;
    reason?: string | null;
    createdAt: string;
    sessionId?: string;
    parentSessionId?: string | null;
    appId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO session_notices
       (id, app_id, session_id, parent_session_id, dedupe_key, kind, reason, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.appId ?? "a1",
    input.sessionId ?? "ses_1",
    input.parentSessionId ?? null,
    `dedupe-${input.id}`,
    input.kind,
    input.reason ?? null,
    JSON.stringify({ notice: input.id }),
    input.createdAt,
  );
}

describe("notice reason matrix", () => {
  it("notifies stop kinds except the suppressed operator lifecycle reasons", () => {
    for (const reason of [
      "process_exit",
      "unknown_restart",
      "unknown",
      "missing",
      "stale",
      "ttl_expired",
      "resume_failed",
      "resume_unavailable",
      "unrecognized_reason",
    ]) {
      expect(noticeReasonNotifies("agent_stopped", reason)).toBe(true);
    }
    for (const reason of [
      "operator_restart",
      "operator_stop",
      "deletion",
      "deployment",
      "operator_abort",
      "subagent_abort",
      "stopped",
      "superseded",
      "completed",
      "ambiguous",
    ]) {
      expect(noticeReasonNotifies("agent_stopped", reason)).toBe(false);
    }
    expect(noticeReasonNotifies("agent_stopped", undefined)).toBe(true);
  });

  it("notifies every resume failure and never the resume lifecycle kinds", () => {
    expect(noticeReasonNotifies("resume_failed", "operator_stop")).toBe(true);
    expect(noticeReasonNotifies("resume_unavailable", "deployment")).toBe(true);
    expect(noticeReasonNotifies("resume_started", "process_exit")).toBe(false);
    expect(noticeReasonNotifies("resume_completed", "process_exit")).toBe(false);
  });
});

describe("scanMissedNotices", () => {
  it("scans only the four attention kinds, applies the matrix, and orders oldest first", () => {
    const db = createDb();
    insertNotice(db, {
      id: "n1",
      kind: "resume_failed",
      reason: "process_exit",
      createdAt: at(2 * MINUTE),
    });
    insertNotice(db, {
      id: "n2",
      kind: "agent_stopped",
      reason: "process_exit",
      createdAt: at(1 * MINUTE),
    });
    insertNotice(db, {
      id: "n3",
      kind: "agent_stopped",
      reason: "operator_stop",
      createdAt: at(3 * MINUTE),
    });
    insertNotice(db, {
      id: "n4",
      kind: "resume_started",
      reason: "process_exit",
      createdAt: at(4 * MINUTE),
    });
    insertNotice(db, {
      id: "n5",
      kind: "subagent_interrupted",
      reason: "unknown",
      createdAt: at(5 * MINUTE),
      parentSessionId: "ses_parent",
    });

    const result = scanMissedNotices(db, { now: Date.parse(at(10 * MINUTE)) });

    expect(result.candidates.map((candidate) => candidate.noticeId)).toEqual(["n2", "n1", "n5"]);
    expect(result.candidates.map((candidate) => candidate.dedupeKey)).toEqual([
      "notice:n2",
      "notice:n1",
      "notice:n5",
    ]);
    expect(result.candidates[2]).toMatchObject({
      sessionId: "ses_1",
      parentSessionId: "ses_parent",
      kind: "subagent_interrupted",
    });
    expect(result.latestCreatedAt).toBe(at(5 * MINUTE));
  });

  it("applies max(notice_scan_at, enabled_at) and the seven-day floor", () => {
    const db = createDb();
    insertNotice(db, {
      id: "old",
      kind: "agent_stopped",
      reason: "unknown",
      createdAt: at(-8 * DAY),
    });
    insertNotice(db, {
      id: "n1",
      kind: "agent_stopped",
      reason: "unknown",
      createdAt: at(1 * MINUTE),
    });
    insertNotice(db, {
      id: "n2",
      kind: "agent_stopped",
      reason: "unknown",
      createdAt: at(4 * MINUTE),
    });

    const byMarker = scanMissedNotices(db, {
      now: Date.parse(at(10 * MINUTE)),
      noticeScanAt: at(2 * MINUTE),
    });
    expect(byMarker.candidates.map((candidate) => candidate.noticeId)).toEqual(["n2"]);

    const byEnabled = scanMissedNotices(db, {
      now: Date.parse(at(10 * MINUTE)),
      noticeScanAt: at(1 * MINUTE),
      enabledAt: at(3 * MINUTE),
    });
    expect(byEnabled.candidates.map((candidate) => candidate.noticeId)).toEqual(["n2"]);

    const all = scanMissedNotices(db, { now: Date.parse(at(10 * MINUTE)) });
    expect(all.candidates.map((candidate) => candidate.noticeId)).toEqual(["n1", "n2"]);
  });
});

describe("decideWatermark", () => {
  const firstSweepAt = T0;

  it("initializes without notifying when no marker or timestamp exists", () => {
    expect(decideWatermark({ watermark: undefined, currentId: "msg_a1" })).toBe("initialize");
    expect(
      decideWatermark({
        watermark: undefined,
        currentId: "msg_a1",
        firstSweepAt,
      }),
    ).toBe("initialize");
  });

  it("initializes a pre-marker session silently and notifies a new one", () => {
    expect(
      decideWatermark({
        watermark: undefined,
        currentId: "msg_a1",
        sessionCreatedAt: Date.parse(T0) - MINUTE,
        firstSweepAt,
      }),
    ).toBe("initialize");
    expect(
      decideWatermark({
        watermark: undefined,
        currentId: "msg_a1",
        sessionCreatedAt: Date.parse(T0) + MINUTE,
        firstSweepAt,
      }),
    ).toBe("notify");
  });

  it("notifies on a differing id and skips an equal one", () => {
    expect(decideWatermark({ watermark: "msg_a0", currentId: "msg_a1" })).toBe("notify");
    expect(decideWatermark({ watermark: "msg_a1", currentId: "msg_a1" })).toBe("skip");
    expect(decideWatermark({ watermark: null, currentId: "msg_a1" })).toBe("notify");
  });
});
