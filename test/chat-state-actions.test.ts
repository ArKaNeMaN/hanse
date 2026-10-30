import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { PART_TYPES, type ReducerContext, reduceEvent } from "../ui/chat/event-reducer.js";
import { applyChatActions } from "../ui/chat/state-actions.js";
import { useChatContextStore } from "../ui/stores/chat-context.js";
import { useChatFeedStore } from "../ui/stores/chat-feed.js";
import { useChatSessionStore } from "../ui/stores/chat-session.js";

const SESSION = "ses_actions";
const STREAM = "stream-actions";

function reducerContext(overrides: Partial<ReducerContext> = {}): ReducerContext {
  return {
    sessionID: SESSION,
    currentStreamID: STREAM,
    lastSeqByStream: new Map([[STREAM, 10]]),
    ...overrides,
  };
}

function envelope(
  event: Record<string, unknown>,
  seq = 11,
  streamID = STREAM,
): Record<string, unknown> {
  return { ...event, seq, streamID };
}

const notice = {
  id: "ntc_actions",
  appId: "app-test",
  sessionId: SESSION,
  kind: "agent_stopped",
  payload: {},
  createdAt: "2026-01-01T00:00:00.000Z",
};

const contextSnapshot = {
  sessionID: SESSION,
  state: "ready",
  used: 10,
  limit: 100,
  percent: 10,
  model: null,
  status: "idle",
  topLevel: true,
  activeChildren: false,
  pendingTask: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastCompactedAt: null,
  lastError: null,
  autoCompact: { enabled: false, percent: 80, source: "default", percentSource: "default" },
};

const questionRequest = {
  id: "req_q",
  key: "v1:req_q",
  sessionID: SESSION,
  questions: [],
  source: "v1",
  tooLarge: false,
};

const permissionRequest = {
  id: "req_p",
  key: "v1:req_p",
  sessionID: SESSION,
  permission: "read",
  patterns: [],
  metadata: {},
  always: [],
  source: "v1",
};

function messageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope({
    type: "message.updated",
    sessionID: SESSION,
    messageID: "msg_actions",
    role: "assistant",
    ...overrides,
  });
}

function partEvent(
  partType: string,
  partID = "prt_actions",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return envelope({
    type: "message.part.updated",
    sessionID: SESSION,
    messageID: "msg_actions",
    partID,
    partType,
    part: { id: partID, type: partType },
    ...overrides,
  });
}

function setup(): {
  feed: ReturnType<typeof useChatFeedStore>;
  session: ReturnType<typeof useChatSessionStore>;
  context: ReturnType<typeof useChatContextStore>;
} {
  setActivePinia(createPinia());
  const feed = useChatFeedStore();
  const session = useChatSessionStore();
  const context = useChatContextStore();
  feed.reset(SESSION);
  session.setActive(SESSION);
  return { feed, session, context };
}

