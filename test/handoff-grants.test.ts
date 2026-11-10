import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GRANT_DISPATCH_MODE,
  DEFAULT_GRANT_REPLY_MODE,
  deleteAppHandoffGrants,
  deleteHandoffGrant,
  HandoffGrantError,
  type HandoffGrantErrorCode,
  listHandoffGrants,
  listInboundHandoffGrants,
  listReachableRemoteTargets,
  recordCrossProjectDenied,
  resolveCrossProjectGrant,
  setHandoffGrant,
} from "../src/coordinator/grants.js";
import { HANDOFF_THREAD_RATE_WINDOW_MS } from "../src/coordinator/thread.js";
import { MASTER_PROJECT_ID } from "../src/master/constants.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const now = "2026-11-10T00:00:00.000Z";

function insertProject(db: SqliteDatabase, id: string, deleting = 0): void {
  db.prepare(
    `INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at, deleting)
     VALUES (?, ?, 'main', ?, ?, ?, ?)`,
  ).run(id, id, `/tmp/${id}`, now, now, deleting);
}

function insertApp(db: SqliteDatabase, projectId: string, appKey: string, deleting = 0): void {
  db.prepare(
    `INSERT INTO apps (id, project_id, app_key, path, contract, created_at, deleting)
     VALUES (?, ?, ?, ?, 'AGENTS.md', ?, ?)`,
  ).run(`${projectId}:${appKey}`, projectId, appKey, `apps/${appKey}`, now, deleting);
}

function makeDb(): SqliteDatabase {
  const db = openDatabase(":memory:");
  runMigrations(db);
  insertProject(db, "p1");
  insertProject(db, "p2");
  insertProject(db, "p3");
  insertApp(db, "p1", "a");
  insertApp(db, "p1", "b");
  insertApp(db, "p2", "c");
  insertApp(db, "p2", "d");
  insertApp(db, "p3", "e");
  return db;
}

function expectGrantError(fn: () => unknown, code: HandoffGrantErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HandoffGrantError);
    expect((error as HandoffGrantError).code).toBe(code);
    expect((error as Error).message.startsWith(`${code}: `)).toBe(true);
    return;
  }
  throw new Error(`expected HandoffGrantError with code ${code}`);
}

function eventsOfType(
  db: SqliteDatabase,
  type: string,
): Array<{
  scope: string;
  payload: Record<string, unknown>;
}> {
  const rows = db
    .prepare("SELECT scope, payload FROM events WHERE type = ? ORDER BY id")
    .all(type) as Array<{ scope: string; payload: string }>;
  return rows.map((row) => ({ scope: row.scope, payload: JSON.parse(row.payload) }));
}

