import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeAppStatus } from "../src/agent/protocol.js";
import type {
  OpencodeMessage,
  OpencodeSession,
  OpencodeSessionStatusMap,
} from "../src/opencode/client.js";
import { OpencodeHttpError } from "../src/opencode/client.js";
import {
  deterministicResumeMessageId,
  ProcessRecovery,
  type ProcessRecoveryDeps,
  RESUME_LEASE_MS,
  RESUME_PROMPT,
  type RuntimeObservation,
  SessionNoticeStore,
  type SessionNoticeView,
  SessionResumeStore,
} from "../src/opencode/recovery.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const APP = "p:a";
const START_MS = Date.parse("2026-10-27T10:00:00.000Z");
const S1 = "2026-10-27T10:00:00.000Z";
const S2 = "2026-10-27T10:05:00.000Z";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

interface PromptCall {
  endpoint: string;
  sessionId: string;
  text: string;
  messageID: string;
  parts: unknown;
}

interface Harness {
  db: SqliteDatabase;
  recovery: ProcessRecovery;
  resumes: SessionResumeStore;
  notices: SessionNoticeStore;
  emitted: SessionNoticeView[];
  statuses: Map<string, RuntimeAppStatus>;
  sessionStatuses: OpencodeSessionStatusMap;
  sessions: OpencodeSession[];
  messages: Map<string, OpencodeMessage[]>;
  prompts: PromptCall[];
  promptError: unknown;
  deploymentLocked: boolean;
  restarting: boolean;
  now: number;
}

function database(): SqliteDatabase {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const now = new Date(START_MS).toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', 'a', 'apps/a', 'AGENTS.md', ?)",
  ).run(APP, now);
  return db;
}

function harness(overrides: Partial<ProcessRecoveryDeps> = {}): Harness {
  const db = database();
  const state: Harness = {
    db,
    recovery: undefined as unknown as ProcessRecovery,
    resumes: new SessionResumeStore(db),
    notices: new SessionNoticeStore(db),
    emitted: [],
    statuses: new Map(),
    sessionStatuses: {},
    sessions: [],
    messages: new Map(),
    prompts: [],
    promptError: undefined,
    deploymentLocked: false,
    restarting: false,
    now: START_MS,
  };
  const deps: ProcessRecoveryDeps = {
    db,
    runtimeStatus: async (appId) => state.statuses.get(appId),
    endpointFor: () => "http://opencode.test",
    listSessionsBounded: async () => state.sessions,
    listSessionStatuses: async () => state.sessionStatuses,
    listMessages: async (_endpoint, sessionId) => state.messages.get(sessionId) ?? [],
    listMessagePage: async (_endpoint, sessionId, options) => ({
      messages: (state.messages.get(sessionId) ?? []).slice(-options.limit),
    }),
    sendPromptAsync: async (endpoint, sessionId, text, messageID, _options, _model, parts) => {
      state.prompts.push({ endpoint, sessionId, text, messageID, parts });
      if (state.promptError !== undefined) throw state.promptError;
    },
    isRestarting: () => state.restarting,
    isDeploymentLocked: () => state.deploymentLocked,
    now: () => state.now,
    terminalConfirmationMs: 5,
    stoppedGraceMs: 0,
    onNotice: (_appId, notice) => state.emitted.push(notice),
    ...overrides,
  };
  state.recovery = new ProcessRecovery(deps);
  return state;
}

function at(ms: number): string {
  return new Date(ms).toISOString();
}

function runtime(
  startedAt: string | null,
  state: RuntimeAppStatus["state"],
  overrides: Partial<RuntimeAppStatus> = {},
): RuntimeAppStatus {
  return {
    appId: APP,
    endpoint: state === "running" ? "http://opencode.test" : null,
    state,
    specHash: "spec",
    version: null,
    startedAt,
    restartCount: 0,
    exitCode: null,
    oomKilled: false,
    finishedAt: null,
    ...overrides,
  };
}

