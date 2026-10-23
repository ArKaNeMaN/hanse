import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSpecHash, validateAppRuntimeSpec } from "../src/agent/spec.js";
import { addApplication, createProject } from "../src/coordinator/provision.js";
import { ensureMasterAgent } from "../src/master/bootstrap.js";
import {
  MASTER_APP_ID,
  MASTER_APP_KEY,
  MASTER_DIR_NAME,
  MASTER_PROJECT_ID,
} from "../src/master/constants.js";
import { buildConfigOverlay } from "../src/opencode/instance.js";
import { InstanceManager } from "../src/opencode/manager.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { FakeAgentRuntime } from "./fixtures/fake-runtime.js";

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

function fixture(): {
  db: SqliteDatabase;
  workspace: string;
  agents: string;
  masterDir: string;
  settings: SettingsService;
} {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-master-runtime-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  const agents = path.join(root, "agents");
  mkdirSync(workspace);
  mkdirSync(agents);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  ensureMasterAgent(db, workspace);
  return {
    db,
    workspace,
    agents,
    masterDir: path.join(workspace, MASTER_DIR_NAME),
    settings: new SettingsService({ db, secretKey: randomBytes(32) }),
  };
}

const profiles = {
  ensure: async () => ({ applied: false, contentHash: "profile" }),
  preview: () => ({ applied: false, contentHash: "profile" }),
};

describe("master runtime wiring", () => {
  it("hashes appDirReadOnly only when true", () => {
    const { workspace, agents } = fixture();
    const base = {
      appId: "p:app",
      image: "agent-default",
      pathMode: "container" as const,
      appDir: path.join(workspace, "p", "apps", "app"),
      stateDir: path.join(agents, "p", "app", "state"),
      networkName: "agents",
      env: {},
      resources: { memoryBytes: 1, nanoCpus: 1, pidsLimit: 1 },
      labels: {},
    };
    const ordinary = validateAppRuntimeSpec(base, { workspaceRoot: workspace, agentsRoot: agents });
    const explicitlyFalse = validateAppRuntimeSpec(
      { ...base, appDirReadOnly: false },
      { workspaceRoot: workspace, agentsRoot: agents },
    );
    const readOnly = validateAppRuntimeSpec(
      { ...base, appDirReadOnly: true },
      { workspaceRoot: workspace, agentsRoot: agents },
    );
    expect(explicitlyFalse.specHash).toBe(ordinary.specHash);
    expect(readOnly.specHash).not.toBe(ordinary.specHash);
    expect(computeSpecHash(readOnly)).toBe(readOnly.specHash);
  });

  it("launches the master with instructions, a read-only app dir, and no git credentials", async () => {
    const value = fixture();
    const runtime = new FakeAgentRuntime();
    const manager = new InstanceManager(value.db, value.agents, {
      runtime,
      settings: value.settings,
      omoProfiles: profiles,
      verify: async () => [],
      workspaceRoot: value.workspace,
    });
    await manager.ensure({
      id: MASTER_APP_ID,
      projectId: MASTER_PROJECT_ID,
      appKey: MASTER_APP_KEY,
      appDir: value.masterDir,
      instructions: [path.join(value.masterDir, "AGENTS.md")],
      gitCredentials: false,
      appDirReadOnly: true,
    });
    const spec = runtime.ensured[0];
    expect(spec).toBeDefined();
    if (spec === undefined) {
      return;
    }
    expect(spec.appDirReadOnly).toBe(true);
    const overlay = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      instructions?: string[];
    };
    expect(overlay.instructions).toEqual([path.join(value.masterDir, "AGENTS.md")]);
    expect(spec.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(spec.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(spec.env.GIT_ASKPASS).toBeUndefined();
    expect(spec.env.HANSE_CREDENTIALS_DIR).toBeUndefined();
    await manager.stopAll();
  });

  it("keeps ordinary applications read-write with git credentials and no master instructions", async () => {
    const value = fixture();
    const project = createProject(
      { db: value.db, workspaceRoot: value.workspace },
      { name: "Atlas" },
    );
    const app = addApplication(
      { db: value.db, workspaceRoot: value.workspace },
      { projectId: project.id, name: "Worker" },
    );
    const runtime = new FakeAgentRuntime();
    const manager = new InstanceManager(value.db, value.agents, {
      runtime,
      settings: value.settings,
      omoProfiles: profiles,
      verify: async () => [],
      workspaceRoot: value.workspace,
    });
    await manager.ensure({
      id: app.id,
      projectId: app.projectId,
      appKey: app.appKey,
      appDir: path.join(app.rootPath, app.path),
    });
    const spec = runtime.ensured[0];
    expect(spec).toBeDefined();
    if (spec === undefined) {
      return;
    }
    expect(spec.appDirReadOnly).toBeUndefined();
    const overlay = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      instructions?: string[];
    };
    expect(overlay.instructions).toBeUndefined();
    expect(spec.env.GIT_CONFIG_GLOBAL).toContain("hanse/git/config");
    await manager.stopAll();
  });

  it("passes instructions through the opencode overlay", () => {
    const overlay = buildConfigOverlay({
      coordinatorCommand: ["node", "hanse", "mcp"],
      instructions: ["/workspace/.hanse-master/AGENTS.md"],
    });
    expect(overlay.instructions).toEqual(["/workspace/.hanse-master/AGENTS.md"]);
  });
});
