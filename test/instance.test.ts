import { describe, expect, it } from "vitest";
import type { ProviderOverlay } from "../src/model-providers/types.js";
import {
  buildConfigOverlay,
  CODEGRAPH_MCP_NAME,
  COORDINATOR_MCP_NAME,
  resolveInstanceEnv,
  serializeConfigOverlay,
} from "../src/opencode/instance.js";
import {
  type AgentPermissionRule,
  buildPermissionPolicy,
  credentialDenyPatterns,
  evaluatePermission,
  matchesPermissionPattern,
  permissionPattern,
  resolvePermissionPaths,
} from "../src/opencode/policy.js";

describe("resolveInstanceEnv", () => {
  it("isolates state per application under the agents root", () => {
    const web = resolveInstanceEnv("/rt", { projectId: "p", app: "web" });
    const api = resolveInstanceEnv("/rt", { projectId: "p", app: "api" });
    expect(web.XDG_DATA_HOME).not.toBe(api.XDG_DATA_HOME);
    expect(web.OPENCODE_DB).toBe("/rt/p/web/state/opencode.db");
  });

  it("sanitizes application keys for filesystem use", () => {
    const env = resolveInstanceEnv("/rt", { projectId: "p", app: "web ui" });
    expect(env.XDG_DATA_HOME).toBe("/rt/p/web-ui/data");
    expect(env.TMPDIR).toBe("/rt/p/web-ui/tmp");
  });

  it("gives each application its own HOME and scratch root", () => {
    const web = resolveInstanceEnv("/rt", { projectId: "p", app: "web" });
    const api = resolveInstanceEnv("/rt", { projectId: "p", app: "api" });
    expect(web.HOME).toBe("/rt/p/web/home");
    expect(api.HOME).toBe("/rt/p/api/home");
    expect(web.TMPDIR).toBe("/rt/p/web/tmp");
    expect(api.TMPDIR).toBe("/rt/p/api/tmp");
    expect(web.TMPDIR).not.toBe(api.TMPDIR);
  });

  it("separates same-named applications across projects", () => {
    const one = resolveInstanceEnv("/rt", { projectId: "p1", app: "web" });
    const two = resolveInstanceEnv("/rt", { projectId: "p2", app: "web" });
    expect(one.TMPDIR).not.toBe(two.TMPDIR);
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

  it("adds the model and extra MCP servers without an agent map", () => {
    const overlay = buildConfigOverlay({
      coordinatorCommand: ["hanse", "mcp"],
      codegraphCommand: ["node", "codegraph", "serve"],
      model: "deepseek/deepseek-pro",
      mcpServers: {
        hanse: { type: "local", command: ["hijacked"] },
        extra: { type: "local", command: ["extra", "serve"] },
      },
    });
    expect(overlay.model).toBe("deepseek/deepseek-pro");
    expect(overlay.mcp?.extra?.command).toEqual(["extra", "serve"]);
    expect(overlay.mcp?.[COORDINATOR_MCP_NAME]?.command).toEqual(["hanse", "mcp"]);
    expect(overlay.mcp?.[CODEGRAPH_MCP_NAME]?.command).toEqual(["node", "codegraph", "serve"]);
    expect(overlay).not.toHaveProperty("agent");
  });

  it("omits an empty model", () => {
    const overlay = buildConfigOverlay({ coordinatorCommand: ["hanse", "mcp"], model: "" });
    expect(overlay.model).toBeUndefined();
  });

  it("includes the permission overlay and preserves plugins, MCP, and instructions", () => {
    const plugin = "file:///opt/hanse/omo/node_modules/oh-my-openagent";
    const permission = buildPermissionPolicy(["/data/opencode/tool-output"]);
    const overlay = buildConfigOverlay({
      coordinatorCommand: ["hanse", "mcp"],
      plugins: [plugin],
      instructions: ["shared/AGENTS.md"],
      environment: { HANSE_MCP_API_BASE: "http://127.0.0.1:8787" },
      permission,
    });
    expect(overlay.permission).toBe(permission);
    expect(overlay.plugin).toEqual([plugin]);
    expect(overlay.instructions).toEqual(["shared/AGENTS.md"]);
    expect(overlay.mcp?.[COORDINATOR_MCP_NAME]?.environment).toEqual({
      HANSE_MCP_API_BASE: "http://127.0.0.1:8787",
    });
  });

  it("includes custom provider definitions", () => {
    const providers: Record<string, ProviderOverlay> = {
      "llm-lan": {
        npm: "@ai-sdk/openai-compatible",
        name: "LLM LAN",
        options: { baseURL: "http://gateway:4000/v1" },
        models: {
          deepseek: { name: "DeepSeek", limit: { context: 1000, output: 100 } },
        },
      },
    };
    const overlay = buildConfigOverlay({
      coordinatorCommand: ["hanse", "mcp"],
      providers,
    });
    expect(overlay.provider).toEqual(providers);
  });

  it("omits the provider key when the registry is empty", () => {
    const overlay = buildConfigOverlay({
      coordinatorCommand: ["hanse", "mcp"],
      providers: {},
    });
    expect(overlay).not.toHaveProperty("provider");
  });

  it("rejects a serialized overlay over the environment budget", () => {
    const models = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `model-${index}-${"x".repeat(240)}`,
        { name: "n".repeat(100), limit: { context: 1, output: 1 } },
      ]),
    );
    const providers: Record<string, ProviderOverlay> = {
      "llm-lan": {
        npm: "@ai-sdk/openai-compatible",
        name: "LLM LAN",
        options: { baseURL: "http://gateway:4000/v1" },
        models,
      },
    };
    expect(() =>
      serializeConfigOverlay({ coordinatorCommand: ["hanse", "mcp"], providers }),
    ).toThrow(/provider_overlay_too_large/);
  });
});

