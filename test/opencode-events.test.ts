import { describe, expect, it, vi } from "vitest";
import {
  APP_STREAM_MAX_FRAME_BYTES,
  createEventStream,
  EventProjector,
  type HanseEvent,
  IDENTITY_SALVAGE_PREFIX_BYTES,
  MAX_DELTA_BYTES,
  MAX_DIFF_BYTES,
  MAX_DIFF_EVENT_BYTES,
  MAX_DIFF_FILES,
  MAX_DIFF_PATH_BYTES,
  MAX_DIFF_PATH_TOTAL_BYTES,
  MAX_MESSAGE_INFO_BYTES,
  MAX_PART_ARRAY_ITEMS,
  MAX_PART_EVENT_BYTES,
  MAX_PART_STRING_BYTES,
  MAX_PATCH_BYTES,
  MAX_SSE_FRAME_BYTES,
  MAX_STATUS_ACTION_BYTES,
  MAX_STATUS_MESSAGE,
  MAX_TEXT_SNAPSHOT_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TRACKED_PART_IDS,
  MAX_TRUNCATED_FIELD_BYTES,
  MAX_TRUNCATED_FIELDS,
  MAX_TYPED_EVENT_BYTES,
  MAX_WRITE_CONTENT_BYTES,
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

function partEvent(part: Record<string, unknown>, id = "evt_part") {
  return {
    id,
    type: "message.part.updated",
    properties: { sessionID: part.sessionID, part },
  };
}

function deltaEvent(
  partID: string,
  delta: string,
  overrides: Record<string, unknown> = {},
  id = "evt_delta",
) {
  return {
    id,
    type: "message.part.delta",
    properties: {
      sessionID: "ses_1",
      messageID: "msg_1",
      partID,
      field: "text",
      delta,
      ...overrides,
    },
  };
}

function textPart(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "part_text",
    type: "text",
    sessionID: "ses_1",
    messageID: "msg_1",
    text,
    time: { start: 1 },
    ...overrides,
  };
}

function toolPart(overrides: Record<string, unknown> = {}) {
  return {
    id: "part_tool",
    type: "tool",
    sessionID: "ses_1",
    messageID: "msg_1",
    callID: "call_1",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "ls" },
      time: { start: 1 },
      metadata: { output: "partial" },
    },
    ...overrides,
  };
}

function diffPart(
  tool: string,
  state: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `part_${tool}`,
    type: "tool",
    sessionID: "ses_1",
    messageID: "msg_1",
    callID: `call_${tool}`,
    tool,
    state,
    ...overrides,
  };
}

function fileRecord(index: number, patch: string, path = `dir/file-${index}.ts`) {
  return {
    type: "update",
    relativePath: path,
    filePath: path,
    additions: 1,
    deletions: 0,
    patch,
  };
}

function projectPart(part: Record<string, unknown>, id = `evt_${String(part.id)}`) {
  return new EventProjector().project(partEvent(part, id))[0];
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function partOf(event: HanseEvent | undefined): Record<string, unknown> {
  if (event?.type !== "message.part.updated") throw new Error("expected message.part.updated");
  return event.part;
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
    const bytesValue = encoder.encode('data: {"text":"你好"}\n\n');
    const split = 19;
    expect(parser.push(bytesValue.slice(0, split)).frames).toEqual([]);
    const batch = parser.push(bytesValue.slice(split));
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

  it("caps a frame, drops it, and retains a bounded identity prefix", () => {
    const parser = new SseParser({ maxFrameBytes: 32 });
    const batch = parser.push(frame("x".repeat(64)));
    expect(batch.frames).toEqual([]);
    expect(batch.warnings).toHaveLength(1);
    expect(batch.warnings[0]?.code).toBe("frame_too_large");
    expect(batch.warnings[0]?.prefix?.startsWith("data: x")).toBe(true);
    expect(batch.warnings[0]?.prefix?.length).toBeGreaterThan(32);
    expect(MAX_SSE_FRAME_BYTES).toBe(1024 * 1024);
  });

  it("recovers after an oversized frame", () => {
    const parser = new SseParser({ maxFrameBytes: 32 });
    const oversized = parser.push(frame("x".repeat(64)));
    expect(oversized.warnings).toHaveLength(1);
    const batch = parser.push(frame('{"type":"ok"}'));
    expect(batch.frames).toEqual([{ data: '{"type":"ok"}' }]);
  });

  it("exports the app-stream contract constants", () => {
    expect(APP_STREAM_MAX_FRAME_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_TYPED_EVENT_BYTES).toBe(256 * 1024);
    expect(MAX_DELTA_BYTES).toBe(64 * 1024);
    expect(MAX_TEXT_SNAPSHOT_BYTES).toBe(64 * 1024);
    expect(MAX_PART_EVENT_BYTES).toBe(256 * 1024);
    expect(MAX_TOOL_OUTPUT_BYTES).toBe(64 * 1024);
    expect(MAX_PATCH_BYTES).toBe(64 * 1024);
    expect(MAX_DIFF_BYTES).toBe(64 * 1024);
    expect(MAX_DIFF_EVENT_BYTES).toBe(128 * 1024);
    expect(MAX_WRITE_CONTENT_BYTES).toBe(64 * 1024);
    expect(MAX_DIFF_FILES).toBe(50);
    expect(MAX_DIFF_PATH_BYTES).toBe(1024);
    expect(MAX_DIFF_PATH_TOTAL_BYTES).toBe(16 * 1024);
    expect(MAX_TRUNCATED_FIELDS).toBe(32);
    expect(MAX_TRUNCATED_FIELD_BYTES).toBe(8 * 1024);
    expect(MAX_PART_STRING_BYTES).toBe(8 * 1024);
    expect(MAX_PART_ARRAY_ITEMS).toBe(200);
    expect(MAX_STATUS_MESSAGE).toBe(2_000);
    expect(MAX_STATUS_ACTION_BYTES).toBe(2 * 1024);
    expect(MAX_MESSAGE_INFO_BYTES).toBe(8 * 1024);
    expect(IDENTITY_SALVAGE_PREFIX_BYTES).toBe(64 * 1024);
    expect(MAX_TRACKED_PART_IDS).toBe(5_000);
  });
});

