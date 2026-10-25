import { describe, expect, it } from "vitest";
import {
  canSendDraft,
  composerAction,
  draftAutoDeleteEligible,
  draftIsEmpty,
  draftTextForSave,
  flushDraftTransport,
  isSlashCommandOnly,
  normalizePendingSends,
  pendingSendActions,
  pendingSendLabel,
  sessionDraftBadge,
} from "../assets/chat-core.js";

describe("isSlashCommandOnly", () => {
  it("matches a bare slash and a single command token", () => {
    expect(isSlashCommandOnly("/")).toBe(true);
    expect(isSlashCommandOnly("/help")).toBe(true);
    expect(isSlashCommandOnly("  /new  ")).toBe(true);
  });

  it("does not match an escaped slash or a token with arguments", () => {
    expect(isSlashCommandOnly("//help")).toBe(false);
    expect(isSlashCommandOnly("/help me")).toBe(false);
    expect(isSlashCommandOnly("hello")).toBe(false);
    expect(isSlashCommandOnly("")).toBe(false);
    expect(isSlashCommandOnly(null)).toBe(false);
  });
});

describe("draft text helpers", () => {
  it("persists whitespace-only text as empty", () => {
    expect(draftTextForSave("   \n\t")).toBe("");
    expect(draftTextForSave("  keep me  ")).toBe("  keep me  ");
    expect(draftTextForSave(null)).toBe("");
  });

  it("treats empty text with no attachments as empty", () => {
    expect(draftIsEmpty({ text: "", attachmentCount: 0 })).toBe(true);
    expect(draftIsEmpty({ text: "   ", attachmentCount: 0 })).toBe(true);
    expect(draftIsEmpty({})).toBe(true);
  });

  it("is not empty with text or with an attachment", () => {
    expect(draftIsEmpty({ text: "hello", attachmentCount: 0 })).toBe(false);
    expect(draftIsEmpty({ text: "", attachmentCount: 1 })).toBe(false);
    expect(canSendDraft({ text: "", attachmentCount: 1 })).toBe(true);
    expect(canSendDraft({ text: "", attachmentCount: 0 })).toBe(false);
  });
});

describe("composerAction with attachments", () => {
  const base = {
    turnActive: true,
    hasDraft: false,
    sessionId: "ses_1",
    acceptanceBusy: false,
    promptsWaiting: false,
    abortPending: false,
  };

  it("keeps Send while only an attachment is present", () => {
    expect(composerAction({ ...base, attachmentCount: 1 })).toEqual({
      mode: "send",
      disabled: false,
    });
    expect(composerAction({ ...base, hasAttachments: true })).toEqual({
      mode: "send",
      disabled: false,
    });
  });

  it("offers Stop only when the composer is empty", () => {
    expect(composerAction(base)).toEqual({ mode: "stop", disabled: false });
    expect(composerAction({ ...base, attachmentCount: 0 })).toEqual({
      mode: "stop",
      disabled: false,
    });
  });
});

describe("sessionDraftBadge", () => {
  it("labels a no-message session with a draft as Draft with a dot", () => {
    expect(sessionDraftBadge({ hasText: true, attachmentCount: 0, emptyDraft: true })).toEqual({
      label: "Draft",
      dot: true,
    });
  });

  it("shows only the dot for a session with messages", () => {
    expect(sessionDraftBadge({ hasText: true, attachmentCount: 0, emptyDraft: false })).toEqual({
      label: "",
      dot: true,
    });
    expect(sessionDraftBadge({ hasText: false, attachmentCount: 2, emptyDraft: false })).toEqual({
      label: "",
      dot: true,
    });
  });

  it("has no badge without a draft", () => {
    expect(sessionDraftBadge(null)).toEqual({ label: "", dot: false });
    expect(sessionDraftBadge({ hasText: false, attachmentCount: 0 })).toEqual({
      label: "",
      dot: false,
    });
  });
});

