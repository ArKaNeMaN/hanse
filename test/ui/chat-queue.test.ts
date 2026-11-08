import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { TurnSnapshot } from "../../src/chat/turn.js";
import ChatQueueDialog from "../../ui/components/chat/ChatQueueDialog.vue";
import { defaultTurn, FakeEventSource, mountChat } from "./chat-support.js";

const QUEUED_MESSAGES = [
  {
    info: {
      id: "msg_working",
      sessionID: "s1",
      role: "assistant",
      finish: "tool-calls",
      time: { created: 1_760_000_001_000 },
    },
    parts: [
      {
        id: "prt_working",
        sessionID: "s1",
        messageID: "msg_working",
        type: "text",
        text: "Working on it.",
      },
    ],
  },
  {
    info: {
      id: "msg_q1",
      sessionID: "s1",
      role: "user",
      time: { created: 1_760_000_002_000 },
    },
    parts: [
      {
        id: "prt_q1",
        sessionID: "s1",
        messageID: "msg_q1",
        type: "text",
        text: "Queued first\nsecond line",
      },
    ],
  },
  {
    info: {
      id: "msg_q2",
      sessionID: "s1",
      role: "user",
      time: { created: 1_760_000_003_000 },
    },
    parts: [
      {
        id: "prt_q2",
        sessionID: "s1",
        messageID: "msg_q2",
        type: "text",
        text: "Queued second",
      },
    ],
  },
];

function turnWith(overrides: Partial<TurnSnapshot>): TurnSnapshot {
  return { ...defaultTurn("s1"), revision: "rev-test", ...overrides };
}

function turnFixture(
  getTurn: () => TurnSnapshot,
): (request: { method: string; url: string }) => { status: number; body: unknown } | undefined {
  return (request) => {
    if (!/\/sessions\/[^/]+\/turn(?:\?|$)/.test(request.url)) return undefined;
    return { status: 200, body: getTurn() };
  };
}

