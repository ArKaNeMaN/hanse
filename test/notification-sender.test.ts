import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
import {
  claimNextNotificationChunk,
  getNotificationChannelState,
  getNotificationOutboxRow,
  insertNotificationGroup,
  listNotificationGroupRows,
  markNotificationChunkSent,
  type NotificationChunkInput,
  type NotificationOutboxRow,
} from "../src/notifications/outbox.js";
import { TelegramSender } from "../src/notifications/sender.js";
import { TelegramClient } from "../src/notifications/telegram/client.js";
import {
  TelegramApiError,
  type TelegramTransport,
} from "../src/notifications/telegram/transport.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const T0 = "2026-11-10T00:00:00.000Z";
const T0_MS = Date.parse(T0);
const DAY = 24 * 60 * 60 * 1000;
const BOT_TOKEN = "12345:ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHAT_ID = "42";
const LINK = { text: "Open session", url: "https://hanse.test/chat?session=ses_1" };

type Handler = (method: string, body: unknown) => Promise<unknown>;

class FakeTransport implements TelegramTransport {
  readonly calls: Array<{ method: string; body: unknown }> = [];
  handler: Handler;

  constructor(handler: Handler = async () => ({ message_id: 1 })) {
    this.handler = handler;
  }

  call(method: string, body: unknown): Promise<unknown> {
    this.calls.push({ method, body });
    return this.handler(method, body);
  }
}

interface ConfigureOptions {
  enabled?: boolean;
  mode?: "off" | "attention" | "all";
  chatId?: string | null;
  token?: string | null;
  includeAnswer?: boolean;
}

interface Fixture {
  db: ReturnType<typeof openDatabase>;
  settings: SettingsService;
  transport: FakeTransport;
  clock: { value: number };
  lifecycle: LifecycleActivity;
  sleeps: number[];
  sender: TelegramSender;
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

function configure(settings: SettingsService, options: ConfigureOptions = {}): void {
  settings.set("global", {}, "notifications.telegram.enabled", options.enabled ?? true, "test");
  settings.set("global", {}, "notifications.mode", options.mode ?? "all", "test");
  settings.set("global", {}, "notifications.include_answer", options.includeAnswer ?? true, "test");
  const chatId = options.chatId === undefined ? CHAT_ID : options.chatId;
  if (chatId !== null) {
    settings.set("global", {}, "notifications.telegram.chat_id", chatId, "test");
  }
  const token = options.token === undefined ? BOT_TOKEN : options.token;
  if (token !== null) {
    settings.setNotificationSecret("global", {}, "bot_token", token, "test");
  }
}

function createFixture(options: { handler?: Handler; config?: ConfigureOptions } = {}): Fixture {
  const db = createDb();
  const clock = { value: T0_MS };
  const settings = new SettingsService({
    db,
    secretKey: randomBytes(32),
    now: () => new Date(clock.value),
  });
  configure(settings, options.config);
  const transport = new FakeTransport(options.handler);
  const lifecycle = new LifecycleActivity();
  const sleeps: number[] = [];
  const sender = new TelegramSender({
    db,
    settings,
    lifecycleActivity: lifecycle,
    now: () => clock.value,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    clientFactory: (clientOptions) =>
      new TelegramClient({ transport, chatId: clientOptions.chatId }),
  });
  return { db, settings, transport, clock, lifecycle, sleeps, sender };
}

function chunks(
  prefix: string,
  count: number,
  overrides: Partial<NotificationChunkInput> = {},
  payloads?: Array<Record<string, unknown>>,
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
    payloadJson: JSON.stringify(payloads?.[index] ?? { text: `${prefix}:${index}` }),
    ...overrides,
  }));
}

function insert(fixture: Fixture, groupId: string, inputs: NotificationChunkInput[]) {
  return insertNotificationGroup(fixture.db, { groupId, createdAt: T0, chunks: inputs });
}

function rowOf(fixture: Fixture, id: string): NotificationOutboxRow {
  const row = getNotificationOutboxRow(fixture.db, id);
  if (row === undefined) throw new Error(`missing notification row ${id}`);
  return row;
}