describe("EventProjector prompts", () => {
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

describe("message.updated", () => {
  it("copies bounded identity and emits the compatibility activity", () => {
    const projector = new EventProjector();
    const events = projector.project({
      id: "evt_message",
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_1",
          role: "assistant",
          sessionID: "ses_1",
          parentID: "p".repeat(250),
          finish: "f".repeat(40),
          time: { created: 1, completed: 2 },
        },
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "message.updated",
      sessionID: "ses_1",
      messageID: "msg_1",
      role: "assistant",
      parentID: "p".repeat(200),
      finish: "f".repeat(32),
      time: { created: 1, completed: 2 },
    });
    expect(events[1]).toEqual({
      type: "session.activity",
      sessionID: "ses_1",
      cause: "message",
    });
  });

  it.each([
    ["invalid role", { id: "msg_1", role: "system", sessionID: "ses_1" }, "ses_1"],
    ["missing id", { role: "assistant", sessionID: "ses_1" }, "ses_1"],
    ["missing session", { id: "msg_1", role: "assistant" }, "msg_1"],
  ])("falls back to activity for %s", (_label, info, expectedSession) => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_bad_message",
        type: "message.updated",
        properties: { info },
      }),
    ).toEqual([{ type: "session.activity", sessionID: expectedSession, cause: "unknown" }]);
  });

  it("falls back to activity when the derived fields exceed the budget", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_huge_message",
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "i".repeat(MAX_MESSAGE_INFO_BYTES + 1), role: "user", sessionID: "ses_1" },
        },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_1", cause: "unknown" }]);
  });
});

describe("message.part.updated", () => {
  it("maps a bounded text snapshot and preserves synthetic/ignored", () => {
    const projector = new EventProjector();
    const events = projector.project(
      partEvent(textPart("hello", { synthetic: true, ignored: true, title: "T" }), "evt_text"),
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("message.part.updated");
    if (event?.type !== "message.part.updated") return;
    expect(event).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "part_text",
      partType: "text",
    });
    expect(event.part.text).toBe("hello");
    expect(event.part.synthetic).toBe(true);
    expect(event.part.ignored).toBe(true);
    expect(event.part.title).toBe("T");
  });

  it.each([
    ["missing part id", { type: "text", sessionID: "ses_1", messageID: "msg_1" }, "ses_1"],
    ["missing part type", { id: "part_1", sessionID: "ses_1", messageID: "msg_1" }, "ses_1"],
    ["missing session", { id: "part_1", type: "text", messageID: "msg_1" }, undefined],
    ["missing message", { id: "part_1", type: "text", sessionID: "ses_1" }, "ses_1"],
    [
      "unknown part type",
      { id: "part_1", type: "new-type", sessionID: "ses_1", messageID: "msg_1" },
      "ses_1",
    ],
  ])("falls back to activity for %s", (_label, part, expectedSession) => {
    const projector = new EventProjector();
    expect(projector.project(partEvent(part, `evt_${_label}`))).toEqual(
      expectedSession === undefined
        ? []
        : [{ type: "session.activity", sessionID: expectedSession, cause: "unknown" }],
    );
  });

  it("treats mismatched identity as activity", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_mismatch",
        type: "message.part.updated",
        properties: {
          sessionID: "ses_other",
          part: { id: "part_1", type: "text", sessionID: "ses_1", messageID: "msg_1" },
        },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_other", cause: "unknown" }]);
    expect(
      projector.project({
        id: "evt_mismatch_message",
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          messageID: "msg_other",
          part: { id: "part_1", type: "text", sessionID: "ses_1", messageID: "msg_1" },
        },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_1", cause: "unknown" }]);
  });

  it("keeps the last 64 KiB of running bash output", () => {
    const projector = new EventProjector();
    const output = `HEAD${"x".repeat(70 * 1024)}TAIL`;
    const event = projector.project(
      partEvent(
        toolPart({
          state: {
            status: "running",
            input: { command: "bash x" },
            metadata: { output },
          },
        }),
        "evt_running",
      ),
    )[0];
    const part = partOf(event);
    const state = part.state as Record<string, unknown>;
    const metadata = state.metadata as Record<string, unknown>;
    const kept = metadata.output as string;
    expect(Buffer.byteLength(kept, "utf8")).toBe(MAX_TOOL_OUTPUT_BYTES);
    expect(kept.endsWith("TAIL")).toBe(true);
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toContain(
      "state.metadata.output",
    );
  });

  it("keeps the first 64 KiB of completed output", () => {
    const projector = new EventProjector();
    const output = `HEAD${"x".repeat(70 * 1024)}TAIL`;
    const event = projector.project(
      partEvent(
        toolPart({
          state: {
            status: "completed",
            input: { command: "bash x" },
            output,
            metadata: {},
            time: { start: 1, end: 2 },
          },
        }),
        "evt_completed",
      ),
    )[0];
    const state = partOf(event).state as Record<string, unknown>;
    const kept = state.output as string;
    expect(Buffer.byteLength(kept, "utf8")).toBe(MAX_TOOL_OUTPUT_BYTES);
    expect(kept.startsWith("HEAD")).toBe(true);
    expect(kept.endsWith("TAIL")).toBe(false);
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toContain(
      "state.output",
    );
  });

  it("keeps the first 64 KiB of patch text", () => {
    const projector = new EventProjector();
    const event = projector.project(
      partEvent(
        {
          id: "part_patch",
          type: "patch",
          sessionID: "ses_1",
          messageID: "msg_1",
          patch: `HEAD${"x".repeat(70 * 1024)}TAIL`,
        },
        "evt_patch",
      ),
    )[0];
    const part = partOf(event);
    expect(part.patch as string).toHaveLength(MAX_PATCH_BYTES);
    expect(Buffer.byteLength(part.patch as string, "utf8")).toBe(MAX_PATCH_BYTES);
    expect((part.patch as string).startsWith("HEAD")).toBe(true);
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toContain(
      "patch",
    );
  });

  it("caps generic strings and arrays", () => {
    const projector = new EventProjector();
    const event = projector.project(
      partEvent(
        toolPart({
          title: "t".repeat(MAX_PART_STRING_BYTES + 100),
          state: {
            status: "running",
            input: { command: "c".repeat(MAX_PART_STRING_BYTES + 100), args: Array(250).fill("a") },
            metadata: {},
          },
        }),
        "evt_generic",
      ),
    )[0];
    const part = partOf(event);
    expect((part.title as string).length).toBe(MAX_PART_STRING_BYTES);
    const state = part.state as Record<string, unknown>;
    const input = state.input as Record<string, unknown>;
    expect((input.command as string).length).toBe(MAX_PART_STRING_BYTES);
    expect(input.args as unknown[]).toHaveLength(MAX_PART_ARRAY_ITEMS);
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toEqual(
      expect.arrayContaining(["title", "state.input.command", "state.input.args.length"]),
    );
  });

  it("preserves question tool input under the prompt caps", () => {
    const projector = new EventProjector();
    const options = Array.from({ length: 150 }, (_, index) =>
      index === 0
        ? { label: "l".repeat(2_100), description: "d".repeat(4_100) }
        : { label: "L", description: "D" },
    );
    const event = projector.project(
      partEvent(
        {
          id: "part_question",
          type: "tool",
          sessionID: "ses_1",
          messageID: "msg_1",
          callID: "call_q",
          tool: "question",
          state: {
            status: "running",
            input: {
              questions: [
                {
                  header: "h".repeat(300),
                  question: "q".repeat(12_000),
                  options,
                  multiple: true,
                  custom: false,
                },
              ],
            },
            metadata: {},
          },
        },
        "evt_question_part",
      ),
    )[0];
    const state = partOf(event).state as Record<string, unknown>;
    const input = state.input as Record<string, unknown>;
    const questions = input.questions as Array<Record<string, unknown>>;
    expect(questions).toHaveLength(1);
    const firstQuestion = questions[0] as Record<string, unknown>;
    expect((firstQuestion.header as string).length).toBe(200);
    expect((firstQuestion.question as string).length).toBe(10_000);
    const boundedOptions = firstQuestion.options as Array<Record<string, unknown>>;
    expect(boundedOptions).toHaveLength(100);
    const firstOption = boundedOptions[0] as Record<string, unknown>;
    expect((firstOption.label as string).length).toBe(2_000);
    expect((firstOption.description as string).length).toBe(4_000);
    expect(firstQuestion.multiple).toBe(true);
    expect(firstQuestion.custom).toBe(false);
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toEqual(
      expect.arrayContaining([
        "state.input.questions[0].header",
        "state.input.questions[0].question",
        "state.input.questions[0].options.length",
        "state.input.questions[0].options[0].label",
        "state.input.questions[0].options[0].description",
      ]),
    );
  });

  it("preserves question answers and todos under their caps", () => {
    const projector = new EventProjector();
    const answers = Array.from({ length: 120 }, (_, group) => [
      group === 0 ? "a".repeat(3_000) : "answer",
      ...Array.from({ length: 120 }, () => "v"),
    ]);
    const event = projector.project(
      partEvent(
        {
          id: "part_answers",
          type: "tool",
          sessionID: "ses_1",
          messageID: "msg_1",
          tool: "question",
          state: {
            status: "completed",
            input: { questions: [] },
            metadata: {
              answers,
              todos: [{ content: "t".repeat(9_000), status: "pending", priority: "low" }],
            },
            output: "done",
          },
        },
        "evt_answers",
      ),
    )[0];
    const state = partOf(event).state as Record<string, unknown>;
    const metadata = state.metadata as Record<string, unknown>;
    const keptAnswers = metadata.answers as string[][];
    expect(keptAnswers).toHaveLength(100);
    expect(keptAnswers[0]).toHaveLength(100);
    expect(keptAnswers[0]?.[0]).toHaveLength(2_000);
    const todos = metadata.todos as Array<Record<string, unknown>>;
    const firstTodo = todos[0] as Record<string, unknown>;
    expect((firstTodo.content as string).length).toBe(8_000);
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toEqual(
      expect.arrayContaining([
        "state.metadata.answers.length",
        "state.metadata.answers[0].length",
        "state.metadata.answers[0][0]",
        "more",
      ]),
    );
  });

  it("emits message.part.omitted when a part is still too large after caps", () => {
    const projector = new EventProjector();
    const input: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      input[`key_${index}`] = "x".repeat(MAX_PART_STRING_BYTES);
    }
    const event = projector.project(
      partEvent(
        toolPart({ state: { status: "running", input, metadata: {} } }),
        "evt_too_large_part",
      ),
    )[0];
    expect(event).toEqual({
      type: "message.part.omitted",
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "part_tool",
      partType: "tool",
      reason: "too_large",
    });
  });

  it("does not emit activity for valid parts or deltas", () => {
    const projector = new EventProjector();
    const events = projector.project(partEvent(textPart("hello"), "evt_no_activity"));
    expect(events).toHaveLength(1);
    expect(events.some((event) => event.type === "session.activity")).toBe(false);
    const delta = projector.project(deltaEvent("part_text", "!", {}, "evt_no_activity_delta"));
    expect(delta).toHaveLength(1);
    expect(delta.some((event) => event.type === "session.activity")).toBe(false);
  });
});