function observation(
  startedAt: string | null,
  state: RuntimeObservation["state"],
  overrides: Partial<RuntimeObservation> = {},
): RuntimeObservation {
  return {
    startedAt,
    restartCount: 0,
    state,
    exitCode: null,
    oomKilled: false,
    finishedAt: null,
    stopReason: null,
    stopAt: null,
    ...overrides,
  };
}

function busy(state: Harness, sessionId = "ses_1", startedAt = S1): void {
  state.resumes.upsertBusy({
    appId: APP,
    sessionId,
    status: "busy",
    observedAt: at(START_MS),
    runtimeStartedAt: startedAt,
    runtimeRestartCount: 0,
  });
}

function interrupted(
  state: Harness,
  sessionId = "ses_1",
  interruptionKey = `${S1}|${at(START_MS)}`,
): void {
  state.resumes.markInterrupted({
    appId: APP,
    sessionId,
    interruptedAt: at(START_MS),
    interruptionEpoch: S1,
    interruptionKey,
    reason: "process_exit",
  });
}

function resumable(state: Harness, sessionId = "ses_1"): void {
  busy(state, sessionId);
  interrupted(state, sessionId);
  state.sessions = [{ id: sessionId }];
  state.statuses.set(APP, runtime(S1, "running"));
}

function user(id: string, created = START_MS): OpencodeMessage {
  return { info: { id, role: "user", time: { created } }, parts: [] };
}

