import { describe, expect, it } from "vitest";
import { stoppedStatus } from "../src/agent/protocol.js";

describe("RuntimeAppStatus epoch fields", () => {
  it("returns null and zero defaults for a never-started app", () => {
    expect(stoppedStatus("project:app")).toMatchObject({
      appId: "project:app",
      state: "stopped",
      endpoint: null,
      startedAt: null,
      restartCount: 0,
      exitCode: null,
      oomKilled: false,
      finishedAt: null,
    });
  });
});
