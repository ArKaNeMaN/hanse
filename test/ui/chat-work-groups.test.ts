import { describe, expect, it } from "vitest";
import type { AttachmentView } from "../../assets/chat-core.js";
import { threadItemKey } from "../../ui/chat/notice-groups.js";
import type {
  ChatHandoffView,
  ChatMessagePartView,
  ChatMessageView,
  ChatThreadItem,
  ChatWorkGroupView,
} from "../../ui/chat/types.js";
import { buildWorkTimeline } from "../../ui/chat/work-groups.js";
import { message, part } from "./chat-render-support.js";

function reasoning(id: string): ChatMessagePartView {
  return part({ id, type: "reasoning", text: id, data: { text: id } });
}

function tool(id: string, status = "completed"): ChatMessagePartView {
  return part({ id, type: "tool", status, data: { tool: "bash", state: { status } } });
}

function question(id: string): ChatMessagePartView {
  return part({
    id,
    type: "tool",
    status: "completed",
    data: { tool: "question", state: { status: "completed" } },
  });
}

function text(id: string, value = id): ChatMessagePartView {
  return part({ id, type: "text", text: value, data: { text: value } });
}

function file(id: string): ChatMessagePartView {
  return part({ id, type: "file", data: { filename: `${id}.png`, mime: "image/png" } });
}

function subtask(id: string): ChatMessagePartView {
  return part({ id, type: "subtask", data: { description: id } });
}

function assistant(
  id: string,
  parts: ChatMessagePartView[],
  extra: Partial<ChatMessageView> = {},
): ChatMessageView {
  return message({ id, role: "assistant", parts, ...extra });
}

function messageItem(message: ChatMessageView): ChatThreadItem {
  return { type: "message", message };
}

function groupOf(item: ChatThreadItem | undefined): ChatWorkGroupView {
  if (item?.type !== "work-group") throw new Error("expected work-group");
  return item.group;
}

function messageOf(item: ChatThreadItem | undefined): ChatMessageView {
  if (item?.type !== "message") throw new Error("expected message");
  return item.message;
}

function attachment(): AttachmentView {
  return {
    id: "att-1",
    name: "shot.png",
    mime: "image/png",
    size: 1234,
    kind: "image",
    mode: "inline",
    state: "ready",
    downloadURL: "/attachments/att-1",
    inline: true,
  };
}

