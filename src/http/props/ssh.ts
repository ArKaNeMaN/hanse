/**
 * Page props for the SSH console (`/ssh`).
 *
 * `buildSshProps` is the single assembly used by the legacy `renderPage` and by
 * `GET /api/ui/ssh`, so the two renderers cannot drift. It reads host metadata, host-key pins,
 * per-application allowlists/grants, pending approvals, and audit rows, and returns the action
 * URLs and labels the SPA needs.
 *
 * The private key is write-only: this module only exposes the derived public-key status
 * (`SshCredentialStatus`) and never reads the sealed cipher/nonce or the original key material.
 */

import type { AgentTokenIdentity } from "../../mcp/agent-tokens.js";
import {
  ABSOLUTE_GRANT_SEC,
  IDLE_DEFAULT_SEC,
  IDLE_MAX_SEC,
  IDLE_MIN_SEC,
  PENDING_APPROVAL_SEC,
  type SshApprovalView,
  type SshAuditEntry,
  type SshErrorCode,
  type SshGrant,
  type SshHost,
  type SshHostView,
  type SshTestResult,
} from "../../ssh/types.js";
import { findApp } from "../apps.js";
import type { SiteModel } from "../dashboard.js";
import type { HttpDeps } from "../handler.js";

export const SSH_AUDIT_LIMIT = 30;
export const SSH_IDLE_OPTIONS: readonly number[] = [300, 900, 1800, 3600, 7200];

export type SshPinState = "pinned" | "unpinned" | "mismatch";
export type SshGrantState = "active" | "expired" | "revoked";
export type SshAuditOutcome = "running" | "error" | "ok" | "exit" | "recorded";

export interface SshSource {
  listAllHosts(): Array<{ host: SshHost; credential: SshHostView["credential"] }>;
  listHosts(agent: AgentTokenIdentity): SshHostView[];
  listGrants(appId: string): SshGrant[];
  listPending(appId?: string): SshApprovalView[];
  listAudit(appId?: string, limit?: number, before?: number): SshAuditEntry[];
}

export interface SshScopeQuery {
  readonly target?: string;
  readonly project?: string;
  readonly app?: string;
}

export interface SshScopeSelection {
  readonly projectId: string;
  readonly appKey: string;
  readonly appId: string | null;
  readonly projectName: string | null;
}

