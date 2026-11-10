import { describe, expect, it } from "vitest";
import { TelegramClient } from "../src/notifications/telegram/client.js";
import { PLAIN_CHAR_BUDGET } from "../src/notifications/telegram/format.js";
import {
  TelegramApiError,
  type TelegramTransport,
} from "../src/notifications/telegram/transport.js";

const SIGNAL = new AbortController().signal;
const LINK = { text: "Open session", url: "https://hanse.test/chat?session=s" };

class FakeTransport implements TelegramTransport {
  readonly calls: Array<{ method: string; body: unknown }> = [];

  constructor(
    private readonly handler: (method: string, body: unknown) => Promise<unknown> = async () => ({
      message_id: 1,
    }),
  ) {}

  call(method: string, body: unknown, _signal: AbortSignal): Promise<unknown> {
    this.calls.push({ method, body });
    return this.handler(method, body);
  }
}

function plainLength(value: string): number {
  return Math.max([...value].length, value.length);
}

describe("telegram client", () => {
  it("sends rich messages with rich_message.markdown and a link button", async () => {
    const transport = new FakeTransport();
    const client = new TelegramClient({ transport, chatId: "42" });

    const result = await client.sendRichMessage("**hello**", { signal: SIGNAL, link: LINK });

    expect(result).toEqual({ kind: "sent", messageId: 1 });
    expect(transport.calls[0]?.method).toBe("sendRichMessage");
    expect(transport.calls[0]?.body).toEqual({
      chat_id: "42",
      rich_message: { markdown: "**hello**" },
      reply_markup: { inline_keyboard: [[{ text: LINK.text, url: LINK.url }]] },
    });
    expect(transport.calls[0]?.body).not.toHaveProperty("link_preview_options");
  });

  it("sends plain messages with link previews disabled", async () => {
    const transport = new FakeTransport();
    const client = new TelegramClient({ transport, chatId: 42 });

    await client.sendMessage("hello", { signal: SIGNAL, link: LINK });

    expect(transport.calls[0]?.method).toBe("sendMessage");
    expect(transport.calls[0]?.body).toEqual({
      chat_id: 42,
      text: "hello",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: LINK.text, url: LINK.url }]] },
    });
  });

  it("maps 429 to a retry with retry_after", async () => {
    const transport = new FakeTransport(async () => {
      throw new TelegramApiError("telegram_rate_limited", "Too Many Requests", {
        status: 429,
        retryAfterSeconds: 7,
      });
    });
    const client = new TelegramClient({ transport, chatId: "42" });

    await expect(client.sendMessage("hello", { signal: SIGNAL })).resolves.toEqual({
      kind: "retry",
      errorCode: "telegram_rate_limited",
      retryAfterMs: 7_000,
      description: "Too Many Requests",
    });
  });

  it("maps 5xx/network failures to exponential backoff", async () => {
    const transport = new FakeTransport(async () => {
      throw new TelegramApiError("telegram_unavailable", "Telegram request failed", {
        status: 500,
      });
    });
    const client = new TelegramClient({ transport, chatId: "42" });

    await expect(client.sendMessage("hello", { signal: SIGNAL })).resolves.toMatchObject({
      kind: "retry",
      errorCode: "telegram_unavailable",
      retryAfterMs: 5_000,
    });
    await expect(
      client.sendMessage("hello", { signal: SIGNAL, attempts: 2 }),
    ).resolves.toMatchObject({ kind: "retry", retryAfterMs: 20_000 });
    await expect(
      client.sendMessage("hello", { signal: SIGNAL, attempts: 20 }),
    ).resolves.toMatchObject({ kind: "retry", retryAfterMs: 300_000 });
  });

  it("maps 401/403 to a permanent dead letter", async () => {
    for (const status of [401, 403]) {
      const transport = new FakeTransport(async () => {
        throw new TelegramApiError("telegram_unauthorized", "Unauthorized", { status });
      });
      const client = new TelegramClient({ transport, chatId: "42" });
      await expect(client.sendRichMessage("hello", { signal: SIGNAL })).resolves.toMatchObject({
        kind: "dead",
        errorCode: "telegram_unauthorized",
      });
    }
  });

  it("maps a non-format 400 to a dead letter", async () => {
    const transport = new FakeTransport(async () => {
      throw new TelegramApiError("telegram_rejected", "chat not found", { status: 400 });
    });
    const client = new TelegramClient({ transport, chatId: "42" });
    await expect(client.sendRichMessage("hello", { signal: SIGNAL })).resolves.toMatchObject({
      kind: "dead",
      errorCode: "telegram_rejected",
    });
  });

  it("re-chunks the remaining rich suffix into a linked plain group on a format 400", async () => {
    const transport = new FakeTransport(async () => {
      throw new TelegramApiError("telegram_format", "can't parse entities", { status: 400 });
    });
    const client = new TelegramClient({ transport, chatId: "42" });
    const suffix = ["x".repeat(9_000), "tail"];

    const result = await client.sendRichMessage("x".repeat(9_000), {
      signal: SIGNAL,
      link: LINK,
      chunkIndex: 3,
      remainingMarkdown: suffix,
    });

    expect(result.kind).toBe("fallback");
    if (result.kind !== "fallback") return;
    expect(result.errorCode).toBe("telegram_format");
    expect(result.deadFromIndex).toBe(3);
    expect(result.plainChunks.length).toBeGreaterThan(1);
    for (const chunk of result.plainChunks) {
      expect(plainLength(chunk.text)).toBeLessThanOrEqual(PLAIN_CHAR_BUDGET);
    }
    expect(result.plainChunks[result.plainChunks.length - 1]?.link).toEqual(LINK);
    expect(result.plainChunks.slice(0, -1).every((chunk) => chunk.link === undefined)).toBe(true);
    expect(result.plainChunks.some((chunk) => chunk.text === "x".repeat(9_000))).toBe(false);
  });

  it("treats a 404 unknown method as a plain fallback", async () => {
    const transport = new FakeTransport(async () => {
      throw new TelegramApiError("telegram_not_found", "Not Found", { status: 404 });
    });
    const client = new TelegramClient({ transport, chatId: "42" });
    await expect(
      client.sendRichMessage("hello", { signal: SIGNAL, remainingMarkdown: ["hello"] }),
    ).resolves.toMatchObject({
      kind: "fallback",
      errorCode: "telegram_not_found",
      deadFromIndex: 0,
    });
  });

  it("never falls back for a plain send error", async () => {
    const transport = new FakeTransport(async () => {
      throw new TelegramApiError("telegram_format", "message is too long", { status: 400 });
    });
    const client = new TelegramClient({ transport, chatId: "42" });
    await expect(client.sendMessage("hello", { signal: SIGNAL })).resolves.toMatchObject({
      kind: "dead",
      errorCode: "telegram_format",
    });
  });

  it("maps an unexpected error to a sanitized dead letter", async () => {
    const transport = new FakeTransport(async () => {
      throw new Error("boom 123:SUPER-SECRET");
    });
    const client = new TelegramClient({ transport, chatId: "42" });
    await expect(client.sendMessage("hello", { signal: SIGNAL })).resolves.toEqual({
      kind: "dead",
      errorCode: "telegram_unavailable",
      description: "Telegram request failed",
    });
  });
});
