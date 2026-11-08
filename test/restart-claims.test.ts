import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimPersistedRestart,
  listPersistedRestarts,
  openDatabase,
  releasePersistedRestart,
  runMigrations,
  type SqliteDatabase,
} from "../src/store/index.js";

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

function fixture(): SqliteDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-restart-claims-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp/p',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  return db;
}

describe("persisted restart claims", () => {
  it("survives a restart until the owning claim releases it", () => {
    const db = fixture();
    const claimId = claimPersistedRestart(db, "p:a");
    expect(claimId).toBeDefined();
    expect(claimPersistedRestart(db, "p:a")).toBeUndefined();
    expect(listPersistedRestarts(db)).toMatchObject([{ appId: "p:a", claimId: claimId }]);

    releasePersistedRestart(db, "p:a", claimId);
    expect(listPersistedRestarts(db)).toEqual([]);
  });

  it("does not let an old owner delete a newer claim", () => {
    const db = fixture();
    const first = claimPersistedRestart(db, "p:a");
    releasePersistedRestart(db, "p:a", first);
    const second = claimPersistedRestart(db, "p:a");
    expect(second).toBeDefined();
    releasePersistedRestart(db, "p:a", first);
    expect(listPersistedRestarts(db)).toHaveLength(1);
  });
});
