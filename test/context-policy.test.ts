import { describe, expect, it } from "vitest";
import {
  type AutoCompactDecision,
  type AutoCompactState,
  autoCompactDecision,
  type ContextPolicy,
  ContextTracker,
} from "../src/opencode/context.js";

const MODEL = { providerID: "deepseek", modelID: "deepseek-flash" };
const OTHER_MODEL = { providerID: "moonshot", modelID: "kimi" };

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

function armKey(percent: number, model = MODEL): string {
  return `${model.providerID}/${model.modelID}@${percent}`;
}

function baseState(overrides: Partial<AutoCompactState> = {}): AutoCompactState {
  return {
    state: "ready",
    status: "idle",
    used: 900,
    limit: 1000,
    model: MODEL,
    compacting: false,
    topLevel: true,
    armed: true,
    armKey: armKey(80),
    failureCooldownUntil: null,
    usageAt: 1000,
    lastCompactedAt: null,
    postCompactionPending: false,
    ineffective: false,
    ...overrides,
  };
}

function applyDecision(state: AutoCompactState, decision: AutoCompactDecision): AutoCompactState {
  return {
    ...state,
    armed: decision.armed,
    armKey: decision.armKey,
    failureCooldownUntil: decision.failureCooldownUntil,
    postCompactionPending: decision.postCompactionPending,
    ineffective: decision.ineffective,
  };
}

function idleTracker(): ContextTracker {
  const tracker = new ContextTracker();
  tracker.setSessionParents([{ id: "s" }]);
  tracker.setModelLimit("s", MODEL, 1000, 0);
  tracker.applyEvent({ type: "session.idle", sessionID: "s" }, 0);
  return tracker;
}

describe("autoCompactDecision hysteresis floors", () => {
  it.each([
    { percent: 1, above: 1, below: 0.9 },
    { percent: 5, above: 5, below: 0.9 },
    { percent: 6, above: 6, below: 0.9 },
    { percent: 80, above: 80, below: 74.99 },
  ])("uses the floor for threshold $percent", ({ percent, above, below }) => {
    const limit = 10_000;
    const aboveUsed = (above / 100) * limit;
    const belowUsed = (below / 100) * limit;
    const effective = policy({ percent });

    let state = baseState({
      used: aboveUsed,
      limit,
      armed: false,
      armKey: armKey(percent),
    });
    let decision = autoCompactDecision(state, effective, 1000);
    expect(decision.trigger).toBe(false);

    state = { ...applyDecision(state, decision), used: belowUsed };
    decision = autoCompactDecision(state, effective, 1001);
    expect(decision.armed).toBe(true);
    expect(decision.trigger).toBe(false);

    state = { ...applyDecision(state, decision), used: aboveUsed };
    decision = autoCompactDecision(state, effective, 1002);
    expect(decision.trigger).toBe(true);
    expect(decision.armed).toBe(false);
  });
});

describe("autoCompactDecision guards", () => {
  it("carries a busy crossing over to the idle transition", () => {
    const effective = policy();
    let state = baseState({ status: "busy", armed: false, armKey: null });
    let decision = autoCompactDecision(state, effective, 1000);
    expect(decision.trigger).toBe(false);

    state = { ...applyDecision(state, decision), status: "idle" };
    decision = autoCompactDecision(state, effective, 1001);
    expect(decision.trigger).toBe(true);
  });

  it("latches after a trigger until usage drops below the floor", () => {
    const effective = policy();
    let state = baseState();
    let decision = autoCompactDecision(state, effective, 1000);
    expect(decision.trigger).toBe(true);
    expect(decision.armed).toBe(false);

    state = applyDecision(state, decision);
    decision = autoCompactDecision(state, effective, 1001);
    expect(decision.trigger).toBe(false);
  });

  it("does not trigger when disabled, small, child, compacting, or missing model/limit", () => {
    const cases: Array<{ state: AutoCompactState; effective: ContextPolicy }> = [
      { state: baseState(), effective: policy({ enabled: false }) },
      { state: baseState({ used: null }), effective: policy() },
      { state: baseState({ limit: null }), effective: policy() },
      { state: baseState({ limit: 0 }), effective: policy() },
      { state: baseState({ model: null }), effective: policy() },
      { state: baseState({ topLevel: false }), effective: policy() },
      { state: baseState({ compacting: true, state: "compacting" }), effective: policy() },
      { state: baseState({ status: "unknown" }), effective: policy() },
      { state: baseState({ status: "busy" }), effective: policy() },
    ];

    for (const entry of cases) {
      expect(autoCompactDecision(entry.state, entry.effective, 1000).trigger).toBe(false);
    }
  });

  it("re-arms when the model changes", () => {
    const effective = policy();
    let state = baseState({ armed: false, armKey: armKey(80) });
    let decision = autoCompactDecision(state, effective, 1000);
    expect(decision.trigger).toBe(false);

    state = { ...applyDecision(state, decision), model: OTHER_MODEL };
    decision = autoCompactDecision(state, effective, 1001);
    expect(decision.trigger).toBe(true);
  });

  it("re-arms when the threshold changes", () => {
    const state = baseState({ armed: false, armKey: armKey(90) });
    const decision = autoCompactDecision(state, policy({ percent: 70 }), 1000);
    expect(decision.trigger).toBe(true);
  });
});

