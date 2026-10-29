/**
 * Structural mirror of `src/http/props/app.ts` for the SPA application-detail page.
 *
 * The legacy renderer and `GET /api/ui/apps/:app` share one server assembly, so this is the data
 * contract. Keeping the mirror in a small client module avoids importing server code (and its
 * Node-only imports) into the Vite bundle while still typing the boot payload and query response.
 */

import type { BootChrome } from "./boot.js";
import type { RuntimeState } from "./status.js";

export type AppImageState = "default" | "missing" | "building" | "ready" | "stale" | "error";
export type AppSettingsState = "restart_required" | "unavailable" | "saved" | "applied";
export type AppSshGrantState = "active" | "expired" | "revoked";
export type AppSshApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "superseded";
export type AppSshAuditOutcome = "running" | "error" | "ok" | "exit" | "recorded";

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
  readonly glyph: string;
  readonly tone: string;
  readonly configured: boolean;
  readonly pendingRestart: boolean;
  readonly pendingRestartReasons: readonly string[];
  readonly canRestart: boolean;
}

export interface AppSettingsProps {
  readonly state: AppSettingsState;
  readonly pending: boolean;
  readonly appliedStateUnknown: boolean;
  readonly runtimeConfigured: boolean;
  readonly label: string;
  readonly glyph: string;
  readonly tone: string;
  readonly copy: string;
  readonly href: string;
  readonly actionLabel: string | null;
}

export interface AppImageBaseProps {
  readonly kind: string | null;
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
  readonly glyph: string;
  readonly action: string;
  readonly hint: string;
  readonly ref: string | null;
  readonly hash: string | null;
  readonly builtAt: string | null;
  readonly base: AppImageBaseProps;
  readonly drift: boolean;
  readonly blocked: boolean;
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
  readonly state: string;
  readonly message: string | null;
  readonly branch: AppGitBranchProps | null;
  readonly detached: boolean;
  readonly dirty: boolean;
  readonly clean: boolean;
  readonly conflicted: boolean;
  readonly upstream: AppGitUpstreamProps | null;
  readonly ahead: number;
  readonly behind: number;
  readonly operation: string | null;
  readonly counts: AppGitCountsProps;
  readonly lastCommit: AppGitLastCommitProps | null;
}

export interface AppGitProps {
  readonly apiBase: string;
  readonly statusHref: string;
  readonly refreshLabel: string;
  readonly summary: AppGitSummaryProps;
}

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
  readonly status: AppSshApprovalStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly grantId: string | null;
}

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

/** One host in `GET /api/projects/:id/apps/:app/ssh`; never contains key material. */
export interface AppSshHostProps {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly username: string;
  readonly requireApproval: boolean;
  readonly allowed: boolean;
  readonly grant: { readonly id: string } | null;
  readonly pendingApprovals: number;
}

export interface AppSshAllowlistResponse {
  readonly hosts: readonly AppSshHostProps[];
  readonly grants: readonly AppSshGrantProps[];
}

export interface AppSshAuditResponse {
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

export interface AppDeleteResult {
  readonly deleted: boolean;
  readonly kind: "project" | "app";
  readonly projectId: string;
  readonly warnings: readonly string[];
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

export interface AppResponse extends AppProps {
  readonly chrome?: BootChrome;
}

/** Live runtime read used by the page poll (`GET /api/apps/:app/runtime`). */
export interface AppRuntimeLive {
  readonly state?: string;
  readonly imageRef?: string | null;
  readonly restarting?: boolean;
}

/**
 * Live image read used by the page poll (`GET /api/apps/:app/image`). Every field is optional so a
 * partial response cannot corrupt the boot props; missing values fall back to `AppImageProps`.
 */
export interface AppImageLive {
  readonly status?: string;
  readonly state?: string;
  readonly imageRef?: string | null;
  readonly hash?: string | null;
  readonly baseKind?: string | null;
  readonly baseRef?: string | null;
  readonly baseDigest?: string | null;
  readonly currentBaseDigest?: string | null;
  readonly builtAt?: string | null;
  readonly previousImageRef?: string | null;
  readonly previousImageBuiltAt?: string | null;
  readonly error?: string | null;
  readonly buildConfigured?: boolean;
  readonly baseDrift?: boolean;
  readonly hashDrift?: boolean;
  readonly blocked?: boolean;
  readonly usableImageRef?: string | null;
}
