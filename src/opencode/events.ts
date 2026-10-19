import {
  type NormalizedPermissionRequest,
  type NormalizedQuestionRequest,
  type NormalizedTodo,
  normalizePermissionRequest,
  normalizeQuestionRequest,
  normalizeTodos,
  type PromptSource,
} from "./prompts.js";

export const MAX_SSE_FRAME_BYTES = 1024 * 1024;

export type SseWarningCode = "frame_too_large";
export type StreamWarningCode = SseWarningCode | "invalid_json";

export interface SseFrame {
  data: string;
}

export interface SseWarning {
  code: SseWarningCode;
  message: string;
}

export interface SseParseBatch {
  frames: SseFrame[];
  warnings: SseWarning[];
}

export interface SseParserOptions {
  maxFrameBytes?: number;
}

export type HanseEvent =
  | { type: "stream.ready" }
  | { type: "question.asked"; request: NormalizedQuestionRequest }
  | {
      type: "question.replied";
      sessionID: string;
      requestID: string;
      source: PromptSource;
    }
  | {
      type: "question.rejected";
      sessionID: string;
      requestID: string;
      source: PromptSource;
    }
  | { type: "permission.asked"; request: NormalizedPermissionRequest }
  | {
      type: "permission.replied";
      sessionID: string;
      requestID: string;
      reply: string;
      source: PromptSource;
    }
  | {
      type: "todo.updated";
      sessionID: string;
      todos: NormalizedTodo[];
      truncated: boolean;
    }
  | { type: "session.activity"; sessionID: string }
  | { type: "stream.warning"; code: StreamWarningCode; message?: string };

export interface EventStreamOptions {
  signal?: AbortSignal;
  maxFrameBytes?: number;
  /** Called after the upstream reader is attached, before any frame is read. */
  onAttached?: () => void;
}

export interface EventStream {
  events: AsyncGenerator<HanseEvent>;
  close(): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse an upstream SSE byte stream into data frames.
 *
 * The parser is incremental: it keeps the decoder and any partial frame between `push` calls, so
 * chunk boundaries, CRLF pairs, and UTF-8 sequences may split anywhere.
 */
export class SseParser {
  private readonly maxFrameBytes: number;
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private pendingBytes = 0;
  private discarding = false;

  constructor(options: SseParserOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
  }

  push(chunk: Uint8Array | string): SseParseBatch {
    const chunkBytes =
      typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    this.pendingBytes += chunkBytes;
    return this.drain();
  }

  flush(): SseParseBatch {
    const tail = this.decoder.decode();
    if (tail.length > 0) {
      this.buffer += tail;
      this.pendingBytes += Buffer.byteLength(tail, "utf8");
    }
    const batch = this.drain();
    if (this.buffer.length === 0) return batch;
    const block = this.buffer;
    this.buffer = "";
    this.pendingBytes = 0;
    if (this.discarding) {
      this.discarding = false;
      return batch;
    }
    const frame = this.frameFromBlock(block, batch.warnings);
    if (frame !== undefined) batch.frames.push(frame);
    return batch;
  }

  private drain(): SseParseBatch {
    const frames: SseFrame[] = [];
    const warnings: SseWarning[] = [];
    this.buffer = this.buffer.replaceAll("\r\n", "\n");

    for (;;) {
      if (this.discarding) {
        const index = this.buffer.indexOf("\n\n");
        if (index < 0) {
          this.buffer = this.buffer.endsWith("\n") ? "\n" : "";
          this.pendingBytes = Buffer.byteLength(this.buffer, "utf8");
          break;
        }
        this.buffer = this.buffer.slice(index + 2);
        this.pendingBytes = Buffer.byteLength(this.buffer, "utf8");
        this.discarding = false;
        continue;
      }

      const index = this.buffer.indexOf("\n\n");
      if (index < 0) {
        if (this.pendingBytes > this.maxFrameBytes) {
          this.discarding = true;
          this.buffer = "";
          this.pendingBytes = 0;
          warnings.push({
            code: "frame_too_large",
            message: `dropped an SSE frame larger than ${this.maxFrameBytes} bytes`,
          });
        }
        break;
      }

      const block = this.buffer.slice(0, index);
      const consumed = Buffer.byteLength(block, "utf8") + 2;
      this.buffer = this.buffer.slice(index + 2);
      this.pendingBytes = Math.max(0, this.pendingBytes - consumed);
      const frame = this.frameFromBlock(block, warnings);
      if (frame !== undefined) frames.push(frame);
    }

    this.pendingBytes = Buffer.byteLength(this.buffer, "utf8");
    return { frames, warnings };
  }

  private frameFromBlock(block: string, warnings: SseWarning[]): SseFrame | undefined {
    if (Buffer.byteLength(block, "utf8") > this.maxFrameBytes) {
      warnings.push({
        code: "frame_too_large",
        message: `dropped an SSE frame larger than ${this.maxFrameBytes} bytes`,
      });
      return undefined;
    }
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
    return data.length === 0 ? undefined : { data: data.join("\n") };
  }
}

/**
 * Project raw `/event` payloads onto the bounded Hanse event vocabulary.
 *
 * v1 and v2 prompts are normalized to the same Hanse names; `source` and `${source}:${id}` keys
 * keep the two APIs from cross-wiring. Duplicate envelope IDs and duplicate asked requests are
 * dropped, and terminal events release the key.
 */
export class EventProjector {
  private readonly eventIds = new Set<string>();
  private readonly askedKeys = new Set<string>();

