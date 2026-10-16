import { randomUUID } from "node:crypto";
import { AuthError } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { SqliteDatabase } from "../store/index.js";
import { transitionHandoff } from "./handoff.js";

export type ApprovalState = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  handoffId: string;
  state: ApprovalState;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
}

interface ApprovalRow {
  id: string;
  handoff_id: string;
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

export function requestApproval(db: SqliteDatabase, handoffId: string): Approval {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO approvals (id, handoff_id, state, requested_at) VALUES (?, ?, 'pending', ?)",
  ).run(id, handoffId, now);
  db.prepare("UPDATE handoffs SET approval_id = ?, updated_at = ? WHERE id = ?").run(
    id,
    now,
    handoffId,
  );
  return {
    id,
    handoffId,
    state: "pending",
    requestedAt: now,
    decidedAt: null,
    decidedBy: null,
    reason: null,
  };
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
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE approvals SET state = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ?",
  ).run(decision, now, principal.id, reason ?? null, approvalId);
  transitionHandoff(db, approval.handoffId, decision === "approved" ? "dispatching" : "rejected");
  return {
    id: approval.id,
    handoffId: approval.handoffId,
    state: decision,
    requestedAt: approval.requestedAt,
    decidedAt: now,
    decidedBy: principal.id,
    reason: reason ?? null,
  };
}