function bodyText(call: { body: unknown }): string {
  const body = call.body as { rich_message?: { markdown?: string }; text?: string };
  return body.rich_message?.markdown ?? body.text ?? "";
}

function internalError(status = 500): TelegramApiError {
  return new TelegramApiError("telegram_unavailable", "Telegram request failed", { status });
}

describe("telegram sender", () => {
  it("never sends chunk N before chunk N-1 is sent", async () => {
    const fixture = createFixture();
    let calls = 0;
    fixture.transport.handler = async () => {
      calls += 1;
      if (calls === 1) throw internalError();
      return { message_id: calls };
    };
    const [first] = insert(fixture, "g1", chunks("g1", 2)).rows;
    if (first === undefined) throw new Error("missing first chunk");

    expect(await fixture.sender.tick()).toBe(true);
    const failed = rowOf(fixture, first.id);
    expect(failed.state).toBe("pending");
    expect(failed.attempts).toBe(1);
    expect(await fixture.sender.tick()).toBe(false);

    fixture.clock.value = Date.parse(failed.nextAttemptAt);
    expect(await fixture.sender.tick()).toBe(true);
    expect(await fixture.sender.tick()).toBe(true);

    expect(fixture.transport.calls.map(bodyText)).toEqual(["g1:0", "g1:0", "g1:1"]);
    expect(listNotificationGroupRows(fixture.db, "g1").map((row) => row.state)).toEqual([
      "sent",
      "sent",
    ]);
    expect(
      listNotificationGroupRows(fixture.db, "g1").every((row) => row.payloadJson === "{}"),
    ).toBe(true);
    fixture.db.close();
  });

  it("reschedules a 429 with retry_after plus one second and keeps the attempt count", async () => {
    const fixture = createFixture({
      handler: async () => {
        throw new TelegramApiError("telegram_rate_limited", "Too Many Requests", {
          status: 429,
          retryAfterSeconds: 7,
        });
      },
    });
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    expect(await fixture.sender.tick()).toBe(true);
    const retried = rowOf(fixture, row.id);
    expect(retried.state).toBe("pending");
    expect(retried.attempts).toBe(0);
    expect(retried.errorCode).toBe("telegram_rate_limited");
    expect(retried.nextAttemptAt).toBe(new Date(T0_MS + 8_000).toISOString());
    expect(retried.payloadJson).toBe(JSON.stringify({ text: "g1:0" }));
    expect(getNotificationChannelState(fixture.db, "telegram")?.state).toBe("error");
    expect(await fixture.sender.tick()).toBe(false);
    fixture.db.close();
  });

  it("backs off a 5xx exponentially and dead-letters after eight attempts", async () => {
    const fixture = createFixture({ handler: async () => Promise.reject(internalError()) });
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    const expectedBackoff = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
    let tickAt = T0_MS;
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      fixture.clock.value = tickAt;
      expect(await fixture.sender.tick()).toBe(true);
      const retried = rowOf(fixture, row.id);
      expect(retried.state).toBe("pending");
      expect(retried.attempts).toBe(attempt);
      const backoff = expectedBackoff[attempt - 1];
      if (backoff === undefined) throw new Error("missing backoff value");
      const expectedNext = new Date(tickAt + backoff).toISOString();
      expect(retried.nextAttemptAt).toBe(expectedNext);
      tickAt = Date.parse(retried.nextAttemptAt);
    }

    fixture.clock.value = tickAt;
    expect(await fixture.sender.tick()).toBe(true);
    const dead = rowOf(fixture, row.id);
    expect(dead.state).toBe("dead");
    expect(dead.errorCode).toBe("telegram_unavailable");
    expect(dead.payloadJson).toBe("{}");
    expect(getNotificationChannelState(fixture.db, "telegram")?.state).toBe("error");
    expect(fixture.transport.calls).toHaveLength(8);
    fixture.db.close();
  });

  it("dead-letters a non-format 400 with a sanitized error", async () => {
    const fixture = createFixture({
      handler: async () => {
        throw new TelegramApiError("telegram_rejected", "chat not found", { status: 400 });
      },
    });
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    expect(await fixture.sender.tick()).toBe(true);
    const dead = rowOf(fixture, row.id);
    expect(dead.state).toBe("dead");
    expect(dead.errorCode).toBe("telegram_rejected");
    expect(dead.lastError).toBe("chat not found");
    expect(dead.payloadJson).toBe("{}");
    expect(getNotificationChannelState(fixture.db, "telegram")).toMatchObject({
      state: "error",
      lastError: "chat not found",
    });
    fixture.db.close();
  });

  it("dead-letters 401 and 403 and marks the channel errored", async () => {
    for (const status of [401, 403]) {
      const fixture = createFixture({
        handler: async () => {
          throw new TelegramApiError("telegram_unauthorized", "Unauthorized", { status });
        },
      });
      const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
      if (row === undefined) throw new Error("missing chunk");

      expect(await fixture.sender.tick()).toBe(true);
      const dead = rowOf(fixture, row.id);
      expect(dead.state).toBe("dead");
      expect(dead.errorCode).toBe("telegram_unauthorized");
      expect(dead.payloadJson).toBe("{}");
      expect(getNotificationChannelState(fixture.db, "telegram")?.state).toBe("error");
      fixture.db.close();
    }
  });

  it("marks the unsent rich suffix dead and inserts a linked plain group on fallback", async () => {
    const fixture = createFixture();
    let calls = 0;
    fixture.transport.handler = async (method) => {
      calls += 1;
      if (calls === 1) return { message_id: 1 };
      if (method === "sendRichMessage") {
        throw new TelegramApiError("telegram_format", "can't parse entities", { status: 400 });
      }
      return { message_id: 2 };
    };
    insert(
      fixture,
      "g1",
      chunks("g1", 3, {}, [{ text: "c0" }, { text: "c1" }, { text: "c2", link: LINK }]),
    );

    expect(await fixture.sender.tick()).toBe(true);
    expect(await fixture.sender.tick()).toBe(true);

    const original = listNotificationGroupRows(fixture.db, "g1");
    expect(original.map((row) => row.state)).toEqual(["sent", "dead", "dead"]);
    expect(original.map((row) => row.errorCode)).toEqual([null, "rich_fallback", "rich_fallback"]);
    expect(original.every((row) => row.payloadJson === "{}")).toBe(true);

    const newGroup = fixture.db
      .prepare(
        "SELECT DISTINCT group_id AS groupId FROM notification_outbox WHERE group_id <> 'g1'",
      )
      .get() as { groupId: string };
    const plain = listNotificationGroupRows(fixture.db, newGroup.groupId);
    expect(plain.map((row) => row.format)).toEqual(plain.map(() => "plain"));
    expect(plain.every((row) => row.state === "pending")).toBe(true);
    expect(plain.every((row) => row.dedupeKey.includes(":plain:"))).toBe(true);
    const texts = plain.map(
      (row) => JSON.parse(row.payloadJson) as { text: string; link?: unknown },
    );
    const combined = texts.map((payload) => payload.text).join("\n");
    expect(combined).toContain("c1");
    expect(combined).toContain("c2");
    expect(texts[texts.length - 1]?.link).toEqual(LINK);
    expect(fixture.transport.calls.every((call) => call.method === "sendRichMessage")).toBe(true);

    expect(await fixture.sender.tick()).toBe(true);
    expect(fixture.transport.calls[fixture.transport.calls.length - 1]?.method).toBe("sendMessage");
    fixture.db.close();
  });

  it("preserves the full-answer marker on fallback plain rows", async () => {
    const fixture = createFixture();
    let calls = 0;
    fixture.transport.handler = async (method) => {
      calls += 1;
      if (calls === 1) return { message_id: 1 };
      if (method === "sendRichMessage") {
        throw new TelegramApiError("telegram_format", "can't parse entities", { status: 400 });
      }
      return { message_id: 2 };
    };
    insert(
      fixture,
      "g1",
      chunks("g1", 2, {}, [
        { text: "c0", answer: true },
        { text: "c1", answer: true, link: LINK },
      ]),
    );

    expect(await fixture.sender.tick()).toBe(true);
    expect(await fixture.sender.tick()).toBe(true);

    const newGroup = fixture.db
      .prepare(
        "SELECT DISTINCT group_id AS groupId FROM notification_outbox WHERE group_id <> 'g1'",
      )
      .get() as { groupId: string };
    const plain = listNotificationGroupRows(fixture.db, newGroup.groupId);
    expect(plain.every((row) => row.format === "plain")).toBe(true);
    for (const row of plain) {
      expect(JSON.parse(row.payloadJson)).toMatchObject({ answer: true });
    }
    fixture.db.close();
  });

  it("runs retention maintenance while the loop is idle", async () => {
    const fixture = createFixture();
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");
    markNotificationChunkSent(fixture.db, row.id, new Date(T0_MS - 40 * DAY).toISOString());

    expect(await fixture.sender.tick()).toBe(false);
    expect(getNotificationOutboxRow(fixture.db, row.id)).toBeUndefined();
    fixture.db.close();
  });

  it("closes the rest of a group when one chunk dead-letters", async () => {
    const fixture = createFixture({
      handler: async () => {
        throw new TelegramApiError("telegram_rejected", "bad request", { status: 400 });
      },
    });
    insert(fixture, "g1", chunks("g1", 3));

    expect(await fixture.sender.tick()).toBe(true);
    const rows = listNotificationGroupRows(fixture.db, "g1");
    expect(rows.map((row) => row.state)).toEqual(["dead", "dead", "dead"]);
    expect(rows.map((row) => row.errorCode)).toEqual([
      "telegram_rejected",
      "chunk_failed",
      "chunk_failed",
    ]);
    expect(rows.every((row) => row.payloadJson === "{}")).toBe(true);
    fixture.db.close();
  });

  it("dead-letters a disabled channel without marking the channel errored", async () => {
    const fixture = createFixture({ config: { enabled: false } });
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    expect(await fixture.sender.tick()).toBe(true);
    const dead = rowOf(fixture, row.id);
    expect(dead.state).toBe("dead");
    expect(dead.errorCode).toBe("channel_disabled");
    expect(getNotificationChannelState(fixture.db, "telegram")).toBeUndefined();
    expect(fixture.transport.calls).toHaveLength(0);
    fixture.db.close();
  });

  it("dead-letters a turn_completed row under attention mode", async () => {
    const fixture = createFixture({ config: { mode: "attention" } });
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    expect(await fixture.sender.tick()).toBe(true);
    expect(rowOf(fixture, row.id).errorCode).toBe("mode_attention");
    expect(fixture.transport.calls).toHaveLength(0);
    fixture.db.close();
  });

  it("dead-letters a full-answer completion when include_answer is off", async () => {
    const fixture = createFixture({ config: { includeAnswer: false } });
    const [row] = insert(
      fixture,
      "g1",
      chunks("g1", 1, {}, [{ text: "the full answer", answer: true }]),
    ).rows;
    if (row === undefined) throw new Error("missing chunk");

    expect(await fixture.sender.tick()).toBe(true);
    const dead = rowOf(fixture, row.id);
    expect(dead.state).toBe("dead");
    expect(dead.errorCode).toBe("answer_disabled");
    expect(fixture.transport.calls).toHaveLength(0);
    fixture.db.close();
  });

  it("dead-letters an enabled channel with no chat id", async () => {
    const fixture = createFixture({ config: { chatId: null } });
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    expect(await fixture.sender.tick()).toBe(true);
    expect(rowOf(fixture, row.id).errorCode).toBe("channel_unconfigured");
    expect(fixture.transport.calls).toHaveLength(0);
    fixture.db.close();
  });

  it("dead-letters an enabled channel with no bot token", async () => {
    const fixture = createFixture({ config: { token: null } });
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    expect(await fixture.sender.tick()).toBe(true);
    expect(rowOf(fixture, row.id).errorCode).toBe("channel_unconfigured");
    expect(fixture.transport.calls).toHaveLength(0);
    fixture.db.close();
  });

  it("drain stops claiming new chunks", async () => {
    const fixture = createFixture();
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    fixture.sender.drain();
    expect(await fixture.sender.tick()).toBe(false);
    expect(rowOf(fixture, row.id).state).toBe("pending");
    expect(fixture.transport.calls).toHaveLength(0);
    fixture.db.close();
  });

  it("stop awaits the in-flight send and releases the lifecycle activity", async () => {
    const fixture = createFixture();
    let release!: () => void;
    const gate = new Promise<unknown>((resolve) => {
      release = () => resolve({ message_id: 1 });
    });
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    fixture.transport.handler = async () => {
      startedResolve();
      return gate;
    };
    const [row] = insert(fixture, "g1", chunks("g1", 1)).rows;
    if (row === undefined) throw new Error("missing chunk");

    const ticking = fixture.sender.tick();
    await started;
    expect(fixture.lifecycle.count).toBe(1);

    const stopping = fixture.sender.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await ticking;
    await stopping;
    expect(stopped).toBe(true);
    expect(rowOf(fixture, row.id).state).toBe("sent");
    expect(fixture.lifecycle.count).toBe(0);
    fixture.db.close();
  });

  it("resets sending rows to pending on start", async () => {
    const fixture = createFixture();
    insert(fixture, "g1", chunks("g1", 1));
    const claimed = claimNextNotificationChunk(fixture.db, T0);
    if (claimed === undefined) throw new Error("expected a claimed row");
    expect(claimed.state).toBe("sending");

    fixture.sender.start();
    expect(rowOf(fixture, claimed.id).state).toBe("pending");
    await fixture.sender.stop();
    fixture.db.close();
  });

  it("prunes old sent rows and expires old pending rows on start", async () => {
    const fixture = createFixture();
    const old = new Date(T0_MS - 40 * DAY).toISOString();
    insertNotificationGroup(fixture.db, {
      groupId: "old-sent",
      createdAt: old,
      chunks: chunks("old-sent", 1),
    });
    const sent = claimNextNotificationChunk(fixture.db, old);
    if (sent === undefined) throw new Error("expected a claimable row");
    markNotificationChunkSent(fixture.db, sent.id, old);

    const oldPending = new Date(T0_MS - 8 * DAY).toISOString();
    insertNotificationGroup(fixture.db, {
      groupId: "old-pending",
      createdAt: oldPending,
      chunks: chunks("old-pending", 1),
    });

    fixture.sender.start();
    expect(listNotificationGroupRows(fixture.db, "old-sent")).toEqual([]);
    const expired = listNotificationGroupRows(fixture.db, "old-pending");
    expect(expired.map((row) => row.state)).toEqual(["dead"]);
    expect(expired[0]?.errorCode).toBe("expired");
    expect(expired[0]?.payloadJson).toBe("{}");
    await fixture.sender.stop();
    fixture.db.close();
  });

  it("caps the outbox at 500 groups on start", async () => {
    const fixture = createFixture();
    for (let index = 0; index < 505; index += 1) {
      insertNotificationGroup(fixture.db, {
        groupId: `g-${index}`,
        createdAt: T0,
        chunks: chunks(`g-${index}`, 1),
      });
    }
    const before = fixture.db
      .prepare("SELECT COUNT(DISTINCT group_id) AS count FROM notification_outbox")
      .get() as { count: number };
    expect(before.count).toBe(505);

    fixture.sender.start();
    const after = fixture.db
      .prepare("SELECT COUNT(DISTINCT group_id) AS count FROM notification_outbox")
      .get() as { count: number };
    expect(after.count).toBe(500);
    await fixture.sender.stop();
    fixture.db.close();
  });

  it("writes channel state ok after a successful send", async () => {
    const fixture = createFixture();
    insert(fixture, "g1", chunks("g1", 1));

    expect(await fixture.sender.tick()).toBe(true);
    expect(getNotificationChannelState(fixture.db, "telegram")).toMatchObject({
      state: "ok",
      lastError: null,
    });
    fixture.db.close();
  });
});
