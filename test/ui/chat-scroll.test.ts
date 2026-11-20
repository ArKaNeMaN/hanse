import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import type { ChatThreadItem } from "../../ui/chat/types.js";
import ChatThread from "../../ui/components/chat/ChatThread.vue";
import { message } from "./chat-render-support.js";

function items(count: number): ChatThreadItem[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "message" as const,
    message: message({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [],
    }),
  }));
}

function props(value: readonly ChatThreadItem[], revision = 0) {
  return {
    items: value,
    sessionId: "s1",
    workspaceKey: "alpha:p",
    revision,
    loading: false,
    loadingEarlier: false,
    error: null,
    empty: false,
    stopped: false,
    loadEarlierEnabled: false,
  };
}

function scrollMetrics(element: HTMLElement) {
  let scrollTop = 0;
  let scrollHeight = 20_000;
  let clientHeight = 600;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  return {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
    set scrollHeight(value: number) {
      scrollHeight = value;
    },
    set clientHeight(value: number) {
      clientHeight = value;
    },
  };
}

function stubResizeObserver(): {
  callbacks: ResizeObserverCallback[];
  targets: Element[];
  disconnected: () => boolean;
} {
  const callbacks: ResizeObserverCallback[] = [];
  const targets: Element[] = [];
  let disconnected = false;
  class FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe(target: Element): void {
      targets.push(target);
    }
    unobserve(): void {}
    disconnect(): void {
      disconnected = true;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver as unknown as typeof ResizeObserver);
  return { callbacks, targets, disconnected: () => disconnected };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("500-message scroll ownership", () => {
  it("keeps a 500-message feed keyed, follows the bottom only while pinned, and uses rAF", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const list = ref(items(500));
    const wrapper = mount(ChatThread, {
      props: props(list.value),
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const metrics = scrollMetrics(scroll);
    wrapper.vm.scrollToBottom();
    expect(metrics.scrollTop).toBe(20_000);
    expect(wrapper.findAll("[data-message-id]")).toHaveLength(500);

    metrics.scrollTop = 100;
    scroll.dispatchEvent(new Event("scroll"));
    await nextTick();
    const next = [
      ...list.value,
      ...items(1).map((item) => ({ ...item, type: "message" as const })),
    ];
    next[next.length - 1] = {
      type: "message",
      message: message({ id: "m500", role: "assistant", parts: [] }),
    };
    list.value = next;
    await wrapper.setProps({ items: next, revision: 1 });
    await flushPromises();
    expect(metrics.scrollTop).toBe(100);
    expect(wrapper.find("[data-chat-new-messages]").text()).toContain("New messages (1)");

    await wrapper.find("[data-chat-new-messages]").trigger("click");
    expect(metrics.scrollTop).toBe(20_000);
    expect(wrapper.find("[data-chat-new-messages]").exists()).toBe(false);
    expect(wrapper.findAll("[data-message-id]")).toHaveLength(501);
    wrapper.unmount();
  });

  it("defers a pinned follow-bottom scroll to the next animation frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const list = ref<readonly ChatThreadItem[]>(items(2));
    const wrapper = mount(ChatThread, {
      props: props(list.value),
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const metrics = scrollMetrics(scroll);
    wrapper.vm.scrollToBottom();
    expect(metrics.scrollTop).toBe(20_000);

    metrics.scrollHeight = 21_000;
    list.value = [...list.value, ...items(1)];
    await wrapper.setProps({ items: list.value, revision: 1 });
    await flushPromises();
    expect(metrics.scrollTop).toBe(20_000);
    expect(frames.length).toBeGreaterThan(0);
    frames[frames.length - 1]?.(0);
    await nextTick();
    expect(metrics.scrollTop).toBe(21_000);
    wrapper.unmount();
  });

  it("preserves the prepend anchor after 500 older items arrive", async () => {
    const wrapper = mount(ChatThread, {
      props: props(items(500)),
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const metrics = scrollMetrics(scroll);
    metrics.scrollTop = 5_000;
    wrapper.vm.restoreAnchor({ scrollTop: 5_000, scrollHeight: 20_000 });
    expect(metrics.scrollTop).toBe(5_000);

    metrics.scrollHeight = 24_000;
    wrapper.vm.restoreAnchor({ scrollTop: 5_000, scrollHeight: 20_000 });
    expect(metrics.scrollTop).toBe(9_000);
    wrapper.unmount();
  });

  it("pins to the newest content when a session is selected before its messages load", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const wrapper = mount(ChatThread, {
      props: { ...props([]), sessionId: null },
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const metrics = scrollMetrics(scroll);

    await wrapper.setProps({ sessionId: "s1", items: [] });
    await flushPromises();
    await wrapper.setProps({ items: items(2), revision: 1 });
    await flushPromises();
    frames[frames.length - 1]?.(0);
    await nextTick();

    expect(metrics.scrollTop).toBe(20_000);
    wrapper.unmount();
  });

  it("keeps the bottom visible when a taller composer shrinks the viewport", async () => {
    const observer = stubResizeObserver();
    const wrapper = mount(ChatThread, {
      props: props(items(5)),
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const metrics = scrollMetrics(scroll);
    wrapper.vm.scrollToBottom();
    expect(metrics.scrollTop).toBe(20_000);

    expect(observer.targets).toContain(scroll);
    // The composer grew by 100px, so the scroll box is 100px shorter and the newest row would
    // otherwise fall below the fold.
    metrics.clientHeight = 500;
    for (const callback of observer.callbacks) {
      callback([], {} as ResizeObserver);
    }

    expect(metrics.scrollTop).toBe(20_000);
    wrapper.unmount();
    expect(observer.disconnected()).toBe(true);
  });

  it("does not move a reader who scrolled up when the viewport resizes", async () => {
    const observer = stubResizeObserver();
    const wrapper = mount(ChatThread, {
      props: props(items(500)),
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const metrics = scrollMetrics(scroll);
    wrapper.vm.scrollToBottom();
    metrics.scrollTop = 1_000;
    scroll.dispatchEvent(new Event("scroll"));
    await nextTick();

    metrics.clientHeight = 500;
    for (const callback of observer.callbacks) {
      callback([], {} as ResizeObserver);
    }

    expect(metrics.scrollTop).toBe(1_000);
    wrapper.unmount();
  });

  it("treats a scroll event from a shrinking viewport as layout, not user intent", async () => {
    const observer = stubResizeObserver();
    const wrapper = mount(ChatThread, {
      props: props(items(5)),
      attachTo: document.body,
    });
    await flushPromises();
    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const metrics = scrollMetrics(scroll);
    wrapper.vm.scrollToBottom();

    // A growing composer first makes the textarea `height: auto` and then sets the final height.
    // The transient viewport change can clamp scrollTop and dispatch a scroll event before the
    // ResizeObserver callback, even though the reader never left the bottom.
    metrics.clientHeight = 500;
    metrics.scrollTop = 19_300;
    scroll.dispatchEvent(new Event("scroll"));
    await nextTick();

    expect(metrics.scrollTop).toBe(20_000);

    for (const callback of observer.callbacks) {
      callback([], {} as ResizeObserver);
    }

    expect(metrics.scrollTop).toBe(20_000);
    wrapper.unmount();
  });
});