export interface SshScopeOptionProps {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface SshScopeGroupProps {
  readonly label: string;
  readonly options: readonly SshScopeOptionProps[];
}

export interface SshScopeProps extends SshScopeSelection {
  readonly scoped: boolean;
  readonly href: string;
  readonly hostsHref: string;
  readonly accessHref: string;
  readonly approvalsHref: string;
  readonly auditHref: string;
  readonly settingsHref: string;
  readonly options: readonly SshScopeGroupProps[];
}

export interface SshHostCredentialProps {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly keyType: string;
  readonly bits: number | null;
  readonly validatedAt: string;
  readonly updatedAt: string;
}

export interface SshHostActionsProps {
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

export interface SshGrantActionsProps {
  readonly api: {
    readonly revoke: string;
  };
  readonly form: {
    readonly revoke: string;
  };
}

export interface SshGrantProps {
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
  readonly actions: SshGrantActionsProps;
}

export interface SshHostProps {
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
  readonly credential: SshHostCredentialProps | null;
  readonly allowed: boolean;
  readonly grant: SshGrantProps | null;
  readonly pendingApprovals: number;
  readonly pinState: SshPinState;
  readonly status: SshPinState;
  readonly anchor: string;
  readonly returnTo: string;
  readonly actions: SshHostActionsProps;
}

export interface SshApprovalActionsProps {
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

export interface SshApprovalProps {
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
  readonly actions: SshApprovalActionsProps;
}

export interface SshAuditProps {
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

export interface SshCountsProps {
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

export interface SshPolicyProps {
  readonly idleOptions: readonly number[];
  readonly idleDefaultSec: number;
  readonly idleMinSec: number;
  readonly idleMaxSec: number;
  readonly absoluteGrantSec: number;
  readonly pendingApprovalSec: number;
  readonly auditLimit: number;
}

export interface SshActionsProps {
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

export interface SshEmptyStateProps {
  readonly iconName: string;
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string | null;
}

export interface SshLabelProps {
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
    readonly hosts: SshEmptyStateProps;
    readonly grants: string;
    readonly chooseApplication: SshEmptyStateProps;
    readonly approvals: SshEmptyStateProps;
    readonly audit: SshEmptyStateProps;
  };
}

export interface SshTestProps {
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

export interface SshPageErrorProps {
  readonly message: string;
  readonly target: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface SshAddDialogProps {
  readonly open: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly action: string;
  readonly returnTo: string;
}

export interface SshEditDialogProps {
  readonly hostId: string;
  readonly open: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly error: string | null;
  readonly action: string;
  readonly deleteAction: string;
  readonly returnTo: string;
  readonly deleteReturnTo: string;
}

export interface SshDialogsProps {
  readonly add: SshAddDialogProps;
  readonly edits: readonly SshEditDialogProps[];
}

export interface SshProps {
  readonly scope: SshScopeProps;
  readonly hosts: readonly SshHostProps[];
  readonly grants: readonly SshGrantProps[];
  readonly approvals: readonly SshApprovalProps[];
  readonly audit: readonly SshAuditProps[];
  readonly counts: SshCountsProps;
  readonly policy: SshPolicyProps;
  readonly actions: SshActionsProps;
  readonly labels: SshLabelProps;
  readonly test: SshTestProps | null;
  readonly error: SshPageErrorProps | null;
  readonly dialogs: SshDialogsProps;
}

export interface SshPageExtra {
  readonly test?: SshTestResult & {
    readonly hostId: string;
    readonly hostName: string;
    readonly prepareRePin?: boolean;
  };
  readonly error?: {
    readonly message: string;
    readonly target: string;
    readonly values?: Record<string, string>;
  };
  readonly openAdd?: boolean;
}

export interface SshBuildInput {
  readonly ssh: SshSource;
  readonly site: SiteModel;
  readonly scope: SshScopeSelection;
  readonly test?: SshPageExtra["test"];
  readonly error?: SshPageExtra["error"];
  readonly openAdd?: boolean;
  readonly now?: Date;
}

export function sshScopePath(projectId: string, appKey: string, hash?: string): string {
  const base =
    projectId.length > 0 && appKey.length > 0
      ? `/ssh?target=${encodeURIComponent(`${projectId}:${appKey}`)}`
      : "/ssh";
  return hash === undefined ? base : `${base}${hash}`;
}

/** Resolve the optional `?target=|?project=&app=` scope, discarding unknown applications. */
export function resolveSshScope(
  deps: Pick<HttpDeps, "getProjects">,
  query?: SshScopeQuery,
): SshScopeSelection {
  const target = query?.target ?? "";
  let projectId = query?.project ?? "";
  let appKey = query?.app ?? "";
  if (target.length > 0) {
    const separator = target.indexOf(":");
    if (separator > 0) {
      projectId = target.slice(0, separator);
      appKey = target.slice(separator + 1);
    }
  }
  const found =
    projectId.length > 0 && appKey.length > 0 ? findApp(deps, projectId, appKey) : undefined;
  if (found === undefined) {
    return { projectId: "", appKey: "", appId: null, projectName: null };
  }
  return {
    projectId: found.project.id,
    appKey: found.app.appKey,
    appId: found.app.id,
    projectName: found.project.name,
  };
}

function pinState(host: SshHost): SshPinState {
  if (host.hostKeyMismatchAt !== null) return "mismatch";
  return host.hostKeyFingerprint === null ? "unpinned" : "pinned";
}

function grantState(grant: SshGrant, nowMs: number): SshGrantState {
  if (grant.revokedAt !== null) return "revoked";
  if (Date.parse(grant.idleExpiresAt) <= nowMs || Date.parse(grant.absoluteExpiresAt) <= nowMs) {
    return "expired";
  }
  return "active";
}

function auditOutcome(entry: SshAuditEntry): SshAuditOutcome {
  if (entry.finishedAt === null) return "running";
  if (entry.errorCode !== null) return "error";
  if (entry.exitCode === 0) return "ok";
  if (entry.exitCode !== null) return "exit";
  return "recorded";
}

function appKeyFor(site: SiteModel, appId: string): string {
  return site.apps.get(appId)?.appKey ?? appId.split(":").pop() ?? appId;
}

const LABELS: SshLabelProps = {
  title: "SSH hosts",
  description:
    "Coordinator-held keys, host-key pinning, per-application grants, approvals, and audit.",
  nav: {
    ariaLabel: "SSH console",
    sectionsLabel: "SSH sections",
    hosts: "Hosts",
    access: "Access",
    approvals: "Approvals",
    audit: "Audit",
    scope: "Application scope",
    apply: "Apply",
    allApplications: "All applications",
  },
  actions: {
    addHost: "Add host",
    editHost: "Edit host",
    test: "Test connection",
    prepareRePin: "Prepare re-pin",
    rePin: "Re-pin host key",
    refresh: "Refresh",
    saveAllowlist: "Save allowlist",
    revoke: "Revoke",
    approve: "Approve",
    reject: "Reject",
    saveHost: "Save host",
    deleteHost: "Delete host",
    cancel: "Cancel",
  },
  empty: {
    hosts: {
      iconName: "terminal",
      title: "No SSH hosts yet",
      body: "Add a host to hold its key in the coordinator, pin its host key, and grant access per application.",
      actionLabel: "Add host",
    },
    grants: "No grants yet. Approving a pending request creates an idle grant.",
    chooseApplication: {
      iconName: "lock",
      title: "Choose an application",
      body: "Access is scoped to one application. Use the Application scope picker above to view its allowlist, grants, approvals, and audit.",
      actionLabel: null,
    },
    approvals: {
      iconName: "inbox",
      title: "No pending approvals",
      body: "Requests appear here and in chat. Each request expires after 5 minutes.",
      actionLabel: null,
    },
    audit: {
      iconName: "activity",
      title: "No SSH activity yet",
      body: "Tests, commands, uploads, and downloads are recorded here with their result.",
      actionLabel: null,
    },
  },
};

function buildScope(site: SiteModel, selection: SshScopeSelection): SshScopeProps {
  const scoped = selection.appId !== null;
  const href = sshScopePath(selection.projectId, selection.appKey);
  const options: SshScopeGroupProps[] = [];
  for (const project of site.projects) {
    if (project.apps.length === 0) continue;
    options.push({
      label: project.name,
      options: project.apps.map((app) => ({
        value: `${project.id}:${app.appKey}`,
        label: `${project.name} / ${app.appKey}`,
        selected: selection.projectId === project.id && selection.appKey === app.appKey,
      })),
    });
  }
  const appSettings =
    scoped && selection.projectId.length > 0 && selection.appKey.length > 0
      ? `/projects/${encodeURIComponent(selection.projectId)}/apps/${encodeURIComponent(selection.appKey)}/settings`
      : "/settings";
  return {
    ...selection,
    scoped,
    href,
    hostsHref: `${href}#ssh-hosts`,
    accessHref: `${href}#ssh-access`,
    approvalsHref: `${href}#ssh-approvals`,
    auditHref: `${href}#ssh-audit`,
    settingsHref: appSettings,
    options,
  };
}

export function buildSshProps(input: SshBuildInput): SshProps {
  const { ssh, site, scope: selection } = input;
  const nowMs = (input.now ?? new Date()).getTime();
  const scope = buildScope(site, selection);
  const found = selection.appId;

  const views =
    found === null
      ? []
      : ssh.listHosts({
          appId: found,
          projectId: selection.projectId,
          appKey: selection.appKey,
        });
  const viewById = new Map(views.map((view) => [view.id, view]));
  const allowed = new Set(views.map((view) => view.id));
  const rawGrants = found === null ? [] : ssh.listGrants(found);
  const rawApprovals = ssh.listPending(found ?? undefined);
  const rawAudit = ssh.listAudit(found ?? undefined, SSH_AUDIT_LIMIT);
  const allHosts = ssh.listAllHosts();
  const hostNames = new Map(allHosts.map(({ host }) => [host.id, host.name]));

  const grants: SshGrantProps[] = rawGrants.map((grant) => ({
    id: grant.id,
    appId: grant.appId,
    appKey: appKeyFor(site, grant.appId),
    projectId: site.apps.get(grant.appId)?.projectId ?? "",
    hostId: grant.hostId,
    hostName: hostNames.get(grant.hostId) ?? "Unknown host",
    approvalId: grant.approvalId,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    lastUsedAt: grant.lastUsedAt,
    idleExpiresAt: grant.idleExpiresAt,
    absoluteExpiresAt: grant.absoluteExpiresAt,
    revokedAt: grant.revokedAt,
    state: grantState(grant, nowMs),
    canRevoke: grant.revokedAt === null,
    actions: {
      api: {
        revoke: `/api/projects/${encodeURIComponent(site.apps.get(grant.appId)?.projectId ?? "")}/apps/${encodeURIComponent(appKeyFor(site, grant.appId))}/ssh/grants/${encodeURIComponent(grant.id)}/revoke`,
      },
      form: { revoke: `/ssh/grants/${encodeURIComponent(grant.id)}/revoke` },
    },
  }));
  const grantById = new Map(grants.map((grant) => [grant.id, grant]));

  const approvals: SshApprovalProps[] = rawApprovals.map((approval) => ({
    id: approval.id,
    appId: approval.appId,
    appKey: approval.appKey,
    projectId: approval.projectId,
    hostId: approval.hostId,
    hostName: approval.hostName,
    address: approval.address,
    username: approval.username,
    action: approval.action,
    commandHash: approval.commandHash,
    commandPreview: approval.commandPreview,
    commandBytes: approval.commandBytes,
    status: approval.status,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy,
    grantId: approval.grantId,
    actions: {
      api: {
        approve: `/api/apps/${encodeURIComponent(approval.appKey)}/ssh/approvals/${encodeURIComponent(approval.id)}/decision?project=${encodeURIComponent(approval.projectId)}`,
        reject: `/api/apps/${encodeURIComponent(approval.appKey)}/ssh/approvals/${encodeURIComponent(approval.id)}/decision?project=${encodeURIComponent(approval.projectId)}`,
      },
      form: {
        approve: `/ssh/approvals/${encodeURIComponent(approval.id)}/decision`,
        reject: `/ssh/approvals/${encodeURIComponent(approval.id)}/decision`,
      },
      returnTo: scope.approvalsHref,
    },
  }));

  const audit: SshAuditProps[] = rawAudit.map((entry) => ({
    id: entry.id,
    appId: entry.appId,
    projectId: entry.projectId,
    appKey: entry.appKey,
    hostId: entry.hostId,
    hostName: entry.hostName,
    address: entry.address,
    username: entry.username,
    action: entry.action,
    commandPreview: entry.commandPreview,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    exitCode: entry.exitCode,
    errorCode: entry.errorCode,
    outcome: auditOutcome(entry),
  }));

  const hosts: SshHostProps[] = allHosts.map(({ host, credential }) => {
    const view = viewById.get(host.id);
    const activeGrant = view?.grant ?? null;
    const state = pinState(host);
    const id = encodeURIComponent(host.id);
    return {
      id: host.id,
      name: host.name,
      address: host.address,
      username: host.username,
      port: host.port,
      remoteRoot: host.remoteRoot,
      requireApproval: host.requireApproval,
      approvalIdleSec: host.approvalIdleSec,
      hostKeyFingerprint: host.hostKeyFingerprint,
      hostKeyPinnedAt: host.hostKeyPinnedAt,
      hostKeyMismatchAt: host.hostKeyMismatchAt,
      createdAt: host.createdAt,
      updatedAt: host.updatedAt,
      credential,
      allowed: scope.scoped && allowed.has(host.id),
      grant: activeGrant === null ? null : (grantById.get(activeGrant.id) ?? null),
      pendingApprovals: view?.pendingApprovals ?? 0,
      pinState: state,
      status: state,
      anchor: `ssh-host-${host.id}`,
      returnTo: `${scope.href}#ssh-host-${host.id}`,
      actions: {
        api: {
          host: `/api/ssh/hosts/${id}`,
          test: `/api/ssh/hosts/${id}/test`,
          update: `/api/ssh/hosts/${id}`,
          delete: `/api/ssh/hosts/${id}`,
          rePin: `/api/ssh/hosts/${id}/re-pin`,
        },
        form: {
          test: `/ssh/hosts/${id}/test`,
          rePin: `/ssh/hosts/${id}/re-pin`,
          update: `/ssh/hosts/${id}/update`,
          delete: `/ssh/hosts/${id}/delete`,
        },
      },
    };
  });

  const pinned = hosts.filter(
    (host) => host.hostKeyFingerprint !== null && host.hostKeyMismatchAt === null,
  ).length;
  const unpinned = hosts.filter((host) => host.hostKeyFingerprint === null).length;
  const mismatch = hosts.filter((host) => host.hostKeyMismatchAt !== null).length;
  const activeGrants = grants.filter((grant) => grant.state === "active").length;

  const appPrefix = found === null ? null : `/api/apps/${encodeURIComponent(selection.appKey)}/ssh`;
  const api = {
    hosts: "/api/ssh/hosts",
    approvalsCount: "/api/ssh/approvals/count",
    appApprovals:
      appPrefix === null
        ? null
        : `${appPrefix}/approvals?project=${encodeURIComponent(selection.projectId)}`,
    audit:
      appPrefix === null
        ? null
        : `${appPrefix}/audit?project=${encodeURIComponent(selection.projectId)}`,
    grants:
      found === null
        ? null
        : `/api/projects/${encodeURIComponent(selection.projectId)}/apps/${encodeURIComponent(selection.appKey)}/ssh`,
  };

  const addValues = input.error?.target === "add" ? (input.error.values ?? {}) : {};
  const addOpen = input.openAdd === true || input.error?.target === "add";
  const add: SshAddDialogProps = {
    open: addOpen,
    values: addValues,
    error: input.error?.target === "add" ? input.error.message : null,
    action: "/ssh/hosts",
    returnTo: scope.hostsHref,
  };
  const edits: SshEditDialogProps[] = hosts.map((host) => {
    const target = `edit:${host.id}`;
    const isError = input.error?.target === target;
    return {
      hostId: host.id,
      open: isError,
      values: isError ? (input.error?.values ?? {}) : {},
      error: isError ? (input.error?.message ?? null) : null,
      action: host.actions.form.update,
      deleteAction: host.actions.form.delete,
      returnTo: host.returnTo,
      deleteReturnTo: scope.hostsHref,
    };
  });

  const test: SshTestProps | null =
    input.test === undefined
      ? null
      : {
          hostId: input.test.hostId,
          hostName: input.test.hostName,
          ok: input.test.ok,
          authOk: input.test.authOk,
          ...(input.test.code === undefined ? {} : { code: input.test.code }),
          ...(input.test.message === undefined ? {} : { message: input.test.message }),
          ...(input.test.fingerprint === undefined ? {} : { fingerprint: input.test.fingerprint }),
          ...(input.test.previousFingerprint === undefined
            ? {}
            : { previousFingerprint: input.test.previousFingerprint }),
          ...(input.test.mismatch === undefined ? {} : { mismatch: input.test.mismatch }),
          ...(input.test.serverBanner === undefined
            ? {}
            : { serverBanner: input.test.serverBanner }),
          prepareRePin: input.test.prepareRePin === true,
        };

  return {
    scope,
    hosts,
    grants,
    approvals,
    audit,
    counts: {
      hosts: hosts.length,
      pinned,
      unpinned,
      mismatch,
      pendingApprovals: approvals.length,
      activeGrants,
      grants: grants.length,
      allowedHosts: allowed.size,
      auditRows: audit.length,
    },
    policy: {
      idleOptions: SSH_IDLE_OPTIONS,
      idleDefaultSec: IDLE_DEFAULT_SEC,
      idleMinSec: IDLE_MIN_SEC,
      idleMaxSec: IDLE_MAX_SEC,
      absoluteGrantSec: ABSOLUTE_GRANT_SEC,
      pendingApprovalSec: PENDING_APPROVAL_SEC,
      auditLimit: SSH_AUDIT_LIMIT,
    },
    actions: {
      createHost: "/api/ssh/hosts",
      refresh: scope.href,
      saveGrants: api.grants,
      audit: api.audit ?? scope.auditHref,
      form: { createHost: "/ssh/hosts", saveGrants: "/ssh/grants" },
      api,
    },
    labels: LABELS,
    test,
    error:
      input.error === undefined
        ? null
        : {
            message: input.error.message,
            target: input.error.target,
            values: input.error.values ?? {},
          },
    dialogs: { add, edits },
  };
}