describe("message.part.delta", () => {
  it("maps text deltas and attaches the learned part type", () => {
    const projector = new EventProjector();
    projector.project(partEvent(textPart("hello"), "evt_text_before_delta"));
    const event = projector.project(deltaEvent("part_text", " world", {}, "evt_delta_ok"))[0];
    expect(event).toEqual({
      type: "message.part.delta",
      sessionID: "ses_1",
      messageID: "msg_1",
      partID: "part_text",
      field: "text",
      delta: " world",
      partType: "text",
    });
  });

  it("drops non-text fields and empty deltas without activity", () => {
    const projector = new EventProjector();
    expect(
      projector.project(deltaEvent("part_text", "x", { field: "reasoning" }, "evt_field")),
    ).toEqual([]);
    expect(projector.project(deltaEvent("part_text", "", {}, "evt_empty"))).toEqual([]);
  });

  it("falls back to activity for missing identity", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_delta_bad",
        type: "message.part.delta",
        properties: { sessionID: "ses_1", field: "text", delta: "x" },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_1", cause: "unknown" }]);
  });

  it("drops oversized deltas with one warning per session", () => {
    const projector = new EventProjector();
    const oversized = "x".repeat(MAX_DELTA_BYTES + 1);
    const first = projector.project(deltaEvent("part_text", oversized, {}, "evt_big_delta"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: "stream.warning",
      code: "delta_too_large",
      sessionID: "ses_1",
    });
    expect(projector.project(deltaEvent("part_text", oversized, {}, "evt_big_delta_2"))).toEqual(
      [],
    );
    const otherSession = projector.project(
      deltaEvent("part_text", oversized, { sessionID: "ses_2" }, "evt_big_delta_3"),
    );
    expect(otherSession).toHaveLength(1);
    expect(otherSession[0]).toMatchObject({ code: "delta_too_large", sessionID: "ses_2" });
  });
});

