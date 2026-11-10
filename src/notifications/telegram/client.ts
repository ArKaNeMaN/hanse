import { type PlainChunk, planPlainFallback, type TelegramLink } from "./format.js";
import { TelegramApiError, type TelegramErrorCode, type TelegramTransport } from "./transport.js";

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

export interface TelegramClientOptions {
  transport: TelegramTransport;
  chatId: string | number;
}

export interface TelegramSendOptions {
  signal: AbortSignal;
  link?: TelegramLink;
  /** Retry count already spent on this chunk; drives the 5xx exponential backoff. */
  attempts?: number;
}

export interface RichMessageOptions extends TelegramSendOptions {
  /** Remaining rich suffix (the failed chunk through the last chunk) for a plain fallback. */
  remainingMarkdown?: readonly string[];
  /** Zero-based index of the chunk being sent. */
  chunkIndex?: number;
}

export interface SentResult {
  kind: "sent";
  messageId?: number;
}

export interface RetryResult {
  kind: "retry";
  errorCode: TelegramErrorCode;
  retryAfterMs: number;
  description: string;
}

export interface DeadResult {
  kind: "dead";
  errorCode: TelegramErrorCode;
  description: string;
}

export interface FallbackResult {
  kind: "fallback";
  errorCode: "telegram_format" | "telegram_not_found";
  /** The rich rows from this index through the end must be marked dead. */
  deadFromIndex: number;
  /** Replacement plain rows; the link is on the last row. */
  plainChunks: PlainChunk[];
  description: string;
}

export type TelegramSendResult = SentResult | RetryResult | DeadResult | FallbackResult;

function messageIdOf(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const messageId = (result as { message_id?: unknown }).message_id;
  return typeof messageId === "number" ? messageId : undefined;
}

function backoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 0), 16);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}

function replyMarkup(link: TelegramLink | undefined): Record<string, unknown> | undefined {
  if (link === undefined) return undefined;
  return { inline_keyboard: [[{ text: link.text, url: link.url }]] };
}

function resultFor(error: unknown, options: TelegramSendOptions): RetryResult | DeadResult {
  if (!(error instanceof TelegramApiError)) {
    return {
      kind: "dead",
      errorCode: "telegram_unavailable",
      description: "Telegram request failed",
    };
  }
  if (error.code === "telegram_rate_limited") {
    const retryAfterMs =
      error.retryAfterSeconds === undefined
        ? DEFAULT_RETRY_AFTER_MS
        : Math.max(0, error.retryAfterSeconds * 1_000);
    return {
      kind: "retry",
      errorCode: error.code,
      retryAfterMs,
      description: error.message,
    };
  }
  if (error.code === "telegram_unavailable") {
    return {
      kind: "retry",
      errorCode: error.code,
      retryAfterMs: backoffMs(options.attempts ?? 0),
      description: error.message,
    };
  }
  return { kind: "dead", errorCode: error.code, description: error.message };
}

/**
 * Thin Bot API client.
 *
 * Rich chunks are never retried through `sendMessage` unchanged: a format/limit 400 or an unknown
 * method 404 returns a `fallback` result carrying the re-chunked plain suffix group. The sender
 * marks the original rich rows from `deadFromIndex` dead and inserts the returned plain rows.
 */
export class TelegramClient {
  readonly #transport: TelegramTransport;
  readonly #chatId: string | number;

  constructor(options: TelegramClientOptions) {
    this.#transport = options.transport;
    this.#chatId = options.chatId;
  }

  async sendRichMessage(
    markdown: string,
    options: RichMessageOptions,
  ): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = {
      chat_id: this.#chatId,
      rich_message: { markdown },
    };
    const markup = replyMarkup(options.link);
    if (markup !== undefined) body.reply_markup = markup;

    try {
      const result = await this.#transport.call("sendRichMessage", body, options.signal);
      const messageId = messageIdOf(result);
      return messageId === undefined ? { kind: "sent" } : { kind: "sent", messageId };
    } catch (error) {
      if (
        error instanceof TelegramApiError &&
        (error.code === "telegram_format" || error.code === "telegram_not_found")
      ) {
        const suffix = options.remainingMarkdown ?? [markdown];
        return {
          kind: "fallback",
          errorCode: error.code,
          deadFromIndex: options.chunkIndex ?? 0,
          plainChunks: planPlainFallback(suffix, options.link),
          description: error.message,
        };
      }
      return resultFor(error, options);
    }
  }

  async sendMessage(text: string, options: TelegramSendOptions): Promise<TelegramSendResult> {
    const body: Record<string, unknown> = {
      chat_id: this.#chatId,
      text,
      link_preview_options: { is_disabled: true },
    };
    const markup = replyMarkup(options.link);
    if (markup !== undefined) body.reply_markup = markup;

    try {
      const result = await this.#transport.call("sendMessage", body, options.signal);
      const messageId = messageIdOf(result);
      return messageId === undefined ? { kind: "sent" } : { kind: "sent", messageId };
    } catch (error) {
      return resultFor(error, options);
    }
  }
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  return new TelegramClient(options);
}
