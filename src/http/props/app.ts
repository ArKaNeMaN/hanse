/**
 * Page props for application detail (`/projects/:id/apps/:app`).
 *
 * `buildAppProps` is the single assembly used by the legacy `renderApplication` and by
 * `GET /api/ui/apps/:app`, so the two renderers cannot drift. It reads application identity,
 * runtime/settings state, image read state, the git read summary, and the app-scoped SSH summary
 * from the same `SiteModel` and service objects the legacy page uses.
 *
 * The image rail and SSH panel are read-only here. No private keys, git credentials, provider
 * keys, MCP tokens, or runtime passwords are read: SSH grants/approvals/audit expose only the
 * metadata the app page and the SSH console display, never key material.
 */

import type { GitOperation, GitRepoState, GitStatus } from "../../git/service.js";
import { isMasterApp } from "../../master/constants.js";
import type { AppImageBaseKind, AppImageStatus, RegisteredApp } from "../../registry/index.js";
import type {
  SshApprovalStatus,
  SshApprovalView,
  SshAuditEntry,
  SshGrant,
} from "../../ssh/types.js";
import { appDir } from "../apps.js";
import type { SiteModel } from "../dashboard.js";
import { type IconName, ideFolderUrl, type RuntimeState } from "../ui.js";

export type AppImageState = "default" | "missing" | "building" | "ready" | "stale" | "error";

export interface AppIdentityProps {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly rootPath: string;
  readonly appKey: string;
  readonly kind: string;
  readonly path: string;
  readonly folder: string;
  readonly href: string;
  readonly master: boolean;
}

export interface AppRuntimeProps {
  readonly state: RuntimeState;
  readonly label: string;
  readonly glyph: IconName;
  /** Value of the status pill `data-state` attribute. */
  readonly tone: string;
  readonly configured: boolean;
  readonly pendingRestart: boolean;
  readonly pendingRestartReasons: readonly string[];
  readonly canRestart: boolean;
}

export type AppSettingsState = "restart_required" | "unavailable" | "saved" | "applied";

export interface AppSettingsProps {
  readonly state: AppSettingsState;
  readonly pending: boolean;
  readonly appliedStateUnknown: boolean;
  readonly runtimeConfigured: boolean;
  readonly label: string;
  readonly glyph: IconName;
  readonly tone: string;
  readonly copy: string;
  readonly href: string;
  readonly actionLabel: string | null;
}

export interface AppImageBaseProps {
  readonly kind: AppImageBaseKind | null;
  readonly kindLabel: string;
  readonly ref: string | null;
  readonly digest: string | null;
}

export interface AppImageRollbackProps {
  readonly available: boolean;
  readonly ref: string | null;
  readonly builtAt: string | null;
  readonly action: string;
  readonly restart: boolean;
}

export interface AppImageHrefsProps {
  readonly app: string;
  readonly build: string;
  readonly rollback: string;
  readonly check: string;
  readonly image: string;
  readonly logs: string;
  readonly runtime: string;
}

export interface AppImageProps {
  readonly configured: boolean;
  readonly status: AppImageState;
  readonly state: string;
  readonly label: string;
  readonly glyph: IconName;
  readonly action: string;
  readonly hint: string;
  readonly ref: string | null;
  readonly hash: string | null;
  readonly builtAt: string | null;
  readonly base: AppImageBaseProps;
  /** True when the built image no longer matches the Dockerfile or base. */
  readonly drift: boolean;
  /** True when actions are unavailable because deletion is pending. */
  readonly blocked: boolean;
  /** True when a current image exists for this app (including a building replacement). */
  readonly usable: boolean;
  readonly rollback: AppImageRollbackProps;
  readonly error: string | null;
  readonly building: boolean;
  readonly buildDisabled: boolean;
  readonly rollbackDisabled: boolean;
  readonly projectId: string;
  readonly appKey: string;
  readonly hrefs: AppImageHrefsProps;
}

export interface AppGitBranchProps {
  readonly name: string | null;
  readonly detached: boolean;
  readonly head: string | null;
}

