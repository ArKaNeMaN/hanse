import { randomUUID } from "node:crypto";
import { AuthError } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { SqliteDatabase } from "../store/index.js";
import { getHandoff, transitionHandoff, updateHandoff } from "./handoff.js";

export type ApprovalKind = "dispatch" | "reply";
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  handoffId: string;
  kind: ApprovalKind;
  state: ApprovalState;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
}

interface ApprovalRow {
  id: string;
  handoff_id: string;
  kind: ApprovalKind;
  state: ApprovalState;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    handoffId: row.handoff_id,
    kind: row.kind,
    state: row.state,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    reason: row.reason,
  };
}

export function getApproval(db: SqliteDatabase, id: string): Approval | undefined {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  return row === undefined ? undefined : rowToApproval(row);
}

export function getPendingApproval(
  db: SqliteDatabase,
  handoffId: string,
  kind?: ApprovalKind,
): Approval | undefined {
  const row =
    kind === undefined
      ? (db
          .prepare(
            "SELECT * FROM approvals WHERE handoff_id = ? AND state = 'pending' ORDER BY requested_at, id LIMIT 1",
          )
          .get(handoffId) as ApprovalRow | undefined)
      : (db
          .prepare(
            "SELECT * FROM approvals WHERE handoff_id = ? AND kind = ? AND state = 'pending' ORDER BY requested_at, id LIMIT 1",
          )
          .get(handoffId, kind) as ApprovalRow | undefined);
  return row === undefined ? undefined : rowToApproval(row);
}

export function requestApproval(
  db: SqliteDatabase,
  handoffId: string,
  kind: ApprovalKind = "dispatch",
): Approval {
  const existing = getPendingApproval(db, handoffId, kind);
  if (existing !== undefined) {
    return existing;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare(
      "INSERT INTO approvals (id, handoff_id, kind, state, requested_at) VALUES (?, ?, ?, 'pending', ?)",
    ).run(id, handoffId, kind, now);
    db.prepare("UPDATE handoffs SET approval_id = ?, updated_at = ? WHERE id = ?").run(
      id,
      now,
      handoffId,
    );
  });
  run();
  return {
    id,
    handoffId,
    kind,
    state: "pending",
    requestedAt: now,
    decidedAt: null,
    decidedBy: null,
    reason: null,
  };
}

/** Expire pending approvals for one handoff (used when the handoff or its reply is cancelled). */
export function expirePendingApprovals(
  db: SqliteDatabase,
  handoffId: string,
  kind?: ApprovalKind,
): number {
  const result =
    kind === undefined
      ? db
          .prepare(
            "UPDATE approvals SET state = 'expired', decided_at = ? WHERE handoff_id = ? AND state = 'pending'",
          )
          .run(new Date().toISOString(), handoffId)
      : db
          .prepare(
            "UPDATE approvals SET state = 'expired', decided_at = ? WHERE handoff_id = ? AND kind = ? AND state = 'pending'",
          )
          .run(new Date().toISOString(), handoffId, kind);
  return result.changes;
}

export function decideApproval(
  db: SqliteDatabase,
  approvalId: string,
  principal: Principal,
  decision: "approved" | "rejected",
  reason?: string,
): Approval {
  if (principal.kind !== "human") {
    throw new AuthError("only a human principal may decide an approval");
  }
  const approval = getApproval(db, approvalId);
  if (approval === undefined) {
    throw new Error(`Approval not found: ${approvalId}`);
  }
  if (approval.state !== "pending") {
    throw new Error(`Approval ${approvalId} is not pending (state: ${approval.state})`);
  }
  const handoff = getHandoff(db, approval.handoffId);
  if (handoff === undefined) {
    throw new Error(`Handoff not found: ${approval.handoffId}`);
  }
  const now = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare(
      "UPDATE approvals SET state = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ?",
    ).run(decision, now, principal.id, reason ?? null, approvalId);
    if (approval.kind === "dispatch") {
      if (handoff.state !== "awaiting_approval") {
        throw new Error(
          `Handoff ${handoff.id} is not awaiting dispatch approval (state: ${handoff.state})`,
        );
      }
      transitionHandoff(
        db,
        approval.handoffId,
        decision === "approved" ? "dispatching" : "rejected",
      );
      return;
    }
    if (handoff.replyState !== "awaiting_approval") {
      throw new Error(
        `Handoff ${handoff.id} reply is not awaiting approval (state: ${handoff.replyState})`,
      );
    }
    updateHandoff(db, approval.handoffId, {
      replyState: decision === "approved" ? "pending" : "failed",
      replyError:
        decision === "approved"
          ? null
          : reason === undefined || reason.trim().length === 0
            ? "reply rejected by operator"
            : `reply rejected by operator: ${reason.trim()}`,
    });
  });
  run();
  return {
    id: approval.id,
    handoffId: approval.handoffId,
    kind: approval.kind,
    state: decision,
    requestedAt: approval.requestedAt,
    decidedAt: now,
    decidedBy: principal.id,
    reason: reason ?? null,
  };
}
