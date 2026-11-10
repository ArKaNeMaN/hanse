import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideApproval, getPendingApproval } from "../src/coordinator/approval.js";
import { getHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import { projectHandoffMessages } from "../src/coordinator/handoff-messages.js";
import { setHandoffPolicy } from "../src/coordinator/policy.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import {
  appendThreadReply,
  buildThreadIdempotencyKey,
  createThread,
  DEFAULT_THREAD_LIMITS,
  getHandoffMessage,
  insertHandoffMessage,
  listHandoffMessages,
  ThreadError,
  type ThreadErrorCode,
  transitionHandoffMessage,
} from "../src/coordinator/thread.js";
import { createPrincipal } from "../src/identity/principals.js";
import { type NotificationSignal, notificationEvents } from "../src/notifications/events.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(() => {
  notificationEvents.reset();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): { db: SqliteDatabase; service: CoordinatorService } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ht-"));
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
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('q','Q','main','/y',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('q:b','q','b','apps/b','AGENTS.md',?)",
  ).run(now);
  return { db, service: new CoordinatorService(db, "p") };
}

let keyCounter = 0;
function nextKey(prefix = "key"): string {
  keyCounter += 1;
  return `${prefix}-${keyCounter}`;
}

function startThread(
  service: CoordinatorService,
  overrides: Record<string, unknown> = {},
): ReturnType<CoordinatorService["requestSiblingChange"]> {
  return service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "thread summary",
    spec: "initial spec",
    mode: "thread",
    idempotencyKey: nextKey("thread"),
    ...overrides,
  });
}

function openThread(
  db: SqliteDatabase,
  id: string,
  roots: { sourceSessionId?: string | null; targetSessionId?: string | null } = {},
): void {
  updateHandoff(db, id, {
    state: "in_progress",
    sourceSessionId: roots.sourceSessionId === undefined ? "ses-source" : roots.sourceSessionId,
    targetSessionId: roots.targetSessionId === undefined ? "ses-target" : roots.targetSessionId,
  });
}

function makeSourceDispatching(db: SqliteDatabase, messageId: number): void {
  transitionHandoffMessage(db, messageId, "queued");
  transitionHandoffMessage(db, messageId, "dispatching", {
    deliverySessionId: `ses-${messageId}`,
  });
}

function makeSourceDelivered(db: SqliteDatabase, messageId: number): void {
  makeSourceDispatching(db, messageId);
  transitionHandoffMessage(db, messageId, "delivered", {
    deliveredAt: new Date().toISOString(),
  });
}

