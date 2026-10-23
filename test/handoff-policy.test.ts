import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteHandoffPolicy,
  HandoffPolicyError,
  listHandoffPolicies,
  resolveHandoffPolicy,
  setHandoffPolicy,
} from "../src/coordinator/policy.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): SqliteDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-hp-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/x',?,?)",
  ).run(now, now);
  for (const key of ["a", "b", "c"]) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(`p:${key}`, key, `apps/${key}`, now);
  }
  return db;
}

describe("handoff policy", () => {
  it("defaults to autonomous dispatch and reply when no rule matches", () => {
    const db = fixture();
    const resolved = resolveHandoffPolicy(db, "p", "a", "b");
    expect(resolved.dispatchMode).toBe("auto");
    expect(resolved.replyMode).toBe("auto");
    expect(resolved.rule).toBeNull();
    db.close();
  });

  it("applies exact pairs over wildcards over the project default", () => {
    const db = fixture();
    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "*",
      toAppKey: "*",
      dispatchMode: "approve",
      replyMode: "approve",
    });
    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "*",
      dispatchMode: "auto",
      replyMode: "auto",
    });
    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "*",
      toAppKey: "b",
      dispatchMode: "deny",
      replyMode: "auto",
    });

    // Exact-from wildcard beats exact-to wildcard; the project default is last.
    expect(resolveHandoffPolicy(db, "p", "a", "b").dispatchMode).toBe("auto");
    expect(resolveHandoffPolicy(db, "p", "a", "c").dispatchMode).toBe("auto");
    expect(resolveHandoffPolicy(db, "p", "c", "b").dispatchMode).toBe("deny");
    expect(resolveHandoffPolicy(db, "p", "c", "c").dispatchMode).toBe("approve");

    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "deny",
      replyMode: "approve",
    });
    const exact = resolveHandoffPolicy(db, "p", "a", "b");
    expect(exact.dispatchMode).toBe("deny");
    expect(exact.replyMode).toBe("approve");
    expect(exact.rule?.fromAppKey).toBe("a");
    expect(exact.rule?.toAppKey).toBe("b");
    db.close();
  });

  it("validates modes and application keys", () => {
    const db = fixture();
    expect(() =>
      setHandoffPolicy(db, {
        projectId: "p",
        fromAppKey: "missing",
        dispatchMode: "auto",
        replyMode: "auto",
      }),
    ).toThrow(HandoffPolicyError);
    expect(() =>
      setHandoffPolicy(db, {
        projectId: "p",
        fromAppKey: "a",
        dispatchMode: "sometimes",
        replyMode: "auto",
      }),
    ).toThrow(HandoffPolicyError);
    expect(() =>
      setHandoffPolicy(db, {
        projectId: "p",
        fromAppKey: "a",
        replyMode: "sometimes",
      }),
    ).toThrow(HandoffPolicyError);
    db.close();
  });

  it("lists, replaces, and deletes rules", () => {
    const db = fixture();
    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "approve",
      replyMode: "auto",
    });
    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "deny",
      replyMode: "approve",
    });
    const rules = listHandoffPolicies(db, "p");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.dispatchMode).toBe("deny");
    expect(rules[0]?.replyMode).toBe("approve");

    expect(deleteHandoffPolicy(db, "p", "a", "b")).toBe(true);
    expect(deleteHandoffPolicy(db, "p", "a", "b")).toBe(false);
    expect(listHandoffPolicies(db, "p")).toEqual([]);
    db.close();
  });
});
