import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NOTIFICATION_META_KEYS } from "../src/notifications/catch-up.js";
import {
  hasInflightOneShotHandoff,
  hasOutstandingThreadWork,
  hasUnboundHandoffInGrace,
  NOTIFY_OCCURRENCE_BUCKET_MS,
  type NotificationEffectiveSettings,
  NotificationRouter,
  type NotificationSettingsSource,
} from "../src/notifications/router.js";
import type {
  OpencodeMessage,
  OpencodeSession,
  OpencodeSessionStatus,
} from "../src/opencode/client.js";
import type { SessionActivitySnapshot } from "../src/opencode/context.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import {
  getNotificationMeta,
  getNotificationWatermark,
  insertNotificationGroup,
  listNotificationGroupRows,
  writeNotificationMeta,
  writeNotificationWatermark,
} from "../src/store/notifications.js";
import {
  assistantMessage,
  idleStatus,
  textPart,
  toolPart,
  userMessage,
} from "./fixtures/chat-turn.js";

const T0 = "2026-11-10T00:00:00.000Z";
const T_NOW = Date.parse("2026-11-10T12:00:00.000Z");
const SESSION_ID = "ses_turn";

const databases: SqliteDatabase[] = [];
const servers: Server[] = [];
const routers: NotificationRouter[] = [];

afterEach(async () => {
  for (const router of routers.splice(0)) router.stop();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases.splice(0)) db.close();
});

interface Upstream {
  endpoint: string;
  sessions: OpencodeSession[];
  statuses: Record<string, OpencodeSessionStatus>;
  messages: OpencodeMessage[];
  questions: unknown[];
  permissions: unknown[];
  messageResponse?: { status: number; body: string };
}

async function fakeUpstream(init: {
  sessions?: OpencodeSession[];
  statuses?: Record<string, OpencodeSessionStatus>;
  messages?: OpencodeMessage[];
  questions?: unknown[];
  permissions?: unknown[];
  messageResponse?: { status: number; body: string };
}): Promise<Upstream> {
  const upstream: Upstream = {
    endpoint: "",
    sessions: init.sessions ?? [{ id: SESSION_ID, title: "Session", time: { created: T_NOW } }],
    statuses: init.statuses ?? { [SESSION_ID]: idleStatus },
    messages: init.messages ?? completedTurn(),
    questions: init.questions ?? [],
    permissions: init.permissions ?? [],
    ...(init.messageResponse === undefined ? {} : { messageResponse: init.messageResponse }),
  };
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const send = (body: unknown): void => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(body));
    };
    if (url.pathname === "/session") {
      send(upstream.sessions);
      return;
    }
    if (url.pathname === "/session/status") {
      send(upstream.statuses);
      return;
    }
    if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message")) {
      if (upstream.messageResponse !== undefined) {
        outgoing.writeHead(upstream.messageResponse.status, { "content-type": "application/json" });
        outgoing.end(upstream.messageResponse.body);
        return;
      }
      send(upstream.messages);
      return;
    }
    if (
      url.pathname === "/question" ||
      url.pathname === "/permission" ||
      url.pathname === "/api/question/request" ||
      url.pathname === "/api/permission/request"
    ) {
      send(url.pathname.includes("question") ? upstream.questions : upstream.permissions);
      return;
    }
    outgoing.writeHead(404, { "content-type": "application/json" });
    outgoing.end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  upstream.endpoint = `http://127.0.0.1:${address.port}`;
  return upstream;
}

function createDb(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Project','main','/tmp',?,?)",
  ).run(T0, T0);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a1','p1','app','/tmp/app','AGENTS.md',?)",
  ).run(T0);
  return db;
}

function completedTurn(): OpencodeMessage[] {
  return [
    userMessage("msg_u1", [textPart("run")], { sessionID: SESSION_ID }),
    assistantMessage("msg_a1", [textPart("the answer")], {
      sessionID: SESSION_ID,
      parentID: "msg_u1",
      finish: "stop",
      completed: true,
    }),
  ];
}

