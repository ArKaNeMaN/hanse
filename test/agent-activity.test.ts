import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../src/logging/logger.js";
import {
  type ActivityEndpoint,
  type AgentActivityClient,
  AgentActivityService,
} from "../src/opencode/activity.js";
import {
  OpencodeHttpError,
  type OpencodePermissionRequest,
  type OpencodePermissionV2Request,
  type OpencodeQuestionRequest,
  type OpencodeSessionStatusMap,
} from "../src/opencode/client.js";
import { SessionResumeStore } from "../src/opencode/recovery.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { readLastAgentActivityAt } from "../src/store/process.js";

const APP = "p:a";
const START = 1_000;

class FakeClient implements AgentActivityClient {
  statusCalls = 0;
  v1QuestionCalls = 0;
  v1PermissionCalls = 0;
  v2QuestionCalls = 0;
  v2PermissionCalls = 0;
  status: () => Promise<OpencodeSessionStatusMap> = async () => ({});
  v1Questions: () => Promise<OpencodeQuestionRequest[]> = async () => [];
  v1Permissions: () => Promise<OpencodePermissionRequest[]> = async () => [];
  v2Questions: () => Promise<OpencodeQuestionRequest[]> = async () => [];
  v2Permissions: () => Promise<OpencodePermissionV2Request[]> = async () => [];

  listSessionStatusesStrict = async (): Promise<OpencodeSessionStatusMap> => {
    this.statusCalls += 1;
    return this.status();
  };

  listQuestionsStrict = async (): Promise<OpencodeQuestionRequest[]> => {
    this.v1QuestionCalls += 1;
    return this.v1Questions();
  };

  listPermissionsStrict = async (): Promise<OpencodePermissionRequest[]> => {
    this.v1PermissionCalls += 1;
    return this.v1Permissions();
  };

  listQuestionsV2Strict = async (): Promise<OpencodeQuestionRequest[]> => {
    this.v2QuestionCalls += 1;
    return this.v2Questions();
  };

  listPermissionsV2Strict = async (): Promise<OpencodePermissionV2Request[]> => {
    this.v2PermissionCalls += 1;
    return this.v2Permissions();
  };
}

function database(): SqliteDatabase {
  const db = openDatabase(":memory:");
  runMigrations(db);
  const now = new Date(START).toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', 'a', 'apps/a', 'AGENTS.md', ?)",
  ).run(APP, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:b', 'p', 'b', 'apps/b', 'AGENTS.md', ?)",
  ).run(now);
  return db;
}

interface Harness {
  db: SqliteDatabase;
  client: FakeClient;
  activity: AgentActivityService;
  clock: { now: number };
  warnings: Array<{ message: string; fields?: LogFields }>;
}

function harness(
  overrides: {
    endpoint?: () => ActivityEndpoint | Promise<ActivityEndpoint>;
    appDirFor?: (appId: string) => string | undefined;
    timeoutMs?: number;
  } = {},
): Harness {
  const db = database();
  const client = new FakeClient();
  const clock = { now: START };
  const warnings: Array<{ message: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, fields) => warnings.push({ message, fields }),
    error: () => undefined,
  };
  const activity = new AgentActivityService({
    db,
    client,
    activityEndpoint: overrides.endpoint ?? (() => ({ state: "running", endpoint: "http://oc" })),
    appDirFor: overrides.appDirFor ?? (() => "/tmp/app"),
    logger,
    now: () => clock.now,
    timeoutMs: overrides.timeoutMs ?? 50,
  });
  return { db, client, activity, clock, warnings };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function unsupported(path: string): OpencodeHttpError {
  return new OpencodeHttpError(path, 404, "missing");
}

function insertPendingSend(db: SqliteDatabase, updatedAt: number, state = "sending"): void {
  db.prepare(
    `INSERT INTO pending_sends
       (id, app_id, session_id, message_id, text, state, created_at, updated_at)
     VALUES ('pending_1', ?, 'ses_1', 'msg_1', 'hello', ?, ?, ?)`,
  ).run(APP, state, iso(updatedAt), iso(updatedAt));
}