describe("snapshot policy", () => {
  it("forwards the first snapshot and completion after deltas", () => {
    const projector = new EventProjector();
    expect(projector.project(deltaEvent("part_t", "a", {}, "evt_sd_1"))).toHaveLength(1);
    expect(projector.project(partEvent(textPart("a", { id: "part_t" }), "evt_sd_2"))).toHaveLength(
      1,
    );
    expect(projector.project(partEvent(textPart("ab", { id: "part_t" }), "evt_sd_3"))).toEqual([]);
    const completion = projector.project(
      partEvent(textPart("abc", { id: "part_t", time: { start: 1, end: 2 } }), "evt_sd_4"),
    );
    expect(completion).toHaveLength(1);
  });

  it("throttles snapshot-only growth and always forwards completion", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const projector = new EventProjector();
      expect(
        projector.project(partEvent(textPart("a", { id: "part_t2" }), "evt_th_1")),
      ).toHaveLength(1);
      expect(projector.project(partEvent(textPart("ab", { id: "part_t2" }), "evt_th_2"))).toEqual(
        [],
      );
      now.mockReturnValue(1_200);
      expect(
        projector.project(partEvent(textPart("abcd", { id: "part_t2" }), "evt_th_3")),
      ).toHaveLength(1);
      expect(
        projector.project(
          partEvent(textPart("abcde", { id: "part_t2", time: { start: 1, end: 2 } }), "evt_th_4"),
        ),
      ).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("forwards status changes and throttles running snapshots", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const projector = new EventProjector();
      const pending = toolPart({ state: { status: "pending", input: {} } });
      const running = toolPart();
      const runningAgain = toolPart({ state: { ...running.state, metadata: { output: "more" } } });
      const completed = toolPart({
        state: { status: "completed", input: {}, output: "done", metadata: {}, time: {} },
      });
      expect(projector.project(partEvent(pending, "evt_snap_1"))).toHaveLength(1);
      expect(projector.project(partEvent(running, "evt_snap_2"))).toHaveLength(1);
      expect(projector.project(partEvent(runningAgain, "evt_snap_3"))).toEqual([]);
      expect(projector.project(partEvent(completed, "evt_snap_4"))).toHaveLength(1);
      const errored = toolPart({
        state: { status: "error", input: {}, error: "boom", metadata: {} },
      });
      expect(projector.project(partEvent(errored, "evt_snap_5"))).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("omits text snapshots over the text cap", () => {
    const projector = new EventProjector();
    expect(
      projector.project(
        partEvent(textPart("x".repeat(MAX_TEXT_SNAPSHOT_BYTES + 1)), "evt_text_cap"),
      ),
    ).toEqual([]);
  });
});

describe("session.status and session.idle", () => {
  it("rebuilds and bounds the status, and emits compatibility activity", () => {
    const projector = new EventProjector();
    const events = projector.project({
      id: "evt_status",
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: {
          type: "retry",
          attempt: 2,
          next: 3_000,
          message: "m".repeat(MAX_STATUS_MESSAGE + 100),
          action: { command: "x".repeat(MAX_STATUS_ACTION_BYTES) },
          ignored: "nope",
        },
      },
    });
    expect(events).toHaveLength(2);
    const event = events[0];
    expect(event?.type).toBe("session.status");
    if (event?.type !== "session.status") return;
    expect(event.status).toEqual({
      type: "retry",
      attempt: 2,
      next: 3_000,
      message: "m".repeat(MAX_STATUS_MESSAGE),
    });
    expect(event.truncated?.fields).toEqual(
      expect.arrayContaining(["status.message", "status.action"]),
    );
    expect(event.truncated?.omittedBytes).toBeGreaterThan(0);
    expect(events[1]).toEqual({
      type: "session.activity",
      sessionID: "ses_1",
      cause: "status",
    });
  });

  it("keeps a bounded action when it fits", () => {
    const projector = new EventProjector();
    const action = { command: "ls" };
    const event = projector.project({
      id: "evt_status_action",
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy", action } },
    })[0];
    expect(event?.type).toBe("session.status");
    if (event?.type !== "session.status") return;
    expect(event.status.action).toEqual(action);
    expect(event.truncated).toBeUndefined();
  });

  it("falls back to activity for an invalid status", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_status_bad",
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "unknown" } },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_1", cause: "unknown" }]);
  });

  it("normalizes idle and suppresses consecutive duplicates", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_idle_1",
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
    ).toEqual([
      { type: "session.status", sessionID: "ses_1", status: { type: "idle" } },
      { type: "session.activity", sessionID: "ses_1", cause: "status" },
    ]);
    expect(
      projector.project({
        id: "evt_idle_2",
        type: "session.idle",
        properties: { sessionID: "ses_1" },
      }),
    ).toEqual([]);
    projector.project({
      id: "evt_busy_again",
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    });
    const again = projector.project({
      id: "evt_idle_3",
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    });
    expect(again[0]).toEqual({
      type: "session.status",
      sessionID: "ses_1",
      status: { type: "idle" },
    });
  });
});

describe("session.error", () => {
  function errorEvent(
    id: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id,
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "UnknownError", data: { message } },
        ...extra,
      },
    };
  }

  it("projects the session, name, and first message line", () => {
    const projector = new EventProjector();
    const events = projector.project(
      errorEvent("evt_error", "Model not found: deepseek/deepseek_flash\n    at foo"),
    );
    expect(events).toEqual([
      {
        type: "session.error",
        sessionID: "ses_1",
        name: "UnknownError",
        message: "Model not found: deepseek/deepseek_flash",
      },
    ]);
  });

  it("suppresses a stack-trace variant with the same first line", () => {
    const projector = new EventProjector();
    const first = projector.project(errorEvent("evt_error_1", "Model not found: deepseek/flash"));
    expect(first).toHaveLength(1);
    const stack = projector.project(
      errorEvent("evt_error_2", "Model not found: deepseek/flash\n    at Provider.init (/x.js:1)"),
    );
    expect(stack).toEqual([]);
  });

  it("suppresses a prefixed variant of the same error", () => {
    const projector = new EventProjector();
    const first = projector.project(errorEvent("evt_error_1", "Model not found: deepseek/flash"));
    expect(first).toEqual([
      {
        type: "session.error",
        sessionID: "ses_1",
        name: "UnknownError",
        message: "Model not found: deepseek/flash",
      },
    ]);
    const prefixed = projector.project(
      errorEvent(
        "evt_error_2",
        "ProviderModelNotFoundError: Model not found: deepseek/flash\n    at getModel (/x.js:1)",
      ),
    );
    expect(prefixed).toEqual([]);
  });

  it("resets dedupe on a new busy attempt", () => {
    const projector = new EventProjector();
    projector.project(errorEvent("evt_error_1", "Model not found: deepseek/flash"));
    projector.project({
      id: "evt_busy",
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "busy" } },
    });
    const repeated = projector.project(
      errorEvent("evt_error_2", "Model not found: deepseek/flash"),
    );
    expect(repeated).toEqual([
      {
        type: "session.error",
        sessionID: "ses_1",
        name: "UnknownError",
        message: "Model not found: deepseek/flash",
      },
    ]);
  });

  it("falls back to a bounded activity when the direct session id is missing", () => {
    const projector = new EventProjector();
    const events = projector.project({
      id: "evt_error_no_session",
      type: "session.error",
      properties: {
        info: { id: "ses_2" },
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    });
    expect(events).toEqual([{ type: "session.activity", sessionID: "ses_2", cause: "unknown" }]);
  });

  it("bounds an oversized message and stays under the typed event budget", () => {
    const projector = new EventProjector();
    const events = projector.project(
      errorEvent("evt_error_big", "x".repeat(MAX_STATUS_MESSAGE + 500)),
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("session.error");
    if (event?.type !== "session.error") return;
    expect(event.message.length).toBeLessThanOrEqual(MAX_STATUS_MESSAGE);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_TYPED_EVENT_BYTES);
  });
});

