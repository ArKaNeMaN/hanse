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
import { hashValue } from "../src/settings/hash.js";
import {
  isOwnAppSkillRow,
  isSameSkillTarget,
  skillRowTarget,
  skillVisibleAt,
} from "../src/skills/access.js";
import type {
  EffectiveBundle,
  SkillApplyOptions,
  SkillMetadata,
  SkillReference,
  SkillRow,
  SkillScope,
  SkillTarget,
  SkillWarning,
} from "../src/skills/index.js";
import {
  SkillConflictError,
  SkillService,
  SkillValidationError,
  validateSkillEnabled,
  validateSkillMetadata,
} from "../src/skills/index.js";
import { buildSkillDocument, rebuildSkills } from "../src/skills/materialize.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { MIGRATIONS } from "../src/store/migrations.js";

const dirs: string[] = [];
const EPOCH = Date.UTC(2026, 9, 22, 10, 0, 0);

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

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

function createBundle(
  service: SkillService,
  scope: SkillScope,
  scopeTarget: SkillTarget,
  name: string,
  input: {
    description?: string;
    content?: string;
    license?: string | null;
    compatibility?: string | null;
    metadata?: SkillMetadata;
    references?: SkillReference[];
    enabled?: boolean;
  } = {},
) {
  return service.create(
    scope,
    scopeTarget,
    {
      name,
      description: input.description ?? `description for ${name}`,
      content: input.content ?? `body for ${name}`,
      ...(input.license === undefined ? {} : { license: input.license }),
      ...(input.compatibility === undefined ? {} : { compatibility: input.compatibility }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.references === undefined ? {} : { references: input.references }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    },
    "owner",
  );
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

function withIgnoredChecks<T>(f: Fixture, action: () => T): T {
  f.db.pragma("ignore_check_constraints = ON");
  try {
    return action();
  } finally {
    f.db.pragma("ignore_check_constraints = OFF");
  }
}

function insertRawSkill(
  f: Fixture,
  input: {
    scope?: SkillScope;
    projectId?: string;
    appKey?: string;
    name: string;
    description?: string;
    content?: string;
    enabled?: boolean;
    license?: string | null;
    compatibility?: string | null;
    metadataJson?: string;
  },
): number {
  const now = new Date(EPOCH).toISOString();
  return withIgnoredChecks(f, () => {
    const result = f.db
      .prepare(
        `INSERT INTO skills
           (scope, project_id, app_key, name, description, content, enabled,
            license, compatibility, metadata_json, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scope ?? "global",
        input.projectId ?? (input.scope === undefined || input.scope === "global" ? "" : "p"),
        input.appKey ?? (input.scope === "app" ? "web" : ""),
        input.name,
        input.description ?? "raw description",
        input.content ?? "raw body",
        input.enabled === false ? 0 : 1,
        input.license ?? null,
        input.compatibility ?? null,
        input.metadataJson ?? "{}",
        now,
        now,
        "raw",
      );
    return Number(result.lastInsertRowid);
  });
}

function insertRawReference(f: Fixture, skillId: number, referencePath: string, content: string) {
  withIgnoredChecks(f, () => {
    f.db
      .prepare("INSERT INTO skill_references (skill_id, path, content) VALUES (?, ?, ?)")
      .run(skillId, referencePath, content);
  });
}

function referenceCount(f: Fixture, skillId: number): number {
  return (
    f.db
      .prepare("SELECT COUNT(*) AS count FROM skill_references WHERE skill_id = ?")
      .get(skillId) as { count: number }
  ).count;
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
    expect(atApp.effective).toMatchObject([
      {
        id: app.id,
        name: "review",
        description: "app",
        content: "app body",
        source: "app",
        shadows: ["global", "project"],
      },
    ]);
    expect(atApp.effective[0]).toMatchObject({
      license: null,
      compatibility: null,
      metadata: {},
      references: [],
    });
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

  it("carries the winning row's updated metadata on effective summaries", () => {
    const f = fixture();
    const reference: SkillReference = { path: "references/a.md", content: "body" };
    const warning: SkillWarning = { code: "skill_collision", name: "review", root: "skills" };
    const global = create(f.service, "global", {}, "review", "global", "global body");
    const project = create(
      f.service,
      "project",
      { projectId: "p" },
      "review",
      "project",
      "project body",
    );

    expect(reference.content).toBe("body");
    expect(warning.code).toBe("skill_collision");
    expect(f.service.resolve({}).effective[0]).toMatchObject({
      id: global.id,
      updatedAt: global.updatedAt,
      updatedBy: "owner",
    });
    expect(f.service.resolve({ projectId: "p" }).effective[0]).toMatchObject({
      id: project.id,
      updatedAt: project.updatedAt,
      updatedBy: "owner",
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

  it("allows multiline descriptions and normalizes CRLF", () => {
    const f = fixture();
    const row = createBundle(f.service, "global", {}, "multi", {
      description: "line one\r\nline two\rline three",
    });
    expect(row.description).toBe("line one\nline two\nline three");
  });

  it("validates license, compatibility, metadata, and reference limits", () => {
    const f = fixture();
    const invalid = [
      () =>
        createBundle(f.service, "global", {}, "license-long", {
          license: "x".repeat(257),
        }),
      () =>
        createBundle(f.service, "global", {}, "license-line", {
          license: "a\nb",
        }),
      () =>
        createBundle(f.service, "global", {}, "compat-long", {
          compatibility: "x".repeat(513),
        }),
      () =>
        createBundle(f.service, "global", {}, "meta-json", {
          metadata: { author: "a".repeat(1025) },
        }),
      () =>
        createBundle(f.service, "global", {}, "meta-reserved", {
          metadata: { name: "x" },
        }),
      () =>
        createBundle(f.service, "global", {}, "meta-key", {
          metadata: { "Bad Key": "x" },
        }),
      () =>
        createBundle(f.service, "global", {}, "meta-entries", {
          metadata: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`key-${index}`, "value"]),
          ),
        }),
    ];
    for (const action of invalid) {
      expect(captureError(action)).toBeInstanceOf(SkillValidationError);
    }
    expect(
      captureError(() => validateSkillMetadata({ author: 1 as unknown as string })),
    ).toBeInstanceOf(SkillValidationError);

    for (const referencePath of [
      "references/A.md",
      "references/a",
      "references/a.txt",
      "references/nested/a.md",
      "references/../a.md",
      "references/a b.md",
      "references/.md",
      `references/${"a".repeat(65)}.md`,
    ]) {
      expect(
        captureError(() =>
          createBundle(f.service, "global", {}, "refs-bad", {
            references: [{ path: referencePath, content: "body" }],
          }),
        ),
        referencePath,
      ).toBeInstanceOf(SkillValidationError);
    }

    for (const content of ["", "\u0000", "a\u0001b", "a".repeat(48001)]) {
      expect(
        captureError(() =>
          createBundle(f.service, "global", {}, "refs-content", {
            references: [{ path: "references/a.md", content }],
          }),
        ),
      ).toBeInstanceOf(SkillValidationError);
    }

    expect(
      captureError(() =>
        createBundle(f.service, "global", {}, "refs-count", {
          references: Array.from({ length: 21 }, (_, index) => ({
            path: `references/ref-${index}.md`,
            content: "body",
          })),
        }),
      ),
    ).toBeInstanceOf(SkillValidationError);

    expect(
      captureError(() =>
        createBundle(f.service, "global", {}, "refs-aggregate", {
          references: Array.from({ length: 5 }, (_, index) => ({
            path: `references/agg-${index}.md`,
            content: "x".repeat(48000),
          })),
        }),
      ),
    ).toBeInstanceOf(SkillValidationError);
  });

  it("normalizes optional fields, metadata, and reference text", () => {
    const f = fixture();
    const row = createBundle(f.service, "global", {}, "normalized", {
      license: "  MIT  ",
      compatibility: "  Node >= 20  ",
      metadata: { " author ": " arkan ", version: "", "custom-key": "  value  " },
      references: [
        { path: "references/b.md", content: "b\r\nline" },
        { path: "references/a.md", content: "a\rline" },
      ],
    });
    expect(row).toMatchObject({
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "arkan", "custom-key": "value" },
    });
    expect(row.references).toEqual([
      { path: "references/a.md", content: "a\nline" },
      { path: "references/b.md", content: "b\nline" },
    ]);

    const cleared = createBundle(f.service, "global", {}, "cleared", {
      license: "  ",
      compatibility: "",
      metadata: { author: "   " },
      references: [],
    });
    expect(cleared).toMatchObject({ license: null, compatibility: null, metadata: {} });
    expect(cleared.references).toEqual([]);
  });
});

describe("skills hashing and materialization", () => {
  it("keeps the legacy hash and SKILL.md bytes for a v12-style row", () => {
    const f = fixture();
    const id = insertRawSkill(f, { name: "legacy", description: "Legacy", content: "Legacy body" });
    const expected = hashValue([{ name: "legacy", description: "Legacy", content: "Legacy body" }]);
    expect(f.service.hash({})).toBe(expected);
    expect(f.service.get(id)).toMatchObject({
      license: null,
      compatibility: null,
      metadata: {},
      references: [],
      storedIssues: [],
      metadataRaw: null,
    });

    const applied = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(applied.hash).toBe(expected);
    expect(readFileSync(path.join(skillsRoot(f.xdgConfigHome), "legacy", "SKILL.md"), "utf8")).toBe(
      '---\nname: legacy\ndescription: "Legacy"\n---\n\nLegacy body\n',
    );
  });

  it("clearing every bundle field restores the legacy hash", () => {
    const f = fixture();
    const row = createBundle(f.service, "global", {}, "review", {
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "arkan" },
      references: [{ path: "references/extra.md", content: "Reference" }],
    });
    const legacy = hashValue([
      { name: "review", description: row.description, content: row.content },
    ]);
    expect(f.service.hash({})).not.toBe(legacy);

    const cleared = f.service.update(
      row.id,
      {
        license: null,
        compatibility: null,
        metadata: {},
        references: [],
      },
      "owner",
    );
    expect(cleared).toMatchObject({ license: null, compatibility: null, metadata: {} });
    expect(cleared.references).toEqual([]);
    expect(f.service.hash({})).toBe(legacy);
  });

  it("includes license, compatibility, metadata, and references in the hash", () => {
    const f = fixture();
    const row = createBundle(f.service, "global", {}, "review");
    const base = f.service.hash({});
    f.service.update(row.id, { license: "MIT" }, "owner");
    const withLicense = f.service.hash({});
    expect(withLicense).not.toBe(base);
    f.service.update(row.id, { compatibility: "Node >= 20" }, "owner");
    const withCompatibility = f.service.hash({});
    expect(withCompatibility).not.toBe(withLicense);
    f.service.update(row.id, { metadata: { author: "arkan" } }, "owner");
    const withMetadata = f.service.hash({});
    expect(withMetadata).not.toBe(withCompatibility);
    const references = [{ path: "references/a.md", content: "Reference" }];
    f.service.update(row.id, { references }, "owner");
    const withReferences = f.service.hash({});
    expect(withReferences).not.toBe(withMetadata);
    f.service.update(row.id, { references: [] }, "owner");
    expect(f.service.hash({})).toBe(withMetadata);
  });

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

  it("materializes a complete bundle with references before SKILL.md", () => {
    const f = fixture();
    createBundle(f.service, "global", {}, "bundle", {
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "arkan", version: "1.0.0" },
      references: [
        { path: "references/b.md", content: "Second" },
        { path: "references/a.md", content: "First" },
      ],
    });
    const hash = f.service.hash({});
    const probe = f.service.probe({}, f.xdgConfigHome, f.options);
    const applied = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(probe.hash).toBe(hash);
    expect(applied.hash).toBe(hash);
    expect(applied.written).toEqual([
      "skills/bundle/SKILL.md",
      "skills/bundle/references/a.md",
      "skills/bundle/references/b.md",
    ]);
    expect(
      readFileSync(path.join(skillsRoot(f.xdgConfigHome), "bundle", "references", "a.md"), "utf8"),
    ).toBe("First");
    const document = readDocument(path.join(skillsRoot(f.xdgConfigHome), "bundle", "SKILL.md"));
    expect(document.frontmatter).toMatchObject({
      name: "bundle",
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "arkan", version: "1.0.0" },
    });
    expect(document.body).toBe("body for bundle\n");

    const before = snapshot(skillsRoot(f.xdgConfigHome));
    const second = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(second.written).toEqual(applied.written);
    expect(snapshot(skillsRoot(f.xdgConfigHome))).toEqual(before);
  });

  it("writes deterministic frontmatter order and quotes hostile scalars", () => {
    const f = fixture();
    const metadata: SkillMetadata = {
      "related-skills": "qa-engineer, software-architect",
      triggers: "implement, bugfix",
      version: "1.0.0",
      author: "arkan",
      domain: "engineering",
      role: "engineer",
      scope: "implementation",
      "output-format": "code",
      custom: 'value: "quoted"',
    };
    createBundle(f.service, "global", {}, "ordered", {
      description: "Use when implementing approved work.",
      license: "MIT",
      compatibility: "Node >= 20",
      metadata,
    });
    expect(f.service.apply({}, f.xdgConfigHome, f.options).hash).toBe(f.service.hash({}));
    const raw = readFileSync(path.join(skillsRoot(f.xdgConfigHome), "ordered", "SKILL.md"), "utf8");
    const lines = raw.split("\n");
    expect(lines.slice(0, 15)).toEqual([
      "---",
      "name: ordered",
      'description: "Use when implementing approved work."',
      'license: "MIT"',
      'compatibility: "Node >= 20"',
      "metadata:",
      '  author: "arkan"',
      '  version: "1.0.0"',
      '  domain: "engineering"',
      '  triggers: "implement, bugfix"',
      '  role: "engineer"',
      '  scope: "implementation"',
      '  output-format: "code"',
      '  related-skills: "qa-engineer, software-architect"',
      '  custom: "value: \\"quoted\\""',
    ]);
    expect(parseYaml(lines.slice(1, 15).join("\n"))).toMatchObject({
      description: "Use when implementing approved work.",
      license: "MIT",
      metadata: { author: "arkan", custom: 'value: "quoted"' },
    });
    expect(buildSkillDocument({ name: "plain", description: "Plain", content: "Body" })).toBe(
      '---\nname: plain\ndescription: "Plain"\n---\n\nBody\n',
    );
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
      "line one\nline two",
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

  it("removes stale references on a later apply", () => {
    const f = fixture();
    const row = createBundle(f.service, "global", {}, "stale", {
      references: [
        { path: "references/a.md", content: "A" },
        { path: "references/b.md", content: "B" },
      ],
    });
    const first = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(first.written).toContain("skills/stale/references/a.md");
    expect(first.written).toContain("skills/stale/references/b.md");
    f.service.update(row.id, { references: [{ path: "references/a.md", content: "A" }] }, "owner");
    const second = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(second.written).toEqual(["skills/stale/SKILL.md", "skills/stale/references/a.md"]);
    expect(existsSync(path.join(skillsRoot(f.xdgConfigHome), "stale", "references", "b.md"))).toBe(
      false,
    );
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
    const row = createBundle(f.service, "global", {}, "alpha", {
      references: [{ path: "references/a.md", content: "Reference" }],
    });
    expect(row.references).toHaveLength(1);
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

    const outsideReferences = path.join(f.dir, "outside-references");
    mkdirSync(outsideReferences, { recursive: true });
    writeFileSync(path.join(outsideReferences, "a.md"), "outside");
    rmSync(path.join(root, "skills", "alpha", "references"), { recursive: true, force: true });
    symlinkSync(outsideReferences, path.join(root, "skills", "alpha", "references"), "dir");

    mkdirSync(path.join(root, "skills", "alpha", "nested"), { recursive: true });
    writeFileSync(path.join(root, "skills", "alpha", "nested", "SKILL.md"), "planted");
    writeFileSync(path.join(root, "skills", "alpha", "extra.txt"), "planted");
    writeFileSync(path.join(root, "skills", "loose.txt"), "planted");
    f.service.apply({}, f.xdgConfigHome, f.options);
    expect(readdirSync(path.join(root, "skills", "alpha")).sort()).toEqual([
      "SKILL.md",
      "references",
    ]);
    expect(readFileSync(path.join(outsideReferences, "a.md"), "utf8")).toBe("outside");
    expect(readFileSync(path.join(root, "skills", "alpha", "references", "a.md"), "utf8")).toBe(
      "Reference",
    );
    expect(existsSync(path.join(root, "skills", "loose.txt"))).toBe(false);
  });

  it("rejects forged stored reference paths on read and before materialization", () => {
    const f = fixture();
    const global = create(f.service, "global", {}, "safe");
    const before = f.service.hash({});
    const forged = insertRawSkill(f, { name: "forged", scope: "app" });
    insertRawReference(f, forged, "references/../../escape.md", "malicious");
    const resolved = f.service.resolve(target);
    expect(resolved.effective.map((skill) => skill.id)).toEqual([global.id]);
    expect(resolved.rows.find((row) => row.id === forged)?.storedIssues).toEqual([
      {
        code: "invalid_skill_reference",
        path: "references/../../escape.md",
        detail: "invalid reference path",
      },
    ]);
    const applied = f.service.apply(target, f.xdgConfigHome, f.options);
    expect(applied.hash).toBe(before);
    expect(existsSync(path.join(f.dir, "escape.md"))).toBe(false);
    expect(existsSync(path.join(f.appRoot, "escape.md"))).toBe(false);
    expect(existsSync(path.join(opencodeRoot(f.xdgConfigHome), "escape.md"))).toBe(false);

    const bundle: EffectiveBundle = {
      id: 1,
      name: "forged",
      description: "Forged",
      content: "Body",
      license: null,
      compatibility: null,
      metadata: {},
      references: [{ path: "references/../../escape.md", content: "malicious" }],
      source: "global",
      shadows: [],
    };
    const error = captureError(() =>
      rebuildSkills({
        appRoot: f.appRoot,
        opencodeRoot: path.join(f.appRoot, "forged-root"),
        effective: [bundle],
        preserveFirstDeploy: false,
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("skills_materialize_failed");
    expect(existsSync(path.join(f.dir, "escape.md"))).toBe(false);
  });
});

describe("skills stored-row safety", () => {
  it("keeps invalid-name rows visible in rows but out of effective and warnings", () => {
    const f = fixture();
    create(f.service, "global", {}, "safe");
    const now = new Date(EPOCH).toISOString();
    f.db.pragma("ignore_check_constraints = ON");
    f.db
      .prepare(
        `INSERT INTO skills
           (scope, project_id, app_key, name, description, content, enabled, created_at, updated_at)
         VALUES ('global', '', '', '../x', 'forged', 'forged body', 1, ?, ?)`,
      )
      .run(now, now);
    f.db
      .prepare(
        `INSERT INTO skills
           (scope, project_id, app_key, name, description, content, enabled, created_at, updated_at)
         VALUES ('global', '', '', '../hidden', 'forged', 'forged body', 0, ?, ?)`,
      )
      .run(now, now);
    f.db.pragma("ignore_check_constraints = OFF");
    const forged = f.db.prepare("SELECT id FROM skills WHERE name = '../x'").get() as {
      id: number;
    };

    const resolved = f.service.resolve({});
    expect(resolved.effective.map((skill) => skill.name)).toEqual(["safe"]);
    expect(resolved.rows.map((row) => row.name)).toEqual(["../hidden", "../x", "safe"]);
    expect(resolved.rows.find((row) => row.id === forged.id)?.storedIssues).toEqual([
      { code: "invalid_skill_name" },
    ]);
    expect(resolved.disabled).toEqual([]);
    expect(resolved.warnings).toEqual([]);
    expect(f.service.hash({})).toMatch(/^[0-9a-f]{64}$/);

    const preview = f.service.preview({}, f.options);
    expect(preview.warnings).toEqual([]);
    const probe = f.service.probe({}, f.xdgConfigHome, f.options);
    const applied = f.service.apply({}, f.xdgConfigHome, f.options);
    expect(probe.warnings).toEqual([]);
    expect(applied.warnings).toEqual([]);
    expect(applied.written).toEqual(["skills/safe/SKILL.md"]);
    expect(existsSync(path.join(opencodeRoot(f.xdgConfigHome), "x"))).toBe(false);
    expect(existsSync(path.join(f.appRoot, "x"))).toBe(false);
  });

  it("excludes invalid metadata JSON, keeps metadataRaw, and falls back to a wider row", () => {
    const f = fixture();
    createBundle(f.service, "global", {}, "alpha", {
      description: "global",
      content: "global body",
    });
    const before = f.service.hash(target);
    const app = create(f.service, "app", target, "alpha", "app", "app body");
    const raw = "{not json";
    withIgnoredChecks(f, () => {
      f.db.prepare("UPDATE skills SET metadata_json = ? WHERE id = ?").run(raw, app.id);
    });

    const resolved = f.service.resolve(target);
    expect(resolved.effective.map((skill) => skill.source)).toEqual(["global"]);
    const row = resolved.rows.find((entry) => entry.id === app.id);
    expect(row?.storedIssues).toEqual([
      { code: "invalid_skill_metadata", detail: expect.stringContaining("JSON") },
    ]);
    const full = f.service.get(app.id);
    expect(full?.metadataRaw).toBe(raw);
    expect(full?.metadata).toEqual({});
    expect(f.service.hash(target)).toBe(before);
    const probe = f.service.probe(target, f.xdgConfigHome, f.options);
    const applied = f.service.apply(target, f.xdgConfigHome, f.options);
    expect(probe.hash).toBe(before);
    expect(applied.hash).toBe(before);
  });

  it("excludes invalid license, compatibility, reference count, and aggregate", () => {
    const metadataFree = (f: Fixture, suffix: string, action: (id: number) => void) => {
      createBundle(f.service, "global", {}, `wide-${suffix}`, {
        description: "global",
        content: "global body",
      });
      const before = f.service.hash(target);
      const app = create(f.service, "app", target, `wide-${suffix}`, "app", "app body");
      action(app.id);
      const resolved = f.service.resolve(target);
      expect(resolved.effective.map((skill) => skill.source)).toEqual(["global"]);
      const row = resolved.rows.find((entry) => entry.id === app.id);
      expect(row?.storedIssues.length).toBeGreaterThan(0);
      expect(f.service.hash(target)).toBe(before);
      expect(f.service.probe(target, f.xdgConfigHome, f.options).hash).toBe(before);
      expect(f.service.apply(target, f.xdgConfigHome, f.options).hash).toBe(before);
      return row;
    };

    const licenseFixture = fixture();
    const licenseRow = metadataFree(licenseFixture, "license", (id) => {
      withIgnoredChecks(licenseFixture, () => {
        licenseFixture.db
          .prepare("UPDATE skills SET license = ? WHERE id = ?")
          .run("x".repeat(257), id);
      });
    });
    expect(licenseRow?.storedIssues[0]?.code).toBe("invalid_skill_bundle");

    const compatibilityFixture = fixture();
    const compatibilityRow = metadataFree(compatibilityFixture, "compat", (id) => {
      withIgnoredChecks(compatibilityFixture, () => {
        compatibilityFixture.db
          .prepare("UPDATE skills SET compatibility = ? WHERE id = ?")
          .run("x".repeat(513), id);
      });
    });
    expect(compatibilityRow?.storedIssues[0]?.code).toBe("invalid_skill_bundle");

    const countFixture = fixture();
    const countRow = metadataFree(countFixture, "count", (id) => {
      for (let index = 0; index < 21; index += 1) {
        insertRawReference(countFixture, id, `references/ref-${index}.md`, "body");
      }
    });
    expect(countRow?.storedIssues.some((issue) => issue.code === "invalid_skill_bundle")).toBe(
      true,
    );

    const aggregateFixture = fixture();
    const aggregateRow = metadataFree(aggregateFixture, "aggregate", (id) => {
      for (let index = 0; index < 5; index += 1) {
        insertRawReference(aggregateFixture, id, `references/agg-${index}.md`, "x".repeat(48000));
      }
    });
    expect(aggregateRow?.storedIssues.some((issue) => issue.code === "invalid_skill_bundle")).toBe(
      true,
    );
  });

  it("excludes invalid reference content and still agrees across hash/probe/apply", () => {
    const f = fixture();
    createBundle(f.service, "global", {}, "alpha", {
      description: "global",
      content: "global body",
    });
    const before = f.service.hash(target);
    const app = create(f.service, "app", target, "alpha", "app", "app body");
    insertRawReference(f, app.id, "references/bad.md", "bad\u0000content");
    const resolved = f.service.resolve(target);
    expect(resolved.effective.map((skill) => skill.source)).toEqual(["global"]);
    expect(
      resolved.rows
        .find((row) => row.id === app.id)
        ?.storedIssues.some(
          (issue) => issue.code === "invalid_skill_reference" && issue.path === "references/bad.md",
        ),
    ).toBe(true);
    expect(f.service.hash(target)).toBe(before);
    expect(f.service.probe(target, f.xdgConfigHome, f.options).hash).toBe(before);
    expect(f.service.apply(target, f.xdgConfigHome, f.options).hash).toBe(before);
  });
});

describe("skills override and transactions", () => {
  it("copies the complete bundle and keeps a copied tombstone disabled", () => {
    const f = fixture();
    const source = createBundle(f.service, "global", {}, "review", {
      description: "Global",
      content: "Global body",
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "arkan", scope: "implementation" },
      references: [
        { path: "references/a.md", content: "A" },
        { path: "references/b.md", content: "B" },
      ],
    });

    const copy = f.service.override(source.id, "app", target, true, "owner");
    expect(copy).toMatchObject({
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "arkan", scope: "implementation" },
      description: "Global",
      content: "Global body",
    });
    expect(copy.references).toEqual([
      { path: "references/a.md", content: "A" },
      { path: "references/b.md", content: "B" },
    ]);

    const tombstone = f.service.override(source.id, "project", { projectId: "p" }, false, "owner");
    expect(tombstone.enabled).toBe(false);
    expect(tombstone.license).toBe("MIT");
    expect(tombstone.metadata).toEqual({ author: "arkan", scope: "implementation" });
    expect(tombstone.references).toHaveLength(2);
    expect(f.service.resolve(target).effective[0]).toMatchObject({ source: "app", id: copy.id });
    expect(f.service.resolve({ projectId: "p" }).disabled).toEqual([
      { id: tombstone.id, name: "review", source: "global", disabledBy: "project" },
    ]);
  });

  it("replaces the target reference set on override", () => {
    const f = fixture();
    const source = createBundle(f.service, "global", {}, "review", {
      references: [{ path: "references/a.md", content: "A" }],
    });
    const existing = createBundle(f.service, "app", target, "review", {
      references: [{ path: "references/old.md", content: "Old" }],
    });
    f.service.override(source.id, "app", target, true, "owner");
    expect(f.service.get(existing.id)?.references).toEqual([
      { path: "references/a.md", content: "A" },
    ]);
    expect(referenceCount(f, existing.id)).toBe(1);
  });

  it("rolls back a failed create and leaves no partial references", () => {
    const f = fixture();
    f.db.exec(
      `CREATE TRIGGER fail_reference BEFORE INSERT ON skill_references
       WHEN NEW.path = 'references/boom.md'
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    expect(() =>
      createBundle(f.service, "global", {}, "tx-create", {
        references: [
          { path: "references/a.md", content: "A" },
          { path: "references/boom.md", content: "Boom" },
        ],
      }),
    ).toThrow(/boom/);
    expect(
      (
        f.db.prepare("SELECT COUNT(*) AS count FROM skills WHERE name = 'tx-create'").get() as {
          count: number;
        }
      ).count,
    ).toBe(0);
    expect(
      (f.db.prepare("SELECT COUNT(*) AS count FROM skill_references").get() as { count: number })
        .count,
    ).toBe(0);
  });

  it("rolls back a failed update and keeps the previous references", () => {
    const f = fixture();
    const row = createBundle(f.service, "global", {}, "tx-update", {
      references: [{ path: "references/a.md", content: "A" }],
    });
    f.db.exec(
      `CREATE TRIGGER fail_reference BEFORE INSERT ON skill_references
       WHEN NEW.path = 'references/boom.md'
       BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    expect(() =>
      f.service.update(
        row.id,
        { references: [{ path: "references/boom.md", content: "Boom" }] },
        "owner",
      ),
    ).toThrow(/boom/);
    expect(f.service.get(row.id)?.references).toEqual([{ path: "references/a.md", content: "A" }]);
  });

  it("cascades reference rows on delete", () => {
    const f = fixture();
    const row = createBundle(f.service, "global", {}, "cascade", {
      references: [
        { path: "references/a.md", content: "A" },
        { path: "references/b.md", content: "B" },
      ],
    });
    expect(referenceCount(f, row.id)).toBe(2);
    expect(f.service.delete(row.id)).toBe(true);
    expect(referenceCount(f, row.id)).toBe(0);
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

describe("migration v13", () => {
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
    expect(runMigrations(db)).toBe(8);
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

function skillRowFixture(input: {
  id: number;
  scope: SkillScope;
  projectId: string;
  appKey: string;
}): SkillRow {
  return {
    ...input,
    name: `skill-${input.id}`,
    description: "description",
    content: "content",
    enabled: true,
    license: null,
    compatibility: null,
    metadata: {},
    references: [],
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    updatedBy: null,
    storedIssues: [],
    metadataRaw: null,
  };
}

describe("shared skill access predicates", () => {
  const target = { projectId: "p", appKey: "web" };
  const globalRow = skillRowFixture({ id: 1, scope: "global", projectId: "", appKey: "" });
  const projectRow = skillRowFixture({ id: 2, scope: "project", projectId: "p", appKey: "" });
  const callerAppRow = skillRowFixture({ id: 3, scope: "app", projectId: "p", appKey: "web" });
  const siblingAppRow = skillRowFixture({ id: 4, scope: "app", projectId: "p", appKey: "api" });
  const otherProjectRow = skillRowFixture({ id: 5, scope: "app", projectId: "q", appKey: "web" });

  it("sees global rows at every target", () => {
    expect(skillVisibleAt(globalRow, {})).toBe(true);
    expect(skillVisibleAt(globalRow, { projectId: "p" })).toBe(true);
    expect(skillVisibleAt(globalRow, target)).toBe(true);
    expect(skillVisibleAt(globalRow, { projectId: "q", appKey: "web" })).toBe(true);
    expect(isOwnAppSkillRow(globalRow, target)).toBe(false);
    expect(skillRowTarget(globalRow)).toEqual({});
    expect(isSameSkillTarget(globalRow, "project", { projectId: "" })).toBe(false);
    expect(isSameSkillTarget(globalRow, "app", target)).toBe(false);
  });

  it("sees project rows only inside their own project", () => {
    expect(skillVisibleAt(projectRow, { projectId: "p" })).toBe(true);
    expect(skillVisibleAt(projectRow, target)).toBe(true);
    expect(skillVisibleAt(projectRow, {})).toBe(false);
    expect(skillVisibleAt(projectRow, { projectId: "q" })).toBe(false);
    expect(skillVisibleAt(projectRow, { projectId: "q", appKey: "web" })).toBe(false);
    expect(isOwnAppSkillRow(projectRow, target)).toBe(false);
    expect(skillRowTarget(projectRow)).toEqual({ projectId: "p" });
    expect(isSameSkillTarget(projectRow, "project", { projectId: "p" })).toBe(true);
    expect(isSameSkillTarget(projectRow, "project", { projectId: "q" })).toBe(false);
    expect(isSameSkillTarget(projectRow, "app", target)).toBe(false);
  });

  it("sees the caller's app row only at its own target", () => {
    expect(skillVisibleAt(callerAppRow, target)).toBe(true);
    expect(skillVisibleAt(callerAppRow, { projectId: "p" })).toBe(false);
    expect(skillVisibleAt(callerAppRow, { projectId: "q", appKey: "web" })).toBe(false);
    expect(isOwnAppSkillRow(callerAppRow, target)).toBe(true);
    expect(skillRowTarget(callerAppRow)).toEqual({ projectId: "p", appKey: "web" });
    expect(isSameSkillTarget(callerAppRow, "app", target)).toBe(true);
    expect(isSameSkillTarget(callerAppRow, "app", { projectId: "p", appKey: "api" })).toBe(false);
    expect(isSameSkillTarget(callerAppRow, "project", { projectId: "p" })).toBe(false);
  });

  it("hides sibling-app and other-project rows from the caller", () => {
    expect(skillVisibleAt(siblingAppRow, target)).toBe(false);
    expect(isOwnAppSkillRow(siblingAppRow, target)).toBe(false);
    expect(skillRowTarget(siblingAppRow)).toEqual({ projectId: "p", appKey: "api" });
    expect(isSameSkillTarget(siblingAppRow, "app", target)).toBe(false);

    expect(skillVisibleAt(otherProjectRow, target)).toBe(false);
    expect(skillVisibleAt(otherProjectRow, { projectId: "q", appKey: "web" })).toBe(true);
    expect(isOwnAppSkillRow(otherProjectRow, target)).toBe(false);
    expect(skillRowTarget(otherProjectRow)).toEqual({ projectId: "q", appKey: "web" });
    expect(isSameSkillTarget(otherProjectRow, "app", target)).toBe(false);
  });
});
