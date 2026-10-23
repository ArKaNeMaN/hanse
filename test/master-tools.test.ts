import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addApplication, createProject } from "../src/coordinator/provision.js";
import { ensureMasterAgent } from "../src/master/bootstrap.js";
import { MASTER_APP_ID, MASTER_APP_KEY, MASTER_PROJECT_ID } from "../src/master/constants.js";
import { callMasterTool, type MasterToolContext, MasterToolError } from "../src/master/tools.js";
import { handleMasterRpc } from "../src/mcp/master.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { SettingsService } from "../src/settings/index.js";
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
  context: MasterToolContext;
  db: SqliteDatabase;
  workspace: string;
  ensureCalls: string[];
  restartCalls: string[];
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-master-tools-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  ensureMasterAgent(db, workspace);
  const settings = new SettingsService({ db, secretKey: randomBytes(32) });
  const ensureCalls: string[] = [];
  const restartCalls: string[] = [];
  const manager = {
    ensure: async (app: { id: string }) => {
      ensureCalls.push(app.id);
      return "http://127.0.0.1:1";
    },
    restartIfRunning: async (app: { id: string }) => {
      restartCalls.push(app.id);
      return true;
    },
    pendingRestart: () => ({ pending: false, reasons: [] }),
  } as unknown as InstanceManager;
  return {
    context: { db, workspaceRoot: workspace, settings, manager },
    db,
    workspace,
    ensureCalls,
    restartCalls,
  };
}

function project(fixtureValue: Fixture): { id: string; appId: string } {
  const created = createProject(
    { db: fixtureValue.db, workspaceRoot: fixtureValue.workspace },
    { name: "Atlas" },
  );
  const app = addApplication(
    { db: fixtureValue.db, workspaceRoot: fixtureValue.workspace },
    { projectId: created.id, name: "Reviewer" },
  );
  return { id: created.id, appId: app.id };
}

const MASTER = { appId: MASTER_APP_ID, appKey: MASTER_APP_KEY };

