import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createThreadStore } from "../assets/chat-feed-store.js";
import {
  isKnownPartType,
  KNOWN_PART_TYPES,
  createThreadStore as wrappedCreateThreadStore,
} from "../ui/chat/feed-store.js";

const EXPECTED_FIELDS = [
  "sessionID",
  "generation",
  "turnGeneration",
  "order",
  "messages",
  "activePromptID",
  "queue",
  "openParts",
  "lastSeqByStream",
  "currentStreamID",
  "pendingDeltas",
  "agentStatus",
] as const;

const SOURCE = readFileSync(new URL("../assets/chat-feed-store.js", import.meta.url), "utf8");

describe("copy-first chat feed store", () => {
  it("creates the frozen legacy shape", () => {
    const store = createThreadStore("ses_copy");

    expect(Object.keys(store).sort()).toEqual([...EXPECTED_FIELDS].sort());
    expect(store.sessionID).toBe("ses_copy");
    expect(store.generation).toBe(0);
    expect(store.turnGeneration).toBe(0);
    expect(store.order).toEqual([]);
    expect(store.messages).toBeInstanceOf(Map);
    expect(store.activePromptID).toBeNull();
    expect(store.queue).toEqual([]);
    expect(store.openParts).toBeInstanceOf(Set);
    expect(store.lastSeqByStream).toBeInstanceOf(Map);
    expect(store.currentStreamID).toBeNull();
    expect(store.pendingDeltas).toBeInstanceOf(Map);
    expect(store.agentStatus).toBeNull();
  });

  it("keeps the null session case identical to the legacy factory", () => {
    expect(createThreadStore(null).sessionID).toBeNull();
  });

  it("re-exports the same factory through the typed wrapper", () => {
    expect(wrappedCreateThreadStore).toBe(createThreadStore);
  });

  it("has no import, ui, legacy-client, or dynamic-import dependency", () => {
    const specifiers = [
      ...SOURCE.matchAll(/\bfrom\s+["']([^"']+)["']/g),
      ...SOURCE.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g),
      ...SOURCE.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    expect(specifiers).toEqual([]);
    expect(/^\s*import\b/m.test(SOURCE)).toBe(false);
    expect(/^\s*export\s+[^;]*\bfrom\b/m.test(SOURCE)).toBe(false);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/^ui\//);
      expect(specifier).not.toMatch(/chat\.js$/);
      expect(specifier).not.toMatch(/terminal\.js$/);
    }
  });

  it("recognizes every known PartType and rejects future types", () => {
    expect([...KNOWN_PART_TYPES].sort()).toEqual([
      "agent",
      "compaction",
      "file",
      "patch",
      "reasoning",
      "retry",
      "snapshot",
      "step-finish",
      "step-start",
      "subtask",
      "text",
      "tool",
    ]);
    for (const type of KNOWN_PART_TYPES) {
      expect(isKnownPartType(type)).toBe(true);
    }
    expect(isKnownPartType("future-part")).toBe(false);
  });
});
