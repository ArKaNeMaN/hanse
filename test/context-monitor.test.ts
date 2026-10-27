import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextMonitor,
  type ContextMonitorClientHooks,
  type ContextPolicy,
  type ContextSnapshot,
  NotTopLevelError,
  parseModelString,
  SessionBusyError,
  SessionNotFoundError,
} from "../src/opencode/context.js";
import {
  clearEndpointAuthorization,
  setEndpointAuthorization,
} from "../src/opencode/endpoint-auth.js";

const MODEL = { providerID: "deepseek", modelID: "deepseek-flash" };
const PROVIDER_LIMIT = 1000;

interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: string;
}

interface FakeUpstream {
  endpoint: string;
  requests: RecordedRequest[];
  readonly eventConnections: number;
  readonly summarizeBodies: Array<Record<string, unknown>>;
  setMessages(messages: unknown[]): void;
  setSessions(sessions: unknown[]): void;
  setProviders(providers: unknown): void;
  setMessageStatus(status: number): void;
  setSummarize(handler: (body: Record<string, unknown>, response: ServerResponse) => void): void;
  emit(event: unknown): void;
  endStream(): void;
  close(): Promise<void>;
}

function providersWithLimit(limit: number | null): unknown {
  return {
    providers: [
      {
        id: "deepseek",
        models: {
          "deepseek-flash": limit === null ? {} : { limit: { context: limit } },
        },
      },
    ],
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function fakeUpstream(): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const summarizeBodies: Array<Record<string, unknown>> = [];
  const clients = new Set<ServerResponse>();
  let eventConnections = 0;
  let messages: unknown[] = [];
  let sessions: unknown[] = [{ id: "s" }];
  let providers: unknown = providersWithLimit(PROVIDER_LIMIT);
  let messageStatus = 200;
  let summarizeHandler:
    | ((body: Record<string, unknown>, response: ServerResponse) => void)
    | undefined;

  const sendJson = (response: ServerResponse, body: unknown): void => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
    };
    if (request.method === "POST") recorded.body = await readBody(request);
    requests.push(recorded);

    if (url.pathname === "/event") {
      eventConnections += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.flushHeaders();
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (url.pathname === "/config/providers") {
      sendJson(response, providers);
      return;
    }
    if (url.pathname === "/session") {
      sendJson(response, sessions);
      return;
    }
    if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message")) {
      if (messageStatus !== 200) {
        response.writeHead(messageStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      sendJson(response, messages);
      return;
    }
    if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/summarize")) {
      const body = JSON.parse(recorded.body ?? "{}") as Record<string, unknown>;
      summarizeBodies.push(body);
      if (summarizeHandler !== undefined) {
        summarizeHandler(body, response);
        return;
      }
      sendJson(response, true);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unmatched" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    summarizeBodies,
    get eventConnections() {
      return eventConnections;
    },
    setMessages(next) {
      messages = next;
    },
    setSessions(next) {
      sessions = next;
    },
    setProviders(next) {
      providers = next;
    },
    setMessageStatus(next) {
      messageStatus = next;
    },
    setSummarize(next) {
      summarizeHandler = next;
    },
    emit(event) {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) client.write(frame);
    },
    endStream() {
      for (const client of clients) client.end();
      clients.clear();
    },
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function policy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    enabled: true,
    percent: 80,
    model: "deepseek/deepseek-flash",
    enabledSource: "global",
    percentSource: "global",
    ...overrides,
  };
}

function messageUpdated(
  sessionID: string,
  messageID: string,
  tokens: Record<string, unknown> = {},
  finished = true,
): unknown {
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  return {
    type: "message.updated",
    properties: {
      info: {
        id: messageID,
        role: "assistant",
        sessionID,
        providerID: MODEL.providerID,
        modelID: MODEL.modelID,
        tokens: {
          input: tokens.input ?? 0,
          output: tokens.output ?? 0,
          reasoning: tokens.reasoning ?? 0,
          cache: { read: cache.read ?? 0, write: cache.write ?? 0 },
        },
        time: finished ? { created: 1, completed: 2 } : { created: 1 },
      },
    },
  };
}

function stepFinish(
  sessionID: string,
  messageID: string,
  tokens: Record<string, unknown>,
): unknown {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `${messageID}-step`,
        sessionID,
        messageID,
        type: "step-finish",
        tokens,
      },
    },
  };
}

function statusEvent(sessionID: string, type: "idle" | "busy" | "retry"): unknown {
  return { type: "session.status", properties: { sessionID, status: { type } } };
}

