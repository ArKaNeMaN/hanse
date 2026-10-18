import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

export type GitRepoState = "ok" | "not_git" | "not_root" | "missing";
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";
export type FileGroup = "staged" | "unstaged" | "untracked" | "conflicted";

export type GitErrorCode =
  | "invalid_input"
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

export interface GitFile {
  path: string;
  oldPath?: string;
  code: string;
  group: FileGroup;
}

export type GitBranch = string;

export interface GitUpstream {
  name: string;
  ahead: number;
  behind: number;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitLastCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  committedAt: string;
}

export interface GitStatus {
  state: GitRepoState;
  root?: string;
  message?: string;
  branch?: { name: string | null; detached: boolean; head: string | null };
  upstream?: GitUpstream | null;
  clean?: boolean;
  files?: GitFile[];
  branches?: GitBranch[];
  remotes?: GitRemote[];
  lastCommit?: GitLastCommit | null;
  operation?: GitOperation | null;
  conflicted?: boolean;
  identity?: { configured: boolean };
}

export interface ResolvedRepository {
  root: string;
  appDir: string;
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
}

/** Result returned by every mutating operation. The HTTP layer maps this to its response shape. */
export interface GitActionResult {
  status: GitStatus | null;
  message: string;
  warning?: string;
  commit?: GitCommitInfo;
}

export interface GitCommand {
  bin: string;
  args: string[];
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  killSignal: NodeJS.Signals | number;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable command seam; must never use a shell. */
export type GitRunner = (command: GitCommand) => Promise<GitCommandResult>;

export interface GitTimeouts {
  status: number;
  mutation: number;
  fetch: number;
  update: number;
  push: number;
}

export interface GitServiceOptions {
  workspaceRoot: string;
  gitBin?: string;
  runner?: GitRunner;
  timeouts?: Partial<GitTimeouts>;
}

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

const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ERROR_OUTPUT = 4000;

const DEFAULT_TIMEOUTS: GitTimeouts = {
  status: 30_000,
  mutation: 30_000,
  fetch: 120_000,
  update: 120_000,
  push: 180_000,
};

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  LC_ALL: "C",
  LANG: "C",
  GIT_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_PAGER: "cat",
};

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

function hasControlChars(value: string, allowNewlineAndTab: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (allowNewlineAndTab && (code === 0x09 || code === 0x0a)) {
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Redact credentials embedded in a URL (`scheme://userinfo@host`). */
export function redactUserinfo(value: string): string {
  return value.replace(URL_USERINFO, "$1***@");
}

function redactAndTruncate(value: string): string {
  return redactUserinfo(value).slice(0, MAX_ERROR_OUTPUT);
}

const defaultRunner: GitRunner = (command) =>
  new Promise((resolve, reject) => {
    execFile(
      command.bin,
      command.args,
      {
        cwd: command.cwd,
        env: command.env,
        timeout: command.timeout,
        maxBuffer: command.maxBuffer,
        killSignal: command.killSignal,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: error.code });
          return;
        }
        reject(error);
      },
    );
  });

