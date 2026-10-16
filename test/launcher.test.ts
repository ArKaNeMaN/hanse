import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstanceEnv, launchInstance, stopInstance } from "../src/opencode/launcher.js";
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

describe("launcher", () => {
  it("composes an isolated environment with the overlay", () => {
    const env = buildInstanceEnv({
      appId: "p:web",
      identity: { projectId: "p", app: "web" },
      appDir: "/tmp",
      runtimeRoot: "/rt",
      port: 4096,
      coordinatorCommand: ["hanse", "mcp"],
    });
    expect(env.XDG_DATA_HOME).toBe("/rt/apps/web/data");
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      mcp?: Record<string, unknown>;
    };
    expect(overlay.mcp?.hanse).toBeDefined();
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
});