function expectThreadError(fn: () => unknown, code: ThreadErrorCode): void {
  try {
    fn();
    throw new Error(`expected ThreadError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ThreadError);
    expect((error as ThreadError).code).toBe(code);
  }
}

function countRows(
  db: SqliteDatabase,
  table: "handoffs" | "handoff_messages" | "approvals",
): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

describe("handoff thread start", () => {
  it("creates the header and initial request with exact spec bytes", () => {
    const { db, service } = fixture();
    const spec = "line one\nline two\té";
    const result = startThread(service, {
      summary: "exact bytes",
      spec,
      idempotencyKey: "exact-bytes",
    });

    expect(result.status).toBe("queued");
    expect(result.state).toBe("queued");
    expect(result.mode).toBe("thread");
    expect(result.threadId).toBe(result.handoffId);
    expect(result.initialMessage?.seq).toBe(1);
    expect(result.initialMessage?.clientMessageId).toBeTruthy();
    expect(result.initialMessage?.bindingNonce).toBeTruthy();

    const handoff = getHandoff(db, result.handoffId);
    expect(handoff).toBeDefined();
    expect(handoff).toMatchObject({
      mode: "thread",
      messageSeq: 1,
      messageCount: 1,
      lastMessageAt: handoff?.createdAt,
      threadIdleExpiresAt: expect.any(String),
      sourceSessionId: null,
      sourceInvokingSessionId: null,
      dispatchMessageId: null,
      replyMessageId: null,
      replyState: "none",
      replyDeliveredSessionId: null,
      replyDeliveredAt: null,
      policyDispatchMode: "auto",
      policyReplyMode: "auto",
      idempotencyKey: buildThreadIdempotencyKey("p", "p:a", "p:b", "exact-bytes"),
    });
    expect(Date.parse(handoff?.threadIdleExpiresAt ?? "")).toBeGreaterThan(
      Date.parse(handoff?.createdAt ?? ""),
    );

    const messages = listHandoffMessages(db, result.handoffId);
    expect(messages).toHaveLength(1);
    const initial = messages[0];
    expect(initial).toMatchObject({
      seq: 1,
      kind: "request",
      authorSide: "source",
      authorAppId: "p:a",
      state: "binding",
      body: spec,
    });
    expect(Buffer.byteLength(initial?.body ?? "", "utf8")).toBe(Buffer.byteLength(spec, "utf8"));
    expect(initial?.clientMessageId).toBe(result.initialMessage?.clientMessageId);
    expect(initial?.bindingNonce).toBe(result.initialMessage?.bindingNonce);
  });

  it("creates the dispatch approval in the same transaction", () => {
    const { db, service } = fixture();
    const result = startThread(service, {
      idempotencyKey: "approval-in-tx",
      requiresApproval: true,
    });

    expect(result.status).toBe("awaiting_approval");
    expect(result.state).toBe("awaiting_approval");
    const approval = getPendingApproval(db, result.handoffId, "dispatch");
    expect(approval).toBeDefined();
    expect(listHandoffMessages(db, result.handoffId)[0]?.state).toBe("binding");
  });

  it("rolls back the header and initial request when the approval insert fails", () => {
    const { db, service } = fixture();
    const handoffsBefore = countRows(db, "handoffs");
    const messagesBefore = countRows(db, "handoff_messages");
    const signals: NotificationSignal[] = [];
    notificationEvents.subscribe((signal) => signals.push(signal));
    db.exec(
      "CREATE TRIGGER fail_approval_insert BEFORE INSERT ON approvals BEGIN SELECT RAISE(ABORT, 'forced'); END",
    );
    try {
      expect(() =>
        startThread(service, { idempotencyKey: "approval-failure", requiresApproval: true }),
      ).toThrow();
    } finally {
      db.exec("DROP TRIGGER fail_approval_insert");
    }
    expect(countRows(db, "handoffs")).toBe(handoffsBefore);
    expect(countRows(db, "handoff_messages")).toBe(messagesBefore);
    expect(countRows(db, "approvals")).toBe(0);
    expect(signals).toHaveLength(0);
  });

  it("emits handoff_approval after the thread transaction commits", () => {
    const { db, service } = fixture();
    const signals: NotificationSignal[] = [];
    notificationEvents.subscribe((signal) => {
      signals.push(signal);
      if (signal.type === "handoff_approval") {
        expect(getPendingApproval(db, signal.handoffId, "dispatch")?.id).toBe(signal.approvalId);
      }
    });

    const result = startThread(service, {
      idempotencyKey: "emit-thread-approval",
      requiresApproval: true,
    });
    const approval = getPendingApproval(db, result.handoffId, "dispatch");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "handoff_approval",
      handoffId: result.handoffId,
      approvalKind: "dispatch",
      approvalId: approval?.id,
      requestedAt: approval?.requestedAt,
      transitionAt: approval?.requestedAt,
    });
  });

  it("emits handoff_approval after one-shot dispatch and reply approvals commit", () => {
    const { db, service } = fixture();
    const signals: NotificationSignal[] = [];
    notificationEvents.subscribe((signal) => signals.push(signal));

    const dispatch = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "spec",
      requiresApproval: true,
    });
    const dispatchApproval = getPendingApproval(db, dispatch.handoffId, "dispatch");
    expect(signals[0]).toMatchObject({
      type: "handoff_approval",
      handoffId: dispatch.handoffId,
      approvalKind: "dispatch",
      approvalId: dispatchApproval?.id,
    });

    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "auto",
      replyMode: "approve",
    });
    const reply = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "reply approval",
      spec: "spec",
    });
    updateHandoff(db, reply.handoffId, { state: "in_progress" });
    service.deliverHandoff(reply.handoffId, "done", "completed", "b");
    const replyApproval = getPendingApproval(db, reply.handoffId, "reply");
    expect(signals[1]).toMatchObject({
      type: "handoff_approval",
      handoffId: reply.handoffId,
      approvalKind: "reply",
      approvalId: replyApproval?.id,
    });
  });

  it("denies a thread without creating an approval", () => {
    const { db, service } = fixture();
    setHandoffPolicy(db, {
      projectId: "p",
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "deny",
      replyMode: "auto",
    });
    const result = startThread(service, { idempotencyKey: "denied" });

    expect(result.status).toBe("denied");
    expect(result.state).toBe("rejected");
    expect(getPendingApproval(db, result.handoffId, "dispatch")).toBeUndefined();
    const message = listHandoffMessages(db, result.handoffId)[0];
    expect(message).toMatchObject({ state: "cancelled", errorCode: "start_rejected" });
  });

  it("cancels the initial request when the operator rejects the start", () => {
    const { db, service } = fixture();
    const human = createPrincipal(db, { kind: "human", name: "operator" }).principal;
    const result = startThread(service, { idempotencyKey: "reject-start", requiresApproval: true });
    const approval = getPendingApproval(db, result.handoffId, "dispatch");
    expect(approval).toBeDefined();
    decideApproval(db, approval?.id ?? "", human, "rejected", "not now");

    expect(getHandoff(db, result.handoffId)?.state).toBe("rejected");
    expect(listHandoffMessages(db, result.handoffId)[0]).toMatchObject({
      state: "cancelled",
      errorCode: "start_rejected",
    });
  });

  it("approves before binding and moves the header to dispatching", () => {
    const { db, service } = fixture();
    const human = createPrincipal(db, { kind: "human", name: "operator" }).principal;
    const result = startThread(service, {
      idempotencyKey: "approve-start",
      requiresApproval: true,
    });
    const approval = getPendingApproval(db, result.handoffId, "dispatch");
    decideApproval(db, approval?.id ?? "", human, "approved");

    expect(getHandoff(db, result.handoffId)?.state).toBe("dispatching");
    expect(listHandoffMessages(db, result.handoffId)[0]?.state).toBe("binding");
  });

  it("rejects a stale approval decision with approval_stale", () => {
    const { db, service } = fixture();
    const human = createPrincipal(db, { kind: "human", name: "operator" }).principal;
    const result = startThread(service, {
      idempotencyKey: "stale-approval",
      requiresApproval: true,
    });
    const approval = getPendingApproval(db, result.handoffId, "dispatch");
    updateHandoff(db, result.handoffId, { state: "cancelled" });

    expectThreadError(
      () => decideApproval(db, approval?.id ?? "", human, "approved"),
      "approval_stale",
    );
    expect(getPendingApproval(db, result.handoffId, "dispatch")?.id).toBe(approval?.id);
  });

  it("is idempotent on the namespaced key and returns the current state", () => {
    const { db, service } = fixture();
    const first = startThread(service, { idempotencyKey: "same-key" });
    const rowCount = countRows(db, "handoffs");
    const messageCount = countRows(db, "handoff_messages");

    const second = startThread(service, { idempotencyKey: "same-key" });
    expect(second.status).toBe("existing");
    expect(second.handoffId).toBe(first.handoffId);
    expect(second.initialMessage?.id).toBe(first.initialMessage?.id);
    expect(countRows(db, "handoffs")).toBe(rowCount);
    expect(countRows(db, "handoff_messages")).toBe(messageCount);

    openThread(db, first.handoffId);
    expect(startThread(service, { idempotencyKey: "same-key" }).state).toBe("in_progress");
    updateHandoff(db, first.handoffId, { state: "rejected" });
    expect(startThread(service, { idempotencyKey: "same-key" }).state).toBe("rejected");
  });

  it("rejects the same key with different content", () => {
    const { service } = fixture();
    startThread(service, { idempotencyKey: "conflict-key", spec: "one" });
    expectThreadError(
      () => startThread(service, { idempotencyKey: "conflict-key", spec: "two" }),
      "idempotency_conflict",
    );
  });

  it("resolves a legacy raw key only for a matching thread", () => {
    const { db, service } = fixture();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO handoffs
         (id, project_id, from_app_id, to_app_id, state, mode, summary, spec, idempotency_key,
          message_seq, message_count, created_at, updated_at)
       VALUES ('legacy-thread', 'p', 'p:a', 'p:b', 'queued', 'thread', 'thread summary',
               'initial spec', 'legacy', 1, 1, ?, ?)`,
    ).run(now, now);
    insertHandoffMessage(db, {
      handoffId: "legacy-thread",
      seq: 1,
      kind: "request",
      body: "initial spec",
      authorSide: "source",
      authorAppId: "p:a",
      clientMessageId: "legacy-client",
      bindingNonce: "legacy-nonce",
      createdAt: now,
    });

    const matched = startThread(service, { idempotencyKey: "legacy" });
    expect(matched.status).toBe("existing");
    expect(matched.handoffId).toBe("legacy-thread");
    expect(matched.initialMessage?.clientMessageId).toBe("legacy-client");

    const oneShot = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "one shot spec",
      idempotencyKey: "legacy-one-shot",
    });
    const created = startThread(service, { idempotencyKey: "legacy-one-shot" });
    expect(created.status).toBe("queued");
    expect(created.handoffId).not.toBe(oneShot.handoffId);
    expect(getHandoff(db, oneShot.handoffId)?.idempotencyKey).toBe("legacy-one-shot");

    db.prepare(
      `INSERT INTO handoffs
         (id, project_id, from_app_id, to_app_id, state, mode, summary, spec, idempotency_key,
          message_seq, message_count, created_at, updated_at)
       VALUES ('legacy-wrong-pair', 'p', 'p:c', 'p:b', 'queued', 'thread', 'thread summary',
               'initial spec', 'legacy-pair', 1, 1, ?, ?)`,
    ).run(now, now);
    const mismatched = startThread(service, { idempotencyKey: "legacy-pair" });
    expect(mismatched.status).toBe("queued");
    expect(mismatched.handoffId).not.toBe("legacy-wrong-pair");
  });

  it("keeps one-shot output and stored keys unchanged", () => {
    const { db, service } = fixture();
    const result = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "one shot spec",
      idempotencyKey: "plain-key",
    });
    expect(Object.keys(result).sort()).toEqual(["handoffId", "state", "status"]);
    const handoff = getHandoff(db, result.handoffId);
    expect(handoff).toMatchObject({
      mode: "one_shot",
      messageSeq: 0,
      messageCount: 0,
      idempotencyKey: "plain-key",
    });
  });
});

