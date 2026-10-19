import { describe, expect, it } from "vitest";
import {
  createEventStream,
  EventProjector,
  type HanseEvent,
  MAX_SSE_FRAME_BYTES,
  SseParser,
} from "../src/opencode/events.js";

const encoder = new TextEncoder();

function sseEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function frame(value: string): string {
  return `data: ${value}\n\n`;
}

async function collect(events: AsyncGenerator<HanseEvent>): Promise<HanseEvent[]> {
  const output: HanseEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function v1Question(id = "que_1") {
  return {
    id: "evt_ask",
    type: "question.asked",
    properties: {
      id,
      sessionID: "ses_1",
      questions: [
        {
          header: "Pick",
          question: "Which?",
          options: [{ label: "A", description: "first" }],
        },
      ],
    },
  };
}

function v2Permission(id = "per_1") {
  return {
    id: "evt_v2_perm",
    type: "permission.v2.asked",
    properties: {
      id,
      sessionID: "ses_1",
      action: "bash",
      resources: ["ls*"],
      save: ["ls*"],
      metadata: { command: "ls" },
      source: { type: "tool", messageID: "msg_1", callID: "call_1" },
    },
  };
}

describe("SseParser", () => {
  it("keeps frames across chunk and delimiter splits", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"type":"a"}\n')).toEqual({ frames: [], warnings: [] });
    expect(parser.push('\ndata: {"type":"b"}\n\n')).toEqual({
      frames: [{ data: '{"type":"a"}' }, { data: '{"type":"b"}' }],
      warnings: [],
    });
  });

  it("handles CRLF split across chunks", () => {
    const parser = new SseParser();
    parser.push('data: {"type":"a"}\r');
    parser.push("\n\r");
    const batch = parser.push("\n");
    expect(batch.frames).toEqual([{ data: '{"type":"a"}' }]);
  });

  it("handles UTF-8 split across chunks", () => {
    const parser = new SseParser();
    const bytes = encoder.encode('data: {"text":"你好"}\n\n');
    const split = 19;
    expect(parser.push(bytes.slice(0, split)).frames).toEqual([]);
    const batch = parser.push(bytes.slice(split));
    expect(batch.frames).toEqual([{ data: '{"text":"你好"}' }]);
  });

  it("joins multi-line data and ignores comments, id, event, and retry", () => {
    const parser = new SseParser();
    const batch = parser.push(
      ": comment\nid: 1\nevent: question.asked\nretry: 100\ndata: line one\ndata: line two\n\n",
    );
    expect(batch.frames).toEqual([{ data: "line one\nline two" }]);
  });

  it("ignores frames without data and flushes a trailing frame", () => {
    const parser = new SseParser();
    expect(parser.push("event: ignored\n\n").frames).toEqual([]);
    const batch = parser.push("data: tail");
    expect(batch.frames).toEqual([]);
    expect(parser.flush().frames).toEqual([{ data: "tail" }]);
  });

  it("caps a frame and drops it", () => {
    const parser = new SseParser({ maxFrameBytes: 32 });
    const batch = parser.push(frame("x".repeat(64)));
    expect(batch.frames).toEqual([]);
    expect(batch.warnings).toHaveLength(1);
    expect(batch.warnings[0]?.code).toBe("frame_too_large");
    expect(MAX_SSE_FRAME_BYTES).toBe(1024 * 1024);
  });

  it("recovers after an oversized frame", () => {
    const parser = new SseParser({ maxFrameBytes: 32 });
    const oversized = parser.push(frame("x".repeat(64)));
    expect(oversized.warnings).toHaveLength(1);
    const batch = parser.push(frame('{"type":"ok"}'));
    expect(batch.frames).toEqual([{ data: '{"type":"ok"}' }]);
  });
});

