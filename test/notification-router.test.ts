import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NOTIFICATION_META_KEYS } from "../src/notifications/catch-up.js";
import {
  type NotificationEffectiveSettings,
  NotificationRouter,
  type NotificationSettingsSource,
} from "../src/notifications/router.js";
import type { OpencodeMessage } from "../src/opencode/client.js";
import type { SessionActivitySnapshot } from "../src/opencode/context.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import {
  getNotificationMeta,
  listNotificationGroupRows,
  writeNotificationMeta,
} from "../src/store/notifications.js";
import { assistantMessage, idleStatus, textPart, userMessage } from "./fixtures/chat-turn.js";

const T0 = "2026-11-10T00:00:00.000Z";
const T_NOW = Date.parse("2026-11-10T12:00:00.000Z");
const SESSION_ID = "ses_1";
const TRANSITION = "2026-11-10T11:00:00.000Z";

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
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a2','p1','other','/tmp/other','AGENTS.md',?)",
  ).run(T0);
  return db;
}

function effective(
  overrides: Partial<{ mode: "off" | "attention" | "all"; enabled: boolean }> = {},
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
      publicBaseUrl: value("https://hanse.test"),
      includeAnswer: value(true),
    },
  };
}

function settingsFor(overrides: Parameters<typeof effective>[0] = {}): NotificationSettingsSource {
  return { resolve: () => ({ effective: effective(overrides) }) };
}

function rows(db: SqliteDatabase): ReturnType<typeof listNotificationGroupRows> {
  return db
    .prepare("SELECT group_id FROM notification_outbox ORDER BY created_at, group_id, chunk_index")
    .all()
    .flatMap((row) => listNotificationGroupRows(db, (row as { group_id: string }).group_id));
}

