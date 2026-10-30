import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { useChatContextStore } from "../ui/stores/chat-context.js";
import { useChatFeedStore } from "../ui/stores/chat-feed.js";
import { useChatSessionStore } from "../ui/stores/chat-session.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("chat session store", () => {
  it("builds the tree and derives first root and ancestors", () => {
    const session = useChatSessionStore();
    session.setSessions([
      { id: "ses_root", title: "Root" },
      { id: "ses_child", parentID: "ses_root", title: "Child" },
      { id: "ses_grandchild", parentID: "ses_child", title: "Grandchild" },
    ]);

    expect(session.sessions.map((item) => item.id)).toEqual([
      "ses_root",
      "ses_child",
      "ses_grandchild",
    ]);
    expect(session.tree?.roots).toEqual(["ses_root"]);
    expect(session.firstRoot()).toBe("ses_root");
    expect(session.ancestorsOf("ses_grandchild")).toEqual(["ses_root", "ses_child"]);
  });

  it("bumps selection generation and tracks per-session status", () => {
    const session = useChatSessionStore();
    session.setActive("ses_a");
    const first = session.selectionGeneration;
    session.setActive("ses_a");
    expect(session.selectionGeneration).toBe(first);
    session.setActive("ses_b");
    expect(session.selectionGeneration).toBe(first + 1);

    session.setAgentStatus("ses_b", { type: "busy" });
    expect(session.agentStatusFor("ses_b")).toEqual({ type: "busy" });
    expect(session.agentStatusFor("ses_a")).toBeNull();
  });
});

describe("chat context store", () => {
  it("keeps session-keyed context/todos and active mirrors separate", () => {
    const context = useChatContextStore();
    const snapshot = {
      sessionID: "ses_a",
      state: "ready" as const,
      used: 1,
      limit: 2,
      percent: 50,
      model: null,
      status: "idle" as const,
      topLevel: true,
      activeChildren: false,
      pendingTask: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastCompactedAt: null,
      lastError: null,
      autoCompact: {
        enabled: false,
        percent: 80,
        source: "default" as const,
        percentSource: "default" as const,
      },
    };
    context.setSnapshot("ses_a", snapshot, true);
    context.setSnapshot("ses_b", { ...snapshot, sessionID: "ses_b" }, false);
    context.setTodos(
      "ses_a",
      [
        { content: "one", status: "pending", priority: "low" },
        { content: "two", status: "completed", priority: "high" },
      ],
      false,
      true,
    );

    expect(context.snapshot?.sessionID).toBe("ses_a");
    expect(context.snapshotFor("ses_b")?.sessionID).toBe("ses_b");
    expect(context.todos).toHaveLength(2);
    expect(context.todoCounts).toEqual({ total: 2, completed: 1, active: 0, pending: 1 });

    context.setPreviews([]);
    context.setHandoffs([]);
    context.setRuntime("running");
    expect(context.runtime).toBe("running");
    context.markCompacted(true);
    expect(context.compactedAt).not.toBeNull();
  });
});

describe("chat feed store", () => {
  it("merges message and notice order with the shared chat-core helper", () => {
    const feed = useChatFeedStore();
    feed.reset("ses_feed");
    feed.upsertMessage({
      type: "message/upsert",
      sessionID: "ses_feed",
      messageID: "msg_feed",
      role: "user",
      time: { created: 1_700_000_002_000 },
    });
    feed.upsertNotice({
      id: "ntc_feed",
      sessionId: "ses_feed",
      createdAt: "2023-11-14T22:13:21.000Z",
    });

    expect(feed.feedOrder.map((item) => item.id)).toEqual(["ntc_feed", "msg_feed"]);
  });

  it("rekeys an optimistic message with the shared chat-core helper", () => {
    const feed = useChatFeedStore();
    feed.reset("ses_feed");
    const optimistic = feed.upsertMessage({
      type: "message/upsert",
      sessionID: "ses_feed",
      messageID: "local_1",
      role: "user",
    });
    optimistic.optimistic = "sending";
    feed.upsertPart({
      type: "part/upsert",
      sessionID: "ses_feed",
      messageID: "local_1",
      partID: "prt_local",
      partType: "text",
      part: { id: "prt_local", type: "text", text: "hi" },
      known: true,
    });

    expect(feed.rekeyOptimistic({ tempID: "local_1", serverID: "msg_server" }).consumed).toBe(
      false,
    );
    expect(feed.thread.order).toEqual(["msg_server"]);
    expect(feed.message("msg_server")?.parts.has("prt_local")).toBe(true);
  });

  it("classifies an OMO user message through the shared chat-core classifier", () => {
    const feed = useChatFeedStore();
    feed.reset("ses_feed");
    feed.upsertMessage({
      type: "message/upsert",
      sessionID: "ses_feed",
      messageID: "msg_omo",
      role: "user",
    });
    feed.upsertPart({
      type: "part/upsert",
      sessionID: "ses_feed",
      messageID: "msg_omo",
      partID: "prt_omo",
      partType: "text",
      part: {
        id: "prt_omo",
        type: "text",
        text: "<!-- OMO_INTERNAL_INITIATOR -->\n[SYSTEM REMINDER]\nbody",
      },
      known: true,
    });

    const system = feed.classifyUserMessage("msg_omo");
    expect(system?.kind).toBe("System reminder");
    expect(feed.message("msg_omo")?.system).toBeDefined();
  });
});
