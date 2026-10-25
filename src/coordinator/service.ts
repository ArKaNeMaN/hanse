import { randomUUID } from "node:crypto";
import { AuthError } from "../identity/auth.js";
import type { Principal } from "../identity/principals.js";
import type { RegisteredApp } from "../registry/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { expirePendingApprovals, getPendingApproval, requestApproval } from "./approval.js";
import {
  createHandoff,
  getHandoff,
  type Handoff,
  type HandoffOutcome,
  type HandoffState,
  transitionHandoff,
  updateHandoff,
} from "./handoff.js";
import { resolveHandoffPolicy } from "./policy.js";

export type HandoffRequestStatus = "queued" | "awaiting_approval" | "denied" | "existing";

export interface RequestSiblingChangeInput {
  fromAppKey: string;
  toAppKey: string;
  summary: string;
  spec: string;
  requiresApproval?: boolean;
  idempotencyKey?: string;
  expiresAt?: string;
  origin?: "agent" | "operator";
}

export interface RequestSiblingChangeResult {
  handoffId: string;
  status: HandoffRequestStatus;
  state: HandoffState;
}

const DELIVERABLE_STATES: readonly HandoffState[] = ["dispatching", "in_progress", "delivered"];

/** Coordinator-side handoff operations; the MCP tools are thin wrappers over these. */
export class CoordinatorService {
  readonly #db: SqliteDatabase;
  readonly #projectId: string;

  constructor(db: SqliteDatabase, projectId: string) {
    this.#db = db;
    this.#projectId = projectId;
  }