function assistant(
  id: string,
  options: { completed?: boolean; finish?: string; created?: number } = {},
): OpencodeMessage {
  const created = options.created ?? START_MS;
  return {
    info: {
      id,
      role: "assistant",
      finish: options.finish ?? "stop",
      time: options.completed === false ? { created } : { created, completed: created + 1 },
    },
    parts: [],
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("ProcessRecovery runtime classification", () => {
  it("treats a NULL previous epoch as a baseline and synthesizes nothing", async () => {
    const h = harness();
    busy(h);

    await h.recovery.observeRuntime(APP, undefined, observation(S1, "running"));
    await h.recovery.observeRuntime(APP, observation(null, "stopped"), observation(S1, "running"));

    expect(h.emitted).toEqual([]);
    expect(h.resumes.get(APP, "ses_1")?.interruptedAt).toBeNull();
  });

  it("records an operator restart notice once per active session", async () => {
    const h = harness();
    busy(h);
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.recordStopIntent(APP, "restart");
    await h.recovery.recordStopIntent(APP, "restart");

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      sessionId: "ses_1",
      kind: "agent_stopped",
      reason: "operator_restart",
    });
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      interruptedAt: at(START_MS),
      reason: "operator_restart",
      resumeState: "observing",
    });
  });

  it("maps stop and deletion intents and terminalizes the cycle", async () => {
    const stop = harness();
    busy(stop);
    stop.statuses.set(APP, runtime(S1, "running"));
    await stop.recovery.recordStopIntent(APP, "stop");
    expect(stop.emitted[0]?.reason).toBe("operator_stop");
    expect(stop.resumes.get(APP, "ses_1")?.resumeState).toBe("skipped_stopped");

    const deletion = harness();
    busy(deletion);
    deletion.statuses.set(APP, runtime(S1, "running"));
    await deletion.recovery.recordStopIntent(APP, "delete");
    expect(deletion.emitted[0]?.reason).toBe("deletion");
    expect(deletion.resumes.get(APP, "ses_1")?.resumeState).toBe("skipped_stopped");
  });

  it("classifies an external restart without an intent as an unexpected exit", async () => {
    const h = harness();
    busy(h);

    await h.recovery.observeRuntime(
      APP,
      observation(S1, "running"),
      observation(S2, "running", { exitCode: 1 }),
    );

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({ kind: "agent_stopped", reason: "process_exit" });
    expect(h.resumes.get(APP, "ses_1")?.interruptionEpoch).toContain(S1);
  });

  it("defers an epoch change under an active deployment lock without a notice", async () => {
    const h = harness();
    h.deploymentLocked = true;
    busy(h);

    await h.recovery.observeRuntime(APP, observation(S1, "running"), observation(S2, "running"));

    expect(h.emitted).toEqual([]);
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "deferred",
      deferReason: "deployment_lock",
    });
  });

  it("classifies a stopped app and terminalizes the cycle", async () => {
    const h = harness();
    busy(h);

    await h.recovery.observeRuntime(APP, observation(S1, "running"), observation(S1, "stopped"));

    expect(h.emitted[0]).toMatchObject({ kind: "agent_stopped", reason: "unknown_restart" });
    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("skipped_stopped");
  });

  it("defers a stopped sample while a deployment lock is active", async () => {
    const h = harness();
    h.deploymentLocked = true;
    busy(h);

    await h.recovery.observeRuntime(APP, observation(S1, "running"), observation(S1, "stopped"));

    expect(h.emitted).toEqual([]);
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "deferred",
      deferReason: "deployment_lock",
    });
  });

  it("does not honor a stale stop intent", async () => {
    const h = harness();
    busy(h);
    h.now = START_MS + 11 * 60 * 1000;

    await h.recovery.observeRuntime(
      APP,
      observation(S1, "running", {
        stopReason: "restart",
        stopAt: "2026-10-27T10:00:30.000Z",
      }),
      observation(S2, "running", { exitCode: 0 }),
    );

    expect(h.emitted[0]).toMatchObject({ reason: "process_exit" });
  });

  it("treats an intent older than the previous start as stale", async () => {
    const h = harness();
    busy(h);

    await h.recovery.observeRuntime(
      APP,
      observation(S1, "running", {
        stopReason: "restart",
        stopAt: "2026-10-27T09:59:00.000Z",
      }),
      observation(S2, "running"),
    );

    expect(h.emitted[0]).toMatchObject({ reason: "unknown_restart" });
  });

  it("suppresses the notice and clears the marker for a completed tail", async () => {
    const h = harness();
    busy(h);
    h.messages.set("ses_1", [user("msg_1"), assistant("msg_2")]);

    await h.recovery.observeRuntime(APP, observation(S1, "running"), observation(S2, "running"));

    expect(h.emitted).toEqual([]);
    expect(h.resumes.get(APP, "ses_1")).toBeUndefined();
  });

  it("writes parent rollups for active children on a whole-process stop", async () => {
    const h = harness();
    busy(h, "ses_child");
    h.resumes.setResumeState(APP, "ses_child", "observing");
    h.db
      .prepare("UPDATE session_resume SET parent_session_id = 'ses_parent' WHERE session_id = ?")
      .run("ses_child");
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.recordStopIntent(APP, "stop");

    expect(h.emitted.map((notice) => [notice.sessionId, notice.kind])).toEqual([
      ["ses_child", "agent_stopped"],
      ["ses_parent", "subagent_interrupted"],
    ]);
  });
});

describe("ProcessRecovery terminal confirmation", () => {
  it("clears a busy marker after a SIGTERM-like idle when the tail completed", async () => {
    const h = harness();
    busy(h);
    h.messages.set("ses_1", [user("msg_1"), assistant("msg_2")]);
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "idle" } },
    );
    await settle();

    expect(h.resumes.get(APP, "ses_1")).toBeUndefined();
  });

  it("preserves a busy marker after a SIGTERM-like error with an unfinished tail", async () => {
    const h = harness();
    busy(h);
    h.messages.set("ses_1", [user("msg_1"), assistant("msg_2", { finish: "tool-calls" })]);
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "error" } },
    );
    await settle();

    expect(h.resumes.get(APP, "ses_1")?.interruptedAt).toBeNull();
  });

  it("preserves the marker when the live epoch changed and the tail was unfinished", async () => {
    const h = harness();
    busy(h);
    h.messages.set("ses_1", [user("msg_1")]);
    h.statuses.set(APP, runtime(S2, "running"));

    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "idle" } },
    );
    await settle();

    expect(h.resumes.get(APP, "ses_1")).toBeDefined();
  });

  it("preserves the marker when the confirmation status probe fails", async () => {
    const h = harness({
      listSessionStatuses: async () => {
        throw new Error("status unavailable");
      },
    });
    busy(h);
    h.messages.set("ses_1", [user("msg_1"), assistant("msg_2")]);
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "idle" } },
    );
    await settle();

    expect(h.resumes.get(APP, "ses_1")).toBeDefined();
  });

  it("cancels a pending clear when a new busy event arrives", async () => {
    const h = harness();
    busy(h);
    h.messages.set("ses_1", [user("msg_1"), assistant("msg_2")]);
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "idle" } },
    );
    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "busy" } },
    );
    await settle();

    expect(h.resumes.get(APP, "ses_1")?.observedStatus).toBe("busy");
  });
});

