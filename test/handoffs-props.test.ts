import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HandoffReplyState, HandoffState } from "../src/coordinator/handoff.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { buildSite, renderHandoffs, type SiteModel } from "../src/http/dashboard.js";
import { buildHandoffsProps } from "../src/http/props/handoffs.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const databases: SqliteDatabase[] = [];
const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

interface SeedHandoff {
  readonly id: string;
  readonly state: HandoffState;
  readonly replyState?: HandoffReplyState;
  readonly summary?: string;
  readonly updatedAt: string;
  readonly result?: string;
  readonly error?: string;
  readonly outcome?: "completed" | "blocked" | "failed";
  readonly sourceSessionId?: string;
  readonly sourceSessionDeletedAt?: string;
  readonly targetSessionId?: string;
  readonly replyDeliveredSessionId?: string;
  readonly replyDeliveredAt?: string;
  readonly replyError?: string;
  readonly operatorNote?: string;
  readonly deliveredVia?: string;
  readonly policyDispatchMode?: "auto" | "approve" | "deny";
  readonly policyReplyMode?: "auto" | "approve";
  readonly origin?: "agent" | "operator";
}

function fixture(seeds?: readonly SeedHandoff[]): SiteModel {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T12:00:00.000Z"));
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const created = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Demo','main','/workspace/demo',?,?)",
  ).run(created, created);
  for (const key of ["a", "b"]) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES (?, 'p', ?, ?, 'app', 'AGENTS.md', ?)",
    ).run(`p:${key}`, key, `apps/${key}`, created);
  }
  const insert = db.prepare(
    `INSERT INTO handoffs
      (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key, attempts,
       result, error, outcome, origin, source_session_id, source_session_deleted_at,
       target_session_id, reply_state, reply_delivered_session_id, reply_delivered_at,
       reply_error, operator_note, delivered_via, policy_dispatch_mode, policy_reply_mode,
       created_at, updated_at)
     VALUES
      (@id, 'p', 'p:a', 'p:b', @state, @summary, @spec, @key, 1, @result, @error, @outcome,
       @origin, @sourceSessionId, @sourceSessionDeletedAt, @targetSessionId, @replyState,
       @replyDeliveredSessionId, @replyDeliveredAt, @replyError, @operatorNote, @deliveredVia,
       @policyDispatchMode, @policyReplyMode, @createdAt, @updatedAt)`,
  );
  const rows = seeds ?? defaultSeeds();
  for (const seed of rows) {
    insert.run({
      id: seed.id,
      state: seed.state,
      summary: seed.summary ?? `Summary ${seed.id}`,
      spec: `Spec for ${seed.id}`,
      key: `key-${seed.id}`,
      result: seed.result ?? null,
      error: seed.error ?? null,
      outcome: seed.outcome ?? null,
      origin: seed.origin ?? "agent",
      sourceSessionId: seed.sourceSessionId ?? null,
      sourceSessionDeletedAt: seed.sourceSessionDeletedAt ?? null,
      targetSessionId: seed.targetSessionId ?? null,
      replyState: seed.replyState ?? "none",
      replyDeliveredSessionId: seed.replyDeliveredSessionId ?? null,
      replyDeliveredAt: seed.replyDeliveredAt ?? null,
      replyError: seed.replyError ?? null,
      operatorNote: seed.operatorNote ?? null,
      deliveredVia: seed.deliveredVia ?? null,
      policyDispatchMode: seed.policyDispatchMode ?? "auto",
      policyReplyMode: seed.policyReplyMode ?? "auto",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: seed.updatedAt,
    });
  }
  return buildSite({
    db,
    getProjects: () => [
      {
        id: "p",
        name: "Demo",
        rootPath: "/workspace/demo",
        workspaceRoot: "/workspace",
        service: new CoordinatorService(db, "p"),
      },
    ],
  });
}

