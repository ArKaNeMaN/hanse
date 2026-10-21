import type { SqliteDatabase } from "../store/index.js";
import {
  ABSOLUTE_GRANT_SEC,
  APPROVAL_REQUESTS_PER_HOUR,
  PENDING_PER_APP,
  REJECT_COOLDOWN_SEC,
  type SshAction,
  type SshApproval,
  type SshApprovalStatus,
  type SshApprovalView,
  type SshAuditEntry,
  type SshCredentialStatus,
  SshError,
  type SshGrant,
  type SshHost,
} from "./types.js";

interface HostRow {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  host_key: string | null;
  host_key_type: string | null;
  host_key_bits: number | null;
  host_key_fingerprint: string | null;
  host_key_pinned_at: string | null;
  host_key_mismatch_at: string | null;
  require_approval: number;
  approval_idle_sec: number;
  remote_root: string | null;
  created_at: string;
  updated_at: string;
  public_key: string | null;
  public_key_fingerprint: string | null;
  key_type: string | null;
  bits: number | null;
  validated_at: string | null;
  credential_updated_at: string | null;
}

interface ApprovalRow {
  id: string;
  app_id: string;
  host_id: string;
  action: SshAction;
  command_hash: string;
  command_preview: string;
  command_bytes: number;
  status: SshApprovalStatus;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  grant_id: string | null;
}

interface GrantRow {
  id: string;
  app_id: string;
  host_id: string;
  approval_id: string;
  granted_by: string;
  granted_at: string;
  last_used_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
}

interface AuditRow {
  id: number;
  app_id: string;
  project_id: string;
  app_key: string;
  host_id: string;
  host_name: string;
  address: string;
  username: string;
  action: string;
  command_hash: string | null;
  command_preview: string | null;
  presented_fingerprint: string | null;
  detail_json: string | null;
  approval_id: string | null;
  grant_id: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  error_code: string | null;
  bytes_out: number | null;
  truncated: number;
}

function hostFromRow(row: HostRow): SshHost {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    port: row.port,
    username: row.username,
    hostKey: row.host_key,
    hostKeyType: row.host_key_type,
    hostKeyBits: row.host_key_bits,
    hostKeyFingerprint: row.host_key_fingerprint,
    hostKeyPinnedAt: row.host_key_pinned_at,
    hostKeyMismatchAt: row.host_key_mismatch_at,
    requireApproval: row.require_approval === 1,
    approvalIdleSec: row.approval_idle_sec,
    remoteRoot: row.remote_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function credentialFromRow(row: HostRow): SshCredentialStatus | null {
  if (
    row.public_key === null ||
    row.public_key_fingerprint === null ||
    row.key_type === null ||
    row.validated_at === null
  ) {
    return null;
  }
  return {
    publicKey: row.public_key,
    fingerprint: row.public_key_fingerprint,
    keyType: row.key_type,
    bits: row.bits,
    validatedAt: row.validated_at,
    updatedAt: row.credential_updated_at ?? row.updated_at,
  };
}

function approvalFromRow(row: ApprovalRow): SshApproval {
  return {
    id: row.id,
    appId: row.app_id,
    hostId: row.host_id,
    action: row.action,
    commandHash: row.command_hash,
    commandPreview: row.command_preview,
    commandBytes: row.command_bytes,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    grantId: row.grant_id,
  };
}

function grantFromRow(row: GrantRow): SshGrant {
  return {
    id: row.id,
    appId: row.app_id,
    hostId: row.host_id,
    approvalId: row.approval_id,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    lastUsedAt: row.last_used_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at,
  };
}

function auditFromRow(row: AuditRow): SshAuditEntry {
  let detail: Record<string, unknown> | null = null;
  if (row.detail_json !== null) {
    try {
      const parsed = JSON.parse(row.detail_json) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        detail = parsed as Record<string, unknown>;
      }
    } catch {
      detail = null;
    }
  }
  return {
    id: row.id,
    appId: row.app_id,
    projectId: row.project_id,
    appKey: row.app_key,
    hostId: row.host_id,
    hostName: row.host_name,
    address: row.address,
    username: row.username,
    action: row.action,
    commandHash: row.command_hash,
    commandPreview: row.command_preview,
    presentedFingerprint: row.presented_fingerprint,
    detail,
    approvalId: row.approval_id,
    grantId: row.grant_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    errorCode: row.error_code,
    bytesOut: row.bytes_out,
    truncated: row.truncated === 1,
  };
}