function toolPart(
  sessionID: string,
  partID: string,
  tool: string,
  status: string,
  messageID = "m1",
): unknown {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: partID,
        sessionID,
        messageID,
        type: "tool",
        tool,
        state: { status },
      },
    },
  };
}

function compactedEvent(sessionID: string): unknown {
  return { type: "session.compacted", properties: { sessionID } };
}

function assistantMessage(id: string, tokens: Record<string, unknown>, time: number): unknown {
  return {
    info: {
      id,
      role: "assistant",
      providerID: MODEL.providerID,
      modelID: MODEL.modelID,
      tokens,
      time: { completed: time },
    },
    parts: [],
  };
}

const monitors: ContextMonitor[] = [];
const upstreams: FakeUpstream[] = [];

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  for (const upstream of upstreams.splice(0)) {
    clearEndpointAuthorization(upstream.endpoint);
    await upstream.close();
  }
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function monitorFor(
  upstream: FakeUpstream,
  options: {
    policy?: ContextPolicy;
    client?: ContextMonitorClientHooks;
    compactTimeoutMs?: number;
    isCurrent?: () => boolean;
    onContextUpdate?: (snapshot: ContextSnapshot) => void;
  } = {},
): ContextMonitor {
  upstreams.push(upstream);
  const monitor = new ContextMonitor({
    endpoint: upstream.endpoint,
    appId: "p:app",
    projectId: "p",
    appKey: "app",
    isCurrent: options.isCurrent ?? (() => true),
    settings: { contextPolicy: () => options.policy ?? policy() },
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    compactTimeoutMs: options.compactTimeoutMs ?? 500,
    ...(options.client === undefined ? {} : { client: options.client }),
    ...(options.onContextUpdate === undefined ? {} : { onContextUpdate: options.onContextUpdate }),
  });
  monitors.push(monitor);
  return monitor;
}

async function startMonitor(
  upstream: FakeUpstream,
  options: Parameters<typeof monitorFor>[1] = {},
): Promise<ContextMonitor> {
  const monitor = monitorFor(upstream, options);
  monitor.start();
  await waitFor(() => upstream.eventConnections === 1);
  return monitor;
}

describe("parseModelString", () => {
  it("splits at the first slash and rejects empty parts", () => {
    expect(parseModelString("deepseek/deepseek-flash")).toEqual(MODEL);
    expect(parseModelString("a/b/c")).toEqual({ providerID: "a", modelID: "b/c" });
    expect(parseModelString("/model")).toBeNull();
    expect(parseModelString("provider/")).toBeNull();
    expect(parseModelString("model")).toBeNull();
  });
});

