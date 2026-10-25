import { describe, expect, it } from "vitest";
import { collectSessionSubtreeIDs } from "../src/chat/session-tree.js";

describe("collectSessionSubtreeIDs", () => {
  it("returns just the root id for an empty list", () => {
    expect(collectSessionSubtreeIDs([], "root")).toEqual(["root"]);
  });

  it("returns the root id when it is absent from the list", () => {
    expect(collectSessionSubtreeIDs([{ id: "a" }, { id: "b" }], "ghost")).toEqual(["ghost"]);
  });

  it("returns just the id for a flat list entry", () => {
    const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(collectSessionSubtreeIDs(sessions, "a")).toEqual(["a"]);
    expect(collectSessionSubtreeIDs(sessions, "b")).toEqual(["b"]);
  });

  it("collects a three-level chain and sibling order root-first", () => {
    const sessions = [
      { id: "root" },
      { id: "child1", parentID: "root" },
      { id: "child2", parentID: "root" },
      { id: "grand", parentID: "child1" },
    ];

    expect(collectSessionSubtreeIDs(sessions, "root")).toEqual([
      "root",
      "child1",
      "grand",
      "child2",
    ]);
    expect(collectSessionSubtreeIDs(sessions, "child1")).toEqual(["child1", "grand"]);
    expect(collectSessionSubtreeIDs(sessions, "child2")).toEqual(["child2"]);
  });

  it("treats a missing parent as a root", () => {
    const sessions = [{ id: "a" }, { id: "b", parentID: "missing" }];

    expect(collectSessionSubtreeIDs(sessions, "a")).toEqual(["a"]);
    expect(collectSessionSubtreeIDs(sessions, "b")).toEqual(["b"]);
  });

  it("treats empty, blank, and non-string parentID values as roots", () => {
    const sessions = [
      { id: "a", parentID: "" },
      { id: "b", parentID: "   " },
      { id: "c", parentID: 42 },
      { id: "d", parentID: null },
      { id: "e" },
    ];

    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(collectSessionSubtreeIDs(sessions, id)).toEqual([id]);
    }
  });

  it("treats a self-parent as a root", () => {
    const sessions = [
      { id: "a", parentID: "a" },
      { id: "b", parentID: "b" },
    ];

    expect(collectSessionSubtreeIDs(sessions, "a")).toEqual(["a"]);
    expect(collectSessionSubtreeIDs(sessions, "b")).toEqual(["b"]);
  });

  it("is cycle-safe for a two-node cycle", () => {
    const sessions = [
      { id: "a", parentID: "b" },
      { id: "b", parentID: "a" },
    ];

    const fromA = collectSessionSubtreeIDs(sessions, "a");
    const fromB = collectSessionSubtreeIDs(sessions, "b");
    expect(fromA).toEqual(["a", "b"]);
    expect(fromB).toEqual(["b", "a"]);
    expect(new Set(fromA).size).toBe(fromA.length);
    expect(new Set(fromB).size).toBe(fromB.length);
  });

  it("is cycle-safe for a three-node cycle", () => {
    const sessions = [
      { id: "a", parentID: "c" },
      { id: "b", parentID: "a" },
      { id: "c", parentID: "b" },
    ];

    const subtree = collectSessionSubtreeIDs(sessions, "a");
    expect(subtree).toEqual(["a", "b", "c"]);
    expect(new Set(subtree).size).toBe(subtree.length);
  });

  it("keeps the first occurrence of a duplicate id and its grouping", () => {
    const sessions = [
      { id: "a" },
      { id: "b", parentID: "a" },
      { id: "a", parentID: "missing" },
      { id: "b", parentID: "ghost" },
    ];

    expect(collectSessionSubtreeIDs(sessions, "a")).toEqual(["a", "b"]);
    expect(collectSessionSubtreeIDs(sessions, "ghost")).toEqual(["ghost"]);
  });

  it("returns just the root id for a malformed list", () => {
    expect(collectSessionSubtreeIDs(null as unknown as [], "root")).toEqual(["root"]);
    expect(collectSessionSubtreeIDs([null, { id: "" }, 42] as unknown as [], "root")).toEqual([
      "root",
    ]);
  });
});