function runnerFailure(error: unknown): GitError {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = record.code;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new GitError("output_too_large", "Git output exceeded the 8 MiB limit.");
  }
  if (code === "ETIMEDOUT" || record.killed === true) {
    return new GitError("timeout", "Git command timed out.");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitError("git_failed", redactAndTruncate(message));
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resultText(result: GitCommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function looksLikeAuthFailure(result: GitCommandResult): boolean {
  return /authentication failed|could not read username|could not read password|permission denied|host key verification failed|terminal prompts disabled|invalid username or password|access denied/i.test(
    resultText(result),
  );
}

function failureFromResult(code: GitErrorCode, result: GitCommandResult): GitError {
  const text =
    result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code}`;
  const message = redactAndTruncate(text);
  return new GitError(code, message, { stderr: message });
}

function takeFields(record: string, count: number): { fields: string[]; rest: string } | undefined {
  const fields: string[] = [];
  let index = 0;
  for (let field = 0; field < count; field += 1) {
    const space = record.indexOf(" ", index);
    if (space < 0) {
      return undefined;
    }
    fields.push(record.slice(index, space));
    index = space + 1;
  }
  return { fields, rest: record.slice(index) };
}

export interface PorcelainStatus {
  branch: { name: string | null; detached: boolean; head: string | null };
  upstream: GitUpstream | null;
  files: GitFile[];
}

/**
 * Parse `git status --porcelain=v2 --branch --untracked-files=all -z` output.
 *
 * With `-z` every record (including `# branch.*` headers) is NUL-terminated, and rename/copy
 * records carry the original path in the following NUL field. Paths therefore contain spaces,
 * newlines, and non-ASCII bytes verbatim; never split records on whitespace.
 */
export function parsePorcelainV2(raw: string): PorcelainStatus {
  let head: string | null = null;
  let name: string | null = null;
  let detached = false;
  let upstreamName: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  const records = raw.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) {
      continue;
    }

    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.oid ")) {
        const value = record.slice("# branch.oid ".length);
        head = value === "(initial)" ? null : value;
      } else if (record.startsWith("# branch.head ")) {
        const value = record.slice("# branch.head ".length);
        if (value === "(detached)") {
          detached = true;
          name = null;
        } else {
          detached = false;
          name = value;
        }
      } else if (record.startsWith("# branch.upstream ")) {
        upstreamName = record.slice("# branch.upstream ".length);
      } else if (record.startsWith("# branch.ab ")) {
        const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
        if (match !== null) {
          ahead = Number.parseInt(match[1] ?? "0", 10);
          behind = Number.parseInt(match[2] ?? "0", 10);
        }
      }
      continue;
    }

    const kind = record[0];
    if (kind === "1") {
      const parsed = takeFields(record, 8);
      if (parsed === undefined) {
        continue;
      }
      appendXY(files, parsed.fields[1] ?? "..", parsed.rest);
    } else if (kind === "2") {
      const parsed = takeFields(record, 9);
      if (parsed === undefined) {
        continue;
      }
      const oldPath = records[index + 1];
      index += 1;
      appendXY(files, parsed.fields[1] ?? "..", parsed.rest, oldPath);
    } else if (kind === "u") {
      const parsed = takeFields(record, 10);
      if (parsed === undefined) {
        continue;
      }
      // Preserve the XY pair (e.g. UU, AA, DD) for accessible conflict display.
      files.push({ path: parsed.rest, code: parsed.fields[1] ?? "U", group: "conflicted" });
    } else if (kind === "?") {
      files.push({ path: record.slice(2), code: "?", group: "untracked" });
    }
  }

  return {
    branch: { name, detached, head },
    upstream: upstreamName === undefined ? null : { name: upstreamName, ahead, behind },
    files,
  };
}

function appendXY(files: GitFile[], xy: string, filePath: string, oldPath?: string): void {
  const indexState = xy[0] ?? ".";
  const worktreeState = xy[1] ?? ".";
  if (indexState !== ".") {
    files.push({
      path: filePath,
      ...(oldPath === undefined ? {} : { oldPath }),
      code: indexState,
      group: "staged",
    });
  }
  if (worktreeState !== ".") {
    files.push({
      path: filePath,
      ...(oldPath === undefined ? {} : { oldPath }),
      code: worktreeState,
      group: "unstaged",
    });
  }
}

function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<string, { fetch?: string; push?: string }>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (match === null) {
      continue;
    }
    const name = match[1] ?? "";
    const url = match[2] ?? "";
    const kind = match[3];
    const entry = remotes.get(name) ?? {};
    if (kind === "fetch") {
      entry.fetch = url;
    } else {
      entry.push = url;
    }
    remotes.set(name, entry);
  }
  return [...remotes.entries()].map(([name, entry]) => ({
    name,
    url: redactUserinfo(entry.fetch ?? entry.push ?? ""),
  }));
}

function operationFromPaths(root: string, output: string): Promise<GitOperation | null> {
  const paths = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const markers: Array<{ operation: GitOperation; indexes: number[] }> = [
    { operation: "merge", indexes: [0] },
    { operation: "cherry-pick", indexes: [1] },
    { operation: "revert", indexes: [2] },
    { operation: "rebase", indexes: [3, 4] },
  ];

  return (async () => {
    for (const marker of markers) {
      for (const index of marker.indexes) {
        const relative = paths[index];
        if (relative === undefined) {
          continue;
        }
        try {
          await access(path.isAbsolute(relative) ? relative : path.resolve(root, relative));
          return marker.operation;
        } catch {
          // Marker is absent.
        }
      }
    }
    return null;
  })();
}

