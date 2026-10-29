/**
 * Client mirror of the git JSON contract in `src/git/service.ts` plus the pure presentation rules
 * ported from `assets/git.js`.
 *
 * Nothing here imports server code: the status endpoint is the only source of the full repository
 * state (files, branches, remotes, identity), while `/api/ui/apps/:app` carries a read-only summary.
 */

import type { AppGitSummaryProps } from "./app-types.js";

export type GitRepoState = "ok" | "not_git" | "not_root" | "missing";
export type GitFileGroup = "staged" | "unstaged" | "untracked" | "conflicted";
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface GitFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly code: string;
  readonly group: GitFileGroup;
}

export interface GitBranchState {
  readonly name: string | null;
  readonly detached: boolean;
  readonly head: string | null;
}

export interface GitUpstreamState {
  readonly name: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface GitRemoteState {
  readonly name: string;
  readonly url: string;
}

export interface GitLastCommitState {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly author: string;
  readonly committedAt: string;
}

export interface GitIdentityState {
  readonly configured: boolean;
}

export interface GitStatus {
  readonly state: GitRepoState;
  readonly root?: string;
  readonly message?: string;
  readonly branch?: GitBranchState;
  readonly upstream?: GitUpstreamState | null;
  readonly clean?: boolean;
  readonly files?: readonly GitFile[];
  readonly branches?: readonly string[];
  readonly remotes?: readonly GitRemoteState[];
  readonly lastCommit?: GitLastCommitState | null;
  readonly operation?: GitOperation | null;
  readonly conflicted?: boolean;
  readonly identity?: GitIdentityState;
}

export interface GitCommitInfo {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
}

export interface GitActionResult {
  readonly status: GitStatus | null;
  readonly message: string;
  readonly warning?: string;
  readonly commit?: GitCommitInfo;
}

export interface GitStatusResponse {
  readonly status: GitStatus;
}

export type GitMutation = "fetch" | "update" | "push" | "commit" | "switch";

export interface GitControlRules {
  readonly detached: boolean;
  readonly unborn: boolean;
  readonly upstream: GitUpstreamState | null;
  readonly hasOrigin: boolean;
  readonly noRemote: boolean;
  readonly conflicts: boolean;
  readonly operation: boolean;
  readonly identity: boolean;
  readonly commitReason: string | null;
  readonly fetch: boolean;
  readonly update: boolean;
  readonly push: boolean;
  readonly switch: boolean;
  readonly commit: boolean;
}

export const GIT_FILE_GROUPS: readonly GitFileGroup[] = [
  "staged",
  "unstaged",
  "untracked",
  "conflicted",
];

export const GIT_GROUP_LABEL: Record<GitFileGroup, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
  conflicted: "Conflicted",
};

