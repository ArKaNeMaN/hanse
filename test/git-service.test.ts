import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GitCommand,
  type GitCommandResult,
  type GitRunner,
  GitService,
  parsePorcelainV2,
} from "../src/git/service.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  LC_ALL: "C",
  LANG: "C",
  GIT_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_PAGER: "cat",
};

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "hanse-git-")));
  dirs.push(dir);
  return dir;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...GIT_ENV, ...env },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
  } catch (error) {
    const record = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };
    return {
      stdout: String(record.stdout ?? ""),
      stderr: String(record.stderr ?? ""),
      code: typeof record.code === "number" ? record.code : 1,
    };
  }
}

/** Mirrors the production default runner so injected runners can delegate real work. */
const realRunner: GitRunner = (command) =>
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

async function initRepo(root: string, name = "repo"): Promise<string> {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await configureIdentity(dir);
  return dir;
}

async function configureIdentity(dir: string): Promise<void> {
  await git(dir, ["config", "user.name", "Test Operator"]);
  await git(dir, ["config", "user.email", "operator@example.com"]);
}

async function setupOrigin(root: string): Promise<{ repo: string; bare: string }> {
  const repo = await initRepo(root);
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  // The git workbench only accepts file:// remotes inside the application directory.
  const bare = path.join(repo, ".git", "remotes", "remote.git");
  mkdirSync(bare, { recursive: true });
  await git(bare, ["init", "--bare", "-b", "main"]);
  await git(repo, ["remote", "add", "origin", pathToFileURL(bare).href]);
  await git(repo, ["push", "-u", "origin", "main"]);
  return { repo, bare };
}

async function clonePeer(root: string, bare: string): Promise<string> {
  const peer = path.join(root, "peer");
  await git(root, ["clone", pathToFileURL(bare).href, peer]);
  await configureIdentity(peer);
  return peer;
}

function resolve(repo: string): { root: string; appDir: string } {
  return { root: realpathSync(repo), appDir: realpathSync(repo) };
}

function statusOutput(...records: string[]): string {
  return `${records.join("\0")}\0`;
}

describe("parsePorcelainV2", () => {
  it("parses a clean branch with an upstream", () => {
    const parsed = parsePorcelainV2(
      statusOutput(
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
      ),
    );
    expect(parsed.branch).toEqual({ name: "main", detached: false, head: "abc123" });
    expect(parsed.upstream).toEqual({ name: "origin/main", ahead: 2, behind: 3 });
    expect(parsed.files).toEqual([]);
  });

  it("parses an unstaged-only change", () => {
    const parsed = parsePorcelainV2(
      statusOutput(
        "# branch.oid abc123",
        "# branch.head main",
        "1 .M N... 100644 100644 100644 aaa bbb file.txt",
      ),
    );
    expect(parsed.files).toEqual([{ path: "file.txt", code: "M", group: "unstaged" }]);
  });

  it("parses a staged-only change", () => {
    const parsed = parsePorcelainV2(
      statusOutput("1 M. N... 100644 100644 100644 aaa bbb file.txt"),
    );
    expect(parsed.files).toEqual([{ path: "file.txt", code: "M", group: "staged" }]);
  });

  it("emits two entries for MM", () => {
    const parsed = parsePorcelainV2(
      statusOutput("1 MM N... 100644 100644 100644 aaa bbb file.txt"),
    );
    expect(parsed.files).toEqual([
      { path: "file.txt", code: "M", group: "staged" },
      { path: "file.txt", code: "M", group: "unstaged" },
    ]);
  });

  it("parses renames with the original path from the following NUL field", () => {
    const parsed = parsePorcelainV2(
      statusOutput("2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt", "old name.txt"),
    );
    expect(parsed.files).toEqual([
      {
        path: "new name.txt",
        oldPath: "old name.txt",
        code: "R",
        group: "staged",
      },
    ]);
  });

  it("parses copies", () => {
    const parsed = parsePorcelainV2(
      statusOutput("2 C. N... 100644 100644 100644 aaa bbb C75 copy.txt", "source.txt"),
    );
    expect(parsed.files).toEqual([
      { path: "copy.txt", oldPath: "source.txt", code: "C", group: "staged" },
    ]);
  });

  it("parses conflicted records and preserves the XY pair", () => {
    const parsed = parsePorcelainV2(
      statusOutput("u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt"),
    );
    expect(parsed.files).toEqual([{ path: "conflicted.txt", code: "UU", group: "conflicted" }]);
  });

  it("parses detached HEAD and unborn branches", () => {
    const detached = parsePorcelainV2(
      statusOutput("# branch.oid abc123", "# branch.head (detached)"),
    );
    expect(detached.branch).toEqual({ name: null, detached: true, head: "abc123" });

    const unborn = parsePorcelainV2(statusOutput("# branch.oid (initial)", "# branch.head main"));
    expect(unborn.branch).toEqual({ name: "main", detached: false, head: null });
    expect(unborn.upstream).toBeNull();
  });

  it("parses a branch without an upstream", () => {
    const parsed = parsePorcelainV2(statusOutput("# branch.oid abc123", "# branch.head topic"));
    expect(parsed.upstream).toBeNull();
  });

  it("preserves spaces, newlines, and non-ASCII in untracked paths", () => {
    const parsed = parsePorcelainV2(
      statusOutput("? file with space.txt", "? line\nbreak.txt", "? \u00fcn\u00efcode.txt"),
    );
    expect(parsed.files.map((file) => file.path)).toEqual([
      "file with space.txt",
      "line\nbreak.txt",
      "\u00fcn\u00efcode.txt",
    ]);
  });
});

