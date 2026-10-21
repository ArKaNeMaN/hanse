import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GitCredentialChown,
  GitCredentialsMaterializeError,
  materializeGitCredentials,
  shellQuote,
  writeGitCredentialFiles,
} from "../src/git/materialize.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  base: string;
  agentsRoot: string;
  appRoot: string;
  home: string;
  managed: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-materialize-"));
  dirs.push(base);
  const agentsRoot = path.join(base, "agents");
  const appRoot = path.join(agentsRoot, "project", "app");
  const home = path.join(appRoot, "home");
  mkdirSync(home, { recursive: true });
  return {
    base,
    agentsRoot,
    appRoot,
    home,
    managed: path.join(home, ".config", "hanse", "git"),
  };
}

const SSH = {
  privateKey:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-body\n-----END OPENSSH PRIVATE KEY-----\n",
  knownHosts: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA\n",
};

const HTTPS = {
  hosts: ["github.com", "gitlab.example"],
  username: "x-access-token",
  token: "token-body",
};

function materialize(
  f: Fixture,
  options: {
    identity?: { name?: string | null; email?: string | null };
    auth?: { ssh?: typeof SSH; https?: typeof HTTPS };
    ownership?: { uid: number; gid: number } | null;
    chown?: GitCredentialChown;
    appRoot?: string;
    home?: string;
  } = {},
): Record<string, string> {
  return materializeGitCredentials({
    agentsRoot: f.agentsRoot,
    appRoot: options.appRoot ?? f.appRoot,
    home: options.home ?? f.home,
    projectId: "project",
    appKey: "app",
    identity: options.identity ?? { name: null, email: null },
    auth: options.auth ?? {},
    ownership: options.ownership === undefined ? null : options.ownership,
    ...(options.chown === undefined ? {} : { chown: options.chown }),
  });
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

describe("git credential materialization", () => {
  it("writes the exact file set with secure modes", () => {
    const f = fixture();
    const env = materialize(f, {
      identity: { name: "Ada Lovelace", email: "ada@example.com" },
      auth: { ssh: SSH, https: HTTPS },
    });

    expect(readdirSync(f.managed).sort()).toEqual(
      ["askpass", "config", "https_hosts", "id", "known_hosts", "ssh", "token", "username"].sort(),
    );
    expect(mode(f.managed)).toBe(0o700);
    expect(mode(path.join(f.home, ".config"))).toBe(0o700);
    expect(mode(path.join(f.home, ".config", "hanse"))).toBe(0o700);
    expect(mode(path.join(f.managed, "config"))).toBe(0o600);
    expect(mode(path.join(f.managed, "id"))).toBe(0o600);
    expect(mode(path.join(f.managed, "known_hosts"))).toBe(0o600);
    expect(mode(path.join(f.managed, "token"))).toBe(0o600);
    expect(mode(path.join(f.managed, "username"))).toBe(0o600);
    expect(mode(path.join(f.managed, "https_hosts"))).toBe(0o600);
    expect(mode(path.join(f.managed, "ssh"))).toBe(0o700);
    expect(mode(path.join(f.managed, "askpass"))).toBe(0o700);
    expect(env).toEqual({
      GIT_CONFIG_GLOBAL: path.join(f.managed, "config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: shellQuote(path.join(f.managed, "ssh")),
      GIT_ASKPASS: path.join(f.managed, "askpass"),
      GIT_ASKPASS_REQUIRE: "force",
      HANSE_CREDENTIALS_DIR: f.managed,
      LC_ALL: "C",
      LANG: "C",
    });
    expect(readFileSync(path.join(f.managed, "id"), "utf8")).toBe(SSH.privateKey);
    expect(readFileSync(path.join(f.managed, "token"), "utf8")).toBe(HTTPS.token);
    expect(readFileSync(path.join(f.managed, "https_hosts"), "utf8")).toBe(
      "github.com\ngitlab.example\n",
    );
  });

  it("writes git identity with git-config quoting and an empty credential helper", () => {
    const f = fixture();
    materialize(f, {
      identity: { name: 'Ada "Enchantress" \\ Lovelace', email: "ada@example.com" },
    });
    const config = readFileSync(path.join(f.managed, "config"), "utf8");
    expect(config).toContain('[user]\n\tname = "Ada \\"Enchantress\\" \\\\ Lovelace"');
    expect(config).toContain('\temail = "ada@example.com"');
    expect(config).toContain("[credential]\n\thelper =");
    expect(config).toContain(`\tsshCommand = ${shellQuote(path.join(f.managed, "ssh"))}`);
    expect(config).toContain(`\taskpass = ${path.join(f.managed, "askpass")}`);
    expect(config).not.toContain("gpgsign");
  });

  it("omits the user section when no identity is set", () => {
    const f = fixture();
    materialize(f);
    const config = readFileSync(path.join(f.managed, "config"), "utf8");
    expect(config).not.toContain("[user]");
    expect(config).toContain("[credential]");
    expect(config).toContain("[core]");
  });

  it("removes optional credential files on clear while keeping stable files", () => {
    const f = fixture();
    materialize(f, { auth: { ssh: SSH, https: HTTPS } });
    materialize(f, { auth: {} });

    expect(readdirSync(f.managed).sort()).toEqual(["askpass", "config", "ssh"]);
    expect(existsSync(path.join(f.managed, "id"))).toBe(false);
    expect(existsSync(path.join(f.managed, "known_hosts"))).toBe(false);
    expect(existsSync(path.join(f.managed, "token"))).toBe(false);
    expect(existsSync(path.join(f.managed, "username"))).toBe(false);
    expect(existsSync(path.join(f.managed, "https_hosts"))).toBe(false);
  });

  it("rewrites atomically and leaves no temporary files", () => {
    const f = fixture();
    materialize(f, { auth: { https: HTTPS } });
    materialize(f, {
      auth: { https: { ...HTTPS, token: "rotated-token" } },
    });

    expect(readFileSync(path.join(f.managed, "token"), "utf8")).toBe("rotated-token");
    expect(readdirSync(f.managed).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("applies ownership through the injectable seam and never touches ~/.ssh", () => {
    const f = fixture();
    const calls: { target: number | string; uid: number; gid: number }[] = [];
    materialize(f, {
      auth: { ssh: SSH, https: HTTPS },
      ownership: { uid: 1234, gid: 5678 },
      chown: (target, uid, gid) => calls.push({ target, uid, gid }),
    });

    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((call) => call.uid === 1234 && call.gid === 5678)).toBe(true);
    expect(calls.some((call) => typeof call.target === "number")).toBe(true);
    expect(calls.some((call) => typeof call.target === "string")).toBe(true);
    expect(existsSync(path.join(f.home, ".ssh"))).toBe(false);
  });

  it("writes the same file set through the standalone writer with a visible dir", () => {
    const f = fixture();
    const directory = path.join(f.base, "ephemeral", "git");
    const env = writeGitCredentialFiles(directory, {
      identity: { name: "Ada", email: null },
      auth: { ssh: SSH, https: HTTPS },
      visibleDir: "/run/hanse/git/app",
      ownership: null,
    });
    expect(env.GIT_CONFIG_GLOBAL).toBe("/run/hanse/git/app/config");
    expect(env.GIT_ASKPASS).toBe("/run/hanse/git/app/askpass");
    expect(env.HANSE_CREDENTIALS_DIR).toBe("/run/hanse/git/app");
    const config = readFileSync(path.join(directory, "config"), "utf8");
    expect(config).toContain(`sshCommand = '${"/run/hanse/git/app/ssh"}'`);
    expect(config).toContain("\taskpass = /run/hanse/git/app/askpass");
    expect(mode(directory)).toBe(0o700);
  });

  it("rejects a symlinked home without writing through it", () => {
    const f = fixture();
    const other = path.join(f.base, "other-home");
    mkdirSync(other);
    rmSync(f.home, { recursive: true, force: true });
    symlinkSync(other, f.home);

    expect(() => materialize(f)).toThrow(GitCredentialsMaterializeError);
    expect(existsSync(path.join(other, ".config"))).toBe(false);
  });

  it("rejects a symlinked app root", () => {
    const f = fixture();
    const other = path.join(f.base, "other-app");
    mkdirSync(path.join(other, "home"), { recursive: true });
    const linked = path.join(f.base, "agents", "project", "linked");
    symlinkSync(other, linked);

    expect(() =>
      materializeGitCredentials({
        agentsRoot: f.agentsRoot,
        appRoot: linked,
        home: path.join(linked, "home"),
        projectId: "project",
        appKey: "linked",
        identity: {},
        auth: {},
        ownership: null,
      }),
    ).toThrow(GitCredentialsMaterializeError);
    expect(existsSync(path.join(other, "home", ".config"))).toBe(false);
  });

  it("rejects a symlinked project/app segment", () => {
    const f = fixture();
    const other = path.join(f.base, "elsewhere");
    mkdirSync(path.join(other, "app", "home"), { recursive: true });
    rmSync(path.join(f.agentsRoot, "project"), { recursive: true, force: true });
    symlinkSync(other, path.join(f.agentsRoot, "project"));

    expect(() => materialize(f)).toThrow(GitCredentialsMaterializeError);
    expect(existsSync(path.join(other, "app", "home", ".config"))).toBe(false);
  });

  it("rejects an expectedAppRoot mismatch before writing", () => {
    const f = fixture();
    const other = path.join(f.agentsRoot, "project", "other");
    mkdirSync(path.join(other, "home"), { recursive: true });

    expect(() => materialize(f, { appRoot: other, home: path.join(other, "home") })).toThrow(
      GitCredentialsMaterializeError,
    );
    expect(existsSync(path.join(other, "home", ".config"))).toBe(false);
  });

  it("repairs symlinks at .config, hanse, and git", () => {
    for (const component of [
      ".config",
      path.join(".config", "hanse"),
      path.join(".config", "hanse", "git"),
    ]) {
      const f = fixture();
      const outside = path.join(f.base, "outside");
      mkdirSync(outside, { recursive: true });
      const target = path.join(f.home, component);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(outside, target);

      materialize(f, { auth: { https: HTTPS } });

      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(existsSync(path.join(f.managed, "config"))).toBe(true);
      expect(existsSync(path.join(outside, "config"))).toBe(false);
    }
  });

  it("replaces a symlinked final file instead of writing through it", () => {
    const f = fixture();
    materialize(f, { auth: { https: HTTPS } });
    const outside = path.join(f.base, "outside-token");
    writeFileSync(outside, "do-not-touch");
    unlinkSync(path.join(f.managed, "token"));
    symlinkSync(outside, path.join(f.managed, "token"));

    materialize(f, { auth: { https: { ...HTTPS, token: "new-token" } } });

    expect(readFileSync(outside, "utf8")).toBe("do-not-touch");
    expect(lstatSync(path.join(f.managed, "token")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(f.managed, "token"), "utf8")).toBe("new-token");
  });
});