/** Mirror of `appGitSummary` in `src/http/props/app.ts`. */
export function summaryFromStatus(status: GitStatus): AppGitSummaryProps {
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

/** Port of `controlState` from `assets/git.js`. Every `true` flag disables that control. */
export function gitControlRules(status: GitStatus | null): GitControlRules {
  if (status === null || status.state !== "ok") {
    return {
      detached: false,
      unborn: false,
      upstream: null,
      hasOrigin: false,
      noRemote: true,
      conflicts: false,
      operation: false,
      identity: false,
      commitReason: null,
      fetch: true,
      update: true,
      push: true,
      switch: true,
      commit: true,
    };
  }

  const branch = status.branch ?? { name: null, detached: false, head: null };
  const detached = branch.detached === true;
  const unborn = !detached && (branch.head === null || branch.head === undefined);
  const upstream =
    status.upstream !== null && typeof status.upstream?.name === "string" ? status.upstream : null;
  const remotes = status.remotes ?? [];
  const hasOrigin = remotes.some((remote) => remote.name === "origin");
  const noRemote = remotes.length === 0;
  const conflicts = status.conflicted === true;
  const operation = typeof status.operation === "string" && status.operation.length > 0;
  const identity = status.identity?.configured === true;
  const commitReason = conflicts
    ? "Resolve conflicts in the IDE before committing."
    : operation
      ? `Finish or abort the ${status.operation ?? "git"} in the IDE before committing.`
      : detached
        ? "Detached HEAD. Switch to a branch before committing."
        : !identity
          ? "Set user.name and user.email in the repository or host git config before committing."
          : null;
  return {
    detached,
    unborn,
    upstream,
    hasOrigin,
    noRemote,
    conflicts,
    operation,
    identity,
    commitReason,
    fetch: noRemote,
    update: detached || noRemote || unborn || upstream === null || conflicts || operation,
    push: detached || noRemote || unborn || (upstream === null && !hasOrigin),
    switch: conflicts || operation,
    commit: commitReason !== null,
  };
}

/** Port of `actionsHint`; the disabled-action reason shown under the action row. */
export function actionsHint(status: GitStatus, rules: GitControlRules): string {
  if (rules.noRemote) {
    return "No remotes configured. Local commits still work.";
  }
  if (rules.detached) {
    return "Detached HEAD. Switch to a branch before committing.";
  }
  if (rules.conflicts) {
    return "Resolve conflicts in the IDE before committing.";
  }
  if (rules.operation) {
    return "Finish or abort the operation in the IDE.";
  }
  if (rules.unborn) {
    return "No commits yet. Commit changes to create the first commit.";
  }
  if (rules.upstream === null && rules.hasOrigin) {
    const branch = status.branch?.name ?? "the branch";
    return `Pushes to origin/${branch} and sets the upstream.`;
  }
  if (rules.upstream === null) {
    return "Set an upstream branch in git to update or push.";
  }
  return "Fetch, update, push, or switch this branch.";
}

export function pushLabel(rules: GitControlRules): string {
  return !rules.unborn && rules.upstream === null && rules.hasOrigin
    ? "Push and set upstream"
    : "Push";
}

export function gitActionPath(action: GitMutation): string {
  return action === "switch" ? "branches/switch" : action;
}

/** Port of `fallbackMessage`: used when the server response has no `message`. */
export function fallbackGitMessage(
  action: GitMutation,
  data: GitActionResult,
  body: Readonly<Record<string, string>>,
  previous: GitStatus | null,
): string {
  const next = data.status ?? previous;
  if (action === "fetch") {
    return "Fetched all remotes.";
  }
  if (action === "update") {
    const head = next?.branch?.head ?? "";
    return head.length >= 7 ? `Branch updated to ${head.slice(0, 7)}.` : "Branch updated.";
  }
  if (action === "push") {
    const upstream = next?.upstream?.name ?? next?.branch?.name ?? "the remote";
    return `Pushed to ${upstream}.`;
  }
  if (action === "commit") {
    const hash = data.commit?.shortHash ?? next?.lastCommit?.shortHash ?? "";
    return hash.length > 0 ? `Committed as ${hash}.` : "Committed changes.";
  }
  if (action === "switch") {
    return `Switched to ${body.branch ?? "the branch"}.`;
  }
  return "Action completed.";
}

export interface GitErrorDetail {
  readonly title: string;
  readonly message: string;
}

/** Port of `describeError`: maps a coordinator code to the legacy title/message pair. */
export function gitErrorDetail(
  code: string | undefined,
  server: string,
  action: GitMutation,
): GitErrorDetail {
  if (code === "busy") {
    return {
      title: "Another git operation is running",
      message: "Another git operation is already running for this application.",
    };
  }
  if (code === "git_locked") {
    return {
      title: "Repository is locked",
      message:
        "Another git process is using this repository. Wait for it to finish or remove a stale lock.",
    };
  }
  if (code === "no_upstream") {
    return {
      title: "No upstream branch",
      message: "Set an upstream branch in git to update or push.",
    };
  }
  if (code === "detached") {
    return { title: "Detached HEAD", message: "Switch to a branch before doing this." };
  }
  if (code === "conflicts") {
    return { title: "Conflicts", message: "Resolve conflicts in the IDE before committing." };
  }
  if (code === "operation_in_progress") {
    return {
      title: "Git operation in progress",
      message: "Finish or abort the operation in the IDE first.",
    };
  }
  if (code === "nothing_to_commit") {
    return {
      title: "Nothing to commit",
      message: "The working tree has no changes to commit.",
    };
  }
  if (code === "branch_not_found") {
    return {
      title: "Branch not found",
      message: "That branch no longer exists. Choose another branch.",
    };
  }
  if (code === "diverged") {
    return {
      title: "Update stopped",
      message: "The branch has diverged from its upstream. Reconcile it in the IDE.",
    };
  }
  if (code === "worktree_dirty") {
    return {
      title: "Update stopped",
      message: "Commit or discard the changes that would be overwritten, then update again.",
    };
  }
  if (code === "push_rejected") {
    return {
      title: "Push rejected",
      message:
        "The remote has commits you do not have. Fetch and update the branch, then try again.",
    };
  }
  if (code === "auth_failed") {
    return {
      title: "Authentication failed",
      message: server.length > 0 ? server : "Git could not authenticate with the remote.",
    };
  }
  if (code === "timeout") {
    return {
      title: "Timed out",
      message: "The git operation timed out. Refresh status before retrying.",
    };
  }
  if (code === "output_too_large") {
    return {
      title: "Output too large",
      message: "Git produced too much output to read here. Use the IDE for this repository.",
    };
  }
  if (code === "invalid_input") {
    return {
      title: "Check the input",
      message: server.length > 0 ? server : "The value was not accepted.",
    };
  }
  if (code === "outside_workspace") {
    return {
      title: "Repository path outside the workspace",
      message:
        "Git actions are blocked because the registered path is outside the coordinator workspace.",
    };
  }
  if (code === "network") {
    return {
      title: "Connection lost",
      message:
        "The coordinator could not be reached. Check the connection and refresh status before retrying.",
    };
  }
  const title =
    action === "commit"
      ? "Commit failed"
      : action === "switch"
        ? "Could not switch branch"
        : "Action failed";
  return { title, message: server.length > 0 ? server : "The git operation failed." };
}

/** Port of the repository-body empty states for non-`ok` statuses. */
export interface GitRepoEmptyState {
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly detail: string | null;
  readonly action: "ide" | "project" | null;
}

export function gitRepoEmptyState(status: GitStatus): GitRepoEmptyState | null {
  if (status.state === "not_git") {
    return {
      icon: "branch",
      title: "Not a git repository",
      body: "This application path is not a git working tree. Git status and actions are unavailable.",
      detail: null,
      action: "ide",
    };
  }
  if (status.state === "not_root") {
    return {
      icon: "folder",
      title: "Not a repository root",
      body: "This application is inside a larger git repository. Git actions are only available when the application directory is the repository root.",
      detail: typeof status.root === "string" ? status.root : null,
      action: "ide",
    };
  }
  if (status.state === "missing") {
    return {
      icon: "folder",
      title: "Application path not found",
      body: "The registered path does not exist. Restore it or update the application manifest.",
      detail: null,
      action: "project",
    };
  }
  return status.message !== undefined && status.message.length > 0
    ? {
        icon: "alert-triangle",
        title: "Repository status unavailable",
        body: status.message,
        detail: null,
        action: null,
      }
    : null;
}

/** Port of `changeLabel` for the screen-reader file status text. */
export function changeCodeLabel(code: string | undefined): string {
  const value = typeof code === "string" ? code.toUpperCase() : "";
  if (value === "M") return "Modified";
  if (value === "A") return "Added";
  if (value === "D") return "Deleted";
  if (value === "R") return "Renamed";
  if (value === "C") return "Copied";
  if (value === "T") return "Type changed";
  if (value === "UU") return "Unmerged";
  if (value === "AA") return "Both added";
  if (value === "DD") return "Both deleted";
  if (value.includes("U")) return "Unmerged";
  if (value === "U") return "Unmerged";
  if (value === "?") return "Untracked";
  return "Changed";
}
