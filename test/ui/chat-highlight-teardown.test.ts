import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { allocateView, extractToolView, type ToolView } from "../../assets/chat-diff.js";
import {
  disposeHighlightController,
  getHighlightStats,
  mountToolView,
  setToolViewOpen,
} from "../../assets/chat-highlight.js";
import ToolPart from "../../ui/components/chat/ToolPart.vue";
import { part } from "./chat-render-support.js";

class TestWorker {
  static constructed = 0;
  static terminated = 0;
  static autoReady = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;

  constructor() {
    TestWorker.constructed += 1;
  }

  postMessage(message: { type?: string }): void {
    if (message.type === "init" && TestWorker.autoReady) {
      queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
    }
  }

  terminate(): void {
    TestWorker.terminated += 1;
  }
}

function diffView(): ToolView {
  const view = extractToolView(
    {
      state: {
        status: "completed",
        input: { filePath: "src/a.ts" },
        metadata: {
          filediff: {
            file: "src/a.ts",
            patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
          },
        },
      },
    },
    "edit",
    "completed",
  );
  if (view === null) throw new Error("missing view");
  return allocateView(view);
}

function open(partID: string, viewKey: string): HTMLElement {
  const view = diffView();
  const container = mountToolView(view, { partID, viewKey });
  if (container === null) throw new Error("missing container");
  document.body.append(container);
  setToolViewOpen(partID, viewKey, view, container, true);
  return container;
}

beforeEach(() => {
  TestWorker.constructed = 0;
  TestWorker.terminated = 0;
  TestWorker.autoReady = false;
  vi.stubGlobal("Worker", TestWorker);
  disposeHighlightController();
  TestWorker.constructed = 0;
  TestWorker.terminated = 0;
});

afterEach(() => {
  disposeHighlightController();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("lazy tool body teardown", () => {
  it("mounts the diff view only while open and unmounts it on collapse", async () => {
    const editPart = part({
      id: "diff-tool",
      type: "tool",
      status: "completed",
      data: {
        id: "diff-tool",
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "src/a.ts" },
          metadata: {
            filediff: {
              file: "src/a.ts",
              patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
            },
          },
        },
      },
    });
    const wrapper = mount(ToolPart, { props: { part: editPart } });
    await nextTick();
    expect(wrapper.find("[data-diff-view]").exists()).toBe(false);

    const details = wrapper.find("details");
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle");
    await nextTick();
    expect(wrapper.find("[data-diff-view]").exists()).toBe(true);

    (details.element as HTMLDetailsElement).open = false;
    await details.trigger("toggle");
    await nextTick();
    expect(wrapper.find("[data-diff-view]").exists()).toBe(false);
    expect(getHighlightStats().disabled).toBe(false);
    wrapper.unmount();
  });
});

describe("disposeHighlightController", () => {
  it("terminates the worker, clears the ready timer/jobs/stats, and allows a fresh mount", async () => {
    vi.useFakeTimers();
    open("p1", "k1");
    await Promise.resolve();
    expect(TestWorker.constructed).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    disposeHighlightController();
    expect(TestWorker.terminated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(getHighlightStats()).toMatchObject({
      inflightStreams: 0,
      reservedNodes: 0,
      pageCommitted: 0,
      pendingFiles: 0,
      timeouts: 0,
      disabled: false,
    });

    open("p2", "k2");
    await Promise.resolve();
    expect(TestWorker.constructed).toBe(2);
  });

  it("resets stats.disabled after a worker failure so a remount highlights again", async () => {
    class ThrowingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      constructor() {
        TestWorker.constructed += 1;
        throw new Error("worker unavailable");
      }
      postMessage(): void {}
      terminate(): void {
        TestWorker.terminated += 1;
      }
    }
    vi.stubGlobal("Worker", ThrowingWorker);
    open("p1", "k1");
    await Promise.resolve();
    expect(getHighlightStats().disabled).toBe(true);

    disposeHighlightController();
    expect(getHighlightStats().disabled).toBe(false);

    TestWorker.autoReady = false;
    vi.stubGlobal("Worker", TestWorker);
    open("p2", "k2");
    await Promise.resolve();
    expect(TestWorker.constructed).toBe(2);
    expect(getHighlightStats().disabled).toBe(false);
  });
});