function insertHandoff(
  db: SqliteDatabase,
  input: {
    id: string;
    state?: string;
    mode?: "one_shot" | "thread";
    summary?: string;
    targetSessionId?: string | null;
    replyError?: string | null;
    error?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO handoffs
       (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key,
        mode, source_session_id, target_session_id, reply_state, reply_error, error,
        created_at, updated_at)
     VALUES (?, 'p1', 'a1', 'a2', ?, ?, 'spec', ?, ?, ?, ?, 'none', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.state ?? "awaiting_approval",
    input.summary ?? "Do the thing",
    `idem-${input.id}`,
    input.mode ?? "one_shot",
    "ses_source",
    input.targetSessionId ?? null,
    input.replyError ?? null,
    input.error ?? null,
    T0,
    T0,
  );
}

function insertThreadMessage(db: SqliteDatabase, handoffId: string, errorCode?: string): number {
  const result = db
    .prepare(
      `INSERT INTO handoff_messages
         (handoff_id, seq, kind, body, created_at, author_side, state, error_code)
       VALUES (?, 1, 'message', 'thread body', ?, 'source', 'waiting_operator', ?)`,
    )
    .run(handoffId, T0, errorCode ?? null);
  return Number(result.lastInsertRowid);
}

function insertSshApproval(db: SqliteDatabase, approvalId: string): void {
  db.prepare(
    `INSERT INTO ssh_hosts (id,name,address,port,username,created_at,updated_at)
     VALUES ('h1','deploy-host','10.0.0.5',22,'operator',?,?)`,
  ).run(T0, T0);
  db.prepare(
    `INSERT INTO ssh_approvals
       (id, app_id, host_id, action, command_hash, command_preview, command_bytes,
        status, requested_at, expires_at)
     VALUES (?, 'a1', 'h1', 'exec', 'hash', 'uptime', 6, 'pending', ?, ?)`,
  ).run(approvalId, T0, "2026-11-10T12:05:00.000Z");
}

interface Fixture {
  db: SqliteDatabase;
  router: NotificationRouter;
}

function fixture(
  init: {
    settings?: Parameters<typeof settingsFor>[0];
    endpoint?: string;
    activity?: SessionActivitySnapshot;
  } = {},
): Fixture {
  const db = createDb();
  const router = new NotificationRouter({
    db,
    manager: {
      endpointFor: () => init.endpoint,
      sessionActivity: async () =>
        init.activity ?? { activeChildren: false, pendingTask: false, known: true },
    },
    settings: settingsFor(init.settings),
    now: () => T_NOW,
  });
  routers.push(router);
  return { db, router };
}

describe("router attention signals", () => {
  it("enqueues and dedupes an SSH approval with host, action, preview, and expiry", () => {
    const f = fixture();
    insertSshApproval(f.db, "ap1");
    f.router.handleNotificationSignal({
      type: "ssh_approval",
      transitionAt: TRANSITION,
      appId: "a1",
      hostId: "h1",
      approvalId: "ap1",
      commandPreview: "uptime",
      expiresAt: "2026-11-10T12:05:00.000Z",
    });

    const outbox = rows(f.db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      kind: "ssh_approval",
      scope: "app",
      appId: "a1",
      projectId: "p1",
      appKey: "app",
      sessionId: null,
      dedupeKey: "ssh-approval:ap1:0",
    });
    const payload = JSON.parse(outbox[0]?.payloadJson ?? "{}") as { text: string; link?: unknown };
    expect(payload.text).toContain("deploy-host - exec");
    expect(payload.text).toContain("uptime");
    expect(payload.link).toMatchObject({ text: "Open app" });

    f.router.handleNotificationSignal({
      type: "ssh_approval",
      transitionAt: "2026-11-10T11:01:00.000Z",
      appId: "a1",
      hostId: "h1",
      approvalId: "ap1",
      commandPreview: "uptime",
      expiresAt: "2026-11-10T12:05:00.000Z",
    });
    expect(rows(f.db)).toHaveLength(1);
  });

  it("enqueues handoff approval, parked reply, and terminal failure occurrences", () => {
    const f = fixture();
    insertHandoff(f.db, { id: "h1", state: "awaiting_approval" });
    f.router.handleNotificationSignal({
      type: "handoff_approval",
      transitionAt: TRANSITION,
      handoffId: "h1",
      approvalKind: "dispatch",
      approvalId: "ap1",
      requestedAt: TRANSITION,
    });

    insertHandoff(f.db, { id: "h2", state: "delivered", replyError: "no route" });
    f.router.handleNotificationSignal({
      type: "handoff_waiting_operator",
      transitionAt: TRANSITION,
      handoffId: "h2",
    });
    f.router.handleNotificationSignal({
      type: "handoff_waiting_operator",
      transitionAt: "2026-11-10T11:05:00.000Z",
      handoffId: "h2",
    });

    insertHandoff(f.db, { id: "h3", state: "failed", error: "target failed" });
    f.router.handleNotificationSignal({
      type: "handoff_failed",
      transitionAt: TRANSITION,
      handoffId: "h3",
      scope: "terminal",
      state: "failed",
    });
    f.router.handleNotificationSignal({
      type: "handoff_failed",
      transitionAt: TRANSITION,
      handoffId: "h2",
      scope: "reply",
    });

    const outbox = rows(f.db);
    expect(outbox.map((row) => row.dedupeKey).sort()).toEqual(
      [
        "handoff-approval:ap1:0",
        "handoff-waiting:h2:2026-11-10T11:00:00.000Z:0",
        "handoff-waiting:h2:2026-11-10T11:05:00.000Z:0",
        "handoff-terminal:h3:failed:2026-11-10T11:00:00.000Z:0",
        "handoff-failed:h2:2026-11-10T11:00:00.000Z:0",
      ].sort(),
    );
    const approval = outbox.find((row) => row.dedupeKey.startsWith("handoff-approval:"));
    expect(approval?.scope).toBe("project");
    expect(JSON.parse(approval?.payloadJson ?? "{}").text).toContain("app -> other");
  });

  it("enqueues a parked thread message with its message occurrence", () => {
    const f = fixture();
    insertHandoff(f.db, { id: "h1", mode: "thread", state: "in_progress" });
    const messageId = insertThreadMessage(f.db, "h1", "parked");
    f.router.handleNotificationSignal({
      type: "thread_message_waiting",
      transitionAt: TRANSITION,
      messageId,
      handoffId: "h1",
    });
    expect(rows(f.db)[0]?.dedupeKey).toBe(`thread-message-waiting:${messageId}:${TRANSITION}:0`);
  });
});