function apply(event: Record<string, unknown>, ctx: ReducerContext = reducerContext()) {
  const result = reduceEvent(event as never, ctx);
  return { result, intents: applyChatActions(result.actions) };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("chat state action applier", () => {
  it("resets stream identity on stream.ready and requests rehydration", () => {
    const { feed } = setup();
    feed.setStreamWarning("old");
    const { intents } = apply(envelope({ type: "stream.ready" }, 1, "stream-next"));

    expect(feed.thread.currentStreamID).toBe("stream-next");
    expect([...feed.thread.lastSeqByStream.entries()]).toEqual([["stream-next", 0]]);
    expect(feed.streamWarning).toBeNull();
    expect(intents).toContainEqual({
      type: "refresh",
      targets: ["runtime", "commands", "context", "notices", "messages"],
    });
  });

  it("applies sequence updates and requests reconcile on a gap", () => {
    const { feed } = setup();
    const { intents } = apply(
      { ...messageEvent(), seq: 12 },
      reducerContext({ lastSeqByStream: new Map([[STREAM, 10]]) }),
    );

    expect(feed.thread.lastSeqByStream.get(STREAM)).toBe(12);
    expect(intents).toContainEqual({ type: "reconcile", reason: "stream-gap", delayMs: 500 });
  });

  it("applies stream warnings and the paused limit state", () => {
    const { feed } = setup();
    const warning = apply(
      envelope({
        type: "stream.warning",
        code: "invalid_json",
        message: "bad",
        sessionID: SESSION,
      }),
    );
    expect(feed.streamWarning).toBe("bad");
    expect(warning.intents).toContainEqual({
      type: "notice",
      tone: "warning",
      message: "bad",
    });
    expect(warning.intents).toContainEqual({
      type: "reconcile",
      reason: "stream-warning",
      delayMs: 500,
    });

    const limit = apply(
      envelope({ type: "stream.warning", code: "stream_limit", message: "paused" }),
    );
    expect(feed.streamPaused).toBe(true);
    expect(limit.intents).toContainEqual({ type: "stream-paused", message: "paused" });
  });

  it("upserts nav notices and keeps them ordered by time", () => {
    const { feed } = setup();
    apply(
      envelope({
        type: "notice.created",
        notice: { ...notice, id: "ntc_late", createdAt: "2026-01-02T00:00:00.000Z" },
      }),
    );
    apply(
      envelope({
        type: "notice.created",
        notice: { ...notice, id: "ntc_early", createdAt: "2026-01-01T00:00:00.000Z" },
      }),
    );

    expect(feed.notices.map((item) => item.id)).toEqual(["ntc_early", "ntc_late"]);
  });

  it("mirrors context snapshots only for the active session", () => {
    const { context } = setup();
    apply(envelope({ type: "context.updated", sessionID: SESSION, context: contextSnapshot }));
    expect(context.snapshot?.sessionID).toBe(SESSION);
    expect(context.snapshotFor(SESSION)?.used).toBe(10);

    apply(
      envelope({
        type: "context.updated",
        sessionID: "ses_other",
        context: { ...contextSnapshot, sessionID: "ses_other" },
      }),
    );
    expect(context.snapshotFor("ses_other")?.sessionID).toBe("ses_other");
    expect(context.snapshot?.sessionID).toBe(SESSION);
  });

  it("upserts a message into the keyed feed and marks it dirty", () => {
    const { feed } = setup();
    const { intents } = apply(messageEvent({ role: "user", parentID: "msg_parent" }));

    expect(feed.thread.order).toEqual(["msg_actions"]);
    const record = feed.message("msg_actions");
    expect(record).toMatchObject({ role: "user", parentID: "msg_parent" });
    expect(feed.dirtyMessages.has("msg_actions")).toBe(true);
    expect(intents).toContainEqual({ type: "dirty-message", messageID: "msg_actions" });
    expect(intents).toContainEqual({
      type: "scroll",
      target: "bottom",
      reason: "message-updated",
    });
  });

  it("upserts every PartType and reconciles unknown part types", () => {
    const { feed } = setup();
    for (const [index, partType] of PART_TYPES.entries()) {
      const partID = `prt_${index}`;
      const { intents } = apply(partEvent(partType, partID));
      expect(feed.part("msg_actions", partID)?.type, partType).toBe(partType);
      expect(intents).toContainEqual({ type: "dirty-part", partID });
    }

    const { intents } = apply(partEvent("future-part", "prt_future"));
    expect(feed.message("msg_actions")?.needsReconcile).toBe(true);
    expect(intents).toContainEqual({
      type: "reconcile",
      reason: "unknown-part-type",
      delayMs: 500,
    });
    expect(intents).toContainEqual(expect.objectContaining({ type: "notice", tone: "warning" }));
  });

  it("buffers part deltas instead of applying them to part data", () => {
    const { feed } = setup();
    apply(partEvent("text", "prt_delta"));
    const { intents } = apply(
      envelope({
        type: "message.part.delta",
        sessionID: SESSION,
        messageID: "msg_actions",
        partID: "prt_delta",
        field: "text",
        delta: "hello",
      }),
    );

    expect(feed.thread.pendingDeltas.get("prt_delta")).toBe("hello");
    expect(feed.part("msg_actions", "prt_delta")?.data.text).toBeUndefined();
    expect(intents).toContainEqual({ type: "dirty-part", partID: "prt_delta" });
  });

  it("marks an omitted part partial and requests reconcile", () => {
    const { feed } = setup();
    const { intents } = apply(
      envelope({
        type: "message.part.omitted",
        sessionID: SESSION,
        messageID: "msg_actions",
        partID: "prt_omitted",
        partType: "text",
        reason: "too_large",
      }),
    );

    expect(feed.part("msg_actions", "prt_omitted")).toMatchObject({
      partial: true,
      omitted: true,
    });
    expect(feed.message("msg_actions")?.needsReconcile).toBe(true);
    expect(intents).toContainEqual({ type: "reconcile", reason: "part-omitted", delayMs: 500 });
    expect(intents).toContainEqual(expect.objectContaining({ type: "notice", tone: "warning" }));
  });

  it("sets agent status, bumps the turn on busy/idle, and seals parts on idle", () => {
    const { feed, session } = setup();
    apply(partEvent("text"));
    const turnBefore = feed.thread.turnGeneration;

    apply(envelope({ type: "session.status", sessionID: SESSION, status: { type: "busy" } }));
    expect(feed.thread.turnGeneration).toBe(turnBefore + 1);
    expect(session.agentStatusFor(SESSION)).toEqual({ type: "busy" });

    const { intents } = apply(
      envelope({ type: "session.status", sessionID: SESSION, status: { type: "idle" } }),
    );
    expect(feed.thread.turnGeneration).toBe(turnBefore + 2);
    expect(feed.part("msg_actions", "prt_actions")?.sealed).toBe(true);
    expect(intents).toContainEqual({ type: "reconcile", reason: "idle", delayMs: 200 });
  });

  it("settles failed optimistic messages and appends the local error row", () => {
    const { feed } = setup();
    apply(messageEvent({ role: "user", messageID: "msg_optimistic" }));
    const optimistic = feed.message("msg_optimistic");
    if (optimistic !== undefined) {
      optimistic.optimistic = "sending";
    }

    const { intents } = apply(
      envelope({ type: "session.error", sessionID: SESSION, message: "boom" }, 12),
    );

    expect(feed.message("msg_optimistic")?.optimistic).toBe("failed");
    const errorID = `local_error_${STREAM}_12`;
    expect(feed.message(errorID)?.role).toBe("assistant");
    expect(feed.thread.agentStatus).toEqual({ type: "idle" });
    expect(intents).toContainEqual({ type: "dirty-message", messageID: errorID });
    expect(intents).toContainEqual({ type: "toast", tone: "error", message: "Agent error: boom" });
    expect(intents).toContainEqual({ type: "refresh", targets: ["context"] });
  });

  it("records compaction and activity reconcile intents", () => {
    const { context } = setup();
    const compacted = apply(envelope({ type: "session.compacted", sessionID: SESSION }));
    expect(context.compactedAt).not.toBeNull();
    expect(compacted.intents).toContainEqual({
      type: "toast",
      tone: "success",
      message: "Session compacted.",
    });

    const quiet = apply(
      envelope({ type: "session.activity", sessionID: SESSION, cause: "message" }),
    );
    expect(quiet.intents).toEqual([]);

    const reconcile = apply(
      envelope({ type: "session.activity", sessionID: SESSION, cause: "removed" }),
    );
    expect(reconcile.intents).toContainEqual({
      type: "reconcile",
      reason: "session-activity",
      delayMs: 500,
    });
  });

  it("passes prompt requests through as render intents", () => {
    setup();
    const { intents: asked } = apply(
      envelope({ type: "question.asked", request: questionRequest }),
    );
    expect(asked).toContainEqual({
      type: "prompt-upsert",
      kind: "question",
      request: questionRequest,
      active: true,
    });

    const { intents: permission } = apply(
      envelope({ type: "permission.asked", request: permissionRequest }),
    );
    expect(permission).toContainEqual({
      type: "prompt-upsert",
      kind: "permission",
      request: permissionRequest,
      active: true,
    });

    const { intents: replied } = apply(
      envelope({
        type: "permission.replied",
        sessionID: SESSION,
        requestID: "req_p",
        reply: "once",
        source: "v1",
      }),
    );
    expect(replied).toContainEqual({
      type: "prompt-resolve",
      kind: "permission",
      outcome: "replied",
      requestID: "req_p",
      source: "v1",
      reply: "once",
      active: true,
    });
  });

  it("updates active context todos and the plan", () => {
    const { context } = setup();
    apply(
      envelope({
        type: "todo.updated",
        sessionID: SESSION,
        todos: [
          { content: "one", status: "completed", priority: "low" },
          { content: "two", status: "in_progress", priority: "high" },
        ],
        truncated: false,
      }),
    );

    expect(context.todos.map((todo) => todo.content)).toEqual(["one", "two"]);
    expect(context.plan).toHaveLength(2);
    expect(context.todoCounts).toEqual({ total: 2, completed: 1, active: 1, pending: 0 });
    expect(context.todosFor(SESSION)?.truncated).toBe(false);
  });
});

describe("store URL ownership guard", () => {
  const files = [
    "../ui/stores/chat-feed.ts",
    "../ui/stores/chat-session.ts",
    "../ui/stores/chat-context.ts",
    "../ui/chat/state-actions.ts",
    "../ui/chat/feed-store.ts",
    "../ui/chat/event-reducer.ts",
  ];

  it("has no router, URL, history, or location writer", () => {
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/\buseRouter\b|\buseRoute\b/);
      expect(source, file).not.toMatch(/\brouter\.(push|replace|go|back|forward)\b/);
      expect(source, file).not.toMatch(/\bhistory\.(pushState|replaceState)\b/);
      expect(source, file).not.toMatch(/\bwindow\.location\b/);
      expect(source, file).not.toMatch(/\blocation\.(assign|replace|href)\b/);
    }
  });
});