async function emitStatus(source: FakeEventSource, seq: number, type: string): Promise<void> {
  source.emit({
    type: "session.status",
    seq,
    streamID: "stream-queue",
    sessionID: "s1",
    status: { type },
  });
  await flushPromises();
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("chat queue and abort", () => {
  it("renders the turn-status live region and opens the queue modal from the count", async () => {
    const turn = turnWith({
      status: { type: "idle" },
      queuedPromptIDs: ["msg_q1", "msg_q2"],
      activePromptID: "msg_q1",
    });
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
      turn: turn,
    });
    await flushPromises();

    expect(wrapper.find("[data-chat-queue-strip]").exists()).toBe(false);
    expect(wrapper.find(".chat-queue-strip").exists()).toBe(false);

    const status = wrapper.get("[data-chat-turn-status]");
    expect(status.attributes("role")).toBe("status");
    expect(status.attributes("aria-live")).toBe("polite");
    expect(status.get("[data-chat-turn-label]").text()).toBe("Ready");
    const open = status.get("[data-chat-queue-open]");
    expect(open.text()).toBe("· 2 queued");
    expect(open.attributes("aria-controls")).toBe("chat-queue-dialog");
    expect(open.attributes("aria-haspopup")).toBe("dialog");
    expect(open.attributes("aria-label")).toBe("Show 2 queued messages");
    expect(wrapper.get("[data-chat-generating-label]").text()).toBe("Ready · 2 queued");
    expect(wrapper.get("[data-chat-queue-dialog]").attributes("open")).toBeUndefined();

    const beforeOpen = fetchState.requests.filter(
      (request) => request.method === "GET" && request.url.includes("/turn"),
    ).length;
    await open.trigger("click");
    await flushPromises();
    expect(
      fetchState.requests.filter(
        (request) => request.method === "GET" && request.url.includes("/turn"),
      ).length,
    ).toBeGreaterThan(beforeOpen);
    const dialog = wrapper.get("[data-chat-queue-dialog]");
    expect(dialog.attributes("open")).toBe("");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.findAll("[data-queue-id]")).toHaveLength(2);
    expect(dialog.text()).toContain("Queued first");
    expect(dialog.text()).toContain("Queued second");
    expect(document.activeElement).toBe(wrapper.get("[data-chat-queue-close]").element);

    await dialog.trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.get("[data-chat-queue-dialog]").attributes("open")).toBeUndefined();
    expect(document.activeElement).toBe(wrapper.get("[data-chat-queue-open]").element);
    wrapper.unmount();
  });

  it("traps tab focus in the modal and closes from the backdrop", async () => {
    const turn = turnWith({
      status: { type: "idle" },
      queuedPromptIDs: ["msg_q1"],
      activePromptID: "msg_q1",
    });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES.slice(0, 2),
      turn,
    });
    await flushPromises();
    await wrapper.get("[data-chat-queue-open]").trigger("click");
    await flushPromises();
    const dialog = wrapper.get("[data-chat-queue-dialog]");
    const close = wrapper.get("[data-chat-queue-close]");
    expect(document.activeElement).toBe(close.element);

    await dialog.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(close.element);

    await dialog.trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-chat-queue-dialog]").attributes("open")).toBeUndefined();
    expect(document.activeElement).toBe(wrapper.get("[data-chat-queue-open]").element);
    wrapper.unmount();
  });

  it("never counts a client-only row in the queue", async () => {
    const turn = turnWith({
      status: { type: "idle" },
      queuedPromptIDs: ["msg_q1"],
      activePromptID: "msg_q1",
    });
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES.slice(0, 2),
      turn,
    });
    const { useChatFeedStore } = await import("../../ui/stores/chat-feed.js");
    const feed = useChatFeedStore(pinia);
    feed.insertOptimisticMessage({ id: "local_only", text: "local" });
    await flushPromises();
    expect(wrapper.find("[data-chat-generating-label]").text()).toBe("Ready · 1 queued");
    expect(wrapper.get("[data-chat-queue-open]").text()).toBe("· 1 queued");
    await wrapper.get("[data-chat-queue-open]").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-chat-queue-dialog] [data-queue-id]")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows Thinking before the first part while the head is running", async () => {
    let turn = turnWith({
      status: { type: "idle" },
      queuedPromptIDs: ["msg_q1"],
      activePromptID: "msg_q1",
    });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: [QUEUED_MESSAGES[1]],
      custom: turnFixture(() => turn),
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-queue" });
    await flushPromises();

    turn = turnWith({
      status: { type: "busy" },
      runningPromptID: "msg_q1",
      activePromptID: "msg_q1",
      queuedPromptIDs: ["msg_q1"],
    });
    await emitStatus(source, 1, "busy");

    const label = wrapper.find("[data-chat-generating-label]");
    expect(label.text()).toBe("Thinking");
    expect(label.text()).not.toContain("queued");
    expect(wrapper.find('[data-message-id="msg_q1"]').attributes("data-optimistic")).toBe(
      "accepted",
    );
    wrapper.unmount();
  });

  it("counts a queued prompt behind a busy multi-step turn", async () => {
    let turn = turnWith({ status: { type: "idle" } });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
      custom: turnFixture(() => turn),
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-queue" });
    await flushPromises();

    turn = turnWith({
      status: { type: "busy" },
      turnContinues: true,
      queuedPromptIDs: ["msg_q1"],
      activePromptID: null,
    });
    await emitStatus(source, 1, "busy");
    expect(wrapper.find("[data-chat-generating-label]").text()).toContain("· 1 queued");
    wrapper.unmount();
  });

  it("skips a hidden synthetic manifest in the queue row preview", async () => {
    const turn = turnWith({
      status: { type: "idle" },
      queuedPromptIDs: ["msg_q_manifest"],
      activePromptID: "msg_q_manifest",
    });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: [
        {
          info: {
            id: "msg_q_manifest",
            sessionID: "s1",
            role: "user",
            time: { created: 1_760_000_004_000 },
          },
          parts: [
            {
              id: "prt_q_manifest",
              sessionID: "s1",
              messageID: "msg_q_manifest",
              type: "text",
              text: "Attached files (use these paths...):\n- /tmp/a.txt",
              synthetic: true,
              metadata: { hanse: "attachment-manifest" },
            },
            {
              id: "prt_q_visible",
              sessionID: "s1",
              messageID: "msg_q_manifest",
              type: "text",
              text: "Visible queued text",
            },
          ],
        },
      ],
      turn,
    });
    await flushPromises();
    await wrapper.get("[data-chat-queue-open]").trigger("click");
    await flushPromises();
    const dialog = wrapper.get("[data-chat-queue-dialog]");
    expect(dialog.text()).toContain("Visible queued text");
    expect(dialog.text()).not.toContain("Attached files");
    wrapper.unmount();
  });

  it("renders the running row as active and never labels it queued", async () => {
    const turn = turnWith({
      status: { type: "busy" },
      runningPromptID: "msg_q1",
      activePromptID: "msg_q1",
      queuedPromptIDs: ["msg_q1", "msg_q2"],
    });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
      turn,
    });
    await flushPromises();
    expect(wrapper.get("[data-chat-queue-open]").text()).toBe("· 1 queued");
    await wrapper.get("[data-chat-queue-open]").trigger("click");
    await flushPromises();

    const active = wrapper.get('[data-chat-queue-dialog] [data-queue-id="msg_q1"]');
    expect(active.attributes("data-active")).toBe("true");
    expect(active.attributes("data-state")).toBe("active");
    expect(active.attributes("aria-current")).toBe("true");
    expect(active.get(".chat-queue__kind").text()).toBe("Active");
    expect(active.get(".chat-queue__kind").text()).not.toContain("Queued");

    const queued = wrapper.get('[data-chat-queue-dialog] [data-queue-id="msg_q2"]');
    expect(queued.attributes("data-active")).toBeUndefined();
    expect(queued.attributes("data-state")).toBe("Queued");
    wrapper.unmount();
  });

  it("renders the truncated count as N+ in the row and the button", async () => {
    const turn = turnWith({
      status: { type: "idle" },
      queuedPromptIDs: ["msg_q1", "msg_q2"],
      queuedTruncated: true,
      activePromptID: "msg_q1",
    });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
      turn,
    });
    await flushPromises();
    expect(wrapper.get("[data-chat-generating-label]").text()).toBe("Ready · 2+ queued");
    const open = wrapper.get("[data-chat-queue-open]");
    expect(open.text()).toBe("· 2+ queued");
    expect(open.attributes("aria-label")).toBe("Show 2+ queued messages");
    wrapper.unmount();
  });

  it("returns focus to the composer when the count disappears while the modal is open", async () => {
    let turn = turnWith({
      status: { type: "idle" },
      queuedPromptIDs: ["msg_q1"],
      activePromptID: "msg_q1",
    });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES.slice(0, 2),
      custom: turnFixture(() => turn),
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-focus" });
    await flushPromises();
    await wrapper.get("[data-chat-queue-open]").trigger("click");
    await flushPromises();

    turn = turnWith({ status: { type: "idle" } });
    await emitStatus(source, 1, "idle");
    expect(wrapper.find("[data-chat-queue-open]").exists()).toBe(false);

    await wrapper.get("[data-chat-queue-dialog]").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get("[data-chat-composer-input]").element);
    wrapper.unmount();
  });

  it("settles idle after a successful stop and keeps the server queue ready", async () => {
    let turn = turnWith({
      status: { type: "busy" },
      runningPromptID: "msg_q1",
      activePromptID: "msg_q1",
      queuedPromptIDs: ["msg_q1", "msg_q2"],
    });
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
      abortBody: { aborted: true },
      custom: turnFixture(() => turn),
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-stop" });
    await flushPromises();
    await emitStatus(source, 1, "busy");
    expect(wrapper.find("[data-chat-generating-label]").text()).toContain("Working");

    await wrapper.find("[data-chat-abort]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-chat-abort]").attributes("disabled")).toBeDefined();

    turn = turnWith({
      status: { type: "idle" },
      activePromptID: "msg_q1",
      queuedPromptIDs: ["msg_q1", "msg_q2"],
    });
    await emitStatus(source, 2, "idle");
    expect(wrapper.find("[data-chat-abort]").exists()).toBe(false);
    expect(wrapper.find("[data-chat-send]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-generating-label]").text()).toBe("Ready · 2 queued");
    expect(sessionStorage.length).toBe(0);
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/abort"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("reports an already-idle stop without changing the queue", async () => {
    const turn = turnWith({
      status: { type: "busy" },
      queuedPromptIDs: ["msg_q1"],
      activePromptID: "msg_q1",
    });
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES.slice(0, 2),
      abortBody: { aborted: false },
      custom: turnFixture(() => turn),
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-idle-abort" });
    await flushPromises();
    await emitStatus(source, 1, "busy");

    await wrapper.find("[data-chat-abort]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-chat-send-error]").text()).toContain("already idle");
    expect(wrapper.find("[data-chat-generating-label]").text()).toContain("Working");
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/abort"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("renders the empty and failed queue states", async () => {
    const empty = mount(ChatQueueDialog, {
      props: { open: true, rows: [] },
      attachTo: document.body,
    });
    await nextTick();
    expect(empty.get("[data-chat-queue-empty]").text()).toBe("No messages are queued.");
    expect(empty.find("[data-chat-queue-failed]").exists()).toBe(false);
    empty.unmount();

    const failed = mount(ChatQueueDialog, {
      props: {
        open: true,
        rows: [{ id: "msg_q1", preview: "Queued first", state: "Queued" }],
        failed: true,
      },
      attachTo: document.body,
    });
    await nextTick();
    expect(failed.get("[data-chat-queue-failed]").text()).toContain("Could not refresh the queue");
    expect(failed.find("[data-chat-queue-empty]").exists()).toBe(false);
    expect(failed.findAll("[data-queue-id]")).toHaveLength(1);
    failed.unmount();
  });
});