describe("router agent attention events", () => {
  it("enqueues question and permission prompts with a session link", () => {
    const f = fixture();
    f.router.handleAgentEvent("a1", {
      type: "question.asked",
      request: {
        key: "v1:q1",
        id: "q1",
        sessionID: SESSION_ID,
        questions: [
          {
            header: "Choose",
            question: "Which environment?",
            options: [
              { label: "staging", description: "" },
              { label: "prod", description: "" },
            ],
            multiple: false,
            custom: false,
          },
        ],
        source: "v1",
        tooLarge: false,
      },
    });
    f.router.handleAgentEvent("a1", {
      type: "permission.asked",
      request: {
        key: "v1:p1",
        id: "p1",
        sessionID: SESSION_ID,
        permission: "bash",
        patterns: ["rm -rf"],
        metadata: { command: "rm -rf /tmp/x" },
        always: [],
        source: "v1",
        tool: { name: "bash" },
      },
    });

    const outbox = rows(f.db);
    const questionRow = outbox.find((row) => row.kind === "question");
    const permissionRow = outbox.find((row) => row.kind === "permission");
    expect(questionRow?.dedupeKey).toBe(`question:a1:q1:0`);
    expect(permissionRow?.dedupeKey).toBe("permission:p1:0");
    const question = JSON.parse(questionRow?.payloadJson ?? "{}") as {
      text: string;
      link?: unknown;
    };
    expect(question.text).toContain("Which environment?");
    expect(question.text).toContain("staging");
    expect(question.link).toMatchObject({ text: "Open session" });
    const permission = JSON.parse(permissionRow?.payloadJson ?? "{}") as { text: string };
    expect(permission.text).toContain("bash (bash)");
    expect(permission.text).toContain("rm -rf /tmp/x");
  });

  it("ignores a question whose session is an active thread target", () => {
    const f = fixture();
    insertHandoff(f.db, {
      id: "h1",
      mode: "thread",
      state: "in_progress",
      targetSessionId: "ses_thread",
    });
    f.router.handleAgentEvent("a1", {
      type: "question.asked",
      request: {
        key: "v1:q1",
        id: "q1",
        sessionID: "ses_thread",
        questions: [],
        source: "v1",
        tooLarge: true,
        summary: "too large",
      },
    });
    expect(rows(f.db)).toHaveLength(0);
  });

  it("enqueues agent errors and ignores aborts", () => {
    const f = fixture();
    f.router.handleAgentEvent("a1", {
      type: "session.error",
      sessionID: SESSION_ID,
      name: "MessageAbortedError",
      message: "request aborted",
    });
    expect(rows(f.db)).toHaveLength(0);

    f.router.handleAgentEvent("a1", {
      type: "session.error",
      sessionID: SESSION_ID,
      name: "ProviderError",
      message: "upstream exploded",
    });
    const outbox = rows(f.db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.kind).toBe("agent_interrupted");
    expect(outbox[0]?.dedupeKey).toBe(`agent-error:${SESSION_ID}:2026-11-10T12:00:00.000Z:0`);
    expect(JSON.parse(outbox[0]?.payloadJson ?? "{}").text).toContain("upstream exploded");
  });
});

describe("router attention gating", () => {
  it("enqueues attention under mode=attention but not mode=off or disabled", () => {
    for (const [settings, expected] of [
      [{ mode: "attention" as const, enabled: true }, 1],
      [{ mode: "all" as const, enabled: true }, 1],
      [{ mode: "off" as const, enabled: true }, 0],
      [{ mode: "all" as const, enabled: false }, 0],
    ] as const) {
      const f = fixture({ settings });
      insertSshApproval(f.db, `ap-${settings.mode}-${String(settings.enabled)}`);
      f.router.handleNotificationSignal({
        type: "ssh_approval",
        transitionAt: TRANSITION,
        appId: "a1",
        hostId: "h1",
        approvalId: `ap-${settings.mode}-${String(settings.enabled)}`,
        commandPreview: "uptime",
        expiresAt: "2026-11-10T12:05:00.000Z",
      });
      expect(rows(f.db)).toHaveLength(expected);
    }
  });

  it("enqueues missed notices before advancing the scan marker", async () => {
    const f = fixture();
    writeNotificationMeta(f.db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
    writeNotificationMeta(f.db, NOTIFICATION_META_KEYS.enabledAt, T0, T0);
    writeNotificationMeta(f.db, NOTIFICATION_META_KEYS.channelEnabled, "true", T0);
    f.db
      .prepare(
        `INSERT INTO session_notices
           (id, app_id, session_id, dedupe_key, kind, reason, payload_json, created_at)
         VALUES ('n1','a1',?,'dedupe-n1','agent_stopped','process_exit','{"message":"process exited"}',?)`,
      )
      .run(SESSION_ID, "2026-11-10T11:00:00.000Z");

    await f.router.sweep();

    const outbox = rows(f.db);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      kind: "agent_interrupted",
      dedupeKey: "notice:n1:0",
      appId: "a1",
      sessionId: SESSION_ID,
    });
    expect(getNotificationMeta(f.db, NOTIFICATION_META_KEYS.noticeScanAt)).toBe(
      "2026-11-10T11:00:00.000Z",
    );
  });
});