describe("autoCompactDecision failure cooldown", () => {
  it("measures the cooldown from the failure instant and retries once after it", () => {
    const tracker = idleTracker();
    const effective = policy();
    tracker.noteUsage("s", { input: 900 }, MODEL, 0);
    tracker.markAutoAttempt("s", 0);
    // Failure two minutes after the attempt: the 5 minute cooldown ends at 7 minutes.
    tracker.markCompactionFailure("s", "compaction_failed", 120_000);
    // Usage 6.5 minutes in is after a lastAttempt-based cooldown but before the failure-based one.
    tracker.noteUsage("s", { input: 900 }, MODEL, 390_000);

    expect(tracker.evaluateAutoCompact("s", effective, 391_000).trigger).toBe(false);

    // The first new usage after 7 minutes re-arms and triggers once.
    tracker.noteUsage("s", { input: 900 }, MODEL, 421_000);
    const retry = tracker.evaluateAutoCompact("s", effective, 422_000);
    expect(retry.trigger).toBe(true);
    expect(retry.armed).toBe(false);
  });

  it("does not retry on usage observed during the cooldown", () => {
    const tracker = idleTracker();
    const effective = policy();
    tracker.noteUsage("s", { input: 900 }, MODEL, 0);
    tracker.markAutoAttempt("s", 0);
    tracker.markCompactionFailure("s", "compaction_timeout", 0);
    tracker.noteUsage("s", { input: 900 }, MODEL, 60_000);

    expect(tracker.evaluateAutoCompact("s", effective, 301_000).trigger).toBe(false);
  });
});

describe("autoCompactDecision ineffective latch", () => {
  it("latches when post-compaction usage is still above the threshold", () => {
    const tracker = idleTracker();
    const effective = policy();
    tracker.noteUsage("s", { input: 850 }, MODEL, 0);
    expect(tracker.evaluateAutoCompact("s", effective, 1).trigger).toBe(true);

    tracker.markAutoAttempt("s", 1);
    tracker.markCompactionSuccess("s", 2);
    tracker.noteUsage("s", { input: 850 }, MODEL, 3);
    const latched = tracker.evaluateAutoCompact("s", effective, 4);
    expect(latched.trigger).toBe(false);
    expect(latched.ineffective).toBe(true);

    tracker.noteUsage("s", { input: 700 }, MODEL, 5);
    const belowFloor = tracker.evaluateAutoCompact("s", effective, 6);
    expect(belowFloor.trigger).toBe(false);
    expect(belowFloor.ineffective).toBe(false);
    expect(belowFloor.armed).toBe(true);

    tracker.noteUsage("s", { input: 850 }, MODEL, 7);
    expect(tracker.evaluateAutoCompact("s", effective, 8).trigger).toBe(true);
  });
});

describe("autoCompactDecision unavailable", () => {
  it("records compaction_unavailable without starting a retry", () => {
    const tracker = idleTracker();
    const effective = policy();
    tracker.noteUsage("s", { input: 900 }, MODEL, 0);
    expect(tracker.evaluateAutoCompact("s", effective, 1).trigger).toBe(true);
    tracker.markAutoAttempt("s", 2);
    tracker.markCompactionUnavailable("s", 3);

    const snapshot = tracker.snapshot("s", effective, 4);
    expect(snapshot.lastError).toBe("compaction_unavailable");
    expect(snapshot.state).toBe("ready");
    expect(tracker.evaluateAutoCompact("s", effective, 5).trigger).toBe(false);
  });

  it("never triggers for a summary-only session", () => {
    const tracker = idleTracker();
    const effective = policy();
    tracker.applyEvent(
      {
        type: "message.updated",
        sessionID: "s",
        messageID: "summary",
        role: "assistant",
        model: MODEL,
        summary: true,
        usage: { input: 900 },
      },
      0,
    );
    expect(tracker.evaluateAutoCompact("s", effective, 1).trigger).toBe(false);
  });
});
