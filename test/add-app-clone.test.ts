import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CloneExec, cloneRemote, ProvisioningError } from "../src/coordinator/provision.js";
import type { GitCredentialAuth } from "../src/git/materialize.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SSH_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-body\n-----END OPENSSH PRIVATE KEY-----\n";
const SSH: GitCredentialAuth = { ssh: { privateKey: SSH_KEY } };
const HTTPS: GitCredentialAuth = {
  https: { hosts: ["github.com"], username: "x-access-token", token: "token-body" },
};
const BOTH: GitCredentialAuth = { ...SSH, ...HTTPS };

interface Captured {
  args: readonly string[];
  options: { env?: NodeJS.ProcessEnv };
}

function fixture(): { tempRoot: string; workspace: string; target: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-add-app-clone-"));
  dirs.push(root);
  const tempRoot = path.join(root, "tmp");
  const workspace = path.join(root, "workspace");
  mkdirSync(tempRoot);
  mkdirSync(workspace);
  return { tempRoot, workspace, target: path.join(root, "target") };
}

function cloneDirs(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith("hanse-git-clone-"));
}

function expectCloneFailure(run: () => unknown, message: string): ProvisioningError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    const failure = error as ProvisioningError;
    expect(failure.code).toBe("clone_failed");
    expect(failure.message).toContain(message);
    return failure;
  }
  throw new Error("expected a clone failure");
}

function mode(target: string): number {
  return statSync(target).mode & 0o777;
}