function defaultSeeds(): SeedHandoff[] {
  return [
    { id: "h-queued", state: "queued", updatedAt: "2026-01-02T11:50:00.000Z" },
    {
      id: "h-awaiting",
      state: "awaiting_approval",
      updatedAt: "2026-01-02T11:40:00.000Z",
      policyDispatchMode: "approve",
    },
    { id: "h-dispatching", state: "dispatching", updatedAt: "2026-01-02T11:30:00.000Z" },
    { id: "h-progress", state: "in_progress", updatedAt: "2026-01-02T11:20:00.000Z" },
    {
      id: "h-delivered",
      state: "delivered",
      updatedAt: "2026-01-02T11:10:00.000Z",
      result: "Delivered result",
      outcome: "completed",
    },
    { id: "h-rejected", state: "rejected", updatedAt: "2026-01-02T11:00:00.000Z" },
    {
      id: "h-failed",
      state: "failed",
      updatedAt: "2026-01-02T10:50:00.000Z",
      error: "Target repository unavailable.",
    },
    { id: "h-expired", state: "expired", updatedAt: "2026-01-02T10:40:00.000Z" },
    { id: "h-cancelled", state: "cancelled", updatedAt: "2026-01-02T10:30:00.000Z" },
    {
      id: "h-reply-wait",
      state: "delivered",
      replyState: "waiting_operator",
      summary: "Sibling reply waiting",
      updatedAt: "2026-01-02T10:20:00.000Z",
      result: "Sibling result",
      outcome: "blocked",
      sourceSessionId: "ses_source",
      sourceSessionDeletedAt: "2026-01-02T10:25:00.000Z",
      targetSessionId: "ses_target",
      replyError: "Source session disappeared",
      operatorNote: "Look <at> this",
      policyDispatchMode: "approve",
      policyReplyMode: "approve",
    },
    {
      id: "h-reply-failed",
      state: "delivered",
      replyState: "failed",
      updatedAt: "2026-01-02T10:10:00.000Z",
      result: "Partial result",
      outcome: "failed",
    },
    {
      id: "h-reply-approval",
      state: "delivered",
      replyState: "awaiting_approval",
      updatedAt: "2026-01-02T10:00:00.000Z",
      result: "Awaiting approval result",
      outcome: "completed",
      deliveredVia: "operator_relaunch",
      replyDeliveredSessionId: "ses_delivered",
      replyDeliveredAt: "2026-01-02T10:05:00.000Z",
    },
  ];
}

