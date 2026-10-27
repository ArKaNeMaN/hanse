import { describe, expect, it } from "vitest";
import {
  SESSION_RESUME_TTL_MS,
  type SessionResumeState,
  SessionResumeStore,
} from "../src/opencode/recovery.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const APP_ID = "p:a";
const START = "2026-10-27T10:00:00.000Z";
const T1 = "2026-10-27T10:01:00.000Z";
const T2 = "2026-10-27T10:02:00.000Z";

function database(): SqliteDatabase {
  const db = openDatabase(":memory:");
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', 'a', 'apps/a', 'AGENTS.md', ?)",
  ).run(APP_ID, now);
  return db;
}

function busy(store: SessionResumeStore, sessionId: string, at: string, extra = {}) {
  return store.upsertBusy({
    appId: APP_ID,
    sessionId,
    status: "busy",
    observedAt: at,
    runtimeStartedAt: START,
    runtimeRestartCount: 1,
    ...extra,
  });
}

function interrupt(store: SessionResumeStore, sessionId: string, key = "epoch-1|cycle-1", at = T2) {
  return store.markInterrupted({
    appId: APP_ID,
    sessionId,
    interruptedAt: at,
    interruptionEpoch: "epoch-1",
    interruptionKey: key,
    reason: "process_exit",
  });
}

