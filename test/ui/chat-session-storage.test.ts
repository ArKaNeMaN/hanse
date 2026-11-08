import { beforeEach, describe, expect, it } from "vitest";
import {
  clearChatSessionState,
  clearChatWorkspaceState,
  clearImageIntent,
  imageIntentStorageKey,
  readImageIntent,
  writeImageIntent,
} from "../../ui/chat/session-storage.js";

const ALPHA = { app: "alpha", project: "p" };
const BETA = { app: "beta", project: "p" };

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("chat session storage", () => {
  it("namespaces image intent by app/project", () => {
    writeImageIntent(ALPHA, { action: "build_start", startedAt: 123 });

    expect(imageIntentStorageKey(ALPHA)).toBe("hanse.chat.imageIntent:p:alpha");
    expect(readImageIntent(ALPHA)).toEqual({ action: "build_start", startedAt: 123 });
    expect(readImageIntent(BETA)).toBeNull();
  });

  it("clears image intent for one session without touching another workspace", () => {
    writeImageIntent(ALPHA, { action: "rebuild_restart", startedAt: 5 });
    writeImageIntent(BETA, { action: "build_start", startedAt: 7 });

    clearChatSessionState(ALPHA, "s1");

    expect(readImageIntent(ALPHA)).toBeNull();
    expect(readImageIntent(BETA)).toEqual({ action: "build_start", startedAt: 7 });
  });

  it("clears every chat key for one workspace on route leave/app switch", () => {
    writeImageIntent(ALPHA, { action: "build_start", startedAt: 1 });
    writeImageIntent(BETA, { action: "build_start", startedAt: 2 });

    clearChatWorkspaceState(ALPHA);

    expect(readImageIntent(ALPHA)).toBeNull();
    expect(readImageIntent(BETA)).toEqual({ action: "build_start", startedAt: 2 });
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
