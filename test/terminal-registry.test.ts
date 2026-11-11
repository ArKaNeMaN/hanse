import { describe, expect, it } from "vitest";
import { TerminalSessionRegistry } from "../src/http/terminal.js";

describe("terminal session registry", () => {
  it("counts attached terminals and releases idempotently", () => {
    const registry = new TerminalSessionRegistry();
    const first = registry.register("p:a");
    const second = registry.register("p:a");

    expect(first).toBeTypeOf("function");
    expect(second).toBeTypeOf("function");
    expect(registry.isActive("p:a")).toBe(true);
    expect(registry.isActive("p:b")).toBe(false);

    first?.();
    first?.();
    expect(registry.isActive("p:a")).toBe(true);

    second?.();
    expect(registry.isActive("p:a")).toBe(false);
    expect(registry.register("p:a")).toBeTypeOf("function");
  });

  it("refuses registration while a maintenance gate is active", () => {
    const registry = new TerminalSessionRegistry();
    const release = registry.beginMaintenance("p:a");

    expect(registry.register("p:a")).toBeUndefined();
    expect(registry.isActive("p:a")).toBe(false);
    expect(registry.register("p:b")).toBeTypeOf("function");

    release();
    expect(registry.register("p:a")).toBeTypeOf("function");
  });

  it("refcounts maintenance and releases it idempotently", () => {
    const registry = new TerminalSessionRegistry();
    const first = registry.beginMaintenance("p:a");
    const second = registry.beginMaintenance("p:a");

    first();
    first();
    expect(registry.register("p:a")).toBeUndefined();

    second();
    second();
    expect(registry.register("p:a")).toBeTypeOf("function");
  });
});
