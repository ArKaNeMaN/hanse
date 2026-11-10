import { randomUUID } from "node:crypto";
import type { LifecycleActivity } from "../coordinator/lifecycle-activity.js";
import type { SettingsService } from "../settings/service.js";
import type { SettingsTarget } from "../settings/types.js";
import type { SqliteDatabase } from "../store/database.js";
import {
  capNotificationGroups,
  claimNextNotificationChunk,
  expirePendingNotifications,
  insertNotificationGroup,
  listNotificationGroupRows,
  markNotificationChunkDead,
  markNotificationChunkSent,
  type NotificationChunkInput,
  type NotificationOutboxRow,
  pruneSentAndDeadNotifications,
  rescheduleNotificationChunk,
  resetSendingNotifications,
  writeNotificationChannelState,
} from "./outbox.js";
import {
  createTelegramClient,
  type TelegramClient,
  type TelegramClientOptions,
} from "./telegram/client.js";
import { sanitizeNotificationText, type TelegramLink } from "./telegram/format.js";
import { createTelegramTransport } from "./telegram/transport.js";

const CHANNEL = "telegram";
const PER_CHAT_GAP_MS = 1_100;
const MAX_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 1_000;
const STOP_WAIT_MS = 10_000;
const RATE_LIMIT_PADDING_MS = 1_000;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

const NEVER_ABORTED = new AbortController().signal;

export interface TelegramSenderDeps {
  db: SqliteDatabase;
  settings: SettingsService;
  lifecycleActivity?: LifecycleActivity;
  logger?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  clientFactory?: (options: TelegramClientOptions) => TelegramClient;
}

interface NotificationPayload {
  text: string;
  link?: TelegramLink;
  /**
   * Set by the router on a `turn_completed` row enqueued with the full answer. It lets the sender
   * dead-letter a pending full-answer row when `include_answer` was turned off after enqueue.
   */
  answer?: boolean;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function awaitBounded(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function targetFor(row: NotificationOutboxRow): SettingsTarget {
  switch (row.scope) {
    case "app":
      if (row.projectId !== null && row.appKey !== null) {
        return { projectId: row.projectId, appKey: row.appKey };
      }
      return row.projectId === null ? {} : { projectId: row.projectId };
    case "project":
      return row.projectId === null ? {} : { projectId: row.projectId };
    default:
      return {};
  }
}

function parsePayload(raw: string): NotificationPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const candidate = parsed as { text?: unknown; link?: unknown; answer?: unknown };
  if (typeof candidate.text !== "string") return undefined;
  const payload: NotificationPayload = { text: candidate.text };
  if (candidate.link !== undefined) {
    if (typeof candidate.link !== "object" || candidate.link === null) return undefined;
    const link = candidate.link as { text?: unknown; url?: unknown };
    if (typeof link.text !== "string" || typeof link.url !== "string") return undefined;
    payload.link = { text: link.text, url: link.url };
  }
  if (typeof candidate.answer === "boolean") payload.answer = candidate.answer;
  return payload;
}

function payloadText(raw: string): string {
  return parsePayload(raw)?.text ?? "";
}

function dedupeBase(dedupeKey: string, chunkIndex: number): string {
  const suffix = `:${chunkIndex}`;
  return dedupeKey.endsWith(suffix) ? dedupeKey.slice(0, -suffix.length) : dedupeKey;
}

function sanitize(value: string, secrets: readonly (string | undefined)[]): string {
  return sanitizeNotificationText(value, secrets);
}

/**
 * The single coordinator-side sender loop for the notification outbox.
 *
 * It claims one eligible chunk at a time in strict group order, re-checks the effective Telegram
 * channel for the row's scope, and writes `notification_channel_state`. `start()` runs the boot
 * maintenance (crash recovery, prune, cap, expiry); `tick()` performs one claim/send cycle and is
 * the deterministic test seam. The bot token and proxy never reach the logger or a persisted error.
 */
export class TelegramSender {
  readonly #db: SqliteDatabase;
  readonly #settings: SettingsService;
  readonly #lifecycleActivity: LifecycleActivity | undefined;
  readonly #logger: (message: string) => void;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #clientFactory: (options: TelegramClientOptions) => TelegramClient;
  readonly #lastSendAt = new Map<string, number>();
  #lastMaintenanceAt = 0;
  #loopPromise: Promise<void> | undefined;
  #currentSend: Promise<void> | undefined;
  #wakeController: AbortController | undefined;
  #started = false;
  #stopping = false;
  #draining = false;

  constructor(deps: TelegramSenderDeps) {
    this.#db = deps.db;
    this.#settings = deps.settings;
    this.#lifecycleActivity = deps.lifecycleActivity;
    this.#logger = deps.logger ?? (() => undefined);
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#clientFactory = deps.clientFactory ?? createTelegramClient;
  }

