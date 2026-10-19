import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(env.XDG_DATA_HOME).toBe("/rt/apps/web/data");
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: Record<string, unknown>;
      plugin?: string[];
    };
    expect(overlay.mcp?.hanse).toBeDefined();
    expect(overlay.mcp?.codegraph).toBeDefined();
    expect(overlay.plugin).toEqual([plugin]);
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
            HANSE_API_BASE: "http://127.0.0.1:8787",
            HANSE_AUTH_FILE: "/state/auth.json",
            HANSE_DB: "/state/coordinator.db",
            HANSE_STATE_HOME: "/state",
            HANSE_KEEP: "kept",
          },
        }),
      );
      for (const key of [
        "HANSE_OPERATOR_TOKEN",
        "OPENCODE_PERMISSION",
        "HANSE_API_BASE",
        "HANSE_AUTH_FILE",
        "HANSE_DB",
        "HANSE_STATE_HOME",
      ]) {
        expect(env[key]).toBeUndefined();
      }
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
          HANSE_DB: "/state/coordinator.db",
          HANSE_PROJECT_ID: "p",
          HANSE_APP_KEY: "web",
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
      HANSE_DB: "/state/coordinator.db",
      HANSE_PROJECT_ID: "p",
      HANSE_APP_KEY: "web",
    });
    expect(overlay.permission?.external_directory?.["*"]).toBe("deny");
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
});
