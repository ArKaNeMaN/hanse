import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMermaidSandbox,
  type SandboxFrame,
  type SandboxTransport,
} from "../../ui/chat/mermaid-sandbox";

interface Harness {
  client: ReturnType<typeof createMermaidSandbox>;
  frame: SandboxFrame;
  transport: SandboxTransport;
  posts: unknown[];
  load(): void;
  send(data: unknown): void;
  close(): void;
}

function harness(): Harness {
  let onMessage: ((data: unknown) => void) | null = null;
  let load: (() => void) | null = null;
  const posts: unknown[] = [];
  const frame: SandboxFrame = {
    contentWindow: null,
    addEventListener: (_type, listener) => {
      load = listener;
    },
    removeEventListener: () => undefined,
    remove: vi.fn(),
  };
  const transport: SandboxTransport = {
    post: (data) => {
      posts.push(data);
    },
    close: vi.fn(),
  };
  const client = createMermaidSandbox({
    createFrame: () => frame,
    connect: (_frame, callback) => {
      onMessage = callback;
      return transport;
    },
    readTheme: () => ({ theme: "dark", tokens: { primaryColor: "#fff" } }),
    connectTimeoutMs: 100,
    renderTimeoutMs: 100,
  });
  return {
    client,
    frame,
    transport,
    posts,
    load: () => load?.(),
    send: (data) => onMessage?.(data),
    close: () => undefined,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Mermaid sandbox client", () => {
  it("connects, sends a render, and resolves the result", async () => {
    const h = harness();
    const pending = h.client.render("flowchart LR\n A-->B");
    h.load();
    h.send({ v: 1, type: "ready" });
    expect(h.posts).toHaveLength(1);
    const request = h.posts[0] as { id: string; source: string; theme: string };
    expect(request.source).toContain("flowchart");
    expect(request.theme).toBe("dark");
    h.send({ v: 1, type: "result", id: request.id, svg: "<svg/>" });
    await expect(pending).resolves.toBe("<svg/>");
  });

  it("caches by theme and source", async () => {
    const h = harness();
    const first = h.client.render("flowchart LR\n A-->B");
    h.load();
    h.send({ v: 1, type: "ready" });
    const request = h.posts[0] as { id: string };
    h.send({ v: 1, type: "result", id: request.id, svg: "<svg/>" });
    await first;
    await expect(h.client.render("flowchart LR\n A-->B")).resolves.toBe("<svg/>");
    expect(h.posts).toHaveLength(1);
  });

  it("queues work until the frame is ready", async () => {
    const h = harness();
    const pending = h.client.render("flowchart LR\n A-->B");
    expect(h.posts).toHaveLength(0);
    h.load();
    h.send({ v: 1, type: "ready" });
    expect(h.posts).toHaveLength(1);
    const request = h.posts[0] as { id: string };
    h.send({ v: 1, type: "error", id: request.id, message: "nope" });
    await expect(pending).rejects.toThrow("nope");
  });

  it("drops a cancelled job before it starts", async () => {
    const h = harness();
    const pending = h.client.render("flowchart LR\n A-->B", () => true);
    h.load();
    h.send({ v: 1, type: "ready" });
    await expect(pending).rejects.toThrow("cancelled");
    expect(h.posts).toHaveLength(0);
  });

  it("times out, restarts once, then latches", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.client.render("flowchart LR\n A-->B");
    const firstRejection = expect(first).rejects.toThrow("timed out");
    h.load();
    h.send({ v: 1, type: "ready" });
    await vi.advanceTimersByTimeAsync(100);
    await firstRejection;

    // The first timeout restarts the frame; a second timeout latches.
    const second = h.client.render("flowchart LR\n B-->C");
    const secondRejection = expect(second).rejects.toThrow("timed out");
    h.load();
    h.send({ v: 1, type: "ready" });
    await vi.advanceTimersByTimeAsync(100);
    await secondRejection;
    await expect(h.client.render("flowchart LR\n C-->D")).rejects.toThrow("timed out");
  });

  it("rejects a source over the cap", async () => {
    const h = harness();
    await expect(h.client.render("x".repeat(32_001))).rejects.toThrow("too large");
  });

  it("rejects new work after destroy", async () => {
    const h = harness();
    h.client.destroy();
    await expect(h.client.render("flowchart LR\n A-->B")).rejects.toThrow("destroyed");
  });
});
