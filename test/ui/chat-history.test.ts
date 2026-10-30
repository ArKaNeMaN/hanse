import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { clearScrollMemory } from "../../ui/chat/scroll-memory.js";
import type { ChatThreadItem } from "../../ui/chat/types.js";
import ChatThread from "../../ui/components/chat/ChatThread.vue";
import { FakeEventSource, FIXTURE_MESSAGES, mountChat } from "./chat-support.js";

function historyMessage(index: number) {
  const suffix = String(index).padStart(2, "0");
  return {
    info: {
      id: `msg_history_${suffix}`,
      sessionID: "s1",
      role: index % 2 === 0 ? "assistant" : "user",
      time: { created: 1_760_000_000_000 + index },
    },
    parts: [
      {
        id: `prt_history_${suffix}`,
        sessionID: "s1",
        messageID: `msg_history_${suffix}`,
        type: "text",
        text: `History message ${index}.`,
      },
    ],
  };
}

const HISTORY = Array.from({ length: 35 }, (_, index) => historyMessage(index + 1));
const HISTORY_PAGES = [
  { before: null, messages: HISTORY.slice(5), nextCursor: "msg_history_06" },
  { before: "msg_history_06", messages: HISTORY.slice(0, 5), nextCursor: null },
];

function messageIDs(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper
    .findAll("#chat-scroll [data-message-id]")
    .map((node) => node.attributes("data-message-id") ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearScrollMemory();
  document.body.innerHTML = "";
});

describe("chat history paging", () => {
  it("loads a 30-message tail, pages older on scroll-top, and has no duplicates", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messagePages: HISTORY_PAGES,
    });

    expect(
      fetchState.requests.some(
        (request) => request.url.includes("/messages?") && request.url.includes("limit=30"),
      ),
    ).toBe(true);
    expect(fetchState.requests.some((request) => request.url.includes("before="))).toBe(false);
    expect(messageIDs(wrapper)).toHaveLength(30);
    expect(wrapper.find("[data-chat-history-start]").exists()).toBe(false);

    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
    await flushPromises();
    await nextTick();

    expect(
      fetchState.requests.some((request) => request.url.includes("before=msg_history_06")),
    ).toBe(true);
    const ids = messageIDs(wrapper);
    expect(ids).toHaveLength(35);
    expect(new Set(ids).size).toBe(ids.length);
    expect(wrapper.find("[data-chat-history-start]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-load-earlier]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("merges overlapping older pages without duplicating a message", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: FIXTURE_MESSAGES,
      nextCursor: "msg_assistant",
      olderMessages: [historyMessage(1), FIXTURE_MESSAGES[1]],
    });

    await wrapper.find("[data-chat-load-earlier]").trigger("click");
    await flushPromises();

    const ids = messageIDs(wrapper);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("msg_assistant");
    expect(ids).toContain("msg_user");
    expect(wrapper.text()).toContain("History message 1.");
    wrapper.unmount();
  });

  it("surfaces a cursor error without dropping the loaded tail", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      nextCursor: "cursor-bad",
      olderStatus: 400,
      olderCode: "invalid_cursor",
    });

    await wrapper.find("[data-chat-load-earlier]").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Could not load earlier messages; refresh this conversation.");
    expect(messageIDs(wrapper)).toHaveLength(2);
    expect(wrapper.find("[data-chat-load-earlier]").exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps keyed message nodes across a live delta instead of replacing the feed DOM", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1");
    const before = wrapper.find('[data-message-id="msg_user"]').element;
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");

    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-keyed" });
    await flushPromises();
    source.emit({
      type: "message.part.delta",
      seq: 1,
      streamID: "stream-keyed",
      sessionID: "s1",
      messageID: "msg_assistant",
      partID: "prt_live",
      partType: "text",
      field: "text",
      delta: " Keyed delta.",
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Keyed delta.");
    expect(wrapper.find('[data-message-id="msg_user"]').element).toBe(before);
    const ids = messageIDs(wrapper);
    expect(new Set(ids).size).toBe(ids.length);
    wrapper.unmount();
  });
});

describe("chat scroll ownership", () => {
  it("follows the bottom while pinned, pauses while scrolled up, and shows new messages", async () => {
    const items = ref<readonly ChatThreadItem[]>([
      {
        type: "message",
        message: { id: "m1", role: "user", omo: null, parts: [] },
      },
    ]);
    const wrapper = mount(ChatThread, {
      props: {
        items: items.value,
        sessionId: "s1",
        workspaceKey: "alpha:p",
        revision: 0,
        loading: false,
        loadingEarlier: false,
        error: null,
        empty: false,
        stopped: false,
        loadEarlierEnabled: false,
      },
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    Object.defineProperty(scroll, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 200, configurable: true });
    let scrollTop = 0;
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    await nextTick();
    await wrapper.setProps({ revision: 1 });

    scrollTop = 100;
    scroll.dispatchEvent(new Event("scroll"));
    await nextTick();
    items.value = [
      ...items.value,
      { type: "message", message: { id: "m2", role: "assistant", omo: null, parts: [] } },
    ];
    await wrapper.setProps({ items: items.value, revision: 2 });
    await flushPromises();
    await nextTick();

    expect(wrapper.find("[data-chat-new-messages]").text()).toContain("New messages (1)");
    expect(scrollTop).toBe(100);
    await wrapper.find("[data-chat-new-messages]").trigger("click");
    expect(scrollTop).toBe(1000);
    expect(wrapper.find("[data-chat-new-messages]").exists()).toBe(false);
    wrapper.unmount();
  });
});
