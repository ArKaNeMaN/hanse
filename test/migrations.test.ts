import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  openDatabase,
  runMigrations,
  SchemaTooNewError,
  UnknownMigrationError,
} from "../src/store/index.js";
import { MIGRATIONS } from "../src/store/migrations.js";

const IMAGE_COLUMNS = [
  "image_ref",
  "image_status",
  "image_hash",
  "image_base_digest",
  "image_built_at",
  "image_error",
];

const now = "2026-10-21T00:00:00.000Z";

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function appColumns(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare("PRAGMA table_info(apps)").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function projectColumns(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare("PRAGMA table_info(projects)").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function insertProjectAndApp(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a1','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
}

describe("migration v6 app-images", () => {
  it("applies fresh migrations and defaults existing app inserts to missing", () => {
    const db = openDatabase(":memory:");
    expect(runMigrations(db)).toBe(13);
    expect(runMigrations(db)).toBe(0);

    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const secretTables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('setting_secrets', 'secrets') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(secretTables).toEqual(["setting_secrets"]);

    const sshTables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'ssh_%' OR name = 'app_ssh_hosts') ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(sshTables).toEqual(
      [
        "ssh_approvals",
        "ssh_audit",
        "ssh_grants",
        "ssh_host_credentials",
        "ssh_hosts",
        "app_ssh_hosts",
      ].sort(),
    );

    const columns = appColumns(db);
    for (const column of IMAGE_COLUMNS) {
      expect(columns).toContain(column);
    }
    expect(columns).toContain("deleting");
    expect(projectColumns(db)).toContain("deleting");
    expect(
      (
        db.prepare("PRAGMA table_info(app_image_versions)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    ).toEqual([
      "id",
      "app_id",
      "image_ref",
      "image_id",
      "spec_hash",
      "base_digest",
      "built_at",
      "created_at",
    ]);
    const instanceColumns = (
      db.prepare("PRAGMA table_info(instances)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(instanceColumns).toContain("image_ref");
    expect(instanceColumns).toContain("applied_settings_hash");
    expect(instanceColumns).toContain("applied_profile");

    const skillColumns = (
      db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(skillColumns).toEqual([
      "id",
      "scope",
      "project_id",
      "app_key",
      "name",
      "description",
      "content",
      "enabled",
      "created_at",
      "updated_at",
      "updated_by",
      "license",
      "compatibility",
      "metadata_json",
    ]);
    const referenceColumns = (
      db.prepare("PRAGMA table_info(skill_references)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(referenceColumns).toEqual(["skill_id", "path", "content"]);
    const skillsSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skills'")
        .get() as { sql: string }
    ).sql;
    expect(skillsSql).toContain("UNIQUE (scope, project_id, app_key, name)");
    expect(skillsSql).toContain("scope IN ('global', 'project', 'app')");
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'skills_scope'")
        .get(),
    ).toEqual({ name: "skills_scope" });

    insertProjectAndApp(db);
    const row = db
      .prepare(
        "SELECT image_status, image_ref, image_hash, image_base_digest, image_built_at, image_error FROM apps WHERE id = 'a1'",
      )
      .get() as {
      image_status: string;
      image_ref: string | null;
      image_hash: string | null;
      image_base_digest: string | null;
      image_built_at: string | null;
      image_error: string | null;
    };
    expect(row).toEqual({
      image_status: "missing",
      image_ref: null,
      image_hash: null,
      image_base_digest: null,
      image_built_at: null,
      image_error: null,
    });

    expect(() =>
      db.prepare("UPDATE apps SET image_status = 'bogus' WHERE id = 'a1'").run(),
    ).toThrow();
    for (const status of ["building", "ready", "stale", "error"]) {
      db.prepare("UPDATE apps SET image_status = ? WHERE id = 'a1'").run(status);
    }
    db.close();
  });

  it("upgrades a v5 database and preserves existing app rows", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 5)) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
    }
    insertProjectAndApp(db);
    expect(appColumns(db)).not.toContain("image_status");

    expect(runMigrations(db)).toBe(8);

    const row = db.prepare("SELECT image_status, image_error FROM apps WHERE id = 'a1'").get() as {
      image_status: string;
      image_error: string | null;
    };
    expect(row).toEqual({ image_status: "missing", image_error: null });
    db.close();
  });

  it("upgrades a v9 database through v11 without losing instance state", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 9)) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
    }
    insertProjectAndApp(db);
    db.prepare(
      "INSERT INTO instances (id, app_id, state, runtime_state, updated_at) VALUES ('a1','a1','running','running',?)",
    ).run(now);

    expect(runMigrations(db)).toBe(4);

    const row = db
      .prepare(
        "SELECT state, applied_settings_hash, applied_profile FROM instances WHERE app_id = 'a1'",
      )
      .get() as {
      state: string;
      applied_settings_hash: string | null;
      applied_profile: number | null;
    };
    expect(row).toEqual({ state: "running", applied_settings_hash: null, applied_profile: null });
    db.close();
  });

  it("upgrades a v10 database to v11 and defaults existing rows to not deleting", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 10)) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
    }
    insertProjectAndApp(db);
    expect(appColumns(db)).not.toContain("deleting");
    expect(projectColumns(db)).not.toContain("deleting");

    expect(runMigrations(db)).toBe(3);

    const app = db.prepare("SELECT deleting FROM apps WHERE id = 'a1'").get() as {
      deleting: number;
    };
    const project = db.prepare("SELECT deleting FROM projects WHERE id = 'p'").get() as {
      deleting: number;
    };
    expect(app).toEqual({ deleting: 0 });
    expect(project).toEqual({ deleting: 0 });
    expect(() => db.prepare("UPDATE apps SET deleting = 2 WHERE id = 'a1'").run()).toThrow();
    expect(() => db.prepare("UPDATE projects SET deleting = 2 WHERE id = 'p'").run()).toThrow();
    db.close();
  });

  it("upgrades a v11 database to v13 and is idempotent", () => {
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
      record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
    }
    insertProjectAndApp(db);
    expect(() => db.prepare("SELECT 1 FROM skills").get()).toThrow();

    expect(runMigrations(db)).toBe(2);
    expect(runMigrations(db)).toBe(0);

    const columns = (db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(columns).toEqual([
      "id",
      "scope",
      "project_id",
      "app_key",
      "name",
      "description",
      "content",
      "enabled",
      "created_at",
      "updated_at",
      "updated_by",
      "license",
      "compatibility",
      "metadata_json",
    ]);
    const insert = db.prepare(
      `INSERT INTO skills
         (scope, project_id, app_key, name, description, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("global", "", "", "review-code", "Review code", "Body", now, now);
    expect(() =>
      insert.run("global", "", "", "Review-Code", "Review code", "Body", now, now),
    ).toThrow();
    expect(() =>
      insert.run("global", "p", "", "second", "Review code", "Body", now, now),
    ).toThrow();
    db.close();
  });

  it("rejects a newer applied schema before applying anything", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(14, "future", "future-checksum", now);

    expect(() => runMigrations(db)).toThrowError(SchemaTooNewError);
    try {
      runMigrations(db);
    } catch (error) {
      expect(error).toMatchObject({
        code: "schema_too_new",
        applied: 14,
        known: 13,
      });
      expect((error as Error).message).toContain("14");
      expect((error as Error).message).toContain("13");
    }
    expect(() => db.prepare("SELECT 1 FROM skills").get()).toThrow();
    db.close();
  });

  it("does not apply pending migrations when the database is newer", () => {
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
      record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
    }
    record.run(14, "future", "future-checksum", now);

    expect(() => runMigrations(db)).toThrowError(SchemaTooNewError);
    expect(() => db.prepare("SELECT 1 FROM skills").get()).toThrow();
    const count = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
      count: number;
    };
    expect(count.count).toBe(12);
    db.close();
  });

  it("rejects an applied version this binary does not know", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(0, "unknown", "unknown-checksum", now);

    expect(() => runMigrations(db)).toThrowError(UnknownMigrationError);
    try {
      runMigrations(db);
    } catch (error) {
      expect(error).toMatchObject({ code: "unknown_migration", version: 0, knownMax: 13 });
    }
    db.close();
  });

  it("warns and continues on a checksum mismatch", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 12").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(runMigrations(db)).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("schema_checksum_mismatch version=12"),
      );
    } finally {
      warn.mockRestore();
    }
    db.close();
  });

  it("upgrades a real v12 database to v13 and preserves existing skills", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-v12-"));
    const file = path.join(dir, "coordinator.db");
    try {
      const first = openDatabase(file);
      first.exec(
        "CREATE TABLE schema_migrations (" +
          "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
      const record = first.prepare(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      );
      for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 12)) {
        first.exec(migration.sql);
        record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
      }
      first
        .prepare(
          "INSERT INTO skills (scope, project_id, app_key, name, description, content, created_at, updated_at) VALUES ('global','','','review','Review','Body',?,?)",
        )
        .run(now, now);
      first.close();

      const reopened = openDatabase(file);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(runMigrations(reopened)).toBe(1);
        expect(runMigrations(reopened)).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      const max = reopened
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number };
      expect(max.version).toBe(13);
      const skill = reopened
        .prepare("SELECT license, compatibility, metadata_json FROM skills WHERE name = 'review'")
        .get() as { license: string | null; compatibility: string | null; metadata_json: string };
      expect(skill).toEqual({ license: null, compatibility: null, metadata_json: "{}" });
      const references = reopened
        .prepare("SELECT COUNT(*) AS count FROM skill_references")
        .get() as { count: number };
      expect(references.count).toBe(0);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces v13 bundle constraints and cascades reference rows", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    const insertSkill = db.prepare(
      `INSERT INTO skills
         (scope, project_id, app_key, name, description, content, created_at, updated_at)
       VALUES ('global', '', '', 'review', 'Review', 'Body', ?, ?)`,
    );
    insertSkill.run(now, now);
    const id = Number(
      (db.prepare("SELECT id FROM skills WHERE name = 'review'").get() as { id: number }).id,
    );

    expect(() =>
      db.prepare("UPDATE skills SET metadata_json = 'not-json' WHERE id = ?").run(id),
    ).toThrow();
    expect(() => db.prepare("UPDATE skills SET license = '' WHERE id = ?").run(id)).toThrow();
    expect(() =>
      db.prepare("UPDATE skills SET compatibility = ? WHERE id = ?").run("x".repeat(513), id),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE skills SET license = ? WHERE id = ?").run("x".repeat(257), id),
    ).toThrow();
    expect(() => db.prepare("UPDATE skills SET compatibility = '' WHERE id = ?").run(id)).toThrow();

    const insertReference = db.prepare(
      "INSERT INTO skill_references (skill_id, path, content) VALUES (?, ?, ?)",
    );
    expect(() => insertReference.run(id, "references/a.md", "")).toThrow();
    expect(() => insertReference.run(id, "references/../a.md", "Body")).toThrow();
    expect(() => insertReference.run(id, "references/nested/a.md", "Body")).toThrow();
    expect(() => insertReference.run(id, "references/A.md", "Body")).not.toThrow();
    db.prepare("DELETE FROM skill_references WHERE skill_id = ?").run(id);
    insertReference.run(id, "references/a.md", "Body");
    expect(() => insertReference.run(id, "references/a.md", "Other")).toThrow();
    db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM skill_references WHERE skill_id = ?")
      .get(id) as { count: number };
    expect(count.count).toBe(0);
    db.close();
  });

  it("starts a real v13 database unchanged", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-v13-"));
    const file = path.join(dir, "coordinator.db");
    try {
      const first = openDatabase(file);
      expect(runMigrations(first)).toBe(13);
      first.close();

      const reopened = openDatabase(file);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(runMigrations(reopened)).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      const max = reopened
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number };
      expect(max.version).toBe(13);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
