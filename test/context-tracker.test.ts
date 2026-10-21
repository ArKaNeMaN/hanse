import { describe, expect, it } from "vitest";
import type { OpencodeMessage, OpencodeSession } from "../src/opencode/client.js";
import {
  CONTEXT_SESSION_INACTIVITY_MS,
  type ContextPolicy,
  type ContextTokens,
  ContextTracker,
  contextPercent,
  formatContextError,
  MAX_CONTEXT_SESSIONS,
  ProviderLimitCache,
  promptTokens,
} from "../src/opencode/context.js";

const MODEL = { providerID: "deepseek", modelID: "deepseek-flash" };

function policy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    enabled: true,
    percent: 80,
    model: "deepseek/deepseek-flash",
    enabledSource: "app",
    percentSource: "global",
    ...overrides,
  };
}

function messageUpdated(
  sessionID: string,
  messageID: string,
  extra: Record<string, unknown> = {},
): { type: string; [key: string]: unknown } {
  return {
    type: "message.updated",
    sessionID,
    messageID,
    role: "assistant",
    model: MODEL,
    ...extra,
  };
}

function stepFinish(
  sessionID: string,
  messageID: string,
  tokens: ContextTokens,
  partID = `${messageID}-step`,
): { type: string; [key: string]: unknown } {
  return {
    type: "message.part.updated",
    sessionID,
    messageID,
    partID,
    partType: "step-finish",
    part: { id: partID, messageID, type: "step-finish", tokens },
  };
}

function assistantMessage(
  id: string,
  tokens: Record<string, unknown>,
  time: number,
  summary = false,
): OpencodeMessage {
  return {
    info: {
      id,
      role: "assistant",
      providerID: MODEL.providerID,
      modelID: MODEL.modelID,
      tokens,
      time: { completed: time },
      ...(summary ? { summary: true } : {}),
    },
    parts: [],
  };
}

function compactionMessage(id: string, time: number): OpencodeMessage {
  return {
    info: { id, role: "user", time: { created: time } },
    parts: [{ type: "compaction", time: { created: time } }],
  };
}

describe("promptTokens", () => {
  it("sums input and cache reads/writes", () => {
    expect(promptTokens({ input: 100, output: 20, cache: { read: 30, write: 5 } })).toBe(135);
    expect(promptTokens({ input: 10, cacheRead: 4, cacheWrite: 6 })).toBe(20);
  });

  it("treats missing and zero fields as zero", () => {
    expect(promptTokens({})).toBe(0);
    expect(promptTokens({ input: 0, cache: { read: 0, write: 0 } })).toBe(0);
    expect(promptTokens(null)).toBe(0);
    expect(promptTokens(undefined)).toBe(0);
  });

  it("ignores malformed cache fields", () => {
    expect(promptTokens({ input: 10, cache: { read: -5, write: Number.NaN } })).toBe(10);
    expect(promptTokens({ input: Number.POSITIVE_INFINITY, cacheRead: 7 })).toBe(7);
  });
});

describe("contextPercent", () => {
  it("rounds and may exceed 100", () => {
    expect(contextPercent(115, 1000)).toBe(12);
    expect(contextPercent(1500, 1000)).toBe(150);
  });

  it("is null when either side is missing, non-positive, or malformed", () => {
    expect(contextPercent(null, 1000)).toBeNull();
    expect(contextPercent(10, null)).toBeNull();
    expect(contextPercent(10, 0)).toBeNull();
    expect(contextPercent(10, -1)).toBeNull();
    expect(contextPercent(Number.NaN, 1000)).toBeNull();
  });
});

describe("formatContextError", () => {
  it("maps fixed codes to human strings", () => {
    expect(formatContextError("compaction_failed")).toContain("failed");
    expect(formatContextError("compaction_timeout")).toContain("timed out");
    expect(formatContextError("compaction_unavailable")).toContain("unavailable");
  });
});