function insertHandoff(
  db: SqliteDatabase,
  input: {
    id: string;
    state: string;
    from?: string;
    to?: string;
    mode?: "one_shot" | "thread";
  },
): void {
  const now = iso(START);
  db.prepare(
    `INSERT INTO handoffs
       (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key,
        attempts, mode, created_at, updated_at)
     VALUES (?, 'p', ?, ?, ?, 'summary', 'spec', ?, 0, ?, ?, ?)`,
  ).run(
    input.id,
    input.from ?? APP,
    input.to ?? APP,
    input.state,
    `idem_${input.id}`,
    input.mode ?? "one_shot",
    now,
    now,
  );
}

function insertThreadMessage(db: SqliteDatabase, handoffId: string, state: string): void {
  db.prepare(
    `INSERT INTO handoff_messages
       (handoff_id, kind, body, created_at, seq, state, author_side,
        delivery_session_id, updated_at)
     VALUES (?, 'message', 'hello', ?, 2, ?, 'source', 'ses_dest', ?)`,
  ).run(handoffId, iso(START), state, iso(START));
}

describe("AgentActivityService touch", () => {
  it("writes monotonically and coalesces status touches to one per minute", () => {
    const h = harness();
    h.activity.touch(APP, "status", h.clock.now);
    expect(h.activity.lastActivityAt(APP)).toBe(START);

    h.clock.now += 10_000;
    h.activity.touch(APP, "status");
    expect(readLastAgentActivityAt(h.db, APP)).toBe(iso(START));

    h.clock.now += 55_000;
    h.activity.touch(APP, "status");
    expect(readLastAgentActivityAt(h.db, APP)).toBe(iso(START + 65_000));

    h.clock.now += 1_000;
    h.activity.touch(APP, "answer");
    expect(readLastAgentActivityAt(h.db, APP)).toBe(iso(START + 66_000));
  });

  it("clears prompt capabilities on a start or restart touch", async () => {
    const h = harness();
    h.client.v2Questions = async () => [];
    await expect(h.activity.isActive(APP)).resolves.toBe(false);
    h.client.v2Questions = async () => Promise.reject(unsupported("/api/question/request"));
    await expect(h.activity.isActive(APP)).resolves.toBe(true);

    h.activity.touch(APP, "restart");
    await expect(h.activity.isActive(APP)).resolves.toBe(false);
  });
});

