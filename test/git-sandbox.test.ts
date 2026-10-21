import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_SANDBOX_APP_DIR_ENV,
  GIT_SANDBOX_OPERATION_ENV,
  gitOpError,
  runGitOperation,
  runGitTest,
} from "../src/git/op.js";
import {
  type GitCommand,
  GitError,
  type GitRunner,
  GitService,
  type GitStatus,
} from "../src/git/service.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: String(result.stdout), code: 0 };
  } catch (error) {
    const record = error as { stdout?: string | Buffer; code?: number | string };
    return {
      stdout: String(record.stdout ?? ""),
      code: typeof record.code === "number" ? record.code : 1,
    };
  }
}

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

async function initRepo(root: string): Promise<string> {
  const dir = path.join(root, "app");
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test Operator"]);
  await git(dir, ["config", "user.email", "operator@example.com"]);
  writeFileSync(path.join(dir, "tracked.txt"), "one\n");
  await git(dir, ["add", "tracked.txt"]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

async function setupOrigin(repo: string): Promise<string> {
  const bare = path.join(repo, ".git", "remotes", "remote.git");
  mkdirSync(bare, { recursive: true });
  await git(bare, ["init", "--bare", "-b", "main"]);
  await git(repo, ["remote", "add", "origin", pathToFileURL(bare).href]);
  await git(repo, ["push", "-u", "origin", "main"]);
  return bare;
}

function markerScript(directory: string, name: string): { script: string; marker: string } {
  const marker = path.join(directory, `${name}.marker`);
  const script = path.join(directory, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  return { script, marker };
}

function sandboxEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...extra,
  };
}

describe("sandboxed git helper hardening", () => {
  it("does not execute repository hooks, fsmonitor, uploadpack, or receivepack", async () => {
    const workspace = tempDir("hanse-git-sandbox-");
    const repo = await initRepo(workspace);
    const bare = await setupOrigin(repo);
    const commands: GitCommand[] = [];
    const runner: GitRunner = (command) => {
      commands.push(command);
      return realRunner(command);
    };

    const hook = markerScript(repo, "pre-commit-hook");
    writeFileSync(
      path.join(repo, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\ntouch '${hook.marker}'\n`,
      {
        mode: 0o755,
      },
    );
    chmodSync(path.join(repo, ".git", "hooks", "pre-commit"), 0o755);
    const fsmonitor = markerScript(repo, "fsmonitor");
    await git(repo, ["config", "core.fsmonitor", fsmonitor.script]);
    const uploadpack = markerScript(repo, "uploadpack");
    const receivepack = markerScript(repo, "receivepack");
    await git(repo, ["config", "remote.origin.uploadpack", uploadpack.script]);
    await git(repo, ["config", "remote.origin.receivepack", receivepack.script]);
    await git(repo, ["config", "core.sshCommand", markerScript(repo, "ssh").script]);
    writeFileSync(path.join(repo, "change.txt"), "change\n");

    const run = (request: Parameters<typeof runGitOperation>[0]["request"]) =>
      runGitOperation({
        request,
        workspaceRoot: workspace,
        appDir: repo,
        env: sandboxEnv(),
        runnerImpl: runner,
      });

    await run({ operation: "status" });
    await run({ operation: "fetch" });
    await run({ operation: "commit", message: "sandbox commit" });
    await run({ operation: "push" });
    expect(bare.length).toBeGreaterThan(0);

    expect(existsSync(hook.marker)).toBe(false);
    expect(existsSync(fsmonitor.marker)).toBe(false);
    expect(existsSync(uploadpack.marker)).toBe(false);
    expect(existsSync(receivepack.marker)).toBe(false);
    expect(existsSync(path.join(repo, "ssh.marker"))).toBe(false);

    const fixed = [
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
      expect(command.args.slice(0, fixed.length)).toEqual(fixed);
    }
    const fetch = commands.find((command) => command.args.includes("fetch"));
    expect(fetch?.args).toContain("--upload-pack=git-upload-pack");
    const push = commands.find((command) => command.args.includes("push"));
    expect(push?.args).toContain("--receive-pack=git-receive-pack");
  });

  it("rejects ext:: remotes before executing them", async () => {
    const workspace = tempDir("hanse-git-sandbox-ext-");
    const repo = await initRepo(workspace);
    const ext = markerScript(repo, "ext");
    await git(repo, ["remote", "add", "origin", `ext::sh -c 'touch ${ext.marker}'`]);

    await expect(
      runGitOperation({
        request: { operation: "fetch" },
        workspaceRoot: workspace,
        appDir: repo,
        env: sandboxEnv(),
      }),
    ).rejects.toMatchObject({ code: "invalid_remote" });
    expect(existsSync(ext.marker)).toBe(false);
  });

  it("keeps coordinator secrets out of the git child environment", async () => {
    const workspace = tempDir("hanse-git-sandbox-env-");
    const repo = await initRepo(workspace);
    const commands: GitCommand[] = [];
    const runner: GitRunner = (command) => {
      commands.push(command);
      return realRunner(command);
    };

    await runGitOperation({
      request: { operation: "status" },
      workspaceRoot: workspace,
      appDir: repo,
      env: sandboxEnv({
        HANSE_OPERATOR_TOKEN: "operator-secret",
        HANSE_RUNTIME_TOKEN: "runtime-secret",
        OPENCODE_SERVER_PASSWORD: "app-secret",
        HANSE_GIT_TOKEN: "git-token",
        HANSE_GIT_AUTHOR_NAME: "Git Author",
        HANSE_GIT_AUTHOR_EMAIL: "author@example.com",
      }),
      runnerImpl: runner,
    });

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.env.HANSE_OPERATOR_TOKEN).toBeUndefined();
      expect(command.env.HANSE_RUNTIME_TOKEN).toBeUndefined();
      expect(command.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
      expect(command.env.HANSE_GIT_TOKEN).toBeUndefined();
      expect(command.env.GIT_AUTHOR_NAME).toBeUndefined();
      expect(command.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
      expect(command.env.GIT_TERMINAL_PROMPT).toBe("0");
    }
  });

  it("runs the Test connection helper with the hardened git pipeline", async () => {
    const workspace = tempDir("hanse-git-sandbox-test-");
    const repo = await initRepo(workspace);
    const temp = tempDir("hanse-git-sandbox-test-tmp-");
    const runner: GitRunner = async (command) => {
      if (command.args.includes("--is-inside-work-tree")) {
        return { stdout: "true\n", stderr: "", code: 0 };
      }
      if (command.args.includes("--show-toplevel")) {
        return { stdout: `${repo}\n`, stderr: "", code: 0 };
      }
      if (command.args.includes("ls-remote")) {
        return {
          stdout: "abc123\tHEAD\nabc123\trefs/heads/main\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 1 };
    };

    const result = await runGitTest({
      workspaceRoot: workspace,
      appDir: repo,
      env: { PATH: process.env.PATH, TMPDIR: temp },
      kind: "https",
      remote: "https://example.com/acme/repo.git",
      runnerImpl: runner,
    });

    expect(result).toMatchObject({
      ok: true,
      kind: "https",
      remote: "https://example.com/acme/repo.git",
      refs: 2,
      head: "abc123",
      warnings: [],
    });
  });

  it("emits a bounded machine-readable error envelope", () => {
    expect(
      gitOpError(new GitError("auth_failed", "no credentials", { root: "/data/workspace" })),
    ).toEqual({
      error: "no credentials",
      code: "auth_failed",
      root: "/data/workspace",
    });
    expect(gitOpError(new Error("boom"))).toEqual({ error: "boom", code: "git_failed" });
  });

  it("exposes the fixed sandbox environment names", () => {
    expect(GIT_SANDBOX_APP_DIR_ENV).toBe("HANSE_GIT_APP_DIR");
    expect(GIT_SANDBOX_OPERATION_ENV).toBe("HANSE_GIT_OP");
  });
});

function fakeStatus(root: string): GitStatus {
  return {
    state: "ok",
    root,
    branch: { name: "main", detached: false, head: "abc" },
    upstream: null,
    clean: true,
    files: [],
    branches: ["main"],
    remotes: [],
    lastCommit: null,
    operation: null,
    conflicted: false,
    identity: { configured: true },
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function runnerFetch(calls: RecordedCall[], statusRoot: string): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });
    const body = JSON.parse(String(init?.body ?? "{}")) as { operation: string };
    if (body.operation === "status") {
      return new Response(JSON.stringify({ status: fakeStatus(statusRoot) }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        result: {
          status: fakeStatus(statusRoot),
          message: `${body.operation} ok`,
          ...(body.operation === "commit"
            ? { commit: { hash: "abcdef1", shortHash: "abcdef1", subject: "test" } }
            : {}),
        },
      }),
      { status: 200 },
    );
  };
}

describe("coordinator GitService runner delegation", () => {
  it("delegates every operation to the runner with the runtime token", async () => {
    const workspace = tempDir("hanse-git-delegation-");
    const appDir = path.join(workspace, "project", "app");
    mkdirSync(appDir, { recursive: true });
    const calls: RecordedCall[] = [];
    const git = new GitService({
      workspaceRoot: workspace,
      remote: {
        baseUrl: "http://runner:8790/",
        token: "runtime-token",
        fetchImpl: runnerFetch(calls, appDir),
      },
    });

    const resolved = await git.resolveRepository(workspace, appDir, "project:app");
    expect(resolved).toEqual({ root: appDir, appDir, appId: "project:app" });

    const status = await git.status(resolved);
    expect(status).toMatchObject({ state: "ok", root: appDir });
    expect(await git.fetch(resolved)).toMatchObject({ message: "fetch ok" });
    expect(await git.update(resolved)).toMatchObject({ message: "update ok" });
    expect(await git.switchBranch(resolved, "feature")).toMatchObject({
      message: "switch ok",
    });
    expect(await git.commitAll(resolved, "  test commit  ")).toMatchObject({
      message: "commit ok",
      commit: { shortHash: "abcdef1" },
    });
    expect(await git.push(resolved)).toMatchObject({ message: "push ok" });

    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(call.url).toBe("http://runner:8790/v1/apps/project%3Aapp/git");
      const headers = call.init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer runtime-token");
      expect(headers["content-type"]).toBe("application/json");
    }
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ operation: "status" });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      operation: "switch",
      branch: "feature",
    });
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({
      operation: "commit",
      message: "test commit",
    });
  });

  it("delegates Test connection to the runner test endpoint", async () => {
    const workspace = tempDir("hanse-git-delegation-test-");
    const appDir = path.join(workspace, "project", "app");
    mkdirSync(appDir, { recursive: true });
    const calls: RecordedCall[] = [];
    const git = new GitService({
      workspaceRoot: workspace,
      remote: {
        baseUrl: "http://runner:8790",
        token: "runtime-token",
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : String(input);
          calls.push({ url, init: init ?? {} });
          return new Response(
            JSON.stringify({
              test: {
                ok: true,
                kind: "ssh",
                remote: "ssh://git@example.com/acme/repo.git",
                refs: 2,
                warnings: [],
              },
            }),
            { status: 200 },
          );
        },
      },
    });
    const resolved = await git.resolveRepository(workspace, appDir, "project:app");
    const result = await git.testConnection(resolved, {
      kind: "ssh",
      remote: "ssh://git@example.com/acme/repo.git",
    });

    expect(result).toMatchObject({ ok: true, kind: "ssh", refs: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://runner:8790/v1/apps/project%3Aapp/git/test");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      kind: "ssh",
      remote: "ssh://git@example.com/acme/repo.git",
    });
  });

  it("maps runner status errors and transport failures to GitError codes", async () => {
    const workspace = tempDir("hanse-git-delegation-errors-");
    const appDir = path.join(workspace, "project", "app");
    mkdirSync(appDir, { recursive: true });

    const notGit = new GitService({
      workspaceRoot: workspace,
      remote: {
        baseUrl: "http://runner:8790",
        token: "runtime-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "not a git work tree", code: "not_git" }), {
            status: 409,
          }),
      },
    });
    const notGitStatus = await notGit.statusFor(workspace, appDir, "project:app");
    expect(notGitStatus).toMatchObject({ state: "not_git", message: "not a git work tree" });

    const auth = new GitService({
      workspaceRoot: workspace,
      remote: {
        baseUrl: "http://runner:8790",
        token: "runtime-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "bad credentials", code: "auth_failed" }), {
            status: 502,
          }),
      },
    });
    await expect(
      auth.fetch(await auth.resolveRepository(workspace, appDir, "project:app")),
    ).rejects.toMatchObject({ code: "auth_failed", message: "bad credentials" });

    const transport = new GitService({
      workspaceRoot: workspace,
      remote: {
        baseUrl: "http://runner:8790",
        token: "runtime-token",
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      },
    });
    await expect(
      transport.status(await transport.resolveRepository(workspace, appDir, "project:app")),
    ).rejects.toMatchObject({
      code: "git_failed",
      message: expect.stringContaining("fetch failed"),
    });
  });

  it("requires an app id for runner-backed repositories", async () => {
    const workspace = tempDir("hanse-git-delegation-id-");
    const appDir = path.join(workspace, "project", "app");
    mkdirSync(appDir, { recursive: true });
    const git = new GitService({
      workspaceRoot: workspace,
      remote: {
        baseUrl: "http://runner:8790",
        token: "runtime-token",
        fetchImpl: async () => new Response("{}", { status: 200 }),
      },
    });

    await expect(git.resolveRepository(workspace, appDir)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