describe("ContextTracker usage", () => {
  it("accepts step-finish before the message finish and keeps it authoritative", () => {
    const tracker = new ContextTracker();
    tracker.setModelLimit("s", MODEL, 1000, 0);
    tracker.applyEvent(messageUpdated("s", "m"), 10);
    tracker.applyEvent(stepFinish("s", "m", { input: 100, cache: { read: 10, write: 5 } }), 11);
    tracker.applyEvent(messageUpdated("s", "m", { finish: "stop", usage: { input: 999 } }), 12);

    const snapshot = tracker.snapshot("s", policy(), 13);
    expect(snapshot.used).toBe(115);
    expect(snapshot.percent).toBe(12);
    expect(snapshot.state).toBe("ready");
  });

  it("uses the finished message usage as the fallback", () => {
    const tracker = new ContextTracker();
    tracker.setModelLimit("s", MODEL, 1000, 0);
    tracker.applyEvent(
      messageUpdated("s", "m", {
        finish: "stop",
        usage: { input: 50, cache: { read: 5, write: 5 } },
      }),
      10,
    );

    expect(tracker.snapshot("s", policy(), 11).used).toBe(60);
  });

  it("excludes summary messages and their step-finish parts", () => {
    const tracker = new ContextTracker();
    tracker.applyEvent(messageUpdated("s", "m", { usage: { input: 10 } }), 10);
    tracker.applyEvent(
      messageUpdated("s", "summary", { summary: true, usage: { input: 500 } }),
      11,
    );
    tracker.applyEvent(stepFinish("s", "summary", { input: 500 }), 12);

    const snapshot = tracker.snapshot("s", policy(), 13);
    expect(snapshot.used).toBe(10);
    expect(snapshot.model).toEqual(MODEL);
  });

  it("applies a step-finish received before its model metadata once metadata arrives", () => {
    const tracker = new ContextTracker();
    tracker.applyEvent(stepFinish("s", "m", { input: 70, cacheRead: 3 }), 10);
    tracker.applyEvent(messageUpdated("s", "m"), 11);

    expect(tracker.snapshot("s", policy(), 12).used).toBe(73);
  });

  it("marks live compaction parts compacting but not historical ones", () => {
    const live = new ContextTracker();
    live.applyEvent(
      {
        type: "message.part.updated",
        sessionID: "s",
        messageID: "m",
        partID: "p",
        partType: "compaction",
        part: { id: "p", messageID: "m", type: "compaction" },
      },
      10,
    );
    expect(live.snapshot("s", policy(), 11).state).toBe("compacting");

    const historical = new ContextTracker();
    historical.hydrate("s", [compactionMessage("c", 100)], [{ id: "s" }], 200);
    expect(historical.snapshot("s", policy(), 201).state).not.toBe("compacting");
  });

  it("tracks status transitions", () => {
    const tracker = new ContextTracker();
    expect(tracker.snapshot("s", policy(), 1).status).toBe("unknown");
    tracker.applyEvent({ type: "session.status", sessionID: "s", status: { type: "busy" } }, 2);
    expect(tracker.snapshot("s", policy(), 3).status).toBe("busy");
    tracker.applyEvent({ type: "session.idle", sessionID: "s" }, 4);
    expect(tracker.snapshot("s", policy(), 5).status).toBe("idle");
    tracker.applyEvent({ type: "session.status", sessionID: "s", status: { type: "retry" } }, 6);
    expect(tracker.snapshot("s", policy(), 7).status).toBe("retry");
    tracker.applyEvent({ type: "session.status", sessionID: "s", status: { type: "wat" } }, 8);
    expect(tracker.snapshot("s", policy(), 9).status).toBe("unknown");
  });

  it("isolates usage between sessions", () => {
    const tracker = new ContextTracker();
    tracker.applyEvent(messageUpdated("a", "ma", { usage: { input: 10 } }), 10);
    tracker.applyEvent(messageUpdated("b", "mb", { usage: { input: 20 } }), 11);

    expect(tracker.snapshot("a", policy(), 12).used).toBe(10);
    expect(tracker.snapshot("b", policy(), 12).used).toBe(20);
  });
});

describe("ContextTracker bounds", () => {
  it("evicts the oldest session at the 500-session cap", () => {
    const tracker = new ContextTracker();
    for (let index = 0; index <= MAX_CONTEXT_SESSIONS; index += 1) {
      tracker.applyEvent(
        { type: "session.status", sessionID: `s${index}`, status: { type: "idle" } },
        1000,
      );
    }
    expect(tracker.sessionCount).toBe(MAX_CONTEXT_SESSIONS);
    expect(tracker.hasSession("s0")).toBe(false);
    expect(tracker.hasSession(`s${MAX_CONTEXT_SESSIONS}`)).toBe(true);
  });

  it("evicts sessions inactive for 24 hours", () => {
    const tracker = new ContextTracker();
    tracker.applyEvent({ type: "session.status", sessionID: "old", status: { type: "idle" } }, 0);
    tracker.applyEvent(
      { type: "session.status", sessionID: "new", status: { type: "idle" } },
      CONTEXT_SESSION_INACTIVITY_MS,
    );
    expect(tracker.hasSession("old")).toBe(false);
    expect(tracker.hasSession("new")).toBe(true);
    expect(tracker.sessionCount).toBe(1);
  });
});

