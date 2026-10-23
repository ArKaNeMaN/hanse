import { afterEach, describe, expect, it } from "vitest";
import type { InstanceManager } from "../src/opencode/manager.js";
import { callAppSkillTool } from "../src/skills/app-tools.js";
import {
  type SkillRow,
  type SkillScope,
  SkillService,
  type SkillTarget,
} from "../src/skills/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const SENTINEL_BODY = "SENTINEL__BODY";
const SENTINEL_REF = "SENTINEL__REF";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
});

interface Fixture {
  db: SqliteDatabase;
  skills: SkillService;
  manager: InstanceManager;
  pendingRestarts: string[];
  ensureCalls: string[];
  restartCalls: string[];
}

function fixture(): Fixture {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp/p',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('q','Q','main','/tmp/q',?,?)",
  ).run(now, now);
  for (const [id, project, appKey] of [
    ["p:a", "p", "a"],
    ["p:b", "p", "b"],
    ["q:c", "q", "c"],
  ] as const) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, ?, ?, ?, 'AGENTS.md', ?)",
    ).run(id, project, appKey, `apps/${appKey}`, now);
  }
  const pendingRestarts: string[] = [];
  const ensureCalls: string[] = [];
  const restartCalls: string[] = [];
  const manager = {
    pendingRestart: (appId: string) => {
      pendingRestarts.push(appId);
      return { pending: true, reasons: ["settings_changed"] };
    },
    ensure: async (app: { id: string }) => {
      ensureCalls.push(app.id);
    },
    restartIfRunning: async (app: { id: string }) => {
      restartCalls.push(app.id);
      return true;
    },
  } as unknown as InstanceManager;
  return {
    db,
    skills: new SkillService({ db }),
    manager,
    pendingRestarts,
    ensureCalls,
    restartCalls,
  };
}

function agent(projectId: string, appKey: string) {
  return { appId: `${projectId}:${appKey}`, projectId, appKey };
}

async function call(
  f: Fixture,
  actor: ReturnType<typeof agent>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return callAppSkillTool({ db: f.db, skills: f.skills, manager: f.manager }, actor, name, args);
}

function expectFailure(result: unknown, code: string): void {
  expect(result).toMatchObject({ ok: false, code });
  expect(result).not.toHaveProperty("skill");
}

function createSkill(
  f: Fixture,
  scope: SkillScope,
  target: SkillTarget,
  name: string,
  options: { content?: string; references?: Array<{ path: string; content: string }> } = {},
): SkillRow {
  return f.skills.create(
    scope,
    target,
    {
      name,
      description: `description for ${name}`,
      content: options.content ?? `body for ${name}`,
      ...(options.references === undefined ? {} : { references: options.references }),
    },
    "app:p:a",
  );
}

function disable(f: Fixture, row: SkillRow): void {
  f.skills.update(row.id, { enabled: false }, "operator");
}

function insertRawSkill(
  f: Fixture,
  input: {
    scope: SkillScope;
    projectId: string;
    appKey: string;
    name: string;
    metadataJson: string;
  },
): number {
  const now = new Date().toISOString();
  f.db.pragma("ignore_check_constraints = ON");
  try {
    const result = f.db
      .prepare(
        `INSERT INTO skills
           (scope, project_id, app_key, name, description, content, enabled,
            license, compatibility, metadata_json, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 'raw description', 'raw body', 1, NULL, NULL, ?, ?, ?, 'raw')`,
      )
      .run(input.scope, input.projectId, input.appKey, input.name, input.metadataJson, now, now);
    return Number(result.lastInsertRowid);
  } finally {
    f.db.pragma("ignore_check_constraints = OFF");
  }
}

function countSkills(db: SqliteDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number }).n;
}

function countReferences(db: SqliteDatabase): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM skill_references").get() as { n: number }).n;
}

interface EventRow {
  scope: string;
  type: string;
  payload: Record<string, unknown>;
}

function events(f: Fixture, type?: string): EventRow[] {
  const rows = f.db.prepare("SELECT scope, type, payload FROM events ORDER BY id").all() as Array<{
    scope: string;
    type: string;
    payload: string;
  }>;
  return rows
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }))
    .filter((row) => type === undefined || row.type === type);
}

function setDeleting(f: Fixture, target: { projectId?: string; appId?: string }): void {
  if (target.projectId !== undefined) {
    f.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(target.projectId);
  }
  if (target.appId !== undefined) {
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(target.appId);
  }
}

