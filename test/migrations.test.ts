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
    expect(runMigrations(db)).toBe(16);
    expect(runMigrations(db)).toBe(0);

    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[];
    expect(versions.map((row) => row.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
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

    expect(runMigrations(db)).toBe(11);

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

    expect(runMigrations(db)).toBe(7);

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

    expect(runMigrations(db)).toBe(6);

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

    expect(runMigrations(db)).toBe(5);
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
    ).run(17, "future", "future-checksum", now);

    expect(() => runMigrations(db)).toThrowError(SchemaTooNewError);
    try {
      runMigrations(db);
    } catch (error) {
      expect(error).toMatchObject({
        code: "schema_too_new",
        applied: 17,
        known: 16,
      });
      expect((error as Error).message).toContain("17");
      expect((error as Error).message).toContain("16");
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
    record.run(17, "future", "future-checksum", now);

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
      expect(error).toMatchObject({ code: "unknown_migration", version: 0, knownMax: 16 });
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
        expect(runMigrations(reopened)).toBe(4);
        expect(runMigrations(reopened)).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      const max = reopened
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number };
      expect(max.version).toBe(16);
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
      expect(runMigrations(first)).toBe(16);
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
      expect(max.version).toBe(16);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function tableColumns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function namedIndexes(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' " +
          "AND tbl_name IN ('message_drafts', 'session_state', 'pending_sends') ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("migration v15 chat drafts and pending sends", () => {
  it("applies from an empty database with tables, indexes, defaults, and constraints", () => {
    const db = openDatabase(":memory:");
    expect(runMigrations(db)).toBe(16);
    expect(runMigrations(db)).toBe(0);

    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' " +
            "AND name IN ('message_drafts', 'session_state', 'pending_sends') ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(["message_drafts", "pending_sends", "session_state"]);

    expect(tableColumns(db, "message_drafts")).toEqual([
      "app_id",
      "session_id",
      "text",
      "updated_at",
    ]);
    expect(tableColumns(db, "session_state")).toEqual([
      "app_id",
      "session_id",
      "has_messages",
      "last_activity_at",
      "created_at",
      "updated_at",
    ]);
    expect(tableColumns(db, "pending_sends")).toEqual([
      "id",
      "app_id",
      "session_id",
      "message_id",
      "text",
      "attachments_json",
      "state",
      "error_code",
      "created_at",
      "updated_at",
    ]);

    expect(namedIndexes(db)).toEqual(["pending_sends_session_state", "session_state_activity"]);

    insertProjectAndApp(db);
    const insertDraft = db.prepare(
      "INSERT INTO message_drafts (app_id, session_id, updated_at) VALUES (?, ?, ?)",
    );
    insertDraft.run("a1", "ses_1", now);
    expect(db.prepare("SELECT text FROM message_drafts WHERE app_id = 'a1'").get()).toEqual({
      text: "",
    });

    const insertState = db.prepare(
      "INSERT INTO session_state (app_id, session_id, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    insertState.run("a1", "ses_1", now, now, now);
    expect(db.prepare("SELECT has_messages FROM session_state WHERE app_id = 'a1'").get()).toEqual({
      has_messages: 0,
    });
    expect(() =>
      db.prepare("UPDATE session_state SET has_messages = 2 WHERE app_id = 'a1'").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE session_state SET has_messages = -1 WHERE app_id = 'a1'").run(),
    ).toThrow();

    const insertPending = db.prepare(
      "INSERT INTO pending_sends (id, app_id, session_id, message_id, state, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertPending.run("ps1", "a1", "ses_1", "msg_1", "sending", now, now);
    expect(
      db.prepare("SELECT text, attachments_json FROM pending_sends WHERE id = 'ps1'").get(),
    ).toEqual({ text: "", attachments_json: "[]" });
    expect(() => insertPending.run("ps2", "a1", "ses_1", "msg_1", "sending", now, now)).toThrow();
    expect(() => insertPending.run("ps3", "a1", "ses_1", "msg_2", "sent", now, now)).toThrow();
    expect(() =>
      db.prepare("UPDATE pending_sends SET state = 'sent' WHERE id = 'ps1'").run(),
    ).toThrow();
    for (const state of ["sending", "unknown", "failed"]) {
      db.prepare("UPDATE pending_sends SET state = ? WHERE id = 'ps1'").run(state);
    }

    db.prepare("DELETE FROM apps WHERE id = 'a1'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM message_drafts").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM session_state").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM pending_sends").get()).toEqual({ count: 0 });
    db.close();
  });

  it("upgrades a v14 database and preserves existing rows", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 14)) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
    }
    insertProjectAndApp(db);
    db.prepare(
      "INSERT INTO handoffs (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key, created_at, updated_at) " +
        "VALUES ('h1', 'p', 'a1', 'a1', 'queued', 's', 'spec', 'idem', ?, ?)",
    ).run(now, now);

    expect(() => db.prepare("SELECT 1 FROM message_drafts").get()).toThrow();

    expect(runMigrations(db)).toBe(2);
    expect(runMigrations(db)).toBe(0);

    const max = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    expect(max.version).toBe(16);
    expect(namedIndexes(db)).toEqual(["pending_sends_session_state", "session_state_activity"]);
    expect(db.prepare("SELECT id FROM handoffs WHERE id = 'h1'").get()).toEqual({ id: "h1" });
    expect(db.prepare("SELECT id FROM apps WHERE id = 'a1'").get()).toEqual({ id: "a1" });
    db.close();
  });
});