  listApps(): RegisteredApp[] {
    const rows = this.#db
      .prepare(
        `SELECT a.id, a.project_id, a.app_key, a.path, a.kind, a.contract, a.deleting,
                a.image_status, a.image_ref, a.image_hash, a.image_base_digest,
                a.image_built_at, a.image_error,
                (SELECT v.image_ref FROM app_image_versions v
                  WHERE v.app_id = a.id AND a.image_ref IS NOT NULL
                    AND v.image_ref <> a.image_ref
                  ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS image_rollback_ref,
                (SELECT v.built_at FROM app_image_versions v
                  WHERE v.app_id = a.id AND a.image_ref IS NOT NULL
                    AND v.image_ref <> a.image_ref
                  ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS image_rollback_built_at
         FROM apps a WHERE a.project_id = ? ORDER BY a.app_key`,
      )
      .all(this.#projectId) as {
      id: string;
      project_id: string;
      app_key: string;
      path: string;
      kind: string | null;
      contract: string;
      deleting: number;
      image_status: RegisteredApp["imageStatus"];
      image_ref: string | null;
      image_hash: string | null;
      image_base_digest: string | null;
      image_built_at: string | null;
      image_error: string | null;
      image_rollback_ref: string | null;
      image_rollback_built_at: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      appKey: row.app_key,
      path: row.path,
      kind: row.kind,
      contract: row.contract,
      deleting: row.deleting === 1,
      imageStatus: row.image_status,
      imageRef: row.image_ref,
      imageHash: row.image_hash,
      imageBaseDigest: row.image_base_digest,
      imageBuiltAt: row.image_built_at,
      imageError: row.image_error,
      imageRollbackRef: row.image_rollback_ref,
      imageRollbackBuiltAt: row.image_rollback_built_at,
      buildDockerfile: null,
      // image_hash is the manifest build-spec hash, so unlike `image_status` it is non-null for a
      // build-configured app that has never produced an image. Error rows are also build-configured.
      buildConfigured:
        row.image_status !== "missing" || row.image_ref !== null || row.image_hash !== null,
      buildArgs: {},
      buildSpecHash: null,
    }));
  }

  requestSiblingChange(input: RequestSiblingChangeInput): RequestSiblingChangeResult {
    const fromAppKey = input.fromAppKey.trim();
    const toAppKey = input.toAppKey.trim();
    if (fromAppKey === toAppKey) {
      throw new Error("a handoff must target a different application");
    }
    const fromAppId = this.#appIdByKey(fromAppKey);
    const toAppId = this.#appIdByKey(toAppKey);
    const policy = resolveHandoffPolicy(this.#db, this.#projectId, fromAppKey, toAppKey);
    // An agent's `requires_approval` flag may raise the policy bar, never lower it.
    const dispatchMode =
      policy.dispatchMode === "auto" && input.requiresApproval === true
        ? "approve"
        : policy.dispatchMode;
    const handoff = createHandoff(this.#db, {
      projectId: this.#projectId,
      fromAppId,
      toAppId,
      summary: input.summary,
      spec: input.spec,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      requiresApproval: dispatchMode === "approve",
      expiresAt: input.expiresAt,
      origin: input.origin ?? "agent",
      policyDispatchMode: dispatchMode,
      policyReplyMode: policy.replyMode,
    });
    if (dispatchMode === "deny") {
      if (handoff.state === "queued" || handoff.state === "awaiting_approval") {
        const denied = transitionHandoff(this.#db, handoff.id, "rejected", {
          error: "denied by handoff policy",
        });
        return { handoffId: denied.id, status: "denied", state: denied.state };
      }
      return {
        handoffId: handoff.id,
        status: handoff.state === "rejected" ? "denied" : "existing",
        state: handoff.state,
      };
    }
    if (handoff.state === "awaiting_approval" && !this.#hasApproval(handoff.id, "dispatch")) {
      requestApproval(this.#db, handoff.id, "dispatch");
    }
    const status: HandoffRequestStatus =
      handoff.state === "awaiting_approval"
        ? "awaiting_approval"
        : handoff.state === "queued"
          ? "queued"
          : handoff.state === "rejected"
            ? "denied"
            : "existing";
    return { handoffId: handoff.id, status, state: handoff.state };
  }

  /**
   * Bind an agent-created handoff to the session that invoked `request_sibling_change`.
   * The coordinator derives this from the app's event stream, so the agent cannot spoof it.
   */
  bindSourceSession(
    handoffId: string,
    appId: string,
    sessionId: string,
    sessionTitle?: string | null,
  ): boolean {
    const handoff = getHandoff(this.#db, handoffId);
    if (handoff === undefined) return false;
    if (handoff.fromAppId !== appId) return false;
    if (handoff.origin !== "agent") return false;
    if (handoff.sourceSessionId !== null) return false;
    const parentRow = this.#db
      .prepare(
        `SELECT id FROM handoffs
         WHERE to_app_id = ? AND target_session_id = ? AND id <> ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(appId, sessionId, handoffId) as { id: string } | undefined;
    const parent = parentRow === undefined ? undefined : getHandoff(this.#db, parentRow.id);
    const rootHandoffId = parent?.rootHandoffId ?? parent?.id ?? handoff.id;
    updateHandoff(this.#db, handoffId, {
      sourceSessionId: sessionId,
      sourceSessionTitle: sessionTitle ?? null,
      parentHandoffId: parent?.id ?? null,
      rootHandoffId,
      depth: parent === undefined ? 0 : parent.depth + 1,
    });
    return true;
  }

  handoffStatus(id: string, callerAppKey?: string): Handoff | undefined {
    const handoff = getHandoff(this.#db, id);
    if (handoff === undefined) return undefined;
    if (callerAppKey === undefined) return handoff;
    const callerId = this.#tryAppIdByKey(callerAppKey);
    if (callerId === undefined) return undefined;
    if (handoff.fromAppId !== callerId && handoff.toAppId !== callerId) return undefined;
    return handoff;
  }

  /**
   * Record the target agent's reply. Only the addressed application may deliver; an already
   * delivered handoff is returned unchanged (idempotent retries).
   */
  deliverHandoff(
    id: string,
    result: string,
    outcome: HandoffOutcome = "completed",
    callerAppKey?: string,
  ): Handoff {
    const handoff = getHandoff(this.#db, id);
    if (handoff === undefined) {
      throw new Error(`Handoff not found: ${id}`);
    }
    if (callerAppKey !== undefined) {
      const callerId = this.#tryAppIdByKey(callerAppKey);
      if (callerId === undefined || callerId !== handoff.toAppId) {
        throw new Error(`Handoff ${id} is not addressed to this application`);
      }
    }
    if (handoff.state === "delivered") {
      return handoff;
    }
    if (!DELIVERABLE_STATES.includes(handoff.state)) {
      throw new Error(`Handoff ${id} is not deliverable (state: ${handoff.state})`);
    }
    if (handoff.state === "dispatching") {
      transitionHandoff(this.#db, id, "in_progress");
    }
    const delivered = transitionHandoff(this.#db, id, "delivered", { result, outcome });
    if (delivered.policyReplyMode === "approve") {
      updateHandoff(this.#db, id, { replyState: "awaiting_approval", replyError: null });
      requestApproval(this.#db, id, "reply");
    } else {
      updateHandoff(this.#db, id, { replyState: "pending", replyError: null });
    }
    return getHandoff(this.#db, id) ?? delivered;
  }

  /** Cancel a pending/running handoff or its undelivered reply. Human-only. */
  cancelHandoff(id: string, principal: Principal): Handoff {
    if (principal.kind !== "human") {
      throw new AuthError("only a human principal may cancel a handoff");
    }
    const handoff = getHandoff(this.#db, id);
    if (handoff === undefined) {
      throw new Error(`Handoff not found: ${id}`);
    }
    if (handoff.state === "delivered") {
      if (
        handoff.replyState === "pending" ||
        handoff.replyState === "awaiting_approval" ||
        handoff.replyState === "waiting_operator" ||
        handoff.replyState === "failed"
      ) {
        expirePendingApprovals(this.#db, id, "reply");
        return updateHandoff(this.#db, id, {
          replyState: "cancelled",
          replyError: null,
        });
      }
      throw new Error(`Handoff ${id} has no reply pending delivery`);
    }
    if (
      handoff.state === "rejected" ||
      handoff.state === "failed" ||
      handoff.state === "expired" ||
      handoff.state === "cancelled"
    ) {
      throw new Error(`Handoff ${id} is already closed (state: ${handoff.state})`);
    }
    expirePendingApprovals(this.#db, id);
    return transitionHandoff(this.#db, id, "cancelled", { error: "cancelled by operator" });
  }

  #hasApproval(handoffId: string, kind: "dispatch" | "reply"): boolean {
    return getPendingApproval(this.#db, handoffId, kind) !== undefined;
  }

  #appIdByKey(appKey: string): string {
    const id = this.#tryAppIdByKey(appKey);
    if (id === undefined) {
      throw new Error(
        `Unknown application "${appKey}" in project ${this.#projectId}. Use the appKey from list_apps (for example "hanse-deploy"), not a full application id such as "<projectId>:<appKey>".`,
      );
    }
    return id;
  }

  #tryAppIdByKey(appKey: string): string | undefined {
    const row = this.#db
      .prepare("SELECT id FROM apps WHERE project_id = ? AND app_key = ?")
      .get(this.#projectId, appKey) as { id: string } | undefined;
    return row?.id;
  }
}
