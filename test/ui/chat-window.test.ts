import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { clearScrollMemory, readScrollMemory } from "../../ui/chat/scroll-memory.js";
import type { ChatThreadItem } from "../../ui/chat/types.js";
import ChatThread from "../../ui/components/chat/ChatThread.vue";
import { message } from "./chat-render-support.js";

const ROW_HEIGHT = 100;
const GAP = 20;
const VIEWPORT = 600;

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

function keysOf(value: readonly ChatThreadItem[]): string[] {
  return value.map((item) => `message:${item.type === "message" ? item.message.id : ""}`);
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

interface LayoutState {
  contentHeight: number;
  clientHeight: number;
  scrollTop: number;
  heights: number[];
}

interface FakeObserver {
  callback: ResizeObserverCallback;
  targets: Element[];
  observeCount: number;
  unobserveCount: number;
}

function installResizeObserver(): FakeObserver[] {
  const instances: FakeObserver[] = [];
  class FakeResizeObserver {
    callback: ResizeObserverCallback;
    targets: Element[] = [];
    observeCount = 0;
    unobserveCount = 0;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      instances.push(this);
    }
    observe(target: Element): void {
      this.targets.push(target);
      this.observeCount += 1;
    }
    unobserve(): void {
      this.unobserveCount += 1;
    }
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver as unknown as typeof ResizeObserver);
  return instances;
}

function installFrames(): { drain: () => void } {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  return {
    drain: () => {
      let guard = 0;
      while (frames.length > 0 && guard < 100) {
        guard += 1;
        const callback = frames.shift();
        callback?.(0);
      }
    },
  };
}

function installLayout(wrapper: ReturnType<typeof mount>, order: readonly string[]): LayoutState {
  const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
  const state: LayoutState = {
    contentHeight: order.length * ROW_HEIGHT + GAP * Math.max(0, order.length - 1),
    clientHeight: VIEWPORT,
    scrollTop: 0,
    heights: order.map(() => ROW_HEIGHT),
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

function stubRowRects(
  wrapper: ReturnType<typeof mount>,
  order: readonly string[],
  state: LayoutState,
): void {
  for (const row of wrapper.findAll("[data-thread-key]")) {
    const element = row.element as HTMLElement;
    const key = element.dataset.threadKey ?? "";
    const index = order.indexOf(key);
    const height = index < 0 ? ROW_HEIGHT : (state.heights[index] ?? ROW_HEIGHT);
    const top = index < 0 ? 0 : index * (ROW_HEIGHT + GAP);
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => rect(top - state.scrollTop, height),
    });
  }
}

function makeEntry(target: Element, height: number): ResizeObserverEntry {
  return {
    target,
    borderBoxSize: [{ blockSize: height, inlineSize: 100 }],
    contentRect: { height },
  } as unknown as ResizeObserverEntry;
}

function rowObserverOf(instances: readonly FakeObserver[]): FakeObserver {
  const found = instances.find((instance) =>
    instance.targets.some((target) => (target as HTMLElement).hasAttribute("data-thread-key")),
  );
  if (found === undefined) throw new Error("row ResizeObserver not found");
  return found;
}

function viewportObserverOf(instances: readonly FakeObserver[], scroll: Element): FakeObserver {
  const found = instances.find((instance) => instance.targets.includes(scroll));
  if (found === undefined) throw new Error("viewport ResizeObserver not found");
  return found;
}

async function settle(frames: { drain: () => void }): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    await flushPromises();
    await nextTick();
    frames.drain();
  }
  await flushPromises();
  await nextTick();
}

async function activate(
  wrapper: ReturnType<typeof mount>,
  observers: readonly FakeObserver[],
  frames: { drain: () => void },
): Promise<void> {
  wrapper.vm.scrollToBottom();
  const entries = wrapper
    .findAll("[data-thread-key]")
    .map((row) => makeEntry(row.element, ROW_HEIGHT));
  const observer = rowObserverOf(observers);
  observer.callback(entries, {} as ResizeObserver);
  await settle(frames);
}

function spacerStyle(spacer: { element: Element } | undefined): CSSStyleDeclaration {
  if (spacer === undefined) throw new Error("missing spacer");
  return (spacer.element as HTMLElement).style;
}

