import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { SkillApplyOptions, SkillScope, SkillTarget } from "../src/skills/index.js";
import {
  SkillConflictError,
  SkillService,
  SkillValidationError,
  validateSkillEnabled,
} from "../src/skills/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { MIGRATIONS } from "../src/store/migrations.js";

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

const dirs: string[] = [];
const EPOCH = Date.UTC(2026, 9, 22, 10, 0, 0);

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  dir: string;
  service: SkillService;
  appRoot: string;
  xdgConfigHome: string;
  home: string;
  xdgCacheHome: string;
  appDir: string;
  options: SkillApplyOptions;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skills-store-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  let tick = 0;
  const service = new SkillService({
    db,
    now: () => new Date(EPOCH + tick++ * 1000),
  });
  const appRoot = path.join(dir, "app");
  const xdgConfigHome = path.join(appRoot, "config");
  const home = path.join(appRoot, "home");
  const xdgCacheHome = path.join(appRoot, "cache");
  const appDir = path.join(dir, "repo");
  for (const target of [appRoot, xdgConfigHome, home, xdgCacheHome, appDir]) {
    mkdirSync(target, { recursive: true });
  }
  return {
    db,
    dir,
    service,
    appRoot,
    xdgConfigHome,
    home,
    xdgCacheHome,
    appDir,
    options: { appRoot, home, xdgCacheHome, appDir },
  };
}

const target: SkillTarget = { projectId: "p", appKey: "web" };

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw");
}

function create(
  service: SkillService,
  scope: SkillScope,
  scopeTarget: SkillTarget,
  name: string,
  description = `description for ${name}`,
  content = `body for ${name}`,
) {
  return service.create(scope, scopeTarget, { name, description, content }, "owner");
}

function opencodeRoot(configHome: string): string {
  return path.join(configHome, "opencode");
}

function skillsRoot(configHome: string): string {
  return path.join(opencodeRoot(configHome), "skills");
}

function readDocument(file: string): { frontmatter: Record<string, unknown>; body: string } {
  const raw = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(raw);
  if (match === null) {
    throw new Error(`missing frontmatter in ${file}`);
  }
  return {
    frontmatter: parseYaml(match[1] ?? "") as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        entries[`${relative}/`] = "";
        visit(full);
      } else {
        entries[relative] = readFileSync(full, "utf8");
      }
    }
  };
  if (existsSync(root)) {
    visit(root);
  }
  return entries;
}

