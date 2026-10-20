import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeClient } from "../src/agent/client.js";
import type { AppRuntimeSpec } from "../src/agent/spec.js";
import { InstanceManager, type ManagedApp } from "../src/opencode/manager.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  containerWorkspace: string;
  hostWorkspace: string;
  containerAgents: string;
  hostAgents: string;
  appDir: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-runtime-manager-"));
  dirs.push(base);
  const containerWorkspace = path.join(base, "container-workspace");
  const hostWorkspace = path.join(base, "host-workspace");
  const containerAgents = path.join(base, "container-agents");
  const hostAgents = path.join(base, "host-agents");
  const appDir = path.join(containerWorkspace, "p", "a");
  mkdirSync(appDir, { recursive: true });
  return { containerWorkspace, hostWorkspace, containerAgents, hostAgents, appDir };
}

function database(): SqliteDatabase {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-runtime-db-"));
  dirs.push(base);
  const db = openDatabase(path.join(base, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','a','AGENTS.md',?)",
  ).run(now);
  return db;
}

describe("InstanceManager B1 runner spec", () => {
  it("sends host paths/fixed runner network and records the container status", async () => {
    const f = fixture();
    const db = database();
    let observed: AppRuntimeSpec | undefined;
    const runtime: AgentRuntimeClient = {
      async ensure(spec) {
        observed = spec;
        return {
          appId: spec.appId,
          endpoint: "http://hanse-app-p-a:4100",
          state: "running",
          specHash: spec.specHash,
          version: null,
          containerId: "docker-id",
          containerName: "hanse-app-p-a",
        };
      },
      async delete() {
        return {
          appId: "p:a",
          endpoint: null,
          state: "stopped",
          specHash: null,
          version: null,
        };
      },
      async status() {
        return undefined;
      },
      async logs() {
        return undefined;
      },
      async reconcile() {
        return { stopped: [], apps: [] };
      },
    };
    const app: ManagedApp = {
      id: "p:a",
      projectId: "p",
      appKey: "a",
      appDir: f.appDir,
    };
    const manager = new InstanceManager(db, f.containerAgents, {
      runtime,
      workspaceRoot: f.containerWorkspace,
      agentsRoot: f.containerAgents,
      hostWorkspace: f.hostWorkspace,
      hostAgents: f.hostAgents,
      verify: async () => [],
    });

    await expect(manager.ensure(app)).resolves.toBe("http://hanse-app-p-a:4100");
    expect(observed?.pathMode).toBe("host");
    expect(observed?.networkName).toBe("hanse-app-p-a");
    expect(observed?.port).toBe(4100);
    expect(observed?.appDir).toBe(path.join(f.hostWorkspace, "p", "a"));
    expect(observed?.stateDir).toBe(path.join(f.hostAgents, "p", "a", "state"));
    expect(observed?.env.HOME).toBe(path.join(f.containerAgents, "p", "a", "home"));

    const row = db
      .prepare(
        "SELECT state, runtime_state AS runtimeState, container_id AS containerId, container_name AS containerName FROM instances WHERE app_id = 'p:a'",
      )
      .get() as {
      state: string;
      runtimeState: string;
      containerId: string;
      containerName: string;
    };
    expect(row).toEqual({
      state: "running",
      runtimeState: "running",
      containerId: "docker-id",
      containerName: "hanse-app-p-a",
    });

    await expect(manager.stopApp("p:a")).resolves.toBe(true);
    const stopped = db
      .prepare("SELECT state, runtime_state AS runtimeState FROM instances WHERE app_id = 'p:a'")
      .get() as { state: string; runtimeState: string };
    expect(stopped).toEqual({ state: "stopped", runtimeState: "stopped" });
  });
});