  project(raw: unknown): HanseEvent[] {
    const event = asRecord(raw);
    if (event === undefined) return [];
    const type = asString(event.type);
    if (type === undefined) return [];

    const envelopeID = asString(event.id);
    if (envelopeID !== undefined) {
      if (this.eventIds.has(envelopeID)) return [];
      this.remember(this.eventIds, envelopeID);
    }

    const properties = asRecord(event.properties) ?? {};
    switch (type) {
      case "question.asked":
        return this.askedQuestion(properties, "v1");
      case "question.v2.asked":
        return this.askedQuestion(properties, "v2");
      case "permission.asked":
        return this.askedPermission(properties, "v1");
      case "permission.v2.asked":
        return this.askedPermission(properties, "v2");
      case "question.replied":
        return this.questionDone(properties, "question.replied", "v1");
      case "question.v2.replied":
        return this.questionDone(properties, "question.replied", "v2");
      case "question.rejected":
        return this.questionDone(properties, "question.rejected", "v1");
      case "question.v2.rejected":
        return this.questionDone(properties, "question.rejected", "v2");
      case "permission.replied":
        return this.permissionDone(properties, "v1");
      case "permission.v2.replied":
        return this.permissionDone(properties, "v2");
      case "todo.updated":
        return this.todoUpdated(properties);
      default:
        return this.activity(properties);
    }
  }

  private askedQuestion(properties: Record<string, unknown>, source: PromptSource): HanseEvent[] {
    const request = normalizeQuestionRequest(properties, source);
    if (request === undefined) return this.activity(properties);
    if (this.askedKeys.has(request.key)) return [];
    this.remember(this.askedKeys, request.key);
    return [{ type: "question.asked", request }];
  }

  private askedPermission(properties: Record<string, unknown>, source: PromptSource): HanseEvent[] {
    const request = normalizePermissionRequest(properties, source);
    if (request === undefined) return this.activity(properties);
    if (this.askedKeys.has(request.key)) return [];
    this.remember(this.askedKeys, request.key);
    return [{ type: "permission.asked", request }];
  }

  private questionDone(
    properties: Record<string, unknown>,
    type: "question.replied" | "question.rejected",
    source: PromptSource,
  ): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    const requestID = asString(properties.requestID);
    if (sessionID === undefined || requestID === undefined) return this.activity(properties);
    this.askedKeys.delete(`${source}:${requestID}`);
    return [{ type, sessionID, requestID, source }];
  }

  private permissionDone(properties: Record<string, unknown>, source: PromptSource): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    const requestID = asString(properties.requestID);
    const reply = asString(properties.reply);
    if (sessionID === undefined || requestID === undefined || reply === undefined) {
      return this.activity(properties);
    }
    this.askedKeys.delete(`${source}:${requestID}`);
    return [{ type: "permission.replied", sessionID, requestID, reply, source }];
  }

  private todoUpdated(properties: Record<string, unknown>): HanseEvent[] {
    const sessionID = asString(properties.sessionID);
    if (sessionID === undefined) return this.activity(properties);
    const { todos, truncated } = normalizeTodos(properties.todos);
    return [{ type: "todo.updated", sessionID, todos, truncated }];
  }

  private activity(properties: Record<string, unknown>): HanseEvent[] {
    const sessionID = extractSessionID(properties);
    return sessionID === undefined ? [] : [{ type: "session.activity", sessionID }];
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value);
    if (set.size <= 5_000) return;
    const oldest = set.values().next();
    if (!oldest.done) set.delete(oldest.value);
  }
}

function extractSessionID(properties: Record<string, unknown>): string | undefined {
  const direct = asString(properties.sessionID);
  if (direct !== undefined) return direct;
  const info = asRecord(properties.info);
  const infoSession = asString(info?.sessionID);
  if (infoSession !== undefined) return infoSession;
  const infoID = asString(info?.id);
  if (infoID !== undefined) return infoID;
  const part = asRecord(properties.part);
  return asString(part?.sessionID);
}

/**
 * Consume an upstream SSE body and yield projected Hanse events.
 *
 * The reader is attached synchronously, so `onAttached` is the correct place for a route to emit
 * `stream.ready`. Aborting the signal cancels the upstream reader.
 */
export function createEventStream(
  body: ReadableStream<Uint8Array>,
  options: EventStreamOptions = {},
): EventStream {
  const parser = new SseParser({ maxFrameBytes: options.maxFrameBytes });
  const projector = new EventProjector();
  const reader = body.getReader();
  const warned = new Set<StreamWarningCode>();
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
  };
  const onAbort = (): void => close();
  if (options.signal !== undefined) {
    if (options.signal.aborted) close();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  options.onAttached?.();

  const produce = (batch: SseParseBatch): HanseEvent[] => {
    const output: HanseEvent[] = [];
    for (const warning of batch.warnings) {
      if (warned.has(warning.code)) continue;
      warned.add(warning.code);
      output.push({ type: "stream.warning", code: warning.code, message: warning.message });
    }
    for (const frame of batch.frames) {
      let raw: unknown;
      try {
        raw = JSON.parse(frame.data);
      } catch {
        if (warned.has("invalid_json")) continue;
        warned.add("invalid_json");
        output.push({
          type: "stream.warning",
          code: "invalid_json",
          message: "dropped an SSE frame with invalid JSON",
        });
        continue;
      }
      output.push(...projector.project(raw));
    }
    return output;
  };

  async function* iterate(): AsyncGenerator<HanseEvent> {
    try {
      while (!closed) {
        const { done, value } = await reader.read();
        if (done || closed) break;
        for (const event of produce(parser.push(value))) yield event;
      }
      if (!closed) {
        for (const event of produce(parser.flush())) yield event;
      }
    } catch {
      // Abort and upstream read failures both end the stream.
    } finally {
      close();
    }
  }

  return { events: iterate(), close };
}