describe("GitService status", () => {
  it("reports a clean repository", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-m", "first"]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    const status = await service.status(resolved);

    expect(status.state).toBe("ok");
    expect(status.root).toBe(realpathSync(repo));
    expect(status.clean).toBe(true);
    expect(status.files).toEqual([]);
    expect(status.branch).toEqual({
      name: "main",
      detached: false,
      head: status.lastCommit?.hash ?? "",
    });
    expect(status.upstream).toBeNull();
    expect(status.branches).toEqual(["main"]);
    expect(status.operation).toBeNull();
    expect(status.conflicted).toBe(false);
    expect(status.identity).toEqual({ configured: true });
    expect(status.lastCommit).toMatchObject({
      shortHash: expect.any(String),
      subject: "first",
      author: "Test Operator",
      committedAt: expect.any(String),
    });
    expect(status.remotes).toEqual([]);
  });

  it("groups staged, unstaged, and untracked files and keeps ignored files out", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    writeFileSync(path.join(repo, "tracked.txt"), "one\n");
    writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);

    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    writeFileSync(path.join(repo, "staged.txt"), "staged\n");
    await git(repo, ["add", "staged.txt"]);
    writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    writeFileSync(path.join(repo, "ignored.txt"), "ignored\n");

    const service = new GitService({ workspaceRoot: root });
    const status = await service.status(await service.resolveRepository(root, "repo"));

    expect(status.clean).toBe(false);
    expect(status.files).toEqual(
      expect.arrayContaining([
        { path: "staged.txt", code: "A", group: "staged" },
        { path: "tracked.txt", code: "M", group: "unstaged" },
        { path: "untracked.txt", code: "?", group: "untracked" },
      ]),
    );
    expect(status.files?.some((file) => file.path === "ignored.txt")).toBe(false);
  });

  it("returns lastCommit null for an unborn repository", async () => {
    const root = workspace();
    await initRepo(root);
    const service = new GitService({ workspaceRoot: root });
    const status = await service.status(await service.resolveRepository(root, "repo"));

    expect(status.lastCommit).toBeNull();
    expect(status.clean).toBe(true);
    expect(status.branch).toEqual({ name: "main", detached: false, head: null });
    expect(status.branches).toEqual(["main"]);
  });

  it("detects an in-progress merge", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-m", "first"]);
    writeFileSync(
      path.join(repo, ".git", "MERGE_HEAD"),
      `${(await git(repo, ["rev-parse", "HEAD"])).stdout}`,
    );

    const service = new GitService({ workspaceRoot: root });
    const status = await service.status(await service.resolveRepository(root, "repo"));
    expect(status.operation).toBe("merge");
  });

  it("redacts credentials and dedupes remotes, preferring the fetch URL", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    await git(repo, ["remote", "add", "origin", "https://ghp_token@example.com/one.git"]);
    await git(repo, ["remote", "add", "creds", "https://user:secret@example.com/two.git"]);
    await git(repo, [
      "remote",
      "set-url",
      "--push",
      "creds",
      "https://push:secret@example.com/three.git",
    ]);
    await git(repo, [
      "remote",
      "add",
      "encoded",
      "https://user%40name:p%40ss@example.com/four.git",
    ]);

    const service = new GitService({ workspaceRoot: root });
    const status = await service.status(await service.resolveRepository(root, "repo"));
    const urls = (status.remotes ?? []).map((remote) => remote.url);

    expect(status.remotes?.map((remote) => remote.name)).toEqual(["creds", "encoded", "origin"]);
    expect(status.remotes?.find((remote) => remote.name === "creds")?.url).toContain("/two.git");
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toContain("***@");
      expect(url).not.toContain("secret");
      expect(url).not.toContain("ghp_token");
      expect(url).not.toContain("p%40ss");
    }
  });

  it("uses argument arrays, toplevel cwd, and the fixed environment", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-m", "first"]);

    const commands: GitCommand[] = [];
    const runner: GitRunner = (command) => {
      commands.push(command);
      return realRunner(command);
    };
    const service = new GitService({ workspaceRoot: root, runner });
    await service.status(await service.resolveRepository(root, "repo"));

    const fixedConfig = [
      "-c",
      "color.ui=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "submodule.recurse=false",
      "-c",
      "core.pager=cat",
      "-c",
      "core.sshCommand=ssh",
    ];
    for (const command of commands) {
      expect(command.bin).toBe("git");
      expect(command.cwd).toBe(realpathSync(repo));
      expect(command.args.slice(0, fixedConfig.length)).toEqual(fixedConfig);
      expect(command.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(command.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(command.env.GIT_SSH_COMMAND).toBe("ssh");
      expect(command.env.GCM_INTERACTIVE).toBe("never");
      expect(command.env.LC_ALL).toBe("C");
      expect(command.env.GIT_PAGER).toBe("cat");
      expect(command.env.HOME).toEqual(expect.any(String));
      expect(command.maxBuffer).toBe(8 * 1024 * 1024);
      expect(command.killSignal).toBe("SIGKILL");
    }
    const statusCommand = commands.find((command) => command.args.includes("status"));
    expect(statusCommand?.args).toContain("--porcelain=v2");
    expect(statusCommand?.args).toContain("-z");
    expect(statusCommand?.timeout).toBe(30_000);
  });
});