const ROOTS = [
  "/data/opencode/tool-output",
  "/data/opencode/repos",
  "/tmp/opencode",
  "/config/opencode/skills",
  "/cache/opencode/skills",
  "/home/operator/.claude/skills",
  "/home/operator/.agents/skills",
];

const DENY = credentialDenyPatterns({
  appRoot: "/data/agents/p/web",
  home: "/data/agents/p/web/home",
  xdgDataHome: "/data/agents/p/web/data",
  passwordFile: "/data/agents/p/web/state/opencode-password",
});

describe("permission policy", () => {
  it("has the exact keys and order, with allow-all, allow roots, and credential denies last", () => {
    const policy = buildPermissionPolicy(ROOTS, { denyPatterns: DENY });
    expect(Object.keys(policy)).toEqual([
      "external_directory",
      "question",
      "todowrite",
      "todoread",
      "webfetch",
      "websearch",
      "read",
      "edit",
      "doom_loop",
    ]);
    expect(Object.keys(policy.external_directory)).toEqual([
      "*",
      ...ROOTS.map((root) => `${root}/*`),
      ...DENY,
    ]);
    expect(policy.external_directory["*"]).toBe("allow");
    for (const root of ROOTS) {
      expect(policy.external_directory[`${root}/*`]).toBe("allow");
    }
    for (const pattern of DENY) {
      expect(policy.external_directory[pattern]).toBe("deny");
    }
    expect(policy.question).toBe("allow");
    expect(policy.todowrite).toBe("allow");
    expect(policy.todoread).toBe("allow");
    expect(policy.webfetch).toBe("allow");
    expect(policy.websearch).toBe("allow");
    expect(policy.doom_loop).toBe("ask");
  });

  it("allows .env reads without a wildcard read allow", () => {
    const policy = buildPermissionPolicy(ROOTS);
    expect(policy.read).toEqual({
      "*.env": "allow",
      "*.env.*": "allow",
      "*.env.example": "allow",
    });
    expect(policy.read["*"]).toBeUndefined();
  });

  it("allows .env edits before denying app-owned config and plugins", () => {
    const policy = buildPermissionPolicy(ROOTS);
    expect(Object.keys(policy.edit)).toEqual([
      "*.env",
      "*.env.*",
      "*.env.example",
      "opencode.json",
      "opencode.jsonc",
      "*/opencode.json",
      "*/opencode.jsonc",
      ".opencode/opencode.json",
      ".opencode/opencode.jsonc",
      "*/.opencode/opencode.json",
      "*/.opencode/opencode.jsonc",
      ".opencode/plugin/*",
      ".opencode/plugins/*",
      "*/.opencode/plugin/*",
      "*/.opencode/plugins/*",
    ]);
    for (const pattern of ["*.env", "*.env.*", "*.env.example"]) {
      expect(policy.edit[pattern]).toBe("allow");
    }
    for (const pattern of Object.keys(policy.edit).filter((key) => !key.includes(".env"))) {
      expect(policy.edit[pattern]).toBe("deny");
    }
  });

  it("matches the .opencode denies for app-as-worktree, non-git, and nested worktrees", () => {
    expect(matchesPermissionPattern("opencode.json", "opencode.json")).toBe(true);
    expect(matchesPermissionPattern(".opencode/opencode.json", ".opencode/opencode.json")).toBe(
      true,
    );
    expect(
      matchesPermissionPattern("*/.opencode/opencode.json", "apps/web/.opencode/opencode.json"),
    ).toBe(true);
    expect(matchesPermissionPattern("*/opencode.json", "apps/web/opencode.json")).toBe(true);
    expect(
      matchesPermissionPattern("*/.opencode/plugins/*", "apps/web/.opencode/plugins/tool.ts"),
    ).toBe(true);
    expect(
      matchesPermissionPattern("*/.opencode/plugin/*", "nested/apps/web/.opencode/plugin/x.ts"),
    ).toBe(true);
    expect(matchesPermissionPattern("*/opencode.json", "opencode.json")).toBe(false);
  });

  it("denies config and plugin edits while allowing .env in every worktree shape", () => {
    const policy = buildPermissionPolicy(ROOTS);
    const rules = Object.entries(policy.edit).map(
      ([pattern, action]): AgentPermissionRule => ({
        permission: "edit",
        pattern,
        action,
      }),
    );
    expect(evaluatePermission(rules, "edit", "opencode.json")).toBe("deny");
    expect(evaluatePermission(rules, "edit", ".opencode/opencode.jsonc")).toBe("deny");
    expect(evaluatePermission(rules, "edit", "srv/apps/web/opencode.json")).toBe("deny");
    expect(evaluatePermission(rules, "edit", "srv/apps/web/.opencode/opencode.json")).toBe("deny");
    expect(evaluatePermission(rules, "edit", "srv/apps/web/.opencode/plugin/tool.ts")).toBe("deny");
    expect(
      evaluatePermission(rules, "edit", "worktrees/parent/srv/apps/web/.opencode/plugins/tool.ts"),
    ).toBe("deny");
    expect(evaluatePermission(rules, "edit", ".env")).toBe("allow");
    expect(evaluatePermission(rules, "edit", "srv/apps/web/.env.local")).toBe("allow");
    expect(evaluatePermission(rules, "edit", "srv/apps/web/.env.example")).toBe("allow");
  });

  it("resolves trusted roots from the instance environment and plugin specs", () => {
    const roots = resolvePermissionPaths({
      xdgDataHome: "/data",
      xdgConfigHome: "/config",
      xdgCacheHome: "/cache",
      home: "/home/operator",
      tmpdir: "/tmp",
      baselinePlugins: [
        "file:///opt/omo%20plugin/node_modules/oh-my-openagent",
        "oh-my-openagent@latest",
        "file:///opt/hanse/omo",
      ],
    });
    expect(roots).toEqual([
      "/data/opencode/tool-output",
      "/data/opencode/repos",
      "/tmp/opencode",
      "/config/opencode/skills",
      "/cache/opencode/skills",
      "/home/operator/.claude/skills",
      "/home/operator/.agents/skills",
      "/opt/omo plugin/node_modules/oh-my-openagent/skills",
      "/opt/hanse/omo/skills",
    ]);
    expect(permissionPattern("/tmp/opencode")).toBe("/tmp/opencode/*");
  });
});
