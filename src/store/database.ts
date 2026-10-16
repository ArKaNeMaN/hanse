import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.js";

export type SqliteDatabase = Database.Database;

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

/** Apply pending forward-only migrations. Returns the number applied (0 when up to date). */
export function runMigrations(db: SqliteDatabase): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (" +
      "version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );
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