describe("GitService repository resolution", () => {
  it("distinguishes missing, non-git, outside-workspace, and non-root paths", async () => {
    const root = workspace();
    const service = new GitService({ workspaceRoot: root });
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "hanse-git-out-")));
    dirs.push(outside);

    const missing = await service.resolveRepository(root, "nope").catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: "missing_path" });

    const plain = path.join(root, "plain");
    mkdirSync(plain);
    const notGit = await service.resolveRepository(root, "plain").catch((error: unknown) => error);
    expect(notGit).toMatchObject({ code: "not_git" });

    const outsideRepo = await initRepo(outside, "repo");
    const outsideError = await service
      .resolveRepository(outside, "repo")
      .catch((error: unknown) => error);
    expect(outsideError).toMatchObject({ code: "outside_workspace" });
    expect(outsideRepo).toBeDefined();

    const parent = await initRepo(root, "parent");
    const child = path.join(parent, "child");
    mkdirSync(child);
    const notRoot = await service
      .resolveRepository(root, "parent/child")
      .catch((error: unknown) => error);
    expect(notRoot).toMatchObject({ code: "not_root", root: realpathSync(parent) });

    const absolute = await service.resolveRepository(root, realpathSync(parent));
    expect(absolute.appDir).toBe(realpathSync(parent));
  });

  it("maps resolution failures to non-ok status states", async () => {
    const root = workspace();
    const service = new GitService({ workspaceRoot: root });
    expect((await service.statusFor(root, "nope")).state).toBe("missing");
    mkdirSync(path.join(root, "plain"));
    expect((await service.statusFor(root, "plain")).state).toBe("not_git");
    const parent = await initRepo(root, "parent");
    mkdirSync(path.join(parent, "child"));
    const notRoot = await service.statusFor(root, "parent/child");
    expect(notRoot.state).toBe("not_root");
    expect(notRoot.root).toBe(realpathSync(parent));
  });
});