describe("session.activity", () => {
  it.each([
    [
      "session.status",
      { sessionID: "ses_status", status: { type: "not-a-status" } },
      "ses_status",
      "unknown",
    ],
    ["message.updated", { info: { sessionID: "ses_message" } }, "ses_message", "unknown"],
    ["message.part.updated", { part: { sessionID: "ses_part" } }, "ses_part", "unknown"],
    ["session.updated", { info: { id: "ses_updated" } }, "ses_updated", "unknown"],
    ["message.part.removed", { part: { sessionID: "ses_removed" } }, "ses_removed", "removed"],
    ["message.removed", { sessionID: "ses_removed_direct" }, "ses_removed_direct", "removed"],
  ])("extracts the session id and cause from %s", (type, properties, expected, cause) => {
    const projector = new EventProjector();
    const event = projector.project({ id: `evt_${type}`, type, properties })[0];
    expect(event).toEqual({ type: "session.activity", sessionID: expected, cause });
  });

  it("emits activity for unknown events with a session id and drops others", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_unknown",
        type: "something.new",
        properties: { sessionID: "ses_unknown" },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_unknown", cause: "unknown" }]);
    expect(projector.project({ id: "evt_none", type: "something.new", properties: {} })).toEqual(
      [],
    );
  });
});

describe("prompt and todo event budgets", () => {
  it("keeps a question under the budget intact", () => {
    const projector = new EventProjector();
    const event = projector.project(v1Question())[0];
    expect(event?.type).toBe("question.asked");
    if (event?.type !== "question.asked") return;
    expect(event.request.questions).toHaveLength(1);
    expect(event.request.tooLarge).toBe(false);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_TYPED_EVENT_BYTES);
  });

  it("collapses an over-budget question to a bounded summary", () => {
    const projector = new EventProjector();
    const event = projector.project({
      id: "evt_big_question",
      type: "question.asked",
      properties: {
        id: "que_big",
        sessionID: "ses_1",
        tool: { messageID: "msg_1", callID: "call_1" },
        questions: [
          {
            header: "HUGE",
            question: "q".repeat(270 * 1024),
            options: [],
          },
        ],
      },
    })[0];
    expect(event?.type).toBe("question.asked");
    if (event?.type !== "question.asked") return;
    expect(event.request.tooLarge).toBe(true);
    expect(event.request.questions).toEqual([]);
    expect(event.request.tool).toEqual({ messageID: "msg_1", callID: "call_1" });
    expect(event.request.summary?.startsWith("HUGE")).toBe(true);
    expect((event.request.summary ?? "").length).toBeLessThanOrEqual(500);
    expect((event.request.tooLargeReason ?? "").length).toBeLessThanOrEqual(200);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_TYPED_EVENT_BYTES);
  });

  it("keeps a large but under-budget question answerable", () => {
    const projector = new EventProjector();
    const event = projector.project({
      id: "evt_large_question",
      type: "question.asked",
      properties: {
        id: "que_large",
        sessionID: "ses_1",
        questions: [{ header: "H", question: "q".repeat(200 * 1024), options: [] }],
      },
    })[0];
    expect(event?.type).toBe("question.asked");
    if (event?.type !== "question.asked") return;
    expect(event.request.questions).toHaveLength(1);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_TYPED_EVENT_BYTES);
  });

  it("collapses an over-budget permission to a deny-only summary", () => {
    const projector = new EventProjector();
    const event = projector.project({
      id: "evt_big_permission",
      type: "permission.asked",
      properties: {
        id: "per_big",
        sessionID: "ses_1",
        permission: "bash",
        patterns: ["p".repeat(270 * 1024)],
        always: ["a".repeat(270 * 1024)],
        metadata: { command: "x".repeat(270 * 1024) },
        tool: { type: "tool", messageID: "msg_1", callID: "call_1" },
      },
    })[0];
    expect(event?.type).toBe("permission.asked");
    if (event?.type !== "permission.asked") return;
    expect(event.request.tooLarge).toBe(true);
    expect(event.request.permission).toBe("bash");
    expect(event.request.patterns).toEqual([]);
    expect(event.request.always).toEqual([]);
    expect(event.request.metadata).toEqual({});
    expect(event.request.summary?.startsWith("bash")).toBe(true);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_TYPED_EVENT_BYTES);
  });

  it("drops trailing todos until an over-budget event fits", () => {
    const projector = new EventProjector();
    const todos = Array.from({ length: 200 }, (_, index) => ({
      content: `${index}:${"x".repeat(7_000)}`,
      status: "pending",
      priority: "low",
    }));
    const event = projector.project({
      id: "evt_big_todos",
      type: "todo.updated",
      properties: { sessionID: "ses_1", todos },
    })[0];
    expect(event?.type).toBe("todo.updated");
    if (event?.type !== "todo.updated") return;
    expect(event.truncated).toBe(true);
    expect(event.todos.length).toBeGreaterThan(0);
    expect(event.todos.length).toBeLessThan(200);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_TYPED_EVENT_BYTES);
  });
});

