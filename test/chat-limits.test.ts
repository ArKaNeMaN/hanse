import { describe, expect, it } from "vitest";
import { chatTextTooLarge, MAX_CHAT_TEXT_BYTES, textByteLength } from "../assets/chat-core.js";
import { MAX_DRAFT_BYTES } from "../src/chat/state.js";

describe("chat text limits", () => {
  it("keeps the client guard equal to the server draft and message cap", () => {
    expect(MAX_CHAT_TEXT_BYTES).toBe(MAX_DRAFT_BYTES);
  });

  it("counts UTF-8 bytes and rejects text above the cap", () => {
    expect(textByteLength("привет")).toBe(12);
    expect(textByteLength("x".repeat(MAX_DRAFT_BYTES))).toBe(MAX_DRAFT_BYTES);
    expect(chatTextTooLarge("x".repeat(MAX_DRAFT_BYTES))).toBe(false);
    expect(chatTextTooLarge("x".repeat(MAX_DRAFT_BYTES + 1))).toBe(true);
    expect(chatTextTooLarge("я".repeat(MAX_DRAFT_BYTES / 2 + 1))).toBe(true);
  });
});
