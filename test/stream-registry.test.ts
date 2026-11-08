import { describe, expect, it } from "vitest";
import { AppStreamRegistry } from "../src/attachments/streams.js";

describe("AppStreamRegistry active ids", () => {
  it("prunes stale ids on the next registration", () => {
    const registry = new AppStreamRegistry(8, 1000);
    registry.registerActive("p:a", "stream-a", 0);
    registry.registerActive("p:a", "stream-b", 500);
    expect(registry.activeEntryCountForTests("p:a")).toBe(2);

    registry.registerActive("p:a", "stream-c", 2000);
    expect(registry.activeEntryCountForTests("p:a")).toBe(1);
    expect(registry.isActive("p:a", "stream-c", 2000)).toBe(true);
    expect(registry.isActive("p:a", "stream-a", 2000)).toBe(false);
  });

  it("expires a stale id on lookup", () => {
    const registry = new AppStreamRegistry(8, 1000);
    registry.registerActive("p:a", "stream-a", 0);
    expect(registry.isActive("p:a", "stream-a", 1000)).toBe(true);
    expect(registry.isActive("p:a", "stream-a", 1001)).toBe(false);
    expect(registry.activeEntryCountForTests("p:a")).toBe(0);
  });

  it("prunes other stale ids when a fresh id is looked up", () => {
    const registry = new AppStreamRegistry(8, 1000);
    registry.registerActive("p:a", "stream-a", 0);
    registry.registerActive("p:a", "stream-b", 1000);
    expect(registry.isActive("p:a", "stream-b", 1500)).toBe(true);
    expect(registry.activeEntryCountForTests("p:a")).toBe(1);
    expect(registry.isActive("p:a", "stream-a", 1500)).toBe(false);
  });

  it("prunes stale ids when the last browser slot is released", () => {
    const registry = new AppStreamRegistry(8, 1000);
    const release = registry.acquireBrowser("p:a");
    registry.registerActive("p:a", "stream-a", 0);
    expect(release).toBeDefined();
    release?.();
    expect(registry.activeEntryCountForTests("p:a")).toBe(0);
    expect(registry.browserCount("p:a")).toBe(0);
  });
});