describe("handoffs page props", () => {
  it("assembles counts, filter links, query, and rows in legacy order", () => {
    const props = buildHandoffsProps(fixture(), "waiting", "  reply  ");
    expect(props.filter).toBe("waiting");
    expect(props.query).toBe("reply");
    expect(props.counts).toEqual({ all: 12, waiting: 2, active: 3, closed: 8, replies: 3 });
    expect(props.filters).toEqual([
      {
        value: "all",
        label: "All",
        href: "/handoffs?q=reply",
        count: 12,
        current: false,
      },
      {
        value: "waiting",
        label: "Waiting",
        href: "/handoffs?filter=waiting&q=reply",
        count: 2,
        current: true,
      },
      {
        value: "active",
        label: "Active",
        href: "/handoffs?filter=active&q=reply",
        count: 3,
        current: false,
      },
      {
        value: "closed",
        label: "Closed",
        href: "/handoffs?filter=closed&q=reply",
        count: 8,
        current: false,
      },
      {
        value: "replies",
        label: "Replies",
        href: "/handoffs?filter=replies&q=reply",
        count: 3,
        current: false,
      },
    ]);
    expect(props.search).toEqual({
      action: "/handoffs",
      filter: "waiting",
      query: "reply",
      hiddenFilter: "waiting",
      placeholder: "Id, summary, application",
      clearHref: "/handoffs?filter=waiting",
    });
    expect(props.returnTo).toBe("/handoffs?filter=waiting");
    expect(props.tableTitle).toBe("Waiting for approval");
    expect(props.rows.map((row) => row.id)).toEqual(["h-reply-approval"]);
    expect(props.rows.map((row) => row.updatedAt)).toEqual(["2026-01-02T10:00:00.000Z"]);
    expect(props.emptyState).toBeNull();
  });

  it("matches the legacy query across id, summary, app keys, and project name", () => {
    const site = fixture();
    expect(buildHandoffsProps(site, undefined, "h-expired").rows.map((row) => row.id)).toEqual([
      "h-expired",
    ]);
    expect(buildHandoffsProps(site, undefined, "sibling").rows.map((row) => row.id)).toEqual([
      "h-reply-wait",
    ]);
    expect(buildHandoffsProps(site, undefined, "DEMO").rows).toHaveLength(12);
    expect(buildHandoffsProps(site, "invalid", undefined).filter).toBe("all");
  });

  it("builds the full dialog data with the current return_to", () => {
    const props = buildHandoffsProps(fixture(), "replies", "sibling");
    expect(props.rows.map((row) => row.id)).toEqual(["h-reply-wait"]);
    const row = props.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) {
      throw new Error("expected a reply row");
    }
    expect(row.shortId).toBe("h-reply-");
    expect(row.fromAppKey).toBe("a");
    expect(row.toAppKey).toBe("b");
    expect(row.displayState).toBe("delivered");
    expect(row.inlineDecision).toBeNull();
    expect(row.dialog).toMatchObject({
      id: "h-reply-wait",
      approvalKind: null,
      returnTo: "/handoffs?filter=replies",
      state: "delivered",
      replyState: "waiting_operator",
      displayState: "delivered",
      sourceSessionId: "ses_source",
      sourceSessionHref: "/chat?app=a&project=p&session=ses_source",
      sourceSessionDeleted: true,
      targetSessionId: "ses_target",
      targetSessionHref: "/chat?app=b&project=p&session=ses_target",
      replyError: "Source session disappeared",
      operatorNote: "Look <at> this",
      policyDispatchMode: "approve",
      policyReplyMode: "approve",
      canCancel: false,
      canRelaunch: true,
      canRetryReply: false,
      canCancelReply: true,
    });
  });

  it("marks dispatch and reply approvals for inline and dialog actions", () => {
    const props = buildHandoffsProps(fixture(), "waiting", undefined);
    expect(props.rows.map((row) => row.id)).toEqual(["h-awaiting", "h-reply-approval"]);
    const [dispatchRow, replyRow] = props.rows;
    expect(dispatchRow?.inlineDecision).toEqual({
      action: "/api/handoffs/h-awaiting/decision",
      approvalKind: "dispatch",
      returnTo: "/handoffs?filter=waiting",
    });
    expect(dispatchRow?.dialog.approvalKind).toBe("dispatch");
    expect(dispatchRow?.dialog.returnTo).toBe("/handoffs?filter=waiting");
    expect(replyRow?.inlineDecision).toEqual({
      action: "/api/handoffs/h-reply-approval/decision",
      approvalKind: "reply",
      returnTo: "/handoffs?filter=waiting",
    });
    expect(replyRow?.dialog.approvalKind).toBe("reply");
  });

  it("derives the empty-state copy for every filter and query combination", () => {
    const empty = buildHandoffsProps(fixture([]), undefined, undefined);
    expect(empty.emptyState).toEqual({
      iconName: "branch",
      title: "No handoffs yet",
      body: "Handoffs route work between applications. Open a project to create the first one.",
      actionLabel: "Open a project",
      actionHref: "/projects",
    });

    const queued = fixture([
      { id: "h-queued", state: "queued", updatedAt: "2026-01-02T11:50:00.000Z" },
    ]);
    expect(buildHandoffsProps(queued, "waiting", undefined).emptyState).toMatchObject({
      title: "No handoffs waiting",
      actionLabel: "Show all handoffs",
      actionHref: "/handoffs",
    });
    expect(buildHandoffsProps(queued, "closed", "zzz").emptyState).toEqual({
      iconName: "search",
      title: "No matching handoffs",
      body: "Nothing matches “zzz” in this filter.",
      actionLabel: "Clear search",
      actionHref: "/handoffs?filter=closed",
    });

    const closed = fixture([
      { id: "h-delivered", state: "delivered", updatedAt: "2026-01-02T11:50:00.000Z" },
    ]);
    expect(buildHandoffsProps(closed, "active", undefined).emptyState).toMatchObject({
      title: "No active handoffs",
    });
    expect(buildHandoffsProps(closed, "replies", undefined).emptyState).toMatchObject({
      title: "No replies waiting",
    });
  });

  it("keeps the legacy inbox HTML deriving from the same props", () => {
    const site = fixture();
    expect(renderHandoffs(site, { chrome: { operatorName: "operator" } })).toMatchSnapshot();
    expect(
      renderHandoffs(site, {
        filter: "waiting",
        q: "reply",
        chrome: { operatorName: "operator" },
      }),
    ).toMatchSnapshot();
  });
});