describe("buildWorkTimeline grouping", () => {
  it("groups reasoning and tools across assistant messages that continue the turn", () => {
    const first = assistant("m1", [reasoning("r1"), tool("t1")], {
      finish: "tool-calls",
      time: { created: 1 },
    });
    const second = assistant("m2", [tool("t2", "error")], { time: { created: 2, completed: 3 } });

    const result = buildWorkTimeline([messageItem(first), messageItem(second)]);

    expect(result).toHaveLength(1);
    const group = groupOf(result[0]);
    expect(group.id).toBe("work-group:r1");
    expect(group.parts.map((entry) => entry.id)).toEqual(["r1", "t1", "t2"]);
    expect(group.toolCount).toBe(2);
    expect(group.reasoningCount).toBe(1);
    expect(group.hasError).toBe(true);
    expect(group.metricsText).toBe("2 tool calls · 1 thought");
  });

  it("ignores hidden parts without splitting the run", () => {
    const item = assistant(
      "m1",
      [
        reasoning("r1"),
        part({ id: "step-start", type: "step-start" }),
        tool("t1"),
        part({ id: "step-finish", type: "step-finish" }),
        part({ id: "patch", type: "patch" }),
        reasoning("r2"),
      ],
      { finish: "stop", time: { completed: 1 } },
    );

    const result = buildWorkTimeline([messageItem(item)]);

    expect(result).toHaveLength(1);
    const group = groupOf(result[0]);
    expect(group.parts.map((entry) => entry.id)).toEqual(["r1", "t1", "r2"]);
    expect(group.toolCount).toBe(1);
    expect(group.reasoningCount).toBe(2);
  });

  it("splits the run at visible text and resumes after it", () => {
    const item = assistant("m1", [reasoning("r1"), text("hello"), reasoning("r2")], {
      finish: "stop",
      time: { completed: 1 },
    });

    const result = buildWorkTimeline([messageItem(item)]);

    expect(result.map((entry) => entry.type)).toEqual(["work-group", "message", "work-group"]);
    expect(groupOf(result[0]).parts.map((entry) => entry.id)).toEqual(["r1"]);
    expect(messageOf(result[1]).parts.map((entry) => entry.id)).toEqual(["hello"]);
    expect(groupOf(result[2]).parts.map((entry) => entry.id)).toEqual(["r2"]);
  });

  const boundaries: [string, ChatMessagePartView][] = [
    ["file", file("file1")],
    ["subtask", subtask("sub1")],
    ["question", question("q1")],
  ];

  it.each(boundaries)("treats a %s part as a visible boundary", (_label, boundary) => {
    const item = assistant("m1", [reasoning("r1"), boundary, reasoning("r2")], {
      finish: "stop",
      time: { completed: 1 },
    });

    const result = buildWorkTimeline([messageItem(item)]);

    expect(result.map((entry) => entry.type)).toEqual(["work-group", "message", "work-group"]);
    const boundaryMessage = messageOf(result[1]);
    expect(boundaryMessage.parts.map((entry) => entry.id)).toEqual([boundary.id]);
  });

  it("ends the run at operator messages and notice items", () => {
    const first = assistant("m1", [reasoning("r1")], { finish: "tool-calls" });
    const user = message({ id: "u1", role: "user", parts: [text("hi")] });
    const notice: ChatThreadItem = { type: "notice", notice: { id: "n1" } };
    const second = assistant("m2", [reasoning("r2")], { time: { completed: 2 } });

    const result = buildWorkTimeline([
      messageItem(first),
      messageItem(user),
      notice,
      messageItem(second),
    ]);

    expect(result.map((entry) => entry.type)).toEqual([
      "work-group",
      "message",
      "notice",
      "work-group",
    ]);
    expect(result[1]).toEqual(messageItem(user));
    expect(result[2]).toBe(notice);
  });

  it("ends the run when a completed assistant message finishes with stop", () => {
    const first = assistant("m1", [reasoning("r1")], { finish: "tool-calls" });
    const second = assistant("m2", [reasoning("r2")], {
      finish: "stop",
      time: { completed: 2 },
    });
    const third = assistant("m3", [reasoning("r3")], { finish: "tool-calls" });

    const result = buildWorkTimeline([messageItem(first), messageItem(second), messageItem(third)]);

    expect(result.map((entry) => entry.type)).toEqual(["work-group", "work-group"]);
    expect(groupOf(result[0]).parts.map((entry) => entry.id)).toEqual(["r1", "r2"]);
    expect(groupOf(result[1]).parts.map((entry) => entry.id)).toEqual(["r3"]);
  });

  it("does not split on an empty text part or a hidden synthetic text part", () => {
    const item = assistant(
      "m1",
      [
        reasoning("r1"),
        part({ id: "empty", type: "text", text: "", data: { text: "" } }),
        part({
          id: "synthetic",
          type: "text",
          text: "Called the Read tool with the following input: {}",
          data: {
            text: "Called the Read tool with the following input: {}",
            synthetic: true,
          },
        }),
        tool("t1"),
      ],
      { finish: "stop", time: { completed: 1 } },
    );

    const result = buildWorkTimeline([messageItem(item)]);

    expect(result).toHaveLength(1);
    expect(groupOf(result[0]).parts.map((entry) => entry.id)).toEqual(["r1", "t1"]);
  });

  it("slices a message with work and text, showing meta only on the first boundary", () => {
    const item = assistant("m1", [text("text1"), reasoning("r1"), text("text2")], {
      finish: "stop",
      time: { completed: 1 },
    });

    const result = buildWorkTimeline([messageItem(item)]);

    expect(result.map((entry) => entry.type)).toEqual(["message", "work-group", "message"]);
    const first = messageOf(result[0]);
    expect(first.parts.map((entry) => entry.id)).toEqual(["text1"]);
    expect(first.showMeta).toBeUndefined();
    expect(result[0]?.type === "message" ? result[0].sliceKey : undefined).toBe("text1");

    const second = messageOf(result[2]);
    expect(second.parts.map((entry) => entry.id)).toEqual(["text2"]);
    expect(second.showMeta).toBe(false);
    expect(result[2]?.type === "message" ? result[2].sliceKey : undefined).toBe("text2");

    expect(groupOf(result[1]).parts.map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("preserves message-level attachments when a message has only work parts", () => {
    const att = attachment();
    const item = assistant("m1", [reasoning("r1")], {
      finish: "stop",
      time: { completed: 1 },
      attachments: [att],
    });

    const result = buildWorkTimeline([messageItem(item)]);

    expect(result.map((entry) => entry.type)).toEqual(["work-group", "message"]);
    const attachmentSlice = result.find(
      (entry): entry is Extract<ChatThreadItem, { type: "message" }> => entry.type === "message",
    );
    if (attachmentSlice === undefined) throw new Error("missing attachment slice");
    expect(attachmentSlice.message.parts).toEqual([]);
    expect(attachmentSlice.message.attachments).toEqual([att]);
    expect(attachmentSlice.sliceKey).toBe("attachments");
    expect(groupOf(result[0]).parts.map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("keeps attachments on the first boundary slice without adding an empty slice", () => {
    const att = attachment();
    const item = assistant("m1", [text("hello"), reasoning("r1")], {
      finish: "stop",
      time: { completed: 1 },
      attachments: [att],
    });

    const result = buildWorkTimeline([messageItem(item)]);

    expect(result.map((entry) => entry.type)).toEqual(["message", "work-group"]);
    const first = messageOf(result[0]);
    expect(first.parts.map((entry) => entry.id)).toEqual(["hello"]);
    expect(first.attachments).toEqual([att]);
    expect(result.filter((entry) => entry.type === "message")).toHaveLength(1);
  });

  it("keeps an errored tool inside the group and marks the group as errored", () => {
    const item = assistant("m1", [tool("t1", "error")], {
      finish: "stop",
      time: { completed: 1 },
    });

    const group = groupOf(buildWorkTimeline([messageItem(item)])[0]);

    expect(group.toolCount).toBe(1);
    expect(group.reasoningCount).toBe(0);
    expect(group.hasError).toBe(true);
    expect(group.metricsText).toBe("1 tool call");
    expect(group.parts[0]?.id).toBe("t1");
  });

  it("treats OMO and handoff messages as boundaries and passes them through unchanged", () => {
    const handoff: ChatHandoffView = {
      id: "handoff-1",
      direction: "request",
      agent: "alpha",
      from: "alpha",
      to: "beta",
      summary: "Reconcile totals",
      body: "The totals disagree.",
      note: "",
    };
    const omoItem: ChatThreadItem = {
      type: "message",
      message: message({
        id: "omo",
        role: "assistant",
        omo: { kind: "system", tone: "neutral", title: "System reminder", body: "internal" },
        parts: [reasoning("r-omo")],
      }),
    };
    const handoffItem: ChatThreadItem = {
      type: "message",
      message: message({ id: "handoff", role: "user", handoff, parts: [text("h")] }),
    };

    const result = buildWorkTimeline([omoItem, handoffItem]);

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(omoItem);
    expect(result[1]).toBe(handoffItem);
  });

  it("never mutates the input array or its items", () => {
    const items: ChatThreadItem[] = [
      messageItem(assistant("m1", [reasoning("r1"), text("hello")], { finish: "tool-calls" })),
      messageItem(assistant("m2", [tool("t1")], { time: { completed: 2 } })),
    ];
    const snapshot = structuredClone(items);

    const result = buildWorkTimeline(items);

    expect(items).toEqual(snapshot);
    expect(result).not.toBe(items);
  });
});

describe("threadItemKey work slices", () => {
  it("keys work groups and sliced messages uniquely", () => {
    const groupItem: ChatThreadItem = {
      type: "work-group",
      group: {
        id: "work-group:r1",
        parts: [],
        toolCount: 0,
        reasoningCount: 0,
        hasError: false,
        metricsText: "",
      },
    };
    const plain = message({ id: "m1", role: "assistant", parts: [] });
    const sliced = message({ id: "m1", role: "assistant", parts: [] });

    expect(threadItemKey(groupItem)).toBe("work-group:r1");
    expect(threadItemKey({ type: "message", message: plain })).toBe("message:m1");
    expect(threadItemKey({ type: "message", message: sliced, sliceKey: "p1" })).toBe(
      "message:m1:p1",
    );
  });
});