/** Read-only and mutating git operations for a single application repository. */
export class GitService {
  readonly #workspaceRoot: string;
  readonly #gitBin: string;
  readonly #runner: GitRunner;
  readonly #timeouts: GitTimeouts;
  readonly #mutationLocks = new Set<string>();

  constructor(options: GitServiceOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#gitBin = options.gitBin ?? "git";
    this.#runner = options.runner ?? defaultRunner;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  async resolveRepository(projectRoot: string, appPath: string): Promise<ResolvedRepository> {
    const candidate = path.isAbsolute(appPath) ? appPath : path.resolve(projectRoot, appPath);
    let appReal: string;
    try {
      appReal = await realpath(candidate);
    } catch {
      throw new GitError("missing_path", `application path not found: ${candidate}`);
    }

    let workspaceReal: string;
    try {
      workspaceReal = await realpath(this.#workspaceRoot);
    } catch {
      throw new GitError("missing_path", `workspace root not found: ${this.#workspaceRoot}`);
    }

    if (!isContained(workspaceReal, appReal)) {
      throw new GitError("outside_workspace", "application path is outside the workspace");
    }

    const inside = await this.#run(
      appReal,
      ["rev-parse", "--is-inside-work-tree"],
      this.#timeouts.status,
    );
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      throw new GitError("not_git", "application path is not a git working tree", {
        root: appReal,
      });
    }

