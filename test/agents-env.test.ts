import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstanceEnv } from "../src/opencode/instance.js";
import { agentsHome } from "../src/runtime/paths.js";

describe("agentsHome", () => {
  it("uses HANSE_AGENTS_HOME when configured", () => {
    expect(agentsHome({ HANSE_AGENTS_HOME: "/data/agents" })).toBe("/data/agents");
  });

  it("defaults outside the coordinator state directory", () => {
    expect(agentsHome({ HANSE_STATE_HOME: "/data/state" })).toBe(
      path.join(os.homedir(), ".local", "state", "hanse-agents"),
    );
  });
});

describe("per-app agent environment", () => {
  it("uses the agents root layout", () => {
    const env = resolveInstanceEnv("/data/agents", { projectId: "p", app: "web" });
    const root = "/data/agents/p/web";
    expect(env).toEqual({
      HOME: path.join(root, "home"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      OPENCODE_DB: path.join(root, "state", "opencode.db"),
      TMPDIR: path.join(root, "tmp"),
      MISE_DATA_DIR: path.join(root, "mise"),
    });
  });

  it("isolates HOME, TMPDIR, and toolchains per app", () => {
    const web = resolveInstanceEnv("/data/agents", { projectId: "p", app: "web" });
    const api = resolveInstanceEnv("/data/agents", { projectId: "p", app: "api" });
    for (const key of [
      "HOME",
      "XDG_DATA_HOME",
      "TMPDIR",
      "MISE_DATA_DIR",
      "OPENCODE_DB",
    ] as const) {
      expect(web[key]).not.toBe(api[key]);
    }
  });

  it("sanitizes project and app keys for filesystem use", () => {
    const env = resolveInstanceEnv("/data/agents", { projectId: "../p 1", app: "web/ui" });
    expect(env.HOME).toBe("/data/agents/..-p-1/web-ui/home");
  });

  it("isolates same-named apps across projects", () => {
    const one = resolveInstanceEnv("/data/agents", { projectId: "p1", app: "web" });
    const two = resolveInstanceEnv("/data/agents", { projectId: "p2", app: "web" });
    expect(one.HOME).not.toBe(two.HOME);
    expect(one.TMPDIR).not.toBe(two.TMPDIR);
  });

  it("never derives agent paths from /data/state", () => {
    const env = resolveInstanceEnv("/data/agents", { projectId: "p", app: "web" });
    for (const value of Object.values(env)) {
      expect(value.startsWith("/data/state")).toBe(false);
    }
  });
});
