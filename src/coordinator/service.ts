import { randomUUID } from "node:crypto";
import type { RegisteredApp } from "../registry/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { requestApproval } from "./approval.js";
import {
  createHandoff,
  getHandoff,
  type Handoff,
  type HandoffState,
  transitionHandoff,
} from "./handoff.js";

export interface RequestSiblingChangeInput {
  fromAppKey: string;
  toAppKey: string;
  summary: string;
  spec: string;
  requiresApproval?: boolean;
  idempotencyKey?: string;
  expiresAt?: string;
}

export interface RequestSiblingChangeResult {
  handoffId: string;
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
        `SELECT a.id, a.project_id, a.app_key, a.path, a.kind, a.contract,
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
      imageStatus: row.image_status,
      imageRef: row.image_ref,
      imageHash: row.image_hash,
      imageBaseDigest: row.image_base_digest,
      imageBuiltAt: row.image_built_at,
      imageError: row.image_error,
      imageRollbackRef: row.image_rollback_ref,
      imageRollbackBuiltAt: row.image_rollback_built_at,
      buildDockerfile: null,
      buildArgs: {},
      buildSpecHash: null,
    }));
  }

  requestSiblingChange(input: RequestSiblingChangeInput): RequestSiblingChangeResult {
    const fromAppId = this.#appIdByKey(input.fromAppKey);
    const toAppId = this.#appIdByKey(input.toAppKey);
    const handoff = createHandoff(this.#db, {
      projectId: this.#projectId,
      fromAppId,
      toAppId,
      summary: input.summary,
      spec: input.spec,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      requiresApproval: input.requiresApproval,
      expiresAt: input.expiresAt,
    });
    if (handoff.state === "awaiting_approval" && !this.#hasApproval(handoff.id)) {
      requestApproval(this.#db, handoff.id);
    }
    return { handoffId: handoff.id };
  }

  handoffStatus(id: string): Handoff | undefined {
    return getHandoff(this.#db, id);
  }

  /** Record the result of a handoff. Idempotent: an already-delivered handoff is returned unchanged. */
  deliverHandoff(id: string, result: string): Handoff {
    const handoff = getHandoff(this.#db, id);
    if (handoff === undefined) {
      throw new Error(`Handoff not found: ${id}`);
    }
    if (handoff.state === "delivered") {
      return handoff;
    }
    if (!DELIVERABLE_STATES.includes(handoff.state)) {
      throw new Error(`Handoff ${id} is not deliverable (state: ${handoff.state})`);
    }
    const dispatched =
      handoff.state === "dispatching" ? transitionHandoff(this.#db, id, "in_progress") : handoff;
    if (dispatched.state === "delivered") {
      return dispatched;
    }
    return transitionHandoff(this.#db, id, "delivered", { result });
  }

  #hasApproval(handoffId: string): boolean {
    return (
      this.#db.prepare("SELECT id FROM approvals WHERE handoff_id = ?").get(handoffId) !== undefined
    );
  }

  #appIdByKey(appKey: string): string {
    const row = this.#db
      .prepare("SELECT id FROM apps WHERE project_id = ? AND app_key = ?")
      .get(this.#projectId, appKey) as { id: string } | undefined;
    if (row === undefined) {
      throw new Error(`Unknown application "${appKey}" in project ${this.#projectId}`);
    }
    return row.id;
  }
}