describe("add-app clone credentials", () => {
  it("materializes an SSH credential into a minimal child environment and cleans up", () => {
    const f = fixture();
    const captured: Captured[] = [];
    const saved = {
      GIT_TRACE: process.env.GIT_TRACE,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    };
    process.env.GIT_TRACE = "1";
    process.env.GIT_CONFIG_COUNT = "1";
    try {
      cloneRemote("git@github.com:owner/repo.git", f.target, BOTH, {
        tempRoot: f.tempRoot,
        workspaceRoot: f.workspace,
        exec: (args, options) => {
          captured.push({ args, options });
          const env = options.env;
          expect(env).toBeDefined();
          expect(env?.PATH).toBe(process.env.PATH);
          expect(env?.GIT_TRACE).toBeUndefined();
          expect(env?.GIT_CONFIG_COUNT).toBeUndefined();
          expect(env?.HANSE_CREDENTIALS_READONLY).toBe("0");
          const home = env?.HOME ?? "";
          const credentialsDir = path.dirname(home);
          expect(path.basename(home)).toBe("home");
          expect(mode(credentialsDir)).toBe(0o700);
          expect(mode(path.join(credentialsDir, "id"))).toBe(0o600);
          expect(readFileSync(path.join(credentialsDir, "id"), "utf8")).toBe(SSH_KEY);
          expect(existsSync(path.join(credentialsDir, "token"))).toBe(false);
          expect(existsSync(path.join(credentialsDir, "https_hosts"))).toBe(false);
          expect(lstatSync(path.join(credentialsDir, "config")).isFile()).toBe(true);
          expect(lstatSync(path.join(credentialsDir, "ssh")).isFile()).toBe(true);
          expect(lstatSync(path.join(credentialsDir, "askpass")).isFile()).toBe(true);
          expect(env?.GIT_SSH_COMMAND).toContain(path.join(credentialsDir, "ssh"));
        },
      });
    } finally {
      process.env.GIT_TRACE = saved.GIT_TRACE;
      process.env.GIT_CONFIG_COUNT = saved.GIT_CONFIG_COUNT;
      if (saved.GIT_TRACE === undefined) {
        delete process.env.GIT_TRACE;
      }
      if (saved.GIT_CONFIG_COUNT === undefined) {
        delete process.env.GIT_CONFIG_COUNT;
      }
    }
    expect(captured).toHaveLength(1);
    const args = captured[0]?.args ?? [];
    expect(args).toContain("core.hooksPath=/dev/null");
    expect(args).toContain("credential.helper=");
    expect(args).toContain("protocol.ext.allow=never");
    expect(args.slice(-6)).toEqual([
      "clone",
      "--depth",
      "1",
      "--",
      "git@github.com:owner/repo.git",
      f.target,
    ]);
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("materializes an HTTPS credential without putting the token in argv or env", () => {
    const f = fixture();
    const captured: Captured[] = [];
    cloneRemote("https://github.com/owner/repo.git", f.target, BOTH, {
      tempRoot: f.tempRoot,
      workspaceRoot: f.workspace,
      exec: (args, options) => {
        captured.push({ args, options });
        const env = options.env ?? {};
        const credentialsDir = String(env.HANSE_CREDENTIALS_DIR);
        expect(readFileSync(path.join(credentialsDir, "token"), "utf8")).toBe("token-body");
        expect(readFileSync(path.join(credentialsDir, "username"), "utf8")).toBe("x-access-token");
        expect(readFileSync(path.join(credentialsDir, "https_hosts"), "utf8")).toBe("github.com\n");
        expect(existsSync(path.join(credentialsDir, "id"))).toBe(false);
        expect(env.GIT_ASKPASS).toBe(path.join(credentialsDir, "askpass"));
        expect(args.join(" ")).not.toContain("token-body");
        expect(Object.values(env)).not.toContain("token-body");
      },
    });
    expect(captured).toHaveLength(1);
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("keeps the plain argv and uses an allowlisted empty env for http(s)/git://", () => {
    const f = fixture();
    const savedTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = "1";
    try {
      for (const remote of ["https://example.invalid/repo.git", "git://example.invalid/repo.git"]) {
        const captured: Captured[] = [];
        cloneRemote(
          remote,
          f.target,
          {},
          {
            tempRoot: f.tempRoot,
            workspaceRoot: f.workspace,
            exec: (args, options) => {
              captured.push({ args, options });
              const env = options.env ?? {};
              expect(env.PATH).toBe(process.env.PATH);
              expect(env.GIT_TRACE).toBeUndefined();
              expect(env.GIT_ASKPASS).toBeUndefined();
              expect(env.HANSE_CREDENTIALS_READONLY).toBe("0");
              const credentialsDir = path.dirname(env.HOME ?? "");
              expect(path.basename(env.HOME ?? "")).toBe("home");
              expect(existsSync(path.join(credentialsDir, "id"))).toBe(false);
              expect(existsSync(path.join(credentialsDir, "token"))).toBe(false);
            },
          },
        );
        expect(captured).toHaveLength(1);
        expect(captured[0]?.args).toEqual(["clone", "--depth", "1", "--", remote, f.target]);
        expect(cloneDirs(f.tempRoot)).toEqual([]);
      }
    } finally {
      if (savedTrace === undefined) {
        delete process.env.GIT_TRACE;
      } else {
        process.env.GIT_TRACE = savedTrace;
      }
    }
  });

  it("sanitizes failures on the plain-clone branch too", () => {
    const f = fixture();
    const stderr = `fatal: could not read from https://secret-user:secret-token@example.invalid/x\n\u0007\n${"y".repeat(400)}`;
    const failure = expectCloneFailure(
      () =>
        cloneRemote(
          "https://example.invalid/repo.git",
          f.target,
          {},
          {
            tempRoot: f.tempRoot,
            workspaceRoot: f.workspace,
            exec: () => {
              const error = new Error("Command failed: git clone");
              Object.assign(error, { stderr });
              throw error;
            },
          },
        ),
      "failed to clone the application",
    );
    expect(failure.message).not.toContain("secret-token");
    expect(failure.message).not.toContain("secret-user");
    expect(failure.message).toContain("***");
    expect(failure.message).not.toContain("\n");
    expect(failure.message.length).toBeLessThanOrEqual(
      "failed to clone the application: ".length + 300,
    );
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("fails clearly for SSH without an SSH credential and never invokes git", () => {
    const f = fixture();
    let called = false;
    const failure = expectCloneFailure(
      () =>
        cloneRemote(
          "git@github.com:owner/repo.git",
          f.target,
          {},
          {
            tempRoot: f.tempRoot,
            exec: () => {
              called = true;
            },
          },
        ),
      "no SSH git credential is configured for this project",
    );
    expect(failure.status).toBe(502);
    expect(called).toBe(false);
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("surfaces sanitized exec stderr and removes the credential directory", () => {
    const f = fixture();
    const privateKeyLine = "SUPER-SECRET-KEY-BODY";
    const auth: GitCredentialAuth = {
      ssh: { privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${privateKeyLine}\n` },
      https: { hosts: ["github.com"], username: "secret-user", token: "secret-token" },
    };
    const stderr = `fatal: could not read from https://secret-user:secret-token@github.com/x\n${privateKeyLine}\u0007\nline two\t${"x".repeat(400)}`;
    const failure = expectCloneFailure(
      () =>
        cloneRemote("ssh://git@github.com/owner/repo.git", f.target, auth, {
          tempRoot: f.tempRoot,
          workspaceRoot: f.workspace,
          exec: () => {
            const error = new Error("Command failed: git clone");
            Object.assign(error, { stderr });
            throw error;
          },
        }),
      "failed to clone the application",
    );
    expect(failure.status).toBe(502);
    expect(failure.message).not.toContain("secret-token");
    expect(failure.message).not.toContain("secret-user");
    expect(failure.message).not.toContain(privateKeyLine);
    expect(failure.message).toContain("***");
    const hasControlCharacter = [...failure.message].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
    expect(hasControlCharacter).toBe(false);
    expect(failure.message).not.toContain("\n");
    expect(failure.message.length).toBeLessThanOrEqual(
      "failed to clone the application: ".length + 300,
    );
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("falls back to a sanitized error message when stderr is empty (ENOENT)", () => {
    const f = fixture();
    const failure = expectCloneFailure(
      () =>
        cloneRemote("https://example.invalid/repo.git", f.target, HTTPS, {
          tempRoot: f.tempRoot,
          exec: () => {
            throw new Error("spawn git ENOENT");
          },
        }),
      "spawn git ENOENT",
    );
    expect(failure.message).not.toContain("undefined");
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("removes the credential directory when materialization fails", () => {
    const f = fixture();
    const broken = {
      https: { hosts: ["github.com"], username: "user", token: 42 },
    } as unknown as GitCredentialAuth;
    expectCloneFailure(
      () =>
        cloneRemote("https://github.com/owner/repo.git", f.target, broken, {
          tempRoot: f.tempRoot,
          workspaceRoot: f.workspace,
          exec: () => {
            throw new Error("should not run");
          },
        }),
      "failed to clone the application",
    );
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("gives nested clones distinct directories and cleans both", () => {
    const f = fixture();
    const seen: string[] = [];
    const exec: CloneExec = (_args, options) => {
      const credentialsDir = String(options.env?.HANSE_CREDENTIALS_DIR);
      seen.push(credentialsDir);
      if (seen.length === 1) {
        cloneRemote("git@github.com:owner/other.git", path.join(f.target, "other"), SSH, {
          tempRoot: f.tempRoot,
          workspaceRoot: f.workspace,
          exec: (innerArgs, innerOptions) => {
            seen.push(String(innerOptions.env?.HANSE_CREDENTIALS_DIR));
            expect(innerArgs).toContain("clone");
          },
        });
      }
    };
    cloneRemote("git@github.com:owner/repo.git", f.target, SSH, {
      tempRoot: f.tempRoot,
      workspaceRoot: f.workspace,
      exec,
    });
    expect(new Set(seen).size).toBe(2);
    expect(cloneDirs(f.tempRoot)).toEqual([]);
  });

  it("refuses a temporary root inside the workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hanse-add-app-clone-"));
    dirs.push(root);
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    const failure = expectCloneFailure(
      () =>
        cloneRemote("git@github.com:owner/repo.git", path.join(root, "target"), SSH, {
          tempRoot: workspace,
          workspaceRoot: workspace,
          exec: () => {},
        }),
      "inside the workspace",
    );
    expect(failure.status).toBe(500);
    expect(readdirSync(workspace)).toEqual([]);
  });
});