const HOST_SELECT = `
SELECT h.*, c.public_key, c.public_key_fingerprint, c.key_type, c.bits, c.validated_at,
       c.updated_at AS credential_updated_at
FROM ssh_hosts h
LEFT JOIN ssh_host_credentials c ON c.host_id = h.id
`;

export interface HostCredentialInput {
  cipher: string;
  nonce: string;
  publicKey: string;
  fingerprint: string;
  keyType: string;
  bits: number | null;
  validatedAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface CreateHostInput {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  requireApproval: boolean;
  approvalIdleSec: number;
  remoteRoot: string | null;
  createdAt: string;
  credential: HostCredentialInput;
}

export interface HostMetadataPatch {
  name: string;
  address: string;
  port: number;
  username: string;
  requireApproval: boolean;
  approvalIdleSec: number;
  remoteRoot: string | null;
  updatedAt: string;
}

export interface AppPath {
  projectId: string;
  appKey: string;
  rootPath: string;
  appPath: string;
}

export class SshStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  listHosts(): Array<{ host: SshHost; credential: SshCredentialStatus | null }> {
    const rows = this.#db.prepare(`${HOST_SELECT} ORDER BY h.name`).all() as HostRow[];
    return rows.map((row) => ({ host: hostFromRow(row), credential: credentialFromRow(row) }));
  }

  getHost(id: string): { host: SshHost; credential: SshCredentialStatus | null } | undefined {
    const row = this.#db.prepare(`${HOST_SELECT} WHERE h.id = ?`).get(id) as HostRow | undefined;
    return row === undefined
      ? undefined
      : { host: hostFromRow(row), credential: credentialFromRow(row) };
  }

  getHostByName(
    name: string,
  ): { host: SshHost; credential: SshCredentialStatus | null } | undefined {
    const row = this.#db.prepare(`${HOST_SELECT} WHERE h.name = ?`).get(name) as
      | HostRow
      | undefined;
    return row === undefined
      ? undefined
      : { host: hostFromRow(row), credential: credentialFromRow(row) };
  }

