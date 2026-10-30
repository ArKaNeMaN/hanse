import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatStreamDeps, createChatStream } from "../../ui/chat/stream.js";

interface Frame {
  type: string;
  seq?: number;
  streamID?: string;
  [key: string]: unknown;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emit(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  fail(): void {
    this.onerror?.({});
  }
}

function response(status: number, payload: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  } as unknown as Response;
}

interface Harness {
  deps: ChatStreamDeps;
  fetch: ReturnType<typeof vi.fn>;
  doc: { hidden: boolean; defaultView?: undefined };
  now: { value: number };
  events: Frame[];
  reads: string[];
  resyncs: string[];
  statuses: string[];
  limits: string[];
  authExpired: number;
}

function harness(hidden = false): Harness {
  FakeEventSource.instances = [];
  const events: Frame[] = [];
  const reads: string[] = [];
  const resyncs: string[] = [];
  const statuses: string[] = [];
  const limits: string[] = [];
  const state: Harness = {
    deps: {} as ChatStreamDeps,
    fetch: vi.fn(async () => response(200)),
    doc: { hidden },
    now: { value: 10_000 },
    events,
    reads,
    resyncs,
    statuses,
    limits,
    authExpired: 0,
  };
  state.deps = {
    EventSource: FakeEventSource as unknown as ChatStreamDeps["EventSource"],
    fetch: state.fetch as unknown as typeof fetch,
    document: state.doc as unknown as Document,
    location: {
      pathname: "/chat",
      search: "?app=alpha&project=p",
      hash: "",
      assign: (url: string) => reads.push(url),
    } as unknown as Location,
    now: () => state.now.value,
  };
  return state;
}

function stream(h: Harness, onStatus?: (kind: string) => void) {
  return createChatStream({
    url: "/api/apps/alpha/events?project=p",
    deps: h.deps,
    onEvent: (event) => h.events.push(event as unknown as Frame),
    onResync: (reason) => h.resyncs.push(reason),
    onStatus: (kind) => {
      h.statuses.push(kind);
      onStatus?.(kind);
    },
    onLimit: (message) => h.limits.push(message),
    onAuthExpired: () => {
      h.authExpired += 1;
    },
  });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat stream adapter", () => {
  it("opens one EventSource and resets on every stream.ready frame", () => {
    const h = harness();
    const adapter = stream(h);
    adapter.connect();
    adapter.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");

    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "s1" });
    expect(adapter.status()).toBe("live");
    expect(adapter.streamID()).toBe("s1");

    source.emit({ type: "session.status", seq: 1, streamID: "s1" });
    source.emit({ type: "session.status", seq: 1, streamID: "s1" });
    expect(h.events.filter((event) => event.type === "session.status")).toHaveLength(1);

    source.emit({ type: "session.status", seq: 5, streamID: "s1" });
    expect(h.resyncs).toEqual(["gap"]);

    source.emit({ type: "session.status", seq: 6, streamID: "s2" });
    expect(h.resyncs).toEqual(["gap", "stream-id"]);

    source.emit({ type: "stream.ready", seq: 0, streamID: "s3" });
    expect(adapter.streamID()).toBe("s3");
    expect(adapter.lastSeq("s3")).toBe(0);
    adapter.dispose();
    expect(source.closed).toBe(true);
  });

  it("keeps hidden failures out of the client counter and probes", async () => {
    const h = harness(true);
    const adapter = stream(h);
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");

    source.fail();
    source.fail();
    source.fail();
    expect(adapter.failures()).toBe(0);
    expect(adapter.status()).toBe("reconnecting");
    expect(source.closed).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("pauses after three visible failures and probes the limit once", async () => {
    const h = harness();
    h.fetch.mockResolvedValue(response(429, { code: "stream_limit" }));
    const adapter = stream(h);
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");

    source.fail();
    source.fail();
    expect(adapter.status()).toBe("reconnecting");
    source.fail();
    await vi.waitFor(() => expect(h.limits).toHaveLength(1));
    expect(source.closed).toBe(true);
    expect(adapter.status()).toBe("paused");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(String(h.fetch.mock.calls[0]?.[0])).toBe("/api/apps/alpha/events?project=p");

    // No fourth attempt and no second limit probe.
    source.fail();
    expect(adapter.failures()).toBe(3);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });

  it("treats a 401 pause as auth expiry once per pause window with a cooldown", async () => {
    const h = harness();
    h.fetch.mockResolvedValue(response(401, {}));
    const adapter = stream(h);
    adapter.connect();
    let source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.fail();
    source.fail();
    source.fail();
    await vi.waitFor(() => expect(h.authExpired).toBe(1));
    expect(adapter.status()).toBe("paused");
    expect(h.fetch).toHaveBeenCalledTimes(2);

    // A manual retry in the same 5 s window must not probe again.
    adapter.connect(true);
    source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error("missing retry source");
    source.fail();
    source.fail();
    source.fail();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.authExpired).toBe(1);
    // The limit probe still runs once; only the auth probe is suppressed by the cooldown.
    expect(h.fetch).toHaveBeenCalledTimes(3);

    // After the cooldown the next bounded pause probes again.
    h.now.value += 6000;
    adapter.connect(true);
    source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error("missing second retry source");
    source.fail();
    source.fail();
    source.fail();
    await vi.waitFor(() => expect(h.authExpired).toBe(2));
    expect(h.fetch).toHaveBeenCalledTimes(5);
    adapter.dispose();
  });

  it("stays paused when the auth probe returns 200", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(response(200, {})).mockResolvedValue(response(200, {}));
    const adapter = stream(h);
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.fail();
    source.fail();
    source.fail();
    await vi.waitFor(() => expect(adapter.status()).toBe("paused"));
    await Promise.resolve();
    expect(h.authExpired).toBe(0);
    expect(h.reads).toEqual([]);
    adapter.dispose();
  });

  it("dispose closes the source and ignores stale callbacks", () => {
    const h = harness();
    const adapter = stream(h);
    adapter.connect();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    adapter.dispose();
    expect(source.closed).toBe(true);
    source.emit({ type: "stream.ready", seq: 0, streamID: "s1" });
    source.fail();
    expect(adapter.status()).toBe("connecting");
    expect(h.events).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