interface Seeded {
  global: SkillRow;
  project: SkillRow;
  app: SkillRow;
  sibling: SkillRow;
  other: SkillRow;
  shadowGlobal: SkillRow;
  shadowApp: SkillRow;
  disabledGlobal: SkillRow;
  disabledProject: SkillRow;
  invalidGlobal: number;
  invalidProject: number;
  ownDisabled: SkillRow;
  ownInvalid: number;
}

function seed(f: Fixture): Seeded {
  const global = createSkill(f, "global", {}, "global-skill", {
    content: SENTINEL_BODY,
    references: [{ path: "references/a.md", content: SENTINEL_REF }],
  });
  const project = createSkill(f, "project", { projectId: "p" }, "project-skill");
  const app = createSkill(f, "app", { projectId: "p", appKey: "a" }, "app-skill", {
    content: SENTINEL_BODY,
    references: [{ path: "references/a.md", content: SENTINEL_REF }],
  });
  const sibling = createSkill(f, "app", { projectId: "p", appKey: "b" }, "sibling-skill");
  const other = createSkill(f, "app", { projectId: "q", appKey: "c" }, "other-skill");
  const shadowGlobal = createSkill(f, "global", {}, "shadowed");
  const shadowApp = createSkill(f, "app", { projectId: "p", appKey: "a" }, "shadowed");
  const disabledGlobal = createSkill(f, "global", {}, "disabled-global");
  disable(f, disabledGlobal);
  const disabledProject = createSkill(f, "project", { projectId: "p" }, "disabled-project");
  disable(f, disabledProject);
  const invalidGlobal = insertRawSkill(f, {
    scope: "global",
    projectId: "",
    appKey: "",
    name: "invalid-global",
    metadataJson: "{bad",
  });
  const invalidProject = insertRawSkill(f, {
    scope: "project",
    projectId: "p",
    appKey: "",
    name: "invalid-project",
    metadataJson: "{bad",
  });
  const ownDisabled = createSkill(f, "app", { projectId: "p", appKey: "a" }, "own-disabled");
  disable(f, ownDisabled);
  const ownInvalid = insertRawSkill(f, {
    scope: "app",
    projectId: "p",
    appKey: "a",
    name: "own-invalid",
    metadataJson: "{bad",
  });
  return {
    global,
    project,
    app,
    sibling,
    other,
    shadowGlobal,
    shadowApp,
    disabledGlobal,
    disabledProject,
    invalidGlobal,
    invalidProject,
    ownDisabled,
    ownInvalid,
  };
}