  createHost(input: CreateHostInput): void {
    const tx = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO ssh_hosts
           (id, name, address, port, username, require_approval, approval_idle_sec, remote_root,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.address,
          input.port,
          input.username,
          input.requireApproval ? 1 : 0,
          input.approvalIdleSec,
          input.remoteRoot,
          input.createdAt,
          input.createdAt,
        );
      this.upsertCredential(input.id, input.credential);
    });
    tx.immediate();
  }

  updateHostMetadata(id: string, patch: HostMetadataPatch): void {
    this.#db
      .prepare(
        `UPDATE ssh_hosts SET name = ?, address = ?, port = ?, username = ?, require_approval = ?,
         approval_idle_sec = ?, remote_root = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.name,
        patch.address,
        patch.port,
        patch.username,
        patch.requireApproval ? 1 : 0,
        patch.approvalIdleSec,
        patch.remoteRoot,
        patch.updatedAt,
        id,
      );
  }

  upsertCredential(hostId: string, credential: HostCredentialInput): void {
    this.#db
      .prepare(
        `INSERT INTO ssh_host_credentials
         (host_id, cipher, nonce, public_key, public_key_fingerprint, key_type, bits, validated_at,
          updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET
           cipher = excluded.cipher, nonce = excluded.nonce, public_key = excluded.public_key,
           public_key_fingerprint = excluded.public_key_fingerprint, key_type = excluded.key_type,
           bits = excluded.bits, validated_at = excluded.validated_at,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(
        hostId,
        credential.cipher,
        credential.nonce,
        credential.publicKey,
        credential.fingerprint,
        credential.keyType,
        credential.bits,
        credential.validatedAt,
        credential.updatedAt,
        credential.updatedBy,
      );
  }

  getCredential(hostId: string): { cipher: string; nonce: string } | undefined {
    return this.#db
      .prepare("SELECT cipher, nonce FROM ssh_host_credentials WHERE host_id = ?")
      .get(hostId) as { cipher: string; nonce: string } | undefined;
  }

  deleteHost(id: string): void {
    this.#db.prepare("DELETE FROM ssh_hosts WHERE id = ?").run(id);
  }

  clearPin(id: string, now: string): void {
    this.#db
      .prepare(
        `UPDATE ssh_hosts SET host_key = NULL, host_key_type = NULL, host_key_bits = NULL,
         host_key_fingerprint = NULL, host_key_pinned_at = NULL, pending_host_key = NULL,
         pending_host_key_type = NULL, pending_host_key_fingerprint = NULL,
         pending_host_key_at = NULL, host_key_mismatch_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
  }

  setPin(
    id: string,
    pin: { text: string; type: string; bits: number | null; fingerprint: string },
    now: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE ssh_hosts SET host_key = ?, host_key_type = ?, host_key_bits = ?,
         host_key_fingerprint = ?, host_key_pinned_at = ?, pending_host_key = NULL,
         pending_host_key_type = NULL, pending_host_key_fingerprint = NULL,
         pending_host_key_at = NULL, host_key_mismatch_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(pin.text, pin.type, pin.bits, pin.fingerprint, now, now, id);
  }

  pinIfUnset(
    id: string,
    pin: { text: string; type: string; bits: number | null; fingerprint: string },
    now: string,
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE ssh_hosts SET host_key = ?, host_key_type = ?, host_key_bits = ?,
         host_key_fingerprint = ?, host_key_pinned_at = ?, host_key_mismatch_at = NULL,
         updated_at = ? WHERE id = ? AND host_key IS NULL`,
      )
      .run(pin.text, pin.type, pin.bits, pin.fingerprint, now, now, id);
    return result.changes === 1;
  }

  setPendingObservation(
    id: string,
    observation: { text: string; type: string; fingerprint: string },
    now: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE ssh_hosts SET pending_host_key = ?, pending_host_key_type = ?,
         pending_host_key_fingerprint = ?, pending_host_key_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(observation.text, observation.type, observation.fingerprint, now, now, id);
  }

  getPendingObservation(id: string):
    | {
        text: string;
        type: string;
        fingerprint: string;
        at: string;
      }
    | undefined {
    const row = this.#db
      .prepare(
        `SELECT pending_host_key AS text, pending_host_key_type AS type,
         pending_host_key_fingerprint AS fingerprint, pending_host_key_at AS at
         FROM ssh_hosts WHERE id = ?`,
      )
      .get(id) as
      | { text: string | null; type: string | null; fingerprint: string | null; at: string | null }
      | undefined;
    if (
      row === undefined ||
      row.text === null ||
      row.type === null ||
      row.fingerprint === null ||
      row.at === null
    ) {
      return undefined;
    }
    return { text: row.text, type: row.type, fingerprint: row.fingerprint, at: row.at };
  }

  clearPendingObservation(id: string, now: string): void {
    this.#db
      .prepare(
        `UPDATE ssh_hosts SET pending_host_key = NULL, pending_host_key_type = NULL,
         pending_host_key_fingerprint = NULL, pending_host_key_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
  }

  markMismatch(id: string, fingerprint: string, now: string): void {
    this.#db
      .prepare("UPDATE ssh_hosts SET host_key_mismatch_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
    void fingerprint;
  }

  clearMismatch(id: string, now: string): void {
    this.#db
      .prepare("UPDATE ssh_hosts SET host_key_mismatch_at = NULL, updated_at = ? WHERE id = ?")
      .run(now, id);
  }

  listAppHosts(appId: string): SshHost[] {
    const rows = this.#db
      .prepare(
        `${HOST_SELECT} JOIN app_ssh_hosts a ON a.host_id = h.id
         WHERE a.app_id = ? ORDER BY h.name`,
      )
      .all(appId) as HostRow[];
    return rows.map(hostFromRow);
  }

  isAllowed(appId: string, hostId: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 AS ok FROM app_ssh_hosts WHERE app_id = ? AND host_id = ?")
        .get(appId, hostId) !== undefined
    );
  }

  replaceAppHosts(appId: string, hostIds: string[], actor: string, now: string): void {
    const tx = this.#db.transaction(() => {
      const existing = new Set(
        (
          this.#db.prepare("SELECT host_id FROM app_ssh_hosts WHERE app_id = ?").all(appId) as {
            host_id: string;
          }[]
        ).map((row) => row.host_id),
      );
      const next = new Set(hostIds);
      for (const hostId of existing) {
        if (!next.has(hostId)) {
          this.#db
            .prepare("DELETE FROM app_ssh_hosts WHERE app_id = ? AND host_id = ?")
            .run(appId, hostId);
          this.#db
            .prepare(
              "UPDATE ssh_grants SET revoked_at = ? WHERE app_id = ? AND host_id = ? AND revoked_at IS NULL",
            )
            .run(now, appId, hostId);
          this.#db
            .prepare(
              "UPDATE ssh_approvals SET status = 'expired' WHERE app_id = ? AND host_id = ? AND status = 'pending'",
            )
            .run(appId, hostId);
        }
      }
      for (const hostId of next) {
        if (!existing.has(hostId)) {
          this.#db
            .prepare(
              "INSERT INTO app_ssh_hosts (app_id, host_id, created_at, created_by) VALUES (?, ?, ?, ?)",
            )
            .run(appId, hostId, now, actor);
        }
      }
    });
    tx.immediate();
  }

  getGrant(id: string): SshGrant | undefined {
    const row = this.#db.prepare("SELECT * FROM ssh_grants WHERE id = ?").get(id) as
      | GrantRow
      | undefined;
    return row === undefined ? undefined : grantFromRow(row);
  }

  listGrants(appId: string): SshGrant[] {
    const rows = this.#db
      .prepare(`SELECT * FROM ssh_grants WHERE app_id = ? ORDER BY granted_at DESC`)
      .all(appId) as GrantRow[];
    return rows.map(grantFromRow);
  }

  activeGrant(appId: string, hostId: string, now: string): SshGrant | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM ssh_grants WHERE app_id = ? AND host_id = ? AND revoked_at IS NULL
         AND idle_expires_at > ? AND absolute_expires_at > ?
         ORDER BY granted_at DESC LIMIT 1`,
      )
      .get(appId, hostId, now, now) as GrantRow | undefined;
    return row === undefined ? undefined : grantFromRow(row);
  }

  createGrant(input: {
    id: string;
    appId: string;
    hostId: string;
    approvalId: string;
    grantedBy: string;
    grantedAt: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  }): SshGrant {
    this.#db
      .prepare(
        `INSERT INTO ssh_grants
         (id, app_id, host_id, approval_id, granted_by, granted_at, last_used_at,
          idle_expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.id,
        input.appId,
        input.hostId,
        input.approvalId,
        input.grantedBy,
        input.grantedAt,
        input.grantedAt,
        input.idleExpiresAt,
        input.absoluteExpiresAt,
      );
    const row = this.#db.prepare("SELECT * FROM ssh_grants WHERE id = ?").get(input.id) as GrantRow;
    return grantFromRow(row);
  }

  touchGrant(id: string, now: string, idleSec: number, absoluteExpiresAt: string): void {
    const idle = new Date(Date.parse(now) + idleSec * 1000).toISOString();
    const capped = Date.parse(idle) < Date.parse(absoluteExpiresAt) ? idle : absoluteExpiresAt;
    this.#db
      .prepare("UPDATE ssh_grants SET last_used_at = ?, idle_expires_at = ? WHERE id = ?")
      .run(now, capped, id);
  }

  revokeGrant(id: string, now: string): void {
    this.#db.prepare("UPDATE ssh_grants SET revoked_at = ? WHERE id = ?").run(now, id);
  }

  findPending(
    appId: string,
    hostId: string,
    action: SshAction,
    commandHash: string,
    now: string,
  ): SshApproval | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM ssh_approvals WHERE app_id = ? AND host_id = ? AND action = ?
         AND command_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1`,
      )
      .get(appId, hostId, action, commandHash, now) as ApprovalRow | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  createPending(input: {
    id: string;
    appId: string;
    hostId: string;
    action: SshAction;
    commandHash: string;
    commandPreview: string;
    commandBytes: number;
    now: string;
    expiresAt: string;
  }): SshApproval {
    const tx = this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE ssh_approvals SET status = 'expired'
           WHERE app_id = ? AND host_id = ? AND action = ? AND command_hash = ?
             AND status = 'pending' AND expires_at <= ?`,
        )
        .run(input.appId, input.hostId, input.action, input.commandHash, input.now);
      const existing = this.#db
        .prepare(
          `SELECT * FROM ssh_approvals WHERE app_id = ? AND host_id = ? AND action = ?
           AND command_hash = ? AND status = 'pending' AND expires_at > ? LIMIT 1`,
        )
        .get(input.appId, input.hostId, input.action, input.commandHash, input.now) as
        | ApprovalRow
        | undefined;
      if (existing !== undefined) {
        return approvalFromRow(existing);
      }
      const pending = this.#db
        .prepare(
          "SELECT COUNT(*) AS count FROM ssh_approvals WHERE app_id = ? AND status = 'pending' AND expires_at > ?",
        )
        .get(input.appId, input.now) as { count: number };
      if (pending.count >= PENDING_PER_APP) {
        throw new SshError(
          "ssh_rate_limited",
          "Too many pending SSH approvals for this application",
        );
      }
      const since = new Date(Date.parse(input.now) - 3600_000).toISOString();
      const requests = this.#db
        .prepare(
          "SELECT COUNT(*) AS count FROM ssh_approvals WHERE app_id = ? AND requested_at > ?",
        )
        .get(input.appId, since) as { count: number };
      if (requests.count >= APPROVAL_REQUESTS_PER_HOUR) {
        throw new SshError(
          "ssh_rate_limited",
          "Too many SSH approval requests for this application",
        );
      }
      const cooldown = new Date(Date.parse(input.now) - REJECT_COOLDOWN_SEC * 1000).toISOString();
      const rejected = this.#db
        .prepare(
          `SELECT 1 AS found FROM ssh_approvals WHERE app_id = ? AND host_id = ?
           AND status = 'rejected' AND decided_at > ? LIMIT 1`,
        )
        .get(input.appId, input.hostId, cooldown);
      if (rejected !== undefined) {
        throw new SshError("ssh_rate_limited", "The previous SSH request was rejected recently");
      }
      this.#db
        .prepare(
          `INSERT INTO ssh_approvals
           (id, app_id, host_id, action, command_hash, command_preview, command_bytes, status,
            requested_at, expires_at, decided_at, decided_by, grant_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          input.id,
          input.appId,
          input.hostId,
          input.action,
          input.commandHash,
          input.commandPreview,
          input.commandBytes,
          input.now,
          input.expiresAt,
        );
      const row = this.#db
        .prepare("SELECT * FROM ssh_approvals WHERE id = ?")
        .get(input.id) as ApprovalRow;
      return approvalFromRow(row);
    });
    try {
      return tx.immediate();
    } catch (error) {
      if (error instanceof SshError) {
        throw error;
      }
      if (String(error).includes("SQLITE_BUSY")) {
        throw new SshError("ssh_busy", "The coordinator is busy; retry the request");
      }
      throw error;
    }
  }

  getApproval(id: string): SshApproval | undefined {
    const row = this.#db.prepare("SELECT * FROM ssh_approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row === undefined ? undefined : approvalFromRow(row);
  }

  decideApproval(input: {
    id: string;
    appId: string;
    decision: "approve" | "reject";
    actor: string;
    now: string;
    idleSec: number;
    grantId: string;
  }): SshApproval {
    const tx = this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM ssh_approvals WHERE id = ?").get(input.id) as
        | ApprovalRow
        | undefined;
      if (row === undefined || row.app_id !== input.appId) {
        throw new SshError("ssh_approval_expired", "The SSH approval was not found");
      }
      const target = input.decision === "approve" ? "approved" : "rejected";
      if (row.status === target) {
        return approvalFromRow(row);
      }
      if (row.status !== "pending") {
        throw new SshError("ssh_approval_expired", "The SSH approval is no longer pending");
      }
      if (row.expires_at <= input.now) {
        this.#db.prepare("UPDATE ssh_approvals SET status = 'expired' WHERE id = ?").run(input.id);
        throw new SshError("ssh_approval_expired", "The SSH approval expired");
      }
      this.#db
        .prepare(
          "UPDATE ssh_approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
        )
        .run(target, input.now, input.actor, input.id);
      if (input.decision === "approve") {
        const idleExpiresAt = new Date(Date.parse(input.now) + input.idleSec * 1000).toISOString();
        const absoluteExpiresAt = new Date(
          Date.parse(input.now) + ABSOLUTE_GRANT_SEC * 1000,
        ).toISOString();
        this.createGrant({
          id: input.grantId,
          appId: row.app_id,
          hostId: row.host_id,
          approvalId: row.id,
          grantedBy: input.actor,
          grantedAt: input.now,
          idleExpiresAt,
          absoluteExpiresAt,
        });
        this.#db
          .prepare("UPDATE ssh_approvals SET grant_id = ? WHERE id = ?")
          .run(input.grantId, input.id);
        this.#db
          .prepare(
            `UPDATE ssh_approvals SET status = 'superseded'
             WHERE app_id = ? AND host_id = ? AND status = 'pending' AND id <> ?`,
          )
          .run(row.app_id, row.host_id, row.id);
      }
      return approvalFromRow(
        this.#db.prepare("SELECT * FROM ssh_approvals WHERE id = ?").get(input.id) as ApprovalRow,
      );
    });
    try {
      return tx.immediate();
    } catch (error) {
      if (error instanceof SshError) {
        throw error;
      }
      if (String(error).includes("SQLITE_BUSY")) {
        throw new SshError("ssh_busy", "The coordinator is busy; retry the request");
      }
      throw error;
    }
  }

  listPending(appId?: string, now = new Date().toISOString()): SshApprovalView[] {
    const rows = this.#db
      .prepare(
        `SELECT a.*, h.name AS host_name, h.address, h.username, app.app_key, p.id AS project_id
         FROM ssh_approvals a
         JOIN ssh_hosts h ON h.id = a.host_id
         JOIN apps app ON app.id = a.app_id
         JOIN projects p ON p.id = app.project_id
         WHERE a.status = 'pending' AND a.expires_at > ?
           ${appId === undefined ? "" : "AND a.app_id = ?"}
         ORDER BY a.requested_at ASC`,
      )
      .all(...(appId === undefined ? [now] : [now, appId])) as Array<
      ApprovalRow & {
        host_name: string;
        address: string;
        username: string;
        app_key: string;
        project_id: string;
      }
    >;
    return rows.map((row) => ({
      ...approvalFromRow(row),
      hostName: row.host_name,
      address: row.address,
      username: row.username,
      appKey: row.app_key,
      projectId: row.project_id,
    }));
  }

  countPending(now = new Date().toISOString()): number {
    const row = this.#db
      .prepare(
        "SELECT COUNT(*) AS count FROM ssh_approvals WHERE status = 'pending' AND expires_at > ?",
      )
      .get(now) as { count: number };
    return row.count;
  }

  countApprovalsSince(appId: string, since: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS count FROM ssh_approvals WHERE app_id = ? AND requested_at > ?")
      .get(appId, since) as { count: number };
    return row.count;
  }

  countOperationsSince(appId: string, hostId: string, since: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS count FROM ssh_audit WHERE app_id = ? AND host_id = ?
         AND action IN ('exec', 'upload', 'download') AND started_at > ?`,
      )
      .get(appId, hostId, since) as { count: number };
    return row.count;
  }

  startAudit(input: {
    appId: string;
    projectId: string;
    appKey: string;
    hostId: string;
    hostName: string;
    address: string;
    username: string;
    action: string;
    commandHash: string | null;
    commandPreview: string | null;
    approvalId: string | null;
    grantId: string | null;
    startedAt: string;
  }): number {
    const result = this.#db
      .prepare(
        `INSERT INTO ssh_audit
         (app_id, project_id, app_key, host_id, host_name, address, username, action,
          command_hash, command_preview, presented_fingerprint, detail_json, approval_id, grant_id,
          started_at, finished_at, exit_code, error_code, bytes_out, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
      )
      .run(
        input.appId,
        input.projectId,
        input.appKey,
        input.hostId,
        input.hostName,
        input.address,
        input.username,
        input.action,
        input.commandHash,
        input.commandPreview,
        input.approvalId,
        input.grantId,
        input.startedAt,
      );
    return Number(result.lastInsertRowid);
  }

  finishAudit(
    id: number,
    patch: {
      finishedAt: string;
      exitCode?: number | null;
      errorCode?: string | null;
      bytesOut?: number | null;
      truncated?: boolean;
      presentedFingerprint?: string | null;
      detail?: Record<string, unknown> | null;
    },
  ): void {
    this.#db
      .prepare(
        `UPDATE ssh_audit SET finished_at = ?, exit_code = ?, error_code = ?, bytes_out = ?,
         truncated = ?, presented_fingerprint = COALESCE(?, presented_fingerprint),
         detail_json = COALESCE(?, detail_json) WHERE id = ?`,
      )
      .run(
        patch.finishedAt,
        patch.exitCode ?? null,
        patch.errorCode ?? null,
        patch.bytesOut ?? null,
        patch.truncated === true ? 1 : 0,
        patch.presentedFingerprint ?? null,
        patch.detail === undefined || patch.detail === null ? null : JSON.stringify(patch.detail),
        id,
      );
  }

  markOrphaned(now: string): void {
    this.#db
      .prepare(
        "UPDATE ssh_audit SET finished_at = ?, error_code = 'interrupted' WHERE finished_at IS NULL",
      )
      .run(now);
  }

  listAudit(limit = 50, before?: number, appId?: string): SshAuditEntry[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM ssh_audit
         WHERE (? IS NULL OR id < ?) ${appId === undefined ? "" : "AND app_id = ?"}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(
        ...(appId === undefined
          ? [before ?? null, before ?? null, limit]
          : [before ?? null, before ?? null, appId, limit]),
      ) as AuditRow[];
    return rows.map(auditFromRow);
  }

  getAppPath(appId: string): AppPath | undefined {
    const row = this.#db
      .prepare(
        `SELECT a.project_id AS projectId, a.app_key AS appKey, a.path AS appPath,
         p.root_path AS rootPath
         FROM apps a JOIN projects p ON p.id = a.project_id WHERE a.id = ?`,
      )
      .get(appId) as AppPath | undefined;
    return row;
  }
}
