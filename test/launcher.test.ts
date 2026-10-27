import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderOverlay } from "../src/model-providers/types.js";
import { resolveInstanceEnv } from "../src/opencode/instance.js";
import {
  buildInstanceEnv,
  type LaunchInput,
  launchInstance,
  stopInstance,
} from "../src/opencode/launcher.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function fixture(): { db: SqliteDatabase; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-launch-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(dir, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:web','p','web','apps/web','AGENTS.md',?)",
  ).run(now);
  return { db, dir };
}

const fakeCommand = ["node", "-e", "setInterval(() => {}, 1000)"];

function launchInput(overrides: Partial<LaunchInput> = {}): LaunchInput {
  return {
    appId: "p:web",
    identity: { projectId: "p", app: "web" },
    appDir: "/tmp",
    runtimeRoot: "/rt",
    port: 4096,
    coordinatorCommand: ["hanse", "mcp"],
    ...overrides,
  };
}

function git(env: NodeJS.ProcessEnv, appDir: string): string {
  return execFileSync("git", ["-C", appDir, "rev-parse", "--show-toplevel"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

describe("launcher", () => {
  it("composes an isolated environment with the overlay", () => {
    const plugin = "file:///opt/hanse/omo/node_modules/oh-my-openagent";
    const env = buildInstanceEnv({
      appId: "p:web",
      identity: { projectId: "p", app: "web" },
      appDir: "/tmp",
      runtimeRoot: "/rt",
      port: 4096,
      coordinatorCommand: ["hanse", "mcp"],
      codegraphCommand: [
        "node",
        "/opt/hanse/codegraph/node_modules/.bin/codegraph",
        "serve",
        "--mcp",
      ],
      baselinePlugins: [plugin],
    });
    expect(env.HOME).toBe("/rt/p/web/home");
    expect(env.XDG_DATA_HOME).toBe("/rt/p/web/data");
    expect(env.XDG_STATE_HOME).toBe("/rt/p/web/state");
    expect(env.OPENCODE_DB).toBe("/rt/p/web/state/opencode.db");
    expect(env.TMPDIR).toBe("/rt/p/web/tmp");
    expect(env.MISE_DATA_DIR).toBe("/rt/p/web/mise");
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: Record<string, unknown>;
      plugin?: string[];
      permission?: { external_directory?: Record<string, string> };
    };
    expect(overlay.mcp?.hanse).toBeDefined();
    expect(overlay.mcp?.codegraph).toBeDefined();
    expect(overlay.plugin).toEqual([plugin]);
    expect(overlay.permission?.external_directory?.[`${env.TMPDIR}/opencode/*`]).toBe("allow");
    expect(overlay.permission?.external_directory?.[`${env.HOME}/.claude/skills/*`]).toBe("allow");
    expect(overlay.permission?.external_directory?.[`${env.HOME}/.agents/skills/*`]).toBe("allow");
    expect(overlay.permission?.external_directory?.["/tmp/opencode/*"]).toBeUndefined();
    expect(overlay.permission?.external_directory?.["*"]).toBe("allow");
    expect(overlay.permission?.external_directory?.["/rt/p/web/data/opencode/auth.json"]).toBe(
      "deny",
    );
    expect(overlay.permission?.external_directory?.["/rt/p/web/home/.config/hanse/git/*"]).toBe(
      "deny",
    );
    expect(overlay.permission?.external_directory?.["/rt/p/web/mcp-token"]).toBe("deny");
    expect(overlay.permission?.external_directory?.["/rt/p/web/state/opencode-password"]).toBe(
      "deny",
    );
  });

  it("launches and stops an instance, tracking state", async () => {
    const { db, dir } = fixture();
    const running = launchInstance(db, {
      appId: "p:web",
      identity: { projectId: "p", app: "web" },
      appDir: dir,
      runtimeRoot: path.join(dir, "rt"),
      port: 0,
      coordinatorCommand: ["hanse", "mcp"],
      command: fakeCommand,
    });
    const started = db.prepare("SELECT state, pid FROM instances WHERE app_id = 'p:web'").get() as {
      state: string;
      pid: number | null;
    };
    expect(started.state).toBe("running");
    expect(started.pid).toBeGreaterThan(0);
    const appRoot = path.join(dir, "rt", "p", "web");
    for (const directory of [
      "home",
      "data",
      "state",
      "config",
      "cache",
      "tmp",
      "mise",
      path.join("data", "opencode"),
    ]) {
      expect(existsSync(path.join(appRoot, directory))).toBe(true);
    }

    await stopInstance(db, running);
    const stopped = db.prepare("SELECT state, pid FROM instances WHERE app_id = 'p:web'").get() as {
      state: string;
      pid: number | null;
    };
    expect(stopped.state).toBe("stopped");
    expect(stopped.pid).toBeNull();
    db.close();
  });

  it("scrubs coordinator credentials after every environment spread", () => {
    const previous = process.env.HANSE_OPERATOR_TOKEN;
    process.env.HANSE_OPERATOR_TOKEN = "process-env-token";
    try {
      const env = buildInstanceEnv(
        launchInput({
          baseEnv: {
            HANSE_OPERATOR_TOKEN: "base-env-token",
            OPENCODE_PERMISSION: '{"*":"allow"}',
            OPENCODE_AUTH_CONTENT: '{"deepseek":{}}',
            OMO_PROFILE: "inherited",
            OCX_PROFILE: "inherited",
            OPENCODE_CONFIG_DIR: "/state/config",
            HANSE_API_BASE: "http://127.0.0.1:8787",
            HANSE_AUTH_FILE: "/state/auth.json",
            HANSE_DB: "/state/coordinator.db",
            HANSE_STATE_HOME: "/state",
            GIT_CONFIG_GLOBAL: "/host/git/config",
            GIT_CONFIG_SYSTEM: "/host/git/system",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.sshCommand",
            GIT_CONFIG_VALUE_0: "/host/git/evil-ssh",
            GIT_SSH_COMMAND: "/host/git/evil-ssh",
            GIT_SSH: "/host/git/evil-ssh",
            GIT_ASKPASS: "/host/git/askpass",
            GIT_ASKPASS_REQUIRE: "force",
            GIT_TERMINAL_PROMPT: "1",
            GIT_SSL_CAINFO: "/host/git/ca.pem",
            GIT_DIR: "/host/git/repo",
            GIT_WORK_TREE: "/host/git/tree",
            GIT_CEILING_DIRECTORIES: "/host/git",
            HANSE_CREDENTIALS_DIR: "/host/git",
            HANSE_CREDENTIALS_READONLY: "1",
            HANSE_GIT_TOKEN: "legacy-token",
            HANSE_GIT_SSH_KEY: "/host/legacy/key",
            HANSE_GIT_AUTHOR_NAME: "Legacy",
            HANSE_GIT_OP: "status",
            HANSE_GIT_APP_DIR: "/app",
            HANSE_GIT_BRANCH: "main",
            HANSE_GIT_MESSAGE: "message",
            HANSE_KEEP: "kept",
          },
        }),
      );
      for (const key of [
        "HANSE_OPERATOR_TOKEN",
        "OPENCODE_PERMISSION",
        "OPENCODE_AUTH_CONTENT",
        "OMO_PROFILE",
        "OCX_PROFILE",
        "OPENCODE_CONFIG_DIR",
        "HANSE_API_BASE",
        "HANSE_AUTH_FILE",
        "HANSE_DB",
        "HANSE_STATE_HOME",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        "GIT_SSH_COMMAND",
        "GIT_SSH",
        "GIT_ASKPASS",
        "GIT_ASKPASS_REQUIRE",
        "GIT_TERMINAL_PROMPT",
        "GIT_SSL_CAINFO",
        "GIT_DIR",
        "GIT_WORK_TREE",
        "HANSE_CREDENTIALS_DIR",
        "HANSE_CREDENTIALS_READONLY",
        "HANSE_GIT_TOKEN",
        "HANSE_GIT_SSH_KEY",
        "HANSE_GIT_AUTHOR_NAME",
      ]) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.GIT_CEILING_DIRECTORIES).not.toBe("/host/git");
      expect(env.HANSE_GIT_OP).toBe("status");
      expect(env.HANSE_GIT_APP_DIR).toBe("/app");
      expect(env.HANSE_GIT_BRANCH).toBe("main");
      expect(env.HANSE_GIT_MESSAGE).toBe("message");
      expect(env.HANSE_KEEP).toBe("kept");
    } finally {
      if (previous === undefined) delete process.env.HANSE_OPERATOR_TOKEN;
      else process.env.HANSE_OPERATOR_TOKEN = previous;
    }
  });

  it("injects the permission overlay and keeps the coordinator MCP environment", () => {
    const plugin = "file:///opt/hanse/omo/node_modules/oh-my-openagent";
    const env = buildInstanceEnv(
      launchInput({
        appDir: "/tmp/apps/web",
        coordinatorEnvironment: {
          HANSE_MCP_API_BASE: "http://127.0.0.1:8787",
          HANSE_AGENT_TOKEN_FILE: "/rt/p/web/mcp-token",
        },
        instructions: ["shared/AGENTS.md"],
        baselinePlugins: [plugin],
      }),
    );
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: Record<string, { environment?: Record<string, string> }>;
      plugin?: string[];
      instructions?: string[];
      permission?: {
        external_directory?: Record<string, string>;
        question?: string;
        doom_loop?: string;
      };
    };
    expect(overlay.plugin).toEqual([plugin]);
    expect(overlay.instructions).toEqual(["shared/AGENTS.md"]);
    expect(overlay.mcp?.hanse?.environment).toEqual({
      HANSE_MCP_API_BASE: "http://127.0.0.1:8787",
      HANSE_AGENT_TOKEN_FILE: "/rt/p/web/mcp-token",
    });
    expect(overlay.permission?.external_directory?.["*"]).toBe("allow");
    expect(overlay.permission?.question).toBe("allow");
    expect(overlay.permission?.doom_loop).toBe("ask");
  });

  it("sets GIT_CEILING_DIRECTORIES to the real parent of the app directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-ceiling-"));
    dirs.push(dir);
    const appDir = path.join(dir, "apps", "web");
    mkdirSync(appDir, { recursive: true });
    const env = buildInstanceEnv(launchInput({ appDir }));
    expect(env.GIT_CEILING_DIRECTORIES).toBe(path.dirname(realpathSync(appDir)));
  });

  it("keeps git from discovering a parent repository for a nested app", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hanse-nested-"));
    dirs.push(root);
    execFileSync("git", ["init", root], { stdio: "ignore" });
    const nested = path.join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    const env = buildInstanceEnv(launchInput({ appDir: nested }));
    const gitEnv = { ...process.env, GIT_CEILING_DIRECTORIES: env.GIT_CEILING_DIRECTORIES };
    expect(() => git(gitEnv, nested)).toThrow();

    const own = path.join(root, "own-app");
    mkdirSync(own, { recursive: true });
    execFileSync("git", ["init", own], { stdio: "ignore" });
    const ownEnv = buildInstanceEnv(launchInput({ appDir: own }));
    expect(
      git({ ...process.env, GIT_CEILING_DIRECTORIES: ownEnv.GIT_CEILING_DIRECTORIES }, own),
    ).toBe(realpathSync(own));
  });

  it("writes the merged auth snapshot with mode 0600", async () => {
    const { db, dir } = fixture();
    const runtimeRoot = path.join(dir, "rt");
    const auth = { deepseek: { type: "api", key: "sk-test" } };
    const running = launchInstance(db, {
      appId: "p:web",
      identity: { projectId: "p", app: "web" },
      appDir: dir,
      runtimeRoot,
      port: 0,
      coordinatorCommand: ["hanse", "mcp"],
      command: fakeCommand,
      auth,
    });
    const authFile = path.join(
      resolveInstanceEnv(runtimeRoot, { projectId: "p", app: "web" }).XDG_DATA_HOME,
      "opencode",
      "auth.json",
    );
    expect(JSON.parse(readFileSync(authFile, "utf8"))).toEqual(auth);
    expect(statSync(authFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(authFile)).mode & 0o777).toBe(0o700);
    await stopInstance(db, running, { timeoutMs: 1000 });
    db.close();
  });

  it("removes a stale auth file when the merged snapshot is empty", async () => {
    const { db, dir } = fixture();
    const runtimeRoot = path.join(dir, "rt");
    const authFile = path.join(
      resolveInstanceEnv(runtimeRoot, { projectId: "p", app: "web" }).XDG_DATA_HOME,
      "opencode",
      "auth.json",
    );
    mkdirSync(path.dirname(authFile), { recursive: true });
    writeFileSync(authFile, '{"stale":true}');
    const running = launchInstance(db, {
      appId: "p:web",
      identity: { projectId: "p", app: "web" },
      appDir: dir,
      runtimeRoot,
      port: 0,
      coordinatorCommand: ["hanse", "mcp"],
      command: fakeCommand,
      auth: {},
    });
    expect(existsSync(authFile)).toBe(false);
    await stopInstance(db, running, { timeoutMs: 1000 });
    db.close();
  });

  it("scrubs inherited profile/auth overrides and sets only the applied profile", () => {
    const env = buildInstanceEnv(
      launchInput({
        baseEnv: {
          OPENCODE_AUTH_CONTENT: '{"deepseek":{"type":"api","key":"inherited"}}',
          OMO_PROFILE: "inherited-profile",
          OCX_PROFILE: "inherited-profile",
          OPENCODE_CONFIG_DIR: "/tmp/inherited-config",
        },
        omoProfile: "hanse-app-abc",
      }),
    );
    for (const key of ["OPENCODE_AUTH_CONTENT", "OCX_PROFILE", "OPENCODE_CONFIG_DIR"]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.OMO_PROFILE).toBe("hanse-app-abc");
  });

  it("omits OMO_PROFILE when no profile was applied", () => {
    const env = buildInstanceEnv(launchInput({ baseEnv: { OMO_PROFILE: "inherited" } }));
    expect(env.OMO_PROFILE).toBeUndefined();
  });

  it("includes the model, extra MCP servers, and managed web permissions", () => {
    const web: LaunchInput["web"] = {
      search: {
        value: { driver: "deepseek", options: { provider: "deepseek" } },
        state: "set",
        source: "global",
        sources: ["global"],
      },
      fetch: { value: null, state: "cleared", source: "global", sources: ["global"] },
    };
    const env = buildInstanceEnv(
      launchInput({
        model: "deepseek/deepseek-pro",
        web,
        mcpServers: {
          hanse_web: {
            type: "local",
            command: ["node", "main.js", "web-mcp"],
            environment: {
              HANSE_WEB_CONFIG: '{"search":{"provider":"deepseek"}}',
              HANSE_OPENCODE_AUTH_FILE: "/rt/p/web/data/opencode/auth.json",
            },
          },
        },
      }),
    );
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      model?: string;
      mcp?: Record<string, { environment?: Record<string, string> }>;
      permission?: {
        websearch?: string;
        webfetch?: string;
        hanse_web_search?: string;
        hanse_web_fetch?: string;
      };
    };
    expect(overlay.model).toBe("deepseek/deepseek-pro");
    expect(overlay.mcp?.hanse_web?.environment).toEqual({
      HANSE_WEB_CONFIG: '{"search":{"provider":"deepseek"}}',
      HANSE_OPENCODE_AUTH_FILE: "/rt/p/web/data/opencode/auth.json",
    });
    expect(overlay.permission?.websearch).toBe("deny");
    expect(overlay.permission?.webfetch).toBe("deny");
    expect(overlay.permission?.hanse_web_search).toBe("allow");
    expect(overlay.permission?.hanse_web_fetch).toBeUndefined();
  });
});

describe("launcher custom providers", () => {
  it("projects custom providers into the overlay", () => {
    const providers: Record<string, ProviderOverlay> = {
      "llm-lan": {
        npm: "@ai-sdk/openai-compatible",
        name: "LLM LAN",
        options: { baseURL: "http://gateway:4000/v1" },
        models: { deepseek: { limit: { context: 1000, output: 100 } } },
      },
    };
    const env = buildInstanceEnv(launchInput({ providers }));
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<string, unknown>;
    };
    expect(overlay.provider).toEqual(providers);
  });

  it("rejects a provider overlay over the environment budget", () => {
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
    expect(() => buildInstanceEnv(launchInput({ providers }))).toThrow(
      /provider_overlay_too_large/,
    );
  });
});