describe("ProcessRecovery subagent aborts", () => {
  it("classifies an operator abort through an ancestor tombstone", async () => {
    const h = harness();
    h.sessions = [
      { id: "ses_grand" },
      { id: "ses_parent", parentID: "ses_grand" },
      { id: "ses_child", parentID: "ses_parent" },
    ];
    h.recovery.recordOperatorAbort(APP, "ses_grand");

    await h.recovery.handleChildAbort({ id: APP }, "ses_child", "ses_parent", {
      startedAt: S1,
      restartCount: 0,
    });

    expect(h.emitted.map((notice) => [notice.sessionId, notice.reason])).toEqual([
      ["ses_child", "operator_abort"],
      ["ses_parent", "operator_abort"],
    ]);
  });

  it("classifies an unexpected child abort as a subagent abort", async () => {
    const h = harness();
    h.sessions = [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }];

    await h.recovery.handleChildAbort({ id: APP }, "ses_child", "ses_parent", {
      startedAt: S1,
      restartCount: 0,
    });

    expect(h.emitted.map((notice) => notice.reason)).toEqual(["subagent_abort", "subagent_abort"]);
  });

  it("writes a child-only notice when the parent is gone", async () => {
    const h = harness();
    h.sessions = [{ id: "ses_child", parentID: "ses_parent" }];

    await h.recovery.handleChildAbort({ id: APP }, "ses_child", "ses_parent", {
      startedAt: S1,
      restartCount: 0,
    });

    expect(h.emitted.map((notice) => notice.sessionId)).toEqual(["ses_child"]);
  });

  it("dedupes a child abort against a later whole-process rollup", async () => {
    const h = harness();
    h.sessions = [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }];
    h.statuses.set(APP, runtime(S1, "running"));
    busy(h, "ses_parent");
    busy(h, "ses_child");
    h.db
      .prepare("UPDATE session_resume SET parent_session_id = 'ses_parent' WHERE session_id = ?")
      .run("ses_child");

    await h.recovery.handleChildAbort({ id: APP }, "ses_child", "ses_parent", {
      startedAt: S1,
      restartCount: 0,
    });
    await h.recovery.recordStopIntent(APP, "stop");

    const parentRollups = h.emitted.filter(
      (notice) => notice.sessionId === "ses_parent" && notice.kind === "subagent_interrupted",
    );
    expect(parentRollups).toHaveLength(1);
  });

  it("derives a child abort from session.error only for aborted children", async () => {
    const h = harness();
    h.sessions = [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }];
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.observeSessionError(
      { id: APP },
      { sessionID: "ses_child", name: "MessageAbortedError", message: "aborted" },
    );
    await h.recovery.observeSessionError(
      { id: APP },
      { sessionID: "ses_child", name: "OtherError", message: "boom" },
    );

    expect(h.emitted).toHaveLength(2);
  });
});