describe("diff event normalization and budget", () => {
  it("keeps cap-sized diff, content, and patch inputs and clips over-cap heads", () => {
    const exact = "a".repeat(MAX_DIFF_BYTES);
    const edit = projectPart(
      diffPart("edit", { status: "completed", input: {}, metadata: { diff: exact } }),
    );
    expect((partOf(edit).state as Record<string, unknown>).metadata).toMatchObject({ diff: exact });
    expect(edit?.type === "message.part.updated" ? edit.truncated : undefined).toBeUndefined();

    const content = "c".repeat(MAX_WRITE_CONTENT_BYTES);
    const write = projectPart(
      diffPart("write", {
        status: "completed",
        input: { filePath: "src/a.ts", content },
        metadata: {},
      }),
    );
    expect(
      ((partOf(write).state as Record<string, unknown>).input as Record<string, unknown>).content,
    ).toBe(content);
    expect(write?.type === "message.part.updated" ? write.truncated : undefined).toBeUndefined();

    const patchText = "p".repeat(MAX_DIFF_BYTES);
    const running = projectPart(
      diffPart("apply_patch", {
        status: "running",
        input: { patchText },
        metadata: {},
      }),
    );
    expect(
      ((partOf(running).state as Record<string, unknown>).input as Record<string, unknown>)
        .patchText,
    ).toBe(patchText);
    expect(
      running?.type === "message.part.updated" ? running.truncated : undefined,
    ).toBeUndefined();

    const over = projectPart(
      diffPart("edit", {
        status: "completed",
        input: {},
        metadata: { diff: "x".repeat(MAX_DIFF_BYTES + 100) },
      }),
    );
    const overState = partOf(over).state as Record<string, unknown>;
    const overMetadata = overState.metadata as Record<string, unknown>;
    expect(Buffer.byteLength(overMetadata.diff as string, "utf8")).toBe(MAX_DIFF_BYTES);
    expect(over?.type === "message.part.updated" ? over.truncated?.fields : []).toContain(
      "state.metadata.diff",
    );
    expect(over?.type === "message.part.updated" ? over.truncated?.limit : undefined).toBe(
      "per-file",
    );
  });

  it("drops the combined apply_patch diff when every file has a patch", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+one\n";
    const event = projectPart(
      diffPart("apply_patch", {
        status: "completed",
        input: { patchText: "*** Begin Patch" },
        metadata: {
          diff: "combined-diff",
          files: [fileRecord(0, patch), fileRecord(1, patch)],
        },
      }),
    );
    const state = partOf(event).state as Record<string, unknown>;
    const metadata = state.metadata as Record<string, unknown>;
    const files = metadata.files as Array<Record<string, unknown>>;
    expect(metadata.diff).toBeUndefined();
    expect((state.input as Record<string, unknown>).patchText).toBeUndefined();
    expect(files.map((file) => file.patch)).toEqual([patch, patch]);
  });

  it("drops the duplicate edit sources and unrendered input", () => {
    const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const event = projectPart(
      diffPart("edit", {
        status: "completed",
        input: {
          filePath: "a.ts",
          oldString: "old",
          newString: "new",
          replaceAll: true,
          edits: Array.from({ length: 200 }, () => "e".repeat(8_000)),
        },
        metadata: {
          diff: "legacy-diff",
          filediff: {
            file: "a.ts",
            patch,
            before: "b".repeat(64 * 1024),
            after: "a".repeat(64 * 1024),
            additions: 1,
            deletions: 1,
          },
        },
      }),
    );
    const state = partOf(event).state as Record<string, unknown>;
    const metadata = state.metadata as Record<string, unknown>;
    const filediff = metadata.filediff as Record<string, unknown>;
    const input = state.input as Record<string, unknown>;
    expect(metadata.diff).toBeUndefined();
    expect(filediff.patch).toBe(patch);
    expect(filediff.before).toBeUndefined();
    expect(filediff.after).toBeUndefined();
    expect(filediff.additions).toBe(1);
    expect(input.oldString).toBeUndefined();
    expect(input.newString).toBeUndefined();
    expect(input.replaceAll).toBeUndefined();
    expect(input.edits).toBeUndefined();
  });

  it("drops whole trailing file records over the 128 KiB sum", () => {
    const patch = "a".repeat(MAX_DIFF_BYTES);
    const event = projectPart(
      diffPart("apply_patch", {
        status: "completed",
        input: {},
        metadata: { files: [0, 1, 2].map((index) => fileRecord(index, patch)) },
      }),
    );
    const state = partOf(event).state as Record<string, unknown>;
    const files = (state.metadata as Record<string, unknown>).files as Array<
      Record<string, unknown>
    >;
    expect(files).toHaveLength(2);
    expect(
      files.every((file) => Buffer.byteLength(file.patch as string, "utf8") === MAX_DIFF_BYTES),
    ).toBe(true);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_PART_EVENT_BYTES);
    expect(event?.type === "message.part.updated" ? event.truncated?.limit : undefined).toBe(
      "total",
    );
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toContain(
      "state.metadata.files.length",
    );
  });

  it("keeps 50 of 200 files and does not omit the event", () => {
    const files = Array.from({ length: 200 }, (_, index) => fileRecord(index, "+x\n"));
    const event = projectPart(
      diffPart("apply_patch", {
        status: "completed",
        input: {},
        metadata: { files },
      }),
    );
    expect(event?.type).toBe("message.part.updated");
    const state = partOf(event).state as Record<string, unknown>;
    const kept = (state.metadata as Record<string, unknown>).files as unknown[];
    expect(kept).toHaveLength(MAX_DIFF_FILES);
    expect(event?.type === "message.part.updated" ? event.truncated?.limit : undefined).toBe(
      "files",
    );
  });

  it("caps adversarial paths and the total path budget without omitting", () => {
    const longPath = "p".repeat(5_000);
    const files = Array.from({ length: MAX_DIFF_FILES }, (_, index) =>
      fileRecord(index, "+x\n", longPath),
    );
    const event = projectPart(
      diffPart("apply_patch", {
        status: "completed",
        input: {},
        metadata: { files },
      }),
    );
    expect(event?.type).toBe("message.part.updated");
    const state = partOf(event).state as Record<string, unknown>;
    const kept = (state.metadata as Record<string, unknown>).files as Array<
      Record<string, unknown>
    >;
    const pathBytes = kept.reduce(
      (total, file) =>
        total +
        ["relativePath", "movePath", "filePath"].reduce(
          (inner, key) =>
            inner + (typeof file[key] === "string" ? Buffer.byteLength(file[key], "utf8") : 0),
          0,
        ),
      0,
    );
    expect(pathBytes).toBeLessThanOrEqual(MAX_DIFF_PATH_TOTAL_BYTES);
    expect(
      kept.every((file) =>
        ["relativePath", "movePath", "filePath"].every(
          (key) =>
            typeof file[key] !== "string" ||
            Buffer.byteLength(file[key], "utf8") <= MAX_DIFF_PATH_BYTES,
        ),
      ),
    ).toBe(true);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_PART_EVENT_BYTES);
    expect(
      event?.type === "message.part.updated" ? event.truncated?.fields.length : 0,
    ).toBeLessThanOrEqual(MAX_TRUNCATED_FIELDS);
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toContain("more");
  });

  it("drops unrendered diagnostics but keeps rendered metadata", () => {
    const event = projectPart(
      diffPart("edit", {
        status: "completed",
        input: { filePath: "a.ts" },
        metadata: {
          filepath: "a.ts",
          exists: false,
          diagnostics: "d".repeat(200 * 1024),
          other: { nested: "x".repeat(50 * 1024) },
          diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
          filediff: { file: "a.ts", additions: 4, deletions: 2 },
        },
      }),
    );
    const metadata = (partOf(event).state as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect(metadata.diagnostics).toBeUndefined();
    expect(metadata.other).toBeUndefined();
    expect(metadata.filepath).toBe("a.ts");
    expect(metadata.exists).toBe(false);
    expect((metadata.filediff as Record<string, unknown>).additions).toBe(4);
    expect((metadata.filediff as Record<string, unknown>).deletions).toBe(2);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_PART_EVENT_BYTES);
  });

  it("drops 200 hashline edits and keeps the diff", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const event = projectPart(
      diffPart("edit", {
        status: "completed",
        input: {
          filePath: "a.ts",
          rename: "b.ts",
          delete: false,
          replaceAll: true,
          edits: Array.from({ length: 200 }, () => "e".repeat(8_000)),
        },
        metadata: { diff },
      }),
    );
    const state = partOf(event).state as Record<string, unknown>;
    const input = state.input as Record<string, unknown>;
    expect((state.metadata as Record<string, unknown>).diff).toBe(diff);
    expect(input.edits).toBeUndefined();
    expect(input.replaceAll).toBeUndefined();
    expect(input.rename).toBe("b.ts");
    expect(input.delete).toBe(false);
    expect(bytes(event)).toBeLessThanOrEqual(MAX_PART_EVENT_BYTES);
  });

  it("caps truncated.fields at 32 entries including more", () => {
    const longPath = "q".repeat(5_000);
    const files = Array.from({ length: MAX_DIFF_FILES }, (_, index) =>
      fileRecord(index, "+x\n", longPath),
    );
    const event = projectPart(
      diffPart("apply_patch", {
        status: "completed",
        input: {},
        metadata: { files },
      }),
    );
    const truncated = event?.type === "message.part.updated" ? event.truncated : undefined;
    expect(truncated?.fields.length).toBeLessThanOrEqual(MAX_TRUNCATED_FIELDS);
    expect(truncated?.fields.at(-1)).toBe("more");
    expect(truncated?.omittedBytes).toBeGreaterThan(0);
  });

  it("collapses the field list to more when even one long field cannot fit", () => {
    const key = "k".repeat(MAX_TRUNCATED_FIELD_BYTES + 100);
    const event = projectPart(
      toolPart({
        state: {
          status: "running",
          input: { [key]: "v".repeat(MAX_PART_STRING_BYTES + 100) },
          metadata: {},
        },
      }),
    );
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : undefined).toEqual([
      "more",
    ]);
  });

  it("keeps 50 combined-diff file headers and caps the combined text at 128 KiB", () => {
    const files = Array.from({ length: 60 }, (_, index) => ({
      type: "update",
      relativePath: `file-${index}.ts`,
      additions: index,
      deletions: 0,
    }));
    const combined = projectPart(
      diffPart("apply_patch", {
        status: "completed",
        input: {},
        metadata: { diff: "combined", files },
      }),
    );
    const combinedMetadata = (partOf(combined).state as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect((combinedMetadata.files as unknown[]).length).toBe(MAX_DIFF_FILES);
    expect(combinedMetadata.diff).toBe("combined");
    expect(combined?.type === "message.part.updated" ? combined.truncated?.limit : undefined).toBe(
      "files",
    );

    const tooLarge = "d".repeat(MAX_DIFF_EVENT_BYTES + 1_000);
    const clipped = projectPart(
      diffPart("apply_patch", {
        status: "completed",
        input: {},
        metadata: { diff: tooLarge },
      }),
    );
    const clippedMetadata = (partOf(clipped).state as Record<string, unknown>).metadata as Record<
      string,
      unknown
    >;
    expect(Buffer.byteLength(clippedMetadata.diff as string, "utf8")).toBe(MAX_DIFF_EVENT_BYTES);
    expect(clipped?.type === "message.part.updated" ? clipped.truncated?.limit : undefined).toBe(
      "total",
    );
    expect(bytes(clipped)).toBeLessThanOrEqual(MAX_PART_EVENT_BYTES);
  });

  it("drops output before omitting an otherwise representable diff event", () => {
    const patch = "a".repeat(MAX_DIFF_BYTES);
    const event = projectPart(
      diffPart(
        "apply_patch",
        {
          status: "completed",
          input: {},
          output: "o".repeat(MAX_TOOL_OUTPUT_BYTES),
          metadata: { files: [fileRecord(0, patch), fileRecord(1, patch)] },
        },
        { text: "t".repeat(MAX_TEXT_SNAPSHOT_BYTES) },
      ),
    );
    expect(event?.type).toBe("message.part.updated");
    const state = partOf(event).state as Record<string, unknown>;
    expect(state.output).toBeUndefined();
    expect(event?.type === "message.part.updated" ? event.truncated?.limit : undefined).toBe(
      "output",
    );
    expect(event?.type === "message.part.updated" ? event.truncated?.fields : []).toContain(
      "state.output",
    );
    expect(bytes(event)).toBeLessThanOrEqual(MAX_PART_EVENT_BYTES);
  });

  it("still emits message.part.omitted for an unrepresentable diff payload", () => {
    const event = projectPart(
      diffPart(
        "apply_patch",
        {
          status: "completed",
          input: {},
          output: "o".repeat(MAX_TOOL_OUTPUT_BYTES),
          metadata: { diff: "d".repeat(MAX_DIFF_EVENT_BYTES) },
        },
        {
          text: "t".repeat(MAX_TEXT_SNAPSHOT_BYTES),
          patch: "p".repeat(MAX_PATCH_BYTES),
        },
      ),
    );
    expect(event?.type).toBe("message.part.omitted");
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
    expect(events).toContainEqual({
      type: "session.activity",
      sessionID: "ses_x",
      cause: "unknown",
    });
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
    expect(events[0]).toMatchObject({
      type: "stream.warning",
      code: "frame_too_large",
      message: "dropped an SSE frame larger than 1024 bytes",
    });
    expect(events.some((event) => event.type === "question.asked")).toBe(true);
  });

  it("salvages identity from an oversized frame and emits message.part.omitted", async () => {
    const oversized = {
      id: "evt_omitted",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_big",
        part: {
          id: "part_big",
          type: "tool",
          sessionID: "ses_big",
          messageID: "msg_big",
          state: { status: "running", metadata: { output: "x".repeat(4_096) } },
        },
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseEvent(oversized)));
        controller.close();
      },
    });
    const events = await collect(createEventStream(body, { maxFrameBytes: 512 }).events);
    expect(events).toEqual([
      {
        type: "message.part.omitted",
        sessionID: "ses_big",
        messageID: "msg_big",
        partID: "part_big",
        reason: "too_large",
      },
      {
        type: "stream.warning",
        code: "frame_too_large",
        message: "dropped an SSE frame larger than 512 bytes",
        sessionID: "ses_big",
      },
    ]);
  });

  it("dedupes oversized warnings by code and session id", async () => {
    const makeFrame = (sessionID: string) =>
      frame(
        JSON.stringify({
          type: "unknown",
          properties: { sessionID, padding: "x".repeat(1_024) },
        }),
      );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(makeFrame("ses_a") + makeFrame("ses_a")));
        controller.enqueue(encoder.encode(makeFrame("ses_b")));
        controller.close();
      },
    });
    const events = await collect(createEventStream(body, { maxFrameBytes: 256 }).events);
    const warnings = events.filter((event) => event.type === "stream.warning");
    expect(warnings).toHaveLength(2);
    expect(warnings.map((event) => event.type === "stream.warning" && event.sessionID)).toEqual([
      "ses_a",
      "ses_b",
    ]);
  });

  it("emits one warning without a session id when identity cannot be salvaged", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame("x".repeat(1_024))));
        controller.enqueue(encoder.encode(frame("y".repeat(1_024))));
        controller.close();
      },
    });
    const events = await collect(createEventStream(body, { maxFrameBytes: 256 }).events);
    expect(events).toEqual([
      {
        type: "stream.warning",
        code: "frame_too_large",
        message: "dropped an SSE frame larger than 256 bytes",
      },
    ]);
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

