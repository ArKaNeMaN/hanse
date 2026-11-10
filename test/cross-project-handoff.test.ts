import { beforeEach, describe, expect, it } from "vitest";
import {
  deleteHandoffGrant,
  HandoffGrantError,
  type HandoffGrantErrorCode,
  setHandoffGrant,
} from "../src/coordinator/grants.js";
import { getHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import { CoordinatorService, type RequestSiblingChangeInput } from "../src/coordinator/service.js";
import { listHandoffMessages, transitionHandoffMessage } from "../src/coordinator/thread.js";
import { MASTER_PROJECT_ID } from "../src/master/constants.js";
import { handleRpc } from "../src/mcp/protocol.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const now = "2026-11-10T00:00:00.000Z";

function insertProject(db: SqliteDatabase, id: string, name: string, deleting = 0): void {
  db.prepare(
    `INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at, deleting)
     VALUES (?, ?, 'main', ?, ?, ?, ?)`,
  ).run(id, name, `/tmp/${id}`, now, now, deleting);
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
  insertProject(db, "p", "P");
  insertProject(db, "q", "Q");
  insertProject(db, "r", "R", 1);
  insertProject(db, MASTER_PROJECT_ID, "Master");
  for (const key of ["a", "b"]) {
    insertApp(db, "p", key);
  }
  for (const key of ["a", "b", "c"]) {
    insertApp(db, "q", key);
  }
  insertApp(db, "q", "dead", 1);
  insertApp(db, "r", "a");
  insertApp(db, MASTER_PROJECT_ID, "master");
  return db;
}

function eventsOfType(
  db: SqliteDatabase,
  type: string,
): Array<{ scope: string; payload: Record<string, unknown> }> {
  const rows = db
    .prepare("SELECT scope, payload FROM events WHERE type = ? ORDER BY id")
    .all(type) as Array<{ scope: string; payload: string }>;
  return rows.map((row) => ({ scope: row.scope, payload: JSON.parse(row.payload) }));
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

function toolText(response: ReturnType<typeof handleRpc>): unknown {
  const result = (response as { result: { content: { text: string }[] } }).result;
  return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("cross-project handoffs", () => {
  let db: SqliteDatabase;
  let service: CoordinatorService;

  beforeEach(() => {
    db = makeDb();
    service = new CoordinatorService(db, "p");
  });

  it("keeps the same-project path unchanged when to_project is omitted", () => {
    const first = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "same",
      spec: "same spec",
      idempotencyKey: "same-key",
    });
    expect(first.status).toBe("queued");
    const handoff = getHandoff(db, first.handoffId);
    expect(handoff).toMatchObject({
      projectId: "p",
      targetProjectId: "p",
      grantId: null,
      fromAppId: "p:a",
      toAppId: "p:b",
      idempotencyKey: "same-key",
      policyDispatchMode: "auto",
      policyReplyMode: "auto",
    });

    const retry = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "same",
      spec: "same spec",
      idempotencyKey: "same-key",
    });
    expect(retry.status).toBe(first.status);
    expect(retry.handoffId).toBe(first.handoffId);
    expect(eventsOfType(db, "handoff.cross_project.created")).toEqual([]);
  });

  it("keeps a same-project thread retry existing and never conflicts (B1)", () => {
    const input = {
      fromAppKey: "a",
      toAppKey: "b",
      summary: "thread",
      spec: "thread spec",
      mode: "thread" as const,
      idempotencyKey: "same-thread",
    };
    const first = service.requestSiblingChange(input);
    expect(first.status).toBe("queued");
    const retry = service.requestSiblingChange(input);
    expect(retry.status).toBe("existing");
    expect(retry.handoffId).toBe(first.handoffId);
    expect(retry.initialMessage?.id).toBe(first.initialMessage?.id);
    const handoff = getHandoff(db, first.handoffId);
    expect(handoff?.targetProjectId).toBe("p");
    expect(handoff?.idempotencyKey).toBe("v1|p|p:a|p:b|thread|same-thread");
  });

  it("allows the same bare key in two projects when granted (M1)", () => {
    const grant = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "a",
    });
    const result = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "a",
      summary: "cross same key",
      spec: "spec",
      toProjectId: "q",
      idempotencyKey: "same-bare-key",
    });
    expect(result.status).toBe("queued");
    const handoff = getHandoff(db, result.handoffId);
    expect(handoff).toMatchObject({
      projectId: "p",
      targetProjectId: "q",
      grantId: grant.id,
      fromAppId: "p:a",
      toAppId: "q:a",
    });
  });

  it("still rejects a same-project same-app handoff", () => {
    expect(() =>
      service.requestSiblingChange({
        fromAppKey: "a",
        toAppKey: "a",
        summary: "same app",
        spec: "spec",
      }),
    ).toThrow(/different application/);
  });

  it("returns cross_project_denied for an existing and a missing target key before a grant (M3)", () => {
    expectGrantError(
      () =>
        service.requestSiblingChange({
          fromAppKey: "a",
          toAppKey: "b",
          summary: "denied existing",
          spec: "spec",
          toProjectId: "q",
        }),
      "cross_project_denied",
    );
    expectGrantError(
      () =>
        service.requestSiblingChange({
          fromAppKey: "a",
          toAppKey: "missing",
          summary: "denied missing",
          spec: "spec",
          toProjectId: "q",
        }),
      "cross_project_denied",
    );
    const count = db.prepare("SELECT count(*) AS n FROM handoffs").get() as { n: number };
    expect(count.n).toBe(0);
    const denied = eventsOfType(db, "handoff.cross_project.denied");
    expect(denied).toEqual([
      {
        scope: "p:a",
        payload: { projectId: "p", targetProjectId: "q", fromAppKey: "a", toAppKey: "b" },
      },
    ]);
  });

  it("rejects the master target with builtin_target_forbidden (M2)", () => {
    try {
      service.requestSiblingChange({
        fromAppKey: "a",
        toAppKey: "master",
        summary: "master",
        spec: "spec",
        toProjectId: MASTER_PROJECT_ID,
      });
      throw new Error("expected builtin_target_forbidden");
    } catch (error) {
      expect(error).toBeInstanceOf(HandoffGrantError);
      expect((error as Error).message).toBe(
        "builtin_target_forbidden: the master project cannot be a handoff target",
      );
    }
  });

  it("rejects a deleting target project/app with deleting_target_forbidden", () => {
    expectGrantError(
      () =>
        service.requestSiblingChange({
          fromAppKey: "a",
          toAppKey: "a",
          summary: "deleting project",
          spec: "spec",
          toProjectId: "r",
        }),
      "deleting_target_forbidden",
    );

    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "*",
    });
    expectGrantError(
      () =>
        service.requestSiblingChange({
          fromAppKey: "a",
          toAppKey: "dead",
          summary: "deleting app",
          spec: "spec",
          toProjectId: "q",
        }),
      "deleting_target_forbidden",
    );
  });

  it('treats to_project "" as invalid_target_project (m8)', () => {
    expectGrantError(
      () =>
        service.requestSiblingChange({
          fromAppKey: "a",
          toAppKey: "b",
          summary: "empty target project",
          spec: "spec",
          toProjectId: "",
        }),
      "invalid_target_project",
    );
  });

  it("rejects a malformed to_project passed directly to the service as a defensive check (m1)", () => {
    for (const malformed of [null, 42, {}]) {
      const input = {
        fromAppKey: "a",
        toAppKey: "b",
        summary: "malformed",
        spec: "spec",
        toProjectId: malformed,
      } as unknown as RequestSiblingChangeInput;
      expectGrantError(() => service.requestSiblingChange(input), "invalid_target_project");
    }
  });

  it("resolves the target app inside the target project, not a local app with the same key", () => {
    const grant = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
    });
    const result = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "target scoped",
      spec: "spec",
      toProjectId: "q",
    });
    const handoff = getHandoff(db, result.handoffId);
    expect(handoff?.toAppId).toBe("q:b");
    expect(handoff?.grantId).toBe(grant.id);
  });

  it("snapshots target_project_id, grant_id, and the resolved modes", () => {
    const grant = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
      dispatchMode: "approve",
      replyMode: "approve",
    });
    const result = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "snapshot",
      spec: "spec",
      toProjectId: "q",
    });
    expect(result.status).toBe("awaiting_approval");
    const handoff = getHandoff(db, result.handoffId);
    expect(handoff).toMatchObject({
      targetProjectId: "q",
      grantId: grant.id,
      policyDispatchMode: "approve",
      policyReplyMode: "approve",
    });
  });

  it("maps grant approve and requires_approval to approval, and never produces deny", () => {
    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
      dispatchMode: "auto",
      replyMode: "auto",
    });
    const raised = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "raised",
      spec: "spec",
      toProjectId: "q",
      requiresApproval: true,
      idempotencyKey: "raised-key",
    });
    expect(raised.status).toBe("awaiting_approval");
    expect(getHandoff(db, raised.handoffId)?.policyDispatchMode).toBe("approve");
    expect(getHandoff(db, raised.handoffId)?.policyReplyMode).toBe("auto");

    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
      dispatchMode: "approve",
      replyMode: "auto",
    });
    const approved = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "approved",
      spec: "spec",
      toProjectId: "q",
      idempotencyKey: "approved-key",
    });
    expect(approved.status).toBe("awaiting_approval");
    expect(getHandoff(db, approved.handoffId)?.policyDispatchMode).toBe("approve");

    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
      dispatchMode: "auto",
      replyMode: "approve",
    });
    const replyApprove = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "reply approve",
      spec: "spec",
      toProjectId: "q",
      idempotencyKey: "reply-approve-key",
    });
    expect(replyApprove.status).toBe("queued");
    expect(getHandoff(db, replyApprove.handoffId)?.policyReplyMode).toBe("approve");
    expect([raised.status, approved.status, replyApprove.status]).not.toContain("denied");
  });

  it("namespaces a cross-project one-shot idempotency key and resolves a retry", () => {
    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
    });
    const first = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "namespaced",
      spec: "spec",
      toProjectId: "q",
      idempotencyKey: "retry-key",
    });
    expect(getHandoff(db, first.handoffId)?.idempotencyKey).toBe("xp|p|p:a|q|q:b|retry-key");
    const retry = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "namespaced",
      spec: "spec",
      toProjectId: "q",
      idempotencyKey: "retry-key",
    });
    expect(retry.status).toBe(first.status);
    expect(retry.handoffId).toBe(first.handoffId);

    const generated = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "generated",
      spec: "spec",
      toProjectId: "q",
    });
    expect(getHandoff(db, generated.handoffId)?.idempotencyKey).toMatch(
      /^xp\|p\|p:a\|q\|q:b\|[0-9a-f-]{36}$/,
    );
    const count = db.prepare("SELECT count(*) AS n FROM handoffs").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("returns existing on a cross-project retry while the grant exists and cross_project_denied after revoke (m8)", () => {
    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
    });
    const input = {
      fromAppKey: "a",
      toAppKey: "b",
      summary: "revoke",
      spec: "spec",
      toProjectId: "q",
      mode: "thread" as const,
      idempotencyKey: "revoke-key",
    };
    const first = service.requestSiblingChange(input);
    expect(first.status).toBe("queued");
    const retry = service.requestSiblingChange(input);
    expect(retry.status).toBe("existing");
    expect(retry.handoffId).toBe(first.handoffId);

    deleteHandoffGrant(db, "p", "a", "q", "b");
    expectGrantError(() => service.requestSiblingChange(input), "cross_project_denied");
  });

  it("records handoff.cross_project.created with scope = sourceProjectId and the exact payload (m4)", () => {
    const grant = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
    });
    const oneShot = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "event one shot",
      spec: "spec",
      toProjectId: "q",
      idempotencyKey: "event-one-shot",
    });
    const threadInput = {
      fromAppKey: "a",
      toAppKey: "b",
      summary: "event thread",
      spec: "spec",
      toProjectId: "q",
      mode: "thread" as const,
      idempotencyKey: "event-thread",
    };
    const thread = service.requestSiblingChange(threadInput);
    service.requestSiblingChange(threadInput);

    const created = eventsOfType(db, "handoff.cross_project.created");
    expect(created).toEqual([
      {
        scope: "p",
        payload: {
          handoffId: oneShot.handoffId,
          grantId: grant.id,
          projectId: "p",
          targetProjectId: "q",
          fromAppKey: "a",
          toAppKey: "b",
          dispatchMode: "auto",
          replyMode: "auto",
        },
      },
      {
        scope: "p",
        payload: {
          handoffId: thread.handoffId,
          grantId: grant.id,
          projectId: "p",
          targetProjectId: "q",
          fromAppKey: "a",
          toAppKey: "b",
          dispatchMode: "auto",
          replyMode: "auto",
        },
      },
    ]);
  });

  it("creates a cross-project thread with target_project_id/grant_id and a v2 key", () => {
    const grant = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
    });
    const result = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "cross thread",
      spec: "spec",
      toProjectId: "q",
      mode: "thread",
      idempotencyKey: "thread-key",
    });
    const handoff = getHandoff(db, result.handoffId);
    expect(handoff).toMatchObject({
      mode: "thread",
      projectId: "p",
      targetProjectId: "q",
      grantId: grant.id,
      idempotencyKey: "v2|p|p:a|q|q:b|thread|thread-key",
    });
  });

  it("returns remoteApps with only granted targets and the stored modes", () => {
    const exact = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
      dispatchMode: "approve",
      replyMode: "approve",
    });
    const wildcard = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "*",
      dispatchMode: "auto",
      replyMode: "auto",
    });
    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "b",
      targetProjectId: "q",
      toAppKey: "c",
    });

    expect(service.listReachableRemoteTargets("a")).toEqual([
      {
        projectId: "q",
        projectName: "Q",
        appKey: "a",
        appId: "q:a",
        grantId: wildcard.id,
        dispatchMode: "auto",
        replyMode: "auto",
      },
      {
        projectId: "q",
        projectName: "Q",
        appKey: "b",
        appId: "q:b",
        grantId: exact.id,
        dispatchMode: "approve",
        replyMode: "approve",
      },
      {
        projectId: "q",
        projectName: "Q",
        appKey: "c",
        appId: "q:c",
        grantId: wildcard.id,
        dispatchMode: "auto",
        replyMode: "auto",
      },
    ]);
    expect(service.listReachableRemoteTargets("b")).toEqual([
      {
        projectId: "q",
        projectName: "Q",
        appKey: "c",
        appId: "q:c",
        grantId: expect.any(Number),
        dispatchMode: "auto",
        replyMode: "auto",
      },
    ]);
    expect(service.listReachableRemoteTargets("a").map((target) => target.appKey)).not.toContain(
      "dead",
    );
  });

  it("returns remoteApps [] when the server is unbound", () => {
    const unbound = toolText(
      handleRpc(service, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_apps", arguments: {} },
      }),
    ) as { apps: unknown[]; remoteApps: unknown[] };
    expect(unbound.remoteApps).toEqual([]);
    expect(unbound.apps.length).toBeGreaterThan(0);

    const grant = setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
    });
    const bound = toolText(
      handleRpc(
        service,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_apps", arguments: {} },
        },
        { fromAppKey: "a" },
      ),
    ) as { remoteApps: Array<{ appKey: string; grantId: number }> };
    expect(bound.remoteApps).toEqual([
      {
        projectId: "q",
        projectName: "Q",
        appKey: "b",
        appId: "q:b",
        grantId: grant.id,
        dispatchMode: "auto",
        replyMode: "auto",
      },
    ]);
  });

  it("target app can reply without a reverse grant while a source call is wrong_side", () => {
    setHandoffGrant(db, {
      projectId: "p",
      fromAppKey: "a",
      targetProjectId: "q",
      toAppKey: "b",
    });
    const thread = service.requestSiblingChange({
      fromAppKey: "a",
      toAppKey: "b",
      summary: "reply",
      spec: "spec",
      toProjectId: "q",
      mode: "thread",
      idempotencyKey: "reply-key",
    });
    updateHandoff(db, thread.handoffId, {
      state: "in_progress",
      sourceSessionId: "ses-source",
      targetSessionId: "ses-target",
    });
    const initial = listHandoffMessages(db, thread.handoffId)[0];
    expect(initial).toBeDefined();
    transitionHandoffMessage(db, initial?.id ?? 0, "queued");
    transitionHandoffMessage(db, initial?.id ?? 0, "dispatching", {
      deliverySessionId: "ses-target",
    });

    expect(() =>
      service.deliverHandoff(thread.handoffId, "source reply", "completed", "a", {
        replyTo: initial?.id,
      }),
    ).toThrow(/only the target application may reply/);

    deleteHandoffGrant(db, "p", "a", "q", "b");
    const targetService = new CoordinatorService(db, "q");
    const reply = targetService.deliverHandoff(thread.handoffId, "target reply", "completed", "b", {
      replyTo: initial?.id,
    }) as { message: { seq: number } };
    expect(reply.message.seq).toBe(2);
  });
});
