import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { clearScrollMemory, readScrollMemory } from "../../ui/chat/scroll-memory.js";
import type { ChatThreadItem } from "../../ui/chat/types.js";
import ChatThread from "../../ui/components/chat/ChatThread.vue";
import { message } from "./chat-render-support.js";

const ROW_HEIGHT = 100;
const GAP = 20;

function items(count: number, prefix = "m"): ChatThreadItem[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "message" as const,
    message: message({
      id: `${prefix}${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [],
    }),
  }));
}

function props(value: readonly ChatThreadItem[], extra: Record<string, unknown> = {}) {
  return {
    items: value,
    sessionId: "s1",
    workspaceKey: "alpha:p",
    revision: 0,
    loading: false,
    loadingEarlier: false,
    error: null,
    empty: false,
    stopped: false,
    loadEarlierEnabled: false,
    loadedMessageCount: value.length,
    ...extra,
  };
}

interface LayoutState {
  contentHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubRowRects(
  wrapper: ReturnType<typeof mount>,
  order: readonly string[],
  state: LayoutState,
): void {
  for (const row of wrapper.findAll("[data-thread-key]")) {
    const element = row.element as HTMLElement;
    const key = element.dataset.threadKey ?? "";
    const index = order.indexOf(key);
    const top = index < 0 ? 0 : index * (ROW_HEIGHT + GAP);
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(top - state.scrollTop, ROW_HEIGHT),
    });
  }
}

function installLayout(wrapper: ReturnType<typeof mount>, order: readonly string[]): LayoutState {
  const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
  const state: LayoutState = {
    contentHeight: order.length * ROW_HEIGHT + GAP * Math.max(0, order.length - 1),
    clientHeight: 600,
    scrollTop: 0,
  };
  Object.defineProperty(scroll, "scrollHeight", {
    configurable: true,
    get: () => state.contentHeight,
  });
  Object.defineProperty(scroll, "clientHeight", {
    configurable: true,
    get: () => state.clientHeight,
  });
  Object.defineProperty(scroll, "scrollTop", {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
    },
  });
  Object.defineProperty(scroll, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(0, state.clientHeight),
  });
  stubRowRects(wrapper, order, state);
  return state;
}

function keysOf(value: readonly ChatThreadItem[]): string[] {
  return value.map((item) => `message:${item.type === "message" ? item.message.id : ""}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearScrollMemory();
  document.body.innerHTML = "";
});

describe("chat scroll anchors", () => {
  it("captures the first rendered row below the viewport top as key + visualOffset", async () => {
    const list = items(8);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    wrapper.vm.scrollToBottom();

    state.scrollTop = 250;
    wrapper.vm.onScroll();

    const anchor = wrapper.vm.captureAnchor();
    expect(anchor?.key).toBe("message:m2");
    expect(anchor?.visualOffset).toBe(-10);
    expect(anchor?.scrollTop).toBe(250);
    wrapper.unmount();
  });

  it("restores a mounted key exactly regardless of the current scroll offset", async () => {
    const list = items(8);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    wrapper.vm.scrollToBottom();

    state.scrollTop = 250;
    wrapper.vm.onScroll();
    const anchor = wrapper.vm.captureAnchor();
    expect(anchor?.key).toBe("message:m2");

    state.scrollTop = 600;
    wrapper.vm.onScroll();
    await wrapper.vm.restoreAnchor(anchor);
    await nextTick();

    expect(state.scrollTop).toBe(250);
    const row = wrapper.find('[data-thread-key="message:m2"]').element as HTMLElement;
    expect(row.getBoundingClientRect().top).toBe(-10);
    wrapper.unmount();
  });

  it("falls back to the scrollHeight delta when the anchor key is gone", async () => {
    const list = items(8);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    wrapper.vm.scrollToBottom();
    state.contentHeight = 1500;

    await wrapper.vm.restoreAnchor({
      scrollTop: 500,
      scrollHeight: 1000,
      key: "message:gone",
      visualOffset: 0,
    });

    expect(state.scrollTop).toBe(1000);
    wrapper.unmount();
  });

  it("keeps the same row at the same visualOffset after a prepend", async () => {
    const original = items(5);
    const wrapper = mount(ChatThread, {
      props: props(original),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(original));
    wrapper.vm.scrollToBottom();
    state.scrollTop = 240;
    wrapper.vm.onScroll();
    const anchor = wrapper.vm.captureAnchor();
    expect(anchor?.key).toBe("message:m2");
    expect(anchor?.visualOffset).toBe(0);

    const prepended = [...items(3, "new"), ...original];
    await wrapper.setProps({ items: prepended, revision: 1 });
    await flushPromises();
    stubRowRects(wrapper, keysOf(prepended), state);

    await wrapper.vm.restoreAnchor(anchor);
    await nextTick();

    expect(state.scrollTop).toBe(600);
    const row = wrapper.find('[data-thread-key="message:m2"]').element as HTMLElement;
    expect(row.getBoundingClientRect().top).toBe(0);
    wrapper.unmount();
  });

  it("does not overwrite the outgoing scope on a session change", async () => {
    const list = items(5);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    wrapper.vm.scrollToBottom();
    state.scrollTop = 400;
    wrapper.vm.onScroll();
    expect(readScrollMemory("alpha:p::s1")?.scrollTop).toBe(400);

    await wrapper.setProps({ sessionId: "s2", items: list });
    await flushPromises();

    expect(readScrollMemory("alpha:p::s1")?.scrollTop).toBe(400);
    wrapper.unmount();
  });

  it("updates the reactive scroll inputs synchronously on programmatic scrolls", async () => {
    const list = items(5);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    wrapper.vm.scrollToBottom();

    state.scrollTop = 500;
    wrapper.vm.onScroll();
    expect(wrapper.vm.scrollTopValue).toBe(500);
    expect(wrapper.vm.viewportHeightValue).toBe(600);

    wrapper.vm.scrollToBottom();
    expect(wrapper.vm.scrollTopValue).toBe(state.contentHeight);
    wrapper.unmount();
  });

  it("re-settles from the last anchor after load-earlier without emitting again", async () => {
    const original = items(30);
    const loadEarlier = vi.fn();
    const wrapper = mount(ChatThread, {
      props: props(original, { loadEarlierEnabled: true, onLoadEarlier: loadEarlier }),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(original));
    wrapper.vm.scrollToBottom();
    state.scrollTop = 0;
    wrapper.vm.onScroll();
    expect(loadEarlier).toHaveBeenCalledTimes(1);

    const prepended = [...items(5, "older"), ...original];
    await wrapper.setProps({ items: prepended, revision: 1, loadingEarlier: true });
    await flushPromises();
    stubRowRects(wrapper, keysOf(prepended), state);

    await wrapper.setProps({ loadingEarlier: false });
    await flushPromises();
    await nextTick();

    expect(state.scrollTop).toBe(600);
    expect(loadEarlier).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
