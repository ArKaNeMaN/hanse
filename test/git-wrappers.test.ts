import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGitCredentialFiles } from "../src/git/materialize.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  base: string;
  directory: string;
  bin: string;
  argsFile: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-wrapper-"));
  dirs.push(base);
  const directory = path.join(base, "git");
  const bin = path.join(base, "bin");
  const argsFile = path.join(base, "ssh-args");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "ssh"),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$HANS_TEST_SSH_ARGS"\nexit 0\n',
    { mode: 0o700 },
  );
  return { base, directory, bin, argsFile };
}

function write(
  f: Fixture,
  options: {
    ssh?: { privateKey: string; knownHosts?: string };
    https?: { hosts: string[]; username: string; token: string };
  } = {},
): string {
  writeGitCredentialFiles(f.directory, {
    identity: {},
    auth: options,
    visibleDir: "/run/hanse/git/app",
    ownership: null,
  });
  return f.directory;
}

function run(
  f: Fixture,
  file: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(file, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      HANS_TEST_SSH_ARGS: f.argsFile,
      ...env,
    },
  });
}

function sshArgs(f: Fixture): string[] {
  return readFileSync(f.argsFile, "utf8").split("\n").slice(0, -1);
}

function expectPair(args: string[], key: string, value: string): void {
  let found = false;
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === key && args[index + 1] === value) {
      found = true;
      break;
    }
  }
  expect(found, `${key} ${value}`).toBe(true);
}

const SSH_KEY = {
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-body\n-----END OPENSSH PRIVATE KEY-----\n",
};

describe("managed SSH wrapper", () => {
  it("fails clearly without invoking ssh when no private key is configured", () => {
    const f = fixture();
    write(f);
    const result = run(f, path.join(f.directory, "ssh"), ["git@example.com"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no SSH credential is configured");
    expect(() => sshArgs(f)).toThrow();
  });

  it("uses a strict managed known_hosts when configured", () => {
    const f = fixture();
    write(f, { ssh: { ...SSH_KEY, knownHosts: "github.com ssh-ed25519 AAAA\n" } });
    const result = run(f, path.join(f.directory, "ssh"), ["git@github.com", "git-upload-pack"]);
    expect(result.status).toBe(0);
    const args = sshArgs(f);
    expectPair(args, "-F", "/dev/null");
    expectPair(args, "-i", path.join(f.directory, "id"));
    expectPair(args, "-o", "IdentitiesOnly=yes");
    expectPair(args, "-o", "IdentityAgent=none");
    expectPair(args, "-o", "BatchMode=yes");
    expectPair(args, "-o", "ConnectTimeout=20");
    expectPair(args, "-o", "GlobalKnownHostsFile=/dev/null");
    expectPair(args, "-o", `UserKnownHostsFile=${path.join(f.directory, "known_hosts")}`);
    expectPair(args, "-o", "StrictHostKeyChecking=yes");
    expect(args.slice(-2)).toEqual(["git@github.com", "git-upload-pack"]);
  });

  it("uses accept-new and the managed known_hosts when none is provided", () => {
    const f = fixture();
    write(f, { ssh: SSH_KEY });
    const result = run(f, path.join(f.directory, "ssh"), ["git@github.com"]);
    expect(result.status).toBe(0);
    const args = sshArgs(f);
    expectPair(args, "-o", "StrictHostKeyChecking=accept-new");
    expectPair(args, "-o", `UserKnownHostsFile=${path.join(f.directory, "known_hosts")}`);
  });

  it("uses the TMPDIR TOFU file in a read-only mount", () => {
    const f = fixture();
    const tmp = path.join(f.base, "tmp");
    mkdirSync(tmp);
    write(f, { ssh: SSH_KEY });
    const result = run(f, path.join(f.directory, "ssh"), ["git@github.com"], {
      HANSE_CREDENTIALS_READONLY: "1",
      TMPDIR: tmp,
    });
    expect(result.status).toBe(0);
    const args = sshArgs(f);
    expectPair(args, "-o", `UserKnownHostsFile=${path.join(tmp, "hanse-known_hosts")}`);
    expectPair(args, "-o", "StrictHostKeyChecking=accept-new");
  });
});

describe("managed HTTPS askpass", () => {
  const HTTPS = {
    hosts: ["github.com", "gitlab.example", "[2001:db8::1]"],
    username: "x-access-token",
    token: "super-secret-token",
  };

  it("returns the username and password for an allowlisted https host", () => {
    const f = fixture();
    write(f, { https: HTTPS });
    const askpass = path.join(f.directory, "askpass");

    const user = run(f, askpass, ["Username for 'https://github.com': "]);
    expect(user.status).toBe(0);
    expect(user.stdout.trim()).toBe("x-access-token");

    const password = run(f, askpass, ["Password for 'https://github.com': "]);
    expect(password.status).toBe(0);
    expect(password.stdout.trim()).toBe("super-secret-token");
  });

  it("matches hosts case-insensitively and ignores the port", () => {
    const f = fixture();
    write(f, { https: HTTPS });
    const askpass = path.join(f.directory, "askpass");

    expect(run(f, askpass, ["Password for 'https://GITHUB.COM/repo': "]).stdout.trim()).toBe(
      "super-secret-token",
    );
    expect(run(f, askpass, ["Password for 'https://github.com:443/repo': "]).stdout.trim()).toBe(
      "super-secret-token",
    );
    expect(run(f, askpass, ["Password for 'https://[2001:db8::1]:443/repo': "]).stdout.trim()).toBe(
      "super-secret-token",
    );
  });

  it("refuses a host outside the allowlist without printing the token", () => {
    const f = fixture();
    write(f, { https: HTTPS });
    const result = run(f, path.join(f.directory, "askpass"), [
      "Password for 'https://evil.example/repo': ",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(HTTPS.token);
    expect(result.stderr).toContain("not in the HTTPS allowlist");
  });

  it("refuses non-HTTPS schemes without reading the token", () => {
    const f = fixture();
    write(f, { https: HTTPS });
    for (const prompt of [
      "Password for 'http://github.com/repo': ",
      "Password for 'ftp://github.com/repo': ",
    ]) {
      const result = run(f, path.join(f.directory, "askpass"), [prompt]);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain(HTTPS.token);
      expect(result.stderr).toContain("non-HTTPS");
    }
  });

  it("refuses OTP and unknown prompts", () => {
    const f = fixture();
    write(f, { https: HTTPS });
    for (const prompt of [
      "Enter OTP for 'https://github.com': ",
      "Password for https://github.com: ",
    ]) {
      const result = run(f, path.join(f.directory, "askpass"), [prompt]);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain(HTTPS.token);
    }
  });

  it("fails closed when no HTTPS credential is configured", () => {
    const f = fixture();
    write(f);
    const result = run(f, path.join(f.directory, "askpass"), [
      "Password for 'https://github.com': ",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no HTTPS credential is configured");
  });

  it("contains no eval", () => {
    const f = fixture();
    write(f, { https: HTTPS });
    const script = readFileSync(path.join(f.directory, "askpass"), "utf8");
    expect(script).not.toMatch(/\beval\b/);
  });
});