describe("ContextTracker compaction state", () => {
  it("session.compacted resets usage but keeps the last model and limit", () => {
    const tracker = new ContextTracker();
    tracker.setModelLimit("s", MODEL, 1000, 10);
    tracker.applyEvent(messageUpdated("s", "m", { usage: { input: 400 } }), 20);
    tracker.applyEvent({ type: "session.compacted", sessionID: "s" }, 2000);

    const snapshot = tracker.snapshot("s", policy(), 2001);
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.used).toBeNull();
    expect(snapshot.limit).toBe(1000);
    expect(snapshot.percent).toBeNull();
    expect(snapshot.model).toEqual(MODEL);
    expect(snapshot.lastCompactedAt).toBe(new Date(2000).toISOString());

    tracker.applyEvent(messageUpdated("s", "m2", { usage: { input: 250 } }), 2002);
    expect(tracker.snapshot("s", policy(), 2003).used).toBe(250);
  });

  it("accepts a late session.compacted after a timeout without re-arming", () => {
    const tracker = new ContextTracker();
    const effective = policy({ percent: 80 });
    tracker.setSessionParents([{ id: "s" }]);
    tracker.setModelLimit("s", MODEL, 1000, 0);
    tracker.applyEvent({ type: "session.idle", sessionID: "s" }, 500);
    tracker.noteUsage("s", { input: 900 }, MODEL, 1000);
    tracker.markAutoAttempt("s", 1000);
    tracker.markCompactionFailure("s", "compaction_timeout", 1000);
    expect(tracker.snapshot("s", effective, 1001).lastError).toBe("compaction_timeout");

    tracker.applyEvent({ type: "session.compacted", sessionID: "s" }, 2000);
    const snapshot = tracker.snapshot("s", effective, 2001);
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.state).toBe("unknown");
    expect(snapshot.lastCompactedAt).toBe(new Date(2000).toISOString());
    expect(snapshot.model).toEqual(MODEL);

    tracker.noteUsage("s", { input: 900 }, MODEL, 2002);
    const decision = tracker.evaluateAutoCompact("s", effective, 2003);
    expect(decision.trigger).toBe(false);
    expect(decision.ineffective).toBe(true);
  });
});

describe("ContextTracker hydration", () => {
  it("keeps usage newer than the newest compaction boundary", () => {
    const tracker = new ContextTracker();
    tracker.hydrate(
      "s",
      [
        assistantMessage("m1", { input: 100 }, 100),
        compactionMessage("c1", 200),
        assistantMessage("m2", { input: 300 }, 300),
      ],
      [{ id: "s" }],
      400,
    );

    const snapshot = tracker.snapshot("s", policy(), 401);
    expect(snapshot.used).toBe(300);
    expect(snapshot.model).toEqual(MODEL);
    expect(snapshot.lastCompactedAt).toBe(new Date(200).toISOString());
  });

  it("makes usage unknown when the compaction boundary is newer", () => {
    const tracker = new ContextTracker();
    tracker.hydrate(
      "s",
      [assistantMessage("m1", { input: 100 }, 100), compactionMessage("c1", 200)],
      [{ id: "s" }],
      300,
    );

    const snapshot = tracker.snapshot("s", policy(), 301);
    expect(snapshot.used).toBeNull();
    expect(snapshot.model).toEqual(MODEL);
    expect(snapshot.lastCompactedAt).toBe(new Date(200).toISOString());
  });

  it("ignores summary-only history", () => {
    const tracker = new ContextTracker();
    tracker.hydrate("s", [assistantMessage("sum", { input: 500 }, 100, true)], [{ id: "s" }], 200);

    const snapshot = tracker.snapshot("s", policy(), 201);
    expect(snapshot.used).toBeNull();
    expect(snapshot.model).toBeNull();
    expect(snapshot.lastCompactedAt).toBe(new Date(100).toISOString());
  });

  it("derives parentID and excludes child sessions from the top level", () => {
    const tracker = new ContextTracker();
    const sessions: OpencodeSession[] = [{ id: "child", parentID: "parent" }, { id: "parent" }];
    tracker.hydrate("child", [], sessions, 100);

    expect(tracker.isTopLevel("child")).toBe(false);
    expect(tracker.isTopLevel("parent")).toBe(true);
    expect(tracker.isTopLevel("missing")).toBe(false);
  });

  it("ignores malformed history", () => {
    const tracker = new ContextTracker();
    const messages: OpencodeMessage[] = [
      {
        info: { id: "m", role: "assistant", tokens: { input: "nope" }, time: {} },
        parts: [{ type: "compaction" }],
      },
      { info: { id: "", role: "assistant" }, parts: [] },
    ];
    tracker.hydrate("s", messages, [], 100);

    const snapshot = tracker.snapshot("s", policy(), 101);
    expect(snapshot.used).toBeNull();
    expect(snapshot.model).toBeNull();
  });

  it("handles an empty history", () => {
    const tracker = new ContextTracker();
    tracker.hydrate("s", [], [], 100);

    const snapshot = tracker.snapshot("s", policy(), 101);
    expect(snapshot.used).toBeNull();
    expect(snapshot.model).toBeNull();
    expect(snapshot.lastCompactedAt).toBeNull();
    expect(tracker.isTopLevel("s")).toBe(false);
  });
});

