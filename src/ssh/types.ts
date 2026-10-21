import type { AgentTokenIdentity } from "../mcp/agent-tokens.js";

export const IDLE_DEFAULT_SEC = 1800;
export const IDLE_MIN_SEC = 300;
export const IDLE_MAX_SEC = 7200;
export const ABSOLUTE_GRANT_SEC = 8 * 3600;
export const PENDING_APPROVAL_SEC = 300;
export const APPROVAL_WAIT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 300_000;
export const MCP_TIMEOUT_MS = 600_000;
export const CONNECT_TIMEOUT_MS = 15_000;
export const COMMAND_DEFAULT_SEC = 60;
export const COMMAND_MAX_SEC = 300;
export const COMMAND_MAX_BYTES = 16 * 1024;
export const OUTPUT_CAP_BYTES = 64 * 1024;
export const AUDIT_PREVIEW_BYTES = 4 * 1024;
export const FILE_CAP_BYTES = 50 * 1024 * 1024;
export const PENDING_PER_APP = 10;
export const APPROVAL_REQUESTS_PER_HOUR = 10;
export const REJECT_COOLDOWN_SEC = 60;
export const OPERATIONS_PER_HOUR = 60;
export const WAITERS_PER_APPROVAL = 2;
export const GLOBAL_INFLIGHT = 4;
export const PER_HOST_INFLIGHT = 1;
export const BUSY_WAIT_MS = 5_000;
export const PENDING_HOST_KEY_SEC = 600;

export type SshAction = "exec" | "upload" | "download";
export type SshApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "superseded";

export type SshErrorCode =
  | "ssh_host_not_allowed"
  | "ssh_credential_unavailable"
  | "ssh_auth_failed"
  | "ssh_host_key_mismatch"
  | "ssh_connect_timeout"
  | "ssh_command_timeout"
  | "ssh_transfer_timeout"
  | "ssh_transport_error"
  | "ssh_path_not_allowed"
  | "ssh_file_too_large"
  | "ssh_invalid_argument"
  | "ssh_approval_pending"
  | "ssh_approval_rejected"
  | "ssh_approval_expired"
  | "ssh_busy"
  | "ssh_rate_limited"
  | "ssh_audit_failed"
  | "ssh_unavailable";

export class SshError extends Error {
  readonly code: SshErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: SshErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SshError";
    this.code = code;
    this.details = details;
  }
}

export interface SshHost {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  hostKey: string | null;
  hostKeyType: string | null;
  hostKeyBits: number | null;
  hostKeyFingerprint: string | null;
  hostKeyPinnedAt: string | null;
  hostKeyMismatchAt: string | null;
  requireApproval: boolean;
  approvalIdleSec: number;
  remoteRoot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SshCredentialStatus {
  publicKey: string;
  fingerprint: string;
  keyType: string;
  bits: number | null;
  validatedAt: string;
  updatedAt: string;
}

export interface SshHostView extends SshHost {
  credential: SshCredentialStatus | null;
  allowed: boolean;
  grant: SshGrant | null;
  pendingApprovals: number;
}

export interface SshGrant {
  id: string;
  appId: string;
  hostId: string;
  approvalId: string;
  grantedBy: string;
  grantedAt: string;
  lastUsedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
}

export interface SshApproval {
  id: string;
  appId: string;
  hostId: string;
  action: SshAction;
  commandHash: string;
  commandPreview: string;
  commandBytes: number;
  status: SshApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  grantId: string | null;
}

export interface SshApprovalView extends SshApproval {
  hostName: string;
  address: string;
  username: string;
  appKey: string;
  projectId: string;
}

export interface SshAuditEntry {
  id: number;
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
  presentedFingerprint: string | null;
  detail: Record<string, unknown> | null;
  approvalId: string | null;
  grantId: string | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  errorCode: string | null;
  bytesOut: number | null;
  truncated: boolean;
}

export interface SshExecInput {
  hostId: string;
  command: string;
  timeoutSec?: number;
}

export interface SshUploadInput {
  hostId: string;
  localPath: string;
  remotePath: string;
}

export interface SshDownloadInput {
  hostId: string;
  remotePath: string;
  localPath: string;
}

export interface SshExecResult {
  ok: true;
  host: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  duration_ms: number;
}

export interface SshTransferResult {
  ok: true;
  host: string;
  bytes: number;
  path: string;
}

export interface SshApprovalPendingResult {
  ok: false;
  code: "ssh_approval_pending";
  approval_id: string;
  expires_at: string;
  message: string;
}

export type SshOperationResult = SshExecResult | SshTransferResult | SshApprovalPendingResult;

export interface SshTestResult {
  ok: boolean;
  authOk: boolean;
  code?: SshErrorCode;
  message?: string;
  fingerprint?: string;
  previousFingerprint?: string | null;
  mismatch?: boolean;
  serverBanner?: string;
}

export interface SshAgent {
  agent: AgentTokenIdentity;
}

export type SshActionRequest = {
  action: SshAction;
  commandHash: string;
  commandPreview: string;
  commandBytes: number;
};
