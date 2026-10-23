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
import { SkillService } from "../src/skills/index.js";
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
  skills: SkillService;
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
  const skills = new SkillService({ db });
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
    context: { db, workspaceRoot: workspace, settings, manager, skills },
    db,
    workspace,
    skills,
    ensureCalls,
    restartCalls,
  };
}

function namedProject(fixtureValue: Fixture, name: string): { id: string; appId: string } {
  const created = createProject(
    { db: fixtureValue.db, workspaceRoot: fixtureValue.workspace },
    { name },
  );
  const app = addApplication(
    { db: fixtureValue.db, workspaceRoot: fixtureValue.workspace },
    { projectId: created.id, name: "Reviewer" },
  );
  return { id: created.id, appId: app.id };
}

function project(fixtureValue: Fixture): { id: string; appId: string } {
  return namedProject(fixtureValue, "Atlas");
}

function countRows(fixtureValue: Fixture, table: "skills" | "skill_references"): number {
  const row = fixtureValue.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function insertStarting(fixtureValue: Fixture, appId: string): void {
  fixtureValue.db
    .prepare("INSERT INTO instances (id, app_id, state, updated_at) VALUES (?, ?, 'starting', ?)")
    .run(`instance-${appId}`, appId, new Date().toISOString());
}

interface CreatedSkill {
  id: number;
  scope: string;
  projectId: string;
  appKey: string;
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  enabled: boolean;
  references: Array<{ path: string; size: number }>;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface CreateSkillResult {
  ok: true;
  skill: CreatedSkill;
  shadows: string[];
  shadowedBy: string[];
  appsInScope: { total: number; running: number };
  pendingRestart?: { pending: boolean; reasons: string[] };
  warnings?: string[];
}

async function createSkill(
  fixtureValue: Fixture,
  args: Record<string, unknown>,
): Promise<CreateSkillResult> {
  return (await callMasterTool(
    fixtureValue.context,
    MASTER,
    "create_skill",
    args,
  )) as CreateSkillResult;
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

  it("advertises create_skill with its scope and confirmation schema", async () => {
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
    const tool = tools.find((entry) => entry.name === "create_skill") as unknown as {
      inputSchema: {
        properties: {
          scope: { enum: string[] };
          confirm_global: { type: string };
        };
        required: string[];
      };
    };
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["scope", "name", "description", "content"]);
    expect(tool.inputSchema.properties.scope.enum).toEqual(["global", "project", "app"]);
    expect(tool.inputSchema.properties.confirm_global.type).toBe("boolean");
  });

  it("rejects malformed create arguments and enabled injection", async () => {
    const value = fixture();
    const created = project(value);
    const base = { name: "bad-skill", description: "d", content: "c" };
    await expectFailure(
      () => callMasterTool(value.context, MASTER, "create_skill", base),
      "invalid_argument",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "invalid",
        }),
      "invalid_argument",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "global",
          confirm_global: true,
          enabled: false,
        }),
      "invalid_argument",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "global",
          confirm_global: "yes",
        }),
      "invalid_argument",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "global",
          confirm_global: false,
        }),
      "confirmation_required",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "app",
          project_id: created.id,
          app_key: "reviewer",
          confirm_global: true,
        }),
      "invalid_argument",
    );
    expect(countRows(value, "skills")).toBe(0);
  });

  it("requires explicit confirmation for global skills", async () => {
    const value = fixture();
    const args = { scope: "global", name: "global-check", description: "d", content: "c" };
    await expectFailure(
      () => callMasterTool(value.context, MASTER, "create_skill", args),
      "confirmation_required",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...args,
          confirm_global: false,
        }),
      "confirmation_required",
    );
    const result = await createSkill(value, { ...args, confirm_global: true });
    expect(result.skill.scope).toBe("global");
    expect(value.skills.get(result.skill.id)?.name).toBe("global-check");
  });

  it("creates full bundles at all three scopes without echoing content", async () => {
    const value = fixture();
    const created = project(value);
    const bundle = {
      description: "App description",
      content: "App body",
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "arkan" },
      references: [{ path: "references/guide.md", content: "# Guide\n" }],
    };
    const global = await createSkill(value, {
      scope: "global",
      confirm_global: true,
      name: "global-skill",
      ...bundle,
    });
    const projectSkill = await createSkill(value, {
      scope: "project",
      project_id: created.id,
      name: "project-skill",
      ...bundle,
    });
    const appSkill = await createSkill(value, {
      scope: "app",
      project_id: created.id,
      app_key: "reviewer",
      name: "app-skill",
      ...bundle,
    });
    expect(global.skill.projectId).toBe("");
    expect(projectSkill.skill.projectId).toBe(created.id);
    expect(projectSkill.skill.appKey).toBe("");
    expect(appSkill.skill.projectId).toBe(created.id);
    expect(appSkill.skill.appKey).toBe("reviewer");
    expect(appSkill.skill.description).toBe("App description");
    expect(appSkill.skill.license).toBe("MIT");
    expect(appSkill.skill.compatibility).toBe("Node >= 20");
    expect(appSkill.skill.metadata).toEqual({ author: "arkan" });
    expect(appSkill.skill.enabled).toBe(true);
    expect(appSkill.skill.updatedBy).toBe("master");
    expect(appSkill.skill.references).toEqual([{ path: "references/guide.md", size: 8 }]);
    expect("content" in appSkill.skill).toBe(false);
    expect("metadataRaw" in appSkill.skill).toBe(false);
    expect("storedIssues" in appSkill.skill).toBe(false);
    expect("content" in appSkill.skill.references[0]).toBe(false);
    const stored = value.skills.get(appSkill.skill.id);
    expect(stored?.content).toBe("App body");
    expect(stored?.license).toBe("MIT");
    expect(stored?.references[0]?.content).toBe("# Guide\n");
  });

  it("guards unknown, reserved, and deleting targets", async () => {
    const value = fixture();
    const created = project(value);
    const base = {
      scope: "project",
      project_id: created.id,
      name: "guard-skill",
      description: "d",
      content: "c",
    };
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          project_id: "missing",
        }),
      "unknown_project",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "app",
          app_key: "missing",
        }),
      "unknown_app",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          project_id: MASTER_PROJECT_ID,
        }),
      "master_protected",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "app",
          project_id: MASTER_PROJECT_ID,
          app_key: MASTER_APP_KEY,
        }),
      "master_protected",
    );
    value.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(created.id);
    await expectFailure(
      () => callMasterTool(value.context, MASTER, "create_skill", base),
      "deletion_pending",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "app",
          app_key: "missing",
        }),
      "deletion_pending",
    );
    value.db.prepare("UPDATE projects SET deleting = 0 WHERE id = ?").run(created.id);
    value.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(created.appId);
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          ...base,
          scope: "app",
          app_key: "reviewer",
        }),
      "deletion_pending",
    );
    expect(countRows(value, "skills")).toBe(0);
  });

  it("reports conflicts and wider shadowing", async () => {
    const value = fixture();
    const created = project(value);
    const global = await createSkill(value, {
      scope: "global",
      confirm_global: true,
      name: "shared",
      description: "global",
      content: "global",
    });
    const projectSkill = await createSkill(value, {
      scope: "project",
      project_id: created.id,
      name: "shared",
      description: "project",
      content: "project",
    });
    expect(global.skill.scope).toBe("global");
    expect(projectSkill.shadows).toEqual(["global"]);
    expect(
      value.skills
        .resolve({ projectId: created.id })
        .effective.find((entry) => entry.name === "shared")?.id,
    ).toBe(projectSkill.skill.id);
    const first = await createSkill(value, {
      scope: "app",
      project_id: created.id,
      app_key: "reviewer",
      name: "duplicate",
      description: "d",
      content: "c",
    });
    let caught: MasterToolError | undefined;
    try {
      await callMasterTool(value.context, MASTER, "create_skill", {
        scope: "app",
        project_id: created.id,
        app_key: "reviewer",
        name: "duplicate",
        description: "d",
        content: "c",
      });
    } catch (error) {
      caught = error as MasterToolError;
    }
    expect(caught?.code).toBe("skill_exists");
    expect(caught?.message).toContain(`id ${first.skill.id}`);
    expect(caught?.message).toContain("updated by master");
  });

  it("reports narrower same-name scopes conservatively", async () => {
    const value = fixture();
    const one = namedProject(value, "One");
    const two = namedProject(value, "Two");
    await createSkill(value, {
      scope: "project",
      project_id: one.id,
      name: "early",
      description: "d",
      content: "c",
    });
    await createSkill(value, {
      scope: "project",
      project_id: two.id,
      name: "early",
      description: "d",
      content: "c",
    });
    await createSkill(value, {
      scope: "app",
      project_id: one.id,
      app_key: "reviewer",
      name: "early",
      description: "d",
      content: "c",
    });
    const wide = await createSkill(value, {
      scope: "global",
      confirm_global: true,
      name: "early",
      description: "d",
      content: "c",
    });
    expect(wide.shadows).toEqual([]);
    expect(wide.shadowedBy).toEqual(["project", "app"]);

    const three = namedProject(value, "Three");
    const hidden = await createSkill(value, {
      scope: "project",
      project_id: three.id,
      name: "hidden",
      description: "d",
      content: "c",
    });
    value.skills.update(hidden.skill.id, { enabled: false }, "test");
    const hiddenWide = await createSkill(value, {
      scope: "global",
      confirm_global: true,
      name: "hidden",
      description: "d",
      content: "c",
    });
    expect(hiddenWide.shadowedBy).toEqual(["project"]);

    const four = namedProject(value, "Four");
    await createSkill(value, {
      scope: "project",
      project_id: four.id,
      name: "gone",
      description: "d",
      content: "c",
    });
    value.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(four.id);
    const goneWide = await createSkill(value, {
      scope: "global",
      confirm_global: true,
      name: "gone",
      description: "d",
      content: "c",
    });
    expect(goneWide.shadowedBy).toEqual([]);

    const five = namedProject(value, "Five");
    await createSkill(value, {
      scope: "app",
      project_id: five.id,
      app_key: "reviewer",
      name: "gone-app",
      description: "d",
      content: "c",
    });
    value.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(five.appId);
    const goneAppWide = await createSkill(value, {
      scope: "global",
      confirm_global: true,
      name: "gone-app",
      description: "d",
      content: "c",
    });
    expect(goneAppWide.shadowedBy).toEqual([]);
  });

  it("reports apps in scope and pending restarts", async () => {
    const value = fixture();
    const created = project(value);
    insertStarting(value, created.appId);
    const appSkill = await createSkill(value, {
      scope: "app",
      project_id: created.id,
      app_key: "reviewer",
      name: "metrics-app",
      description: "d",
      content: "c",
    });
    expect(appSkill.appsInScope).toEqual({ total: 1, running: 1 });
    expect(appSkill.pendingRestart).toEqual({ pending: false, reasons: [] });
    const projectSkill = await createSkill(value, {
      scope: "project",
      project_id: created.id,
      name: "metrics-project",
      description: "d",
      content: "c",
    });
    expect(projectSkill.appsInScope).toEqual({ total: 1, running: 1 });
    expect(projectSkill.pendingRestart).toBeUndefined();
    const global = await createSkill(value, {
      scope: "global",
      confirm_global: true,
      name: "metrics-global",
      description: "d",
      content: "c",
    });
    expect(global.appsInScope).toEqual({ total: 2, running: 1 });
    expect(global.pendingRestart).toBeUndefined();
    const other = addApplication(
      { db: value.db, workspaceRoot: value.workspace },
      { projectId: created.id, name: "Other" },
    );
    value.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(other.id);
    const afterDelete = await createSkill(value, {
      scope: "project",
      project_id: created.id,
      name: "metrics-after-delete",
      description: "d",
      content: "c",
    });
    expect(afterDelete.appsInScope).toEqual({ total: 1, running: 1 });
  });

  it("records a compact audit event", async () => {
    const value = fixture();
    const created = project(value);
    const result = await createSkill(value, {
      scope: "app",
      project_id: created.id,
      app_key: "reviewer",
      name: "event-skill",
      description: "description-marker",
      content: "  body-marker  ",
      metadata: { author: "metadata-marker" },
      references: [{ path: "references/ref.md", content: "ref-marker" }],
    });
    const event = value.db
      .prepare("SELECT payload FROM events WHERE type = 'master.skill_created' ORDER BY id DESC")
      .get() as { payload: string };
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      skillId: result.skill.id,
      scope: "app",
      projectId: created.id,
      appKey: "reviewer",
      name: "event-skill",
      referenceCount: 1,
      contentBytes: 11,
      referenceBytes: 10,
    });
    expect(event.payload).not.toContain("body-marker");
    expect(event.payload).not.toContain("description-marker");
    expect(event.payload).not.toContain("metadata-marker");
    expect(event.payload).not.toContain("ref-marker");
    expect(payload).not.toHaveProperty("description");
    expect(payload).not.toHaveProperty("metadata");
    expect(payload).not.toHaveProperty("references");
  });

  it("rolls back the skill and references when the audit insert fails", async () => {
    const value = fixture();
    const created = project(value);
    value.db.exec("DROP TABLE events");
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          scope: "app",
          project_id: created.id,
          app_key: "reviewer",
          name: "rollback-skill",
          description: "d",
          content: "c",
          references: [{ path: "references/r.md", content: "r" }],
        }),
      "internal_error",
    );
    expect(countRows(value, "skills")).toBe(0);
    expect(countRows(value, "skill_references")).toBe(0);
  });

  it("reports unavailable and validation failures", async () => {
    const value = fixture();
    const created = project(value);
    await expectFailure(
      () =>
        callMasterTool({ ...value.context, skills: undefined }, MASTER, "create_skill", {
          scope: "project",
          project_id: created.id,
          name: "no-service",
          description: "d",
          content: "c",
        }),
      "unavailable",
    );
    await expectFailure(
      () =>
        callMasterTool(value.context, MASTER, "create_skill", {
          scope: "app",
          project_id: created.id,
          app_key: "reviewer",
          name: "invalid-reference",
          description: "d",
          content: "c",
          references: [{ path: "references/Bad.md", content: "x" }],
        }),
      "invalid_skill",
    );
    expect(countRows(value, "skills")).toBe(0);
  });

  it("keeps a create successful when pending restart lookup fails", async () => {
    const value = fixture();
    const created = project(value);
    const manager = {
      ...(value.context.manager as InstanceManager),
      pendingRestart: () => {
        throw new Error("pending restart failed");
      },
    } as unknown as InstanceManager;
    const result = (await callMasterTool({ ...value.context, manager }, MASTER, "create_skill", {
      scope: "app",
      project_id: created.id,
      app_key: "reviewer",
      name: "pending-failure",
      description: "d",
      content: "c",
    })) as CreateSkillResult;
    expect(result.ok).toBe(true);
    expect(result.pendingRestart).toEqual({ pending: false, reasons: [] });
    expect(result.warnings).toContain("post_create_enrichment");
  });

  it("keeps a create successful when shadow lookup fails", async () => {
    const value = fixture();
    const created = project(value);
    const throwingSkills = {
      create: value.skills.create.bind(value.skills),
      resolve: () => {
        throw new Error("resolve failed");
      },
    } as unknown as SkillService;
    const result = (await callMasterTool(
      { ...value.context, skills: throwingSkills },
      MASTER,
      "create_skill",
      {
        scope: "app",
        project_id: created.id,
        app_key: "reviewer",
        name: "shadow-failure",
        description: "d",
        content: "c",
      },
    )) as CreateSkillResult;
    expect(result.ok).toBe(true);
    expect(result.shadows).toEqual([]);
    expect(result.warnings).toContain("post_create_enrichment");
  });

  it("keeps a create successful when app counts cannot be read", async () => {
    const value = fixture();
    const created = project(value);
    value.db.exec("DROP TABLE instances");
    const result = await createSkill(value, {
      scope: "app",
      project_id: created.id,
      app_key: "reviewer",
      name: "count-failure",
      description: "d",
      content: "c",
    });
    expect(result.ok).toBe(true);
    expect(result.appsInScope).toEqual({ total: 0, running: 0 });
    expect(result.warnings).toContain("post_create_enrichment");
  });
});