describe("GitService mutations", () => {
  it("fetches and fast-forward updates from a file remote", async () => {
    const root = workspace();
    const { repo, bare } = await setupOrigin(root);
    const peer = await clonePeer(root, bare);
    writeFileSync(path.join(peer, "peer.txt"), "peer\n");
    await git(peer, ["add", "peer.txt"]);
    await git(peer, ["commit", "-m", "peer change"]);
    await git(peer, ["push"]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    const fetched = await service.fetch(resolved);
    expect(fetched.message).toBe("Fetched all remotes.");
    expect(fetched.status?.upstream).toMatchObject({ ahead: 0, behind: 1 });

    const updated = await service.update(resolved);
    expect(updated.message).toBe(`Branch updated to ${updated.status?.lastCommit?.shortHash}.`);
    expect(updated.status?.lastCommit?.subject).toBe("peer change");
    expect(updated.status?.upstream).toMatchObject({ ahead: 0, behind: 0 });
    expect(repo).toBeDefined();
  });

  it("pushes an existing upstream", async () => {
    const root = workspace();
    const { repo, bare } = await setupOrigin(root);
    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "local change"]);

    const service = new GitService({ workspaceRoot: root });
    const result = await service.push(await service.resolveRepository(root, "repo"));

    expect(result.message).toBe("Pushed to origin/main.");
    const localHead = (await git(repo, ["rev-parse", "main"])).stdout.trim();
    const remoteHead = (await git(bare, ["rev-parse", "main"])).stdout.trim();
    expect(remoteHead).toBe(localHead);
  });

  it("pushes and sets upstream when origin exists but upstream is absent", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    await git(repo, ["switch", "-c", "feature"]);
    writeFileSync(path.join(repo, "feature.txt"), "feature\n");
    await git(repo, ["add", "feature.txt"]);
    await git(repo, ["commit", "-m", "feature"]);

    const service = new GitService({ workspaceRoot: root });
    const result = await service.push(await service.resolveRepository(root, "repo"));

    expect(result.message).toBe("Pushed to origin/feature.");
    expect(result.status?.upstream?.name).toBe("origin/feature");
  });

  it("switches branches and rejects unknown, leading-dash, and control-character names", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    await git(repo, ["branch", "feature"]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    const switched = await service.switchBranch(resolved, "feature");
    expect(switched.message).toBe("Switched to feature.");
    expect(switched.status?.branch?.name).toBe("feature");

    await expect(service.switchBranch(resolved, "nope")).rejects.toMatchObject({
      code: "branch_not_found",
    });
    await expect(service.switchBranch(resolved, "-x")).rejects.toMatchObject({
      code: "branch_not_found",
    });
    await expect(service.switchBranch(resolved, "bad\nbranch")).rejects.toMatchObject({
      code: "branch_not_found",
    });
  });

  it("commits tracked and untracked changes while leaving ignored files out", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore"]);

    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");
    writeFileSync(path.join(repo, "ignored.txt"), "ignored\n");

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    const result = await service.commitAll(resolved, "Commit all");

    expect(result.message).toBe(`Committed as ${result.commit?.shortHash}.`);
    expect(result.commit).toMatchObject({
      shortHash: expect.any(String),
      subject: "Commit all",
    });
    expect(result.status?.clean).toBe(true);

    const tracked = (await git(repo, ["ls-files"])).stdout;
    expect(tracked).toContain("untracked.txt");
    expect(tracked).not.toContain("ignored.txt");
    const ignored = (await git(repo, ["status", "--porcelain", "--ignored"])).stdout;
    expect(ignored).toContain("!! ignored.txt");
  });

  it("rejects empty, oversized, and control-character commit messages", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    writeFileSync(path.join(repo, "tracked.txt"), "two\n");

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    await expect(service.commitAll(resolved, "   ")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(service.commitAll(resolved, "bad\u0000message")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(service.commitAll(resolved, "x".repeat(4001))).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("reports nothing to commit on a clean worktree", async () => {
    const root = workspace();
    await setupOrigin(root);
    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    await expect(service.commitAll(resolved, "nothing")).rejects.toMatchObject({
      code: "nothing_to_commit",
    });
  });

  it("refuses to commit when the author identity is missing", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    const resolved = resolve(repo);
    const runner: GitRunner = (command) => {
      if (command.args.includes("GIT_AUTHOR_IDENT")) {
        return Promise.resolve({ stdout: "", stderr: "fatal: no identity", code: 128 });
      }
      return realRunner(command);
    };
    const service = new GitService({ workspaceRoot: root, runner });
    await expect(service.commitAll(resolved, "message")).rejects.toMatchObject({
      code: "git_failed",
      message: expect.stringContaining("Set user.name and user.email"),
    });
  });

  it("refuses to commit when commit signing is enabled", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    await git(repo, ["config", "commit.gpgsign", "true"]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    await expect(service.commitAll(resolved, "message")).rejects.toMatchObject({
      code: "git_failed",
      message: expect.stringContaining("Commit signing is enabled"),
    });
  });

  it("does not execute repository hooks", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    for (const name of ["pre-commit", "post-commit"]) {
      const hook = path.join(repo, ".git", "hooks", name);
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
    }

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    const result = await service.commitAll(resolved, "message");
    expect(result.commit).toMatchObject({ subject: "message" });
    const status = await service.status(resolved);
    expect(status.clean).toBe(true);
  });

  it("rejects a mutation when index.lock already exists", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    writeFileSync(path.join(repo, ".git", "index.lock"), "");

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    await expect(service.fetch(resolved)).rejects.toMatchObject({ code: "git_locked" });
  });

  it("serializes concurrent mutations per toplevel", async () => {
    const root = workspace();
    await setupOrigin(root);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    let started: () => void = () => undefined;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    const runner: GitRunner = async (command) => {
      if (command.args.includes("fetch")) {
        started();
        await gate;
      }
      return realRunner(command);
    };
    const service = new GitService({ workspaceRoot: root, runner });
    const resolved = await service.resolveRepository(root, "repo");

    const first = service.fetch(resolved);
    await fetchStarted;
    await expect(service.fetch(resolved)).rejects.toMatchObject({ code: "busy" });
    release();
    await expect(first).resolves.toMatchObject({ message: "Fetched all remotes." });
  });

  it("maps update divergence and dirty-worktree failures", async () => {
    const root = workspace();
    const { repo, bare } = await setupOrigin(root);
    const peer = await clonePeer(root, bare);
    writeFileSync(path.join(repo, "local.txt"), "local\n");
    await git(repo, ["add", "local.txt"]);
    await git(repo, ["commit", "-m", "local"]);
    writeFileSync(path.join(peer, "peer.txt"), "peer\n");
    await git(peer, ["add", "peer.txt"]);
    await git(peer, ["commit", "-m", "peer"]);
    await git(peer, ["push"]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    await service.fetch(resolved);
    await expect(service.update(resolved)).rejects.toMatchObject({ code: "diverged" });

    const dirtyRoot = workspace();
    const dirty = await setupOrigin(dirtyRoot);
    const dirtyPeer = await clonePeer(dirtyRoot, dirty.bare);
    writeFileSync(path.join(dirty.repo, "tracked.txt"), "local edit\n");
    writeFileSync(path.join(dirtyPeer, "tracked.txt"), "peer edit\n");
    await git(dirtyPeer, ["add", "tracked.txt"]);
    await git(dirtyPeer, ["commit", "-m", "peer edit"]);
    await git(dirtyPeer, ["push"]);
    const dirtyService = new GitService({ workspaceRoot: dirtyRoot });
    const dirtyResolved = await dirtyService.resolveRepository(dirtyRoot, "repo");
    await dirtyService.fetch(dirtyResolved);
    await expect(dirtyService.update(dirtyResolved)).rejects.toMatchObject({
      code: "worktree_dirty",
    });
  });

  it("maps a rejected push", async () => {
    const root = workspace();
    const { repo, bare } = await setupOrigin(root);
    const peer = await clonePeer(root, bare);
    writeFileSync(path.join(repo, "local.txt"), "local\n");
    await git(repo, ["add", "local.txt"]);
    await git(repo, ["commit", "-m", "local"]);
    writeFileSync(path.join(peer, "peer.txt"), "peer\n");
    await git(peer, ["add", "peer.txt"]);
    await git(peer, ["commit", "-m", "peer"]);
    await git(peer, ["push"]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    await expect(service.push(resolved)).rejects.toMatchObject({ code: "push_rejected" });
  });

  it("blocks commit, update, and switch during an in-progress operation and reports conflicts", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    await git(repo, ["switch", "-c", "other"]);
    writeFileSync(path.join(repo, "tracked.txt"), "other\n");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "other"]);
    await git(repo, ["switch", "main"]);
    writeFileSync(path.join(repo, "tracked.txt"), "main\n");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["commit", "-m", "main"]);
    await git(repo, ["merge", "other"]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    await expect(service.commitAll(resolved, "message")).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    await expect(service.update(resolved)).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    await expect(service.switchBranch(resolved, "feature")).rejects.toMatchObject({
      code: "operation_in_progress",
    });

    rmSync(path.join(repo, ".git", "MERGE_HEAD"));
    const status = await service.status(resolved);
    expect(status.conflicted).toBe(true);
    expect(status.operation).toBeNull();
    await expect(service.commitAll(resolved, "message")).rejects.toMatchObject({
      code: "conflicts",
    });
  });

  it("returns status null with a warning when the follow-up status read fails", async () => {
    const root = workspace();
    await setupOrigin(root);
    let sawFetch = false;
    const runner: GitRunner = async (command) => {
      if (command.args.includes("fetch")) {
        const result = await realRunner(command);
        sawFetch = true;
        return result;
      }
      if (sawFetch && command.args.includes("status")) {
        return { stdout: "", stderr: "status failed", code: 1 };
      }
      return realRunner(command);
    };
    const service = new GitService({ workspaceRoot: root, runner });
    const resolved = await service.resolveRepository(root, "repo");

    const result = await service.fetch(resolved);
    expect(result.status).toBeNull();
    expect(result.message).toBe("Fetched all remotes.");
    expect(result.warning).toBe("Action completed; refresh status.");
  });
});