describe("ContextMonitor snapshots", () => {
  it("reports usage, provider limit, percent, and model from live events", async () => {
    const upstream = await fakeUpstream();
    const monitor = await startMonitor(upstream);

    upstream.emit(messageUpdated("s", "m1", { input: 700, cache: { read: 100, write: 50 } }));
    await waitFor(async () => (await monitor.snapshot("s")).used === 850);

    const snapshot = await monitor.snapshot("s");
    expect(snapshot.used).toBe(850);
    expect(snapshot.limit).toBe(PROVIDER_LIMIT);
    expect(snapshot.percent).toBe(85);
    expect(snapshot.model).toEqual(MODEL);
    expect(snapshot.state).toBe("ready");
  });

  it("keeps step-finish tokens authoritative over the later message finish", async () => {
    const upstream = await fakeUpstream();
    const monitor = await startMonitor(upstream);

    upstream.emit(messageUpdated("s", "m1", { input: 100 }));
    upstream.emit(stepFinish("s", "m1", { input: 500, cache: { read: 20 } }));
    upstream.emit(messageUpdated("s", "m1", { input: 999 }));
    await waitFor(async () => (await monitor.snapshot("s")).used === 520);

    const snapshot = await monitor.snapshot("s");
    expect(snapshot.used).toBe(520);
    expect(snapshot.percent).toBe(52);
  });

  it("does not push a zero snapshot when the next step starts", async () => {
    const upstream = await fakeUpstream();
    const updates: ContextSnapshot[] = [];
    await startMonitor(upstream, {
      onContextUpdate: (snapshot) => updates.push(snapshot),
    });

    upstream.emit(messageUpdated("s", "m1", { input: 100 }));
    upstream.emit(stepFinish("s", "m1", { input: 500, cache: { read: 20 } }));
    await waitFor(() => updates.some((snapshot) => snapshot.used === 520));

    upstream.emit(messageUpdated("s", "m2", { input: 0 }, false));
    upstream.emit(stepFinish("s", "m2", { input: 600 }));
    await waitFor(() => updates.some((snapshot) => snapshot.used === 600));

    expect(updates.some((snapshot) => snapshot.used === 0)).toBe(false);
    expect(updates.at(-1)).toMatchObject({ used: 600, percent: 60 });
  });

  it("emits a live snapshot after each step-finish", async () => {
    const upstream = await fakeUpstream();
    const updates: ContextSnapshot[] = [];
    await startMonitor(upstream, {
      onContextUpdate: (snapshot) => updates.push(snapshot),
    });

    upstream.emit(messageUpdated("s", "m1", { input: 100 }));
    upstream.emit(stepFinish("s", "m1", { input: 500, cache: { read: 20 } }));
    await waitFor(() => updates.some((snapshot) => snapshot.used === 520));

    expect(updates.at(-1)).toMatchObject({
      sessionID: "s",
      state: "ready",
      used: 520,
      limit: PROVIDER_LIMIT,
      percent: 52,
      model: MODEL,
    });
  });

  it("emits a snapshot when a pending step-finish gains its model", async () => {
    const upstream = await fakeUpstream();
    const updates: ContextSnapshot[] = [];
    await startMonitor(upstream, {
      onContextUpdate: (snapshot) => updates.push(snapshot),
    });

    upstream.emit(stepFinish("s", "m1", { input: 500, cache: { read: 20 } }));
    await waitFor(() => updates.length > 0);
    upstream.emit(messageUpdated("s", "m1", { input: 0 }));
    await waitFor(() => updates.some((snapshot) => snapshot.used === 520));

    expect(updates.at(-1)).toMatchObject({ used: 520, limit: PROVIDER_LIMIT, percent: 52 });
  });

  it("hydrates usage and top-level parents from message and session history", async () => {
    const upstream = await fakeUpstream();
    upstream.setMessages([assistantMessage("m1", { input: 400 }, 10)]);
    upstream.setSessions([{ id: "s" }]);
    const monitor = monitorFor(upstream, { policy: policy({ enabled: false }) });

    const snapshot = await monitor.snapshot("s");

    expect(snapshot.used).toBe(400);
    expect(snapshot.limit).toBe(PROVIDER_LIMIT);
    expect(snapshot.percent).toBe(40);
    expect(snapshot.model).toEqual(MODEL);
    expect(upstream.requests.some((request) => request.path.includes("/message?limit=30"))).toBe(
      true,
    );
  });

  it("maps a missing upstream session to SessionNotFoundError", async () => {
    const upstream = await fakeUpstream();
    upstream.setMessageStatus(404);
    const monitor = monitorFor(upstream);

    await expect(monitor.snapshot("missing")).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(monitor.snapshot("missing")).rejects.toMatchObject({
      code: "session_not_found",
    });
  });
});

describe("ContextMonitor auto-compaction", () => {
  it("triggers once for an idle top-level session above the threshold", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "s" }]);
    const monitor = await startMonitor(upstream);

    upstream.emit(statusEvent("s", "idle"));
    upstream.emit(messageUpdated("s", "m1", { input: 900 }));
    await waitFor(() => upstream.summarizeBodies.length === 1);

    expect(upstream.summarizeBodies[0]).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-flash",
      auto: false,
    });

    upstream.emit(messageUpdated("s", "m2", { input: 900 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(upstream.summarizeBodies).toHaveLength(1);
    expect((await monitor.snapshot("s")).state).toBe("ready");
  });

  it("defers a busy crossing until the session becomes idle", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "s" }]);
    await startMonitor(upstream);

    upstream.emit(statusEvent("s", "busy"));
    upstream.emit(messageUpdated("s", "m1", { input: 950 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(upstream.summarizeBodies).toHaveLength(0);

    upstream.emit(statusEvent("s", "idle"));
    await waitFor(() => upstream.summarizeBodies.length === 1);
  });

  it("excludes child sessions", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "parent" }, { id: "child", parentID: "parent" }]);
    await startMonitor(upstream);

    upstream.emit(statusEvent("child", "idle"));
    upstream.emit(messageUpdated("child", "m1", { input: 950 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(upstream.summarizeBodies).toHaveLength(0);
  });

  it("defers while a child is busy and fires once when the last child goes idle", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "parent" }, { id: "child", parentID: "parent" }]);
    await startMonitor(upstream);

    upstream.emit(statusEvent("parent", "idle"));
    upstream.emit(messageUpdated("parent", "m1", { input: 950 }));
    upstream.emit(statusEvent("child", "busy"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(upstream.summarizeBodies).toHaveLength(0);

    upstream.emit(statusEvent("child", "idle"));
    await waitFor(() => upstream.summarizeBodies.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(upstream.summarizeBodies).toHaveLength(1);
    expect(
      upstream.requests.filter((request) => request.path.endsWith("/session/parent/summarize")),
    ).toHaveLength(1);
  });

  it("defers while a task part is running and fires after it completes and the session is idle", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "s" }]);
    await startMonitor(upstream);

    upstream.emit(statusEvent("s", "idle"));
    upstream.emit(toolPart("s", "p-task", "task", "running"));
    upstream.emit(messageUpdated("s", "m1", { input: 950 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(upstream.summarizeBodies).toHaveLength(0);

    upstream.emit(toolPart("s", "p-task", "task", "completed"));
    upstream.emit(statusEvent("s", "idle"));
    await waitFor(() => upstream.summarizeBodies.length === 1);
  });

  it("does not trigger when auto-compaction is disabled", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "s" }]);
    const monitor = await startMonitor(upstream, { policy: policy({ enabled: false }) });

    upstream.emit(statusEvent("s", "idle"));
    upstream.emit(messageUpdated("s", "m1", { input: 950 }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(upstream.summarizeBodies).toHaveLength(0);
    expect((await monitor.snapshot("s")).percent).toBe(95);
  });

  it("does not trigger when the model limit is missing", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "s" }]);
    upstream.setProviders(providersWithLimit(null));
    const monitor = await startMonitor(upstream);

    upstream.emit(statusEvent("s", "idle"));
    upstream.emit(messageUpdated("s", "m1", { input: 950 }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(upstream.summarizeBodies).toHaveLength(0);
    const snapshot = await monitor.snapshot("s");
    expect(snapshot.limit).toBeNull();
    expect(snapshot.percent).toBeNull();
  });
});

