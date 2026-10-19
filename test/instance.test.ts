import { describe, expect, it } from "vitest";
import {
  buildConfigOverlay,
  CODEGRAPH_MCP_NAME,
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

  it("injects baseline plugins", () => {
    const plugin = "file:///opt/hanse/omo/node_modules/oh-my-openagent";
    const overlay = buildConfigOverlay({ coordinatorCommand: ["hanse", "mcp"], plugins: [plugin] });
    expect(overlay.plugin).toEqual([plugin]);
  });

  it("omits plugins when none are provided", () => {
    const overlay = buildConfigOverlay({ coordinatorCommand: ["hanse", "mcp"] });
    expect(overlay.plugin).toBeUndefined();
  });

  it("adds the baseline codegraph MCP server", () => {
    const overlay = buildConfigOverlay({
      coordinatorCommand: ["hanse", "mcp"],
      codegraphCommand: [
        "node",
        "/opt/hanse/codegraph/node_modules/.bin/codegraph",
        "serve",
        "--mcp",
      ],
    });
    expect(overlay.mcp?.[CODEGRAPH_MCP_NAME]?.type).toBe("local");
    expect(overlay.mcp?.[COORDINATOR_MCP_NAME]?.type).toBe("local");
  });

  it("serializes to valid JSON for OPENCODE_CONFIG_CONTENT", () => {
    const serialized = serializeConfigOverlay({ coordinatorCommand: ["hanse", "mcp"] });
    expect(JSON.parse(serialized)).toBeTypeOf("object");
  });
});
