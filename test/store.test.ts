import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHandoff,
  expireDueHandoffs,
  failTimedOutHandoffs,
  getHandoff,
  HandoffTransitionError,
  transitionHandoff,
  updateHandoff,
} from "../src/coordinator/handoff.js";
import {
  bumpThreadCounters,
  getHandoffMessage,
  insertHandoffMessage,
  listHandoffMessages,
  transitionHandoffMessage,
} from "../src/coordinator/thread.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

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

  it("migrates to v13 with agent tokens, runner containers, app image versions, git credentials, SSH tables, applied runtime state, deletion markers, and skill bundles", () => {
    const db = openDatabase(tempDbPath());
    runMigrations(db);
    const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[];
    expect(versions.map((row) => row.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    ]);
    const secretTables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('setting_secrets', 'secrets') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(secretTables).toEqual(["setting_secrets"]);

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
    expect(instanceColumns).toContain("container_id");
    expect(instanceColumns).toContain("container_name");
    expect(instanceColumns).toContain("image_ref");
    expect(instanceColumns).toContain("applied_settings_hash");
    expect(instanceColumns).toContain("applied_profile");
    expect(instanceColumns).toContain("applied_image_id");

    const versionColumns = (
      db.prepare("PRAGMA table_info(app_image_versions)").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(versionColumns).toEqual([
      "id",
      "app_id",
      "image_ref",
      "image_id",
      "spec_hash",
      "base_digest",
      "built_at",
      "created_at",
      "base_ref",
      "base_kind",
      "hash_version",
    ]);

    const appColumns = (
      db.prepare("PRAGMA table_info(apps)").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(appColumns).toContain("image_status");
    expect(appColumns).toContain("image_ref");
    expect(appColumns).toContain("image_hash");
    expect(appColumns).toContain("image_base_digest");
    expect(appColumns).toContain("image_built_at");
    expect(appColumns).toContain("image_error");
    expect(appColumns).toContain("deleting");
    expect(appColumns).toContain("build_configured");
    expect(appColumns).toContain("image_base_ref");
    expect(appColumns).toContain("image_base_kind");
    expect(appColumns).toContain("image_hash_version");
    expect(appColumns).toContain("image_build_id");
    expect(appColumns).toContain("image_build_ref");
    expect(appColumns).toContain("image_build_started_at");
    expect(appColumns).toContain("image_build_rejected_ref");

    const projectColumns = (
      db.prepare("PRAGMA table_info(projects)").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(projectColumns).toContain("deleting");

    const skillColumns = (
      db.prepare("PRAGMA table_info(skills)").all() as {
        name: string;
      }[]
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
      "origin",
      "forked_from_source_id",
      "forked_from_name",
      "forked_from_revision",
    ]);
    const referenceColumns = (
      db.prepare("PRAGMA table_info(skill_references)").all() as {
        name: string;
      }[]
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

function handoffFixtures(): { db: SqliteDatabase; now: string } {
  const db = openDatabase(tempDbPath());
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a1','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('a2','p','b','apps/b','AGENTS.md',?)",
  ).run(now);
  return { db, now };
}

function createHandoffRow(db: SqliteDatabase, key: string, extra: { expiresAt?: string } = {}) {
  return createHandoff(db, {
    projectId: "p",
    fromAppId: "a1",
    toAppId: "a2",
    summary: "need X",
    spec: "do X",
    idempotencyKey: key,
    expiresAt: extra.expiresAt ?? null,
  });
}

describe("handoff thread store helpers", () => {
  it("inserts and lists messages in seq order", () => {
    const { db, now } = handoffFixtures();
    const handoff = createHandoffRow(db, "k1");

    const first = insertHandoffMessage(db, {
      handoffId: handoff.id,
      seq: 1,
      kind: "request",
      body: "first",
      authorSide: "source",
      authorAppId: "a1",
      clientMessageId: "cm-1",
      bindingNonce: "nonce-1",
      createdAt: now,
    });
    const second = insertHandoffMessage(db, {
      handoffId: handoff.id,
      seq: 2,
      kind: "message",
      body: "second",
      authorSide: "source",
      authorAppId: "a1",
      createdAt: now,
    });

    expect(first.state).toBe("binding");
    expect(first.authorSide).toBe("source");
    expect(first.clientMessageId).toBe("cm-1");
    expect(first.bindingNonce).toBe("nonce-1");
    expect(getHandoffMessage(db, first.id)).toEqual(first);
    expect(listHandoffMessages(db, handoff.id)).toEqual([first, second]);
    db.close();
  });

  it("transitions messages through the thread state machine", () => {
    const { db, now } = handoffFixtures();
    const handoff = createHandoffRow(db, "k1");
    const message = insertHandoffMessage(db, {
      handoffId: handoff.id,
      seq: 1,
      kind: "request",
      body: "first",
      authorSide: "source",
      authorAppId: "a1",
      createdAt: now,
    });

    const queued = transitionHandoffMessage(db, message.id, "queued", {
      boundSessionId: "ses-root",
      invokingSessionId: "ses-child",
      boundAt: now,
    });
    expect(queued.state).toBe("queued");
    expect(queued.boundSessionId).toBe("ses-root");
    expect(queued.invokingSessionId).toBe("ses-child");

    const dispatching = transitionHandoffMessage(db, message.id, "dispatching", {
      deliverySessionId: "ses-target",
      deliveryMessageId: "msg-1",
      claimedAt: now,
    });
    expect(dispatching.state).toBe("dispatching");
    expect(dispatching.deliverySessionId).toBe("ses-target");

    const delivered = transitionHandoffMessage(db, message.id, "delivered", {
      deliveredAt: now,
    });
    expect(delivered.state).toBe("delivered");
    expect(delivered.deliveredAt).toBe(now);
    expect(() => transitionHandoffMessage(db, message.id, "queued")).toThrow(
      HandoffTransitionError,
    );
    db.close();
  });

  it("allocates thread counters until the message cap", () => {
    const { db, now } = handoffFixtures();
    const handoff = createHandoffRow(db, "k1");
    updateHandoff(db, handoff.id, {
      mode: "thread",
      state: "in_progress",
      messageSeq: 1,
      messageCount: 1,
    });

    expect(bumpThreadCounters(db, handoff.id, { now, idleExpiresAt: now, maxMessages: 2 })).toEqual(
      { messageSeq: 2, messageCount: 2 },
    );
    expect(
      bumpThreadCounters(db, handoff.id, { now, idleExpiresAt: now, maxMessages: 2 }),
    ).toBeUndefined();
    expect(getHandoff(db, handoff.id)?.messageCount).toBe(2);
    db.close();
  });

  it("keeps expiry one-shot-only and fails thread starts only while dispatching", () => {
    const { db } = handoffFixtures();
    const past = new Date(Date.now() - 1000).toISOString();

    const oneShot = createHandoffRow(db, "k1", { expiresAt: past });
    const idleThread = createHandoffRow(db, "k2");
    updateHandoff(db, idleThread.id, { mode: "thread", state: "in_progress" });

    expect(expireDueHandoffs(db)).toBe(1);
    expect(getHandoff(db, oneShot.id)?.state).toBe("expired");
    expect(getHandoff(db, idleThread.id)?.state).toBe("in_progress");

    const runningOneShot = createHandoffRow(db, "k3");
    transitionHandoff(db, runningOneShot.id, "dispatching");
    transitionHandoff(db, runningOneShot.id, "in_progress", { deadlineAt: past });

    const startingThread = createHandoffRow(db, "k4");
    updateHandoff(db, startingThread.id, {
      mode: "thread",
      state: "dispatching",
      deadlineAt: past,
    });

    const openThread = createHandoffRow(db, "k5");
    updateHandoff(db, openThread.id, {
      mode: "thread",
      state: "in_progress",
      deadlineAt: past,
    });

    expect(failTimedOutHandoffs(db)).toBe(2);
    expect(getHandoff(db, runningOneShot.id)?.state).toBe("failed");
    expect(getHandoff(db, startingThread.id)?.state).toBe("failed");
    expect(getHandoff(db, openThread.id)?.state).toBe("in_progress");
    db.close();
  });
});
