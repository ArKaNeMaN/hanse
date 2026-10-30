import { beforeEach, describe, expect, it } from "vitest";
import {
  blockQueuePromotion,
  clearChatSessionState,
  clearChatWorkspaceState,
  clearImageIntent,
  imageIntentStorageKey,
  queueBlockedStorageKey,
  queuePromotionAllowed,
  readImageIntent,
  readQueuePromotionBlocks,
  unblockQueuePromotion,
  writeImageIntent,
} from "../../ui/chat/session-storage.js";

const ALPHA = { app: "alpha", project: "p" };
const BETA = { app: "beta", project: "p" };

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("chat session storage", () => {
  it("namespaces queue suppression and image intent by app/project", () => {
    blockQueuePromotion(ALPHA, "s1");
    writeImageIntent(ALPHA, { action: "build_start", startedAt: 123 });

    expect(queueBlockedStorageKey(ALPHA)).toBe("hanse-chat-queue-blocked:p:alpha");
    expect(imageIntentStorageKey(ALPHA)).toBe("hanse.chat.imageIntent:p:alpha");
    expect([...readQueuePromotionBlocks(ALPHA)]).toEqual(["s1"]);
    expect([...readQueuePromotionBlocks(BETA)]).toEqual([]);
    expect(readImageIntent(ALPHA)).toEqual({ action: "build_start", startedAt: 123 });
    expect(readImageIntent(BETA)).toBeNull();
  });

  it("keeps the legacy queue-promotion idle rule", () => {
    blockQueuePromotion(ALPHA, "s1");
    expect(queuePromotionAllowed(ALPHA, "s1", "busy")).toBe(true);
    expect(queuePromotionAllowed(ALPHA, "s1", "retry")).toBe(true);
    expect(queuePromotionAllowed(ALPHA, "s1", "idle")).toBe(false);
    expect(queuePromotionAllowed(ALPHA, "s1", undefined)).toBe(false);
    expect(queuePromotionAllowed(ALPHA, "other", "busy")).toBe(true);
    unblockQueuePromotion(ALPHA, "s1");
    expect(queuePromotionAllowed(ALPHA, "s1", "busy")).toBe(true);
  });

  it("clears one session without touching another workspace or sibling session", () => {
    blockQueuePromotion(ALPHA, "s1");
    blockQueuePromotion(ALPHA, "s2");
    blockQueuePromotion(BETA, "s1");
    writeImageIntent(ALPHA, { action: "rebuild_restart", startedAt: 5 });

    clearChatSessionState(ALPHA, "s1");

    expect([...readQueuePromotionBlocks(ALPHA)]).toEqual(["s2"]);
    expect(readImageIntent(ALPHA)).toBeNull();
    expect([...readQueuePromotionBlocks(BETA)]).toEqual(["s1"]);
  });

  it("clears every chat key for one workspace on route leave/app switch", () => {
    blockQueuePromotion(ALPHA, "s1");
    blockQueuePromotion(ALPHA, "s2");
    writeImageIntent(ALPHA, { action: "build_start", startedAt: 1 });
    blockQueuePromotion(BETA, "s3");

    clearChatWorkspaceState(ALPHA);

    expect([...readQueuePromotionBlocks(ALPHA)]).toEqual([]);
    expect(readImageIntent(ALPHA)).toBeNull();
    expect([...readQueuePromotionBlocks(BETA)]).toEqual(["s3"]);
  });

  it("ignores malformed image intent and storage failures", () => {
    const key = imageIntentStorageKey(ALPHA);
    if (key !== null) {
      window.sessionStorage.setItem(key, "{not json");
    }
    expect(readImageIntent(ALPHA)).toBeNull();
    clearImageIntent(ALPHA);
    expect(readImageIntent(ALPHA)).toBeNull();
  });
});