export interface AppGitUpstreamProps {
  readonly name: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface AppGitLastCommitProps {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly author: string;
  readonly committedAt: string;
}

export interface AppGitCountsProps {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
}

export interface AppGitSummaryProps {
  readonly loaded: boolean;
  readonly state: GitRepoState | "unavailable";
  readonly message: string | null;
  readonly branch: AppGitBranchProps | null;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly clean: boolean;
  readonly conflicted: boolean;
  readonly upstream: AppGitUpstreamProps | null;
  readonly ahead: number;
  readonly behind: number;
  readonly operation: GitOperation | null;
  readonly counts: AppGitCountsProps;
  readonly lastCommit: AppGitLastCommitProps | null;
}

export interface AppGitProps {
  readonly apiBase: string;
  readonly statusHref: string;
  readonly refreshLabel: string;
  readonly summary: AppGitSummaryProps;
}

export type AppSshGrantState = "active" | "expired" | "revoked";

export interface AppSshGrantProps {
  readonly id: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly approvalId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly lastUsedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
  readonly state: AppSshGrantState;
}

export interface AppSshApprovalProps {
  readonly id: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly action: string;
  readonly commandPreview: string;
  readonly status: SshApprovalStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly grantId: string | null;
}

export type AppSshAuditOutcome = "running" | "error" | "ok" | "exit" | "recorded";

export interface AppSshAuditProps {
  readonly id: number;
  readonly hostId: string;
  readonly hostName: string;
  readonly action: string;
  readonly commandPreview: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly errorCode: string | null;
  readonly outcome: AppSshAuditOutcome;
}

export interface AppSshProps {
  readonly href: string;
  readonly available: boolean;
  readonly hosts: number;
  readonly pendingApprovals: number;
  readonly grants: readonly AppSshGrantProps[];
  readonly approvals: readonly AppSshApprovalProps[];
  readonly audit: readonly AppSshAuditProps[];
}

export interface AppLinksProps {
  readonly chat: string;
  readonly terminal: string;
  readonly ide: string;
  readonly settings: string;
  readonly skills: string;
  readonly ssh: string;
}

export interface AppRestartProps {
  readonly available: boolean;
  readonly action: string;
  readonly returnTo: string;
  readonly label: string;
  readonly dialogTitle: string;
  readonly dialogBody: string;
}

export interface AppDeleteBannerProps {
  readonly title: string;
  readonly body: string;
}

export interface AppDeleteProps {
  readonly deleting: boolean;
  readonly projectDeleting: boolean;
  readonly pending: boolean;
  readonly action: string;
  readonly returnTo: string;
  readonly confirmName: string;
  readonly dialog: "application" | "project";
  readonly retrying: boolean;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly statusLabel: string | null;
  readonly banner: AppDeleteBannerProps | null;
}

export interface AppHeaderProps {
  readonly overline: string;
  readonly title: string;
  readonly description: string;
  readonly meta: readonly string[];
  readonly showChatTerminal: boolean;
}

export interface AppProps {
  readonly identity: AppIdentityProps;
  readonly header: AppHeaderProps;
  readonly runtime: AppRuntimeProps;
  readonly settings: AppSettingsProps;
  readonly image: AppImageProps;
  readonly git: AppGitProps;
  readonly ssh: AppSshProps;
  readonly links: AppLinksProps;
  readonly restart: AppRestartProps;
  readonly delete: AppDeleteProps;
  readonly master: boolean;
  readonly profileWarnings: readonly string[];
}

export interface AppSshSource {
  listGrants(appId: string): SshGrant[];
  listPending(appId?: string): SshApprovalView[];
  listAudit(appId?: string, limit?: number, before?: number): SshAuditEntry[];
  listAllHosts(): ReadonlyArray<{ readonly host: { readonly id: string; readonly name: string } }>;
}

export interface BuildAppPropsInput {
  readonly site: SiteModel;
  readonly projectId: string;
  readonly appKey: string;
  /** True when an instance manager is wired; mirrors the legacy renderer's runtime availability. */
  readonly runtimeConfigured?: boolean;
  /** Optional app-scoped SSH read source; when omitted only the site summary counts are returned. */
  readonly ssh?: AppSshSource;
  /** Optional live git read status; the endpoint loads it, the legacy renderer does not. */
  readonly gitStatus?: GitStatus | null;
  readonly gitError?: string | null;
  readonly profileWarnings?: readonly string[];
  readonly now?: Date;
}

interface ImageMeta {
  readonly label: string;
  readonly state: AppImageState;
  readonly glyph: IconName;
  readonly action: string;
  readonly hint: string;
}

const IMAGE_STATES: Record<AppImageStatus, ImageMeta> = {
  missing: {
    label: "Not built",
    state: "missing",
    glyph: "clock",
    action: "Build image",
    hint: "No app image has been built. Build it before starting the agent.",
  },
  building: {
    label: "Building",
    state: "building",
    glyph: "loader",
    action: "Building…",
    hint: "The runner is building this image. The previous image remains in use.",
  },
  ready: {
    label: "Built",
    state: "ready",
    glyph: "check",
    action: "Rebuild image",
    hint: "The image matches the current Dockerfile and default base.",
  },
  stale: {
    label: "Out of date",
    state: "stale",
    glyph: "hourglass",
    action: "Rebuild image",
    hint: "The Dockerfile or default base changed. The running agent keeps the old image until you rebuild and restart.",
  },
  error: {
    label: "Build failed",
    state: "error",
    glyph: "alert-triangle",
    action: "Retry build",
    hint: "The last build failed. The previous image is kept.",
  },
};

const IMAGE_TONES: Record<AppImageStatus, string> = {
  missing: "queued",
  building: "in_progress",
  ready: "delivered",
  stale: "expired",
  error: "failed",
};

const BASE_KIND_LABELS: Record<AppImageBaseKind, string> = {
  default: "Default",
  base: "Base",
  explicit: "Explicit",
  unknown: "Unknown",
};

const RUNTIME_META: Record<RuntimeState, { label: string; glyph: IconName; tone: string }> = {
  starting: { label: "Starting", glyph: "loader", tone: "dispatching" },
  running: { label: "Running", glyph: "activity", tone: "in_progress" },
  error: { label: "Error", glyph: "alert-triangle", tone: "failed" },
  stopped: { label: "Stopped", glyph: "clock", tone: "queued" },
};

const SSH_AUDIT_LIMIT = 30;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function imageHrefs(projectId: string, appKey: string): AppImageHrefsProps {
  const key = encoded(appKey);
  const project = encoded(projectId);
  return {
    app: `/projects/${project}/apps/${key}`,
    build: `/api/apps/${key}/build?project=${project}`,
    rollback: `/api/apps/${key}/image/rollback?project=${project}`,
    check: `/api/apps/${key}/image/check?project=${project}`,
    image: `/api/apps/${key}/image?project=${project}`,
    logs: `/api/apps/${key}/image/logs?project=${project}`,
    runtime: `/api/apps/${key}/runtime?project=${project}`,
  };
}

function settingsProps(
  pending: boolean,
  reasons: readonly string[],
  runtimeConfigured: boolean,
  runtime: RuntimeState,
  href: string,
): AppSettingsProps {
  if (pending) {
    const unknown = reasons.includes("applied_state_unknown");
    return {
      state: "restart_required",
      pending,
      appliedStateUnknown: unknown,
      runtimeConfigured,
      label: "Restart required",
      glyph: "stamp",
      tone: "awaiting_approval",
      copy: unknown
        ? "The coordinator cannot confirm which settings this running agent loaded."
        : "The agent is running with older settings.",
      href,
      actionLabel: null,
    };
  }
  if (!runtimeConfigured) {
    return {
      state: "unavailable",
      pending,
      appliedStateUnknown: false,
      runtimeConfigured,
      label: "Unavailable",
      glyph: "slash",
      tone: "cancelled",
      copy: "The agent runtime is not configured.",
      href,
      actionLabel: "Review settings",
    };
  }
  if (runtime === "stopped" || runtime === "error") {
    return {
      state: "saved",
      pending,
      appliedStateUnknown: false,
      runtimeConfigured,
      label: "Saved",
      glyph: "clock",
      tone: "queued",
      copy: "Settings apply when the agent starts.",
      href,
      actionLabel: "Review settings",
    };
  }
  return {
    state: "applied",
    pending,
    appliedStateUnknown: false,
    runtimeConfigured,
    label: "Applied",
    glyph: "check",
    tone: "delivered",
    copy: "Settings match the running agent.",
    href,
    actionLabel: "Review settings",
  };
}

function imageProps(
  projectId: string,
  app: RegisteredApp,
  runtime: RuntimeState,
  deletionPending: boolean,
): AppImageProps {
  const hrefs = imageHrefs(projectId, app.appKey);
  const building = app.imageStatus === "building";
  if (!app.buildConfigured) {
    return {
      configured: false,
      status: "default",
      state: "cancelled",
      label: "Default image",
      glyph: "layers",
      action: "",
      hint: "This application uses the shared default agent image.",
      ref: null,
      hash: null,
      builtAt: null,
      base: { kind: null, kindLabel: "Unknown", ref: null, digest: null },
      drift: false,
      blocked: deletionPending,
      usable: false,
      rollback: {
        available: false,
        ref: null,
        builtAt: null,
        action: "Roll back image",
        restart: false,
      },
      error: null,
      building: false,
      buildDisabled: deletionPending,
      rollbackDisabled: deletionPending,
      projectId,
      appKey: app.appKey,
      hrefs,
    };
  }

  const meta = IMAGE_STATES[app.imageStatus] ?? IMAGE_STATES.missing;
  const rollbackRef = app.imageRollbackRef ?? null;
  const activeRuntime = runtime === "running" || runtime === "starting";
  const rollbackAction = activeRuntime ? "Roll back and restart" : "Roll back image";
  return {
    configured: true,
    status: app.imageStatus,
    state: IMAGE_TONES[app.imageStatus] ?? "queued",
    label: meta.label,
    glyph: meta.glyph,
    action: meta.action,
    hint: meta.hint,
    ref: app.imageRef,
    hash: app.imageHash,
    builtAt: app.imageBuiltAt,
    drift: app.imageStatus === "stale",
    blocked: deletionPending,
    usable: app.imageRef !== null && app.imageStatus !== "error",
    base: {
      kind: app.imageBaseKind,
      kindLabel: app.imageBaseKind === null ? "Unknown" : BASE_KIND_LABELS[app.imageBaseKind],
      ref: app.imageBaseRef,
      digest: app.imageBaseDigest,
    },
    rollback: {
      available: rollbackRef !== null,
      ref: rollbackRef,
      builtAt: app.imageRollbackBuiltAt ?? null,
      action: rollbackAction,
      restart: activeRuntime,
    },
    error: app.imageError,
    building,
    buildDisabled: building || deletionPending,
    rollbackDisabled: building || deletionPending,
    projectId,
    appKey: app.appKey,
    hrefs,
  };
}

/** Pure mapping from a `GitStatus` to the read-only summary embedded in `AppProps`. */
export function appGitSummary(
  status: GitStatus | null,
  error: string | null = null,
): AppGitSummaryProps {
  if (status === null) {
    return {
      loaded: false,
      state: "unavailable",
      message: error,
      branch: null,
      detached: false,
      dirty: false,
      clean: false,
      conflicted: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: null,
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      lastCommit: null,
    };
  }

  const files = status.files ?? [];
  const counts = {
    staged: files.filter((file) => file.group === "staged").length,
    unstaged: files.filter((file) => file.group === "unstaged").length,
    untracked: files.filter((file) => file.group === "untracked").length,
    conflicted: files.filter((file) => file.group === "conflicted").length,
  };
  const clean = status.clean ?? files.length === 0;
  const branch = status.branch ?? null;
  const upstream = status.upstream ?? null;
  return {
    loaded: true,
    state: status.state,
    message: status.message ?? null,
    branch,
    detached: branch?.detached === true,
    dirty: !clean,
    clean,
    conflicted: status.conflicted === true || counts.conflicted > 0,
    upstream,
    ahead: upstream?.ahead ?? 0,
    behind: upstream?.behind ?? 0,
    operation: status.operation ?? null,
    counts,
    lastCommit: status.lastCommit ?? null,
  };
}

function grantState(grant: SshGrant, nowMs: number): AppSshGrantState {
  if (grant.revokedAt !== null) {
    return "revoked";
  }
  if (Date.parse(grant.idleExpiresAt) <= nowMs || Date.parse(grant.absoluteExpiresAt) <= nowMs) {
    return "expired";
  }
  return "active";
}

function auditOutcome(entry: SshAuditEntry): AppSshAuditOutcome {
  if (entry.finishedAt === null) return "running";
  if (entry.errorCode !== null) return "error";
  if (entry.exitCode === 0) return "ok";
  if (entry.exitCode !== null) return "exit";
  return "recorded";
}

function sshProps(input: BuildAppPropsInput, appId: string, href: string, now: Date): AppSshProps {
  const hosts = input.site.sshHostsByApp.get(appId) ?? 0;
  const pendingApprovals = input.site.sshPendingByApp.get(appId) ?? 0;
  if (input.ssh === undefined) {
    return {
      href,
      available: false,
      hosts,
      pendingApprovals,
      grants: [],
      approvals: [],
      audit: [],
    };
  }

  let available = true;
  let hostNames = new Map<string, string>();
  let grants: AppSshGrantProps[] = [];
  let approvals: AppSshApprovalProps[] = [];
  let audit: AppSshAuditProps[] = [];
  try {
    hostNames = new Map(
      input.ssh.listAllHosts().map((entry) => [entry.host.id, entry.host.name] as const),
    );
    const nowMs = now.getTime();
    grants = input.ssh.listGrants(appId).map((grant) => ({
      id: grant.id,
      hostId: grant.hostId,
      hostName: hostNames.get(grant.hostId) ?? grant.hostId,
      approvalId: grant.approvalId,
      grantedBy: grant.grantedBy,
      grantedAt: grant.grantedAt,
      lastUsedAt: grant.lastUsedAt,
      idleExpiresAt: grant.idleExpiresAt,
      absoluteExpiresAt: grant.absoluteExpiresAt,
      revokedAt: grant.revokedAt,
      state: grantState(grant, nowMs),
    }));
    approvals = input.ssh.listPending(appId).map((approval) => ({
      id: approval.id,
      hostId: approval.hostId,
      hostName: approval.hostName,
      action: approval.action,
      commandPreview: approval.commandPreview,
      status: approval.status,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      decidedAt: approval.decidedAt,
      grantId: approval.grantId,
    }));
    audit = input.ssh.listAudit(appId, SSH_AUDIT_LIMIT).map((entry) => ({
      id: entry.id,
      hostId: entry.hostId,
      hostName: entry.hostName,
      action: entry.action,
      commandPreview: entry.commandPreview,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      exitCode: entry.exitCode,
      errorCode: entry.errorCode,
      outcome: auditOutcome(entry),
    }));
  } catch {
    available = false;
    grants = [];
    approvals = [];
    audit = [];
  }

  return { href, available, hosts, pendingApprovals, grants, approvals, audit };
}

function deleteProps(
  project: { id: string; name: string; deleting: boolean },
  app: RegisteredApp,
  appHref: string,
): AppDeleteProps {
  const projectDeleting = project.deleting;
  const appDeleting = app.deleting;
  const pending = appDeleting || projectDeleting;
  const retrying = appDeleting && !projectDeleting;
  const statusLabel = projectDeleting
    ? "Project deletion incomplete"
    : appDeleting
      ? "Deletion incomplete"
      : null;
  const banner = projectDeleting
    ? {
        title: "Project deletion incomplete",
        body: "This project is marked for deletion. Chat, terminal, and start actions stay disabled until the deletion completes.",
      }
    : appDeleting
      ? {
          title: "Deletion incomplete",
          body: "This application is marked for deletion. Chat, terminal, and start actions stay disabled until the deletion completes.",
        }
      : null;
  return {
    deleting: appDeleting,
    projectDeleting,
    pending,
    action: projectDeleting
      ? `/api/projects/${encoded(project.id)}/delete`
      : `/api/projects/${encoded(project.id)}/apps/${encoded(app.appKey)}/delete`,
    returnTo: appHref,
    confirmName: projectDeleting ? project.name : app.appKey,
    dialog: projectDeleting ? "project" : "application",
    retrying,
    title: projectDeleting
      ? "Retry project deletion?"
      : appDeleting
        ? "Retry application deletion?"
        : "Delete application?",
    description: projectDeleting
      ? "This removes every application in the project, including their sessions, handoffs, credentials, and managed images."
      : "This removes the application, including its sessions, handoffs, credentials, and managed images.",
    actionLabel: projectDeleting
      ? "Retry deletion"
      : appDeleting
        ? "Retry deletion"
        : "Delete application",
    statusLabel,
    banner,
  };
}

/**
 * Assemble the application detail props. Returns `undefined` for an unknown project or app so the
 * legacy renderer serves 404 and the endpoint answers 404.
 */
export function buildAppProps(input: BuildAppPropsInput): AppProps | undefined {
  const project = input.site.projects.find((candidate) => candidate.id === input.projectId);
  if (project === undefined) {
    return undefined;
  }
  const app = project.apps.find((candidate) => candidate.appKey === input.appKey);
  if (app === undefined) {
    return undefined;
  }

  const now = input.now ?? new Date();
  const master = isMasterApp(project.id, app.appKey);
  const runtime = input.site.runtime.get(app.id) ?? "stopped";
  const runtimeConfigured = input.runtimeConfigured ?? false;
  const deletionPending = app.deleting || project.deleting;
  const pendingRestart = input.site.pendingRestart.get(app.id) ?? false;
  const pendingRestartReasons = input.site.pendingRestartReasons.get(app.id) ?? [];
  const folder = appDir(project, app);
  const appHref = `/projects/${encoded(project.id)}/apps/${encoded(app.appKey)}`;
  const links: AppLinksProps = {
    chat: `/chat?app=${encoded(app.appKey)}&project=${encoded(project.id)}`,
    terminal: `/terminal?app=${encoded(app.appKey)}&project=${encoded(project.id)}`,
    ide: ideFolderUrl(folder),
    settings: `${appHref}/settings`,
    skills: `${appHref}/skills`,
    ssh: `/ssh?project=${encoded(project.id)}&app=${encoded(app.appKey)}`,
  };
  const canRestart = !deletionPending && (runtime === "running" || runtime === "starting");
  const apiBase = `/api/projects/${encoded(project.id)}/apps/${encoded(app.appKey)}/git`;

  return {
    identity: {
      id: app.id,
      projectId: project.id,
      projectName: project.name,
      rootPath: project.rootPath,
      appKey: app.appKey,
      kind: app.kind ?? "app",
      path: app.path,
      folder,
      href: appHref,
      master,
    },
    header: {
      overline: "Application",
      title: app.appKey,
      description: master
        ? "Built-in Hanse assistant. Configure it like an agent; workspace work goes through its tools."
        : "Repository state and lightweight git actions for this application.",
      meta: [project.name, app.kind ?? "app", master ? folder : app.path],
      showChatTerminal: !deletionPending,
    },
    runtime: {
      state: runtime,
      label: RUNTIME_META[runtime].label,
      glyph: RUNTIME_META[runtime].glyph,
      tone: RUNTIME_META[runtime].tone,
      configured: runtimeConfigured,
      pendingRestart,
      pendingRestartReasons,
      canRestart,
    },
    settings: settingsProps(
      pendingRestart,
      pendingRestartReasons,
      runtimeConfigured,
      runtime,
      links.settings,
    ),
    image: imageProps(project.id, app, runtime, deletionPending),
    git: {
      apiBase,
      statusHref: `${apiBase}/status`,
      refreshLabel: "Refresh repository status",
      summary: appGitSummary(input.gitStatus ?? null, input.gitError ?? null),
    },
    ssh: sshProps(input, app.id, links.ssh, now),
    links,
    restart: {
      available: canRestart,
      action: `/api/apps/${encoded(app.appKey)}/restart?project=${encoded(project.id)}`,
      returnTo: appHref,
      label: "Restart agent",
      dialogTitle: `Restart ${app.appKey}?`,
      dialogBody: "An active turn will be interrupted. Sessions are kept.",
    },
    delete: deleteProps(project, app, appHref),
    master,
    profileWarnings: input.profileWarnings ?? [],
  };
}