describe("handoff grants", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  it("resolves exact pair over wildcard forms", () => {
    setHandoffGrant(db, {
      projectId: "p1",
      targetProjectId: "p2",
      dispatchMode: "auto",
      replyMode: "auto",
    });
    setHandoffGrant(db, { projectId: "p1", fromAppKey: "a", targetProjectId: "p2" });
    setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2", toAppKey: "c" });
    const exact = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
      toAppKey: "c",
      dispatchMode: "approve",
      replyMode: "approve",
    });

    expect(resolveCrossProjectGrant(db, "p1", "a", "p2", "c")).toMatchObject({
      grant: { id: exact.id },
      dispatchMode: "approve",
      replyMode: "approve",
    });
    // exact from + wildcard to beats wildcard/wildcard
    expect(resolveCrossProjectGrant(db, "p1", "a", "p2", "d")?.grant.fromAppKey).toBe("a");
    // wildcard from + exact to beats wildcard/wildcard
    expect(resolveCrossProjectGrant(db, "p1", "b", "p2", "c")?.grant.toAppKey).toBe("c");
    // only wildcard/wildcard remains
    expect(resolveCrossProjectGrant(db, "p1", "b", "p2", "d")?.grant.fromAppKey).toBe("*");
  });

  it("breaks a score tie by exact from before id", () => {
    // Wildcard/wildcard first (lowest id), then the exact-to row, then the exact-from row.
    setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2" });
    setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2", toAppKey: "c" });
    const exactFrom = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
    });

    const resolved = resolveCrossProjectGrant(db, "p1", "a", "p2", "c");
    expect(resolved?.grant.id).toBe(exactFrom.id);
    expect(resolved?.grant.fromAppKey).toBe("a");
    expect(resolved?.grant.toAppKey).toBe("*");
  });

  it("returns undefined for a same-project target", () => {
    expect(resolveCrossProjectGrant(db, "p1", "a", "p1", "b")).toBeUndefined();
  });

  it("ignores a grant for another target project", () => {
    setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2" });
    expect(resolveCrossProjectGrant(db, "p1", "a", "p3", "e")).toBeUndefined();
  });

  it("fails closed for the master project and a deleting project", () => {
    insertProject(db, MASTER_PROJECT_ID);
    insertApp(db, MASTER_PROJECT_ID, "master");
    db.prepare(
      `INSERT INTO handoff_grants
         (project_id, from_app_key, target_project_id, to_app_key, dispatch_mode, reply_mode,
          created_at, updated_at)
       VALUES ('p1', '*', ?, '*', 'auto', 'auto', ?, ?)`,
    ).run(MASTER_PROJECT_ID, now, now);
    expect(resolveCrossProjectGrant(db, "p1", "a", MASTER_PROJECT_ID, "master")).toBeUndefined();
    expect(resolveCrossProjectGrant(db, MASTER_PROJECT_ID, "master", "p2", "c")).toBeUndefined();

    setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2" });
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = 'p2'").run();
    expect(resolveCrossProjectGrant(db, "p1", "a", "p2", "c")).toBeUndefined();
  });

  it("creates, replaces, lists, and deletes a grant", () => {
    const created = setHandoffGrant(db, {
      projectId: "p1",
      targetProjectId: "p2",
      actor: "human-1",
    });
    expect(created).toMatchObject({
      projectId: "p1",
      fromAppKey: "*",
      targetProjectId: "p2",
      toAppKey: "*",
      dispatchMode: DEFAULT_GRANT_DISPATCH_MODE,
      replyMode: DEFAULT_GRANT_REPLY_MODE,
      createdBy: "human-1",
      updatedBy: "human-1",
    });
    expect(DEFAULT_GRANT_DISPATCH_MODE).toBe("auto");
    expect(DEFAULT_GRANT_REPLY_MODE).toBe("auto");

    const replaced = setHandoffGrant(db, {
      projectId: "p1",
      targetProjectId: "p2",
      dispatchMode: "approve",
      replyMode: "approve",
      actor: "human-2",
    });
    expect(replaced.id).toBe(created.id);
    expect(replaced.dispatchMode).toBe("approve");
    expect(replaced.replyMode).toBe("approve");
    expect(replaced.createdBy).toBe("human-1");
    expect(replaced.updatedBy).toBe("human-2");

    expect(listHandoffGrants(db, "p1")).toHaveLength(1);
    expect(listHandoffGrants(db, "p2")).toEqual([]);
    expect(listInboundHandoffGrants(db, "p2")).toMatchObject([
      { id: created.id, projectId: "p1", targetProjectId: "p2" },
    ]);

    expect(deleteHandoffGrant(db, "p1", "*", "p2", "*", "human-2")).toBe(true);
    expect(listHandoffGrants(db, "p1")).toEqual([]);
    expect(eventsOfType(db, "handoff.grant.created")).toHaveLength(1);
    expect(eventsOfType(db, "handoff.grant.updated")).toHaveLength(1);
    expect(eventsOfType(db, "handoff.grant.deleted")).toHaveLength(1);
  });

  it("rejects unknown projects, same project, unknown apps, invalid keys and modes, and master/deleting sides", () => {
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "nope", targetProjectId: "p2" }),
      "unknown_source_project",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "nope" }),
      "unknown_target_project",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "p1" }),
      "same_project_grant",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", fromAppKey: "zzz", targetProjectId: "p2" }),
      "unknown_source_app",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2", toAppKey: "zzz" }),
      "unknown_target_app",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", fromAppKey: "bad key", targetProjectId: "p2" }),
      "invalid_app_key",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2", dispatchMode: "deny" }),
      "invalid_mode",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2", replyMode: "deny" }),
      "invalid_mode",
    );

    insertProject(db, MASTER_PROJECT_ID);
    expectGrantError(
      () => setHandoffGrant(db, { projectId: MASTER_PROJECT_ID, targetProjectId: "p2" }),
      "builtin_target_forbidden",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: MASTER_PROJECT_ID }),
      "builtin_target_forbidden",
    );

    insertProject(db, "pdel");
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = 'pdel'").run();
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "pdel", targetProjectId: "p2" }),
      "deleting_target_forbidden",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "pdel" }),
      "deleting_target_forbidden",
    );
  });

  it("rejects an exact source or target app whose apps.deleting is set", () => {
    insertApp(db, "p1", "gone", 1);
    insertApp(db, "p2", "gone", 1);
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", fromAppKey: "gone", targetProjectId: "p2" }),
      "deleting_target_forbidden",
    );
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2", toAppKey: "gone" }),
      "deleting_target_forbidden",
    );
  });

  it("accepts a wildcard target key but never a wildcard target project", () => {
    expect(() =>
      setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2", toAppKey: "*" }),
    ).not.toThrow();
    expectGrantError(
      () => setHandoffGrant(db, { projectId: "p1", targetProjectId: "*" }),
      "unknown_target_project",
    );
  });

  it("resolves the exact grant over a wildcard grant for the same pair", () => {
    setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2" });
    const exact = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
      toAppKey: "c",
    });
    expect(resolveCrossProjectGrant(db, "p1", "a", "p2", "c")?.grant.id).toBe(exact.id);
  });

  it("lists reachable targets matching only the caller app and collapsing duplicates", () => {
    insertProject(db, "pdel");
    insertProject(db, MASTER_PROJECT_ID);
    insertApp(db, "pdel", "f");
    insertApp(db, MASTER_PROJECT_ID, "master");
    db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p2:d'").run();
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = 'pdel'").run();

    const wildcard = setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2" });
    const exact = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
      toAppKey: "c",
      dispatchMode: "approve",
    });
    setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "b",
      targetProjectId: "p3",
      toAppKey: "e",
    });
    // Raw rows model grants that were valid when created and whose target later became
    // master/deleting; the resolver and discovery must fail closed on them.
    db.prepare(
      `INSERT INTO handoff_grants
         (project_id, from_app_key, target_project_id, to_app_key, dispatch_mode, reply_mode,
          created_at, updated_at)
       VALUES ('p1', '*', 'pdel', '*', 'auto', 'auto', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO handoff_grants
         (project_id, from_app_key, target_project_id, to_app_key, dispatch_mode, reply_mode,
          created_at, updated_at)
       VALUES ('p1', '*', ?, '*', 'auto', 'auto', ?, ?)`,
    ).run(MASTER_PROJECT_ID, now, now);

    const fromA = listReachableRemoteTargets(db, "p1", "a");
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toEqual({
      projectId: "p2",
      projectName: "p2",
      appKey: "c",
      appId: "p2:c",
      grantId: exact.id,
      dispatchMode: "approve",
      replyMode: "auto",
    });

    const fromB = listReachableRemoteTargets(db, "p1", "b");
    expect(fromB.map((target) => target.appId)).toEqual(["p2:c", "p3:e"]);
    expect(fromB[0]?.grantId).toBe(wildcard.id);

    // A wildcard source grant matches every caller app, but the exact-from grant for "b" does not.
    expect(listReachableRemoteTargets(db, "p1", "zzz").map((target) => target.appId)).toEqual([
      "p2:c",
    ]);
    expect(listReachableRemoteTargets(db, "p3", "e")).toEqual([]);
    expect(listReachableRemoteTargets(db, "p1", "")).toEqual([]);
  });

  it("deleteHandoffGrant returns false for a missing grant", () => {
    expect(deleteHandoffGrant(db, "p1", "a", "p2", "c")).toBe(false);
    expect(eventsOfType(db, "handoff.grant.deleted")).toEqual([]);
  });

  it("deleteAppHandoffGrants removes exact rows on both sides and leaves wildcards", () => {
    const fromExact = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
    });
    const toExact = setHandoffGrant(db, {
      projectId: "p2",
      targetProjectId: "p1",
      toAppKey: "a",
    });
    const sourceWildcard = setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2" });
    const targetWildcard = setHandoffGrant(db, { projectId: "p2", targetProjectId: "p1" });
    const otherApp = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "b",
      targetProjectId: "p2",
    });

    expect(deleteAppHandoffGrants(db, "p1", "a")).toBe(2);
    const remaining = listHandoffGrants(db, "p1").map((grant) => grant.id);
    expect(remaining).toContain(sourceWildcard.id);
    expect(remaining).toContain(otherApp.id);
    expect(remaining).not.toContain(fromExact.id);
    const inbound = listHandoffGrants(db, "p2").map((grant) => grant.id);
    expect(inbound).toContain(targetWildcard.id);
    expect(inbound).not.toContain(toExact.id);
  });

  it("deleteAppHandoffGrants runs from app deletion", () => {
    const fromExact = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
      toAppKey: "c",
    });
    const toExact = setHandoffGrant(db, {
      projectId: "p2",
      fromAppKey: "c",
      targetProjectId: "p1",
      toAppKey: "a",
    });
    const wildcard = setHandoffGrant(db, { projectId: "p1", targetProjectId: "p2" });

    expect(deleteAppHandoffGrants(db, "p1", "a")).toBe(2);
    expect(deleteAppHandoffGrants(db, "p1", "a")).toBe(0);

    const sourceIds = listHandoffGrants(db, "p1").map((grant) => grant.id);
    expect(sourceIds).toContain(wildcard.id);
    expect(sourceIds).not.toContain(fromExact.id);
    expect(listHandoffGrants(db, "p2").map((grant) => grant.id)).not.toContain(toExact.id);
  });

  it("dedupes the denied event per app per rate window and keeps the payload content-free", () => {
    const payload = {
      projectId: "p1",
      targetProjectId: "p2",
      fromAppKey: "a",
      toAppKey: "c",
    };
    recordCrossProjectDenied(db, "p1:a", payload);
    recordCrossProjectDenied(db, "p1:a", { ...payload, toAppKey: "d" });
    recordCrossProjectDenied(db, "p1:b", payload);

    const denied = eventsOfType(db, "handoff.cross_project.denied");
    expect(denied).toEqual([
      { scope: "p1:a", payload },
      { scope: "p1:b", payload },
    ]);

    db.prepare(
      `UPDATE events SET created_at = ?
       WHERE scope = 'p1:a' AND type = 'handoff.cross_project.denied'`,
    ).run(new Date(Date.now() - HANDOFF_THREAD_RATE_WINDOW_MS - 1_000).toISOString());
    recordCrossProjectDenied(db, "p1:a", payload);

    const afterWindow = eventsOfType(db, "handoff.cross_project.denied");
    expect(afterWindow).toHaveLength(3);
    for (const event of afterWindow) {
      expect(Object.keys(event.payload).sort()).toEqual([
        "fromAppKey",
        "projectId",
        "targetProjectId",
        "toAppKey",
      ]);
      for (const forbidden of ["spec", "summary", "body", "result", "credential", "token"]) {
        expect(event.payload).not.toHaveProperty(forbidden);
      }
    }
  });

  it("audit payloads contain ids, keys, and modes only", () => {
    const grant = setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
      toAppKey: "c",
      actor: "human-1",
    });
    setHandoffGrant(db, {
      projectId: "p1",
      fromAppKey: "a",
      targetProjectId: "p2",
      toAppKey: "c",
      dispatchMode: "approve",
      actor: "human-1",
    });
    deleteHandoffGrant(db, "p1", "a", "p2", "c", "human-1");
    recordCrossProjectDenied(db, "p1:a", {
      projectId: "p1",
      targetProjectId: "p2",
      fromAppKey: "a",
      toAppKey: "c",
    });

    const [created] = eventsOfType(db, "handoff.grant.created");
    expect(created?.scope).toBe("p1");
    expect(Object.keys(created?.payload ?? {}).sort()).toEqual([
      "actor",
      "dispatchMode",
      "fromAppKey",
      "grantId",
      "projectId",
      "replyMode",
      "targetProjectId",
      "toAppKey",
    ]);
    expect(created?.payload).toMatchObject({ grantId: grant.id, actor: "human-1" });

    const [updated] = eventsOfType(db, "handoff.grant.updated");
    expect(updated?.payload).toMatchObject({ grantId: grant.id, dispatchMode: "approve" });

    const [deleted] = eventsOfType(db, "handoff.grant.deleted");
    expect(deleted?.scope).toBe("p1");
    expect(Object.keys(deleted?.payload ?? {}).sort()).toEqual([
      "actor",
      "fromAppKey",
      "grantId",
      "projectId",
      "targetProjectId",
      "toAppKey",
    ]);

    const [denied] = eventsOfType(db, "handoff.cross_project.denied");
    expect(denied?.scope).toBe("p1:a");
    expect(Object.keys(denied?.payload ?? {}).sort()).toEqual([
      "fromAppKey",
      "projectId",
      "targetProjectId",
      "toAppKey",
    ]);

    for (const event of [created?.payload, updated?.payload, deleted?.payload, denied?.payload]) {
      for (const forbidden of ["spec", "summary", "body", "result", "credential", "token"]) {
        expect(event).not.toHaveProperty(forbidden);
      }
    }
  });
});