describe("ProcessRecovery startup catch-up", () => {
  it("notices an epoch change that happened while the coordinator was down", async () => {
    const h = harness();
    busy(h);
    h.statuses.set(APP, runtime(S2, "running"));

    await h.recovery.startupCatchUp();

    expect(h.emitted[0]).toMatchObject({ kind: "agent_stopped", reason: "unknown_restart" });
  });

  it("leaves a same-epoch running cycle alone", async () => {
    const h = harness();
    busy(h);
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.startupCatchUp();

    expect(h.emitted).toEqual([]);
    expect(h.resumes.get(APP, "ses_1")?.interruptedAt).toBeNull();
  });

  it("terminalizes a persistent stopped app after the grace and re-probe", async () => {
    const h = harness({ stoppedGraceMs: 10 });
    busy(h);
    h.statuses.set(APP, runtime(S1, "stopped"));

    await h.recovery.startupCatchUp();
    expect(h.emitted).toEqual([]);
    h.now = START_MS + 11;
    await h.recovery.reconcile();

    expect(h.emitted[0]).toMatchObject({ kind: "agent_stopped", reason: "unknown_restart" });
    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("skipped_stopped");
  });

  it("defers a stopped sample during a restart claim and does not notice it", async () => {
    const h = harness();
    h.restarting = true;
    busy(h);
    h.statuses.set(APP, runtime(S1, "stopped"));

    await h.recovery.startupCatchUp();

    expect(h.emitted).toEqual([]);
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "deferred",
      deferReason: "restart_claim",
    });
  });

  it("terminalizes an expired deferred cycle in reconcile", async () => {
    const h = harness();
    busy(h);
    h.statuses.set(APP, runtime(S1, "running"));
    h.resumes.setResumeState(APP, "ses_1", "deferred", { deferReason: "deployment_lock" });
    h.db
      .prepare("UPDATE session_resume SET last_busy_seen_at = ? WHERE session_id = ?")
      .run(at(START_MS - 31 * 60 * 1000), "ses_1");

    await h.recovery.reconcile();

    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "skipped_stale",
      deferReason: null,
    });
  });

  it("never calls ensure during detection", async () => {
    const h = harness();
    let ensured = false;
    const recovery = new ProcessRecovery({
      db: h.db,
      runtimeStatus: async () => h.statuses.get(APP),
      endpointFor: () => "http://opencode.test",
      listSessionsBounded: async () => [],
      listSessionStatuses: async () => ({}),
      listMessages: async () => [],
      sendPromptAsync: async () => undefined,
      isRestarting: () => false,
      isDeploymentLocked: () => false,
      now: () => h.now,
      ...({
        ensure: () => {
          ensured = true;
        },
      } as unknown as Record<string, unknown>),
    });
    busy(h);

    await recovery.observeRuntime(APP, observation(S1, "running"), observation(S2, "running"));

    expect(ensured).toBe(false);
  });
});

