import { describe, expect, it, vi } from "vitest";
import {
  type ContainerEventDocker,
  ContainerEventTracker,
} from "../src/runner/container-events.js";
import type { DockerContainerInspect } from "../src/runner/docker.js";

const NOW = 1_700_000_000_000;

function abortableWait(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function eventLine(overrides: {
  action?: string;
  type?: string;
  appId?: string;
  id?: string;
  time: number;
}): string {
  return JSON.stringify({
    Type: overrides.type ?? "container",
    Action: overrides.action ?? "oom",
    Actor: {
      ...(overrides.id === undefined ? {} : { ID: overrides.id }),
      ...(overrides.appId === undefined ? {} : { Attributes: { "hanse.app.id": overrides.appId } }),
    },
    time: overrides.time,
  });
}

function trackerWith(
  streamEvents: ContainerEventDocker["streamEvents"],
  inspectContainer?: ContainerEventDocker["inspectContainer"],
): ContainerEventTracker {
  return new ContainerEventTracker({
    docker: {
      streamEvents,
      inspectContainer:
        inspectContainer ??
        (async (_id: string): Promise<DockerContainerInspect | undefined> => undefined),
    },
    now: () => NOW,
  });
}

describe("ContainerEventTracker", () => {
  it("attributes oom events from Actor.Attributes and ignores other types/actions", async () => {
    const tracker = trackerWith(async function* (_filter, signal) {
      yield eventLine({ appId: "project:a", id: "c1", time: NOW / 1000 - 20 });
      yield eventLine({ action: "start", appId: "project:a", id: "c1", time: NOW / 1000 - 10 });
      yield eventLine({ type: "image", appId: "project:a", id: "c1", time: NOW / 1000 - 5 });
      await abortableWait(signal);
    });
    tracker.start();
    await waitFor(() => tracker.eventsFor("project:a").length === 1);

    expect(tracker.eventsFor("project:a")).toEqual([
      { appId: "project:a", at: new Date(NOW - 20_000).toISOString() },
    ]);

    tracker.stop();
  });

  it("falls back to inspectContainer when the actor attribute is absent", async () => {
    const inspected: string[] = [];
    const tracker = trackerWith(
      async function* (_filter, signal) {
        yield eventLine({ id: "container-1", time: NOW / 1000 - 10 });
        await abortableWait(signal);
      },
      async (id) => {
        inspected.push(id);
        return { Id: id, Config: { Labels: { "hanse.app.id": "project:b" } } };
      },
    );
    tracker.start();
    await waitFor(() => tracker.eventsFor("project:b").length === 1);

    expect(inspected).toEqual(["container-1"]);
    expect(tracker.eventsFor("project:b")[0]?.appId).toBe("project:b");

    tracker.stop();
  });

  it("filters by an exclusive since without draining the ring", async () => {
    const first = NOW - 60_000;
    const second = NOW - 30_000;
    const tracker = trackerWith(async function* (_filter, signal) {
      yield eventLine({ appId: "project:a", time: first / 1000 });
      yield eventLine({ appId: "project:a", time: second / 1000 });
      await abortableWait(signal);
    });
    tracker.start();
    await waitFor(() => tracker.eventsFor("project:a").length === 2);

    const since = new Date(first).toISOString();
    const filtered = tracker.eventsFor("project:a", since);
    expect(filtered).toEqual([{ appId: "project:a", at: new Date(second).toISOString() }]);
    expect(tracker.eventsFor("project:a", since)).toEqual(filtered);

    tracker.stop();
  });

  it("reconnects after a closed stream", async () => {
    let calls = 0;
    const tracker = new ContainerEventTracker({
      docker: {
        streamEvents: async function* (_filter, _signal) {
          calls += 1;
          yield eventLine({ appId: "project:a", time: NOW / 1000 - calls });
          throw new Error("stream closed");
        },
        inspectContainer: async () => undefined,
      },
      now: () => NOW,
      initialBackoffMs: 5,
      maxBackoffMs: 10,
    });
    tracker.start();
    await waitFor(() => calls >= 3);

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(tracker.eventsFor("project:a").length).toBeGreaterThanOrEqual(1);

    tracker.stop();
  });

  it("stop aborts the stream and clears the reconnect timer", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const tracker = new ContainerEventTracker({
        docker: {
          streamEvents: (_filter, streamSignal) => {
            signal = streamSignal;
            return {
              [Symbol.asyncIterator]() {
                return { next: () => Promise.reject(new Error("stream closed")) };
              },
            };
          },
          inspectContainer: async () => undefined,
        },
        now: () => NOW,
        initialBackoffMs: 10,
        maxBackoffMs: 20,
      });
      tracker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(vi.getTimerCount()).toBe(1);
      tracker.stop();

      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