describe("ProviderLimitCache limits", () => {
  const payload = {
    providers: [
      {
        id: "deepseek",
        models: {
          "deepseek-flash": {
            limit: { context: 200000, input: 150000, output: 8192 },
            extra: "not retained",
          },
        },
      },
    ],
  };

  it("returns limits and caches a successful lookup for its lifetime", async () => {
    let calls = 0;
    const cache = new ProviderLimitCache(async () => {
      calls += 1;
      return payload;
    }, 0);

    expect(await cache.lookup("deepseek", "deepseek-flash")).toEqual({
      context: 200000,
      input: 150000,
      output: 8192,
    });
    expect(await cache.lookup("deepseek", "deepseek-flash")).toEqual({
      context: 200000,
      input: 150000,
      output: 8192,
    });
    expect(await cache.lookup("deepseek", "missing")).toEqual({
      context: null,
      input: null,
      output: null,
    });
    expect(calls).toBe(1);
  });

  it("backs off 60 seconds after a failed load and never throws", async () => {
    let now = 0;
    let calls = 0;
    let shouldFail = true;
    const cache = new ProviderLimitCache(
      async () => {
        calls += 1;
        if (shouldFail) throw new Error("provider catalog unavailable");
        return payload;
      },
      () => now,
    );

    expect(await cache.lookup("deepseek", "deepseek-flash")).toEqual({
      context: null,
      input: null,
      output: null,
    });
    expect(calls).toBe(1);
    shouldFail = false;
    now = 59_999;
    expect(await cache.lookup("deepseek", "deepseek-flash")).toEqual({
      context: null,
      input: null,
      output: null,
    });
    expect(calls).toBe(1);
    now = 60_000;
    expect(await cache.lookup("deepseek", "deepseek-flash")).toEqual({
      context: 200000,
      input: 150000,
      output: 8192,
    });
    expect(calls).toBe(2);
  });

  it("ignores malformed provider payloads and non-positive limits", async () => {
    const cache = new ProviderLimitCache(
      async () => ({
        providers: [
          {
            id: "p",
            models: {
              bad: { limit: { context: -1, input: "x", output: Number.NaN } },
              partial: { limit: { context: 100, input: 0, output: 25 } },
            },
          },
          { id: "", models: {} },
        ],
      }),
      0,
    );

    expect(await cache.lookup("p", "bad")).toEqual({
      context: null,
      input: null,
      output: null,
    });
    expect(await cache.lookup("p", "partial")).toEqual({
      context: 100,
      input: null,
      output: 25,
    });
  });

  it("retains only the three numeric limits", async () => {
    const cache = new ProviderLimitCache(async () => payload, 0);
    const limits = await cache.lookup("deepseek", "deepseek-flash");
    expect(Object.keys(limits).sort()).toEqual(["context", "input", "output"]);
  });
});