describe("GitService failure mapping", () => {
  it("maps runner timeouts and output overflow", async () => {
    const root = workspace();
    const resolved = { root, appDir: root };

    const timeoutService = new GitService({
      workspaceRoot: root,
      runner: () =>
        Promise.reject(Object.assign(new Error("spawn timeout"), { code: "ETIMEDOUT" })),
    });
    await expect(timeoutService.status(resolved)).rejects.toMatchObject({ code: "timeout" });

    const killedService = new GitService({
      workspaceRoot: root,
      runner: () => Promise.reject(Object.assign(new Error("killed"), { killed: true })),
    });
    await expect(killedService.status(resolved)).rejects.toMatchObject({ code: "timeout" });

    const overflowService = new GitService({
      workspaceRoot: root,
      runner: () =>
        Promise.reject(
          Object.assign(new Error("overflow"), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }),
        ),
    });
    await expect(overflowService.status(resolved)).rejects.toMatchObject({
      code: "output_too_large",
    });
  });

  it("redacts credentials in git error output before truncating", async () => {
    const root = workspace();
    const runner: GitRunner = (command) => {
      if (command.args.includes("status")) {
        return Promise.resolve({
          stdout: "",
          stderr:
            "fatal: could not read Username for 'https://user:secret@example.com/repo.git': terminal prompts disabled",
          code: 128,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    };
    const service = new GitService({ workspaceRoot: root, runner });
    const error = await service
      .status({ root, appDir: root })
      .catch((caught: unknown) => caught as { code: string; message: string });

    expect(error.code).toBe("git_failed");
    expect(error.message).toContain("https://***@example.com/repo.git");
    expect(error.message).not.toContain("secret");
  });

  it("maps authentication failures during fetch to auth_failed", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    const runner: GitRunner = (command) => {
      if (command.args.includes("fetch")) {
        return Promise.resolve({
          stdout: "",
          stderr: "fatal: Authentication failed for 'https://user:secret@example.com/repo.git'",
          code: 128,
        });
      }
      return realRunner(command);
    };
    const service = new GitService({ workspaceRoot: root, runner });
    const resolved = await service.resolveRepository(root, "repo");
    const error = await service.fetch(resolved).catch(
      (caught: unknown) =>
        caught as {
          code: string;
          message: string;
        },
    );

    expect(error.code).toBe("auth_failed");
    expect(error.message).not.toContain("secret");
    expect(repo).toBeDefined();
  });
});

describe("GitService injected runner", () => {
  it("reports output too large from a resolved command result", async () => {
    const root = workspace();
    const resolved = { root, appDir: root };
    const runner: GitRunner = (command): Promise<GitCommandResult> => {
      if (command.args.includes("status")) {
        throw Object.assign(new Error("too big"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    };
    const service = new GitService({ workspaceRoot: root, runner });
    await expect(service.status(resolved)).rejects.toMatchObject({
      code: "output_too_large",
    });
  });
});

describe("GitService test connection", () => {
  it("defaults to origin, parses refs/HEAD, and redacts username userinfo", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    const temp = path.join(root, "tmp");
    mkdirSync(temp, { recursive: true });
    const runner: GitRunner = async (command) => {
      if (command.args.includes("remote") && command.args.includes("get-url")) {
        return { stdout: "https://user@example.com/acme/repo.git\n", stderr: "", code: 0 };
      }
      if (command.args.includes("ls-remote")) {
        return {
          stdout: "abc123\tHEAD\nabc123\trefs/heads/main\ndef456\trefs/heads/feature\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    };
    const service = new GitService({
      workspaceRoot: root,
      runner,
      env: { PATH: process.env.PATH, TMPDIR: temp },
    });

    const result = await service.testConnection(resolve(repo), { kind: "https" });
    expect(result).toEqual({
      ok: true,
      kind: "https",
      remote: "https://***@example.com/acme/repo.git",
      refs: 3,
      head: "abc123",
      warnings: [],
    });
  });

  it("maps missing origin, scheme mismatch, and auth failures", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    const missing: GitRunner = async () => ({ stdout: "", stderr: "no such remote", code: 2 });
    const missingService = new GitService({ workspaceRoot: root, runner: missing });
    await expect(
      missingService.testConnection(resolve(repo), { kind: "ssh" }),
    ).rejects.toMatchObject({ code: "missing_remote" });

    const mismatch = new GitService({
      workspaceRoot: root,
      runner: async () => ({ stdout: "", stderr: "", code: 0 }),
    });
    await expect(
      mismatch.testConnection(resolve(repo), {
        kind: "ssh",
        remote: "https://example.com/acme/repo.git",
      }),
    ).rejects.toMatchObject({ code: "credential_scheme_mismatch" });

    const auth: GitRunner = async (command) => {
      if (command.args.includes("ls-remote")) {
        return {
          stdout: "",
          stderr: "fatal: Authentication failed for 'https://example.com/acme/repo.git/'",
          code: 128,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const authService = new GitService({ workspaceRoot: root, runner: auth });
    await expect(
      authService.testConnection(resolve(repo), {
        kind: "https",
        remote: "https://example.com/acme/repo.git",
      }),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("adds the TOFU warning and host-key fingerprints from ssh-keygen", async () => {
    const root = workspace();
    const repo = await initRepo(root);
    const temp = path.join(root, "tmp");
    const bin = path.join(root, "bin");
    mkdirSync(temp, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "ssh-keygen"),
      "#!/bin/sh\nprintf '%s\\n' 'example.com ssh-ed25519 SHA256:fakefingerprint'\n",
      { mode: 0o755 },
    );
    chmodSync(path.join(bin, "ssh-keygen"), 0o755);
    writeFileSync(path.join(temp, "hanse-known_hosts"), "example.com ssh-ed25519 AAAA\n");
    const runner: GitRunner = async (command) => {
      if (command.args.includes("ls-remote")) {
        return { stdout: "abc123\tHEAD\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const service = new GitService({
      workspaceRoot: root,
      runner,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: temp },
    });

    const result = await service.testConnection(resolve(repo), {
      kind: "ssh",
      remote: "ssh://git@example.com/acme/repo.git",
    });
    expect(result.warnings[0]).toContain("No known_hosts was supplied");
    expect(result.warnings.join("\n")).toContain("SHA256:fakefingerprint");
  });
});