describe("AgentActivityService live check", () => {
  it("treats a not-running endpoint as inactive without probing", async () => {
    const h = harness({ endpoint: () => ({ state: "not_running" }) });
    await expect(h.activity.isActive(APP)).resolves.toBe(false);
    expect(h.client.statusCalls).toBe(0);
  });

  it("fails closed for an unprobeable endpoint", async () => {
    const h = harness({ endpoint: () => ({ state: "unprobeable", reason: "no_password" }) });
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
  });

  it("treats busy and retry statuses as active and a malformed status as active", async () => {
    const busy = harness();
    busy.client.status = async () => ({ ses_1: { type: "busy" } });
    await expect(busy.activity.isActive(APP)).resolves.toBe(true);

    const retry = harness();
    retry.client.status = async () => ({ ses_1: { type: "retry" } });
    await expect(retry.activity.isActive(APP)).resolves.toBe(true);

    const malformed = harness();
    malformed.client.status = async () =>
      Promise.reject(new OpencodeHttpError("/session/status", 0, "bad"));
    await expect(malformed.activity.isActive(APP)).resolves.toBe(true);
  });

  it("returns inactive when the status is idle and all prompt sources are empty", async () => {
    const h = harness();
    await expect(h.activity.isActive(APP)).resolves.toBe(false);
  });

  it("treats a busy subagent recovery row as active", async () => {
    const h = harness();
    new SessionResumeStore(h.db).upsertBusy({
      appId: APP,
      sessionId: "ses_child",
      status: "busy",
      observedAt: iso(START),
      parentSessionId: "ses_parent",
      runtimeStartedAt: iso(START),
    });
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
  });

  it("treats any pending v1 or v2 prompt as active", async () => {
    const v1 = harness();
    v1.client.v1Questions = async () => [{ id: "q", sessionID: "s", questions: [] }];
    await expect(v1.activity.isActive(APP)).resolves.toBe(true);

    const v2 = harness();
    v2.client.v2Permissions = async () => [
      { id: "p", sessionID: "s", action: "bash", resources: [] },
    ];
    await expect(v2.activity.isActive(APP)).resolves.toBe(true);
  });

  it("treats all never-successful 404/405 prompt sources as unsupported and inactive", async () => {
    const h = harness();
    h.client.v1Questions = async () => Promise.reject(unsupported("/question"));
    h.client.v1Permissions = async () => Promise.reject(unsupported("/permission"));
    h.client.v2Questions = async () => Promise.reject(unsupported("/api/question/request"));
    h.client.v2Permissions = async () => Promise.reject(unsupported("/api/permission/request"));

    await expect(h.activity.isActive(APP)).resolves.toBe(false);
  });

  it("keeps probing every source and treats a 404 after a success as active", async () => {
    const h = harness();
    h.client.v2Questions = async () => [];
    await expect(h.activity.isActive(APP)).resolves.toBe(false);
    expect([
      h.client.v1QuestionCalls,
      h.client.v1PermissionCalls,
      h.client.v2QuestionCalls,
      h.client.v2PermissionCalls,
    ]).toEqual([1, 1, 1, 1]);

    h.client.v2Questions = async () => Promise.reject(unsupported("/api/question/request"));
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
    expect([
      h.client.v1QuestionCalls,
      h.client.v1PermissionCalls,
      h.client.v2QuestionCalls,
      h.client.v2PermissionCalls,
    ]).toEqual([2, 2, 2, 2]);
  });

  it("fails closed on an unexpected prompt-source failure", async () => {
    const h = harness();
    h.client.v1Permissions = async () => Promise.reject(new Error("boom"));
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
  });

  it("treats a recent pending send as active and ages it out after fifteen minutes", async () => {
    const h = harness();
    insertPendingSend(h.db, START - 60_000);
    await expect(h.activity.isActive(APP)).resolves.toBe(true);

    h.db
      .prepare("UPDATE pending_sends SET updated_at = ? WHERE id = 'pending_1'")
      .run(iso(START - 16 * 60_000));
    await expect(h.activity.isActive(APP)).resolves.toBe(false);
  });

  it("treats awaiting approval, dispatching, and in-progress one-shot handoffs as active", async () => {
    for (const state of ["awaiting_approval", "dispatching", "in_progress"]) {
      const h = harness();
      insertHandoff(h.db, { id: `h_${state}`, state, from: "p:b", to: APP });
      await expect(h.activity.isActive(APP), state).resolves.toBe(true);
    }
  });

  it("treats a dispatching or waiting thread message as active but not the in-progress header alone", async () => {
    const headerOnly = harness();
    insertHandoff(headerOnly.db, { id: "h_thread", state: "in_progress", mode: "thread" });
    await expect(headerOnly.activity.isActive(APP)).resolves.toBe(false);

    for (const state of ["dispatching", "waiting_operator"]) {
      const h = harness();
      insertHandoff(h.db, { id: "h_thread", state: "in_progress", mode: "thread" });
      insertThreadMessage(h.db, "h_thread", state);
      await expect(h.activity.isActive(APP), state).resolves.toBe(true);
    }

    const delivered = harness();
    insertHandoff(delivered.db, { id: "h_thread", state: "in_progress", mode: "thread" });
    insertThreadMessage(delivered.db, "h_thread", "delivered");
    await expect(delivered.activity.isActive(APP)).resolves.toBe(false);
  });

  it("times out a hanging per-call probe and reports active", async () => {
    const h = harness({ timeoutMs: 10 });
    h.client.status = () => new Promise(() => undefined);
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
  });

  it("warns at most once per app per hour and fails closed without an app directory", async () => {
    const h = harness({ appDirFor: () => undefined });
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
    expect(
      h.warnings.filter((entry) => entry.message === "agent_activity_app_dir_missing"),
    ).toHaveLength(1);

    h.clock.now += 61 * 60_000;
    await expect(h.activity.isActive(APP)).resolves.toBe(true);
    expect(
      h.warnings.filter((entry) => entry.message === "agent_activity_app_dir_missing"),
    ).toHaveLength(2);
  });
});
