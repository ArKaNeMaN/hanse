import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.js";

export type SqliteDatabase = Database.Database;

/** The database was migrated by a newer coordinator than this binary supports. */
export class SchemaTooNewError extends Error {
  readonly code = "schema_too_new";
  readonly applied: number;
  readonly known: number;

  constructor(applied: number, known: number) {
    super(
      `database schema version ${applied} is newer than this coordinator supports (known max ${known}); restore the pre-deploy backup or run the matching coordinator image`,
    );
    this.name = "SchemaTooNewError";
    this.applied = applied;
    this.known = known;
  }
}

/** The database has an applied migration version this binary does not know. */
export class UnknownMigrationError extends Error {
  readonly code = "unknown_migration";
  readonly version: number;
  readonly knownMax: number;

  constructor(version: number, knownMax: number) {
    super(
      `database has unknown applied migration version ${version} (known max ${knownMax}); restore the pre-deploy backup or run the matching coordinator image`,
    );
    this.name = "UnknownMigrationError";
    this.version = version;
    this.knownMax = knownMax;
  }
}

/** Open a SQLite database with the pragmas required for multi-process, single-node use. */
export function openDatabase(filename: string): SqliteDatabase {
  if (filename !== ":memory:") {
    mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Apply pending forward-only migrations after validating the applied versions.
 *
 * A newer-than-code or unknown applied version aborts before any pending migration runs. A checksum
 * mismatch is logged and tolerated (owner decision), so a compatible existing database still starts.
 */
export function runMigrations(db: SqliteDatabase): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const appliedRows = db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; checksum: string }>;
  const known = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  const knownMax = MIGRATIONS.at(-1)?.version ?? 0;
  const appliedMax = appliedRows.at(-1)?.version ?? 0;

  if (appliedMax > knownMax) {
    throw new SchemaTooNewError(appliedMax, knownMax);
  }
  for (const row of appliedRows) {
    const migration = known.get(row.version);
    if (migration === undefined) {
      throw new UnknownMigrationError(row.version, knownMax);
    }
    if (checksum(migration.sql) !== row.checksum) {
      console.warn(
        `[schema] schema_checksum_mismatch version=${row.version}: the stored checksum differs from the code; continuing`,
      );
    }
  }

  const applied = new Set(appliedRows.map((row) => row.version));
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  let appliedCount = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    applyMigration(db, migration, record);
    appliedCount += 1;
  }
  return appliedCount;
}

function applyMigration(
  db: SqliteDatabase,
  migration: Migration,
  record: Database.Statement,
): void {
  const run = db.transaction(() => {
    db.exec(migration.sql);
    record.run(
      migration.version,
      migration.name,
      checksum(migration.sql),
      new Date().toISOString(),
    );
  });
  run();
}