    const toplevel = await this.#run(
      appReal,
      ["rev-parse", "--show-toplevel"],
      this.#timeouts.status,
    );
    if (toplevel.code !== 0) {
      throw new GitError("not_git", "application path is not a git working tree", {
        root: appReal,
      });
    }
    const toplevelPath = toplevel.stdout.replace(/\r?\n$/, "");
    let toplevelReal: string;
    try {
      toplevelReal = await realpath(toplevelPath);
    } catch {
      throw new GitError("not_git", "repository root cannot be resolved");
    }

    // Re-check containment after git reports its root so a symlinked or nested repo cannot escape.
    if (!isContained(workspaceReal, toplevelReal)) {
      throw new GitError("outside_workspace", "repository root is outside the workspace");
    }
    if (toplevelReal !== appReal) {
      throw new GitError("not_root", "application directory is not the repository root", {
        root: toplevelReal,
      });
    }

    return { root: toplevelReal, appDir: appReal };
  }

  /** Status for a registered application path; maps resolution failures to non-ok states. */
  async statusFor(projectRoot: string, appPath: string): Promise<GitStatus> {
    try {
      const resolved = await this.resolveRepository(projectRoot, appPath);
      return await this.status(resolved);
    } catch (error) {
      if (error instanceof GitError) {
        if (error.code === "missing_path") {
          return { state: "missing", message: error.message };
        }
        if (error.code === "not_git") {
          return { state: "not_git", root: error.root, message: error.message };
        }
        if (error.code === "not_root") {
          return { state: "not_root", root: error.root, message: error.message };
        }
      }
      throw error;
    }
  }

  async status(resolved: ResolvedRepository): Promise<GitStatus> {
    const root = resolved.root;
    const porcelain = await this.#run(
      root,
      [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "-z",
      ],
      this.#timeouts.status,
    );
    if (porcelain.code !== 0) {
      throw failureFromResult("git_failed", porcelain);
    }
    const parsed = parsePorcelainV2(porcelain.stdout);

    const branchOutput = await this.#run(
      root,
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      this.#timeouts.status,
    );
    if (branchOutput.code !== 0) {
      throw failureFromResult("git_failed", branchOutput);
    }
    const names = branchOutput.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const current = parsed.branch.detached ? null : parsed.branch.name;
    const branches: GitBranch[] = [...names];
    if (current !== null && !names.includes(current)) {
      // An unborn branch is not listed by for-each-ref yet.
      branches.push(current);
    }

    const remoteOutput = await this.#run(root, ["remote", "-v"], this.#timeouts.status);
    if (remoteOutput.code !== 0) {
      throw failureFromResult("git_failed", remoteOutput);
    }
    const remotes = parseRemotes(remoteOutput.stdout);

    const lastCommit = await this.#readLastCommit(root);

    const operationOutput = await this.#run(
      root,
      [
        "rev-parse",
        "--git-path",
        "MERGE_HEAD",
        "--git-path",
        "CHERRY_PICK_HEAD",
        "--git-path",
        "REVERT_HEAD",
        "--git-path",
        "rebase-merge",
        "--git-path",
        "rebase-apply",
      ],
      this.#timeouts.status,
    );
    const operation =
      operationOutput.code === 0 ? await operationFromPaths(root, operationOutput.stdout) : null;

    const identityOutput = await this.#run(
      root,
      ["var", "GIT_AUTHOR_IDENT"],
      this.#timeouts.status,
    );
    const identity = { configured: identityOutput.code === 0 };

    return {
      state: "ok",
      root,
      branch: parsed.branch,
      upstream: parsed.upstream,
      clean: parsed.files.length === 0,
      files: parsed.files,
      branches,
      remotes,
      lastCommit,
      operation,
      conflicted: parsed.files.some((file) => file.group === "conflicted"),
      identity,
    };
  }

  async fetch(resolved: ResolvedRepository): Promise<GitActionResult> {
    return this.#mutate(resolved, async () => {
      const result = await this.#run(
        resolved.root,
        ["fetch", "--all", "--prune"],
        this.#timeouts.fetch,
      );
      if (result.code !== 0) {
        throw remoteFailure("git_failed", result);
      }
      return this.#finish(resolved, () => "Fetched all remotes.");
    });
  }

  async update(resolved: ResolvedRepository): Promise<GitActionResult> {
    return this.#mutate(resolved, async () => {
      const before = await this.status(resolved);
      this.#guardOperation(before);
      if (before.branch?.detached === true) {
        throw new GitError("detached", "Detached HEAD. Switch to a branch before updating.");
      }
      if (before.upstream === null || before.upstream === undefined) {
        throw new GitError("no_upstream", "The current branch has no upstream.");
      }

      const result = await this.#run(resolved.root, ["pull", "--ff-only"], this.#timeouts.update);
      if (result.code !== 0) {
        throw updateFailure(result);
      }
      return this.#finish(resolved, (status) => {
        const shortHash = status?.lastCommit?.shortHash;
        return shortHash === undefined ? "Branch updated." : `Branch updated to ${shortHash}.`;
      });
    });
  }

  async switchBranch(resolved: ResolvedRepository, branch: string): Promise<GitActionResult> {
    return this.#mutate(resolved, async () => {
      const before = await this.status(resolved);
      this.#guardOperation(before);
      this.#validateBranchName(branch);

      const branches = await this.#localBranches(resolved.root);
      if (!branches.includes(branch)) {
        throw new GitError("branch_not_found", `Branch not found: ${branch}`);
      }

      const result = await this.#run(
        resolved.root,
        ["switch", "--", branch],
        this.#timeouts.mutation,
      );
      if (result.code !== 0) {
        if (/invalid reference|did not match any|no such branch/i.test(resultText(result))) {
          throw failureFromResult("branch_not_found", result);
        }
        throw failureFromResult("git_failed", result);
      }
      return this.#finish(resolved, () => `Switched to ${branch}.`);
    });
  }

  async commitAll(resolved: ResolvedRepository, message: string): Promise<GitActionResult> {
    return this.#mutate(resolved, async () => {
      const trimmed = this.#validateCommitMessage(message);
      const before = await this.status(resolved);
      this.#guardOperation(before);
      if (before.branch?.detached === true) {
        throw new GitError("detached", "Detached HEAD. Switch to a branch before committing.");
      }
      if (before.identity?.configured !== true) {
        throw new GitError(
          "git_failed",
          "Set user.name and user.email in the repository or host git config before committing.",
        );
      }
      if (before.files === undefined || before.files.length === 0) {
        throw new GitError("nothing_to_commit", "Nothing to commit.");
      }
      await this.#assertSigningDisabled(resolved.root);

      const staged = await this.#run(resolved.root, ["add", "-A"], this.#timeouts.mutation);
      if (staged.code !== 0) {
        throw failureFromResult("git_failed", staged);
      }

      const committed = await this.#run(
        resolved.root,
        ["commit", "-m", trimmed],
        this.#timeouts.mutation,
      );
      if (committed.code !== 0) {
        const text = resultText(committed);
        if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(text)) {
          throw new GitError("nothing_to_commit", "Nothing to commit.");
        }
        const detail = committed.stderr.trim() || committed.stdout.trim();
        throw new GitError(
          "git_failed",
          redactAndTruncate(
            `Commit failed; changes remain staged.${detail.length > 0 ? ` ${detail}` : ""}`,
          ),
          { stderr: redactAndTruncate(detail) },
        );
      }

      // The commit already succeeded; never report an error that invites a duplicate commit.
      const commitInfo =
        (await this.#readCommitInfo(resolved.root)) ?? commitFromOutput(committed.stdout, trimmed);

      const result = await this.#finish(resolved, (status) => {
        const shortHash = status?.lastCommit?.shortHash ?? commitInfo.shortHash;
        return shortHash.length > 0 ? `Committed as ${shortHash}.` : "Commit created.";
      });
      return { ...result, commit: commitInfo };
    });
  }

  async push(resolved: ResolvedRepository): Promise<GitActionResult> {
    return this.#mutate(resolved, async () => {
      const before = await this.status(resolved);
      const branch = before.branch;
      if (branch === undefined || branch.detached || branch.name === null) {
        throw new GitError("detached", "Detached HEAD. Switch to a branch before pushing.");
      }

      let args: string[];
      let upstreamName: string;
      if (before.upstream === null || before.upstream === undefined) {
        if (!(before.remotes ?? []).some((remote) => remote.name === "origin")) {
          throw new GitError("no_upstream", "The current branch has no upstream.");
        }
        args = ["push", "-u", "origin", branch.name];
        upstreamName = `origin/${branch.name}`;
      } else {
        args = ["push"];
        upstreamName = before.upstream.name;
      }

      const result = await this.#run(resolved.root, args, this.#timeouts.push);
      if (result.code !== 0) {
        throw remoteFailure("git_failed", result, "push_rejected");
      }
      return this.#finish(resolved, () => `Pushed to ${upstreamName}.`);
    });
  }

  #run(root: string, args: string[], timeout: number): Promise<GitCommandResult> {
    const command: GitCommand = {
      bin: this.#gitBin,
      args: ["-c", "color.ui=false", ...args],
      cwd: root,
      timeout,
      env: { ...process.env, ...GIT_ENV },
      maxBuffer: MAX_BUFFER,
      killSignal: "SIGKILL",
    };
    let pending: Promise<GitCommandResult>;
    try {
      pending = this.#runner(command);
    } catch (error) {
      return Promise.reject(runnerFailure(error));
    }
    return pending.catch((error: unknown) => {
      throw runnerFailure(error);
    });
  }

  async #mutate<T>(resolved: ResolvedRepository, action: () => Promise<T>): Promise<T> {
    const key = resolved.root;
    if (this.#mutationLocks.has(key)) {
      throw new GitError("busy", "Another git operation is already running for this repository.");
    }
    this.#mutationLocks.add(key);
    try {
      await this.#assertNoIndexLock(resolved.root);
      return await action();
    } finally {
      this.#mutationLocks.delete(key);
    }
  }

  async #assertNoIndexLock(root: string): Promise<void> {
    const lockPath = await this.#gitPath(root, "index.lock");
    try {
      await access(lockPath);
    } catch {
      return;
    }
    throw new GitError("git_locked", "Another git process is using this repository.");
  }

  async #gitPath(root: string, name: string): Promise<string> {
    const result = await this.#run(root, ["rev-parse", "--git-path", name], this.#timeouts.status);
    if (result.code !== 0) {
      throw failureFromResult("git_failed", result);
    }
    const value = result.stdout.replace(/\r?\n$/, "");
    return path.isAbsolute(value) ? value : path.resolve(root, value);
  }

  async #readLastCommit(root: string): Promise<GitLastCommit | null> {
    const result = await this.#run(
      root,
      ["log", "-1", "--format=%H%x00%h%x00%s%x00%an%x00%cI"],
      this.#timeouts.status,
    );
    if (result.code !== 0) {
      const text = resultText(result);
      if (
        result.code === 128 &&
        /does not have any commits yet|unknown revision|bad revision|needed a single revision/i.test(
          text,
        )
      ) {
        return null;
      }
      throw failureFromResult("git_failed", result);
    }
    const fields = result.stdout.replace(/\r?\n$/, "").split("\0");
    if (fields.length !== 5) {
      throw new GitError("git_failed", "Unexpected git log output.");
    }
    const [hash, shortHash, subject, author, committedAt] = fields;
    if (
      hash === undefined ||
      shortHash === undefined ||
      subject === undefined ||
      author === undefined ||
      committedAt === undefined
    ) {
      throw new GitError("git_failed", "Unexpected git log output.");
    }
    return { hash, shortHash, subject, author, committedAt };
  }

  async #readCommitInfo(root: string): Promise<GitCommitInfo | null> {
    const result = await this.#run(
      root,
      ["log", "-1", "--format=%H%x00%h%x00%s"],
      this.#timeouts.mutation,
    );
    if (result.code !== 0) {
      return null;
    }
    const fields = result.stdout.replace(/\r?\n$/, "").split("\0");
    if (fields.length !== 3) {
      return null;
    }
    const [hash, shortHash, subject] = fields;
    if (hash === undefined || shortHash === undefined || subject === undefined) {
      return null;
    }
    return { hash, shortHash, subject };
  }

  async #localBranches(root: string): Promise<string[]> {
    const result = await this.#run(
      root,
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      this.#timeouts.status,
    );
    if (result.code !== 0) {
      throw failureFromResult("git_failed", result);
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async #assertSigningDisabled(root: string): Promise<void> {
    const result = await this.#run(
      root,
      ["config", "--bool", "commit.gpgsign"],
      this.#timeouts.status,
    );
    if (result.code === 0 && result.stdout.trim() === "true") {
      throw new GitError("git_failed", "Commit signing is enabled; commit from the IDE.");
    }
  }

  #validateBranchName(branch: string): void {
    if (branch.length === 0 || branch.startsWith("-") || hasControlChars(branch, false)) {
      throw new GitError("branch_not_found", "Invalid branch name.");
    }
  }

  #validateCommitMessage(message: string): string {
    const trimmed = message.trim();
    if (trimmed.length === 0 || Array.from(trimmed).length > 4000) {
      throw new GitError("invalid_input", "Commit message must be 1-4000 characters.");
    }
    if (hasControlChars(trimmed, true)) {
      throw new GitError("invalid_input", "Commit message contains control characters.");
    }
    return trimmed;
  }

  #guardOperation(status: GitStatus): void {
    if (status.operation !== null && status.operation !== undefined) {
      throw new GitError(
        "operation_in_progress",
        "Finish or abort the in-progress git operation in the IDE.",
      );
    }
    if (status.conflicted === true) {
      throw new GitError("conflicts", "Resolve conflicts in the IDE before continuing.");
    }
  }

  async #finish(
    resolved: ResolvedRepository,
    buildMessage: (status: GitStatus | null) => string,
  ): Promise<GitActionResult> {
    let status: GitStatus | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        status = await this.status(resolved);
        break;
      } catch {
        status = null;
      }
    }
    const message = buildMessage(status);
    if (status !== null) {
      return { status, message };
    }
    return { status: null, message, warning: "Action completed; refresh status." };
  }
}

