import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allocateView, extractToolView, type ToolView } from "../../assets/chat-diff.js";
import {
  disposeHighlightController,
  getHighlightStats,
  mountToolView,
  setToolViewOpen,
} from "../../assets/chat-highlight.js";

function viewFor(filePath: string, patch: string): ToolView {
  const view = extractToolView(
    {
      state: {
        status: "completed",
        input: { filePath },
        metadata: { filediff: { file: filePath, patch } },
      },
    },
    "edit",
    "completed",
  );
  if (view === null) throw new Error("missing view");
  return allocateView(view);
}

function open(view: ToolView, partID = "p1"): HTMLElement {
  const container = mountToolView(view, { partID, viewKey: `k-${partID}` });
  if (container === null) throw new Error("missing container");
  document.body.append(container);
  setToolViewOpen(partID, `k-${partID}`, view, container, true);
  return container;
}

beforeEach(() => {
  disposeHighlightController();
});

afterEach(() => {
  disposeHighlightController();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("highlight plain fallback", () => {
  it("does not construct a worker for an unsupported language", async () => {
    let constructed = 0;
    class CountingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      constructor() {
        constructed += 1;
      }
      postMessage(): void {}
      terminate(): void {}
    }
    vi.stubGlobal("Worker", CountingWorker);
    const view = viewFor("assets/unknown.unknownext", "@@ -1 +1 @@\n-alpha\n+beta");
    const container = open(view);
    await Promise.resolve();
    expect(constructed).toBe(0);
    expect(container.dataset.highlight).toBe("plain");
    expect(getHighlightStats().disabled).toBe(false);
  });

  it("falls back to plain when the worker cannot be constructed and recovers after dispose", async () => {
    class BrokenWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      onmessageerror: unknown = null;
      constructor() {
        throw new Error("no worker");
      }
      postMessage(): void {}
      terminate(): void {}
    }
    vi.stubGlobal("Worker", BrokenWorker);
    const container = open(viewFor("src/a.ts", "@@ -1 +1 @@\n-old\n+new"));
    await Promise.resolve();
    expect(getHighlightStats().disabled).toBe(true);
    expect(container.dataset.highlight).toBe("plain");
    disposeHighlightController();
    expect(getHighlightStats().disabled).toBe(false);
  });

  it("marks the view plain after a worker error and resets on dispose", async () => {
    class ErrorWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessageerror: ((event: unknown) => void) | null = null;
      postMessage(message: { type?: string }): void {
        if (message.type === "init") {
          queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
        } else {
          queueMicrotask(() => this.onerror?.({}));
        }
      }
      terminate(): void {}
    }
    vi.stubGlobal("Worker", ErrorWorker);
    const container = open(viewFor("src/a.ts", "@@ -1 +1 @@\n-old\n+new"));
    await vi.waitFor(() => expect(getHighlightStats().disabled).toBe(true));
    expect(container.dataset.highlight).toBe("plain");
    disposeHighlightController();
    expect(getHighlightStats().disabled).toBe(false);
  });

  it("enforces the highlight timeout by falling back to plain, then recovers on remount", async () => {
    class SilentWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessageerror: ((event: unknown) => void) | null = null;
      postMessage(message: { type?: string }): void {
        if (message.type === "init") {
          queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } }));
        }
        // Never answer tokenize requests: the controller should hit its 250 ms stream timeout.
      }
      terminate(): void {}
    }
    vi.useFakeTimers();
    vi.stubGlobal("Worker", SilentWorker);
    const container = open(viewFor("src/a.ts", "@@ -1 +1 @@\n-old\n+new"));
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(container.dataset.highlight).toMatch(/plain|budget|error/);
    disposeHighlightController();
    expect(getHighlightStats().disabled).toBe(false);
  });
});