describe("app skill read tools", () => {
  it("reads effective global/project rows and the caller's own app rows", async () => {
    const f = fixture();
    const s = seed(f);
    const actor = agent("p", "a");

    for (const id of [s.global.id, s.project.id, s.app.id, s.shadowApp.id]) {
      const result = await call(f, actor, "get_skill", { skill_id: id });
      expect(result).toMatchObject({ ok: true });
      expect((result as { skill: { id: number } }).skill.id).toBe(id);
    }

    const detailed = await call(f, actor, "get_skill", { skill_id: s.app.id });
    expect(detailed).toMatchObject({
      ok: true,
      skill: {
        content: SENTINEL_BODY,
        references: [{ path: "references/a.md", content: SENTINEL_REF }],
      },
    });
  });

  it("reads the caller's own tombstone and invalid row", async () => {
    const f = fixture();
    const s = seed(f);
    const actor = agent("p", "a");

    const tombstone = await call(f, actor, "get_skill", { skill_id: s.ownDisabled.id });
    expect(tombstone).toMatchObject({ ok: true, skill: { enabled: false } });

    const invalid = await call(f, actor, "get_skill", { skill_id: s.ownInvalid });
    expect(invalid).toMatchObject({ ok: true, skill: { metadataRaw: "{bad" } });
    expect((invalid as { skill: { storedIssues: unknown[] } }).skill.storedIssues.length).toBe(1);
  });

  it("hides sibling, other-project, disabled, invalid, and shadowed wider rows", async () => {
    const f = fixture();
    const s = seed(f);
    const actor = agent("p", "a");

    for (const id of [
      s.sibling.id,
      s.other.id,
      s.disabledGlobal.id,
      s.disabledProject.id,
      s.invalidGlobal,
      s.invalidProject,
      s.shadowGlobal.id,
    ]) {
      const result = await call(f, actor, "get_skill", { skill_id: id });
      expectFailure(result, "unknown_skill");
      expect(JSON.stringify(result)).not.toContain(SENTINEL_BODY);
    }
  });

  it("lists only the caller's chain and never echoes skill bodies", async () => {
    const f = fixture();
    const s = seed(f);
    const actor = agent("p", "a");

    const result = await call(f, actor, "list_skills", {});
    expect(result).toMatchObject({
      ok: true,
      scope: "app",
      target: { projectId: "p", appKey: "a" },
    });
    const listed = result as {
      effective: Array<{ name: string }>;
      rows: Array<{ name: string }>;
      disabled: Array<{ name: string }>;
    };
    expect(listed.effective.map((entry) => entry.name)).toEqual([
      "app-skill",
      "global-skill",
      "project-skill",
      "shadowed",
    ]);
    expect(listed.rows.map((row) => row.name)).toEqual([
      "app-skill",
      "own-disabled",
      "own-invalid",
      "shadowed",
    ]);
    expect(listed.disabled.map((entry) => entry.name)).toEqual([
      "disabled-global",
      "disabled-project",
      "own-disabled",
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SENTINEL_BODY);
    expect(serialized).not.toContain(SENTINEL_REF);
    expect(serialized).not.toContain('"content"');

    const withUnknownArguments = await call(f, actor, "list_skills", {
      unexpected: true,
      skill_id: s.app.id,
    });
    expect(withUnknownArguments).toEqual(result);
  });

  it("rejects malformed read ids without writing", async () => {
    const f = fixture();
    seed(f);
    const actor = agent("p", "a");
    const before = countSkills(f.db);

    for (const args of [
      { skill_id: 0 },
      { skill_id: -1 },
      { skill_id: 1.5 },
      { skill_id: "1" },
      {},
    ]) {
      expectFailure(await call(f, actor, "get_skill", args), "invalid_argument");
    }

    expect(countSkills(f.db)).toBe(before);
  });
});

const MUTATION_DESCRIPTION = "SENTINEL__MUTATION_DESCRIPTION";
const MUTATION_BODY = "SENTINEL__MUTATION_BODY";
const MUTATION_REFERENCE = "SENTINEL__MUTATION_REFERENCE";
const MUTATION_METADATA = "SENTINEL__MUTATION_METADATA";

const CREATE_EVENT_KEYS = [
  "actor",
  "appKey",
  "contentBytes",
  "name",
  "projectId",
  "referenceBytes",
  "referenceCount",
  "scope",
  "skillId",
].sort();
const UPDATE_EVENT_KEYS = [
  "actor",
  "appKey",
  "changed",
  "contentBytes",
  "name",
  "projectId",
  "referenceBytes",
  "referenceCount",
  "scope",
  "skillId",
].sort();
const ENABLED_EVENT_KEYS = [
  "actor",
  "appKey",
  "enabled",
  "name",
  "projectId",
  "scope",
  "skillId",
].sort();
const OVERRIDE_EVENT_KEYS = [
  "actor",
  "appKey",
  "enabled",
  "name",
  "projectId",
  "referenceCount",
  "scope",
  "skillId",
  "sourceSkillId",
].sort();

function mutatedSkillId(result: unknown): number {
  return (result as { skill: { id: number } }).skill.id;
}

describe("app skill write tools", () => {
  it("rejects forbidden target arguments on every app tool", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const before = countSkills(f.db);

    for (const name of [
      "create_skill",
      "list_skills",
      "get_skill",
      "update_skill",
      "set_skill_enabled",
      "override_skill",
    ]) {
      for (const field of ["scope", "project_id", "app_key", "confirm_global"]) {
        const args: Record<string, unknown> = {
          name: "blocked",
          description: "blocked",
          content: "blocked",
          skill_id: 1,
          source_skill_id: 1,
          [field]: field === "scope" ? "global" : true,
        };
        expectFailure(await call(f, actor, name, args), "invalid_argument");
      }
    }

    expectFailure(
      await call(f, actor, "create_skill", {
        name: "blocked",
        description: "blocked",
        content: "blocked",
        enabled: true,
      }),
      "invalid_argument",
    );
    expectFailure(
      await call(f, actor, "create_skill", {
        name: "blocked",
        description: "blocked",
        content: "blocked",
        references: [{ path: "references/../escape.md", content: "blocked" }],
      }),
      "invalid_skill",
    );

    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toEqual([]);
  });

  it("creates a full bundle, records the app actor, and writes one event", async () => {
    const f = fixture();
    const actor = agent("p", "a");

    const result = await call(f, actor, "create_skill", {
      name: "release-checklist",
      description: MUTATION_DESCRIPTION,
      content: MUTATION_BODY,
      license: "MIT",
      compatibility: "opencode",
      metadata: { owner: MUTATION_METADATA },
      references: [{ path: "references/guide.md", content: MUTATION_REFERENCE }],
    });

    expect(result).toMatchObject({
      ok: true,
      skill: {
        name: "release-checklist",
        scope: "app",
        projectId: "p",
        appKey: "a",
        description: MUTATION_DESCRIPTION,
        license: "MIT",
        compatibility: "opencode",
        metadata: { owner: MUTATION_METADATA },
        enabled: true,
        updatedBy: "app:p:a",
      },
    });
    const id = mutatedSkillId(result);
    expect(f.skills.get(id)).toMatchObject({
      content: MUTATION_BODY,
      license: "MIT",
      compatibility: "opencode",
      metadata: { owner: MUTATION_METADATA },
      updatedBy: "app:p:a",
      references: [{ path: "references/guide.md", content: MUTATION_REFERENCE }],
    });

    const rows = events(f, "app.skill_created");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("expected one create event");
    }
    expect(row.scope).toBe("app");
    expect(row.payload).toEqual({
      actor: "app:p:a",
      skillId: id,
      scope: "app",
      projectId: "p",
      appKey: "a",
      name: "release-checklist",
      referenceCount: 1,
      contentBytes: Buffer.byteLength(MUTATION_BODY, "utf8"),
      referenceBytes: Buffer.byteLength(MUTATION_REFERENCE, "utf8"),
    });
    expect(Object.keys(row.payload).sort()).toEqual(CREATE_EVENT_KEYS);
    const serialized = JSON.stringify(row.payload);
    for (const sentinel of [
      MUTATION_BODY,
      MUTATION_DESCRIPTION,
      MUTATION_REFERENCE,
      MUTATION_METADATA,
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("rejects a same-scope duplicate with existing-row context", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const first = await call(f, actor, "create_skill", {
      name: "duplicate",
      description: "first",
      content: "first body",
    });
    const id = mutatedSkillId(first);
    const stored = f.skills.get(id);
    const before = countSkills(f.db);

    const second = await call(f, actor, "create_skill", {
      name: "duplicate",
      description: "second",
      content: "second body",
    });

    expectFailure(second, "skill_exists");
    const message = (second as { message: string }).message;
    expect(message).toContain(`id ${id}`);
    expect(message).toContain("updated by app:p:a");
    expect(message).toContain(stored?.updatedAt ?? "");
    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toHaveLength(1);
  });

  it("shadows wider same-name rows and reports the caller scope", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    createSkill(f, "global", {}, "shadowed");
    createSkill(f, "project", { projectId: "p" }, "shadowed");

    const result = await call(f, actor, "create_skill", {
      name: "shadowed",
      description: "app",
      content: "body",
    });

    expect(result).toMatchObject({
      ok: true,
      shadows: ["global", "project"],
      shadowedBy: [],
      appsInScope: { total: 1 },
    });
  });

  it("updates every mutable field and rejects immutable or foreign rows", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const app = createSkill(f, "app", { projectId: "p", appKey: "a" }, "edit-me", {
      references: [{ path: "references/a.md", content: "old" }],
    });
    const global = createSkill(f, "global", {}, "global-row");
    const project = createSkill(f, "project", { projectId: "p" }, "project-row");
    const sibling = createSkill(f, "app", { projectId: "p", appKey: "b" }, "sibling-row");

    const result = await call(f, actor, "update_skill", {
      skill_id: app.id,
      description: "new description",
      content: "new body",
      license: "Apache-2.0",
      compatibility: "v2",
      metadata: { team: "x" },
      references: [{ path: "references/b.md", content: "new ref" }],
    });

    expect(result).toMatchObject({
      ok: true,
      skill: {
        id: app.id,
        description: "new description",
        license: "Apache-2.0",
        compatibility: "v2",
        metadata: { team: "x" },
        updatedBy: "app:p:a",
      },
    });
    expect(f.skills.get(app.id)).toMatchObject({
      content: "new body",
      references: [{ path: "references/b.md", content: "new ref" }],
      updatedBy: "app:p:a",
    });

    const rows = events(f, "app.skill_updated");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("expected one update event");
    }
    expect(row.payload).toMatchObject({
      actor: "app:p:a",
      skillId: app.id,
      scope: "app",
      projectId: "p",
      appKey: "a",
      name: "edit-me",
      changed: ["description", "content", "license", "compatibility", "metadata", "references"],
      referenceCount: 1,
      contentBytes: Buffer.byteLength("new body", "utf8"),
      referenceBytes: Buffer.byteLength("new ref", "utf8"),
    });
    expect(Object.keys(row.payload).sort()).toEqual(UPDATE_EVENT_KEYS);

    expectFailure(await call(f, actor, "update_skill", { skill_id: app.id }), "invalid_argument");
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: app.id, name: "renamed" }),
      "invalid_argument",
    );
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: app.id, enabled: false }),
      "invalid_argument",
    );

    const globalSnapshot = f.skills.get(global.id);
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: global.id, description: "x" }),
      "invalid_argument",
    );
    expect(f.skills.get(global.id)).toEqual(globalSnapshot);

    const projectSnapshot = f.skills.get(project.id);
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: project.id, description: "x" }),
      "invalid_argument",
    );
    expect(f.skills.get(project.id)).toEqual(projectSnapshot);

    const siblingSnapshot = f.skills.get(sibling.id);
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: sibling.id, description: "x" }),
      "unknown_skill",
    );
    expect(f.skills.get(sibling.id)).toEqual(siblingSnapshot);
    expect(events(f, "app.skill_updated")).toHaveLength(1);
  });

  it("creates a tombstone that hides a wider name and restores it on enable", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const global = createSkill(f, "global", {}, "toggle");
    const app = createSkill(f, "app", { projectId: "p", appKey: "a" }, "toggle");
    const sibling = createSkill(f, "app", { projectId: "p", appKey: "b" }, "sibling-toggle");
    const target = { projectId: "p", appKey: "a" };

    const disabled = await call(f, actor, "set_skill_enabled", {
      skill_id: app.id,
      enabled: false,
    });
    expect(disabled).toMatchObject({
      ok: true,
      skill: { id: app.id, enabled: false },
      effective: false,
    });
    expect(
      f.skills.resolve(target).effective.find((entry) => entry.name === "toggle"),
    ).toBeUndefined();
    expect(f.skills.resolve(target).disabled).toContainEqual({
      id: app.id,
      name: "toggle",
      source: "global",
      disabledBy: "app",
    });

    const enabled = await call(f, actor, "set_skill_enabled", {
      skill_id: app.id,
      enabled: true,
    });
    expect(enabled).toMatchObject({ ok: true, skill: { enabled: true }, effective: true });
    expect(f.skills.resolve(target).effective.find((entry) => entry.name === "toggle")?.id).toBe(
      app.id,
    );

    expectFailure(
      await call(f, actor, "set_skill_enabled", {
        skill_id: global.id,
        enabled: false,
      }),
      "invalid_argument",
    );
    expectFailure(
      await call(f, actor, "set_skill_enabled", { skill_id: sibling.id, enabled: false }),
      "unknown_skill",
    );
    expectFailure(
      await call(f, actor, "set_skill_enabled", {
        skill_id: app.id,
        enabled: true,
        content: "not allowed",
      }),
      "invalid_argument",
    );

    const rows = events(f, "app.skill_enabled");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload).toEqual({
      actor: "app:p:a",
      skillId: app.id,
      scope: "app",
      projectId: "p",
      appKey: "a",
      name: "toggle",
      enabled: false,
    });
    expect(rows[1]?.payload).toEqual({
      actor: "app:p:a",
      skillId: app.id,
      scope: "app",
      projectId: "p",
      appKey: "a",
      name: "toggle",
      enabled: true,
    });
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual(ENABLED_EVENT_KEYS);
  });

  it("rejects writes while the caller project is deleting", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const app = createSkill(f, "app", { projectId: "p", appKey: "a" }, "guarded");
    const global = createSkill(f, "global", {}, "global-guarded");
    const sibling = createSkill(f, "app", { projectId: "p", appKey: "b" }, "sibling-guarded");
    setDeleting(f, { projectId: "p" });
    const before = countSkills(f.db);

    expectFailure(
      await call(f, actor, "create_skill", {
        name: "blocked",
        description: "blocked",
        content: "blocked",
      }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: app.id, description: "x" }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "set_skill_enabled", { skill_id: app.id, enabled: false }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: global.id, description: "x" }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "set_skill_enabled", { skill_id: sibling.id, enabled: false }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "override_skill", { source_skill_id: global.id }),
      "deletion_pending",
    );

    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toEqual([]);
    expect(await call(f, actor, "list_skills", {})).toMatchObject({ ok: true });
    expect(await call(f, actor, "get_skill", { skill_id: app.id })).toMatchObject({ ok: true });
  });

  it("rejects writes while the caller app is deleting", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const app = createSkill(f, "app", { projectId: "p", appKey: "a" }, "guarded-app");
    const global = createSkill(f, "global", {}, "global-guarded-app");
    const sibling = createSkill(f, "app", { projectId: "p", appKey: "b" }, "sibling-guarded-app");
    setDeleting(f, { appId: "p:a" });
    const before = countSkills(f.db);

    expectFailure(
      await call(f, actor, "create_skill", {
        name: "blocked",
        description: "blocked",
        content: "blocked",
      }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: app.id, description: "x" }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "set_skill_enabled", { skill_id: app.id, enabled: false }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "update_skill", { skill_id: global.id, description: "x" }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "set_skill_enabled", { skill_id: sibling.id, enabled: false }),
      "deletion_pending",
    );
    expectFailure(
      await call(f, actor, "override_skill", { source_skill_id: global.id }),
      "deletion_pending",
    );

    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toEqual([]);
    expect(await call(f, actor, "list_skills", {})).toMatchObject({ ok: true });
    expect(await call(f, actor, "get_skill", { skill_id: app.id })).toMatchObject({ ok: true });
  });

  it("writes exactly one content-free app event per successful mutation", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const source = createSkill(f, "global", {}, "event-source", {
      content: MUTATION_BODY,
      references: [{ path: "references/guide.md", content: MUTATION_REFERENCE }],
    });

    const created = await call(f, actor, "create_skill", {
      name: "event-skill",
      description: MUTATION_DESCRIPTION,
      content: MUTATION_BODY,
      metadata: { owner: MUTATION_METADATA },
      references: [{ path: "references/guide.md", content: MUTATION_REFERENCE }],
    });
    const id = mutatedSkillId(created);
    await call(f, actor, "update_skill", {
      skill_id: id,
      description: "updated description",
      content: MUTATION_BODY,
      references: [{ path: "references/guide.md", content: MUTATION_REFERENCE }],
    });
    await call(f, actor, "set_skill_enabled", { skill_id: id, enabled: false });
    await call(f, actor, "override_skill", { source_skill_id: source.id });

    const rows = events(f);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.type)).toEqual([
      "app.skill_created",
      "app.skill_updated",
      "app.skill_enabled",
      "app.skill_overridden",
    ]);
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual(CREATE_EVENT_KEYS);
    expect(Object.keys(rows[1]?.payload ?? {}).sort()).toEqual(UPDATE_EVENT_KEYS);
    expect(Object.keys(rows[2]?.payload ?? {}).sort()).toEqual(ENABLED_EVENT_KEYS);
    expect(Object.keys(rows[3]?.payload ?? {}).sort()).toEqual(OVERRIDE_EVENT_KEYS);
    for (const row of rows) {
      expect(row.scope).toBe("app");
      const serialized = JSON.stringify(row.payload);
      for (const sentinel of [
        MUTATION_BODY,
        MUTATION_DESCRIPTION,
        MUTATION_REFERENCE,
        MUTATION_METADATA,
      ]) {
        expect(serialized).not.toContain(sentinel);
      }
    }
  });

  it("rolls back the skill and references when the event insert fails", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    f.db.exec("DROP TABLE events");

    const result = await call(f, actor, "create_skill", {
      name: "rollback",
      description: "rollback",
      content: "rollback body",
      references: [{ path: "references/a.md", content: "rollback reference" }],
    });

    expectFailure(result, "internal_error");
    expect(countSkills(f.db)).toBe(0);
    expect(countReferences(f.db)).toBe(0);
  });

  it("rejects malformed write arguments without writing", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const before = countSkills(f.db);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["create_skill", { description: "d", content: "c" }],
      ["create_skill", { name: 1, description: "d", content: "c" }],
      ["update_skill", { skill_id: 0, description: "x" }],
      ["update_skill", { skill_id: -1, description: "x" }],
      ["update_skill", { skill_id: 1.5, description: "x" }],
      ["update_skill", { skill_id: "1", description: "x" }],
      ["update_skill", { description: "x" }],
      ["set_skill_enabled", { skill_id: 0, enabled: true }],
      ["set_skill_enabled", { skill_id: 1, enabled: "true" }],
      ["set_skill_enabled", { skill_id: 1 }],
    ];

    for (const [name, args] of cases) {
      expectFailure(await call(f, actor, name, args), "invalid_argument");
    }

    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toEqual([]);
  });

  it("returns content-free mutation projections and content-free stored issues", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const created = await call(f, actor, "create_skill", {
      name: "projected",
      description: "projected description",
      content: MUTATION_BODY,
      metadata: { owner: "team" },
      references: [{ path: "references/a.md", content: MUTATION_REFERENCE }],
    });
    const createdSkill = (created as { skill: Record<string, unknown> }).skill;
    expect(createdSkill).not.toHaveProperty("content");
    expect(createdSkill).not.toHaveProperty("metadataRaw");
    expect(createdSkill).not.toHaveProperty("storedIssues");
    expect(JSON.stringify(createdSkill)).not.toContain(MUTATION_BODY);
    expect(JSON.stringify(createdSkill)).not.toContain(MUTATION_REFERENCE);

    const id = mutatedSkillId(created);
    const updated = await call(f, actor, "update_skill", {
      skill_id: id,
      description: "updated description",
    });
    const updatedSkill = (updated as { skill: Record<string, unknown> }).skill;
    expect(updatedSkill).not.toHaveProperty("content");
    expect(updatedSkill).not.toHaveProperty("metadataRaw");
    expect(updatedSkill).not.toHaveProperty("storedIssues");
    expect(updated).toHaveProperty("storedIssues", []);
    expect(JSON.stringify(updatedSkill)).not.toContain(MUTATION_BODY);

    const enabled = await call(f, actor, "set_skill_enabled", { skill_id: id, enabled: false });
    const enabledSkill = (enabled as { skill: Record<string, unknown> }).skill;
    expect(enabledSkill).not.toHaveProperty("content");
    expect(enabledSkill).not.toHaveProperty("metadataRaw");
    expect(enabledSkill).not.toHaveProperty("storedIssues");
    expect(enabled).toHaveProperty("storedIssues", []);
    expect(JSON.stringify(enabledSkill)).not.toContain(MUTATION_BODY);
  });
});

