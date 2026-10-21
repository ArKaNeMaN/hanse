import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "../src/store/index.js";
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
    expect(runMigrations(db)).toBe(12);
    expect(runMigrations(db)).toBe(0);

    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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
    ]);
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
      record.run(migration.version, migration.name, "existing", now);
    }
    insertProjectAndApp(db);
    expect(appColumns(db)).not.toContain("image_status");

    expect(runMigrations(db)).toBe(7);

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
      record.run(migration.version, migration.name, "existing", now);
    }
    insertProjectAndApp(db);
    db.prepare(
      "INSERT INTO instances (id, app_id, state, runtime_state, updated_at) VALUES ('a1','a1','running','running',?)",
    ).run(now);

    expect(runMigrations(db)).toBe(3);

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
      record.run(migration.version, migration.name, "existing", now);
    }
    insertProjectAndApp(db);
    expect(appColumns(db)).not.toContain("deleting");
    expect(projectColumns(db)).not.toContain("deleting");

    expect(runMigrations(db)).toBe(2);

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

  it("upgrades a v11 database to v12 and is idempotent", () => {
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
      record.run(migration.version, migration.name, "existing", now);
    }
    insertProjectAndApp(db);
    expect(() => db.prepare("SELECT 1 FROM skills").get()).toThrow();

    expect(runMigrations(db)).toBe(1);
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
});
