import { describe, expect, it } from "vitest";
import { applySnapshot, deriveQueue } from "../assets/chat-core.js";
import { createThreadStore } from "../assets/chat-feed-store.js";
import { deriveTurn } from "../src/chat/turn.js";
import { busyStatus, idleStatus, turnFixtures } from "./fixtures/chat-turn.js";

const OPTIONS = { isSubagent: false, settling: false, queuedTruncated: false };

function clientPending(messages: readonly unknown[], statusType: string): string[] {
  const store = createThreadStore(null);
  const { store: applied } = applySnapshot(store, messages, { position: "replace" });
  const derived = deriveQueue(applied, { sessionStatusType: statusType });
  return derived.activeID === null
    ? [...derived.queuedIDs]
    : [derived.activeID, ...derived.queuedIDs];
}

describe("server deriveTurn and client deriveQueue parity", () => {
  const cases = [
    ["completed turn", turnFixtures.completedTurn, idleStatus, "idle"],
    ["busy before the first part", turnFixtures.busyPreFirstPart, busyStatus, "busy"],
    ["busy with a queued prompt", turnFixtures.busyWithQueue, busyStatus, "busy"],
    ["multi-step turn with a queued prompt", turnFixtures.multiStep, busyStatus, "busy"],
    ["attachment-only queue", turnFixtures.attachmentOnlyQueue, idleStatus, "idle"],
  ] as const;

  for (const [name, messages, status, statusType] of cases) {
    it(`agrees on the pending prompt order for ${name}`, () => {
      const server = deriveTurn(messages, status, OPTIONS);
      expect(clientPending(messages, statusType)).toEqual(server.queuedPromptIDs);
    });
  }

  it("consumes the interrupted prompt that the retired client deriver would count", () => {
    const server = deriveTurn(turnFixtures.resumeAfterInterrupted, busyStatus, OPTIONS);
    expect(server.queuedPromptIDs).toEqual([]);
    expect(clientPending(turnFixtures.resumeAfterInterrupted, "busy")).toEqual([
      "msg_u1",
      "msg_resume",
    ]);
  });

  it("sets runningPromptID only for a non-continuing busy turn", () => {
    const preFirst = deriveTurn(turnFixtures.busyPreFirstPart, busyStatus, OPTIONS);
    expect(preFirst.runningPromptID).toBe("msg_u1");
    expect(preFirst.queuedPromptIDs).toEqual(["msg_u1"]);

    const multi = deriveTurn(turnFixtures.multiStep, busyStatus, OPTIONS);
    expect(multi.turnContinues).toBe(true);
    expect(multi.runningPromptID).toBeNull();
    expect(multi.queuedPromptIDs).toEqual(["msg_u2"]);

    const idle = deriveTurn(turnFixtures.busyWithQueue, idleStatus, OPTIONS);
    expect(idle.runningPromptID).toBeNull();
    expect(idle.activePromptID).toBe("msg_u2");
  });
});