describe("app skill override", () => {
  it("copies a visible global or project source into the caller's app scope", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const global = createSkill(f, "global", {}, "copy-global", {
      content: MUTATION_BODY,
      references: [{ path: "references/a.md", content: MUTATION_REFERENCE }],
    });
    const project = createSkill(f, "project", { projectId: "p" }, "copy-project");

    const fromGlobal = await call(f, actor, "override_skill", {
      source_skill_id: global.id,
    });
    expect(fromGlobal).toMatchObject({
      ok: true,
      skill: {
        name: "copy-global",
        scope: "app",
        projectId: "p",
        appKey: "a",
        enabled: true,
        updatedBy: "app:p:a",
      },
    });
    const globalCopyId = mutatedSkillId(fromGlobal);
    expect(f.skills.get(globalCopyId)).toMatchObject({
      content: MUTATION_BODY,
      references: [{ path: "references/a.md", content: MUTATION_REFERENCE }],
      updatedBy: "app:p:a",
    });

    const fromProject = await call(f, actor, "override_skill", {
      source_skill_id: project.id,
    });
    expect(fromProject).toMatchObject({
      ok: true,
      skill: { name: "copy-project", scope: "app", projectId: "p", appKey: "a" },
    });

    const rows = events(f, "app.skill_overridden");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.payload).toEqual({
      actor: "app:p:a",
      sourceSkillId: global.id,
      skillId: globalCopyId,
      scope: "app",
      projectId: "p",
      appKey: "a",
      name: "copy-global",
      enabled: true,
      referenceCount: 1,
    });
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual(OVERRIDE_EVENT_KEYS);
    const serialized = JSON.stringify(rows[0]?.payload);
    for (const sentinel of [MUTATION_BODY, MUTATION_REFERENCE]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("rejects a self-copy", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const own = createSkill(f, "app", { projectId: "p", appKey: "a" }, "self-copy");
    const before = countSkills(f.db);

    expectFailure(
      await call(f, actor, "override_skill", { source_skill_id: own.id }),
      "invalid_argument",
    );
    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toEqual([]);
  });

  it("requires replacement confirmation and then replaces the app row", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const source = createSkill(f, "global", {}, "replace-me", { content: "source body" });
    const existing = createSkill(f, "app", { projectId: "p", appKey: "a" }, "replace-me", {
      content: "old app body",
    });

    const rejected = await call(f, actor, "override_skill", {
      source_skill_id: source.id,
    });
    expectFailure(rejected, "replacement_confirmation_required");
    const message = (rejected as { message: string }).message;
    expect(message).toContain(`id ${existing.id}`);
    expect(message).toContain("confirm_replace: true");
    expect(f.skills.get(existing.id)).toMatchObject({ content: "old app body" });
    expect(events(f)).toEqual([]);

    const replaced = await call(f, actor, "override_skill", {
      source_skill_id: source.id,
      confirm_replace: true,
    });
    expect(replaced).toMatchObject({
      ok: true,
      skill: { id: existing.id, name: "replace-me", scope: "app" },
    });
    expect(f.skills.get(existing.id)).toMatchObject({
      content: "source body",
      updatedBy: "app:p:a",
    });
    expect(events(f, "app.skill_overridden")).toHaveLength(1);
  });

  it("rejects a disabled source before replacement confirmation", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const disabled = createSkill(f, "global", {}, "disabled-source");
    disable(f, disabled);
    createSkill(f, "app", { projectId: "p", appKey: "a" }, "disabled-source", {
      content: "local body",
    });
    const before = countSkills(f.db);

    const result = await call(f, actor, "override_skill", {
      source_skill_id: disabled.id,
    });

    expectFailure(result, "invalid_skill");
    expect((result as { message: string }).message).not.toContain("confirm_replace");
    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toEqual([]);
  });

  it("rejects invalid visible sources and hides sibling sources", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const invalidGlobal = insertRawSkill(f, {
      scope: "global",
      projectId: "",
      appKey: "",
      name: "invalid-source",
      metadataJson: "{bad",
    });
    const invalidName = insertRawSkill(f, {
      scope: "global",
      projectId: "",
      appKey: "",
      name: "Invalid Name",
      metadataJson: "{}",
    });
    const invalidProject = insertRawSkill(f, {
      scope: "project",
      projectId: "p",
      appKey: "",
      name: "invalid-project-source",
      metadataJson: "{bad",
    });
    const sibling = insertRawSkill(f, {
      scope: "app",
      projectId: "p",
      appKey: "b",
      name: "sibling-source",
      metadataJson: "{bad",
    });
    const before = countSkills(f.db);

    for (const id of [invalidGlobal, invalidName, invalidProject]) {
      expectFailure(
        await call(f, actor, "override_skill", { source_skill_id: id }),
        "invalid_skill",
      );
    }
    expectFailure(
      await call(f, actor, "override_skill", { source_skill_id: sibling }),
      "unknown_skill",
    );

    expect(countSkills(f.db)).toBe(before);
    expect(events(f)).toEqual([]);
  });

  it("returns a content-free override projection", async () => {
    const f = fixture();
    const actor = agent("p", "a");
    const source = createSkill(f, "global", {}, "projected-source", {
      content: MUTATION_BODY,
      references: [{ path: "references/a.md", content: MUTATION_REFERENCE }],
    });

    const result = await call(f, actor, "override_skill", {
      source_skill_id: source.id,
    });
    const skill = (result as { skill: Record<string, unknown> }).skill;

    expect(skill).not.toHaveProperty("content");
    expect(skill).not.toHaveProperty("metadataRaw");
    expect(skill).not.toHaveProperty("storedIssues");
    expect(result).toHaveProperty("storedIssues", []);
    expect(JSON.stringify(skill)).not.toContain(MUTATION_BODY);
    expect(JSON.stringify(skill)).not.toContain(MUTATION_REFERENCE);
  });

  it("reports pendingRestart without starting or restarting the app", async () => {
    const f = fixture();
    const actor = agent("p", "a");

    const result = await call(f, actor, "create_skill", {
      name: "restart-report",
      description: "restart report",
      content: "restart body",
    });

    expect(result).toMatchObject({
      ok: true,
      pendingRestart: { pending: true, reasons: ["settings_changed"] },
    });
    expect(f.pendingRestarts).toEqual(["p:a"]);
    expect(f.ensureCalls).toEqual([]);
    expect(f.restartCalls).toEqual([]);
  });
});
