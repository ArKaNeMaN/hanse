import { describe, expect, it } from "vitest";
import { processPill } from "./status.js";

describe("processPill", () => {
  it("labels an OOM error code before the phase/state fallback", () => {
    expect(processPill("error", "failed", "oom_killed", null)).toMatchObject({
      variant: "status",
      dataState: "failed",
      icon: "alert-triangle",
      label: "Out of memory",
    });
    expect(processPill("running", "ready", "oom_killed", null).label).toBe("Out of memory");
  });

  it("labels an old row by its OOM reason even without the code", () => {
    expect(processPill("error", "failed", "runtime_unavailable", "oom_killed").label).toBe(
      "Out of memory",
    );
  });

  it("keeps the existing phase/state fallback for other errors", () => {
    expect(processPill("error", "failed", "runtime_unavailable", null).label).toBe("Failed");
    expect(processPill("running", "ready").label).toBe("Ready");
    expect(processPill("stopped").label).toBe("Stopped");
  });
});
