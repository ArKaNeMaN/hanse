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
  type HandoffMode,
  type HandoffOutcome,
  type HandoffState,
  transitionHandoff,
  updateHandoff,
} from "./handoff.js";
import { resolveHandoffPolicy } from "./policy.js";
import {
  appendThreadMessage,
  appendThreadReply,
  cancelThread as cancelThreadRecord,
  createThread,
  DEFAULT_THREAD_LIMITS,
  ThreadError,
  type ThreadInitialMessage,
  type ThreadLimits,
  type ThreadMessageView,
  toThreadMessageView,
} from "./thread.js";

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
  mode?: HandoffMode;
}

export interface RequestSiblingChangeResult {
  handoffId: string;
  status: HandoffRequestStatus;
  state: HandoffState;
  mode?: HandoffMode;
  threadId?: string;
  initialMessage?: ThreadInitialMessage;
}

export interface ThreadMessageResult {
  threadId: string;
  message: ThreadMessageView;
  handoff: { id: string; state: HandoffState; messageCount: number };
}

export interface ThreadReplyResult {
  handoff: { id: string; state: HandoffState; messageCount: number };
  message: ThreadMessageView;
  replyTo: { id: number; seq: number };
}

type NewThreadHeaderKey =
  | "mode"
  | "messageSeq"
  | "messageCount"
  | "lastMessageAt"
  | "threadIdleExpiresAt"
  | "sourceInvokingSessionId";

export type OneShotAgentHandoffStatus = Omit<Handoff, NewThreadHeaderKey>;

export interface ThreadAgentHandoffStatus {
  id: string;
  mode: HandoffMode;
  state: HandoffState;
  messageCount: number;
  lastMessageAt: string | null;
  threadIdleExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentHandoffStatus = OneShotAgentHandoffStatus | ThreadAgentHandoffStatus;
export type HandoffStatus = Handoff | AgentHandoffStatus;

function oneShotAgentStatus(handoff: Handoff): OneShotAgentHandoffStatus {
  return {
    id: handoff.id,
    projectId: handoff.projectId,
    fromAppId: handoff.fromAppId,
    toAppId: handoff.toAppId,
    state: handoff.state,
    summary: handoff.summary,
    spec: handoff.spec,
    idempotencyKey: handoff.idempotencyKey,
    attempts: handoff.attempts,
    nextAttemptAt: handoff.nextAttemptAt,
    expiresAt: handoff.expiresAt,
    targetTaskId: handoff.targetTaskId,
    result: handoff.result,
    error: handoff.error,
    outcome: handoff.outcome,
    origin: handoff.origin,
    sourceSessionId: handoff.sourceSessionId,
    sourceSessionTitle: handoff.sourceSessionTitle,
    sourceSessionDeletedAt: handoff.sourceSessionDeletedAt,
    targetSessionId: handoff.targetSessionId,
    targetSessionTitle: handoff.targetSessionTitle,
    replyState: handoff.replyState,
    replyMessageId: handoff.replyMessageId,
    replyDeliveredSessionId: handoff.replyDeliveredSessionId,
    replyDeliveredAt: handoff.replyDeliveredAt,
    replyError: handoff.replyError,
    replyAttempts: handoff.replyAttempts,
    dispatchMessageId: handoff.dispatchMessageId,
    dispatchStartedAt: handoff.dispatchStartedAt,
    deadlineAt: handoff.deadlineAt,
    operatorNote: handoff.operatorNote,
    deliveredVia: handoff.deliveredVia,
    parentHandoffId: handoff.parentHandoffId,
    rootHandoffId: handoff.rootHandoffId,
    depth: handoff.depth,
    policyDispatchMode: handoff.policyDispatchMode,
    policyReplyMode: handoff.policyReplyMode,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
  };
}

function threadAgentStatus(handoff: Handoff): ThreadAgentHandoffStatus {
  return {
    id: handoff.id,
    mode: handoff.mode,
    state: handoff.state,
    messageCount: handoff.messageCount,
    lastMessageAt: handoff.lastMessageAt,
    threadIdleExpiresAt: handoff.threadIdleExpiresAt,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
  };
}

const DELIVERABLE_STATES: readonly HandoffState[] = ["dispatching", "in_progress", "delivered"];

/** Coordinator-side handoff operations; the MCP tools are thin wrappers over these. */
export class CoordinatorService {
  readonly #db: SqliteDatabase;
  readonly #projectId: string;
  readonly #threadLimits: ThreadLimits;

  constructor(
    db: SqliteDatabase,
    projectId: string,
    threadLimits: ThreadLimits = DEFAULT_THREAD_LIMITS,
  ) {
    this.#db = db;
    this.#projectId = projectId;
    this.#threadLimits = threadLimits;
  }

