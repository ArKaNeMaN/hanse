import { beforeEach, describe, expect, it } from "vitest";
import {
  clearScrollMemory,
  readScrollMemory,
  scrollMemoryKey,
  writeScrollMemory,
} from "../../ui/chat/scroll-memory.js";
import { clearTranscriptMemory, createTranscriptMemory } from "../../ui/chat/transcript-memory.js";

beforeEach(() => {
  clearScrollMemory();
});

describe("transcript memory", () => {
  it("re-exports the shared scroll memory key", () => {
    expect(scrollMemoryKey("p:alpha", null)).toBeNull();
    expect(scrollMemoryKey("p:alpha", "")).toBeNull();
    expect(scrollMemoryKey("p:alpha", "ses_1")).toBe("p:alpha::ses_1");
  });

  it("keeps per-scope detail and height maps isolated", () => {
    const first = createTranscriptMemory("scope-a");
    const second = createTranscriptMemory("scope-b");

    first.setOpen("part-1", true);
    first.writeHeight("row-1", 120);

    expect(first.isOpen("part-1")).toBe(true);
    expect(first.readHeight("row-1")).toBe(120);
    expect(second.isOpen("part-1")).toBeUndefined();
    expect(second.readHeight("row-1")).toBeUndefined();
  });

  it("distinguishes an explicit closed detail from an unknown one", () => {
    const memory = createTranscriptMemory("scope");
    expect(memory.isOpen("part")).toBeUndefined();
    memory.setOpen("part", false);
    expect(memory.isOpen("part")).toBe(false);
    memory.setOpen("part", true);
    expect(memory.isOpen("part")).toBe(true);
  });

  it("treats a null scope as a transient no-op", () => {
    const memory = createTranscriptMemory(null);
    memory.setOpen("part", true);
    memory.writeHeight("row", 100);

    expect(memory.isOpen("part")).toBeUndefined();
    expect(memory.readHeight("row")).toBeUndefined();
    expect(() => {
      memory.pruneHeights(new Set());
      memory.pruneDetails(new Set());
    }).not.toThrow();
  });

  it("refreshes hot height keys so the tallest tail is not evicted", () => {
    const memory = createTranscriptMemory("scope");
    for (let index = 0; index < 5000; index += 1) {
      memory.writeHeight(`row-${index}`, index);
    }

    expect(memory.readHeight("row-0")).toBe(0);
    memory.writeHeight("row-new", 1);

    expect(memory.readHeight("row-1")).toBeUndefined();
    expect(memory.readHeight("row-0")).toBe(0);
    expect(memory.readHeight("row-4999")).toBe(4999);
    expect(memory.readHeight("row-new")).toBe(1);
  });

  it("refreshes hot detail keys so live detail state is not evicted", () => {
    const memory = createTranscriptMemory("scope");
    for (let index = 0; index < 2000; index += 1) {
      memory.setOpen(`part-${index}`, index % 2 === 0);
    }

    expect(memory.isOpen("part-0")).toBe(true);
    memory.setOpen("part-new", true);

    expect(memory.isOpen("part-1")).toBeUndefined();
    expect(memory.isOpen("part-0")).toBe(true);
    expect(memory.isOpen("part-1999")).toBe(false);
    expect(memory.isOpen("part-new")).toBe(true);
  });

  it("prunes heights and details that are no longer live", () => {
    const memory = createTranscriptMemory("scope");
    memory.writeHeight("row-a", 10);
    memory.writeHeight("row-b", 20);
    memory.writeHeight("row-c", 30);
    memory.setOpen("part-a", true);
    memory.setOpen("part-b", false);
    memory.setOpen("part-c", true);

    memory.pruneHeights(new Set(["row-b"]));
    memory.pruneDetails(new Set(["part-b"]));

    expect(memory.readHeight("row-a")).toBeUndefined();
    expect(memory.readHeight("row-b")).toBe(20);
    expect(memory.readHeight("row-c")).toBeUndefined();
    expect(memory.isOpen("part-a")).toBeUndefined();
    expect(memory.isOpen("part-b")).toBe(false);
    expect(memory.isOpen("part-c")).toBeUndefined();
  });

  it("clears one scope or every scope", () => {
    const first = createTranscriptMemory("scope-a");
    const second = createTranscriptMemory("scope-b");
    first.setOpen("part", true);
    first.writeHeight("row", 10);
    second.setOpen("part", true);

    clearTranscriptMemory("scope-a");
    expect(first.isOpen("part")).toBeUndefined();
    expect(first.readHeight("row")).toBeUndefined();
    expect(second.isOpen("part")).toBe(true);

    clearTranscriptMemory();
    expect(second.isOpen("part")).toBeUndefined();
  });
});

describe("scroll memory", () => {
  it("round-trips the windowing anchor fields and sanitizes invalid ones", () => {
    writeScrollMemory("scope", {
      scrollTop: 42,
      scrollHeight: 420,
      key: "message:m1",
      visualOffset: -12.5,
    });
    expect(readScrollMemory("scope")).toEqual({
      scrollTop: 42,
      scrollHeight: 420,
      key: "message:m1",
      visualOffset: -12.5,
    });

    writeScrollMemory("scope", {
      scrollTop: -5,
      scrollHeight: -1,
      key: "",
      visualOffset: Number.NaN,
    });
    expect(readScrollMemory("scope")).toEqual({ scrollTop: 0, scrollHeight: 0 });
  });

  it("clears the matching transcript scope", () => {
    const memory = createTranscriptMemory("scope");
    memory.setOpen("part", true);
    memory.writeHeight("row", 10);
    writeScrollMemory("scope", { scrollTop: 1, scrollHeight: 2 });

    clearScrollMemory("scope");

    expect(readScrollMemory("scope")).toBeNull();
    expect(memory.isOpen("part")).toBeUndefined();
    expect(memory.readHeight("row")).toBeUndefined();
  });

  it("clears every scroll and transcript scope without an argument", () => {
    const first = createTranscriptMemory("scope-a");
    const second = createTranscriptMemory("scope-b");
    first.setOpen("part", true);
    second.setOpen("part", true);
    writeScrollMemory("scope-a", { scrollTop: 1, scrollHeight: 2 });
    writeScrollMemory("scope-b", { scrollTop: 3, scrollHeight: 4 });

    clearScrollMemory();

    expect(readScrollMemory("scope-a")).toBeNull();
    expect(readScrollMemory("scope-b")).toBeNull();
    expect(first.isOpen("part")).toBeUndefined();
    expect(second.isOpen("part")).toBeUndefined();
  });
});