describe("ProcessRecovery resume dispatch", () => {
  it("dispatches one deterministic synthetic prompt and counts the attempt once", async () => {
    const h = harness();
    resumable(h);
    const interruptionKey = `${S1}|${at(START_MS)}`;
    const expectedId = deterministicResumeMessageId(APP, "ses_1", interruptionKey, 1);

    await h.recovery.resumePass();

    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toMatchObject({
      endpoint: "http://opencode.test",
      sessionId: "ses_1",
      text: RESUME_PROMPT,
      messageID: expectedId,
    });
    expect(expectedId).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(h.prompts[0]?.parts).toEqual([
      {
        type: "text",
        text: RESUME_PROMPT,
        synthetic: true,
        metadata: { hanse: "agent-resume" },
      },
    ]);
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "resuming",
      dispatchState: "sent",
      autoAttempts: 1,
      resumeMessageId: expectedId,
    });
    expect(h.emitted.map((notice) => notice.kind)).toEqual(["resume_started"]);

    await h.recovery.resumePass();
    expect(h.prompts).toHaveLength(1);
    expect(h.resumes.get(APP, "ses_1")?.autoAttempts).toBe(1);
  });

  it("terminalizes an expired cycle as skipped_stale", async () => {
    const h = harness();
    resumable(h);
    h.now = START_MS + 30 * 60 * 1000;

    await h.recovery.resumePass();

    expect(h.prompts).toHaveLength(0);
    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("skipped_stale");
    expect(h.emitted.at(-1)).toMatchObject({
      kind: "resume_unavailable",
      reason: "ttl_expired",
    });
  });

  it("skips a vanished session as skipped_missing", async () => {
    const h = harness();
    resumable(h);
    h.sessions = [];

    await h.recovery.resumePass();

    expect(h.prompts).toHaveLength(0);
    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("skipped_missing");
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_unavailable", reason: "missing" });
  });

  it("defers on a restart claim or deployment lock and never dispatches", async () => {
    const claim = harness();
    resumable(claim);
    claim.restarting = true;
    await claim.recovery.resumePass();
    expect(claim.prompts).toHaveLength(0);
    expect(claim.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "deferred",
      deferReason: "restart_claim",
    });

    const deployment = harness();
    resumable(deployment);
    deployment.deploymentLocked = true;
    await deployment.recovery.resumePass();
    expect(deployment.prompts).toHaveLength(0);
    expect(deployment.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "deferred",
      deferReason: "deployment_lock",
    });
  });

  it("terminalizes a stopped app without starting it", async () => {
    const h = harness();
    resumable(h);
    h.statuses.set(APP, runtime(S1, "stopped"));

    await h.recovery.resumePass();

    expect(h.prompts).toHaveLength(0);
    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("skipped_stopped");
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_unavailable", reason: "stopped" });
  });

  it("skips a completed tail and a newer user message", async () => {
    const completed = harness();
    resumable(completed);
    completed.messages.set("ses_1", [user("msg_u"), assistant("msg_a", { created: START_MS + 1 })]);
    await completed.recovery.resumePass();
    expect(completed.prompts).toHaveLength(0);
    expect(completed.resumes.get(APP, "ses_1")?.resumeState).toBe("completed");

    const newer = harness();
    resumable(newer);
    newer.messages.set("ses_1", [user("msg_u", START_MS + 1)]);
    await newer.recovery.resumePass();
    expect(newer.prompts).toHaveLength(0);
    expect(newer.resumes.get(APP, "ses_1")?.resumeState).toBe("superseded");
    expect(newer.emitted.at(-1)).toMatchObject({
      kind: "resume_unavailable",
      reason: "superseded",
    });
  });

  it("treats a transport failure as ambiguous without counting the attempt", async () => {
    const h = harness();
    resumable(h);
    h.promptError = new OpencodeHttpError("/session/ses_1/prompt_async", 0, "timeout");

    await h.recovery.resumePass();

    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "ambiguous",
      dispatchState: "ambiguous",
      autoAttempts: 0,
    });
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_failed", reason: "ambiguous" });
  });

  it("retries a provably-not-sent dispatch once, then fails without counting an attempt", async () => {
    const h = harness();
    resumable(h);
    h.promptError = new OpencodeHttpError("/session/ses_1/prompt_async", 400, "bad request");

    await h.recovery.resumePass();

    expect(h.prompts).toHaveLength(2);
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "failed",
      dispatchState: "failed",
      autoAttempts: 0,
      autoDispatchRetries: 2,
    });
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_failed" });
  });

  it("marks a newer user message during the resume as superseded and resets the cycle", async () => {
    const h = harness();
    resumable(h);
    await h.recovery.resumePass();
    const resumeId = h.resumes.get(APP, "ses_1")?.resumeMessageId;
    if (resumeId === null || resumeId === undefined) throw new Error("missing resume id");
    h.messages.set("ses_1", [user(resumeId, START_MS + 1), user("msg_new", START_MS + 2)]);

    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "busy" } },
    );

    expect(h.emitted.map((notice) => notice.reason)).toContain("superseded");
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "observing",
      interruptedAt: null,
      resumeMessageId: null,
      observedStatus: "busy",
    });
  });

  it("does not complete on a bare idle after send, then completes on the correlated assistant", async () => {
    const h = harness();
    resumable(h);
    await h.recovery.resumePass();
    const resumeId = h.resumes.get(APP, "ses_1")?.resumeMessageId;
    if (resumeId === null || resumeId === undefined) throw new Error("missing resume id");

    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "idle" } },
    );
    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("resuming");
    expect(h.emitted.some((notice) => notice.kind === "resume_completed")).toBe(false);

    h.messages.set("ses_1", [
      user(resumeId, START_MS + 1),
      assistant("msg_a", { created: START_MS + 2 }),
    ]);
    await h.recovery.observeSessionStatus(
      { id: APP },
      { sessionID: "ses_1", status: { type: "idle" } },
    );

    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("completed");
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_completed" });
  });

  it("treats an absent status entry as idle for resume completion", async () => {
    const h = harness();
    resumable(h);
    await h.recovery.resumePass();
    const resumeId = h.resumes.get(APP, "ses_1")?.resumeMessageId;
    if (resumeId === null || resumeId === undefined) throw new Error("missing resume id");
    h.messages.set("ses_1", [
      user(resumeId, START_MS + 1),
      assistant("msg_a", { created: START_MS + 2 }),
    ]);

    await h.recovery.observeSessionStatus({ id: APP }, { sessionID: "ses_1", status: null });

    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("completed");
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_completed" });
  });

  it("fails a non-abort session error after the resume message", async () => {
    const h = harness();
    resumable(h);
    await h.recovery.resumePass();
    const resumeId = h.resumes.get(APP, "ses_1")?.resumeMessageId;
    if (resumeId === null || resumeId === undefined) throw new Error("missing resume id");
    h.messages.set("ses_1", [user(resumeId, START_MS + 1)]);

    await h.recovery.observeSessionError(
      { id: APP },
      { sessionID: "ses_1", name: "ProviderError", message: "boom" },
    );

    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("failed");
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_failed" });
  });

  it("expires the lease to ambiguous with a notice", async () => {
    const h = harness();
    resumable(h);
    await h.recovery.resumePass();
    h.now = START_MS + RESUME_LEASE_MS;

    await h.recovery.reconcile();

    expect(h.resumes.get(APP, "ses_1")?.resumeState).toBe("ambiguous");
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_failed", reason: "ambiguous" });
  });

  it("reconciles a prepared dispatch whose message exists without sending again", async () => {
    const h = harness();
    resumable(h);
    const messageId = deterministicResumeMessageId(APP, "ses_1", `${S1}|${at(START_MS)}`, 1);
    h.resumes.prepareDispatch({
      appId: APP,
      sessionId: "ses_1",
      messageId,
      at: at(START_MS),
    });
    h.messages.set("ses_1", [user(messageId, START_MS + 1)]);

    await h.recovery.startupCatchUp();

    expect(h.prompts).toHaveLength(0);
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "resuming",
      dispatchState: "sent",
      autoAttempts: 1,
    });
    expect(h.emitted.at(-1)).toMatchObject({ kind: "resume_started" });
  });

  it("reconciles a provably-not-sent prepared dispatch with one retry", async () => {
    const h = harness();
    resumable(h);
    const messageId = deterministicResumeMessageId(APP, "ses_1", `${S1}|${at(START_MS)}`, 1);
    h.resumes.prepareDispatch({
      appId: APP,
      sessionId: "ses_1",
      messageId,
      at: at(START_MS),
    });

    await h.recovery.startupCatchUp();

    expect(h.prompts).toHaveLength(1);
    expect(h.resumes.get(APP, "ses_1")).toMatchObject({
      resumeState: "resuming",
      dispatchState: "sent",
      autoAttempts: 1,
      autoDispatchRetries: 1,
    });
  });

  it("never auto-resumes a child session", async () => {
    const h = harness();
    busy(h, "ses_child");
    interrupted(h, "ses_child");
    h.db
      .prepare("UPDATE session_resume SET parent_session_id = 'ses_parent' WHERE session_id = ?")
      .run("ses_child");
    h.sessions = [{ id: "ses_parent" }, { id: "ses_child", parentID: "ses_parent" }];
    h.statuses.set(APP, runtime(S1, "running"));

    await h.recovery.resumePass();

    expect(h.prompts).toHaveLength(0);
    expect(h.resumes.get(APP, "ses_child")?.resumeState).toBe("observing");
  });
});