function writeRepoSkill(root: string, folder: string, name: string, description = "repo"): void {
  const directory = path.join(root, folder);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\nRepo body\n`,
  );
}

describe("skills resolution", () => {
  it("resolves global, project, and app rows by name with tombstone semantics", () => {
    const f = fixture();
    const global = create(f.service, "global", {}, "review", "global", "global body");
    const project = create(
      f.service,
      "project",
      { projectId: "p" },
      "review",
      "project",
      "project body",
    );
    const app = create(f.service, "app", target, "review", "app", "app body");

    const atApp = f.service.resolve(target);
    expect(atApp.scope).toBe("app");
    expect(atApp.effective).toEqual([
      {
        id: app.id,
        name: "review",
        description: "app",
        content: "app body",
        source: "app",
        shadows: ["global", "project"],
      },
    ]);
    expect(atApp.rows.map((row) => row.id).sort()).toEqual([app.id].sort());

    const atProject = f.service.resolve({ projectId: "p" });
    expect(atProject.scope).toBe("project");
    expect(atProject.effective[0]).toMatchObject({
      source: "project",
      shadows: ["global"],
      description: "project",
    });
    expect(atProject.rows.map((row) => row.id)).toEqual([project.id]);

    f.service.update(app.id, { enabled: false }, "owner");
    const tombstoned = f.service.resolve(target);
    expect(tombstoned.effective).toEqual([]);
    expect(tombstoned.disabled).toEqual([
      { id: app.id, name: "review", source: "project", disabledBy: "app" },
    ]);
    expect(tombstoned.rows).toHaveLength(1);
    expect(tombstoned.rows[0]).toMatchObject({ id: app.id, enabled: false });

    f.service.update(app.id, { enabled: true }, "owner");
    expect(f.service.resolve(target).effective[0]).toMatchObject({
      source: "app",
      description: "app",
    });

    f.service.update(global.id, { enabled: false }, "owner");
    expect(f.service.resolve({}).disabled).toEqual([
      { id: global.id, name: "review", source: null, disabledBy: "global" },
    ]);
    expect(f.service.resolve({ projectId: "p" }).effective[0]).toMatchObject({
      source: "project",
      shadows: ["global"],
    });
  });

  it("rejects a duplicate name at the same scope with skill_exists", () => {
    const f = fixture();
    create(f.service, "global", {}, "review");
    const error = captureError(() => create(f.service, "global", {}, "review"));
    expect(error).toBeInstanceOf(SkillConflictError);
    expect((error as SkillConflictError).code).toBe("skill_exists");
  });

  it("updates only supplied patch fields, including enabled alone", () => {
    const f = fixture();
    const row = create(f.service, "global", {}, "review", "original", "original body");
    const updated = f.service.update(row.id, { enabled: false }, "second-owner");
    expect(updated).toMatchObject({
      name: "review",
      description: "original",
      content: "original body",
      enabled: false,
      updatedBy: "second-owner",
    });
    expect(f.service.get(row.id)?.enabled).toBe(false);
    expect(f.service.delete(row.id)).toBe(true);
    expect(f.service.get(row.id)).toBeUndefined();
  });

  it("overrides an enabled source and can create a tombstone", () => {
    const f = fixture();
    const global = create(f.service, "global", {}, "review", "global", "global body");
    const tombstone = f.service.override(global.id, "app", target, false, "owner");
    expect(tombstone).toMatchObject({
      scope: "app",
      projectId: "p",
      appKey: "web",
      name: "review",
      description: "global",
      content: "global body",
      enabled: false,
    });
    expect(f.service.resolve(target).disabled).toEqual([
      { id: tombstone.id, name: "review", source: "global", disabledBy: "app" },
    ]);

    const enabledCopy = f.service.override(global.id, "project", { projectId: "p" }, true, "owner");
    expect(enabledCopy).toMatchObject({ scope: "project", enabled: true, description: "global" });
  });

  it("rejects a disabled or invisible override source", () => {
    const f = fixture();
    const global = create(f.service, "global", {}, "review");
    f.service.update(global.id, { enabled: false }, "owner");
    const disabledError = captureError(() =>
      f.service.override(global.id, "app", target, true, "owner"),
    );
    expect(disabledError).toBeInstanceOf(SkillValidationError);
    expect((disabledError as SkillValidationError).message).toBe("invalid_override_source");

    const appRow = create(f.service, "app", target, "other");
    const invisibleError = captureError(() =>
      f.service.override(appRow.id, "project", { projectId: "p" }, true, "owner"),
    );
    expect(invisibleError).toBeInstanceOf(SkillValidationError);
    expect((invisibleError as SkillValidationError).message).toBe("invalid_override_source");
  });
});

describe("skills validation", () => {
  it("rejects invalid names, descriptions, content, and enabled values", () => {
    const f = fixture();
    for (const name of ["", "UPPER", "a--b", "-a", "a-", "a b", "a".repeat(65)]) {
      expect(
        captureError(() => create(f.service, "global", {}, name)),
        `name ${JSON.stringify(name)}`,
      ).toBeInstanceOf(SkillValidationError);
    }

    const trimmed = create(f.service, "global", {}, "  review  ", "  description  ", "  body  ");
    expect(trimmed).toMatchObject({ name: "review", description: "description", content: "body" });

    for (const description of [
      "",
      "   ",
      "a\nb",
      "a\tb",
      `a${String.fromCodePoint(1)}b`,
      "a".repeat(1025),
    ]) {
      const error = captureError(() =>
        f.service.create(
          "global",
          {},
          { name: `description-${description.length}`, description, content: "body" },
          "owner",
        ),
      );
      expect(error).toBeInstanceOf(SkillValidationError);
    }

    for (const content of ["", "   ", `bad\u0000body`, "a".repeat(48001)]) {
      const error = captureError(() =>
        f.service.create(
          "global",
          {},
          { name: `content-${content.length}`, description: "description", content },
          "owner",
        ),
      );
      expect(error).toBeInstanceOf(SkillValidationError);
    }

    expect(captureError(() => validateSkillEnabled("yes"))).toBeInstanceOf(SkillValidationError);

    const insert = f.db.prepare(
      `INSERT INTO skills
         (scope, project_id, app_key, name, description, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date(EPOCH).toISOString();
    expect(() => insert.run("global", "", "", "../x", "d", "c", now, now)).toThrow();
    expect(() => insert.run("global", "p", "", "valid-name", "d", "c", now, now)).toThrow();
  });

  it("emits parseable frontmatter for hostile description text", () => {
    const f = fixture();
    const descriptions = [
      "a: b",
      "# not a comment",
      'he said "hi"',
      "C:\\path\\to",
      "héllo → 世界",
      "true",
      "[1, 2]",
    ];
    descriptions.forEach((description, index) => {
      create(f.service, "global", {}, `edge-${index}`, description, "Body");
    });
    const applied = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(applied.hash).toBe(f.service.hash({}));
    descriptions.forEach((description, index) => {
      const document = readDocument(
        path.join(skillsRoot(f.xdgConfigHome), `edge-${index}`, "SKILL.md"),
      );
      expect(document.frontmatter.name).toBe(`edge-${index}`);
      expect(document.frontmatter.description).toBe(description);
      expect(document.body).toBe("Body\n");
    });
  });
});