function effective(
  overrides: Partial<{
    mode: "off" | "attention" | "all";
    enabled: boolean;
    includeAnswer: boolean;
    publicBaseUrl: string | null;
  }> = {},
): NotificationEffectiveSettings {
  const value = <T>(input: T) => ({
    value: input,
    state: "set" as const,
    source: "global" as const,
    sources: ["global"],
  });
  return {
    notifications: {
      mode: value(overrides.mode ?? "all"),
      telegram: {
        enabled: value(overrides.enabled ?? true),
        chatId: value("-100"),
        apiBaseUrl: value("https://api.telegram.org"),
      },
      publicBaseUrl: value(overrides.publicBaseUrl ?? "https://hanse.test"),
      includeAnswer: value(overrides.includeAnswer ?? true),
    },
  };
}

function settingsFor(overrides: Parameters<typeof effective>[0] = {}): NotificationSettingsSource {
  return { resolve: () => ({ effective: effective(overrides) }) };
}

interface Fixture {
  db: SqliteDatabase;
  upstream: Upstream;
  router: NotificationRouter;
  setActivity(activity: SessionActivitySnapshot): void;
}

async function fixture(
  init: {
    sessions?: OpencodeSession[];
    statuses?: Record<string, OpencodeSessionStatus>;
    messages?: OpencodeMessage[];
    questions?: unknown[];
    permissions?: unknown[];
    messageResponse?: { status: number; body: string };
    settings?: Parameters<typeof settingsFor>[0];
    activity?: SessionActivitySnapshot;
    now?: number;
  } = {},
): Promise<Fixture> {
  const db = createDb();
  const upstream = await fakeUpstream(init);
  let activity: SessionActivitySnapshot = init.activity ?? {
    activeChildren: false,
    pendingTask: false,
    known: true,
  };
  const router = new NotificationRouter({
    db,
    manager: {
      endpointFor: () => upstream.endpoint,
      sessionActivity: async () => activity,
    },
    settings: settingsFor(init.settings),
    now: () => init.now ?? T_NOW,
  });
  routers.push(router);
  return {
    db,
    upstream,
    router,
    setActivity(next) {
      activity = next;
    },
  };
}