describe("ContextMonitor manual compaction", () => {
  it("hydrates first and uses the session's last-used model", async () => {
    const upstream = await fakeUpstream();
    upstream.setMessages([assistantMessage("m1", { input: 100 }, 10)]);
    upstream.setSummarize((_body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("true");
    });
    const result = await monitorFor(upstream, {
      policy: policy({ model: "deepseek/effective" }),
    }).compact("s");

    expect(result).toEqual({ accepted: true });
    await waitFor(() => upstream.summarizeBodies.length === 1);
    expect(upstream.summarizeBodies[0]).toMatchObject({
      providerID: "deepseek",
      modelID: "deepseek-flash",
      auto: false,
    });
  });

  it("falls back to the effective policy model for an empty session", async () => {
    const upstream = await fakeUpstream();
    upstream.setMessages([]);
    const monitor = monitorFor(upstream, { policy: policy({ model: "deepseek/effective" }) });

    await expect(monitor.compact("s")).resolves.toEqual({ accepted: true });
    await waitFor(() => upstream.summarizeBodies.length === 1);
    expect(upstream.summarizeBodies[0]).toMatchObject({
      providerID: "deepseek",
      modelID: "effective",
    });
  });

  it("returns accepted without waiting for a slow summarize", async () => {
    const upstream = await fakeUpstream();
    let release: (() => void) | undefined;
    upstream.setSummarize((_body, response) => {
      release = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("true");
      };
    });
    const monitor = monitorFor(upstream, { policy: policy({ model: "deepseek/effective" }) });

    await expect(monitor.compact("s")).resolves.toEqual({ accepted: true });
    await waitFor(() => upstream.summarizeBodies.length === 1);
    expect(release).toBeDefined();
    release?.();
  });

  it("records a fixed failure code, cools down, and never exposes the upstream body", async () => {
    const upstream = await fakeUpstream();
    upstream.setMessages([assistantMessage("m1", { input: 400 }, 10)]);
    upstream.setSummarize((_body, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("SECRET_PROVIDER_BODY sentinel");
    });
    const monitor = monitorFor(upstream);

    await expect(monitor.compact("s")).resolves.toEqual({ accepted: true });
    await waitFor(async () => (await monitor.snapshot("s")).lastError !== null);

    const snapshot = await monitor.snapshot("s");
    expect(snapshot.lastError).toBe("compaction_failed");
    expect(JSON.stringify(snapshot)).not.toContain("SECRET_PROVIDER_BODY");

    upstream.emit(statusEvent("s", "idle"));
    upstream.emit(messageUpdated("s", "m2", { input: 950 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(upstream.summarizeBodies).toHaveLength(1);
  });

  it("rejects a child session with NotTopLevelError without summarizing", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "parent" }, { id: "child", parentID: "parent" }]);
    upstream.setMessages([]);
    const monitor = monitorFor(upstream, { policy: policy() });

    await expect(monitor.compact("child")).rejects.toBeInstanceOf(NotTopLevelError);
    await expect(monitor.compact("child")).rejects.toMatchObject({ code: "not_top_level" });
    expect(upstream.summarizeBodies).toHaveLength(0);
    expect((await monitor.snapshot("child")).state).not.toBe("compacting");
  });

  it("rejects a top-level session while a child is busy", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "parent" }, { id: "child", parentID: "parent" }]);
    upstream.setMessages([]);
    const monitor = await startMonitor(upstream);

    upstream.emit(statusEvent("child", "busy"));
    await new Promise((resolve) => setTimeout(resolve, 40));

    await expect(monitor.compact("parent")).rejects.toBeInstanceOf(SessionBusyError);
    expect(upstream.summarizeBodies).toHaveLength(0);
    expect((await monitor.snapshot("parent")).state).not.toBe("compacting");
  });

  it("rejects when a child becomes busy during hydration and clears the claim", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "parent" }, { id: "child", parentID: "parent" }]);
    let release: (() => void) | undefined;
    const monitor = await startMonitor(upstream, {
      client: {
        listMessagePage: () =>
          new Promise((resolve) => {
            release = () => resolve({ messages: [] });
          }),
      },
    });

    const pending = monitor.compact("parent");
    await waitFor(() => release !== undefined);
    upstream.emit(statusEvent("child", "busy"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    release?.();

    await expect(pending).rejects.toBeInstanceOf(SessionBusyError);
    expect(upstream.summarizeBodies).toHaveLength(0);
    const snapshot = await monitor.snapshot("parent");
    expect(snapshot.state).not.toBe("compacting");
    expect(snapshot.lastError).toBeNull();
  });

  it("maps a hung summarize to compaction_timeout", async () => {
    const upstream = await fakeUpstream();
    upstream.setMessages([assistantMessage("m1", { input: 400 }, 10)]);
    upstream.setSummarize(() => undefined);
    const monitor = monitorFor(upstream, { compactTimeoutMs: 30 });

    await expect(monitor.compact("s")).resolves.toEqual({ accepted: true });
    await waitFor(async () => (await monitor.snapshot("s")).lastError !== null);

    expect((await monitor.snapshot("s")).lastError).toBe("compaction_timeout");
  });
});

