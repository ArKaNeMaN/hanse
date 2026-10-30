/**
 * Deterministic loopback stand-in for an opencode agent and the app runner exec endpoint.
 *
 * This module is test-only: it is never imported by `src/` and it never contacts Docker, a real
 * opencode process, or any non-loopback address. The coordinator under test talks to it through the
 * ordinary `manager.endpointFor` and `deps.runner` seams, so the real SSE projection and terminal
 * proxy code paths are exercised.
 *
 * Every identity below is a synthetic fixture literal. The bearer token is a fixed test value, not
 * a credential.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** Obvious fixture bearer value; never a deployment credential. */
export const E2E_RUNNER_TOKEN = "e2e-runner-fixture-token";
export const E2E_STREAM_ID = "stream-e2e-fixture";
export const E2E_SESSION_ID = "ses_e2ealpha";
export const E2E_SECOND_SESSION_ID = "ses_e2echild";

export interface FixtureSession {
  id: string;
  title?: string;
  parentID?: string;
  time?: { created?: number; updated?: number };
  [key: string]: unknown;
}

export interface FixturePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface FixtureMessage {
  info: {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    [key: string]: unknown;
  };
  parts: FixturePart[];
}

export interface FixtureCommand {
  name: string;
  description?: string;
  agent?: string;
  template?: string;
  hints?: string[];
  [key: string]: unknown;
}