describe("message.updated usage mode", () => {
  const usageInfo = {
    id: "msg_usage",
    role: "assistant",
    sessionID: "ses_1",
    providerID: "deepseek",
    modelID: "deepseek-flash",
    summary: true,
    tokens: {
      input: 12_345,
      output: 678,
      reasoning: 90,
      cache: { read: 1_000, write: 250 },
    },
  };

  it("adds the exact bounded usage, model, and summary fields", () => {
    const projector = new EventProjector({ includeUsage: true });
    const events = projector.project({
      id: "evt_usage",
      type: "message.updated",
      properties: { sessionID: "ses_1", info: usageInfo },
    });
    expect(events[0]).toEqual({
      type: "message.updated",
      sessionID: "ses_1",
      messageID: "msg_usage",
      role: "assistant",
      usage: {
        input: 12_345,
        output: 678,
        reasoning: 90,
        cacheRead: 1_000,
        cacheWrite: 250,
      },
      model: { providerID: "deepseek", modelID: "deepseek-flash" },
      summary: true,
    });
    expect(events[1]).toEqual({
      type: "session.activity",
      sessionID: "ses_1",
      cause: "message",
    });
  });

  it("omits usage, model, and summary in the default mode", () => {
    const projector = new EventProjector();
    const event = projector.project({
      id: "evt_usage_default",
      type: "message.updated",
      properties: { sessionID: "ses_1", info: usageInfo },
    })[0];
    expect(event).toEqual({
      type: "message.updated",
      sessionID: "ses_1",
      messageID: "msg_usage",
      role: "assistant",
    });
    expect(event).not.toHaveProperty("usage");
    expect(event).not.toHaveProperty("model");
    expect(event).not.toHaveProperty("summary");
  });

  it("omits malformed usage and model fields while keeping valid ones", () => {
    const projector = new EventProjector({ includeUsage: true });
    const event = projector.project({
      id: "evt_usage_bad",
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_bad",
          role: "assistant",
          sessionID: "ses_1",
          providerID: 42,
          modelID: "",
          summary: "yes",
          tokens: {
            input: "12",
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    })[0];
    expect(event).toEqual({
      type: "message.updated",
      sessionID: "ses_1",
      messageID: "msg_bad",
      role: "assistant",
    });
  });

  it("omits negative or non-finite token counts", () => {
    const projector = new EventProjector({ includeUsage: true });
    const event = projector.project({
      id: "evt_usage_negative",
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_neg",
          role: "assistant",
          sessionID: "ses_1",
          providerID: "deepseek",
          modelID: "deepseek-flash",
          tokens: {
            input: -1,
            output: Number.POSITIVE_INFINITY,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
      },
    })[0];
    expect(event).not.toHaveProperty("usage");
    expect(event).toMatchObject({
      model: { providerID: "deepseek", modelID: "deepseek-flash" },
    });
  });

  it("bounds the model identifiers", () => {
    const projector = new EventProjector({ includeUsage: true });
    const event = projector.project({
      id: "evt_usage_long_model",
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "msg_long",
          role: "assistant",
          sessionID: "ses_1",
          providerID: "p".repeat(300),
          modelID: "m".repeat(300),
        },
      },
    })[0];
    expect(event).toMatchObject({
      model: { providerID: "p".repeat(200), modelID: "m".repeat(200) },
    });
  });

  it("is threaded through createEventStream when requested", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent({
              id: "evt_usage_stream",
              type: "message.updated",
              properties: { sessionID: "ses_1", info: usageInfo },
            }),
          ),
        );
        controller.close();
      },
    });
    const events = await collect(createEventStream(body, { includeUsage: true }).events);
    expect(events[0]).toMatchObject({
      type: "message.updated",
      usage: {
        input: 12_345,
        output: 678,
        reasoning: 90,
        cacheRead: 1_000,
        cacheWrite: 250,
      },
      model: { providerID: "deepseek", modelID: "deepseek-flash" },
      summary: true,
    });
  });
});