function indexDetails(
  db: ReturnType<typeof openDatabase>,
  table: string,
): Array<{ name: string; unique: number; partial: number }> {
  return (
    db.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>
  )
    .filter((row) => !row.name.startsWith("sqlite_autoindex_"))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function indexColumns(db: ReturnType<typeof openDatabase>, name: string): string[] {
  return (
    db.prepare(`PRAGMA index_info(${name})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

describe("migration v16 chat attachments and deliveries", () => {
  it("applies from an empty database with tables, columns, and indexes", () => {
    const db = openDatabase(":memory:");
    expect(runMigrations(db)).toBe(16);
    expect(runMigrations(db)).toBe(0);

    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' " +
            "AND name IN ('app_attachments', 'attachment_deliveries') ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toEqual(["app_attachments", "attachment_deliveries"]);

    expect(tableColumns(db, "app_attachments")).toEqual([
      "id",
      "app_id",
      "session_id",
      "original_name",
      "stored_name",
      "rel_path",
      "temp_rel_path",
      "mime",
      "size",
      "declared_size",
      "kind",
      "mode",
      "state",
      "created_at",
      "updated_at",
    ]);
    expect(tableColumns(db, "attachment_deliveries")).toEqual([
      "id",
      "attachment_id",
      "app_id",
      "session_id",
      "part_id",
      "message_id",
      "state",
      "error_code",
      "created_at",
      "updated_at",
    ]);

    const attachmentIndexes = indexDetails(db, "app_attachments");
    expect(attachmentIndexes.map((row) => [row.name, row.unique, row.partial])).toEqual([
      ["app_attachments_app_session", 0, 0],
      ["app_attachments_app_state", 0, 0],
      ["app_attachments_rel_path", 1, 0],
      ["app_attachments_temp_rel_path", 1, 1],
    ]);
    expect(indexColumns(db, "app_attachments_app_session")).toEqual(["app_id", "session_id"]);
    expect(indexColumns(db, "app_attachments_app_state")).toEqual(["app_id", "state"]);
    expect(indexColumns(db, "app_attachments_rel_path")).toEqual(["rel_path"]);
    expect(indexColumns(db, "app_attachments_temp_rel_path")).toEqual(["app_id", "temp_rel_path"]);
    expect(attachmentIndexes[3]?.partial).toBe(1);

    const deliveryIndexes = indexDetails(db, "attachment_deliveries");
    expect(deliveryIndexes.map((row) => [row.name, row.unique, row.partial])).toEqual([
      ["attachment_deliveries_app_attachment", 0, 0],
      ["attachment_deliveries_app_message", 0, 0],
      ["attachment_deliveries_part_id", 1, 0],
      ["attachment_deliveries_session_state", 0, 0],
    ]);
    expect(indexColumns(db, "attachment_deliveries_part_id")).toEqual(["app_id", "part_id"]);
    expect(indexColumns(db, "attachment_deliveries_app_message")).toEqual(["app_id", "message_id"]);
    expect(indexColumns(db, "attachment_deliveries_app_attachment")).toEqual([
      "app_id",
      "attachment_id",
    ]);
    expect(indexColumns(db, "attachment_deliveries_session_state")).toEqual([
      "app_id",
      "session_id",
      "state",
    ]);

    insertProjectAndApp(db);
    db.prepare(
      "INSERT INTO app_attachments (id, app_id, session_id, original_name, state, created_at, updated_at) " +
        "VALUES ('att1', 'a1', 'ses_1', 'report.pdf', 'available', ?, ?)",
    ).run(now, now);
    expect(
      db
        .prepare("SELECT mode, stored_name, rel_path, size FROM app_attachments WHERE id = 'att1'")
        .get(),
    ).toEqual({ mode: "auto", stored_name: null, rel_path: null, size: null });
    db.close();
  });

  it("upgrades a v15 database and preserves existing app rows", () => {
    const db = openDatabase(":memory:");
    db.exec(
      "CREATE TABLE schema_migrations (" +
        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const record = db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= 15)) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migrationChecksum(migration.sql), now);
    }
    insertProjectAndApp(db);
    db.prepare(
      "INSERT INTO message_drafts (app_id, session_id, text, updated_at) VALUES ('a1', 'ses_1', 'draft', ?)",
    ).run(now);
    expect(() => db.prepare("SELECT 1 FROM app_attachments").get()).toThrow();

    expect(runMigrations(db)).toBe(1);
    expect(runMigrations(db)).toBe(0);

    const max = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    };
    expect(max.version).toBe(16);
    expect(db.prepare("SELECT id FROM apps WHERE id = 'a1'").get()).toEqual({ id: "a1" });
    expect(db.prepare("SELECT text FROM message_drafts WHERE app_id = 'a1'").get()).toEqual({
      text: "draft",
    });
    expect(tableColumns(db, "app_attachments")).toContain("declared_size");
    expect(tableColumns(db, "attachment_deliveries")).toContain("part_id");
    db.close();
  });

  it("rejects invalid state, kind, mode, sizes, and empty names", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    insertProjectAndApp(db);
    const insert = db.prepare(
      "INSERT INTO app_attachments (id, app_id, session_id, original_name, state, created_at, updated_at) " +
        "VALUES (?, 'a1', 'ses_1', ?, 'available', ?, ?)",
    );
    insert.run("att1", "report.pdf", now, now);

    for (const state of ["uploading", "available", "missing"]) {
      db.prepare("UPDATE app_attachments SET state = ? WHERE id = 'att1'").run(state);
    }
    expect(() =>
      db.prepare("UPDATE app_attachments SET state = 'sent' WHERE id = 'att1'").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE app_attachments SET state = '' WHERE id = 'att1'").run(),
    ).toThrow();

    for (const kind of ["image", "video", "pdf", "file"]) {
      db.prepare("UPDATE app_attachments SET kind = ? WHERE id = 'att1'").run(kind);
    }
    db.prepare("UPDATE app_attachments SET kind = NULL WHERE id = 'att1'").run();
    expect(() =>
      db.prepare("UPDATE app_attachments SET kind = 'audio' WHERE id = 'att1'").run(),
    ).toThrow();

    for (const mode of ["auto", "inline", "file"]) {
      db.prepare("UPDATE app_attachments SET mode = ? WHERE id = 'att1'").run(mode);
    }
    expect(() =>
      db.prepare("UPDATE app_attachments SET mode = 'embed' WHERE id = 'att1'").run(),
    ).toThrow();

    for (const size of [0, 1, 1024]) {
      db.prepare("UPDATE app_attachments SET size = ?, declared_size = ? WHERE id = 'att1'").run(
        size,
        size,
      );
    }
    db.prepare(
      "UPDATE app_attachments SET size = NULL, declared_size = NULL WHERE id = 'att1'",
    ).run();
    expect(() =>
      db.prepare("UPDATE app_attachments SET size = -1 WHERE id = 'att1'").run(),
    ).toThrow();
    expect(() =>
      db.prepare("UPDATE app_attachments SET declared_size = -1 WHERE id = 'att1'").run(),
    ).toThrow();

    expect(() => insert.run("att2", "", now, now)).toThrow();
    expect(() => insert.run("att3", "x", now, now)).not.toThrow();
    db.close();
  });

  it("enforces rel_path, partial temp path, and delivery part id uniqueness", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    insertProjectAndApp(db);
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p2','P2','main','/tmp',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a2','p2','a2','apps/a2','AGENTS.md',?)",
    ).run(now);

    const insert = db.prepare(
      "INSERT INTO app_attachments " +
        "(id, app_id, session_id, original_name, rel_path, temp_rel_path, state, created_at, updated_at) " +
        "VALUES (?, ?, 'ses_1', ?, ?, ?, 'available', ?, ?)",
    );
    insert.run("att1", "a1", "one.pdf", "attachments/ses_1/att1-one.pdf", null, now, now);
    expect(() =>
      insert.run("att2", "a1", "two.pdf", "attachments/ses_1/att1-one.pdf", null, now, now),
    ).toThrow();
    expect(() =>
      insert.run("att3", "a2", "three.pdf", "attachments/ses_1/att1-one.pdf", null, now, now),
    ).toThrow();

    insert.run("att4", "a1", "four.pdf", null, null, now, now);
    insert.run("att5", "a1", "five.pdf", null, null, now, now);

    insert.run(
      "att6",
      "a1",
      "six.pdf",
      "attachments/ses_1/att6-six.pdf",
      ".tmp/att6.part",
      now,
      now,
    );
    expect(() =>
      insert.run(
        "att7",
        "a1",
        "seven.pdf",
        "attachments/ses_1/att7-seven.pdf",
        ".tmp/att6.part",
        now,
        now,
      ),
    ).toThrow();
    expect(() =>
      insert.run(
        "att8",
        "a2",
        "eight.pdf",
        "attachments/ses_1/att8-eight.pdf",
        ".tmp/att6.part",
        now,
        now,
      ),
    ).not.toThrow();

    const insertDelivery = db.prepare(
      "INSERT INTO attachment_deliveries " +
        "(id, attachment_id, app_id, session_id, part_id, message_id, state, created_at, updated_at) " +
        "VALUES (?, 'att1', ?, 'ses_1', ?, ?, 'sending', ?, ?)",
    );
    insertDelivery.run("d1", "a1", "prt_1", "msg_1", now, now);
    insertDelivery.run("d2", "a1", null, "msg_2", now, now);
    insertDelivery.run("d3", "a1", null, "msg_3", now, now);
    expect(() => insertDelivery.run("d4", "a1", "prt_1", "msg_4", now, now)).toThrow();
    expect(() => insertDelivery.run("d5", "a2", "prt_1", "msg_5", now, now)).not.toThrow();
    db.close();
  });

  it("cascades deliveries from attachments and both from apps", () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    insertProjectAndApp(db);
    const insertAttachment = db.prepare(
      "INSERT INTO app_attachments (id, app_id, session_id, original_name, state, created_at, updated_at) " +
        "VALUES (?, 'a1', 'ses_1', ?, 'available', ?, ?)",
    );
    const insertDelivery = db.prepare(
      "INSERT INTO attachment_deliveries " +
        "(id, attachment_id, app_id, session_id, part_id, message_id, state, created_at, updated_at) " +
        "VALUES (?, ?, 'a1', 'ses_1', ?, ?, 'sending', ?, ?)",
    );
    insertAttachment.run("att1", "one.pdf", now, now);
    insertDelivery.run("d1", "att1", "prt_1", "msg_1", now, now);

    db.prepare("DELETE FROM app_attachments WHERE id = 'att1'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM attachment_deliveries").get()).toEqual({
      count: 0,
    });

    insertAttachment.run("att2", "two.pdf", now, now);
    insertDelivery.run("d2", "att2", "prt_2", "msg_2", now, now);
    db.prepare("DELETE FROM apps WHERE id = 'a1'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM app_attachments").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM attachment_deliveries").get()).toEqual({
      count: 0,
    });
    db.close();
  });
});
