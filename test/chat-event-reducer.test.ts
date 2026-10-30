import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PART_TYPES, type ReducerContext, reduceEvent } from "../ui/chat/event-reducer.js";

const SESSION = "ses_reducer";
const STREAM = "stream-reducer";

function context(overrides: Partial<ReducerContext> = {}): ReducerContext {
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
  id: "ntc_1",
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
  id: "req_q1",
  key: "v1:req_q1",
  sessionID: SESSION,
  questions: [],
  source: "v1",
  tooLarge: false,
};

const permissionRequest = {
  id: "req_p1",
  key: "v1:req_p1",
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
    messageID: "msg_1",
    role: "assistant",
    ...overrides,
  });
}

function partEvent(
  partType: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return envelope({
    type: "message.part.updated",
    sessionID: SESSION,
    messageID: "msg_1",
    partID: "prt_1",
    partType,
    part: { id: "prt_1", type: partType },
    ...overrides,
  });
}

describe("pure chat event reducer", () => {
  it("covers every HanseEvent type", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["stream.ready", envelope({ type: "stream.ready" }), "stream/ready"],
      ["notice.created", envelope({ type: "notice.created", notice }), "notice/upsert"],
      [
        "context.updated",
        envelope({ type: "context.updated", sessionID: SESSION, context: contextSnapshot }),
        "context/set",
      ],
      ["message.updated", messageEvent(), "message/upsert"],
      ["message.part.updated", partEvent("text"), "part/upsert"],
      [
        "message.part.delta",
        envelope({
          type: "message.part.delta",
          sessionID: SESSION,
          messageID: "msg_1",
          partID: "prt_1",
          field: "text",
          delta: "x",
        }),
        "part/delta",
      ],
      [
        "message.part.omitted",
        envelope({
          type: "message.part.omitted",
          sessionID: SESSION,
          messageID: "msg_1",
          partID: "prt_1",
          reason: "too_large",
        }),
        "part/omit",
      ],
      [
        "session.status",
        envelope({ type: "session.status", sessionID: SESSION, status: { type: "busy" } }),
        "session/status",
      ],
      [
        "session.error",
        envelope({ type: "session.error", sessionID: SESSION, message: "boom" }),
        "session/error",
      ],
      [
        "session.compacted",
        envelope({ type: "session.compacted", sessionID: SESSION }),
        "session/compacted",
      ],
      [
        "session.activity",
        envelope({ type: "session.activity", sessionID: SESSION, cause: "removed" }),
        "session/activity",
      ],
      [
        "question.asked",
        envelope({ type: "question.asked", request: questionRequest }),
        "prompt/upsert",
      ],
      [
        "question.replied",
        envelope({
          type: "question.replied",
          sessionID: SESSION,
          requestID: "req_q1",
          source: "v1",
        }),
        "prompt/resolve",
      ],
      [
        "question.rejected",
        envelope({
          type: "question.rejected",
          sessionID: SESSION,
          requestID: "req_q1",
          source: "v1",
        }),
        "prompt/resolve",
      ],
      [
        "permission.asked",
        envelope({ type: "permission.asked", request: permissionRequest }),
        "prompt/upsert",
      ],
      [
        "permission.replied",
        envelope({
          type: "permission.replied",
          sessionID: SESSION,
          requestID: "req_p1",
          reply: "once",
          source: "v1",
        }),
        "prompt/resolve",
      ],
      [
        "todo.updated",
        envelope({
          type: "todo.updated",
          sessionID: SESSION,
          todos: [{ content: "todo", status: "pending", priority: "low" }],
          truncated: false,
        }),
        "context/todos",
      ],
    ];

    for (const [name, event, expected] of cases) {
      const result = reduceEvent(event as never, context());
      expect(result.accepted, name).toBe(true);
      const last = result.actions[result.actions.length - 1];
      expect(last?.type, name).toBe(expected);
    }
  });

  it("covers all twelve PartTypes and flags unknown part types for reconcile", () => {
    expect(PART_TYPES).toHaveLength(12);
    for (const partType of PART_TYPES) {
      const result = reduceEvent(partEvent(partType) as never, context());
      expect(result.accepted).toBe(true);
      const action = result.actions.find((candidate) => candidate.type === "part/upsert");
      expect(action, partType).toMatchObject({ partType, known: true });
    }

    const unknown = reduceEvent(partEvent("future-part") as never, context());
    expect(unknown.actions.find((candidate) => candidate.type === "part/upsert")).toMatchObject({
      partType: "future-part",
      known: false,
    });
  });

  it("turns a future event type into an explicit unknown action, never a silent drop", () => {
    const result = reduceEvent(envelope({ type: "future.event" }) as never, context());
    expect(result.accepted).toBe(true);
    expect(result.actions).toContainEqual({ type: "event/unknown", eventType: "future.event" });
  });

  it("resets stream identity on stream.ready even when its seq is behind", () => {
    const result = reduceEvent(
      envelope({ type: "stream.ready" }, 1, "stream-next") as never,
      context(),
    );

    expect(result.accepted).toBe(true);
    expect(result.stream).toMatchObject({ streamID: "stream-next", reset: true, changed: true });
    expect(result.actions[0]).toMatchObject({
      type: "stream/ready",
      streamID: "stream-next",
      reset: true,
    });
  });

  it("drops duplicate sequences with no actions", () => {
    const result = reduceEvent(
      messageEvent() as never,
      context({ lastSeqByStream: new Map([[STREAM, 11]]) }),
    );
    expect(result.accepted).toBe(false);
    expect(result.dropReason).toBe("duplicate");
    expect(result.actions).toEqual([]);
  });

  it("keeps a gapped event and asks for reconcile", () => {
    const result = reduceEvent({ ...messageEvent(), seq: 12 } as never, context());
    expect(result.accepted).toBe(true);
    expect(result.stream?.gap).toBe(true);
    expect(result.actions[0]).toMatchObject({ type: "stream/seq", seq: 12, gap: true });
  });

  it("resets sequence state when the stream identity changes", () => {
    const result = reduceEvent(
      envelope(
        { type: "session.status", sessionID: SESSION, status: { type: "busy" } },
        1,
        "stream-other",
      ) as never,
      context(),
    );
    expect(result.accepted).toBe(true);
    expect(result.stream).toMatchObject({ streamID: "stream-other", reset: true, changed: true });
    expect(result.actions[0]).toMatchObject({ type: "stream/seq", reset: true, changed: true });
  });

  it("drops session-scoped events for another session", () => {
    const events = [
      messageEvent({ sessionID: "ses_other" }),
      partEvent("text", { sessionID: "ses_other" }),
      envelope({
        type: "message.part.delta",
        sessionID: "ses_other",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "x",
      }),
      envelope({
        type: "message.part.omitted",
        sessionID: "ses_other",
        messageID: "msg_1",
        partID: "prt_1",
        reason: "too_large",
      }),
      envelope({ type: "session.error", sessionID: "ses_other", message: "boom" }),
      envelope({ type: "session.compacted", sessionID: "ses_other" }),
      envelope({ type: "session.activity", sessionID: "ses_other", cause: "removed" }),
      envelope({ type: "notice.created", notice: { ...notice, sessionId: "ses_other" } }),
      envelope({
        type: "stream.warning",
        code: "invalid_json",
        message: "bad",
        sessionID: "ses_other",
      }),
    ];

    for (const event of events) {
      const result = reduceEvent(event as never, context());
      expect(result.accepted, String(event.type)).toBe(false);
      expect(result.dropReason, String(event.type)).toBe("other-session");
      expect(result.actions, String(event.type)).toEqual([]);
    }
  });

  it("keeps keyed context/todo/status events for other sessions", () => {
    const todos = reduceEvent(
      envelope({
        type: "todo.updated",
        sessionID: "ses_other",
        todos: [],
        truncated: false,
      }) as never,
      context(),
    );
    expect(todos.accepted).toBe(true);
    expect(todos.actions).toContainEqual({
      type: "context/todos",
      sessionID: "ses_other",
      todos: [],
      truncated: false,
    });

    const status = reduceEvent(
      envelope({
        type: "session.status",
        sessionID: "ses_other",
        status: { type: "idle" },
      }) as never,
      context(),
    );
    expect(status.accepted).toBe(true);

    const contextEvent = reduceEvent(
      envelope({
        type: "context.updated",
        sessionID: "ses_other",
        context: { ...contextSnapshot, sessionID: "ses_other" },
      }) as never,
      context(),
    );
    expect(contextEvent.accepted).toBe(true);
  });

  it("rejects malformed context and message events", () => {
    expect(
      reduceEvent(
        envelope({
          type: "context.updated",
          sessionID: "ses_other",
          context: contextSnapshot,
        }) as never,
        context(),
      ).dropReason,
    ).toBe("malformed");

    expect(
      reduceEvent(envelope({ type: "message.updated", sessionID: SESSION }) as never, context())
        .dropReason,
    ).toBe("malformed");
  });

  it("derives a deterministic local error row id", () => {
    const result = reduceEvent(
      envelope({ type: "session.error", sessionID: SESSION, message: "boom" }, 12) as never,
      context(),
    );
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        type: "session/error",
        errorID: `local_error_${STREAM}_12`,
      }),
    );
  });

  it("covers both stream warning outcomes", () => {
    const warning = reduceEvent(
      envelope({
        type: "stream.warning",
        code: "invalid_json",
        message: "bad",
        sessionID: SESSION,
      }) as never,
      context(),
    );
    expect(warning.actions).toContainEqual(
      expect.objectContaining({ type: "stream/warning", code: "invalid_json", message: "bad" }),
    );

    const limit = reduceEvent(
      envelope({ type: "stream.warning", code: "stream_limit", message: "paused" }) as never,
      context(),
    );
    expect(limit.accepted).toBe(true);
    expect(limit.actions).toContainEqual(
      expect.objectContaining({ type: "stream/limit", code: "stream_limit", message: "paused" }),
    );
  });
});

describe("reducer purity guard", () => {
  const source = readFileSync(new URL("../ui/chat/event-reducer.ts", import.meta.url), "utf8");

  it("contains no DOM, network, storage, router, or timer access", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bnew\s+EventSource\b/);
    expect(source).not.toMatch(/\bXMLHttpRequest\b/);
    expect(source).not.toMatch(/\bdocument\./);
    expect(source).not.toMatch(/\bwindow\./);
    expect(source).not.toMatch(/\blocalStorage\b/);
    expect(source).not.toMatch(/\bsessionStorage\b/);
    expect(source).not.toMatch(/\buseRouter\b/);
    expect(source).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
  });
});