  listApps(): RegisteredApp[] {
    const rows = this.#db
      .prepare(
        `SELECT a.id, a.project_id, a.app_key, a.path, a.kind, a.contract, a.deleting,
                a.image_status, a.image_ref, a.image_hash, a.image_base_digest,
                a.image_built_at, a.image_error, a.build_configured,
                a.image_base_ref, a.image_base_kind, a.image_hash_version,
                a.image_build_id, a.image_build_ref, a.image_build_started_at,
                a.image_build_rejected_ref,
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
      build_configured: number;
      image_base_ref: string | null;
      image_base_kind: RegisteredApp["imageBaseKind"];
      image_hash_version: number;
      image_build_id: string | null;
      image_build_ref: string | null;
      image_build_started_at: string | null;
      image_build_rejected_ref: string | null;
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
      imageBaseRef: row.image_base_ref,
      imageBaseKind: row.image_base_kind,
      imageHashVersion: row.image_hash_version,
      imageBuildId: row.image_build_id,
      imageBuildRef: row.image_build_ref,
      imageBuildStartedAt: row.image_build_started_at,
      imageBuildRejectedRef: row.image_build_rejected_ref,
      imageRollbackRef: row.image_rollback_ref,
      imageRollbackBuiltAt: row.image_rollback_built_at,
      buildDockerfile: null,
      buildConfigured: row.build_configured === 1,
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
    if (input.mode === "thread") {
      const thread = createThread(
        this.#db,
        {
          projectId: this.#projectId,
          fromAppId,
          toAppId,
          summary: input.summary,
          spec: input.spec,
          idempotencyKey: input.idempotencyKey,
          requiresApproval: input.requiresApproval,
          policyDispatchMode: dispatchMode,
          policyReplyMode: policy.replyMode,
          origin: input.origin ?? "agent",
        },
        this.#threadLimits,
      );
      return {
        handoffId: thread.handoff.id,
        status: thread.status,
        state: thread.handoff.state,
        mode: "thread",
        threadId: thread.handoff.id,
        initialMessage: thread.initialMessage,
      };
    }
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

  handoffStatus(id: string, callerAppKey?: string): HandoffStatus | undefined {
    const handoff = getHandoff(this.#db, id);
    if (handoff === undefined) return undefined;
    if (callerAppKey === undefined) return handoff;
    const callerId = this.#tryAppIdByKey(callerAppKey);
    if (callerId === undefined) return undefined;
    if (handoff.fromAppId !== callerId && handoff.toAppId !== callerId) return undefined;
    return handoff.mode === "thread" ? threadAgentStatus(handoff) : oneShotAgentStatus(handoff);
  }

  sendThreadMessage(
    id: string,
    body: string,
    clientMessageId: string | undefined,
    callerAppKey?: string,
  ): ThreadMessageResult {
    const callerAppId = callerAppKey === undefined ? undefined : this.#tryAppIdByKey(callerAppKey);
    if (callerAppKey !== undefined && callerAppId === undefined) {
      throw new ThreadError(
        "wrong_app",
        `Unknown application "${callerAppKey}" in project ${this.#projectId}`,
      );
    }
    const appended = appendThreadMessage(
      this.#db,
      {
        handoffId: id,
        body,
        clientMessageId,
        callerAppId,
      },
      this.#threadLimits,
    );
    return {
      threadId: appended.handoff.id,
      message: toThreadMessageView(appended.message),
      handoff: {
        id: appended.handoff.id,
        state: appended.handoff.state,
        messageCount: appended.handoff.messageCount,
      },
    };
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
    thread: { replyTo?: unknown; clientMessageId?: string | null } = {},
  ): Handoff | ThreadReplyResult {
    const handoff = getHandoff(this.#db, id);
    if (handoff === undefined) {
      throw new Error(`Handoff not found: ${id}`);
    }
    if (handoff.mode === "thread") {
      const callerAppId =
        callerAppKey === undefined ? undefined : this.#tryAppIdByKey(callerAppKey);
      if (callerAppKey !== undefined && callerAppId === undefined) {
        throw new ThreadError(
          "wrong_app",
          `Unknown application "${callerAppKey}" in project ${this.#projectId}`,
        );
      }
      if (callerAppId !== undefined && callerAppId !== handoff.toAppId) {
        throw new ThreadError("wrong_side", "only the target application may reply");
      }
      const appended = appendThreadReply(
        this.#db,
        {
          handoffId: id,
          body: result,
          outcome,
          replyTo: thread.replyTo,
          clientMessageId: thread.clientMessageId,
          callerAppId,
        },
        this.#threadLimits,
      );
      return {
        handoff: {
          id: appended.handoff.id,
          state: appended.handoff.state,
          messageCount: appended.handoff.messageCount,
        },
        message: toThreadMessageView(appended.message),
        replyTo: appended.replyTo,
      };
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

  /** Cancel a thread atomically. Human-only. One-shot cancel stays on {@link cancelHandoff}. */
  cancelThread(id: string, principal: Principal): Handoff {
    if (principal.kind !== "human") {
      throw new AuthError("only a human principal may cancel a handoff");
    }
    return cancelThreadRecord(this.#db, id);
  }

  #hasApproval(handoffId: string, kind: "dispatch" | "reply"): boolean {
    return getPendingApproval(this.#db, handoffId, kind) !== undefined;
  }

  #appIdByKey(appKey: string): string {
    const id = this.#tryAppIdByKey(appKey);
    if (id === undefined) {
      throw new Error(
        `Unknown application "${appKey}" in project ${this.#projectId}. Use the appKey from list_apps (for example "other-app"), not a full application id such as "<projectId>:<appKey>".`,
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
