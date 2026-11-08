import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnSnapshot } from "../../src/chat/turn.js";
import { useChatTurnStore } from "../../ui/chat/turn-state.js";

function response(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    json: async () => body,
  } as unknown as Response;
}

function snapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    sessionID: "s1",
    status: { type: "idle" },
    turnContinues: false,
    runningPromptID: null,
    activePromptID: null,
    queuedPromptIDs: [],
    queuedTruncated: false,
    settling: false,
    revision: "rev-1",
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function store() {
  const turn = useChatTurnStore();
  turn.bindScope("alpha", "p");
  turn.open("s1");
  return turn;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chat turn state", () => {
  it("applies a snapshot and computes the T13 display count", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response(
          200,
          snapshot({
            status: { type: "busy" },
            queuedPromptIDs: ["msg_1", "msg_2"],
            runningPromptID: "msg_1",
            activePromptID: "msg_1",
            revision: "rev-busy",
          }),
        ),
      ),
    );
    const turn = store();
    await turn.refresh("s1", "open");
    expect(turn.turnRevision).toBe("rev-busy");
    expect(turn.status).toEqual({ type: "busy" });
    expect(turn.queuedPromptIDs).toEqual(["msg_1", "msg_2"]);
    expect(turn.displayCount()).toBe(1);
    expect(turn.source).toBe("snapshot");
  });

  it("keeps the last snapshot, marks stale, and retries a 502 with backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, snapshot({ revision: "rev-good" })))
      .mockResolvedValueOnce(response(502, { code: "turn_unavailable" }))
      .mockResolvedValueOnce(response(200, snapshot({ revision: "rev-recovered" })));
    vi.stubGlobal("fetch", fetchMock);
    const turn = store();
    await turn.refresh("s1", "open");
    expect(turn.turnRevision).toBe("rev-good");

    await turn.refresh("s1", "status");
    expect(turn.stale).toBe(true);
    expect(turn.turnRevision).toBe("rev-good");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(turn.turnRevision).toBe("rev-recovered"));
    expect(turn.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("hides the turn surface on 409 and uses the session-gone path on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(409, { code: "deletion_pending" })),
    );
    const turn = store();
    const gone: string[] = [];
    turn.setSessionGoneHandler((id) => gone.push(id));
    await turn.refresh("s1", "open");
    expect(turn.hidden).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(404, { code: "session_not_found" })),
    );
    await turn.refresh("s1", "open");
    expect(gone).toEqual(["s1"]);
  });

  it("discards a late busy snapshot after an abort settle", async () => {
    const busy = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => busy.promise),
    );
    const turn = store();
    const pending = turn.refresh("s1", "open");
    turn.startAbortSettle("s1");
    turn.finishAbortSettle("s1");

    busy.resolve(response(200, snapshot({ status: { type: "busy" }, queuedPromptIDs: ["msg_1"] })));
    await pending;
    expect(turn.status).toEqual({ type: "idle" });
    expect(turn.source).toBe("abort");
    expect(turn.abortSettling).toBe(false);
  });

  it("discards an in-flight snapshot when a live status arrives first", async () => {
    const late = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => late.promise),
    );
    const turn = store();
    const pending = turn.refresh("s1", "open");
    turn.applySseStatus("s1", { type: "retry" });

    late.resolve(response(200, snapshot({ status: { type: "idle" } })));
    await pending;
    expect(turn.status).toEqual({ type: "retry" });
    expect(turn.source).toBe("sse");
  });

  it("discards a response from a switched session", async () => {
    const late = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => late.promise),
    );
    const turn = store();
    const pending = turn.refresh("s1", "open");
    turn.open("s2");

    late.resolve(response(200, snapshot({ status: { type: "busy" } })));
    await pending;
    expect(turn.sessionID).toBe("s2");
    expect(turn.status).toBeNull();
  });

  it("keeps the current phase for an unknown snapshot status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, snapshot({ status: { type: "busy" } })))
      .mockResolvedValueOnce(
        response(200, snapshot({ status: { type: "unknown" }, queuedPromptIDs: ["msg_1"] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const turn = store();
    await turn.refresh("s1", "open");
    expect(turn.status).toEqual({ type: "busy" });

    await turn.refresh("s1", "status");
    expect(turn.queuedPromptIDs).toEqual(["msg_1"]);
    expect(turn.status).toEqual({ type: "busy" });
  });
});
