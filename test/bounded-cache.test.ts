import { describe, expect, it } from "vitest";
import { setBounded } from "../src/shared/bounded-cache.js";

describe("setBounded", () => {
  it("treats a max below 1 as 1", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 0);
    expect(map.size).toBe(1);
    setBounded(map, "b", 2, -3);
    expect([...map.keys()]).toEqual(["b"]);
  });

  it("keeps a single entry at max 1 and replaces it on insert", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 1);
    setBounded(map, "b", 2, 1);
    expect([...map.keys()]).toEqual(["b"]);
    expect(map.get("b")).toBe(2);
  });

  it("evicts the oldest insertion once the bound is exceeded", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "c", 3, 2);
    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  it("refreshes insertion order when the same key is set again", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "a", 3, 2);
    setBounded(map, "c", 4, 2);
    expect([...map.keys()]).toEqual(["a", "c"]);
    expect(map.get("a")).toBe(3);
  });

  it("never lets the size exceed max across many inserts", () => {
    const map = new Map<number, number>();
    for (let index = 0; index < 100; index += 1) {
      setBounded(map, index, index, 7);
      expect(map.size).toBeLessThanOrEqual(7);
    }
    expect([...map.keys()]).toEqual([93, 94, 95, 96, 97, 98, 99]);
  });
});
