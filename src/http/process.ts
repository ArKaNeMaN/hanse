import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { AppStreamRegistry } from "../attachments/streams.js";
import { processEvents } from "../opencode/process-events.js";
import { type ProcessEvent, readProcessEvents, readProcessSnapshot } from "../store/process.js";
import { findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import { registerSseDrain } from "./deploy.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const PROCESS_PATH = /^\/api\/apps\/([^/]+)\/process$/;
const PROCESS_EVENTS_PATH = /^\/api\/apps\/([^/]+)\/process\/events$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_TRANSITIONS = 256;
const SLOW_CONSUMER_BYTES = 1024 * 1024;

/** Process streams are limited separately from the chat app streams (design §8.3). */
export const processStreams = new AppStreamRegistry(4);

function json(status: number, value: unknown, headers?: Record<string, string>): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    ...(headers === undefined ? {} : { headers }),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Route matcher for the human-only process read endpoint. */
export function isProcessRoute(method: string, pathname: string): boolean {
  return method === "GET" && PROCESS_PATH.test(pathname);
}

export function handleProcess(deps: HttpDeps, request: HttpRequest): HttpResponse {
  const match = PROCESS_PATH.exec(request.path);
  if (match === null || request.method !== "GET") {
    return json(404, { error: "not found" });
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may read process status" });
  }
  const projectId = request.query?.project;
  if (projectId === undefined || projectId.length === 0) {
    return json(400, { error: "project query is required" });
  }
  const project = deps.getProjects().find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return json(404, { error: "project not found" });
  }
  const found = findApp(deps, project.id, safeDecode(match[1] ?? ""));
  if (found === undefined) {
    return json(404, { error: "application not found" });
  }
  if (found.app.deleting || found.project.deleting) {
    return json(409, { error: "application is pending deletion", code: "deletion_pending" });
  }

  const rawLimit = request.query?.limit;
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : parsePositiveInteger(rawLimit);
  if (limit === undefined || limit > MAX_LIMIT) {
    return json(400, { error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
  }
  const rawBefore = request.query?.before;
  const before = rawBefore === undefined ? undefined : parsePositiveInteger(rawBefore);
  if (rawBefore !== undefined && before === undefined) {
    return json(400, { error: "before must be a positive integer" });
  }

  const snapshot = readProcessSnapshot(deps.db, found.app.id);
  const page = readProcessEvents(deps.db, found.app.id, {
    limit,
    ...(before === undefined ? {} : { before }),
  });
  return json(
    200,
    {
      current: {
        state: snapshot.state,
        phase: snapshot.phase,
        attemptId: snapshot.attemptId,
        startedAt: snapshot.startedAt,
        updatedAt: snapshot.updatedAt,
        error: snapshot.error,
        lastEventId: snapshot.lastEventId,
      },
      events: page.events,
      nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
    },
    { "cache-control": "no-store" },
  );
}

/** Route matcher for the always-on process SSE endpoint. */
export function isProcessEventsRoute(method: string, pathname: string): boolean {
  return method === "GET" && PROCESS_EVENTS_PATH.test(pathname);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function writeChunk(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return Promise.resolve();
  }
  if (response.write(chunk)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = (): void => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

function heartbeatInterval(): number {
  const override = Number(process.env.HANSE_EVENT_HEARTBEAT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_HEARTBEAT_MS;
}

interface ProcessFrame {
  type: string;
  [key: string]: unknown;
}

/**
 * Stream durable process transitions for one application.
 *
 * The route is deliberately independent of the agent endpoint: a stopped, starting, stopping, or
 * failed app still receives its snapshot and live transitions from the module-level process bus.
 */
export async function streamProcessEvents(
  deps: HttpDeps,
  request: HttpRequest,
  response: ServerResponse,
): Promise<void> {
  const match = PROCESS_EVENTS_PATH.exec(request.path);
  if (match === null) {
    writeJson(response, 404, { error: "not found" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method not allowed" });
    return;
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    writeJson(response, 401, { error: "sign in required" });
    return;
  }
  if (principal.kind !== "human") {
    writeJson(response, 403, { error: "only a human principal may read process status" });
    return;
  }
  const projectId = request.query?.project?.trim();
  if (projectId === undefined || projectId.length === 0) {
    writeJson(response, 400, { error: "project query is required" });
    return;
  }
  const project = deps.getProjects().find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    writeJson(response, 404, { error: "project not found" });
    return;
  }
  const found = findApp(deps, project.id, safeDecode(match[1] ?? ""));
  if (found === undefined) {
    writeJson(response, 404, { error: "application not found" });
    return;
  }
  if (found.app.deleting || found.project.deleting) {
    writeJson(response, 409, {
      error: "application is pending deletion",
      code: "deletion_pending",
    });
    return;
  }
  const releaseSlot = processStreams.acquireBrowser(found.app.id);
  if (releaseSlot === undefined) {
    writeJson(response, 429, {
      error: "too many process event streams for this application",
      code: "stream_limit",
    });
    return;
  }
  let slotReleased = false;
  const releaseOnce = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlot();
  };
  response.once("close", releaseOnce);
  response.once("finish", releaseOnce);
  if (response.destroyed || response.writableEnded) {
    releaseOnce();
    return;
  }

  const streamID = randomUUID();
  let seq = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let slowWarned = false;
  let unsubscribe: (() => void) | undefined;
  let snapshotRead = false;
  let bufferOverflowed = false;
  let lastEventId = 0;
  const buffered: ProcessEvent[] = [];

  const emit = (frame: ProcessFrame): string => {
    seq += 1;
    return `data: ${JSON.stringify({ ...frame, seq, streamID })}\n\n`;
  };
  const write = (chunk: string): Promise<void> => {
    if (closed || response.destroyed || response.writableEnded) {
      return Promise.resolve();
    }
    const bytes = Buffer.byteLength(chunk, "utf8");
    pendingBytes += bytes;
    queue = queue.then(() => writeChunk(response, chunk));
    queue = queue.finally(() => {
      pendingBytes = Math.max(0, pendingBytes - bytes);
    });
    if (!slowWarned && pendingBytes > SLOW_CONSUMER_BYTES) {
      slowWarned = true;
      void writeEvent({
        type: "stream.warning",
        code: "process_slow_consumer",
        message: "the process stream consumer is not keeping up",
      });
    }
    return queue;
  };
  const writeEvent = (frame: ProcessFrame): Promise<void> => write(emit(frame));
  const deliver = (event: ProcessEvent): void => {
    if (closed || event.id <= lastEventId) return;
    lastEventId = event.id;
    void writeEvent({ type: "process.transition", event });
  };
  const cleanup = (): void => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    releaseOnce();
  };
  response.on("close", cleanup);

  unsubscribe = processEvents.subscribe(found.app.id, (event) => {
    if (closed) return;
    if (snapshotRead) {
      deliver(event);
      return;
    }
    if (bufferOverflowed) return;
    if (buffered.length >= MAX_BUFFERED_TRANSITIONS) {
      bufferOverflowed = true;
      buffered.length = 0;
      return;
    }
    buffered.push(event);
  });

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const unregisterDrain = registerSseDrain(deps, response);
  response.once("close", unregisterDrain);
  void write(`data: ${JSON.stringify({ type: "stream.ready", seq: 0, streamID })}\n\n`);
  heartbeat = setInterval(() => {
    void write(": ping\n\n");
  }, heartbeatInterval());

  let snapshot: ReturnType<typeof readProcessSnapshot> | undefined;
  try {
    snapshot = readProcessSnapshot(deps.db, found.app.id);
  } catch {
    snapshot = undefined;
  }
  snapshotRead = true;

  if (snapshot !== undefined) {
    lastEventId = snapshot.lastEventId;
    void writeEvent({
      type: "process.snapshot",
      current: {
        state: snapshot.state,
        phase: snapshot.phase,
        attemptId: snapshot.attemptId,
        startedAt: snapshot.startedAt,
        updatedAt: snapshot.updatedAt,
        error: snapshot.error,
      },
      lastEventId: snapshot.lastEventId,
    });
    if (bufferOverflowed) {
      void writeEvent({
        type: "stream.warning",
        code: "process_buffer_overflow",
        message: "the pre-snapshot process buffer overflowed",
      });
    }
  } else {
    lastEventId = 0;
    void writeEvent({
      type: "stream.warning",
      code: "process_snapshot_failed",
      message: "the process snapshot could not be read",
    });
    if (bufferOverflowed) {
      void writeEvent({
        type: "stream.warning",
        code: "process_buffer_overflow",
        message: "the pre-snapshot process buffer overflowed",
      });
    }
  }

  for (const event of buffered) {
    deliver(event);
  }
  buffered.length = 0;

  await queue;
}