describe("handoff thread cross-project idempotency", () => {
  const crossBase = {
    projectId: "p",
    targetProjectId: "q",
    fromAppId: "p:a",
    toAppId: "q:b",
    summary: "cross summary",
    spec: "cross spec",
    policyDispatchMode: "auto" as const,
    policyReplyMode: "auto" as const,
  };

  it("keeps a same-project retry existing when targetProjectId is omitted or equal", () => {
    const { db, service } = fixture();
    const first = startThread(service, { idempotencyKey: "same-project-omitted" });
    const retry = startThread(service, { idempotencyKey: "same-project-omitted" });
    expect(retry.status).toBe("existing");
    expect(retry.handoffId).toBe(first.handoffId);
    expect(retry.initialMessage?.id).toBe(first.initialMessage?.id);

    const equalInput = {
      projectId: "p",
      targetProjectId: "p",
      fromAppId: "p:a",
      toAppId: "p:b",
      summary: "thread summary",
      spec: "initial spec",
      idempotencyKey: "same-project-equal",
      policyDispatchMode: "auto" as const,
      policyReplyMode: "auto" as const,
    };
    const equal = createThread(db, equalInput);
    const equalRetry = createThread(db, equalInput);
    expect(equalRetry.status).toBe("existing");
    expect(equalRetry.handoff.id).toBe(equal.handoff.id);
    expect(equalRetry.initialMessage.id).toBe(equal.initialMessage.id);
    expect(equal.handoff.targetProjectId).toBe("p");
    db.close();
  });

  it("uses a v2 key for a cross-project thread and a v1 key for same-project", () => {
    expect(buildThreadIdempotencyKey("p", "p:a", "p:b", "k")).toBe("v1|p|p:a|p:b|thread|k");
    expect(buildThreadIdempotencyKey("p", "p:a", "p:b", "k", "p")).toBe("v1|p|p:a|p:b|thread|k");
    expect(buildThreadIdempotencyKey("p", "p:a", "q:b", "k", "q")).toBe("v2|p|p:a|q|q:b|thread|k");

    const { db } = fixture();
    const cross = createThread(db, { ...crossBase, idempotencyKey: "v2-key" });
    expect(getHandoff(db, cross.handoff.id)?.idempotencyKey).toBe("v2|p|p:a|q|q:b|thread|v2-key");
    expect(cross.handoff.targetProjectId).toBe("q");
    expect(cross.handoff.grantId).toBeNull();

    const same = createThread(db, {
      projectId: "p",
      fromAppId: "p:a",
      toAppId: "p:b",
      summary: "thread summary",
      spec: "initial spec",
      idempotencyKey: "v1-key",
      policyDispatchMode: "auto",
      policyReplyMode: "auto",
    });
    expect(getHandoff(db, same.handoff.id)?.idempotencyKey).toBe("v1|p|p:a|p:b|thread|v1-key");
    expect(same.handoff.targetProjectId).toBe("p");
    db.close();
  });

  it("does not resolve a cross-project thread from a legacy raw key", () => {
    const { db } = fixture();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO handoffs
         (id, project_id, target_project_id, from_app_id, to_app_id, state, mode, summary, spec,
          idempotency_key, message_seq, message_count, created_at, updated_at)
       VALUES ('legacy-cross', 'p', 'q', 'p:a', 'q:b', 'queued', 'thread', 'cross summary',
               'cross spec', 'cross-legacy', 1, 1, ?, ?)`,
    ).run(now, now);
    insertHandoffMessage(db, {
      handoffId: "legacy-cross",
      seq: 1,
      kind: "request",
      body: "cross spec",
      authorSide: "source",
      authorAppId: "p:a",
      clientMessageId: "legacy-cross-client",
      bindingNonce: "legacy-cross-nonce",
      createdAt: now,
    });

    const created = createThread(db, { ...crossBase, idempotencyKey: "cross-legacy" });
    expect(created.status).toBe("queued");
    expect(created.handoff.id).not.toBe("legacy-cross");
    expect(created.handoff.idempotencyKey).toBe("v2|p|p:a|q|q:b|thread|cross-legacy");
    db.close();
  });

  it("rejects the same key with different content across projects", () => {
    const { db } = fixture();
    createThread(db, { ...crossBase, idempotencyKey: "cross-conflict", spec: "one" });
    expectThreadError(
      () => createThread(db, { ...crossBase, idempotencyKey: "cross-conflict", spec: "two" }),
      "idempotency_conflict",
    );
    db.close();
  });
});

describe("handoff thread quotas and attempts", () => {
  function attemptRows(db: SqliteDatabase): Array<{ scope: string; payload: string }> {
    return db
      .prepare(
        "SELECT scope, payload FROM events WHERE type = 'handoff.thread.attempt' ORDER BY id",
      )
      .all() as Array<{ scope: string; payload: string }>;
  }

  it("records count-only attempt events for thread mutations only", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "attempt-events" });
    openThread(db, thread.handoffId);
    const followUp = service.sendThreadMessage(thread.handoffId, "follow up", undefined, "a");
    const initial = listHandoffMessages(db, thread.handoffId)[0];
    makeSourceDispatching(db, initial?.id ?? 0);
    service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {
      replyTo: initial?.id,
    });
    service.handoffStatus(thread.handoffId, "a");
    service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "spec",
    });

    const rows = attemptRows(db);
    expect(rows.map((row) => row.scope)).toEqual(["p:a", "p:a", "p:b"]);
    expect(rows.map((row) => JSON.parse(row.payload))).toEqual([
      { appId: "p:a", tool: "request_sibling_change", outcome: "ok" },
      { appId: "p:a", tool: "send_handoff_message", outcome: "ok" },
      { appId: "p:b", tool: "deliver_handoff", outcome: "ok" },
    ]);
    expect(followUp.message.seq).toBe(2);
  });

  it("rejects a second active thread by source quota without a partial row", () => {
    const { db } = fixture();
    const service = new CoordinatorService(db, "p", {
      ...DEFAULT_THREAD_LIMITS,
      maxActivePerSourceApp: 1,
    });
    startThread(service, { idempotencyKey: "source-quota-1" });
    const before = countRows(db, "handoffs");
    expectThreadError(
      () => startThread(service, { idempotencyKey: "source-quota-2" }),
      "thread_quota",
    );
    expect(countRows(db, "handoffs")).toBe(before);
    expect(countRows(db, "handoff_messages")).toBe(1);
  });

  it("rejects a second pending target start by target quota", () => {
    const { db } = fixture();
    const service = new CoordinatorService(db, "p", {
      ...DEFAULT_THREAD_LIMITS,
      maxPendingPerTargetApp: 1,
    });
    startThread(service, { idempotencyKey: "target-quota-1" });
    const before = countRows(db, "handoffs");
    expectThreadError(
      () => startThread(service, { idempotencyKey: "target-quota-2" }),
      "thread_quota",
    );
    expect(countRows(db, "handoffs")).toBe(before);
  });

  it("enforces the per-app start rate and records the rejection", () => {
    const { db } = fixture();
    const service = new CoordinatorService(db, "p", {
      ...DEFAULT_THREAD_LIMITS,
      rateLimitPerApp: 1,
    });
    startThread(service, { idempotencyKey: "rate-1" });
    expectThreadError(() => startThread(service, { idempotencyKey: "rate-2" }), "rate_limited");
    expect(countRows(db, "handoffs")).toBe(1);
    expect(attemptRows(db).map((row) => JSON.parse(row.payload))).toEqual([
      { appId: "p:a", tool: "request_sibling_change", outcome: "ok" },
      { appId: "p:a", tool: "request_sibling_change", outcome: "failure" },
    ]);
  });

  it("enforces quotas across two connections to the same database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-ht-two-"));
    dirs.push(dir);
    const file = path.join(dir, "coordinator.db");
    const db1 = openDatabase(file);
    runMigrations(db1);
    const now = new Date().toISOString();
    db1
      .prepare(
        "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/x',?,?)",
      )
      .run(now, now);
    for (const key of ["a", "b"]) {
      db1
        .prepare(
          "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
        )
        .run(`p:${key}`, key, `apps/${key}`, now);
    }
    const db2 = openDatabase(file);
    const limits = { ...DEFAULT_THREAD_LIMITS, maxActivePerSourceApp: 1 };
    const first = new CoordinatorService(db1, "p", limits);
    const second = new CoordinatorService(db2, "p", limits);
    startThread(first, { idempotencyKey: "two-connection-1" });
    expectThreadError(
      () => startThread(second, { idempotencyKey: "two-connection-2" }),
      "thread_quota",
    );
    db1.close();
    db2.close();
  });

  it("counts a cross-project denial toward the security failure limit", () => {
    const { db } = fixture();
    const limits = {
      ...DEFAULT_THREAD_LIMITS,
      rateLimitPerApp: 100,
      securityFailuresPerApp: 1,
    };
    const service = new CoordinatorService(db, "p", limits);
    expect(() =>
      service.requestSiblingChange({
        fromAppKey: "a",
        toAppKey: "b",
        summary: "denied",
        spec: "spec",
        toProjectId: "q",
      }),
    ).toThrow(/cross_project_denied/);
    const denied = db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE scope = 'p:a' AND type = 'handoff.cross_project.denied'",
      )
      .get() as { count: number };
    expect(denied.count).toBe(1);

    expectThreadError(
      () => startThread(service, { idempotencyKey: "after-denial" }),
      "rate_limited",
    );
    expect(countRows(db, "handoffs")).toBe(0);
  });

  it("blocks after the failure limit and stays blocked across a new service", () => {
    const { db } = fixture();
    const limits = {
      ...DEFAULT_THREAD_LIMITS,
      rateLimitPerApp: 100,
      securityFailuresPerApp: 1,
    };
    const service = new CoordinatorService(db, "p", limits);
    expectThreadError(
      () =>
        startThread(service, {
          idempotencyKey: "failure-1",
          spec: "bad\u0000spec",
        }),
      "spec_too_large",
    );
    const restarted = new CoordinatorService(db, "p", limits);
    expectThreadError(
      () => startThread(restarted, { idempotencyKey: "failure-2" }),
      "rate_limited",
    );
    expect(countRows(db, "handoffs")).toBe(0);
  });
});

describe("handoff thread append", () => {
  it("appends messages with monotonic seq and counters", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "append-monotonic" });
    openThread(db, thread.handoffId);

    const first = service.sendThreadMessage(thread.handoffId, "follow\nup", undefined, "a");
    expect(first.message).toMatchObject({ seq: 2, state: "binding" });
    expect(first.message.clientMessageId).toBeTruthy();
    expect(first.handoff.messageCount).toBe(2);

    const second = service.sendThreadMessage(thread.handoffId, "third", "client-3", "a");
    expect(second.message).toMatchObject({ seq: 3, state: "binding" });
    expect(second.handoff.messageCount).toBe(3);

    const messages = listHandoffMessages(db, thread.handoffId);
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(messages[1]?.body).toBe("follow\nup");
    expect(messages[1]?.kind).toBe("message");
    expect(messages[1]?.authorSide).toBe("source");
    expect(messages[1]?.authorAppId).toBe("p:a");
    expect(messages[2]?.clientMessageId).toBe("client-3");
  });

  it("sets the destination delivery session from the open thread roots", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "append-destination" });
    openThread(db, thread.handoffId);
    const followUp = service.sendThreadMessage(thread.handoffId, "follow up", undefined, "a");
    expect(getHandoffMessage(db, followUp.message.id)?.deliverySessionId).toBe("ses-target");

    const initial = listHandoffMessages(db, thread.handoffId)[0];
    makeSourceDispatching(db, initial?.id ?? 0);
    service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {
      replyTo: initial?.id,
    });
    const reply = listHandoffMessages(db, thread.handoffId).find(
      (message) => message.kind === "reply",
    );
    expect(reply?.deliverySessionId).toBe("ses-source");

    const missingTarget = startThread(service, { idempotencyKey: "append-no-target" });
    openThread(db, missingTarget.handoffId, { targetSessionId: null });
    expectThreadError(
      () => service.sendThreadMessage(missingTarget.handoffId, "body", undefined, "a"),
      "thread_not_started",
    );

    const missingSource = startThread(service, { idempotencyKey: "reply-no-source" });
    openThread(db, missingSource.handoffId, { sourceSessionId: null });
    const missingInitial = listHandoffMessages(db, missingSource.handoffId)[0];
    makeSourceDispatching(db, missingInitial?.id ?? 0);
    expectThreadError(
      () =>
        service.deliverHandoff(missingSource.handoffId, "reply", "completed", "b", {
          replyTo: missingInitial?.id,
        }),
      "thread_not_started",
    );
  });

  it("returns an existing append for the same client id and content", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "append-idempotent" });
    openThread(db, thread.handoffId);
    const first = service.sendThreadMessage(thread.handoffId, "same body", undefined, "a");
    const messageCount = countRows(db, "handoff_messages");
    const header = getHandoff(db, thread.handoffId);

    const retry = service.sendThreadMessage(
      thread.handoffId,
      "same body",
      first.message.clientMessageId,
      "a",
    );
    expect(retry.message.id).toBe(first.message.id);
    expect(countRows(db, "handoff_messages")).toBe(messageCount);
    expect(getHandoff(db, thread.handoffId)?.messageCount).toBe(header?.messageCount);
    expectThreadError(
      () =>
        service.sendThreadMessage(
          thread.handoffId,
          "different",
          first.message.clientMessageId,
          "a",
        ),
      "idempotency_conflict",
    );
  });

  it("applies the mode, state, full, side, and body errors", () => {
    const { db, service } = fixture();
    const oneShot = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "spec",
    });
    expectThreadError(
      () => service.sendThreadMessage(oneShot.handoffId, "body", undefined, "a"),
      "not_a_thread",
    );

    const queued = startThread(service, { idempotencyKey: "append-state" });
    expectThreadError(
      () => service.sendThreadMessage(queued.handoffId, "body", undefined, "a"),
      "thread_not_started",
    );
    openThread(db, queued.handoffId);
    const beforeWrongSide = countRows(db, "handoff_messages");
    expectThreadError(
      () => service.sendThreadMessage(queued.handoffId, "body", undefined, "b"),
      "wrong_side",
    );
    expect(countRows(db, "handoff_messages")).toBe(beforeWrongSide);
    expectThreadError(
      () => service.sendThreadMessage(queued.handoffId, "body", undefined, "missing"),
      "wrong_app",
    );
    expect(countRows(db, "handoff_messages")).toBe(beforeWrongSide);
    expectThreadError(
      () => service.sendThreadMessage(queued.handoffId, "   ", undefined, "a"),
      "invalid_body",
    );
    expectThreadError(
      () => service.sendThreadMessage(queued.handoffId, "a\u0000b", undefined, "a"),
      "invalid_body",
    );
    expectThreadError(
      () => service.sendThreadMessage(queued.handoffId, "x".repeat(32769), undefined, "a"),
      "body_too_large",
    );
    expect(
      service.sendThreadMessage(queued.handoffId, "x".repeat(32768), undefined, "a").message.seq,
    ).toBe(2);
  });

  it("rejects the 33rd message without allocating a seq or count", () => {
    const { db } = fixture();
    const service = new CoordinatorService(db, "p", {
      ...DEFAULT_THREAD_LIMITS,
      rateLimitPerApp: 100,
    });
    const thread = startThread(service, { idempotencyKey: "append-full" });
    openThread(db, thread.handoffId);
    for (let index = 0; index < 31; index += 1) {
      service.sendThreadMessage(thread.handoffId, `message ${index}`, undefined, "a");
    }
    const header = getHandoff(db, thread.handoffId);
    const messageCount = countRows(db, "handoff_messages");
    expect(header?.messageCount).toBe(32);
    expect(header?.messageSeq).toBe(32);

    expectThreadError(
      () => service.sendThreadMessage(thread.handoffId, "one too many", undefined, "a"),
      "thread_full",
    );
    expect(getHandoff(db, thread.handoffId)?.messageCount).toBe(32);
    expect(getHandoff(db, thread.handoffId)?.messageSeq).toBe(32);
    expect(getHandoff(db, thread.handoffId)?.state).toBe("in_progress");
    expect(countRows(db, "handoff_messages")).toBe(messageCount);
  });
});

describe("handoff thread replies", () => {
  it("requires a positive reply_to", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "reply-required" });
    openThread(db, thread.handoffId);

    expectThreadError(
      () => service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {}),
      "reply_to_required",
    );
    expectThreadError(
      () => service.deliverHandoff(thread.handoffId, "reply", "completed", "b", { replyTo: 0 }),
      "invalid_reply_to",
    );
    expectThreadError(
      () => service.deliverHandoff(thread.handoffId, "reply", "completed", "b", { replyTo: 1.5 }),
      "invalid_reply_to",
    );
  });

  it("accepts dispatching and delivered source parents", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "reply-parents" });
    openThread(db, thread.handoffId);
    const initial = listHandoffMessages(db, thread.handoffId)[0];
    expect(initial).toBeDefined();
    makeSourceDispatching(db, initial?.id ?? 0);

    const dispatchingParent = service.deliverHandoff(
      thread.handoffId,
      "first reply",
      "completed",
      "b",
      { replyTo: initial?.id },
    );
    expect("message" in dispatchingParent).toBe(true);
    if ("message" in dispatchingParent) {
      expect(dispatchingParent.message).toMatchObject({ seq: 2, state: "binding" });
      expect(dispatchingParent.replyTo).toEqual({ id: initial?.id, seq: 1 });
    }

    const followUp = service.sendThreadMessage(thread.handoffId, "second request", undefined, "a");
    makeSourceDelivered(db, followUp.message.id);
    const deliveredParent = service.deliverHandoff(
      thread.handoffId,
      "second reply",
      "blocked",
      "b",
      { replyTo: followUp.message.id },
    );
    expect("message" in deliveredParent).toBe(true);
    if ("message" in deliveredParent) {
      expect(deliveredParent.message.seq).toBe(4);
    }
    const replies = listHandoffMessages(db, thread.handoffId).filter(
      (message) => message.kind === "reply",
    );
    expect(replies).toHaveLength(2);
    expect(replies[0]).toMatchObject({
      authorSide: "target",
      authorAppId: "p:b",
      outcome: "completed",
    });
    expect(replies[1]?.outcome).toBe("blocked");
  });

  it("rejects non-eligible parents and cross-thread or target-authored parents", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "reply-bad-parents" });
    openThread(db, thread.handoffId);
    const now = new Date().toISOString();
    let seq = 100;
    const insertParent = (
      state: "binding" | "queued" | "waiting_operator" | "cancelled",
      authorSide: "source" | "target" = "source",
      kind: "request" | "message" | "reply" = "message",
    ) => {
      seq += 1;
      return insertHandoffMessage(db, {
        handoffId: thread.handoffId,
        seq,
        kind,
        body: "parent",
        authorSide,
        authorAppId: authorSide === "target" ? "p:b" : "p:a",
        state,
        createdAt: now,
      });
    };

    for (const state of ["binding", "queued", "waiting_operator", "cancelled"] as const) {
      const parent = insertParent(state);
      expectThreadError(
        () =>
          service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {
            replyTo: parent.id,
          }),
        "invalid_reply_to",
      );
    }
    const targetParent = insertParent("binding", "target", "reply");
    expectThreadError(
      () =>
        service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {
          replyTo: targetParent.id,
        }),
      "invalid_reply_to",
    );

    const other = startThread(service, { idempotencyKey: "reply-other-thread" });
    const otherInitial = listHandoffMessages(db, other.handoffId)[0];
    makeSourceDispatching(db, otherInitial?.id ?? 0);
    expectThreadError(
      () =>
        service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {
          replyTo: otherInitial?.id,
        }),
      "invalid_reply_to",
    );
  });

  it("returns one reply per source and frees a cancelled slot", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "reply-once" });
    openThread(db, thread.handoffId);
    const initial = listHandoffMessages(db, thread.handoffId)[0];
    makeSourceDispatching(db, initial?.id ?? 0);

    const first = service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {
      replyTo: initial?.id,
    });
    expect("message" in first).toBe(true);
    if (!("message" in first)) return;
    const messageCount = countRows(db, "handoff_messages");
    const headerCount = getHandoff(db, thread.handoffId)?.messageCount;

    const retry = service.deliverHandoff(thread.handoffId, "reply", "completed", "b", {
      replyTo: initial?.id,
      clientMessageId: "new-client-id",
    });
    expect("message" in retry).toBe(true);
    if ("message" in retry) {
      expect(retry.message.id).toBe(first.message.id);
    }
    expect(countRows(db, "handoff_messages")).toBe(messageCount);
    expect(getHandoff(db, thread.handoffId)?.messageCount).toBe(headerCount);

    transitionHandoffMessage(db, first.message.id, "cancelled");
    const replacement = service.deliverHandoff(thread.handoffId, "replacement", "blocked", "b", {
      replyTo: initial?.id,
    });
    expect("message" in replacement).toBe(true);
    if ("message" in replacement) {
      expect(replacement.message.id).not.toBe(first.message.id);
      expect(replacement.message.seq).toBe(3);
    }
  });

  it("rejects a source-side reply before insert", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "reply-wrong-side" });
    openThread(db, thread.handoffId);
    const initial = listHandoffMessages(db, thread.handoffId)[0];
    makeSourceDispatching(db, initial?.id ?? 0);
    const before = countRows(db, "handoff_messages");
    expectThreadError(
      () =>
        service.deliverHandoff(thread.handoffId, "reply", "completed", "a", {
          replyTo: initial?.id,
        }),
      "wrong_side",
    );
    expect(countRows(db, "handoff_messages")).toBe(before);
  });
});

describe("handoff thread operator cancel", () => {
  it("cancels the header, non-terminal messages, and pending approval atomically", () => {
    const { db, service } = fixture();
    const human = createPrincipal(db, { kind: "human", name: "operator" }).principal;
    const thread = startThread(service, {
      idempotencyKey: "operator-cancel",
      requiresApproval: true,
    });
    const approval = getPendingApproval(db, thread.handoffId, "dispatch");
    expect(approval).toBeDefined();

    const cancelled = service.cancelThread(thread.handoffId, human);
    expect(cancelled.state).toBe("cancelled");
    expect(getPendingApproval(db, thread.handoffId, "dispatch")).toBeUndefined();
    expect(listHandoffMessages(db, thread.handoffId)[0]).toMatchObject({
      state: "cancelled",
      errorCode: "operator_cancel",
    });

    const agent = createPrincipal(db, { kind: "agent", name: "a" }).principal;
    expect(() => service.cancelThread(thread.handoffId, agent)).toThrow(/human/i);
  });

  it("cancels a dispatching message without aborting the transport", () => {
    const { db, service } = fixture();
    const human = createPrincipal(db, { kind: "human", name: "operator" }).principal;
    const thread = startThread(service, { idempotencyKey: "soft-cancel" });
    openThread(db, thread.handoffId);
    const followUp = service.sendThreadMessage(thread.handoffId, "in flight", undefined, "a");
    db.prepare(
      "UPDATE handoff_messages SET state = 'dispatching', delivery_session_id = 'ses-target', claimed_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), followUp.message.id);

    service.cancelThread(thread.handoffId, human);
    expect(getHandoff(db, thread.handoffId)?.state).toBe("cancelled");
    expect(getHandoffMessage(db, followUp.message.id)).toMatchObject({
      state: "cancelled",
      errorCode: "operator_cancel",
    });
  });
});

describe("handoff status projection", () => {
  it("exposes only the thread fields to an agent caller", () => {
    const { service } = fixture();
    const thread = startThread(service, { idempotencyKey: "status-thread" });
    const status = service.handoffStatus(thread.handoffId, "a");
    expect(status).toBeDefined();
    expect(Object.keys(status ?? {}).sort()).toEqual(
      [
        "createdAt",
        "id",
        "lastMessageAt",
        "messageCount",
        "mode",
        "state",
        "threadIdleExpiresAt",
        "updatedAt",
      ].sort(),
    );
    expect(status).not.toHaveProperty("spec");
    expect(status).not.toHaveProperty("result");
    expect(status).not.toHaveProperty("operatorNote");
    expect(status).not.toHaveProperty("sourceSessionId");
    expect(service.handoffStatus(thread.handoffId, "c")).toBeUndefined();
    expect(service.handoffStatus(thread.handoffId)).toHaveProperty("spec", "initial spec");
  });

  it("exposes exactly the legacy one-shot key set to an agent caller", () => {
    const { service } = fixture();
    const oneShot = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "one shot",
      spec: "one shot spec",
    });
    const expected = [
      "id",
      "projectId",
      "fromAppId",
      "toAppId",
      "state",
      "summary",
      "spec",
      "idempotencyKey",
      "attempts",
      "nextAttemptAt",
      "expiresAt",
      "targetTaskId",
      "result",
      "error",
      "outcome",
      "origin",
      "sourceSessionId",
      "sourceSessionTitle",
      "sourceSessionDeletedAt",
      "targetSessionId",
      "targetSessionTitle",
      "replyState",
      "replyMessageId",
      "replyDeliveredSessionId",
      "replyDeliveredAt",
      "replyError",
      "replyAttempts",
      "dispatchMessageId",
      "dispatchStartedAt",
      "deadlineAt",
      "operatorNote",
      "deliveredVia",
      "parentHandoffId",
      "rootHandoffId",
      "depth",
      "policyDispatchMode",
      "policyReplyMode",
      "createdAt",
      "updatedAt",
    ];
    const status = service.handoffStatus(oneShot.handoffId, "a");
    expect(Object.keys(status ?? {}).sort()).toEqual(expected.sort());
    for (const key of [
      "mode",
      "messageSeq",
      "messageCount",
      "lastMessageAt",
      "threadIdleExpiresAt",
      "sourceInvokingSessionId",
    ]) {
      expect(status).not.toHaveProperty(key);
    }
  });

  it("leaves one-shot routing columns null for thread messages", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "status-routing" });
    openThread(db, thread.handoffId);
    const initial = listHandoffMessages(db, thread.handoffId)[0];
    makeSourceDispatching(db, initial?.id ?? 0);
    service.sendThreadMessage(thread.handoffId, "follow up", undefined, "a");
    service.deliverHandoff(thread.handoffId, "reply", "completed", "b", { replyTo: initial?.id });

    const handoff = getHandoff(db, thread.handoffId);
    expect(handoff).toMatchObject({
      dispatchMessageId: null,
      replyMessageId: null,
      replyState: "none",
      replyDeliveredSessionId: null,
      replyDeliveredAt: null,
    });
    const messages = [{ info: { id: "msg-thread", role: "user" } }];
    projectHandoffMessages(db, "ses-target", messages);
    expect(messages[0]?.info).not.toHaveProperty("hanse");
  });
});

describe("appendThreadReply CAS", () => {
  it("keeps the message transition table and reply identity intact", () => {
    const { db, service } = fixture();
    const thread = startThread(service, { idempotencyKey: "reply-cas" });
    openThread(db, thread.handoffId);
    const initial = listHandoffMessages(db, thread.handoffId)[0];
    makeSourceDispatching(db, initial?.id ?? 0);

    const reply = appendThreadReply(db, {
      handoffId: thread.handoffId,
      body: "reply",
      outcome: "completed",
      replyTo: initial?.id,
      callerAppId: "p:b",
    });
    expect(getHandoffMessage(db, reply.message.id)?.replyToMessageId).toBe(initial?.id);
    const cancelled = transitionHandoffMessage(db, reply.message.id, "cancelled");
    expect(cancelled.state).toBe("cancelled");
  });
});
