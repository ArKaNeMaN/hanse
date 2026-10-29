/**
 * Structural mirror of `src/http/props/ssh.ts` for the client.
 *
 * `GET /api/ui/ssh` and the boot payload share this shape. Keeping the mirror in the client avoids
 * importing server code into the Vite bundle. The private key is not part of this contract: the
 * props only expose the derived public-key status, and the dialog keeps the write-only input local.
 */

import type { BootChrome } from "./boot.js";

export type SshPinState = "pinned" | "unpinned" | "mismatch";
export type SshGrantState = "active" | "expired" | "revoked";
export type SshAuditOutcome = "running" | "error" | "ok" | "exit" | "recorded";
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

export interface SshScopeOption {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface SshScopeGroup {
  readonly label: string;
  readonly options: readonly SshScopeOption[];
}

export interface SshScope {
  readonly projectId: string;
  readonly appKey: string;
  readonly appId: string | null;
  readonly projectName: string | null;
  readonly scoped: boolean;
  readonly href: string;
  readonly hostsHref: string;
  readonly accessHref: string;
  readonly approvalsHref: string;
  readonly auditHref: string;
  readonly settingsHref: string;
  readonly options: readonly SshScopeGroup[];
}

export interface SshHostCredential {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly keyType: string;
  readonly bits: number | null;
  readonly validatedAt: string;
  readonly updatedAt: string;
}

export interface SshHostActions {
  readonly api: {
    readonly host: string;
    readonly test: string;
    readonly update: string;
    readonly delete: string;
    readonly rePin: string;
  };
  readonly form: {
    readonly test: string;
    readonly update: string;
    readonly delete: string;
    readonly rePin: string;
  };
}

export interface SshGrantActions {
  readonly api: { readonly revoke: string };
  readonly form: { readonly revoke: string };
}

export interface SshGrant {
  readonly id: string;
  readonly appId: string;
  readonly appKey: string;
  readonly projectId: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly approvalId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly lastUsedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
  readonly state: SshGrantState;
  readonly canRevoke: boolean;
  readonly actions: SshGrantActions;
}

export interface SshHost {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly username: string;
  readonly port: number;
  readonly remoteRoot: string | null;
  readonly requireApproval: boolean;
  readonly approvalIdleSec: number;
  readonly hostKeyFingerprint: string | null;
  readonly hostKeyPinnedAt: string | null;
  readonly hostKeyMismatchAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly credential: SshHostCredential | null;
  readonly allowed: boolean;
  readonly grant: SshGrant | null;
  readonly pendingApprovals: number;
  readonly pinState: SshPinState;
  readonly status: SshPinState;
  readonly anchor: string;
  readonly returnTo: string;
  readonly actions: SshHostActions;
}

export interface SshApprovalActions {
  readonly api: {
    readonly approve: string;
    readonly reject: string;
  };
  readonly form: {
    readonly approve: string;
    readonly reject: string;
  };
  readonly returnTo: string;
}

export interface SshApproval {
  readonly id: string;
  readonly appId: string;
  readonly appKey: string;
  readonly projectId: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly address: string;
  readonly username: string;
  readonly action: string;
  readonly commandHash: string;
  readonly commandPreview: string;
  readonly commandBytes: number;
  readonly status: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly grantId: string | null;
  readonly actions: SshApprovalActions;
}

export interface SshAuditEntry {
  readonly id: number;
  readonly appId: string;
  readonly projectId: string;
  readonly appKey: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly address: string;
  readonly username: string;
  readonly action: string;
  readonly commandPreview: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly errorCode: string | null;
  readonly outcome: SshAuditOutcome;
}

export interface SshCounts {
  readonly hosts: number;
  readonly pinned: number;
  readonly unpinned: number;
  readonly mismatch: number;
  readonly pendingApprovals: number;
  readonly activeGrants: number;
  readonly grants: number;
  readonly allowedHosts: number;
  readonly auditRows: number;
}

export interface SshPolicy {
  readonly idleOptions: readonly number[];
  readonly idleDefaultSec: number;
  readonly idleMinSec: number;
  readonly idleMaxSec: number;
  readonly absoluteGrantSec: number;
  readonly pendingApprovalSec: number;
  readonly auditLimit: number;
}

export interface SshActions {
  readonly createHost: string;
  readonly refresh: string;
  readonly saveGrants: string | null;
  readonly audit: string;
  readonly form: {
    readonly createHost: string;
    readonly saveGrants: string;
  };
  readonly api: {
    readonly hosts: string;
    readonly approvalsCount: string;
    readonly appApprovals: string | null;
    readonly audit: string | null;
    readonly grants: string | null;
  };
}

export interface SshEmptyState {
  readonly iconName: string;
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string | null;
}

export interface SshLabels {
  readonly title: string;
  readonly description: string;
  readonly nav: {
    readonly ariaLabel: string;
    readonly sectionsLabel: string;
    readonly hosts: string;
    readonly access: string;
    readonly approvals: string;
    readonly audit: string;
    readonly scope: string;
    readonly apply: string;
    readonly allApplications: string;
  };
  readonly actions: {
    readonly addHost: string;
    readonly editHost: string;
    readonly test: string;
    readonly prepareRePin: string;
    readonly rePin: string;
    readonly refresh: string;
    readonly saveAllowlist: string;
    readonly revoke: string;
    readonly approve: string;
    readonly reject: string;
    readonly saveHost: string;
    readonly deleteHost: string;
    readonly cancel: string;
  };
  readonly empty: {
    readonly hosts: SshEmptyState;
    readonly grants: string;
    readonly chooseApplication: SshEmptyState;
    readonly approvals: SshEmptyState;
    readonly audit: SshEmptyState;
  };
}

export interface SshTestResult {
  readonly hostId: string;
  readonly hostName: string;
  readonly ok: boolean;
  readonly authOk: boolean;
  readonly code?: SshErrorCode;
  readonly message?: string;
  readonly fingerprint?: string;
  readonly previousFingerprint?: string | null;
  readonly mismatch?: boolean;
  readonly serverBanner?: string;
  readonly prepareRePin: boolean;
}

export interface SshPageError {
  readonly message: string;
  readonly target: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface SshAddDialog {
  readonly open: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly action: string;
  readonly returnTo: string;
}

export interface SshEditDialog {
  readonly hostId: string;
  readonly open: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly action: string;
  readonly deleteAction: string;
  readonly returnTo: string;
  readonly deleteReturnTo: string;
}

export interface SshDialogs {
  readonly add: SshAddDialog;
  readonly edits: readonly SshEditDialog[];
}

export interface SshProps {
  readonly scope: SshScope;
  readonly hosts: readonly SshHost[];
  readonly grants: readonly SshGrant[];
  readonly approvals: readonly SshApproval[];
  readonly audit: readonly SshAuditEntry[];
  readonly counts: SshCounts;
  readonly policy: SshPolicy;
  readonly actions: SshActions;
  readonly labels: SshLabels;
  readonly test: SshTestResult | null;
  readonly error: SshPageError | null;
  readonly dialogs: SshDialogs;
}

export interface SshResponse extends SshProps {
  readonly chrome?: BootChrome;
}

export interface SshTestResponse {
  readonly result: Omit<SshTestResult, "hostId" | "hostName" | "prepareRePin">;
}
