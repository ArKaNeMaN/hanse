import { describe, expect, it } from "vitest";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";

describe("LifecycleActivity", () => {
  it("counts concurrent spans and decrements on end", () => {
    const activity = new LifecycleActivity();
    const first = activity.begin("ensure");
    const second = activity.begin("restart");
    expect(activity.count).toBe(2);
    first();
    expect(activity.count).toBe(1);
    second();
    expect(activity.count).toBe(0);
  });

  it("makes end idempotent and never goes negative", () => {
    const activity = new LifecycleActivity();
    const end = activity.begin("stop");
    end();
    end();
    expect(activity.count).toBe(0);
  });
});
