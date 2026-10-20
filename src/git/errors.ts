export type GitErrorCode =
  | "invalid_input"
  | "invalid_remote"
  | "outside_workspace"
  | "not_git"
  | "not_root"
  | "missing_path"
  | "busy"
  | "git_locked"
  | "no_upstream"
  | "detached"
  | "conflicts"
  | "operation_in_progress"
  | "nothing_to_commit"
  | "branch_not_found"
  | "diverged"
  | "worktree_dirty"
  | "push_rejected"
  | "auth_failed"
  | "timeout"
  | "output_too_large"
  | "git_failed";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly stderr?: string;
  /** Detected repository root, currently only populated for `not_root`. */
  readonly root?: string;

  constructor(code: GitErrorCode, message: string, options?: { stderr?: string; root?: string }) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.stderr = options?.stderr;
    this.root = options?.root;
  }
}