  start(): void {
    if (this.#started) return;
    const now = new Date(this.#now()).toISOString();
    resetSendingNotifications(this.#db, now);
    pruneSentAndDeadNotifications(this.#db, { now });
    capNotificationGroups(this.#db);
    expirePendingNotifications(this.#db, { now });
    this.#lastMaintenanceAt = this.#now();
    this.#started = true;
    this.#stopping = false;
    this.#draining = false;
    this.#loopPromise = this.#run();
  }

  async stop(): Promise<void> {
    this.#draining = true;
    this.#stopping = true;
    this.#wake();
    const current = this.#currentSend;
    if (current !== undefined) {
      await awaitBounded(current, STOP_WAIT_MS);
    }
    const loop = this.#loopPromise;
    if (loop !== undefined) {
      await loop.catch(() => undefined);
    }
    this.#loopPromise = undefined;
    this.#currentSend = undefined;
    this.#started = false;
  }

  drain(): void {
    this.#draining = true;
    this.#wake();
  }

  async tick(): Promise<boolean> {
    if (this.#stopping || this.#draining) return false;
    const row = claimNextNotificationChunk(this.#db, new Date(this.#now()).toISOString());
    if (row === undefined) {
      this.#maybeMaintain();
      return false;
    }
    const send = this.#processRow(row);
    this.#currentSend = send;
    try {
      await send;
    } finally {
      if (this.#currentSend === send) this.#currentSend = undefined;
    }
    this.#maybeMaintain();
    return true;
  }

  #maybeMaintain(): void {
    const nowMs = this.#now();
    if (nowMs - this.#lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
    this.#lastMaintenanceAt = nowMs;
    const now = new Date(nowMs).toISOString();
    pruneSentAndDeadNotifications(this.#db, { now });
    capNotificationGroups(this.#db);
    expirePendingNotifications(this.#db, { now });
  }

  async #run(): Promise<void> {
    await Promise.resolve();
    while (!this.#stopping) {
      if (this.#draining) {
        await this.#wait(POLL_INTERVAL_MS);
        continue;
      }
      try {
        const claimed = await this.tick();
        if (!claimed) await this.#wait(POLL_INTERVAL_MS);
      } catch (error) {
        this.#logger(`telegram sender: ${sanitize(describeError(error), [])}`);
        await this.#wait(POLL_INTERVAL_MS);
      }
    }
  }

  async #wait(ms: number): Promise<void> {
    const controller = new AbortController();
    this.#wakeController = controller;
    try {
      await this.#sleep(ms, controller.signal);
    } finally {
      if (this.#wakeController === controller) this.#wakeController = undefined;
    }
  }

  #wake(): void {
    this.#wakeController?.abort();
  }

  async #processRow(row: NotificationOutboxRow): Promise<void> {
    const target = targetFor(row);
    const resolved = this.#settings.resolve(target);
    const notifications = resolved.effective.notifications;
    const now = new Date(this.#now()).toISOString();

    if (notifications.telegram.enabled.value !== true) {
      this.#dropRow(row, "channel_disabled", now);
      return;
    }
    const mode = notifications.mode.value ?? "all";
    if (mode === "off" || (row.kind === "turn_completed" && mode !== "all")) {
      this.#dropRow(row, "mode_attention", now);
      return;
    }

    const payload = parsePayload(row.payloadJson);
    if (payload === undefined) {
      this.#dropRow(row, "invalid_payload", now);
      return;
    }
    if (
      row.kind === "turn_completed" &&
      payload.answer === true &&
      notifications.includeAnswer.value === false
    ) {
      this.#dropRow(row, "answer_disabled", now);
      return;
    }

    const chatId = notifications.telegram.chatId.value;
    const config = this.#settings.telegramConfig(target);
    if (
      chatId === null ||
      chatId.length === 0 ||
      resolved.telegram.botToken.state !== "set" ||
      config.botToken === undefined
    ) {
      this.#dropRow(row, "channel_unconfigured", now);
      return;
    }

    const secrets = [config.botToken, config.proxyUrl];
    const chatKey = String(chatId);
    await this.#waitForChatGap(chatKey);

    const rows = listNotificationGroupRows(this.#db, row.groupId);
    const suffix = rows
      .filter((candidate) => candidate.chunkIndex >= row.chunkIndex && candidate.state !== "sent")
      .map((candidate) => payloadText(candidate.payloadJson));
    const lastIndex = row.chunkCount - 1;
    const lastRow = rows.find((candidate) => candidate.chunkIndex === lastIndex);
    const groupLink = lastRow === undefined ? undefined : parsePayload(lastRow.payloadJson)?.link;
    const link = row.chunkIndex === lastIndex ? groupLink : undefined;

    const client = this.#clientFactory({
      transport: createTelegramTransport({
        token: config.botToken,
        apiBaseUrl: notifications.telegram.apiBaseUrl.value ?? undefined,
        proxyUrl: config.proxyUrl ?? null,
      }),
      chatId,
    });

    this.#lastSendAt.set(chatKey, this.#now());
    const signal = new AbortController().signal;
    const release = this.#lifecycleActivity?.begin("telegram_notify");
    let result: Awaited<ReturnType<TelegramClient["sendRichMessage"]>>;
    try {
      result =
        row.format === "rich"
          ? await client.sendRichMessage(payload.text, {
              signal,
              link,
              chunkIndex: row.chunkIndex,
              remainingMarkdown: suffix,
              attempts: row.attempts,
            })
          : await client.sendMessage(payload.text, { signal, link, attempts: row.attempts });
    } finally {
      release?.();
    }

    this.#applyResult(row, result, groupLink, secrets);
  }

  async #waitForChatGap(chatKey: string): Promise<void> {
    const last = this.#lastSendAt.get(chatKey);
    if (last === undefined) return;
    const remaining = PER_CHAT_GAP_MS - (this.#now() - last);
    if (remaining > 0) await this.#sleep(remaining, NEVER_ABORTED);
  }

  #applyResult(
    row: NotificationOutboxRow,
    result: Awaited<ReturnType<TelegramClient["sendRichMessage"]>>,
    groupLink: TelegramLink | undefined,
    secrets: readonly (string | undefined)[],
  ): void {
    const now = new Date(this.#now()).toISOString();
    switch (result.kind) {
      case "sent":
        markNotificationChunkSent(this.#db, row.id, now);
        writeNotificationChannelState(this.#db, CHANNEL, "ok", null, now);
        return;
      case "fallback":
        this.#applyFallback(row, result.plainChunks, result.deadFromIndex, groupLink, now);
        return;
      case "retry":
        this.#applyRetry(row, result, secrets, now);
        return;
      case "dead":
        this.#deadLetter(row, result.errorCode, sanitize(result.description, secrets), now);
        return;
    }
  }

  #applyRetry(
    row: NotificationOutboxRow,
    result: Extract<Awaited<ReturnType<TelegramClient["sendRichMessage"]>>, { kind: "retry" }>,
    secrets: readonly (string | undefined)[],
    now: string,
  ): void {
    const lastError = sanitize(result.description, secrets);
    if (result.errorCode === "telegram_rate_limited") {
      const next = new Date(
        this.#now() + result.retryAfterMs + RATE_LIMIT_PADDING_MS,
      ).toISOString();
      rescheduleNotificationChunk(this.#db, row.id, {
        nextAttemptAt: next,
        attempts: row.attempts,
        errorCode: result.errorCode,
        lastError,
        now,
      });
    } else {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        this.#deadLetter(row, result.errorCode, lastError, now);
        return;
      }
      const next = new Date(this.#now() + result.retryAfterMs).toISOString();
      rescheduleNotificationChunk(this.#db, row.id, {
        nextAttemptAt: next,
        attempts,
        errorCode: result.errorCode,
        lastError,
        now,
      });
    }
    writeNotificationChannelState(this.#db, CHANNEL, "error", lastError, now);
  }

  #applyFallback(
    row: NotificationOutboxRow,
    plainChunks: readonly { text: string; link?: TelegramLink }[],
    deadFromIndex: number,
    groupLink: TelegramLink | undefined,
    now: string,
  ): void {
    const run = this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE notification_outbox
           SET state = 'dead', error_code = 'rich_fallback', payload_json = '{}', updated_at = :now
           WHERE group_id = :groupId AND chunk_index >= :deadFromIndex AND state <> 'sent'`,
        )
        .run({ groupId: row.groupId, deadFromIndex, now });

      const groupId = randomUUID();
      const base = dedupeBase(row.dedupeKey, row.chunkIndex);
      const answer = parsePayload(row.payloadJson)?.answer === true;
      const chunks: NotificationChunkInput[] = plainChunks.map((chunk, index) => {
        const isLast = index === plainChunks.length - 1;
        const link = chunk.link ?? (isLast ? groupLink : undefined);
        const payload: NotificationPayload = {
          text: chunk.text,
          ...(link === undefined ? {} : { link }),
          ...(answer ? { answer: true } : {}),
        };
        return {
          chunkIndex: index,
          dedupeKey: `${base}:plain:${groupId}:${index}`,
          kind: row.kind,
          format: "plain",
          scope: row.scope,
          projectId: row.projectId,
          appKey: row.appKey,
          appId: row.appId,
          sessionId: row.sessionId,
          payloadJson: JSON.stringify(payload),
          nextAttemptAt: now,
        };
      });
      insertNotificationGroup(this.#db, { groupId, createdAt: now, chunks });
    });
    run();
  }

  #dropRow(row: NotificationOutboxRow, errorCode: string, now: string): void {
    markNotificationChunkDead(this.#db, row.id, errorCode, null, now);
  }

  #deadLetter(
    row: NotificationOutboxRow,
    errorCode: string,
    lastError: string | null,
    now: string,
  ): void {
    markNotificationChunkDead(this.#db, row.id, errorCode, lastError, now);
    writeNotificationChannelState(this.#db, CHANNEL, "error", lastError, now);
  }
}