describe("EventProjector", () => {
  it("projects v1 question events without changing the source", () => {
    const projector = new EventProjector();
    const events = projector.project(v1Question());
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("question.asked");
    if (event?.type !== "question.asked") return;
    expect(event.request.source).toBe("v1");
    expect(event.request.key).toBe("v1:que_1");
    expect(event.request.questions[0]?.custom).toBe(true);
    expect(event.request.questions[0]?.multiple).toBe(false);
  });

  it("normalizes v2 question events with source v2", () => {
    const projector = new EventProjector();
    const events = projector.project({
      id: "evt_v2_q",
      type: "question.v2.asked",
      properties: {
        id: "que_1",
        sessionID: "ses_1",
        questions: [{ header: "H", question: "Q", options: [], multiple: true, custom: false }],
      },
    });
    const event = events[0];
    expect(event?.type).toBe("question.asked");
    if (event?.type !== "question.asked") return;
    expect(event.request.source).toBe("v2");
    expect(event.request.key).toBe("v2:que_1");
    expect(event.request.questions[0]?.multiple).toBe(true);
  });

  it("maps v2 permission fields and keeps v1 separate", () => {
    const projector = new EventProjector();
    const v2Events = projector.project(v2Permission());
    const v2Event = v2Events[0];
    expect(v2Event?.type).toBe("permission.asked");
    if (v2Event?.type === "permission.asked") {
      expect(v2Event.request.permission).toBe("bash");
      expect(v2Event.request.patterns).toEqual(["ls*"]);
      expect(v2Event.request.always).toEqual(["ls*"]);
      expect(v2Event.request.source).toBe("v2");
      expect(v2Event.request.key).toBe("v2:per_1");
      expect(v2Event.request.tool).toEqual({
        type: "tool",
        messageID: "msg_1",
        callID: "call_1",
      });
    }

    const v1Event = projector.project({
      id: "evt_v1_perm",
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID: "ses_1",
        permission: "edit",
        patterns: ["*.ts"],
        metadata: {},
        always: ["*.ts"],
      },
    })[0];
    expect(v1Event?.type).toBe("permission.asked");
    if (v1Event?.type === "permission.asked") {
      expect(v1Event.request.permission).toBe("edit");
      expect(v1Event.request.source).toBe("v1");
      expect(v1Event.request.key).toBe("v1:per_1");
    }
  });

  it("normalizes v1 and v2 terminal events with their source", () => {
    const projector = new EventProjector();
    const v1 = projector.project({
      id: "evt_1",
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "que_1", answers: [["A"]] },
    })[0];
    expect(v1).toEqual({
      type: "question.replied",
      sessionID: "ses_1",
      requestID: "que_1",
      source: "v1",
    });

    const v2 = projector.project({
      id: "evt_2",
      type: "question.v2.rejected",
      properties: { sessionID: "ses_1", requestID: "que_2" },
    })[0];
    expect(v2).toEqual({
      type: "question.rejected",
      sessionID: "ses_1",
      requestID: "que_2",
      source: "v2",
    });

    const permission = projector.project({
      id: "evt_3",
      type: "permission.v2.replied",
      properties: { sessionID: "ses_1", requestID: "per_1", reply: "always" },
    })[0];
    expect(permission).toEqual({
      type: "permission.replied",
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "always",
      source: "v2",
    });
  });

  it("normalizes todo status and priority", () => {
    const projector = new EventProjector();
    const event = projector.project({
      id: "evt_todo",
      type: "todo.updated",
      properties: {
        sessionID: "ses_1",
        todos: [{ content: "step", status: "blocked", priority: "urgent" }],
      },
    })[0];
    expect(event).toEqual({
      type: "todo.updated",
      sessionID: "ses_1",
      todos: [{ content: "step", status: "unknown", priority: "unknown" }],
      truncated: false,
    });
  });

  it("dedupes envelope IDs and asked requests, then releases terminal keys", () => {
    const projector = new EventProjector();
    expect(projector.project(v1Question())).toHaveLength(1);
    expect(projector.project(v1Question())).toEqual([]);

    const sameRequestNewEnvelope = { ...v1Question("que_1"), id: "evt_other" };
    expect(projector.project(sameRequestNewEnvelope)).toEqual([]);

    projector.project({
      id: "evt_done",
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "que_1", answers: [["A"]] },
    });
    const freshAsk = { ...v1Question("que_1"), id: "evt_fresh" };
    expect(projector.project(freshAsk)).toHaveLength(1);
  });
});

describe("session.activity", () => {
  it.each([
    ["session.status", { sessionID: "ses_status" }, "ses_status"],
    ["session.idle", { sessionID: "ses_idle" }, "ses_idle"],
    ["message.updated", { info: { sessionID: "ses_message" } }, "ses_message"],
    ["message.part.updated", { part: { sessionID: "ses_part" } }, "ses_part"],
    ["session.updated", { info: { id: "ses_updated" } }, "ses_updated"],
  ])("extracts the session id from %s", (type, properties, expected) => {
    const projector = new EventProjector();
    const event = projector.project({ id: `evt_${type}`, type, properties })[0];
    expect(event).toEqual({ type: "session.activity", sessionID: expected });
  });

  it("emits activity for unknown events with a session id and drops others", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_unknown",
        type: "something.new",
        properties: { sessionID: "ses_unknown" },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_unknown" }]);
    expect(projector.project({ id: "evt_none", type: "something.new", properties: {} })).toEqual(
      [],
    );
  });
});

describe("createEventStream", () => {
  it("attaches the reader, projects frames, and warns once per dropped code", async () => {
    let attached = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame("not json")));
        controller.enqueue(encoder.encode(frame("still not json")));
        controller.enqueue(encoder.encode(sseEvent(v1Question())));
        controller.enqueue(
          encoder.encode(frame('{"type":"unknown","properties":{"sessionID":"ses_x"}}')),
        );
        controller.close();
      },
    });
    const stream = createEventStream(body, { onAttached: () => (attached = true) });
    const events = await collect(stream.events);
    expect(attached).toBe(true);
    expect(events.filter((event) => event.type === "stream.warning")).toHaveLength(1);
    expect(events.some((event) => event.type === "question.asked")).toBe(true);
    expect(events).toContainEqual({ type: "session.activity", sessionID: "ses_x" });
  });

  it("emits a warning for an oversized frame and continues", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame("x".repeat(2_048))));
        controller.enqueue(encoder.encode(sseEvent(v1Question())));
        controller.close();
      },
    });
    const events = await collect(createEventStream(body, { maxFrameBytes: 1_024 }).events);
    expect(events[0]).toEqual({
      type: "stream.warning",
      code: "frame_too_large",
      message: "dropped an SSE frame larger than 1024 bytes",
    });
    expect(events.some((event) => event.type === "question.asked")).toBe(true);
  });

  it("aborts the upstream reader when the signal fires", async () => {
    const controllerRef: { current?: ReadableStreamDefaultController<Uint8Array> } = {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef.current = controller;
        controller.enqueue(encoder.encode(sseEvent(v1Question())));
      },
    });
    const abort = new AbortController();
    const stream = createEventStream(body, { signal: abort.signal });
    const first = await stream.events.next();
    expect(first.done).toBe(false);
    abort.abort();
    const end = await stream.events.next();
    expect(end.done).toBe(true);
  });
});
