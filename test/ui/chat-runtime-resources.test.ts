import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, mountChat } from "./chat-support.js";

interface TimerTracker {
  readonly timeouts: Set<unknown>;
  readonly intervals: Set<unknown>;
  sleep(ms: number): Promise<void>;
  restore(): void;
}

function installTimerTracker(): TimerTracker {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;
  const timeouts = new Set<unknown>();
  const intervals = new Set<unknown>();

  const patchTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const id = originalSetTimeout(() => {
      timeouts.delete(id);
      if (typeof handler === "function") handler(...args);
    }, timeout);
    timeouts.add(id);
    return id;
  }) as typeof setTimeout;
  const patchInterval = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ): ReturnType<typeof setInterval> => {
    const id = originalSetInterval(handler, timeout, ...args);
    intervals.add(id);
    return id;
  }) as typeof setInterval;

  globalThis.setTimeout = patchTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) timeouts.delete(id);
    originalClearTimeout(id);
  }) as typeof clearTimeout;
  globalThis.setInterval = patchInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) intervals.delete(id);
    originalClearInterval(id);
  }) as typeof clearInterval;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = originalSetTimeout(() => {
      timeouts.delete(id);
      callback(Date.now());
    }, 16);
    timeouts.add(id);
    return id as unknown as number;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    timeouts.delete(id);
    originalClearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }) as typeof cancelAnimationFrame;

  return {
    timeouts,
    intervals,
    sleep: (ms: number) => new Promise((resolve) => originalSetTimeout(resolve, ms)),
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCaf;
    },
  };
}

interface ListenerTracker {
  readonly records: Array<{ target: EventTarget; type: string; listener: EventListener }>;
  restore(): void;
}

function installListenerTracker(): ListenerTracker {
  const records: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
  const targets = [window, document] as EventTarget[];
  const originals = targets.map((target) => ({
    target,
    add: target.addEventListener,
    remove: target.removeEventListener,
  }));

  for (const { target, add, remove } of originals) {
    target.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void => {
      records.push({ target, type, listener: listener as EventListener });
      add.call(target, type, listener, options);
    }) as EventTarget["addEventListener"];
    target.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ): void => {
      const index = records.findIndex(
        (record) =>
          record.target === target && record.type === type && record.listener === listener,
      );
      if (index >= 0) records.splice(index, 1);
      remove.call(target, type, listener, options);
    }) as EventTarget["removeEventListener"];
  }

  return {
    records,
    restore: () => {
      for (const { target, add, remove } of originals) {
        target.addEventListener = add;
        target.removeEventListener = remove;
      }
    },
  };
}

interface WorkerTracker {
  count: number;
  restore(): void;
}

function installWorkerTracker(): WorkerTracker {
  const original = (globalThis as { Worker?: typeof Worker }).Worker;
  let count = 0;
  class CountingWorker {
    constructor() {
      count += 1;
      throw new Error("chat feed must not construct a highlight worker on mount");
    }
    terminate(): void {
      // no-op
    }
  }
  (globalThis as { Worker?: unknown }).Worker = CountingWorker;
  return {
    get count() {
      return count;
    },
    restore: () => {
      if (original === undefined) {
        delete (globalThis as { Worker?: unknown }).Worker;
      } else {
        (globalThis as { Worker?: typeof Worker }).Worker = original;
      }
    },
  };
}

function activeSources(): number {
  return FakeEventSource.instances.filter((source) => !source.closed).length;
}

function domCounts(): Record<string, number> {
  return {
    shell: document.querySelectorAll("#chat-shell").length,
    scroll: document.querySelectorAll("#chat-scroll").length,
    sessions: document.querySelectorAll("[data-chat-sessions-rail]").length,
    context: document.querySelectorAll("[data-chat-context-rail]").length,
    messages: document.querySelectorAll("#chat-scroll [data-message-id]").length,
  };
}

function expectNoSurface(): void {
  expect(domCounts()).toEqual({ shell: 0, scroll: 0, sessions: 0, context: 0, messages: 0 });
}

function expectOneSurface(): void {
  const counts = domCounts();
  expect(counts.shell).toBe(1);
  expect(counts.scroll).toBe(1);
  expect(counts.sessions).toBe(1);
  expect(counts.context).toBe(1);
}