describe("completion payload", () => {
  async function completionFixture(
    answer: string,
    includeAnswer: boolean,
  ): Promise<{ db: SqliteDatabase; router: NotificationRouter }> {
    const server = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const send = (body: unknown): void => {
        outgoing.writeHead(200, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(body));
      };
      if (url.pathname === "/session") {
        send([{ id: SESSION_ID, title: "Session", time: { created: Date.parse(T0) + 1_000 } }]);
        return;
      }
      if (url.pathname === "/session/status") {
        send({ [SESSION_ID]: idleStatus });
        return;
      }
      if (url.pathname === `/session/${SESSION_ID}/message`) {
        const messages: OpencodeMessage[] = [
          userMessage("msg_u1", [textPart("run")], { sessionID: SESSION_ID }),
          assistantMessage("msg_a1", [textPart(answer)], {
            sessionID: SESSION_ID,
            parentID: "msg_u1",
            finish: "stop",
            completed: true,
          }),
        ];
        send(messages);
        return;
      }
      if (
        url.pathname === "/question" ||
        url.pathname === "/permission" ||
        url.pathname === "/api/question/request" ||
        url.pathname === "/api/permission/request"
      ) {
        send([]);
        return;
      }
      outgoing.writeHead(404, { "content-type": "application/json" });
      outgoing.end("{}");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const db = createDb();
    writeNotificationMeta(db, NOTIFICATION_META_KEYS.firstSweepAt, T0, T0);
    writeNotificationMeta(db, NOTIFICATION_META_KEYS.enabledAt, T0, T0);
    writeNotificationMeta(db, NOTIFICATION_META_KEYS.channelEnabled, "true", T0);
    const router = new NotificationRouter({
      db,
      manager: {
        endpointFor: (appId) => (appId === "a1" ? `http://127.0.0.1:${address.port}` : undefined),
        sessionActivity: async () => ({ activeChildren: false, pendingTask: false, known: true }),
      },
      settings: {
        resolve: () => ({
          effective: {
            ...effective(),
            notifications: {
              ...effective().notifications,
              includeAnswer: {
                value: includeAnswer,
                state: "set",
                source: "global",
                sources: ["global"],
              },
            },
          },
        }),
      },
      now: () => T_NOW,
    });
    routers.push(router);
    return { db, router };
  }

  it("marks full-answer completion payloads and leaves them unmarked when disabled", async () => {
    const full = await completionFixture("the answer", true);
    await full.router.sweep();
    const fullRows = rows(full.db);
    expect(fullRows).toHaveLength(1);
    expect(JSON.parse(fullRows[0]?.payloadJson ?? "{}")).toMatchObject({
      text: expect.stringContaining("the answer"),
      answer: true,
    });

    const statusOnly = await completionFixture("the answer", false);
    await statusOnly.router.sweep();
    const statusRows = rows(statusOnly.db);
    expect(statusRows).toHaveLength(1);
    expect(JSON.parse(statusRows[0]?.payloadJson ?? "{}")).not.toHaveProperty("answer");
  });

  it("puts the session link on the last chunk only", async () => {
    const f = await completionFixture("x".repeat(70_000), true);
    await f.router.sweep();
    const outbox = rows(f.db);
    expect(outbox.length).toBeGreaterThan(1);
    expect(JSON.parse(outbox[0]?.payloadJson ?? "{}")).not.toHaveProperty("link");
    expect(JSON.parse(outbox.at(-1)?.payloadJson ?? "{}")).toMatchObject({
      link: { text: "Open session" },
    });
  });
});
