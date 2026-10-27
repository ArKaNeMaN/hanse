import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSessionChatRows, localSessionBlockReason } from "../src/chat/state.js";
import { ChatSweep } from "../src/chat/sweep.js";
import {
  SESSION_NOTICE_MAX_PER_SESSION,
  SESSION_NOTICE_PAYLOAD_MAX_BYTES,
  SessionNoticeStore,
  SessionResumeStore,
} from "../src/opencode/recovery.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const APP_ID = "p:a";
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
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

function database(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
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

function noticeInput(
  overrides: Partial<Parameters<SessionNoticeStore["record"]>[0]> = {},
): Parameters<SessionNoticeStore["record"]>[0] {
  return {
    appId: APP_ID,
    sessionId: "ses_1",
    dedupeKey: "epoch-1|cycle-1|agent_stopped",
    kind: "agent_stopped",
    reason: "process_exit",
    payload: { exitCode: 137, oomKilled: true },
    createdAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

function count(db: SqliteDatabase, table: string, sessionId = "ses_1"): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE app_id = ? AND session_id = ?`)
    .get(APP_ID, sessionId) as { count: number };
  return row.count;
}

describe("SessionNoticeStore", () => {
  it("records a bounded coordinator-generated notice", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);

    const notice = await store.record(noticeInput());

    expect(notice).toMatchObject({
      appId: APP_ID,
      sessionId: "ses_1",
      kind: "agent_stopped",
      reason: "process_exit",
      payload: { exitCode: 137, oomKilled: true },
      createdAt: "2026-10-27T10:00:00.000Z",
    });
    expect(notice?.id).toMatch(/^notice_[0-9a-f-]{36}$/);
    expect(notice).not.toHaveProperty("parentSessionId");
    expect(store.list(APP_ID, "ses_1").notices).toHaveLength(1);
  });

  it("dedupes transactionally through session_notice_dedupe", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);

    const first = await store.record(noticeInput());
    const second = await store.record(noticeInput());
    const changed = await store.record(noticeInput({ createdAt: "2026-10-27T10:01:00.000Z" }));

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(changed).toBeUndefined();
    expect(count(db, "session_notices")).toBe(1);
    expect(count(db, "session_notice_dedupe")).toBe(1);
  });

  it("caps notices at 50 while preserving dedupe evidence for pruned rows", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);
    const base = Date.parse("2026-10-27T10:00:00.000Z");

    for (let index = 0; index < SESSION_NOTICE_MAX_PER_SESSION + 5; index += 1) {
      const notice = await store.record(
        noticeInput({
          dedupeKey: `cycle-${index}`,
          createdAt: new Date(base + index).toISOString(),
        }),
      );
      expect(notice).toBeDefined();
    }

    expect(count(db, "session_notices")).toBe(SESSION_NOTICE_MAX_PER_SESSION);
    expect(count(db, "session_notice_dedupe")).toBe(SESSION_NOTICE_MAX_PER_SESSION + 5);
    expect(await store.record(noticeInput({ dedupeKey: "cycle-0" }))).toBeUndefined();
    expect(count(db, "session_notices")).toBe(SESSION_NOTICE_MAX_PER_SESSION);
  });

  it("keeps parent and child notices independent with the same dedupe key", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);

    const parent = await store.record(
      noticeInput({
        sessionId: "ses_parent",
        kind: "subagent_interrupted",
        reason: "subagent_abort",
        dedupeKey: "child|epoch-1",
        createdAt: "2026-10-27T10:00:00.000Z",
      }),
    );
    const child = await store.record(
      noticeInput({
        sessionId: "ses_child",
        parentSessionId: "ses_parent",
        kind: "subagent_interrupted",
        reason: "subagent_abort",
        dedupeKey: "child|epoch-1",
        createdAt: "2026-10-27T10:01:00.000Z",
      }),
    );

    expect(parent).toBeDefined();
    expect(child).toMatchObject({ parentSessionId: "ses_parent" });
    expect(store.list(APP_ID, "ses_parent").notices).toHaveLength(1);
    expect(store.list(APP_ID, "ses_child").notices).toHaveLength(1);
  });

  it("rejects payloads over the 4 KiB bound", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);

    expect(() =>
      store.record(
        noticeInput({
          payload: { text: "x".repeat(SESSION_NOTICE_PAYLOAD_MAX_BYTES + 1) },
        }),
      ),
    ).toThrow(/exceeds/);
    expect(count(db, "session_notices")).toBe(0);
  });

  it("paginates with an opaque before cursor and no overlap", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);
    const base = Date.parse("2026-10-27T10:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      await store.record(
        noticeInput({
          dedupeKey: `page-${index}`,
          createdAt: new Date(base + index).toISOString(),
        }),
      );
    }

    const first = store.list(APP_ID, "ses_1", { limit: 2 });
    expect(first.notices).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = store.list(APP_ID, "ses_1", {
      limit: 2,
      before: first.nextCursor,
    });
    expect(second.notices).toHaveLength(2);
    expect(second.nextCursor).not.toBeNull();

    const third = store.list(APP_ID, "ses_1", {
      limit: 2,
      before: second.nextCursor,
    });
    expect(third.notices).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const ids = new Set([
      ...first.notices.map((notice) => notice.id),
      ...second.notices.map((notice) => notice.id),
      ...third.notices.map((notice) => notice.id),
    ]);
    expect(ids.size).toBe(5);
  });

  it("composes the interruption guard and notice dedupe in one transaction", () => {
    const db = database();
    const resumes = new SessionResumeStore(db);
    const notices = new SessionNoticeStore(db);
    resumes.upsertBusy({
      appId: APP_ID,
      sessionId: "ses_1",
      status: "busy",
      observedAt: "2026-10-27T10:00:00.000Z",
    });
    const cycle = db.transaction(() => {
      const changed = resumes.markInterrupted({
        appId: APP_ID,
        sessionId: "ses_1",
        interruptedAt: "2026-10-27T10:01:00.000Z",
        interruptionEpoch: "epoch-1",
        interruptionKey: "epoch-1|cycle-1",
      });
      if (!changed) return undefined;
      return notices.record(
        noticeInput({
          dedupeKey: "epoch-1|cycle-1|agent_stopped",
          sessionExists: true,
        }),
      );
    });

    expect(cycle()).toBeDefined();
    expect(cycle()).toBeUndefined();
    expect(count(db, "session_notices")).toBe(1);
    expect(count(db, "session_notice_dedupe")).toBe(1);
  });

  it("skips writes for a deleting app or a vanished upstream session", async () => {
    const db = database();
    const store = new SessionNoticeStore(db, { sessionExists: () => false });
    expect(await store.record(noticeInput())).toBeUndefined();
    expect(await store.record(noticeInput({ sessionExists: false }))).toBeUndefined();
    expect(count(db, "session_notices")).toBe(0);

    db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(APP_ID);
    const existing = new SessionNoticeStore(db, { sessionExists: () => true });
    expect(await existing.record(noticeInput())).toBeUndefined();
    expect(count(db, "session_notices")).toBe(0);
  });

  it("prunes and deletes session rows without touching other sessions", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);
    const base = Date.parse("2026-10-27T10:00:00.000Z");
    for (let index = 0; index < 4; index += 1) {
      await store.record(
        noticeInput({
          dedupeKey: `prune-${index}`,
          createdAt: new Date(base + index).toISOString(),
        }),
      );
    }
    await store.record(noticeInput({ sessionId: "ses_other", dedupeKey: "other" }));

    expect(store.prune(APP_ID, "ses_1", 2)).toBe(2);
    expect(count(db, "session_notices", "ses_1")).toBe(2);
    expect(count(db, "session_notice_dedupe", "ses_1")).toBe(4);

    expect(store.deleteSessionRows(APP_ID, "ses_1")).toBe(6);
    expect(count(db, "session_notices", "ses_1")).toBe(0);
    expect(count(db, "session_notice_dedupe", "ses_1")).toBe(0);
    expect(count(db, "session_notices", "ses_other")).toBe(1);
  });

  it("cascades notice rows when the app is deleted", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);
    await store.record(noticeInput());

    db.prepare("DELETE FROM apps WHERE id = ?").run(APP_ID);

    expect(count(db, "session_notices")).toBe(0);
    expect(count(db, "session_notice_dedupe")).toBe(0);
  });
});

describe("notice lifecycle integration", () => {
  it("blocks delete-if-empty on a notice and clears all process rows", async () => {
    const db = database();
    const store = new SessionNoticeStore(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO session_state (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
       VALUES (?, 'ses_1', 0, ?, ?, ?)`,
    ).run(APP_ID, now, now, now);
    await store.record(noticeInput());
    db.prepare(
      `INSERT INTO session_resume
         (app_id, session_id, observed_status, observed_at, last_busy_seen_at, created_at, updated_at)
       VALUES (?, 'ses_1', 'busy', ?, ?, ?, ?)`,
    ).run(APP_ID, now, now, now, now);

    expect(localSessionBlockReason(db, APP_ID, "ses_1")).toBe("has_notice");

    deleteSessionChatRows(db, APP_ID, "ses_1");
    expect(localSessionBlockReason(db, APP_ID, "ses_1")).toBeUndefined();
    expect(count(db, "session_notices")).toBe(0);
    expect(count(db, "session_notice_dedupe")).toBe(0);
    expect(count(db, "session_resume")).toBe(0);
  });

  it("sweeps a vanished notice-only session but keeps a live one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-notice-sweep-"));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, "coordinator.db"));
    databases.push(db);
    runMigrations(db);
    const now = Date.parse("2026-10-24T00:00:00.000Z");
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
    ).run(old, old);
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', 'a', 'apps/a', 'AGENTS.md', ?)",
    ).run(APP_ID, old);
    db.prepare(
      `INSERT INTO session_state (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?)`,
    ).run(APP_ID, "ses_gone", old, old, old);
    db.prepare(
      `INSERT INTO session_state (app_id, session_id, has_messages, last_activity_at, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?)`,
    ).run(APP_ID, "ses_live", old, old, old);

    const notices = new SessionNoticeStore(db);
    const resumes = new SessionResumeStore(db);
    for (const sessionId of ["ses_gone", "ses_live"]) {
      await notices.record(
        noticeInput({ sessionId, dedupeKey: `stop|${sessionId}`, createdAt: old }),
      );
      resumes.upsertBusy({
        appId: APP_ID,
        sessionId,
        status: "busy",
        observedAt: old,
        runtimeStartedAt: old,
        runtimeRestartCount: 0,
      });
      resumes.markInterrupted({
        appId: APP_ID,
        sessionId,
        interruptedAt: old,
        interruptionEpoch: old,
        interruptionKey: `epoch|${sessionId}`,
      });
    }

    let live = false;
    const server = createServer((incoming, outgoing) => {
      if (incoming.method === "GET" && incoming.url === "/session/ses_live") {
        live = true;
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ id: "ses_live" }));
        return;
      }
      outgoing.writeHead(404, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "not found" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const sweep = new ChatSweep({
      db,
      agentsHome: dir,
      endpointFor: () => `http://127.0.0.1:${address.port}`,
      now: () => now,
    });

    await sweep.runOnce();

    expect(live).toBe(true);
    expect(count(db, "session_notices", "ses_gone")).toBe(0);
    expect(count(db, "session_notice_dedupe", "ses_gone")).toBe(0);
    expect(count(db, "session_resume", "ses_gone")).toBe(0);
    const goneState = db
      .prepare("SELECT 1 AS present FROM session_state WHERE app_id = ? AND session_id = ?")
      .get(APP_ID, "ses_gone");
    expect(goneState).toBeUndefined();

    expect(count(db, "session_notices", "ses_live")).toBe(1);
    expect(count(db, "session_resume", "ses_live")).toBe(1);
    expect(localSessionBlockReason(db, APP_ID, "ses_live")).toBe("has_notice");
  });
});