function expectNoEagerVendor(): void {
  expect((window as { Prism?: unknown }).Prism).toBeUndefined();
  expect(document.querySelectorAll('script[src*="prism"], script[src*="xterm"]')).toHaveLength(0);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("chat runtime resource ownership", () => {
  it("returns EventSource, listeners, workers, timers, and DOM to baseline across 20 cycles", async () => {
    const timers = installTimerTracker();
    const listeners = installListenerTracker();
    const workers = installWorkerTracker();
    const warm = await mountChat();
    warm.wrapper.unmount();
    warm.queryClient.clear();
    await flushPromises();
    await timers.sleep(25);
    const baseline = {
      timers: timers.timeouts.size,
      intervals: timers.intervals.size,
      listeners: listeners.records.length,
      workers: workers.count,
    };
    try {
      for (let cycle = 0; cycle < 20; cycle += 1) {
        const { wrapper, queryClient } = await mountChat();
        await flushPromises();
        expectOneSurface();
        expectNoEagerVendor();
        expect(activeSources()).toBe(1);
        expect(workers.count).toBe(baseline.workers);

        wrapper.unmount();
        queryClient.clear();
        await flushPromises();
        await timers.sleep(25);
        expectNoSurface();
        expect(activeSources()).toBe(0);
        expect(listeners.records, `cycle ${cycle}`).toHaveLength(baseline.listeners);
        expect(timers.intervals.size, `cycle ${cycle}`).toBe(baseline.intervals);
        expect(timers.timeouts.size, `cycle ${cycle}`).toBeLessThanOrEqual(baseline.timers);
        expect(workers.count).toBe(baseline.workers);
      }
    } finally {
      workers.restore();
      listeners.restore();
      timers.restore();
    }
  });

  it("returns to baseline across 10 application switches", async () => {
    const timers = installTimerTracker();
    const listeners = installListenerTracker();
    const workers = installWorkerTracker();
    const baseline = {
      timers: timers.timeouts.size,
      intervals: timers.intervals.size,
      listeners: listeners.records.length,
      workers: workers.count,
    };
    try {
      for (let index = 0; index < 10; index += 1) {
        const app = index % 2 === 0 ? "alpha" : "beta";
        const { wrapper, queryClient } = await mountChat(`/chat?app=${app}&project=p`);
        await flushPromises();
        expect(domCounts().shell).toBe(1);
        expect(activeSources()).toBe(1);
        wrapper.unmount();
        queryClient.clear();
        await flushPromises();
        await timers.sleep(25);
        expectNoSurface();
        expect(activeSources()).toBe(0);
        expect(listeners.records).toHaveLength(baseline.listeners);
        expect(timers.intervals.size).toBe(baseline.intervals);
        expect(timers.timeouts.size).toBeLessThanOrEqual(baseline.timers);
        expect(workers.count).toBe(baseline.workers);
      }
    } finally {
      workers.restore();
      listeners.restore();
      timers.restore();
    }
  });

  it("keeps one source, listener set, and surface across rapid session switches", async () => {
    const timers = installTimerTracker();
    const listeners = installListenerTracker();
    const fixture = {
      sessions: [
        { id: "s1", title: "Session one" },
        { id: "s2", title: "Session two" },
        { id: "s3", title: "Session three" },
      ],
      messagesBySession: {
        s1: [
          {
            info: { id: "msg_s1", sessionID: "s1", role: "user", time: { created: 1 } },
            parts: [{ id: "prt_s1", messageID: "msg_s1", type: "text", text: "One" }],
          },
        ],
        s2: [
          {
            info: { id: "msg_s2", sessionID: "s2", role: "user", time: { created: 2 } },
            parts: [{ id: "prt_s2", messageID: "msg_s2", type: "text", text: "Two" }],
          },
        ],
        s3: [
          {
            info: { id: "msg_s3", sessionID: "s3", role: "user", time: { created: 3 } },
            parts: [{ id: "prt_s3", messageID: "msg_s3", type: "text", text: "Three" }],
          },
        ],
      },
    };
    const { wrapper, queryClient } = await mountChat(
      "/chat?app=alpha&project=p&session=s1",
      fixture,
    );
    await flushPromises();
    const baselineListeners = listeners.records.length;
    const baselineTimers = timers.timeouts.size;
    const baselineIntervals = timers.intervals.size;
    try {
      for (let index = 0; index < 20; index += 1) {
        const id = ["s2", "s3", "s1"][index % 3];
        await wrapper.find(`.session-item[data-session-id="${id}"]`).trigger("click");
        await flushPromises();
        expectOneSurface();
        expectNoEagerVendor();
        expect(activeSources()).toBe(1);
        expect(listeners.records).toHaveLength(baselineListeners);
        expect(timers.intervals.size).toBe(baselineIntervals);
        expect(timers.timeouts.size).toBeLessThanOrEqual(baselineTimers + 1);
        const ids = wrapper
          .findAll("#chat-scroll [data-message-id]")
          .map((node) => node.attributes("data-message-id"));
        expect(new Set(ids).size).toBe(ids.length);
      }
    } finally {
      wrapper.unmount();
      queryClient.clear();
      timers.restore();
      listeners.restore();
    }
    await flushPromises();
    expectNoSurface();
    expect(activeSources()).toBe(0);
  });

  it("online reconnect keeps one source and disposes it on unmount", async () => {
    const listeners = installListenerTracker();
    const { wrapper } = await mountChat();
    await flushPromises();
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error("missing source");
    first.close();
    window.dispatchEvent(new Event("online"));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(activeSources()).toBe(1);
    wrapper.unmount();
    expect(activeSources()).toBe(0);
    listeners.restore();
  });
});
