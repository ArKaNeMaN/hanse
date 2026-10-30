import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readQueuePromotionBlocks } from "../../ui/chat/session-storage.js";
import { useChatUiStore } from "../../ui/stores/chat-ui.js";
import { FakeEventSource, mountChat } from "./chat-support.js";

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
  it("derives strip rows from deriveQueue and opens the queue dialog", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
    });
    const strip = wrapper.find("[data-chat-queue-strip]");
    expect(strip.exists()).toBe(true);
    expect(strip.findAll("[data-queue-id]")).toHaveLength(2);
    expect(strip.text()).toContain("2 messages queued");
    expect(strip.text()).toContain("Queued first");
    expect(strip.text()).toContain("Queued second");

    await wrapper.find("[data-chat-queue-open]").trigger("click");
    await flushPromises();
    const dialog = wrapper.find("[data-chat-queue-dialog]");
    expect(dialog.exists()).toBe(true);
    expect(dialog.findAll("[data-queue-id]")).toHaveLength(2);
    expect(useChatUiStore(pinia).needsInputCount).toBe(0);

    await wrapper.find("[data-chat-queue-close]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-chat-queue-dialog]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps queue promotion suppressed after an intentional abort settles idle", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
      abortBody: { aborted: true },
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-queue" });
    await flushPromises();
    await emitStatus(source, 1, "busy");

    await wrapper.find("[data-chat-abort]").trigger("click");
    await flushPromises();
    expect(readQueuePromotionBlocks({ app: "alpha", project: "p" }).has("s1")).toBe(true);

    await emitStatus(source, 2, "idle");
    expect(wrapper.findAll("[data-chat-queue-strip] [data-queue-id]")).toHaveLength(2);
    expect(useChatUiStore(pinia).needsInputCount).toBe(0);
    wrapper.unmount();
  });

  it("settles idle after a successful stop", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: QUEUED_MESSAGES,
      abortBody: { aborted: true },
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-stop" });
    await flushPromises();
    await emitStatus(source, 1, "busy");

    await wrapper.find("[data-chat-abort]").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-chat-abort]").attributes("disabled")).toBeDefined();
    await emitStatus(source, 2, "idle");
    expect(wrapper.find("[data-chat-abort]").exists()).toBe(false);
    expect(wrapper.find("[data-chat-send]").exists()).toBe(true);
    wrapper.unmount();
  });

  it("reports an already-idle stop without suppressing the queue", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      abortBody: { aborted: false },
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
    expect(readQueuePromotionBlocks({ app: "alpha", project: "p" }).has("s1")).toBe(false);
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/abort"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });
});