export interface FixtureQuestion {
  id: string;
  sessionID: string;
  questions: Array<{
    header: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
  [key: string]: unknown;
}

export interface FixturePermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpencodeUpstreamOptions {
  appId?: string;
  runnerToken?: string;
  streamID?: string;
  heartbeatMs?: number;
  sessions?: readonly FixtureSession[];
  messages?: Readonly<Record<string, readonly FixtureMessage[]>>;
  statuses?: Readonly<Record<string, { type: string; [key: string]: unknown }>>;
  commands?: readonly FixtureCommand[];
  questions?: readonly FixtureQuestion[];
  permissions?: readonly FixturePermission[];
  savedPermissions?: readonly unknown[];
  todos?: Readonly<Record<string, readonly unknown[]>>;
  /**
   * Optional test hook for frames that the coordinator produces from manager callbacks rather than
   * the upstream feed (`context.updated`, `notice.created`). Return true when handled.
   */
  onControl?: (event: Record<string, unknown>) => boolean | undefined;
}

export interface RunnerState {
  connections: number;
  authorizations: Array<string | undefined>;
  resizes: Array<{ cols: number; rows: number }>;
  binaryFrames: string[];
  closed: boolean;
  lastCloseCode: number | null;
}

export interface OpencodeUpstream {
  readonly url: string;
  readonly port: number;
  readonly runnerUrl: string;
  readonly token: string;
  readonly streamID: string;
  readonly appId: string;
  readonly runner: RunnerState;
  readonly requests: string[];
  /** Wait until the coordinator opens the upstream `/event` connection. */
  waitForStream(timeoutMs?: number): Promise<void>;
  /** Broadcast raw opencode event envelopes to every attached `/event` client. */
  send(frames: readonly unknown[]): void;
  /** Broadcast one preformatted SSE chunk (used to exercise malformed input). */
  sendRaw(chunk: string): void;
  /** Close every attached `/event` response, ending the coordinator stream. */
  closeStreams(): void;
  /** Wait for a runner WebSocket connection. */
  waitForRunner(timeoutMs?: number): Promise<void>;
  /** Send a normal close (`1000`), going-away close (`1001`), or failure close (`1011`). */
  closeRunner(code?: 1000 | 1001 | 1011): void;
  stop(): Promise<void>;
}

interface ResolvedOptions {
  appId: string;
  runnerToken: string;
  streamID: string;
  heartbeatMs: number;
  sessions: FixtureSession[];
  messages: Map<string, FixtureMessage[]>;
  statuses: Record<string, { type: string; [key: string]: unknown }>;
  commands: FixtureCommand[];
  questions: FixtureQuestion[];
  permissions: FixturePermission[];
  savedPermissions: unknown[];
  todos: Map<string, unknown[]>;
  onControl: ((event: Record<string, unknown>) => boolean | undefined) | undefined;
}

/** Synthetic two-message conversation used when the caller does not supply fixture data. */
export const DEFAULT_SESSIONS: readonly FixtureSession[] = [
  {
    id: E2E_SESSION_ID,
    title: "E2E alpha session",
    time: { created: 1_760_000_000_000, updated: 1_760_000_005_000 },
  },
  {
    id: E2E_SECOND_SESSION_ID,
    title: "E2E child session",
    parentID: E2E_SESSION_ID,
    time: { created: 1_760_000_001_000, updated: 1_760_000_004_000 },
  },
];

export const DEFAULT_MESSAGES: readonly FixtureMessage[] = [
  {
    info: {
      id: "msg_e2e_user",
      sessionID: E2E_SESSION_ID,
      role: "user",
      time: { created: 1_760_000_001_000 },
    },
    parts: [
      {
        id: "prt_e2e_user_text",
        sessionID: E2E_SESSION_ID,
        messageID: "msg_e2e_user",
        type: "text",
        text: "Hello from the synthetic E2E fixture.",
      },
    ],
  },
  {
    info: {
      id: "msg_e2e_assistant",
      sessionID: E2E_SESSION_ID,
      role: "assistant",
      parentID: "msg_e2e_user",
      finish: "stop",
      time: { created: 1_760_000_002_000, completed: 1_760_000_003_000 },
    },
    parts: [
      {
        id: "prt_e2e_assistant_text",
        sessionID: E2E_SESSION_ID,
        messageID: "msg_e2e_assistant",
        type: "text",
        text: "Synthetic assistant reply.",
      },
    ],
  },
];

export const DEFAULT_COMMANDS: readonly FixtureCommand[] = [
  {
    name: "e2e-command",
    description: "Synthetic fixture command.",
    template: "Echo the fixture argument.",
  },
];

export const DEFAULT_QUESTIONS: readonly FixtureQuestion[] = [
  {
    id: "que_e2e_question",
    sessionID: E2E_SESSION_ID,
    questions: [
      {
        header: "Fixture question",
        question: "Continue with the synthetic fixture?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
  },
];

export const DEFAULT_PERMISSIONS: readonly FixturePermission[] = [
  {
    id: "per_e2e_permission",
    sessionID: E2E_SESSION_ID,
    permission: "bash",
    patterns: ["echo fixture"],
    always: ["echo fixture"],
  },
];

/**
 * Raw opencode frames that project to the core Hanse event vocabulary. The coordinator emits its own
 * `stream.ready` envelope; the upstream ready frame below is part of the deterministic SSE shape.
 */
export const DEFAULT_SCRIPTED_FRAMES: readonly Record<string, unknown>[] = [
  { type: "stream.ready", properties: {}, seq: 0 },
  {
    type: "message.part.delta",
    properties: {
      sessionID: E2E_SESSION_ID,
      messageID: "msg_e2e_assistant",
      partID: "prt_e2e_assistant_text",
      field: "text",
      delta: "Synthetic delta.",
    },
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: E2E_SESSION_ID,
      messageID: "msg_e2e_assistant",
      part: {
        id: "prt_e2e_tool",
        sessionID: E2E_SESSION_ID,
        messageID: "msg_e2e_assistant",
        type: "tool",
        tool: "bash",
        state: { status: "running", input: { command: "echo fixture" } },
      },
    },
  },
  {
    type: "session.status",
    properties: { sessionID: E2E_SESSION_ID, status: { type: "busy" } },
  },
  {
    type: "question.asked",
    properties: DEFAULT_QUESTIONS[0],
  },
  {
    type: "permission.asked",
    properties: DEFAULT_PERMISSIONS[0],
  },
  {
    type: "message.part.delta",
    properties: {
      sessionID: E2E_SESSION_ID,
      messageID: "msg_e2e_assistant",
      partID: "prt_e2e_oversized",
      field: "text",
      delta: "x".repeat(65 * 1024),
    },
  },
  {
    type: "stream.warning",
    properties: {
      code: "stream_budget",
      sessionID: E2E_SESSION_ID,
      message: "Synthetic stream budget warning.",
    },
  },
  {
    type: "message.part.omitted",
    properties: {
      sessionID: E2E_SESSION_ID,
      messageID: "msg_e2e_assistant",
      partID: "prt_e2e_omitted",
      partType: "text",
      reason: "too_large",
    },
  },
  {
    type: "notice.created",
    properties: {
      notice: {
        id: "notice_e2e",
        appId: "e2e-project-one:alpha",
        sessionId: E2E_SESSION_ID,
        kind: "agent_stopped",
        reason: "operator_restart",
        payload: {},
        createdAt: "2026-10-30T10:00:00.000Z",
      },
    },
  },
  {
    type: "context.updated",
    properties: {
      sessionID: E2E_SESSION_ID,
      context: {
        sessionID: E2E_SESSION_ID,
        state: "ready",
        used: 1000,
        limit: 2000,
        percent: 50,
        model: { providerID: "fixture", modelID: "fixture-model" },
        status: "busy",
        updatedAt: "2026-10-30T10:00:00.000Z",
        lastCompactedAt: null,
        lastError: null,
        autoCompact: {
          enabled: false,
          percent: 80,
          source: "default",
          percentSource: "default",
        },
      },
    },
  },
  {
    type: "message.part.updated",
    properties: {
      sessionID: E2E_SESSION_ID,
      messageID: "msg_e2e_assistant",
      part: {
        id: "prt_e2e_omitted",
        sessionID: E2E_SESSION_ID,
        messageID: "msg_e2e_assistant",
        type: "text",
        text: "y".repeat(65 * 1024),
      },
    },
  },
];

function resolveOptions(options: OpencodeUpstreamOptions): ResolvedOptions {
  const messages = new Map<string, FixtureMessage[]>();
  const supplied = options.messages;
  if (supplied === undefined) {
    messages.set(
      E2E_SESSION_ID,
      DEFAULT_MESSAGES.map((message) => structuredClone(message)),
    );
  } else {
    for (const [sessionId, list] of Object.entries(supplied)) {
      messages.set(
        sessionId,
        list.map((message) => structuredClone(message)),
      );
    }
  }
  return {
    appId: options.appId ?? "e2e-project-one:alpha",
    runnerToken: options.runnerToken ?? E2E_RUNNER_TOKEN,
    streamID: options.streamID ?? E2E_STREAM_ID,
    heartbeatMs: options.heartbeatMs ?? 25,
    sessions:
      options.sessions === undefined
        ? DEFAULT_SESSIONS.map((session) => structuredClone(session))
        : options.sessions.map((session) => structuredClone(session)),
    messages,
    statuses:
      options.statuses === undefined
        ? { [E2E_SESSION_ID]: { type: "busy" } }
        : structuredClone(options.statuses),
    commands:
      options.commands === undefined
        ? DEFAULT_COMMANDS.map((command) => structuredClone(command))
        : options.commands.map((command) => structuredClone(command)),
    questions:
      options.questions === undefined
        ? DEFAULT_QUESTIONS.map((question) => structuredClone(question))
        : options.questions.map((question) => structuredClone(question)),
    permissions:
      options.permissions === undefined
        ? DEFAULT_PERMISSIONS.map((permission) => structuredClone(permission))
        : options.permissions.map((permission) => structuredClone(permission)),
    savedPermissions:
      options.savedPermissions === undefined
        ? []
        : options.savedPermissions.map((permission) => structuredClone(permission)),
    todos:
      options.todos === undefined
        ? new Map()
        : new Map(
            Object.entries(options.todos).map(([sessionId, todos]) => [
              sessionId,
              todos.map((todo) => structuredClone(todo)),
            ]),
          ),
    onControl: options.onControl,
  };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function writeEmpty(response: ServerResponse, status = 204): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status);
  response.end();
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

function safeJson(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseClientFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; rest: Buffer } | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function serverFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function upgradeKey(key: string): string {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const payload = JSON.stringify({ error: message });
  socket.write(
    [
      `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}`,
      "content-type: application/json; charset=utf-8",
      `content-length: ${Buffer.byteLength(payload)}`,
      "connection: close",
      "",
      payload,
    ].join("\r\n"),
  );
  socket.end();
}

function closePayload(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

export async function startOpencodeUpstream(
  options: OpencodeUpstreamOptions = {},
): Promise<OpencodeUpstream> {
  const resolved = resolveOptions(options);
  const requests: string[] = [];
  const streamClients = new Set<ServerResponse>();
  const runnerSockets = new Set<Duplex>();
  const runner: RunnerState = {
    connections: 0,
    authorizations: [],
    resizes: [],
    binaryFrames: [],
    closed: false,
    lastCloseCode: null,
  };
  let heartbeat: NodeJS.Timeout | undefined;

  function broadcast(frame: unknown): void {
    const chunk = `data: ${JSON.stringify(frame)}\n\n`;
    for (const client of streamClients) {
      if (!client.destroyed && !client.writableEnded) client.write(chunk);
    }
  }

  function broadcastRaw(chunk: string): void {
    for (const client of streamClients) {
      if (!client.destroyed && !client.writableEnded) client.write(chunk);
    }
  }

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "GET"} ${url.pathname}${url.search}`);
    const method = request.method ?? "GET";
    const body = method === "POST" || method === "PATCH" ? await readBody(request) : "";
    const pathname = url.pathname;

    if (pathname === "/event" && method === "GET") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.flushHeaders();
      response.write(
        `data: ${JSON.stringify({
          type: "stream.ready",
          seq: 0,
          streamID: resolved.streamID,
          properties: {},
        })}\n\n`,
      );
      streamClients.add(response);
      request.on("close", () => streamClients.delete(response));
      response.on("close", () => streamClients.delete(response));
      if (heartbeat === undefined) {
        heartbeat = setInterval(() => broadcastRaw(": ping\n\n"), resolved.heartbeatMs);
      }
      return;
    }

    if (pathname === "/__control" && method === "POST") {
      const parsed = safeJson(body);
      if (parsed?.streamClose === true) {
        for (const client of streamClients) {
          if (!client.destroyed && !client.writableEnded) client.end();
        }
        streamClients.clear();
        writeJson(response, 200, { accepted: 1, streamClose: true });
        return;
      }
      if (typeof parsed?.runnerClose === "number") {
        runner.lastCloseCode = parsed.runnerClose;
        for (const socket of runnerSockets) {
          if (!socket.writable) continue;
          socket.write(serverFrame(0x8, closePayload(parsed.runnerClose)));
          socket.end();
        }
        writeJson(response, 200, { accepted: 1, runnerClose: parsed.runnerClose });
        return;
      }
      const frames = Array.isArray(parsed?.frames)
        ? parsed.frames
        : parsed?.event === undefined
          ? []
          : [parsed.event];
      for (const frame of frames) {
        const event =
          typeof frame === "object" && frame !== null && !Array.isArray(frame)
            ? (frame as Record<string, unknown>)
            : {};
        if (resolved.onControl?.(event) === true) continue;
        broadcast(frame);
      }
      writeJson(response, 200, { accepted: frames.length });
      return;
    }

    if (pathname === "/__state" && method === "GET") {
      writeJson(response, 200, {
        streamID: resolved.streamID,
        sessions: resolved.sessions,
        messages: Object.fromEntries(resolved.messages),
        statuses: resolved.statuses,
        runner,
        requests,
      });
      return;
    }

    const sessionMessage = /^\/session\/([^/]+)\/message$/.exec(pathname);
    const sessionMessageOne = /^\/session\/([^/]+)\/message\/([^/]+)$/.exec(pathname);
    const sessionTodo = /^\/session\/([^/]+)\/todo$/.exec(pathname);
    const sessionAction = /^\/session\/([^/]+)\/(abort|summarize|command)$/.exec(pathname);
    const sessionOne = /^\/session\/([^/]+)$/.exec(pathname);
    const questionAction = /^\/question\/([^/]+)\/(reply|reject)$/.exec(pathname);
    const permissionAction = /^\/permission\/([^/]+)\/reply$/.exec(pathname);
    const savedPermission = /^\/api\/permission\/saved(?:\/([^/]+))?$/.exec(pathname);
    const v2Question = /^\/api\/session\/([^/]+)\/question\/([^/]+)\/(reply|reject)$/.exec(
      pathname,
    );
    const v2Permission = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(pathname);

    if (pathname === "/session" && method === "GET") {
      writeJson(response, 200, resolved.sessions);
      return;
    }
    if (pathname === "/session" && method === "POST") {
      const parsed = safeJson(body) ?? {};
      const id = `ses_e2ecreated${resolved.sessions.length + 1}`;
      const session: FixtureSession = {
        id,
        ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
        time: { created: Date.now(), updated: Date.now() },
      };
      resolved.sessions.push(session);
      resolved.messages.set(id, []);
      writeJson(response, 200, session);
      return;
    }
    if (pathname === "/session/status" && method === "GET") {
      writeJson(response, 200, resolved.statuses);
      return;
    }
    if (sessionOne !== null) {
      const sessionId = decodeURIComponent(sessionOne[1] ?? "");
      const index = resolved.sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) {
        writeJson(response, 404, { error: "session not found" });
        return;
      }
      if (method === "GET") {
        writeJson(response, 200, resolved.sessions[index]);
        return;
      }
      if (method === "PATCH") {
        const parsed = safeJson(body) ?? {};
        const current = resolved.sessions[index] ?? { id: sessionId };
        resolved.sessions[index] = {
          ...current,
          ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
        };
        writeJson(response, 200, resolved.sessions[index]);
        return;
      }
      if (method === "DELETE") {
        resolved.sessions.splice(index, 1);
        resolved.messages.delete(sessionId);
        writeEmpty(response);
        return;
      }
    }
    if (sessionMessage !== null && method === "GET") {
      const sessionId = decodeURIComponent(sessionMessage[1] ?? "");
      const list = resolved.messages.get(sessionId) ?? [];
      const limit = Number(url.searchParams.get("limit"));
      const before = url.searchParams.get("before");
      let page = list;
      if (before !== null) {
        const index = list.findIndex((message) => message.info.id === before);
        if (index >= 0) page = list.slice(0, index);
      }
      if (Number.isFinite(limit) && limit > 0 && page.length > limit) {
        page = page.slice(-limit);
        response.setHeader("x-next-cursor", page[0]?.info.id ?? "");
      }
      writeJson(response, 200, page);
      return;
    }
    if (sessionMessage !== null && method === "POST") {
      const sessionId = decodeURIComponent(sessionMessage[1] ?? "");
      const list = resolved.messages.get(sessionId) ?? [];
      const assistant = [...list].reverse().find((message) => message.info.role === "assistant");
      if (assistant !== undefined) {
        writeJson(response, 200, assistant);
        return;
      }
      writeJson(response, 200, {
        info: {
          id: "msg_e2e_blocking",
          sessionID: sessionId,
          role: "assistant",
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [
          {
            id: "prt_e2e_blocking",
            sessionID: sessionId,
            messageID: "msg_e2e_blocking",
            type: "text",
            text: "Synthetic blocking reply.",
          },
        ],
      });
      return;
    }
    if (sessionMessageOne !== null && method === "GET") {
      const sessionId = decodeURIComponent(sessionMessageOne[1] ?? "");
      const messageId = decodeURIComponent(sessionMessageOne[2] ?? "");
      const message = (resolved.messages.get(sessionId) ?? []).find(
        (candidate) => candidate.info.id === messageId,
      );
      if (message === undefined) {
        writeJson(response, 404, { error: "message not found" });
        return;
      }
      writeJson(response, 200, message);
      return;
    }
    if (sessionTodo !== null && method === "GET") {
      const sessionId = decodeURIComponent(sessionTodo[1] ?? "");
      writeJson(response, 200, resolved.todos.get(sessionId) ?? []);
      return;
    }
    if (sessionAction !== null && method === "POST") {
      const action = sessionAction[2];
      if (action === "command") {
        writeEmpty(response);
        return;
      }
      writeJson(response, 200, true);
      return;
    }
    if (
      pathname.startsWith("/session/") &&
      pathname.endsWith("/prompt_async") &&
      method === "POST"
    ) {
      writeEmpty(response);
      return;
    }
    if (pathname === "/command" && method === "GET") {
      writeJson(response, 200, resolved.commands);
      return;
    }
    if (pathname === "/question" && method === "GET") {
      writeJson(response, 200, resolved.questions);
      return;
    }
    if (pathname === "/permission" && method === "GET") {
      writeJson(response, 200, resolved.permissions);
      return;
    }
    if (questionAction !== null && method === "POST") {
      writeJson(response, 200, true);
      return;
    }
    if (permissionAction !== null && method === "POST") {
      writeJson(response, 200, true);
      return;
    }
    if (pathname === "/api/question/request" && method === "GET") {
      writeJson(response, 200, { data: resolved.questions });
      return;
    }
    if (pathname === "/api/permission/request" && method === "GET") {
      writeJson(response, 200, { data: resolved.permissions });
      return;
    }
    if (v2Question !== null && method === "POST") {
      writeEmpty(response);
      return;
    }
    if (v2Permission !== null && method === "POST") {
      writeEmpty(response);
      return;
    }
    if (savedPermission !== null) {
      if (method === "GET" && savedPermission[1] === undefined) {
        writeJson(response, 200, { data: resolved.savedPermissions });
        return;
      }
      if (method === "DELETE" && savedPermission[1] !== undefined) {
        writeEmpty(response);
        return;
      }
    }
    if (pathname === "/config/providers" && method === "GET") {
      writeJson(response, 200, { providers: [], default: {} });
      return;
    }
    if (pathname === "/agent" && method === "GET") {
      writeJson(response, 200, []);
      return;
    }

    writeJson(response, 404, { error: `fixture upstream has no route for ${method} ${pathname}` });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = /^\/v1\/apps\/([^/]+)\/exec$/.exec(url.pathname);
    if (match === null) {
      rejectUpgrade(socket, 404, "not found");
      return;
    }
    const authorization = request.headers.authorization;
    runner.authorizations.push(authorization);
    if (authorization !== `Bearer ${resolved.runnerToken}`) {
      rejectUpgrade(socket, 401, "unauthorized");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    const version = request.headers["sec-websocket-version"];
    if (typeof key !== "string" || typeof version !== "string") {
      rejectUpgrade(socket, 404, "invalid websocket handshake");
      return;
    }
    runner.connections += 1;
    runnerSockets.add(socket);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${upgradeKey(key)}`,
        "",
        "",
      ].join("\r\n"),
    );

    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const process = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = parseClientFrame(buffer);
        if (frame === undefined) return;
        buffer = frame.rest;
        if (frame.opcode === 0x8) {
          runner.closed = true;
          runner.lastCloseCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          if (socket.writable) socket.write(serverFrame(0x8, frame.payload));
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          if (socket.writable) socket.write(serverFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0x1) {
          const parsed = safeJson(frame.payload.toString("utf8"));
          if (parsed?.type === "resize") {
            const cols = Number(parsed.cols);
            const rows = Number(parsed.rows);
            runner.resizes.push({ cols, rows });
            continue;
          }
          continue;
        }
        if (frame.opcode === 0x2) {
          runner.binaryFrames.push(frame.payload.toString("base64"));
          if (socket.writable) socket.write(serverFrame(0x2, frame.payload));
        }
      }
    };
    socket.on("data", process);
    socket.on("close", () => {
      runner.closed = true;
      runnerSockets.delete(socket);
    });
    socket.on("error", () => undefined);
    if (head.length > 0) process(head);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("opencode upstream did not bind a loopback port");
  }
  const port = (address as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    runnerUrl: url,
    token: resolved.runnerToken,
    streamID: resolved.streamID,
    appId: resolved.appId,
    runner,
    requests,
    async waitForStream(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (streamClients.size === 0) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the upstream SSE client");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    send(frames) {
      for (const frame of frames) broadcast(frame);
    },
    sendRaw(chunk) {
      broadcastRaw(chunk);
    },
    closeStreams() {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      for (const client of streamClients) client.end();
      streamClients.clear();
    },
    async waitForRunner(timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (runner.connections === 0) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the runner WebSocket");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    closeRunner(code = 1000) {
      runner.lastCloseCode = code;
      for (const socket of runnerSockets) {
        if (!socket.writable) continue;
        socket.write(serverFrame(0x8, closePayload(code)));
        socket.end();
      }
    },
    async stop() {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      for (const client of streamClients) client.destroy();
      streamClients.clear();
      for (const socket of runnerSockets) socket.destroy();
      runnerSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
