import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "../src/store/index.js";

const dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-db-"));
  dirs.push(dir);
  return path.join(dir, "coordinator.db");
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("store", () => {
  it("migrates idempotently", () => {
    const db = openDatabase(tempDbPath());
    expect(runMigrations(db)).toBeGreaterThan(0);
    expect(runMigrations(db)).toBe(0);
    db.close();
  });

  it("migrates to v4 with agent tokens and instance runtime columns", () => {
    const db = openDatabase(tempDbPath());
    runMigrations(db);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4]);

    const tokenColumns = (
      db.prepare("PRAGMA table_info(agent_tokens)").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tokenColumns).toEqual(["id", "app_id", "token_hash", "created_at", "revoked_at"]);

    const instanceColumns = (
      db.prepare("PRAGMA table_info(instances)").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(instanceColumns).toContain("spec_hash");
    expect(instanceColumns).toContain("runtime_state");

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a1','p','a','x','AGENTS.md',?)",
    ).run(now);
    db.prepare(
      "INSERT INTO agent_tokens (id,app_id,token_hash,created_at) VALUES ('t1','a1','hash-1',?)",
    ).run(now);
    expect(() =>
      db
        .prepare(
          "INSERT INTO agent_tokens (id,app_id,token_hash,created_at) VALUES ('t2','a1','hash-1',?)",
        )
        .run(now),
    ).toThrow();
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = openDatabase(tempDbPath());
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO apps (id, project_id, app_key, path, contract, created_at) VALUES ('a','missing','a','x','AGENTS.md',?)",
        )
        .run(new Date().toISOString()),
    ).toThrow();
    db.close();
  });

  it("enforces the active-lane partial unique index", () => {
    const db = openDatabase(tempDbPath());
    runMigrations(db);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a1','p','a','x','AGENTS.md',?)",
    ).run(now);
    db.prepare(
      "INSERT INTO tasks (id,app_id,state,created_at,updated_at) VALUES ('t1','a1','running',?,?)",
    ).run(now, now);
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (id,app_id,state,created_at,updated_at) VALUES ('t2','a1','dispatched',?,?)",
        )
        .run(now, now),
    ).toThrow();
    db.prepare(
      "INSERT INTO tasks (id,app_id,state,created_at,updated_at) VALUES ('t3','a1','done',?,?)",
    ).run(now, now);
    db.close();
  });
});