describe("ContextMonitor lifecycle", () => {
  it("sends the endpoint authorization to the event stream", async () => {
    const upstream = await fakeUpstream();
    setEndpointAuthorization(upstream.endpoint, "opencode", "secret");
    await startMonitor(upstream);

    await waitFor(() => upstream.eventConnections === 1);
    const eventRequest = upstream.requests.find((request) => request.path === "/event");
    expect(eventRequest?.authorization).toMatch(/^Basic /);
  });

  it("stops the event stream and never reconnects after stop", async () => {
    const upstream = await fakeUpstream();
    const monitor = await startMonitor(upstream);
    await waitFor(() => upstream.eventConnections === 1);

    monitor.stop();
    upstream.endStream();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(upstream.eventConnections).toBe(1);
  });

  it("aborts an in-flight summarize on stop", async () => {
    const upstream = await fakeUpstream();
    let signal: AbortSignal | undefined;
    const monitor = monitorFor(upstream, {
      compactTimeoutMs: 10_000,
      policy: policy({ model: "deepseek/effective" }),
      client: {
        summarize: async (_endpoint, _sessionId, _model, options) => {
          signal = options?.signal;
          return new Promise<boolean>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      },
    });

    await expect(monitor.compact("s")).resolves.toEqual({ accepted: true });
    await waitFor(() => signal !== undefined);
    monitor.stop();
    expect(signal?.aborted).toBe(true);
  });

  it("accepts a late session.compacted after a timeout without another attempt", async () => {
    const upstream = await fakeUpstream();
    upstream.setSessions([{ id: "s" }]);
    let summarizeCalls = 0;
    upstream.setSummarize(() => {
      summarizeCalls += 1;
    });
    const monitor = await startMonitor(upstream, { compactTimeoutMs: 30 });

    upstream.emit(statusEvent("s", "idle"));
    upstream.emit(messageUpdated("s", "m1", { input: 950 }));
    await waitFor(async () => (await monitor.snapshot("s")).lastError !== null);

    upstream.emit(compactedEvent("s"));
    await waitFor(async () => (await monitor.snapshot("s")).lastError === null);
    const snapshot = await monitor.snapshot("s");
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.used).toBeNull();
    expect(summarizeCalls).toBe(1);
  });
});
