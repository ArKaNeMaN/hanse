import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GitCommand,
  type GitRunner,
  GitService,
  validateRemoteUrl,
} from "../src/git/service.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function workspace(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "hanse-git-hardening-")));
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
  const dir = path.join(root, "repo");
  mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test Operator"]);
  await git(dir, ["config", "user.email", "operator@example.com"]);
  return dir;
}

async function setupOrigin(root: string): Promise<{ repo: string; bare: string }> {
  const repo = await initRepo(root);
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);

  const bare = path.join(repo, ".git", "remotes", "remote.git");
  mkdirSync(bare, { recursive: true });
  await git(bare, ["init", "--bare", "-b", "main"]);
  await git(repo, ["remote", "add", "origin", pathToFileURL(bare).href]);
  await git(repo, ["push", "-u", "origin", "main"]);
  return { repo, bare };
}

function markerScript(
  directory: string,
  name: string,
  exitCode = 0,
): { script: string; marker: string } {
  const marker = path.join(directory, `${name}.marker`);
  const script = path.join(directory, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit ${exitCode}\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  return { script, marker };
}

function fixedConfigArgs(command: GitCommand): string[] {
  const args: string[] = [];
  for (let index = 0; index + 1 < command.args.length; index += 2) {
    if (command.args[index] !== "-c") {
      break;
    }
    args.push("-c", command.args[index + 1] ?? "");
  }
  return args;
}

function resolve(repo: string): { root: string; appDir: string } {
  return { root: realpathSync(repo), appDir: realpathSync(repo) };
}

describe("GitService child environment", () => {
  it("uses a minimal allowlist and the fixed config prefix", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    const commands: GitCommand[] = [];
    const runner: GitRunner = (command) => {
      commands.push(command);
      return realRunner(command);
    };
    const service = new GitService({
      workspaceRoot: root,
      runner,
      env: {
        PATH: process.env.PATH,
        HANSE_OPERATOR_TOKEN: "operator-secret",
        HANSE_RUNTIME_TOKEN: "runtime-secret",
        HANSE_DB: "/data/state/coordinator.db",
        HANSE_STATE_HOME: "/data/state",
        OPENCODE_AUTH_CONTENT: "auth-content",
        HANSE_AUTH_FILE: "/data/state/auth.json",
        OPENCODE_SERVER_PASSWORD: "server-password",
        HANSE_AGENT_TOKEN_FILE: "/data/agents/token",
        GIT_SSH_COMMAND: "evil-ssh",
        GIT_ASKPASS: "evil-askpass",
        GIT_CONFIG_GLOBAL: "/home/operator/.gitconfig",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        HTTPS_PROXY: "http://proxy.example:3128",
        HANSE_GIT_AUTHOR_NAME: "Env Author",
        HANSE_GIT_AUTHOR_EMAIL: "env@example.com",
        HANSE_GIT_COMMITTER_NAME: "Env Committer",
        HANSE_GIT_COMMITTER_EMAIL: "committer@example.com",
        HANSE_GIT_SSL_CAINFO: "/run/hanse/git/ca.pem",
      },
    });

    await service.status(await service.resolveRepository(root, "repo"));
    const command = commands.at(-1);
    if (command === undefined) {
      throw new Error("no git command was captured");
    }

    for (const forbidden of [
      "HANSE_OPERATOR_TOKEN",
      "HANSE_RUNTIME_TOKEN",
      "HANSE_DB",
      "HANSE_STATE_HOME",
      "OPENCODE_AUTH_CONTENT",
      "HANSE_AUTH_FILE",
      "OPENCODE_SERVER_PASSWORD",
      "HANSE_AGENT_TOKEN_FILE",
      "SSH_AUTH_SOCK",
      "GIT_CONFIG_COUNT",
      "GIT_DIR",
      "GIT_WORK_TREE",
    ]) {
      expect(command.env[forbidden]).toBeUndefined();
    }

    expect(command.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(command.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(command.env.GIT_PAGER).toBe("cat");
    expect(command.env.GIT_SSH_COMMAND).toBe("ssh");
    expect(command.env.GIT_ASKPASS).toBe("");
    expect(command.env.HTTPS_PROXY).toBe("http://proxy.example:3128");
    expect(command.env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(command.env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(command.env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(command.env.GIT_COMMITTER_EMAIL).toBeUndefined();
    expect(command.env.GIT_SSL_CAINFO).toBeUndefined();
    expect(command.env.HANSE_GIT_AUTHOR_NAME).toBeUndefined();

    const home = command.env.HOME ?? "";
    expect(path.isAbsolute(home)).toBe(true);
    expect(home).not.toBe(process.env.HOME);
    expect(statSync(home).mode & 0o777).toBe(0o700);

    expect(command.args.slice(0, 16)).toEqual([
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
    ]);
    expect(command.args).toContain("core.askpass=");
    expect(repo).toBeDefined();
  });

  it("uses the managed credential directory when HANSE_CREDENTIALS_DIR is set", async () => {
    const root = workspace();
    await setupOrigin(root);
    const credentials = path.join(root, "credentials");
    mkdirSync(credentials, { recursive: true });
    for (const file of ["config", "ssh", "askpass"]) {
      writeFileSync(path.join(credentials, file), "x");
    }
    writeFileSync(path.join(credentials, "config"), "[core]\n");
    const commands: GitCommand[] = [];
    const runner: GitRunner = (command) => {
      commands.push(command);
      return realRunner(command);
    };
    const service = new GitService({
      workspaceRoot: root,
      runner,
      env: {
        PATH: process.env.PATH,
        HANSE_CREDENTIALS_DIR: credentials,
        HANSE_CREDENTIALS_READONLY: "1",
      },
    });

    await service.status(await service.resolveRepository(root, "repo"));
    const command = commands.at(-1);
    if (command === undefined) {
      throw new Error("no git command was captured");
    }
    expect(command.env.GIT_CONFIG_GLOBAL).toBe(path.join(credentials, "config"));
    expect(command.env.GIT_SSH_COMMAND).toBe(`'${path.join(credentials, "ssh")}'`);
    expect(command.env.GIT_ASKPASS).toBe(path.join(credentials, "askpass"));
    expect(command.env.GIT_ASKPASS_REQUIRE).toBe("force");
    expect(command.env.HANSE_CREDENTIALS_DIR).toBe(credentials);
    expect(command.env.HANSE_CREDENTIALS_READONLY).toBe("1");
    expect(command.args).toContain(`core.sshCommand='${path.join(credentials, "ssh")}'`);
    expect(command.args).toContain(`core.askpass=${path.join(credentials, "askpass")}`);
  });
});

describe("GitService repository-controlled execution", () => {
  it("does not execute pre-commit or post-commit hooks", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    const { script, marker } = markerScript(root, "hook", 1);
    for (const name of ["pre-commit", "post-commit"]) {
      const hook = path.join(repo, ".git", "hooks", name);
      writeFileSync(hook, readFileSync(script));
      chmodSync(hook, 0o755);
    }
    writeFileSync(path.join(repo, "tracked.txt"), "two\n");

    const service = new GitService({ workspaceRoot: root });
    const result = await service.commitAll(await service.resolveRepository(root, "repo"), "commit");

    expect(result.commit).toMatchObject({ subject: "commit" });
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute a repository core.fsmonitor command", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    const { script, marker } = markerScript(root, "fsmonitor");
    await git(repo, ["config", "core.fsmonitor", script]);

    const service = new GitService({ workspaceRoot: root });
    const status = await service.status(await service.resolveRepository(root, "repo"));

    expect(status.state).toBe("ok");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not execute repository uploadpack or receivepack commands", async () => {
    const root = workspace();
    const { repo, bare } = await setupOrigin(root);
    const upload = markerScript(root, "uploadpack");
    const receive = markerScript(root, "receivepack");
    await git(repo, ["config", "remote.origin.uploadpack", upload.script]);
    await git(repo, ["config", "remote.origin.receivepack", receive.script]);

    const service = new GitService({ workspaceRoot: root });
    const resolved = await service.resolveRepository(root, "repo");
    const fetched = await service.fetch(resolved);
    expect(fetched.message).toBe("Fetched all remotes.");

    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    const committed = await service.commitAll(resolved, "local change");
    const pushed = await service.push(resolved);
    expect(pushed.message).toBe("Pushed to origin/main.");
    expect(committed.commit).toBeDefined();

    expect(existsSync(upload.marker)).toBe(false);
    expect(existsSync(receive.marker)).toBe(false);
    const remoteHead = (await git(bare, ["rev-parse", "main"])).stdout.trim();
    expect(remoteHead).toBe(committed.commit?.hash);
  });

  it("ignores a repository core.sshCommand and uses the controlled command", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    const repository = markerScript(root, "repository-ssh");
    const controlled = markerScript(root, "controlled-ssh", 1);
    await git(repo, ["config", "core.sshCommand", repository.script]);
    await git(repo, ["remote", "add", "sshremote", "ssh://git@example.invalid/repo.git"]);

    const credentials = path.join(root, "credentials");
    mkdirSync(credentials, { recursive: true });
    writeFileSync(path.join(credentials, "ssh"), readFileSync(controlled.script), {
      mode: 0o755,
    });
    writeFileSync(path.join(credentials, "askpass"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(path.join(credentials, "config"), "[core]\n");
    const service = new GitService({
      workspaceRoot: root,
      env: { PATH: process.env.PATH, HANSE_CREDENTIALS_DIR: credentials },
    });
    const resolved = await service.resolveRepository(root, "repo");
    await expect(service.fetch(resolved)).rejects.toMatchObject({
      code: expect.stringMatching(/auth_failed|git_failed/),
    });

    expect(existsSync(controlled.marker)).toBe(true);
    expect(existsSync(repository.marker)).toBe(false);
  });

  it("disables repository and ambient credential helpers", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    const { script, marker } = markerScript(root, "credential");
    await git(repo, ["config", "credential.helper", script]);

    const commands: GitCommand[] = [];
    const runner: GitRunner = (command) => {
      commands.push(command);
      return realRunner(command);
    };
    const service = new GitService({
      workspaceRoot: root,
      runner,
      env: { PATH: process.env.PATH },
    });
    await service.status(await service.resolveRepository(root, "repo"));
    const command = commands.at(-1);
    if (command === undefined) {
      throw new Error("no git command was captured");
    }

    const input = "protocol=https\nhost=example.com\n\n";
    spawnSync("git", ["credential", "fill"], {
      cwd: repo,
      env: { ...command.env },
      input,
      encoding: "utf8",
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });

    const result = spawnSync("git", [...fixedConfigArgs(command), "credential", "fill"], {
      cwd: repo,
      env: { ...command.env },
      input,
      encoding: "utf8",
    });
    expect(existsSync(marker)).toBe(false);
    expect(result.status).not.toBe(0);
  });
});

describe("validateRemoteUrl", () => {
  it("accepts https, ssh, scp-like, and file remotes inside the app", async () => {
    const app = workspace();
    const inside = path.join(app, "remote.git");
    mkdirSync(inside);
    for (const url of [
      "https://github.com/example/repo.git",
      "https://user:secret@example.com/repo.git",
      "ssh://git@github.com/example/repo.git",
      "git@github.com:example/repo.git",
      pathToFileURL(inside).href,
    ]) {
      await expect(validateRemoteUrl(url, app)).resolves.toBeUndefined();
    }
  });

  it("rejects ext::, git://, option-looking, control-character, and outside-file remotes", async () => {
    const app = workspace();
    const outside = workspace();
    const outsideRemote = path.join(outside, "remote.git");
    mkdirSync(outsideRemote);
    for (const url of [
      "ext::sh -c 'touch /tmp/pwned'",
      "git://github.com/example/repo.git",
      "--upload-pack=/bin/sh",
      " -oProxyCommand=sh",
      "ssh://-oProxyCommand=sh/repo.git",
      "https://example.com/repo\n.git",
      "https://example.com/repo git",
      "http://example.com/repo.git",
      "example.com:repo.git",
      "git@-oProxyCommand=sh:repo.git",
      `file://host${outsideRemote}`,
      pathToFileURL(outsideRemote).href,
    ]) {
      await expect(validateRemoteUrl(url, app)).rejects.toMatchObject({ code: "invalid_remote" });
    }
  });

  it("rejects unsafe remotes in status before any network operation", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    await git(repo, ["config", "remote.evil.url", "ext::sh -c 'touch /tmp/pwned'"]);

    const service = new GitService({ workspaceRoot: root });
    await expect(
      service.status(await service.resolveRepository(root, "repo")),
    ).rejects.toMatchObject({ code: "invalid_remote" });
  });

  it("rejects file remotes outside the application in status", async () => {
    const root = workspace();
    const { repo } = await setupOrigin(root);
    const outside = workspace();
    const outsideRemote = path.join(outside, "remote.git");
    mkdirSync(outsideRemote);
    await git(repo, ["config", "remote.outside.url", pathToFileURL(outsideRemote).href]);

    const service = new GitService({ workspaceRoot: root });
    await expect(
      service.status(await service.resolveRepository(root, "repo")),
    ).rejects.toMatchObject({ code: "invalid_remote" });
  });
});

describe("GitService identity", () => {
  it("uses repository-local identity and ignores legacy identity env", async () => {
    const root = workspace();
    const repo = path.join(root, "repo");
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Repo Author"]);
    await git(repo, ["config", "user.email", "repo@example.com"]);
    writeFileSync(path.join(repo, "a.txt"), "one\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-m", "seed"]);
    writeFileSync(path.join(repo, "a.txt"), "two\n");

    const service = new GitService({
      workspaceRoot: root,
      env: {
        PATH: process.env.PATH,
        HANSE_GIT_AUTHOR_NAME: "Env Author",
        HANSE_GIT_AUTHOR_EMAIL: "author@example.com",
        HANSE_GIT_COMMITTER_NAME: "Env Committer",
        HANSE_GIT_COMMITTER_EMAIL: "committer@example.com",
      },
    });
    const result = await service.commitAll(resolve(repo), "repo identity");
    expect(result.commit).toMatchObject({ subject: "repo identity" });

    const log = await git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
    expect(log.stdout.trim()).toBe("Repo Author <repo@example.com>|Repo Author <repo@example.com>");
  });
});
