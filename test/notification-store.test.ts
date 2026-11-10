import { describe, expect, it } from "vitest";
import { deleteSessionChatRows } from "../src/chat/state.js";
import type { NotificationChunkInput } from "../src/notifications/outbox.js";
import {
  capNotificationGroups,
  claimNextNotificationChunk,
  deleteNotificationWatermark,
  expirePendingNotifications,
  getNotificationChannelState,
  getNotificationMeta,
  getNotificationOutboxRow,
  getNotificationWatermark,
  insertNotificationGroup,
  listNotificationGroupRows,
  markNotificationChunkDead,
  markNotificationChunkSent,
  pruneSentAndDeadNotifications,
  resetSendingNotifications,
  writeNotificationChannelState,
  writeNotificationMeta,
  writeNotificationWatermark,
} from "../src/notifications/outbox.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const T0 = "2026-11-10T00:00:00.000Z";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function at(deltaMs: number, base = T0): string {
  return new Date(Date.parse(base) + deltaMs).toISOString();
}

function createDb(): ReturnType<typeof openDatabase> {
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

function groupChunks(
  prefix: string,
  count: number,
  overrides: Partial<NotificationChunkInput> = {},
): NotificationChunkInput[] {
  return Array.from({ length: count }, (_, index) => ({
    chunkIndex: index,
    dedupeKey: `${prefix}:${index}`,
    kind: "turn_completed" as const,
    scope: "app" as const,
    projectId: "p",
    appKey: "a",
    appId: "a1",
    sessionId: "ses_1",
    payloadJson: JSON.stringify({ text: `${prefix}:${index}` }),
    ...overrides,
  }));
}

function expectChunk(
  row: ReturnType<typeof claimNextNotificationChunk>,
): NonNullable<ReturnType<typeof claimNextNotificationChunk>> {
  expect(row).toBeDefined();
  if (row === undefined) {
    throw new Error("expected a claimable notification chunk");
  }
  return row;
}

describe("notification outbox store", () => {
  it("inserts a group transactionally, dedupes by key, and claims in chunk order", () => {
    const db = createDb();
    const input = { groupId: "g1", createdAt: T0, chunks: groupChunks("g1", 3) };
    const first = insertNotificationGroup(db, input);
    expect(first.inserted).toBe(3);
    expect(first.rows.map((row) => row.chunkIndex)).toEqual([0, 1, 2]);
    expect(first.rows.every((row) => row.chunkCount === 3 && row.state === "pending")).toBe(true);

    expect(insertNotificationGroup(db, input).inserted).toBe(0);
    expect(() =>
      insertNotificationGroup(db, {
        groupId: "g1",
        createdAt: T0,
        chunks: [{ ...groupChunks("other", 1)[0], dedupeKey: "other:0" }],
      }),
    ).toThrow();

    const chunk0 = expectChunk(claimNextNotificationChunk(db, T0));
    expect(chunk0.chunkIndex).toBe(0);
    expect(chunk0.state).toBe("sending");
    expect(claimNextNotificationChunk(db, T0)).toBeUndefined();

    markNotificationChunkSent(db, chunk0.id, T0);
    const chunk1 = expectChunk(claimNextNotificationChunk(db, T0));
    expect(chunk1.chunkIndex).toBe(1);
    markNotificationChunkSent(db, chunk1.id, T0);
    expect(expectChunk(claimNextNotificationChunk(db, T0)).chunkIndex).toBe(2);
    db.close();
  });

  it("never claims a later chunk while an earlier chunk of the group is not sent", () => {
    const db = createDb();
    insertNotificationGroup(db, {
      groupId: "g1",
      createdAt: T0,
      chunks: groupChunks("g1", 2),
    });
    insertNotificationGroup(db, {
      groupId: "g2",
      createdAt: at(MINUTE),
      chunks: groupChunks("g2", 1),
    });

    const chunk0 = expectChunk(claimNextNotificationChunk(db, at(MINUTE)));
    expect(chunk0.groupId).toBe("g1");
    expect(chunk0.chunkIndex).toBe(0);

    const other = expectChunk(claimNextNotificationChunk(db, at(MINUTE)));
    expect(other.groupId).toBe("g2");
    expect(other.chunkIndex).toBe(0);
    db.close();
  });

  it("does not claim a chunk before next_attempt_at", () => {
    const db = createDb();
    insertNotificationGroup(db, {
      groupId: "g1",
      createdAt: T0,
      chunks: groupChunks("g1", 1, { nextAttemptAt: at(5000) }),
    });
    expect(claimNextNotificationChunk(db, T0)).toBeUndefined();
    expect(expectChunk(claimNextNotificationChunk(db, at(5000))).chunkIndex).toBe(0);
    db.close();
  });

  it("marks a dead chunk's group dead without touching a sent chunk", () => {
    const db = createDb();
    insertNotificationGroup(db, {
      groupId: "g1",
      createdAt: T0,
      chunks: groupChunks("g1", 3),
    });
    const chunk0 = expectChunk(claimNextNotificationChunk(db, T0));
    markNotificationChunkDead(db, chunk0.id, "telegram_format", "bad markdown", T0);

    const rows = listNotificationGroupRows(db, "g1");
    expect(rows.map((row) => row.state)).toEqual(["dead", "dead", "dead"]);
    expect(rows.map((row) => row.errorCode)).toEqual([
      "telegram_format",
      "chunk_failed",
      "chunk_failed",
    ]);
    expect(rows.every((row) => row.payloadJson === "{}")).toBe(true);
    expect(claimNextNotificationChunk(db, T0)).toBeUndefined();

    insertNotificationGroup(db, {
      groupId: "g2",
      createdAt: at(MINUTE),
      chunks: groupChunks("g2", 3),
    });
    const sent = expectChunk(claimNextNotificationChunk(db, at(MINUTE)));
    markNotificationChunkSent(db, sent.id, at(MINUTE));
    const failed = expectChunk(claimNextNotificationChunk(db, at(MINUTE)));
    markNotificationChunkDead(db, failed.id, "telegram_unauthorized", null, at(MINUTE));

    const g2 = listNotificationGroupRows(db, "g2");
    expect(g2.map((row) => row.state)).toEqual(["sent", "dead", "dead"]);
    expect(g2[0].sentAt).toBe(at(MINUTE));
    db.close();
  });

  it("resets sending rows on boot", () => {
    const db = createDb();
    insertNotificationGroup(db, {
      groupId: "g1",
      createdAt: T0,
      chunks: groupChunks("g1", 2),
    });
    const chunk0 = expectChunk(claimNextNotificationChunk(db, T0));
    expect(getNotificationOutboxRow(db, chunk0.id)?.state).toBe("sending");

    expect(resetSendingNotifications(db, at(MINUTE))).toBe(1);
    expect(getNotificationOutboxRow(db, chunk0.id)?.state).toBe("pending");
    expect(expectChunk(claimNextNotificationChunk(db, at(MINUTE))).chunkIndex).toBe(0);
    db.close();
  });

  it("prunes old sent/dead rows but keeps pending rows and recent sends", () => {
    const db = createDb();
    const old = at(-40 * DAY);

    insertNotificationGroup(db, {
      groupId: "old-sent",
      createdAt: old,
      chunks: groupChunks("old-sent", 1),
    });
    markNotificationChunkSent(db, expectChunk(claimNextNotificationChunk(db, old)).id, old);

    insertNotificationGroup(db, {
      groupId: "old-dead",
      createdAt: old,
      chunks: groupChunks("old-dead", 1),
    });
    markNotificationChunkDead(
      db,
      expectChunk(claimNextNotificationChunk(db, old)).id,
      "telegram_format",
      null,
      old,
    );

    insertNotificationGroup(db, {
      groupId: "recent-sent",
      createdAt: T0,
      chunks: groupChunks("recent-sent", 1),
    });
    markNotificationChunkSent(db, expectChunk(claimNextNotificationChunk(db, T0)).id, T0);

    insertNotificationGroup(db, {
      groupId: "old-pending",
      createdAt: old,
      chunks: groupChunks("old-pending", 1),
    });

    expect(pruneSentAndDeadNotifications(db, { now: T0, retentionMs: 30 * DAY })).toBe(2);
    expect(listNotificationGroupRows(db, "old-sent")).toEqual([]);
    expect(listNotificationGroupRows(db, "old-dead")).toEqual([]);
    expect(listNotificationGroupRows(db, "recent-sent")[0].state).toBe("sent");
    expect(listNotificationGroupRows(db, "old-pending")[0].state).toBe("pending");
    db.close();
  });

  it("caps by whole groups, preferring turn_completed and never deleting sending/sent groups", () => {
    const db = createDb();

    insertNotificationGroup(db, {
      groupId: "protected",
      createdAt: at(2 * MINUTE),
      chunks: groupChunks("protected", 2),
    });
    const protectedChunk = expectChunk(claimNextNotificationChunk(db, at(2 * MINUTE)));
    markNotificationChunkSent(db, protectedChunk.id, at(2 * MINUTE));

    insertNotificationGroup(db, {
      groupId: "question-old",
      createdAt: T0,
      chunks: groupChunks("question-old", 1, { kind: "question" }),
    });
    insertNotificationGroup(db, {
      groupId: "turn-old",
      createdAt: at(MINUTE),
      chunks: groupChunks("turn-old", 1),
    });
    insertNotificationGroup(db, {
      groupId: "question-new",
      createdAt: at(3 * MINUTE),
      chunks: groupChunks("question-new", 1, { kind: "question" }),
    });

    expect(capNotificationGroups(db, { maxGroups: 2 })).toBe(2);
    expect(listNotificationGroupRows(db, "turn-old")).toEqual([]);
    expect(listNotificationGroupRows(db, "question-old")).toEqual([]);
    expect(listNotificationGroupRows(db, "protected").map((row) => row.state)).toEqual([
      "sent",
      "pending",
    ]);
    expect(listNotificationGroupRows(db, "question-new")[0].state).toBe("pending");
    db.close();
  });

  it("expires 7-day pending payloads, clears them, and closes the group", () => {
    const db = createDb();
    const old = at(-8 * DAY);

    insertNotificationGroup(db, {
      groupId: "g2",
      createdAt: old,
      chunks: groupChunks("g2", 2),
    });
    const sent = expectChunk(claimNextNotificationChunk(db, old));
    markNotificationChunkSent(db, sent.id, old);

    insertNotificationGroup(db, {
      groupId: "g1",
      createdAt: old,
      chunks: groupChunks("g1", 2),
    });

    expect(expirePendingNotifications(db, { now: T0 })).toBe(2);
    const g1 = listNotificationGroupRows(db, "g1");
    expect(g1.map((row) => row.state)).toEqual(["dead", "dead"]);
    expect(g1.map((row) => row.errorCode)).toEqual(["expired", "chunk_failed"]);
    expect(g1.every((row) => row.payloadJson === "{}")).toBe(true);

    const g2 = listNotificationGroupRows(db, "g2");
    expect(g2.map((row) => row.state)).toEqual(["sent", "dead"]);
    expect(g2[1].errorCode).toBe("expired");
    expect(g2[1].payloadJson).toBe("{}");
    db.close();
  });

  it("reads and writes watermarks, meta, and channel state", () => {
    const db = createDb();

    const first = writeNotificationWatermark(db, "a1", "ses_1", "m1", T0);
    expect(first).toEqual({
      appId: "a1",
      sessionId: "ses_1",
      lastNotifiedMessageId: "m1",
      initializedAt: T0,
      updatedAt: T0,
    });
    const second = writeNotificationWatermark(db, "a1", "ses_1", "m2", at(MINUTE));
    expect(second.lastNotifiedMessageId).toBe("m2");
    expect(second.initializedAt).toBe(T0);
    expect(second.updatedAt).toBe(at(MINUTE));
    expect(getNotificationWatermark(db, "a1", "ses_1")).toEqual(second);
    expect(deleteNotificationWatermark(db, "a1", "ses_1")).toBe(1);
    expect(getNotificationWatermark(db, "a1", "ses_1")).toBeUndefined();

    expect(getNotificationMeta(db, "telegram.enabled_at")).toBeUndefined();
    writeNotificationMeta(db, "telegram.enabled_at", "t1", T0);
    const meta = writeNotificationMeta(db, "telegram.enabled_at", "t2", at(MINUTE));
    expect(meta).toEqual({ key: "telegram.enabled_at", value: "t2", updatedAt: at(MINUTE) });
    expect(getNotificationMeta(db, "telegram.enabled_at")).toBe("t2");

    expect(getNotificationChannelState(db, "telegram")).toBeUndefined();
    writeNotificationChannelState(db, "telegram", "ok", null, T0);
    const error = writeNotificationChannelState(db, "telegram", "error", "bad token", at(MINUTE));
    expect(error).toEqual({
      channel: "telegram",
      state: "error",
      lastError: "bad token",
      updatedAt: at(MINUTE),
    });
    expect(getNotificationChannelState(db, "telegram")).toEqual(error);
    db.close();
  });

  it("deletes the session watermark with chat rows and cascades app rows", () => {
    const db = createDb();
    insertNotificationGroup(db, {
      groupId: "g1",
      createdAt: T0,
      chunks: groupChunks("g1", 1),
    });
    writeNotificationWatermark(db, "a1", "ses_1", "m1", T0);
    writeNotificationWatermark(db, "a1", "ses_2", "m2", T0);

    deleteSessionChatRows(db, "a1", "ses_1");
    expect(getNotificationWatermark(db, "a1", "ses_1")).toBeUndefined();
    expect(getNotificationWatermark(db, "a1", "ses_2")).toBeDefined();
    expect(listNotificationGroupRows(db, "g1")).toHaveLength(1);

    db.prepare("DELETE FROM apps WHERE id = 'a1'").run();
    expect(listNotificationGroupRows(db, "g1")).toEqual([]);
    expect(getNotificationWatermark(db, "a1", "ses_2")).toBeUndefined();
    db.close();
  });
});
