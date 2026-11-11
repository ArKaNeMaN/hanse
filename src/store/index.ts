import { coordinatorDbPath } from "../runtime/paths.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "./database.js";
import { reconcileSkillFiles } from "./reconcile-skill-files.js";

export * from "./database.js";
export * from "./migrations.js";
export * from "./process.js";
export * from "./reconcile-skill-files.js";
export * from "./restart-claims.js";

/** Open the coordinator DB, apply migrations, and reconcile local skill files. */
export function openCoordinatorDatabase(
  stateHome: string,
  filename = coordinatorDbPath(stateHome),
): SqliteDatabase {
  const db = openDatabase(filename);
  runMigrations(db);
  reconcileSkillFiles(db);
  return db;
}
