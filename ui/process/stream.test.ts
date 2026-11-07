import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProcessStream,
  type ProcessCurrent,
  type ProcessEventSource,
  type ProcessStreamStatus,
  type ProcessTransition,
} from "./stream.js";

class FakeEventSource implements ProcessEventSource {
  static instances: FakeEventSource[] = [];

  readyState = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  emit(payload: unknown): void {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  fail(): void {
    this.onerror?.({});
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
});

const CURRENT: ProcessCurrent = {
  state: "error",
  phase: "failed",
  attemptId: "a1",
  startedAt: "2026-11-07T10:00:00.000Z",
  updatedAt: "2026-11-07T10:05:00.000Z",
  error: {
    code: "readiness_timeout",
    message: "agent did not answer",
    at: "2026-11-07T10:05:00.000Z",
  },
};

function transition(id: number): ProcessTransition {
  return {
    id,
    attemptId: "a1",
    seq: id,
    state: "running",
    phase: "ready",
    source: "runtime",
    reason: null,
    errorCode: null,
    message: null,
    createdAt: "2026-11-07T10:03:00.000Z",
  };
}

const URL = "/api/apps/web/process/events?project=p";

describe("process stream adapter", () => {
  it("hydrates the snapshot, suppresses duplicates, and requests one resync per gap", () => {
    let clock = 0;
    const snapshots: Array<{ current: ProcessCurrent; lastEventId: number }> = [];
    const transitions: ProcessTransition[] = [];
    const resyncs: string[] = [];
    const statuses: ProcessStreamStatus[] = [];
    const stream = createProcessStream({
      url: URL,
      deps: { EventSource: FakeEventSource, now: () => clock },
      onSnapshot: (current, lastEventId) => snapshots.push({ current, lastEventId }),
      onTransition: (event) => transitions.push(event),
      onResync: (reason) => resyncs.push(reason),
      onStatus: (status) => statuses.push(status),
    });

    stream.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("no event source");
    source.onopen?.({});
    source.emit({ type: "stream.ready", seq: 0, streamID: "s1" });
    source.emit({
      type: "process.snapshot",
      seq: 1,
      streamID: "s1",
      current: CURRENT,
      lastEventId: 10,
    });

    expect(snapshots).toEqual([{ current: CURRENT, lastEventId: 10 }]);
    expect(stream.lastEventId()).toBe(10);
    expect(stream.status()).toBe("live");

    source.emit({ type: "process.transition", seq: 2, streamID: "s1", event: transition(12) });
    expect(transitions.map((event) => event.id)).toEqual([12]);
    expect(stream.lastEventId()).toBe(12);

    source.emit({ type: "process.transition", seq: 3, streamID: "s1", event: transition(12) });
    source.emit({ type: "process.transition", seq: 4, streamID: "s1", event: transition(11) });
    expect(transitions.map((event) => event.id)).toEqual([12]);
    expect(resyncs).toEqual(["gap"]);

    clock += 5_000;
    source.emit({ type: "process.transition", seq: 5, streamID: "s1", event: transition(13) });
    expect(transitions.map((event) => event.id)).toEqual([12, 13]);
    expect(stream.lastEventId()).toBe(13);
    expect(statuses).toContain("live");
  });

  it("requests a resync for a warning and a new stream id", () => {
    let clock = 0;
    const resyncs: string[] = [];
    const warnings: string[] = [];
    const stream = createProcessStream({
      url: URL,
      deps: { EventSource: FakeEventSource, now: () => clock },
      onWarning: (code) => warnings.push(code),
      onResync: (reason) => resyncs.push(reason),
    });

    stream.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("no event source");
    source.emit({ type: "stream.ready", seq: 0, streamID: "s1" });
    source.emit({
      type: "process.snapshot",
      seq: 1,
      streamID: "s1",
      current: CURRENT,
      lastEventId: 4,
    });

    clock += 5_000;
    source.emit({
      type: "stream.warning",
      seq: 2,
      streamID: "s1",
      code: "process_buffer_overflow",
    });
    expect(warnings).toEqual(["process_buffer_overflow"]);
    expect(resyncs).toEqual(["warning"]);

    clock += 5_000;
    source.emit({ type: "stream.ready", seq: 0, streamID: "s2" });
    expect(resyncs).toEqual(["warning", "stream-id"]);
  });

  it("closes the source and pauses on 429 without an EventSource retry storm", async () => {
    const limits: string[] = [];
    const statuses: ProcessStreamStatus[] = [];
    const fetchImpl = vi.fn(async () => {
      return { status: 429 } as Response;
    }) as unknown as typeof fetch;
    const stream = createProcessStream({
      url: URL,
      deps: { EventSource: FakeEventSource, fetch: fetchImpl },
      onLimit: (message) => limits.push(message),
      onStatus: (status) => statuses.push(status),
    });

    stream.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("no event source");
    source.fail();

    await vi.waitFor(() => expect(stream.status()).toBe("paused"));

    expect(source.closed).toBe(true);
    expect(source.onerror).toBeNull();
    expect(limits).toHaveLength(1);
    expect(limits[0]).toContain("process streams");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(statuses).toContain("reconnecting");
    expect(statuses).toContain("paused");

    stream.connect(true);
    expect(stream.status()).toBe("connecting");
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
