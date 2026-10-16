import { describe, expect, it } from "vitest";
import {
  buildConfigOverlay,
  COORDINATOR_MCP_NAME,
  resolveInstanceEnv,
  serializeConfigOverlay,
} from "../src/opencode/instance.js";

describe("resolveInstanceEnv", () => {
  it("isolates state per application", () => {
    const web = resolveInstanceEnv("/rt", { projectId: "p", app: "web" });
    const api = resolveInstanceEnv("/rt", { projectId: "p", app: "api" });
    expect(web.XDG_DATA_HOME).not.toBe(api.XDG_DATA_HOME);
    expect(web.OPENCODE_DB).toBe("/rt/apps/web/state/opencode.db");
  });

  it("sanitizes application keys for filesystem use", () => {
    const env = resolveInstanceEnv("/rt", { projectId: "p", app: "web ui" });
    expect(env.XDG_DATA_HOME).toBe("/rt/apps/web-ui/data");
  });
});

describe("buildConfigOverlay", () => {
  it("adds the coordinator MCP server and instructions", () => {
    const overlay = buildConfigOverlay({
      coordinatorCommand: ["hanse", "mcp"],
      instructions: ["shared/AGENTS.md"],
    });
    expect(overlay.mcp?.[COORDINATOR_MCP_NAME]?.type).toBe("local");
    expect(overlay.instructions).toEqual(["shared/AGENTS.md"]);
  });

  it("omits instructions when none are provided", () => {
    const overlay = buildConfigOverlay({ coordinatorCommand: ["hanse", "mcp"] });
    expect(overlay.instructions).toBeUndefined();
  });

  it("serializes to valid JSON for OPENCODE_CONFIG_CONTENT", () => {
    const serialized = serializeConfigOverlay({ coordinatorCommand: ["hanse", "mcp"] });
    expect(JSON.parse(serialized)).toBeTypeOf("object");
  });
});