async function expectFailure(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MasterToolError);
    expect((error as MasterToolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("master tools", () => {
  it("lists projects and returns application details and settings", async () => {
    const value = fixture();
    const created = project(value);
    const listed = (await callMasterTool(value.context, MASTER, "list_projects", {})) as {
      projects: Array<{ id: string; builtin: boolean; apps: Array<{ appKey: string }> }>;
    };
    expect(listed.projects.map((entry) => entry.id).sort()).toEqual(
      [MASTER_PROJECT_ID, created.id].sort(),
    );
    expect(listed.projects.find((entry) => entry.id === MASTER_PROJECT_ID)?.builtin).toBe(true);
    const detail = (await callMasterTool(value.context, MASTER, "get_app", {
      project_id: created.id,
      app_key: "reviewer",
    })) as { app: { path: string; runtime: string }; settings: { effective: unknown } };
    expect(detail.app.path).toContain(path.join("apps", "reviewer"));
    expect(detail.app.runtime).toBe("stopped");
    expect(detail.settings.effective).toBeDefined();
  });

  it("writes and inherits a setting at application scope", async () => {
    const value = fixture();
    const created = project(value);
    const result = (await callMasterTool(value.context, MASTER, "set_setting", {
      key: "llm.model",
      value: "deepseek/deepseek-chat",
      project_id: created.id,
      app_key: "reviewer",
    })) as { scope: string; effective: { value: string; source: string } };
    expect(result.scope).toBe("app");
    expect(result.effective).toEqual({
      value: "deepseek/deepseek-chat",
      source: "app",
      state: "set",
      sources: ["app"],
    });
    await callMasterTool(value.context, MASTER, "inherit_setting", {
      key: "llm.model",
      scope: "app",
      project_id: created.id,
      app_key: "reviewer",
    });
    const settings = (await callMasterTool(value.context, MASTER, "get_settings", {
      project_id: created.id,
      app_key: "reviewer",
    })) as { settings: { effective: { llm: { model: { source: string } } } } };
    expect(settings.settings.effective.llm.model.source).toBe("default");
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "set_setting", {
          key: "not.a.key",
          value: 1,
          project_id: created.id,
        }),
      "invalid_argument",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "set_setting", {
          key: "llm.model",
          value: "x/y",
          project_id: "missing",
        }),
      "unknown_project",
    );
    const cleared = (await callMasterTool(value.context, MASTER, "set_setting", {
      key: "web.search",
      value: null,
      project_id: created.id,
      app_key: "reviewer",
    })) as { cleared: boolean; effective: { state: string } };
    expect(cleared.cleared).toBe(true);
    expect(cleared.effective.state).toBe("cleared");
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "set_setting", {
          key: "llm.model",
          value: null,
          project_id: created.id,
          app_key: "reviewer",
        }),
      "invalid_argument",
    );
  });

  it("creates projects and applications and writes workspace files", async () => {
    const value = fixture();
    const created = (await callMasterTool(value.context, MASTER, "create_project", {
      name: "Nova",
    })) as { project: { id: string; rootPath: string } };
    await callMasterTool(value.context, MASTER, "add_app", {
      project_id: created.project.id,
      name: "Worker",
    });
    await callMasterTool(value.context, MASTER, "write_file", {
      path: "nova/apps/worker/AGENTS.md",
      content: "# Worker\n",
    });
    const read = (await callMasterTool(value.context, MASTER, "read_file", {
      path: "nova/apps/worker/AGENTS.md",
    })) as { content: string };
    expect(read.content).toBe("# Worker\n");
    const events = value.db
      .prepare("SELECT type FROM events WHERE scope = 'master' ORDER BY id")
      .all() as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "master.project_created",
      "master.app_added",
      "master.file_written",
    ]);
  });

  it("starts and restarts application agents but refuses the master itself", async () => {
    const value = fixture();
    const created = project(value);
    await callMasterTool(value.context, MASTER, "start_app", {
      project_id: created.id,
      app_key: "reviewer",
    });
    await callMasterTool(value.context, MASTER, "restart_app", {
      project_id: created.id,
      app_key: "reviewer",
    });
    expect(value.ensureCalls).toEqual([created.appId]);
    expect(value.restartCalls).toEqual([created.appId]);
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "start_app", {
          project_id: MASTER_PROJECT_ID,
          app_key: MASTER_APP_KEY,
        }),
      "self_restart_unsupported",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "restart_app", {
          project_id: MASTER_PROJECT_ID,
          app_key: MASTER_APP_KEY,
        }),
      "self_restart_unsupported",
    );
    value.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(created.appId);
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "start_app", {
          project_id: created.id,
          app_key: "reviewer",
        }),
      "deletion_pending",
    );
  });

  it("rejects a non-master identity and unknown tools", async () => {
    const value = fixture();
    await expectFailure(
      () => callMasterTool(value.context, { appId: "p:a", appKey: "a" }, "list_projects", {}),
      "forbidden",
    );
    await expectFailure(
      () => callMasterTool(value.context, MASTER, "ssh_exec", {}),
      "unknown_tool",
    );
  });

  it("advertises only master tools and rejects SSH/handoff calls", async () => {
    const value = fixture();
    const listed = await handleMasterRpc(
      value.context,
      {
        appId: MASTER_APP_ID,
        projectId: MASTER_PROJECT_ID,
        appKey: MASTER_APP_KEY,
      },
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
    );
    if (listed === undefined || listed.result === undefined) {
      throw new Error("tools/list returned no result");
    }
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toContain("list_projects");
    expect(tools.map((tool) => tool.name)).not.toContain("ssh_exec");
    expect(tools.map((tool) => tool.name)).not.toContain("deliver_handoff");
    const called = await handleMasterRpc(
      value.context,
      {
        appId: MASTER_APP_ID,
        projectId: MASTER_PROJECT_ID,
        appKey: MASTER_APP_KEY,
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ssh_exec", arguments: {} },
      },
    );
    if (called === undefined || called.result === undefined) {
      throw new Error("tools/call returned no result");
    }
    const content = (called.result as { content: Array<{ text: string }> }).content;
    const text = content[0]?.text;
    expect(text).toBeDefined();
    expect(JSON.parse(text ?? "")).toMatchObject({ ok: false, code: "unknown_tool" });
  });
});