function activate(db: SqliteDatabase, watermark = "msg_a0"): void {
  writeNotificationMeta(db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
  writeNotificationMeta(db, NOTIFICATION_META_KEYS.enabledAt, T0, T0);
  writeNotificationMeta(db, NOTIFICATION_META_KEYS.channelEnabled, "true", T0);
  writeNotificationWatermark(db, "a1", SESSION_ID, watermark, T0);
}

function rows(db: SqliteDatabase): ReturnType<typeof listNotificationGroupRows> {
  return db
    .prepare("SELECT group_id FROM notification_outbox ORDER BY created_at, chunk_index")
    .all()
    .flatMap((row) => listNotificationGroupRows(db, (row as { group_id: string }).group_id));
}

function insertHandoff(
  db: SqliteDatabase,
  input: {
    id: string;
    mode?: "one_shot" | "thread";
    state?: string;
    sourceSessionId?: string | null;
    invokingSessionId?: string | null;
    createdAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO handoffs
       (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key,
        mode, source_session_id, source_invoking_session_id, created_at, updated_at)
     VALUES (?, 'p1', 'a1', 'a1', ?, 'summary', 'spec', ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.state ?? "in_progress",
    `idem-${input.id}`,
    input.mode ?? "one_shot",
    input.sourceSessionId === undefined ? SESSION_ID : input.sourceSessionId,
    input.invokingSessionId ?? null,
    input.createdAt ?? T0,
    input.createdAt ?? T0,
  );
}

function insertThreadMessage(
  db: SqliteDatabase,
  input: { handoffId: string; id?: number; kind?: string; state?: string; authorSide?: string },
): void {
  db.prepare(
    `INSERT INTO handoff_messages (handoff_id, seq, kind, body, created_at, author_side, state)
     VALUES (?, 1, ?, 'body', ?, ?, ?)`,
  ).run(
    input.handoffId,
    input.kind ?? "request",
    T0,
    input.authorSide ?? "source",
    input.state ?? "queued",
  );
}

describe("completion predicate", () => {
  it("enqueues exactly one completion group for a normal finished turn", async () => {
    const f = await fixture();
    activate(f.db);
    await f.router.sweep();

    const outbox = rows(f.db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      kind: "turn_completed",
      scope: "app",
      projectId: "p1",
      appKey: "app",
      appId: "a1",
      sessionId: SESSION_ID,
      chunkIndex: 0,
      chunkCount: 1,
      dedupeKey: `turn:a1:${SESSION_ID}:msg_a1:0`,
    });
    expect(JSON.parse(outbox[0]?.payloadJson ?? "{}")).toMatchObject({
      text: expect.stringContaining("the answer"),
      link: { text: "Open session", url: expect.stringContaining("/chat?app=app&project=p1") },
    });
    expect(getNotificationWatermark(f.db, "a1", SESSION_ID)?.lastNotifiedMessageId).toBe("msg_a1");
  });

  it("uses the last text answer, not a trailing tool-only assistant", async () => {
    const messages = [
      userMessage("msg_u1", [textPart("run")], { sessionID: SESSION_ID }),
      assistantMessage("msg_a1", [textPart("first answer")], {
        sessionID: SESSION_ID,
        parentID: "msg_u1",
        finish: "tool-calls",
        completed: true,
      }),
      assistantMessage("msg_a2", [toolPart()], {
        sessionID: SESSION_ID,
        parentID: "msg_u1",
        finish: "tool-calls",
        completed: true,
      }),
    ];
    const f = await fixture({ messages });
    activate(f.db);
    await f.router.sweep();

    const outbox = rows(f.db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.dedupeKey).toBe(`turn:a1:${SESSION_ID}:msg_a1:0`);
    expect(JSON.parse(outbox[0]?.payloadJson ?? "{}").text).toContain("first answer");
  });

  it("sends a distinct Done for a tool-only turn after a text turn and never duplicates it", async () => {
    const createdAt = T_NOW - 1_000;
    const messages = [
      userMessage("msg_u1", [textPart("first")], { sessionID: SESSION_ID }),
      assistantMessage("msg_a1", [textPart("first answer")], {
        sessionID: SESSION_ID,
        parentID: "msg_u1",
        finish: "stop",
        completed: true,
      }),
      userMessage("msg_u2", [textPart("second")], {
        sessionID: SESSION_ID,
        createdAt,
      }),
      assistantMessage("msg_a2", [toolPart()], {
        sessionID: SESSION_ID,
        parentID: "msg_u2",
        finish: "stop",
        completed: true,
      }),
    ];
    const f = await fixture({ messages });
    activate(f.db, "msg_a1");
    await f.router.sweep();

    const outbox = rows(f.db);
    const bucket = Math.floor(createdAt / NOTIFY_OCCURRENCE_BUCKET_MS);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.dedupeKey).toBe(`turn:a1:${SESSION_ID}:msg_u2:${bucket}:0`);
    expect(JSON.parse(outbox[0]?.payloadJson ?? "{}").text).toContain("Done");

    await f.router.sweep();
    expect(rows(f.db)).toHaveLength(1);
  });

  it("suppresses a running child, pending task, and unknown tracker", async () => {
    for (const activity of [
      { activeChildren: true, pendingTask: false, known: true },
      { activeChildren: false, pendingTask: true, known: true },
      { activeChildren: false, pendingTask: false, known: false },
    ]) {
      const f = await fixture({ activity });
      activate(f.db);
      await f.router.sweep();
      expect(rows(f.db)).toHaveLength(0);
      expect(getNotificationWatermark(f.db, "a1", SESSION_ID)?.lastNotifiedMessageId).toBe(
        "msg_a0",
      );
    }
  });

  it("defers on a queued prompt and on a settling or truncated turn read", async () => {
    const queued = await fixture({
      messages: [
        ...completedTurn(),
        userMessage("msg_u2", [textPart("queued")], { sessionID: SESSION_ID }),
      ],
    });
    activate(queued.db);
    await queued.router.sweep();
    expect(rows(queued.db)).toHaveLength(0);

    const tooLarge = await fixture({
      messageResponse: { status: 200, body: "x".repeat(3 * 1024 * 1024) },
    });
    activate(tooLarge.db);
    await tooLarge.router.sweep();
    expect(rows(tooLarge.db)).toHaveLength(0);
  });

  it("defers while a child is blocked on a question or permission", async () => {
    const sessions: OpencodeSession[] = [
      { id: SESSION_ID, time: { created: T_NOW } },
      { id: "ses_child", parentID: SESSION_ID, time: { created: T_NOW } },
    ];
    const question = await fixture({
      sessions,
      questions: [{ id: "q1", sessionID: "ses_child", questions: [] }],
    });
    activate(question.db);
    await question.router.sweep();
    expect(rows(question.db)).toHaveLength(0);

    const permission = await fixture({
      sessions,
      permissions: [{ id: "p1", sessionID: "ses_child", permission: "bash", patterns: [] }],
    });
    activate(permission.db);
    await permission.router.sweep();
    expect(rows(permission.db)).toHaveLength(0);
  });

  it("suppresses an in-flight one-shot handoff and an outstanding thread message", async () => {
    const oneShot = await fixture();
    activate(oneShot.db);
    insertHandoff(oneShot.db, { id: "h1", state: "in_progress" });
    await oneShot.router.sweep();
    expect(rows(oneShot.db)).toHaveLength(0);

    const thread = await fixture();
    activate(thread.db);
    insertHandoff(thread.db, { id: "h2", mode: "thread", state: "in_progress" });
    insertThreadMessage(thread.db, { handoffId: "h2", state: "waiting_operator" });
    await thread.router.sweep();
    expect(rows(thread.db)).toHaveLength(0);
  });

  it("defers an unbound handoff only inside the 60 s grace", async () => {
    const fresh = await fixture();
    activate(fresh.db);
    insertHandoff(fresh.db, {
      id: "h1",
      state: "queued",
      sourceSessionId: null,
      invokingSessionId: null,
      createdAt: new Date(T_NOW - 10_000).toISOString(),
    });
    await fresh.router.sweep();
    expect(rows(fresh.db)).toHaveLength(0);

    const stale = await fixture();
    activate(stale.db);
    insertHandoff(stale.db, {
      id: "h2",
      state: "queued",
      sourceSessionId: null,
      invokingSessionId: null,
      createdAt: new Date(T_NOW - 120_000).toISOString(),
    });
    await stale.router.sweep();
    expect(rows(stale.db)).toHaveLength(1);
  });

  it("defers an oversized subtree", async () => {
    const sessions: OpencodeSession[] = [{ id: SESSION_ID, time: { created: T_NOW } }];
    for (let index = 0; index < 500; index += 1) {
      sessions.push({
        id: `ses_child_${index}`,
        parentID: SESSION_ID,
        time: { created: T_NOW },
      });
    }
    const f = await fixture({ sessions });
    activate(f.db);
    await f.router.sweep();
    expect(rows(f.db)).toHaveLength(0);
  });
});