describe("skills hashing and materialization", () => {
  it("hashes only the effective set and matches probe/apply", () => {
    const f = fixture();
    expect(f.service.hash(target)).toBeUndefined();

    const globalAlpha = create(f.service, "global", {}, "alpha", "global alpha", "global body");
    create(f.service, "project", { projectId: "p" }, "alpha", "project alpha", "project body");
    create(f.service, "project", { projectId: "p" }, "beta");
    const hash = f.service.hash(target);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const preview = f.service.preview(target, f.options);
    const probe = f.service.probe(target, f.xdgConfigHome, f.options);
    expect(existsSync(opencodeRoot(f.xdgConfigHome))).toBe(false);
    const applied = f.service.apply(target, f.xdgConfigHome, f.options);
    expect(probe.hash).toBe(hash);
    expect(applied.hash).toBe(hash);
    expect(probe.warnings).toEqual(preview.warnings);
    expect(applied.warnings).toEqual(preview.warnings);
    expect(probe.preserved).toEqual([]);

    f.service.update(globalAlpha.id, { content: "shadowed edit" }, "owner");
    expect(f.service.hash(target)).toBe(hash);

    f.service.update(globalAlpha.id, { enabled: false }, "owner");
    expect(f.service.hash(target)).toBe(hash);
    f.service.update(globalAlpha.id, { enabled: true }, "owner");
    expect(f.service.hash(target)).toBe(hash);

    const projectAlpha = f.service
      .resolve({ projectId: "p" })
      .rows.find((row) => row.name === "alpha");
    expect(projectAlpha).toBeDefined();
    f.service.update(projectAlpha?.id ?? 0, { content: "changed" }, "owner");
    expect(f.service.hash(target)).not.toBe(hash);
  });

  it("is idempotent across applies", () => {
    const f = fixture();
    create(f.service, "global", {}, "alpha");
    create(f.service, "project", { projectId: "p" }, "beta");

    const first = f.service.apply(target, f.xdgConfigHome, f.options);
    const before = snapshot(opencodeRoot(f.xdgConfigHome));
    const second = f.service.apply(target, f.xdgConfigHome, f.options);

    expect(second.hash).toBe(first.hash);
    expect(second.written).toEqual(first.written);
    expect(second.removed).toEqual(first.removed);
    expect(second.preserved).toEqual([]);
    expect(snapshot(opencodeRoot(f.xdgConfigHome))).toEqual(before);
    expect(existsSync(path.join(opencodeRoot(f.xdgConfigHome), ".hanse-skills-initialized"))).toBe(
      true,
    );
  });

  it("preserves pre-existing entries on the first apply and removes them afterwards", () => {
    const f = fixture();
    create(f.service, "global", {}, "alpha");
    const root = opencodeRoot(f.xdgConfigHome);
    writeRepoSkill(path.join(root, "skills"), "operator-skill", "operator-skill");
    writeRepoSkill(path.join(root, "skill"), "legacy-skill", "legacy-skill");

    const first = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(first.preserved).toEqual(["legacy-skill", "operator-skill"]);
    expect(existsSync(path.join(root, "skills-replaced", "operator-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(root, "skills-replaced", "legacy-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(root, "skills", "operator-skill"))).toBe(false);
    expect(readdirSync(path.join(root, "skill"))).toEqual([]);

    writeRepoSkill(path.join(root, "skills"), "intruder", "intruder");
    writeFileSync(path.join(root, "skill", "loose.txt"), "loose");
    const second = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(second.preserved).toEqual([]);
    expect(second.removed).toContain("skills/intruder");
    expect(second.removed).toContain("skill/loose.txt");
    expect(existsSync(path.join(root, "skills", "intruder"))).toBe(false);
    expect(existsSync(path.join(root, "skill", "loose.txt"))).toBe(false);
  });

  it("rebuilds each effective subtree and ignores planted nested files and symlinks", () => {
    const f = fixture();
    create(f.service, "global", {}, "alpha");
    const root = opencodeRoot(f.xdgConfigHome);

    const outside = path.join(f.dir, "outside", "alpha");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "SKILL.md"), "sentinel");
    mkdirSync(path.join(root, "skills"), { recursive: true });
    symlinkSync(outside, path.join(root, "skills", "alpha"), "dir");

    f.service.apply({}, f.xdgConfigHome, f.options);
    expect(lstatSync(path.join(root, "skills", "alpha")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe("sentinel");
    expect(readFileSync(path.join(root, "skills", "alpha", "SKILL.md"), "utf8")).toContain(
      "name: alpha",
    );

    mkdirSync(path.join(root, "skills", "alpha", "nested"), { recursive: true });
    writeFileSync(path.join(root, "skills", "alpha", "nested", "SKILL.md"), "planted");
    writeFileSync(path.join(root, "skills", "alpha", "extra.txt"), "planted");
    writeFileSync(path.join(root, "skills", "loose.txt"), "planted");
    f.service.apply({}, f.xdgConfigHome, f.options);
    expect(readdirSync(path.join(root, "skills", "alpha")).sort()).toEqual(["SKILL.md"]);
    expect(existsSync(path.join(root, "skills", "loose.txt"))).toBe(false);
  });
});

describe("skills collision detection", () => {
  it("reports repository and tombstone collisions without writing in preview", () => {
    const f = fixture();
    create(f.service, "global", {}, "review");
    const legacy = create(f.service, "global", {}, "legacy");
    f.service.update(legacy.id, { enabled: false }, "owner");

    const repositoryRoot = path.join(f.appDir, ".opencode", "skills");
    const externalRoot = path.join(f.home, ".claude", "skills");
    writeRepoSkill(repositoryRoot, "review", "review");
    writeRepoSkill(externalRoot, "legacy", "legacy");

    expect(existsSync(opencodeRoot(f.xdgConfigHome))).toBe(false);
    const preview = f.service.preview({}, f.options);
    expect(preview.warnings).toEqual([
      {
        code: "skill_disabled_elsewhere",
        name: "legacy",
        root: path.resolve(externalRoot),
      },
      { code: "skill_collision", name: "review", root: path.resolve(repositoryRoot) },
    ]);
    expect(existsSync(opencodeRoot(f.xdgConfigHome))).toBe(false);

    const applied = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(applied.warnings).toEqual(preview.warnings);
    expect(existsSync(path.join(skillsRoot(f.xdgConfigHome), "review", "SKILL.md"))).toBe(true);
  });

  it("bounds collision warnings and reports the omitted count", () => {
    const f = fixture();
    const repositoryRoot = path.join(f.appDir, ".opencode", "skills");
    for (let index = 0; index < 25; index += 1) {
      const name = `collide-${String(index).padStart(2, "0")}`;
      create(f.service, "global", {}, name);
      writeRepoSkill(repositoryRoot, name, name);
    }
    const preview = f.service.preview({}, f.options);
    expect(preview.warnings).toHaveLength(20);
    expect(preview.truncated).toBe(5);
    expect(preview.warnings[0]?.name).toBe("collide-00");
    expect(preview.warnings[19]?.name).toBe("collide-19");
  });
});

describe("skills stored-row safety", () => {
  it("excludes a forged invalid name from resolve, hash, preview, probe, and apply", () => {
    const f = fixture();
    create(f.service, "global", {}, "safe");
    const before = f.service.hash({});
    const now = new Date(EPOCH).toISOString();
    f.db.pragma("ignore_check_constraints = ON");
    f.db
      .prepare(
        `INSERT INTO skills
           (scope, project_id, app_key, name, description, content, enabled, created_at, updated_at)
         VALUES ('global', '', '', '../x', 'forged', 'forged body', 1, ?, ?)`,
      )
      .run(now, now);
    f.db.pragma("ignore_check_constraints = OFF");
    const forged = f.db.prepare("SELECT id FROM skills WHERE name = '../x'").get() as {
      id: number;
    };

    const resolved = f.service.resolve({});
    expect(resolved.effective.map((skill) => skill.name)).toEqual(["safe"]);
    expect(resolved.rows.map((row) => row.name)).toEqual(["safe"]);
    expect(resolved.warnings).toEqual([{ code: "invalid_skill_name", id: forged.id }]);
    expect(f.service.hash({})).toBe(before);

    const preview = f.service.preview({}, f.options);
    expect(preview.warnings).toEqual([{ code: "invalid_skill_name", id: forged.id }]);
    const probe = f.service.probe({}, f.xdgConfigHome, f.options);
    const applied = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(probe.warnings).toEqual(preview.warnings);
    expect(applied.warnings).toEqual(preview.warnings);
    expect(applied.written).toEqual(["skills/safe/SKILL.md"]);
    expect(probe.hash).toBe(before);
    expect(applied.hash).toBe(before);
    expect(existsSync(path.join(opencodeRoot(f.xdgConfigHome), "x"))).toBe(false);
    expect(existsSync(path.join(f.appRoot, "x"))).toBe(false);
  });
});

describe("migration v12", () => {
  it("upgrades a v11 database once and is a no-op afterwards", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 11)) {
      db.exec(migration.sql);
      record.run(
        migration.version,
        migration.name,
        migrationChecksum(migration.sql),
        "2026-10-22T00:00:00.000Z",
      );
    }
    expect(() => db.prepare("SELECT 1 FROM skills").get()).toThrow();
    expect(runMigrations(db)).toBe(1);
    expect(runMigrations(db)).toBe(0);
    const now = new Date(EPOCH).toISOString();
    db.prepare(
      `INSERT INTO skills
         (scope, project_id, app_key, name, description, content, created_at, updated_at)
       VALUES ('global', '', '', 'review', 'description', 'content', ?, ?)`,
    ).run(now, now);
    expect(db.prepare("SELECT name FROM skills").get()).toEqual({ name: "review" });
    db.close();
  });
});