describe("normalizePendingSends", () => {
  it("keeps valid rows and normalizes states", () => {
    const rows = normalizePendingSends([
      { id: "p1", messageID: "m1", text: "one", state: "sending" },
      { id: "p2", text: "two", state: "failed" },
      { id: "p3", text: "three", state: "unknown" },
      { id: "p4", text: "four", state: "weird" },
      { id: "", text: "dropped" },
      null,
      "nope",
    ]);
    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["p1", "sending"],
      ["p2", "failed"],
      ["p3", "unknown"],
      ["p4", "sending"],
    ]);
    expect(rows[1]).toMatchObject({ messageID: null, text: "two" });
  });

  it("returns an empty array for a missing list", () => {
    expect(normalizePendingSends(undefined)).toEqual([]);
    expect(normalizePendingSends({})).toEqual([]);
  });
});

describe("pending send states", () => {
  it("marks sending read-only", () => {
    expect(pendingSendActions("sending")).toMatchObject({
      readOnly: true,
      canRetry: false,
      canRestore: false,
    });
  });

  it("offers direct Retry for failed and forced Retry anyway for unknown", () => {
    expect(pendingSendActions("failed")).toMatchObject({
      readOnly: false,
      canRetry: true,
      canRestore: true,
      retryLabel: "Retry",
      force: false,
    });
    expect(pendingSendActions("unknown")).toMatchObject({
      readOnly: false,
      canRetry: true,
      canRestore: false,
      retryLabel: "Retry anyway",
      force: true,
    });
  });

  it("labels each state with a one-line preview", () => {
    expect(pendingSendLabel({ state: "sending", text: "hello\nworld" })).toBe(
      "Sending: hello world",
    );
    expect(pendingSendLabel({ state: "failed", text: "hello" })).toBe("Failed to send: hello");
    expect(pendingSendLabel({ state: "unknown", text: "hello" })).toBe("Delivery unknown: hello");
    expect(pendingSendLabel({ state: "sending", text: "" })).toBe("Sending");
  });
});

describe("draftAutoDeleteEligible", () => {
  const ready = {
    text: "",
    attachmentCount: 0,
    hasPending: false,
    acceptanceBusy: false,
    draftLoaded: true,
    hasHistory: false,
  };

  it("allows a loaded, empty, history-free session with nothing in flight", () => {
    expect(draftAutoDeleteEligible(ready)).toBe(true);
  });

  it("refuses text, attachments, pending rows, or a send in flight", () => {
    expect(draftAutoDeleteEligible({ ...ready, text: "x" })).toBe(false);
    expect(draftAutoDeleteEligible({ ...ready, attachmentCount: 1 })).toBe(false);
    expect(draftAutoDeleteEligible({ ...ready, hasPending: true })).toBe(false);
    expect(draftAutoDeleteEligible({ ...ready, acceptanceBusy: true })).toBe(false);
  });

  it("refuses a session whose draft has not loaded or that has history", () => {
    expect(draftAutoDeleteEligible({ ...ready, draftLoaded: false })).toBe(false);
    expect(draftAutoDeleteEligible({ ...ready, hasHistory: true })).toBe(false);
  });
});

describe("flushDraftTransport", () => {
  it("uses keepalive at or under the browser request cap", () => {
    expect(flushDraftTransport(0)).toBe("keepalive");
    expect(flushDraftTransport(64 * 1024)).toBe("keepalive");
    expect(flushDraftTransport(64 * 1024 + 1)).toBe("fetch");
  });

  it("falls back to a normal fetch for a missing size or a custom limit", () => {
    expect(flushDraftTransport(undefined)).toBe("fetch");
    expect(flushDraftTransport(Number.NaN)).toBe("fetch");
    expect(flushDraftTransport(100, 99)).toBe("fetch");
    expect(flushDraftTransport(99, 99)).toBe("keepalive");
  });
});