function commitFromOutput(output: string, message: string): GitCommitInfo {
  const summary = output.split("\n").find((line) => line.startsWith("["));
  const match = summary === undefined ? null : /\[[^\]]*?([0-9a-f]{7,40})\]/.exec(summary);
  const shortHash = match?.[1] ?? "";
  return { hash: shortHash, shortHash, subject: message.split("\n")[0] ?? "" };
}

function remoteFailure(
  fallback: GitErrorCode,
  result: GitCommandResult,
  rejectedCode?: GitErrorCode,
): GitError {
  if (looksLikeAuthFailure(result)) {
    return failureFromResult("auth_failed", result);
  }
  if (
    rejectedCode !== undefined &&
    /rejected|non-fast-forward|fetch first|failed to push/i.test(resultText(result))
  ) {
    return failureFromResult(rejectedCode, result);
  }
  return failureFromResult(fallback, result);
}

function updateFailure(result: GitCommandResult): GitError {
  if (looksLikeAuthFailure(result)) {
    return failureFromResult("auth_failed", result);
  }
  if (
    /would be overwritten|please commit your changes or stash them|local changes/i.test(
      resultText(result),
    )
  ) {
    return failureFromResult("worktree_dirty", result);
  }
  if (/not possible to fast-forward|divergent branches|have diverged/i.test(resultText(result))) {
    return failureFromResult("diverged", result);
  }
  return failureFromResult("git_failed", result);
}