describe("SessionResumeStore", () => {
  it("inserts a busy row with defaults and the observed runtime epoch", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      const row = busy(store, "ses_1", T1);

      expect(row).toMatchObject({
        appId: APP_ID,
        sessionId: "ses_1",
        parentSessionId: null,
        observedStatus: "busy",
        observedAt: T1,
        lastBusySeenAt: T1,
        interruptedAt: null,
        interruptionKey: null,
        runtimeStartedAt: START,
        runtimeRestartCount: 1,
        resumeState: "observing",
        dispatchState: "none",
        autoAttempts: 0,
        autoDispatchRetries: 0,
      });
    } finally {
      db.close();
    }
  });

  it("refreshes last_busy_seen_at on every successful busy and retry sample", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      busy(store, "ses_1", T1);
      const sampled = store.sampleBusy({
        appId: APP_ID,
        sessionId: "ses_1",
        status: "retry",
        observedAt: T2,
      });

      expect(sampled.lastBusySeenAt).toBe(T2);
      expect(sampled.updatedAt).toBe(T2);
      expect(sampled.observedAt).toBe(T2);
      expect(sampled.observedStatus).toBe("retry");

      const sameStatus = store.sampleBusy({
        appId: APP_ID,
        sessionId: "ses_1",
        status: "retry",
        observedAt: "2026-10-27T10:03:00.000Z",
      });
      expect(sameStatus.lastBusySeenAt).toBe("2026-10-27T10:03:00.000Z");
      expect(sameStatus.observedAt).toBe(T2);
    } finally {
      db.close();
    }
  });

  it("starts a new cycle after a terminal state and clears every cycle field", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      busy(store, "ses_1", T1);
      expect(interrupt(store, "ses_1")).toBe(true);
      store.setResumeState(APP_ID, "ses_1", "completed", {
        at: T2,
        dispatchState: "sent",
        autoAttempts: 1,
        lastAttemptAt: T1,
        resumeMessageId: "msg_previous",
        lastError: "previous failure",
      });

      const reset = busy(store, "ses_1", "2026-10-27T10:04:00.000Z");

      expect(reset).toMatchObject({
        interruptedAt: null,
        interruptionEpoch: null,
        interruptionKey: null,
        reason: null,
        resumeState: "observing",
        deferReason: null,
        dispatchState: "none",
        autoDispatchRetries: 0,
        autoAttempts: 0,
        lastAttemptAt: null,
        resumeMessageId: null,
        lastError: null,
        observedAt: "2026-10-27T10:04:00.000Z",
        lastBusySeenAt: "2026-10-27T10:04:00.000Z",
      });
    } finally {
      db.close();
    }
  });

  it("resets an interrupted cycle only when the caller does not preserve it", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      busy(store, "ses_1", T1);
      interrupt(store, "ses_1");

      const preserved = busy(store, "ses_1", T2, { preserveCycle: true });
      expect(preserved.interruptionKey).toBe("epoch-1|cycle-1");
      expect(preserved.interruptedAt).toBe(T2);

      const reset = busy(store, "ses_1", "2026-10-27T10:03:00.000Z");
      expect(reset.interruptionKey).toBeNull();
      expect(reset.interruptedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it("dedupes an interruption key transactionally and reports whether it changed", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      busy(store, "ses_1", T1);

      expect(interrupt(store, "ses_1", "epoch-1|cycle-1", T2)).toBe(true);
      expect(interrupt(store, "ses_1", "epoch-1|cycle-1", "2026-10-27T10:05:00.000Z")).toBe(false);
      expect(store.get(APP_ID, "ses_1")?.interruptedAt).toBe(T2);

      expect(interrupt(store, "ses_1", "epoch-2|cycle-1", "2026-10-27T10:06:00.000Z")).toBe(true);
      expect(store.get(APP_ID, "ses_1")?.interruptedAt).toBe("2026-10-27T10:06:00.000Z");
    } finally {
      db.close();
    }
  });

  it("applies the TTL to eligibility and keeps deferred rows out of it", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      busy(store, "ses_1", T1);
      interrupt(store, "ses_1", "epoch-1|cycle-1", T1);

      expect(store.listEligible({ now: T1 })).toHaveLength(1);
      const justInside = new Date(Date.parse(T1) + SESSION_RESUME_TTL_MS - 1).toISOString();
      expect(store.listEligible({ now: justInside })).toHaveLength(1);
      const outside = new Date(Date.parse(T1) + SESSION_RESUME_TTL_MS + 1).toISOString();
      expect(store.listEligible({ now: outside })).toHaveLength(0);

      expect(store.setDeferReason(APP_ID, "ses_1", "deployment_lock", T1)).toBe(true);
      const deferred = store.get(APP_ID, "ses_1");
      expect(deferred).toMatchObject({
        resumeState: "deferred",
        deferReason: "deployment_lock",
      });
      expect(store.listEligible({ now: T1 })).toHaveLength(0);
      expect(store.listDeferred()).toHaveLength(1);

      expect(store.setDeferReason(APP_ID, "ses_1", null, T1)).toBe(true);
      expect(store.get(APP_ID, "ses_1")).toMatchObject({
        resumeState: "observing",
        deferReason: null,
      });
      expect(store.listDeferred()).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("excludes stopped, stale, and missing terminal cycles from eligibility", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      const states: SessionResumeState[] = ["skipped_stopped", "skipped_stale", "skipped_missing"];
      for (const [index] of states.entries()) {
        const sessionId = `ses_${index}`;
        busy(store, sessionId, T1);
        interrupt(store, sessionId, `epoch-1|cycle-${index}`, T1);
      }
      expect(store.listEligible({ now: T1 })).toHaveLength(3);

      for (const [index, state] of states.entries()) {
        expect(store.setResumeState(APP_ID, `ses_${index}`, state, { at: T2 })).toBe(true);
        expect(store.listEligible({ now: T1 })).toHaveLength(states.length - index - 1);
      }
      expect(store.listEligible({ now: T1 })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("clears the defer reason when a non-deferred state is set", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      busy(store, "ses_1", T1);
      store.setDeferReason(APP_ID, "ses_1", "restart_claim", T1);
      expect(store.get(APP_ID, "ses_1")?.deferReason).toBe("restart_claim");

      store.setResumeState(APP_ID, "ses_1", "resumed", { at: T2 });
      expect(store.get(APP_ID, "ses_1")).toMatchObject({
        resumeState: "resumed",
        deferReason: null,
      });
    } finally {
      db.close();
    }
  });

  it("keeps child cycles out of top-level eligibility and deletes session rows", () => {
    const db = database();
    try {
      const store = new SessionResumeStore(db);
      busy(store, "ses_child", T1, { parentSessionId: "ses_parent" });
      interrupt(store, "ses_child");

      expect(store.get(APP_ID, "ses_child")?.parentSessionId).toBe("ses_parent");
      expect(store.listEligible({ now: T1 })).toHaveLength(0);

      expect(store.deleteSessionRows(APP_ID, "ses_child")).toBe(1);
      expect(store.get(APP_ID, "ses_child")).toBeUndefined();
      expect(store.deleteSessionRows(APP_ID, "ses_child")).toBe(0);
    } finally {
      db.close();
    }
  });
});