function padIdentity(topPad: number, rangeCount: number, bottomPad: number): number {
  const boundaryGap = bottomPad > 0 ? GAP : 0;
  return (
    topPad + rangeCount * ROW_HEIGHT + GAP * Math.max(0, rangeCount - 1) + boundaryGap + bottomPad
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearScrollMemory();
  document.body.innerHTML = "";
});

describe("measured transcript window", () => {
  it("keeps a 500-item transcript bounded and the pad identity holds at the pinned tail", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(500);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();

    // The first render is the full list: activation waits for the initial restore and the first
    // measurement batch.
    expect(wrapper.findAll("[data-thread-key]")).toHaveLength(500);
    expect(wrapper.find(".chat-thread__spacer").exists()).toBe(false);
    const state = installLayout(wrapper, keysOf(list));

    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    const rendered = wrapper.findAll("[data-thread-key]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(50);
    expect(wrapper.attributes("data-chat-loaded-count")).toBe("500");
    expect(wrapper.attributes("data-chat-item-count")).toBe("500");

    const inner = wrapper.find("#chat-messages");
    const start = Number(inner.attributes("data-chat-window-start"));
    const end = Number(inner.attributes("data-chat-window-end"));
    expect(start).toBeGreaterThan(0);
    expect(end).toBe(500);

    const spacers = wrapper.findAll(".chat-thread__spacer");
    expect(spacers).toHaveLength(1);
    const topStyle = spacerStyle(spacers[0]);
    const topPad = Number.parseFloat(topStyle.height);
    expect(topStyle.marginBlockEnd).toBe(`-${GAP}px`);
    expect(padIdentity(topPad, end - start, 0)).toBe(500 * ROW_HEIGHT + GAP * 499);
    expect(state.scrollTop).toBe(state.contentHeight);
    wrapper.unmount();
  });

  it("shifts the window for a middle scroll and preserves the anchor visualOffset", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(500);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    state.scrollTop = 30_000;
    scroll.dispatchEvent(new Event("scroll"));
    await settle(frames);
    stubRowRects(wrapper, keysOf(list), state);

    const inner = wrapper.find("#chat-messages");
    const start = Number(inner.attributes("data-chat-window-start"));
    const end = Number(inner.attributes("data-chat-window-end"));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeLessThan(500);

    const spacers = wrapper.findAll(".chat-thread__spacer");
    expect(spacers).toHaveLength(2);
    const topPad = Number.parseFloat(spacerStyle(spacers[0]).height);
    const bottomPad = Number.parseFloat(spacerStyle(spacers[1]).height);
    expect(padIdentity(topPad, end - start, bottomPad)).toBe(500 * ROW_HEIGHT + GAP * 499);

    const anchor = wrapper.vm.captureAnchor();
    expect(anchor?.key).toBeDefined();
    if (anchor === null) throw new Error("missing anchor");
    const anchorKey = anchor.key;
    const anchorOffset = anchor.visualOffset;

    state.scrollTop = 30_300;
    scroll.dispatchEvent(new Event("scroll"));
    await settle(frames);
    stubRowRects(wrapper, keysOf(list), state);
    await wrapper.vm.restoreAnchor(anchor);
    await settle(frames);
    stubRowRects(wrapper, keysOf(list), state);

    const row = wrapper.find(`[data-thread-key="${anchorKey}"]`).element as HTMLElement;
    expect(row.getBoundingClientRect().top - scroll.getBoundingClientRect().top).toBe(anchorOffset);
    wrapper.unmount();
  });

  it("does not jump across the restore -> latch transition", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(500);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));

    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    state.scrollTop = 30_000;
    scroll.dispatchEvent(new Event("scroll"));
    await nextTick();
    const before = state.scrollTop;

    const entries = wrapper
      .findAll("[data-thread-key]")
      .map((row) => makeEntry(row.element, ROW_HEIGHT));
    rowObserverOf(observers).callback(entries, {} as ResizeObserver);
    await settle(frames);

    expect(state.scrollTop).toBe(before);
    wrapper.unmount();
  });

  it("restores an unmounted anchor key through revealIndex and the DOM correction", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(500);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    expect(wrapper.find('[data-thread-key="message:m50"]').exists()).toBe(false);
    await wrapper.vm.restoreAnchor({
      scrollTop: state.scrollTop,
      scrollHeight: state.contentHeight,
      key: "message:m50",
      visualOffset: 0,
    });
    await settle(frames);

    expect(state.scrollTop).toBe(50 * (ROW_HEIGHT + GAP));
    expect(wrapper.find('[data-thread-key="message:m50"]').exists()).toBe(true);
    const inner = wrapper.find("#chat-messages");
    expect(Number(inner.attributes("data-chat-window-start"))).toBeLessThanOrEqual(50);
    expect(Number(inner.attributes("data-chat-window-end"))).toBeGreaterThan(50);
    wrapper.unmount();
  });

  it("follows the bottom when a pinned row changes height", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(200);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    state.contentHeight += 500;
    const observer = rowObserverOf(observers);
    const row = wrapper.findAll("[data-thread-key]").at(-1);
    if (row === undefined) throw new Error("missing rendered row");
    observer.callback([makeEntry(row.element, 150)], {} as ResizeObserver);
    await settle(frames);

    expect(state.scrollTop).toBe(state.contentHeight);
    wrapper.unmount();
  });

  it("updates the window and the pinned bottom on a viewport resize", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(500);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const before = Number(wrapper.find("#chat-messages").attributes("data-chat-window-start"));
    state.clientHeight = 400;
    viewportObserverOf(observers, scroll).callback([], {} as ResizeObserver);
    await settle(frames);

    const after = Number(wrapper.find("#chat-messages").attributes("data-chat-window-start"));
    expect(after).toBeGreaterThan(before);
    expect(state.scrollTop).toBe(state.contentHeight);
    wrapper.unmount();
  });

  it("moves focus to the scroll container before the focused row unmounts", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(500);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    const scroll = wrapper.find("#chat-scroll").element as HTMLElement;
    const row = wrapper.find('[data-thread-key="message:m499"]').element as HTMLElement;
    const button = document.createElement("button");
    row.appendChild(button);
    button.focus();
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    state.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
    await settle(frames);

    expect(document.activeElement).toBe(scroll);
    expect(wrapper.find('[data-thread-key="message:m499"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not re-register rows across 20 streaming deltas", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(120);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    const observer = rowObserverOf(observers);
    const observeCount = observer.observeCount;
    const unobserveCount = observer.unobserveCount;
    const firstRow = wrapper.find("[data-thread-key]").element;

    for (let revision = 1; revision <= 20; revision += 1) {
      await wrapper.setProps({ revision });
      await nextTick();
      frames.drain();
    }
    await settle(frames);

    expect(observer.observeCount).toBe(observeCount);
    expect(observer.unobserveCount).toBe(unobserveCount);
    expect(wrapper.find("[data-thread-key]").element).toBe(firstRow);
    wrapper.unmount();
  });

  it("restores a remounted transcript from the saved key anchor", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(500);
    const first = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(first, keysOf(list));
    await activate(first, observers, frames);
    stubRowRects(first, keysOf(list), state);

    const scroll = first.find("#chat-scroll").element as HTMLElement;
    state.scrollTop = 30_000;
    scroll.dispatchEvent(new Event("scroll"));
    await settle(frames);
    const memory = readScrollMemory("alpha:p::s1");
    expect(memory?.key).toBeDefined();
    if (memory === null) throw new Error("missing scroll memory");
    first.unmount();

    const second = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const secondState = installLayout(second, keysOf(list));
    await second.vm.restoreAnchor(memory);
    await nextTick();

    const key = memory.key;
    const offset = memory.visualOffset;
    if (key === undefined || offset === undefined) throw new Error("missing key anchor");
    const row = second.find(`[data-thread-key="${key}"]`).element as HTMLElement;
    const secondScroll = second.find("#chat-scroll").element as HTMLElement;
    expect(row.getBoundingClientRect().top - secondScroll.getBoundingClientRect().top).toBe(offset);
    expect(secondState.scrollTop).toBeGreaterThan(0);
    second.unmount();
  });

  it("keeps the full render when the row ResizeObserver is unavailable", async () => {
    vi.stubGlobal("ResizeObserver", undefined as unknown as typeof ResizeObserver);
    installFrames();
    const wrapper = mount(ChatThread, {
      props: props([]),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, []);
    const list = items(500);
    state.contentHeight = 500 * ROW_HEIGHT + GAP * 499;

    await wrapper.setProps({ items: list, revision: 1, loadedMessageCount: 500 });
    await flushPromises();
    await nextTick();

    expect(wrapper.findAll("[data-thread-key]")).toHaveLength(500);
    expect(wrapper.find(".chat-thread__spacer").exists()).toBe(false);
    expect(wrapper.find("#chat-messages").attributes("data-chat-window-start")).toBe("0");
    wrapper.unmount();
  });

  it("activates when the item count grows past the threshold after a measurement pass", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const base = items(10);
    const wrapper = mount(ChatThread, {
      props: props(base),
      attachTo: document.body,
    });
    await flushPromises();
    installLayout(wrapper, keysOf(base));
    rowObserverOf(observers).callback(
      wrapper.findAll("[data-thread-key]").map((row) => makeEntry(row.element, ROW_HEIGHT)),
      {} as ResizeObserver,
    );
    await settle(frames);

    expect(wrapper.findAll("[data-thread-key]")).toHaveLength(10);
    expect(wrapper.find(".chat-thread__spacer").exists()).toBe(false);

    const grown: ChatThreadItem[] = [
      ...base,
      ...Array.from({ length: 60 }, (_, index) => ({
        type: "message" as const,
        message: message({ id: `g${index}`, role: "assistant", parts: [] }),
      })),
    ];
    await wrapper.setProps({ items: grown, revision: 1, loadedMessageCount: 70 });
    await settle(frames);

    const rendered = wrapper.findAll("[data-thread-key]").length;
    expect(wrapper.attributes("data-chat-loaded-count")).toBe("70");
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(70);
    wrapper.unmount();
  });

  it("detects a same-count key change and remaps the replaced row height", async () => {
    const observers = installResizeObserver();
    const frames = installFrames();
    const list = items(100);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();
    const state = installLayout(wrapper, keysOf(list));
    await activate(wrapper, observers, frames);
    stubRowRects(wrapper, keysOf(list), state);

    const start = Number(wrapper.find("#chat-messages").attributes("data-chat-window-start"));
    const targetIndex = start + 2;
    const target = list[targetIndex];
    if (target === undefined || target.type !== "message") throw new Error("missing target row");
    const oldKey = `message:${target.message.id}`;

    const replaced = list.slice();
    replaced[targetIndex] = {
      type: "message",
      message: message({ id: "replaced", role: "assistant", parts: [] }),
    };
    await wrapper.setProps({ items: replaced, revision: 1 });
    await settle(frames);
    stubRowRects(wrapper, keysOf(replaced), state);

    expect(wrapper.find(`[data-thread-key="${oldKey}"]`).exists()).toBe(false);
    const newRow = wrapper.find('[data-thread-key="message:replaced"]');
    expect(newRow.exists()).toBe(true);

    rowObserverOf(observers).callback([makeEntry(newRow.element, 150)], {} as ResizeObserver);
    await settle(frames);
    stubRowRects(wrapper, keysOf(replaced), state);

    expect(wrapper.find('[data-thread-key="message:replaced"]').exists()).toBe(true);
    const rows = wrapper.findAll("[data-thread-key]");
    let renderedHeight = 0;
    for (const row of rows) {
      renderedHeight += row.attributes("data-thread-key") === "message:replaced" ? 150 : ROW_HEIGHT;
    }
    const spacers = wrapper.findAll(".chat-thread__spacer");
    const topPad = spacers.length > 0 ? Number.parseFloat(spacerStyle(spacers[0]).height) : 0;
    const bottomPad = spacers.length > 1 ? Number.parseFloat(spacerStyle(spacers[1]).height) : 0;
    const boundaryGap = bottomPad > 0 ? GAP : 0;
    const fullTotal = 99 * ROW_HEIGHT + 150 + GAP * 99;
    expect(
      topPad + renderedHeight + GAP * Math.max(0, rows.length - 1) + boundaryGap + bottomPad,
    ).toBe(fullTotal);
    wrapper.unmount();
  });

  it("renders every row in jsdom when no layout/measurement batch arrives", async () => {
    installResizeObserver();
    installFrames();
    const list = items(500);
    const wrapper = mount(ChatThread, {
      props: props(list),
      attachTo: document.body,
    });
    await flushPromises();

    expect(wrapper.findAll("[data-thread-key]")).toHaveLength(500);
    expect(wrapper.find(".chat-thread__spacer").exists()).toBe(false);
    expect(wrapper.attributes("data-chat-loaded-count")).toBe("500");
    expect(wrapper.find("#chat-messages").attributes("data-chat-window-start")).toBe("0");
    wrapper.unmount();
  });
});