describe("session.compacted", () => {
  it("projects the compacted event with a status activity and dedupes by envelope id", () => {
    const projector = new EventProjector();
    const raw = {
      id: "evt_compacted",
      type: "session.compacted",
      properties: { sessionID: "ses_1" },
    };
    expect(projector.project(raw)).toEqual([
      { type: "session.compacted", sessionID: "ses_1" },
      { type: "session.activity", sessionID: "ses_1", cause: "status" },
    ]);
    expect(projector.project(raw)).toEqual([]);
  });

  it("accepts info.sessionID as the session id", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_compacted_info",
        type: "session.compacted",
        properties: { info: { sessionID: "ses_info" } },
      }),
    ).toEqual([
      { type: "session.compacted", sessionID: "ses_info" },
      { type: "session.activity", sessionID: "ses_info", cause: "status" },
    ]);
  });

  it("falls back to an unknown-cause activity when sessionID is missing", () => {
    const projector = new EventProjector();
    expect(
      projector.project({
        id: "evt_compacted_fallback",
        type: "session.compacted",
        properties: { info: { id: "ses_fallback" } },
      }),
    ).toEqual([{ type: "session.activity", sessionID: "ses_fallback", cause: "unknown" }]);
    expect(
      projector.project({
        id: "evt_compacted_none",
        type: "session.compacted",
        properties: {},
      }),
    ).toEqual([]);
  });
});