describe("watermark and dedupe rules", () => {
  it("initializes silently on the first enable without notifying historical turns", async () => {
    const f = await fixture({
      sessions: [{ id: SESSION_ID, time: { created: T_NOW - 3_600_000 } }],
    });
    await f.router.sweep();

    expect(rows(f.db)).toHaveLength(0);
    expect(getNotificationMeta(f.db, NOTIFICATION_META_KEYS.firstSweepAt)).toBe(
      new Date(T_NOW).toISOString(),
    );
    expect(getNotificationMeta(f.db, NOTIFICATION_META_KEYS.noticeScanAt)).toBe(
      new Date(T_NOW).toISOString(),
    );
    expect(getNotificationWatermark(f.db, "a1", SESSION_ID)?.lastNotifiedMessageId).toBe("msg_a1");
  });

  it("notifies a turn completed while the coordinator was down", async () => {
    const f = await fixture({
      sessions: [{ id: SESSION_ID, time: { created: Date.parse(T0) - 60_000 } }],
    });
    activate(f.db, "msg_a0");
    await f.router.sweep();
    expect(rows(f.db)).toHaveLength(1);
  });

  it("notifies a new session created after first_sweep_at and initializes a pre-marker one", async () => {
    const fresh = await fixture({
      sessions: [{ id: SESSION_ID, time: { created: Date.parse(T0) + 60_000 } }],
    });
    writeNotificationMeta(fresh.db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
    writeNotificationMeta(fresh.db, NOTIFICATION_META_KEYS.enabledAt, T0, T0);
    writeNotificationMeta(fresh.db, NOTIFICATION_META_KEYS.channelEnabled, "true", T0);
    await fresh.router.sweep();
    expect(rows(fresh.db)).toHaveLength(1);

    const old = await fixture({
      sessions: [{ id: SESSION_ID, time: { created: Date.parse(T0) - 60_000 } }],
    });
    writeNotificationMeta(old.db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
    writeNotificationMeta(old.db, NOTIFICATION_META_KEYS.enabledAt, T0, T0);
    writeNotificationMeta(old.db, NOTIFICATION_META_KEYS.channelEnabled, "true", T0);
    await old.router.sweep();
    expect(rows(old.db)).toHaveLength(0);
    expect(getNotificationWatermark(old.db, "a1", SESSION_ID)?.lastNotifiedMessageId).toBe(
      "msg_a1",
    );
  });

  it("initializes silently when the session time.created is missing", async () => {
    const f = await fixture({ sessions: [{ id: SESSION_ID }] });
    writeNotificationMeta(f.db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
    writeNotificationMeta(f.db, NOTIFICATION_META_KEYS.enabledAt, T0, T0);
    writeNotificationMeta(f.db, NOTIFICATION_META_KEYS.channelEnabled, "true", T0);
    await f.router.sweep();
    expect(rows(f.db)).toHaveLength(0);
    expect(getNotificationWatermark(f.db, "a1", SESSION_ID)?.lastNotifiedMessageId).toBe("msg_a1");
  });

  it("advances the watermark when the outbox already has the occurrence", async () => {
    const f = await fixture();
    activate(f.db, "msg_a0");
    insertNotificationGroup(f.db, {
      createdAt: T0,
      chunks: [
        {
          dedupeKey: `turn:a1:${SESSION_ID}:msg_a1:0`,
          kind: "turn_completed",
          scope: "app",
          projectId: "p1",
          appKey: "app",
          appId: "a1",
          sessionId: SESSION_ID,
          payloadJson: "{}",
        },
      ],
    });
    await f.router.sweep();
    expect(rows(f.db)).toHaveLength(1);
    expect(getNotificationWatermark(f.db, "a1", SESSION_ID)?.lastNotifiedMessageId).toBe("msg_a1");
  });
});

describe("channel and mode gates", () => {
  it("sends only under mode=all with the channel enabled", async () => {
    const all = await fixture({ settings: { mode: "all", enabled: true } });
    activate(all.db);
    await all.router.sweep();
    expect(rows(all.db)).toHaveLength(1);
  });

  it("advances the watermark under attention, off, and disabled without enqueuing", async () => {
    for (const settings of [
      { mode: "attention" as const, enabled: true },
      { mode: "off" as const, enabled: true },
      { mode: "all" as const, enabled: false },
    ]) {
      const f = await fixture({ settings });
      activate(f.db);
      await f.router.sweep();
      expect(rows(f.db)).toHaveLength(0);
      expect(getNotificationWatermark(f.db, "a1", SESSION_ID)?.lastNotifiedMessageId).toBe(
        "msg_a1",
      );
    }
  });

  it("sets enabled_at on a real enable transition and advances notice_scan_at while disabled", async () => {
    const disabled = await fixture({ settings: { enabled: false } });
    writeNotificationMeta(disabled.db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
    writeNotificationMeta(disabled.db, NOTIFICATION_META_KEYS.channelEnabled, "false", T0);
    await disabled.router.sweep();
    expect(getNotificationMeta(disabled.db, NOTIFICATION_META_KEYS.noticeScanAt)).toBe(
      new Date(T_NOW).toISOString(),
    );

    const enabled = await fixture({ settings: { enabled: true } });
    writeNotificationMeta(enabled.db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
    writeNotificationMeta(enabled.db, NOTIFICATION_META_KEYS.channelEnabled, "false", T0);
    await enabled.router.sweep();
    expect(getNotificationMeta(enabled.db, NOTIFICATION_META_KEYS.enabledAt)).toBe(
      new Date(T_NOW).toISOString(),
    );
    expect(getNotificationMeta(enabled.db, NOTIFICATION_META_KEYS.channelEnabled)).toBe("true");
  });
});

describe("predicate SQL helpers", () => {
  it("returns false for an empty subtree and matches a subtree-bound one-shot handoff", () => {
    const db = createDb();
    expect(hasInflightOneShotHandoff(db, "[]")).toBe(false);
    expect(hasOutstandingThreadWork(db, "[]", SESSION_ID)).toBe(false);
    expect(hasUnboundHandoffInGrace(db, "a1", T_NOW)).toBe(false);

    insertHandoff(db, { id: "h1", state: "in_progress" });
    expect(hasInflightOneShotHandoff(db, JSON.stringify([SESSION_ID]))).toBe(true);
  });
});
