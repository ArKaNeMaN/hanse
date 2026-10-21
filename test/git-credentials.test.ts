import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitCredentialValidationError,
  MAX_HTTPS_HOSTS,
  MAX_KNOWN_HOSTS_BYTES,
  MAX_SSH_KEY_BYTES,
  type RunSshKeygen,
  validateHttpsCredential,
  validateKnownHosts,
  validateRemoteUrl,
  validateSshCredential,
} from "../src/git/credentials.js";

const dirs: string[] = [];
const hasSshKeygen = spawnSync("ssh-keygen", ["-V"], { encoding: "utf8" }).error === undefined;
const VALID_SSH_KEY =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-body\n-----END OPENSSH PRIVATE KEY-----\n";

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-cred-"));
  dirs.push(dir);
  return dir;
}

function fakeRunner(
  options: {
    publicKey?: string;
    keyStatus?: number;
    keyStderr?: string;
    knownHostsStatus?: number;
  } = {},
): RunSshKeygen {
  return (args) => {
    if (args[0] === "-y") {
      return {
        status: options.keyStatus ?? 0,
        stdout: options.publicKey ?? "ssh-ed25519 AAAAC3NzaFake fake@test\n",
        stderr: options.keyStderr ?? "",
      };
    }
    if (args[0] === "-lf") {
      return { status: 0, stdout: "256 SHA256:fakefingerprint fake@test (ED25519)\n", stderr: "" };
    }
    if (args[0] === "-l") {
      return { status: options.knownHostsStatus ?? 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function generateKey(dir: string, type: "ed25519" | "rsa", passphrase = ""): string {
  const keyPath = path.join(dir, `${type}-${passphrase.length > 0 ? "encrypted" : "plain"}`);
  const result = spawnSync(
    "ssh-keygen",
    ["-q", "-t", type, ...(type === "rsa" ? ["-b", "2048"] : []), "-N", passphrase, "-f", keyPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`ssh-keygen failed: ${result.stderr}`);
  }
  return keyPath;
}

describe("validateSshCredential", () => {
  it("accepts a real unencrypted ed25519 and RSA key and derives the public key and fingerprint", () => {
    if (!hasSshKeygen) {
      return;
    }
    const dir = tempDir();
    for (const type of ["ed25519", "rsa"] as const) {
      const keyPath = generateKey(dir, type);
      const validated = validateSshCredential({ privateKey: readFileSync(keyPath, "utf8") });
      expect(validated.publicKey).toMatch(
        new RegExp(`^ssh-${type === "rsa" ? "rsa" : "ed25519"} `),
      );
      expect(validated.fingerprint).toMatch(/^SHA256:/);
      expect(validated.hasKnownHosts).toBe(false);
      expect(validated.knownHosts).toBeUndefined();
    }
  });

  it("normalizes BOM, CRLF, and indented PEM lines for a real ed25519 key", () => {
    if (!hasSshKeygen) {
      return;
    }
    const dir = tempDir();
    const keyPath = generateKey(dir, "ed25519");
    const raw = readFileSync(keyPath, "utf8");
    const variants = [
      raw
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
      raw
        .split("\n")
        .map((line) => `\t${line}`)
        .join("\n"),
      raw.replace(/\n/g, " \n"),
      raw.replace(/\n/g, "\r\n"),
      `\uFEFF${raw}`,
      raw.replace(/\n/g, "\u00a0\n"),
    ];

    for (const privateKey of variants) {
      const validated = validateSshCredential({ privateKey });
      expect(validated.publicKey).toMatch(/^ssh-ed25519 /);
      expect(validated.privateKey).not.toContain("\r");
      expect(validated.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    }
  });

  it("rejects a real passphrase-protected key with the v1 message", () => {
    if (!hasSshKeygen) {
      return;
    }
    const dir = tempDir();
    const keyPath = generateKey(dir, "ed25519", "secret-passphrase");
    expect(() => validateSshCredential({ privateKey: readFileSync(keyPath, "utf8") })).toThrowError(
      "This SSH key is passphrase-protected. Passphrase-protected keys are not supported in v1; use an unencrypted deploy key.",
    );
  });

  it("accepts valid known_hosts content and reports hasKnownHosts", () => {
    if (!hasSshKeygen) {
      return;
    }
    const dir = tempDir();
    const keyPath = generateKey(dir, "ed25519");
    const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    const knownHosts = `example.com ${publicKey.split(" ").slice(0, 2).join(" ")}\n`;
    const validated = validateSshCredential({
      privateKey: readFileSync(keyPath, "utf8"),
      knownHosts,
    });
    expect(validated.hasKnownHosts).toBe(true);
    expect(validated.knownHosts).toBe(knownHosts);

    const hashedPath = path.join(dir, "hashed_known_hosts");
    writeFileSync(hashedPath, knownHosts);
    const hashed = spawnSync("ssh-keygen", ["-H", "-f", hashedPath], { encoding: "utf8" });
    expect(hashed.status).toBe(0);
    const hashedContent = readFileSync(hashedPath, "utf8");
    expect(hashedContent).toContain("|1|");
    const hashedValidated = validateSshCredential({
      privateKey: readFileSync(keyPath, "utf8"),
      knownHosts: hashedContent,
    });
    expect(hashedValidated.hasKnownHosts).toBe(true);
  });

  it("normalizes CRLF and rejects public keys, certificates, garbage, and oversized input", () => {
    const crlf = VALID_SSH_KEY.replace(/\n/g, "\r\n");
    const validated = validateSshCredential({ privateKey: crlf }, fakeRunner());
    expect(validated.privateKey).not.toContain("\r");

    for (const privateKey of [
      "ssh-ed25519 AAAAC3NzaFake fake@test",
      "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
      "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
      "not a key",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nmissing end\n",
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${"a".repeat(MAX_SSH_KEY_BYTES)}\n-----END OPENSSH PRIVATE KEY-----\n`,
    ]) {
      expect(() => validateSshCredential({ privateKey }, fakeRunner())).toThrow(
        GitCredentialValidationError,
      );
    }
  });

  it("maps passphrase and invalid-key ssh-keygen failures", () => {
    expect(() =>
      validateSshCredential(
        { privateKey: VALID_SSH_KEY },
        fakeRunner({ keyStatus: 255, keyStderr: "Load key: incorrect passphrase supplied" }),
      ),
    ).toThrow(
      "This SSH key is passphrase-protected. Passphrase-protected keys are not supported in v1; use an unencrypted deploy key.",
    );

    let error: unknown;
    try {
      validateSshCredential(
        { privateKey: VALID_SSH_KEY },
        fakeRunner({ keyStatus: 255, keyStderr: "unknown key format sentinel-secret" }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitCredentialValidationError);
    expect((error as Error).message).toContain("The SSH private key could not be read");
    expect((error as Error).message.length).toBeLessThan(300);
  });

  it("rejects DSA public keys returned by ssh-keygen", () => {
    expect(() =>
      validateSshCredential(
        { privateKey: VALID_SSH_KEY },
        fakeRunner({ publicKey: "ssh-dss AAAAB3NzaC1kc3MAAAC fake@test\n" }),
      ),
    ).toThrow("DSA SSH keys are not supported.");
  });

  it("treats empty known_hosts as absent and rejects comment-only content", () => {
    expect(validateKnownHosts(undefined)).toBeUndefined();
    expect(validateKnownHosts("   \n", fakeRunner())).toBeUndefined();
    expect(() => validateKnownHosts("# a comment\n\n", fakeRunner())).toThrow(
      "The known_hosts file is not valid; paste the output of `ssh-keyscan <host>`.",
    );
  });

  it("rejects invalid, oversized, and control-character known_hosts", () => {
    expect(() =>
      validateKnownHosts("not a known hosts line", fakeRunner({ knownHostsStatus: 1 })),
    ).toThrow("The known_hosts file is not valid; paste the output of `ssh-keyscan <host>`.");
    expect(() => validateKnownHosts("x".repeat(MAX_KNOWN_HOSTS_BYTES + 1), fakeRunner())).toThrow(
      GitCredentialValidationError,
    );
    expect(() => validateKnownHosts("example.com\0 key", fakeRunner())).toThrow(
      "The known_hosts content contains control characters.",
    );
  });

  it("rejects an invalid ssh-keygen fingerprint output", () => {
    const runner: RunSshKeygen = (args) =>
      args[0] === "-lf"
        ? { status: 0, stdout: "no fingerprint here\n", stderr: "" }
        : { status: 0, stdout: "ssh-ed25519 AAAAFake fake@test\n", stderr: "" };
    expect(() => validateSshCredential({ privateKey: VALID_SSH_KEY }, runner)).toThrow(
      "The SSH key fingerprint could not be derived.",
    );
  });
});

describe("validateHttpsCredential", () => {
  it("normalizes and accepts DNS, IPv4, and bracketed IPv6 hosts", () => {
    const validated = validateHttpsCredential({
      hosts: [" GitHub.com ", "github.com", "192.168.1.10", "[2001:db8::1]", "EXAMPLE.com"],
      username: " x-access-token ",
      token: "  token-value  ",
    });
    expect(validated.hosts).toEqual(["github.com", "192.168.1.10", "[2001:db8::1]", "example.com"]);
    expect(validated.username).toBe("x-access-token");
    expect(validated.token).toBe("token-value");
  });

  it("rejects schemes, paths, userinfo, wildcards, ports, CIDR, whitespace, and empty entries", () => {
    const invalidHosts = [
      "https://github.com",
      "github.com/repo",
      "user@github.com",
      "*.github.com",
      "github.com:443",
      "10.0.0.0/8",
      "github com",
      "",
      "git\u0000hub.com",
      "2001:db8::1",
    ];
    for (const host of invalidHosts) {
      expect(() => validateHttpsCredential({ hosts: [host], username: "u", token: "t" })).toThrow(
        GitCredentialValidationError,
      );
    }
    expect(() => validateHttpsCredential({ hosts: [], username: "u", token: "t" })).toThrow(
      "HTTPS hosts must contain 1 to 32 entries.",
    );
    expect(() =>
      validateHttpsCredential({
        hosts: Array.from(
          { length: MAX_HTTPS_HOSTS + 1 },
          (_, index) => `host${index}.example.com`,
        ),
        username: "u",
        token: "t",
      }),
    ).toThrow(`HTTPS hosts must contain 1 to ${MAX_HTTPS_HOSTS} entries.`);
  });

  it("enforces username and token bounds without echoing them", () => {
    expect(() =>
      validateHttpsCredential({ hosts: ["github.com"], username: "", token: "t" }),
    ).toThrow("The HTTPS username must be between 1 and 256 characters.");
    expect(() =>
      validateHttpsCredential({ hosts: ["github.com"], username: "u".repeat(257), token: "t" }),
    ).toThrow("The HTTPS username must be between 1 and 256 characters.");
    expect(() =>
      validateHttpsCredential({ hosts: ["github.com"], username: "bad\u0000user", token: "t" }),
    ).toThrow("The HTTPS username contains control characters.");
    expect(() =>
      validateHttpsCredential({ hosts: ["github.com"], username: "u", token: "" }),
    ).toThrow("The HTTPS token must be between 1 and 4096 characters.");
    expect(() =>
      validateHttpsCredential({ hosts: ["github.com"], username: "u", token: "t".repeat(4097) }),
    ).toThrow("The HTTPS token must be between 1 and 4096 characters.");
    expect(() =>
      validateHttpsCredential({ hosts: ["github.com"], username: "u", token: "bad\u0000token" }),
    ).toThrow("The HTTPS token contains control characters.");

    let message = "";
    try {
      validateHttpsCredential({
        hosts: ["github.com"],
        username: "u",
        token: `sentinel\u0000token`,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("sentinel");
  });

  it("rejects malformed payload shapes with a bounded field", () => {
    let error: unknown;
    try {
      validateHttpsCredential({ hosts: "github.com", username: "u", token: "t" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GitCredentialValidationError);
    expect((error as GitCredentialValidationError).field).toBe("hosts");
  });
});

describe("validateRemoteUrl", () => {
  it("accepts https and ssh remotes without embedded passwords", () => {
    for (const url of [
      "https://github.com/example/repo.git",
      "https://user@github.com/example/repo.git",
      "ssh://git@github.com/example/repo.git",
      "git@github.com:example/repo.git",
    ]) {
      const kind = url.startsWith("https://") ? "https" : "ssh";
      expect(() => validateRemoteUrl(url, kind)).not.toThrow();
    }
  });

  it("rejects embedded passwords, disallowed schemes, and unsafe syntax", () => {
    expect(() => validateRemoteUrl("https://user:pass@example.com/repo", "https")).toThrow(
      "The git remote must not embed a password.",
    );
    expect(() => validateRemoteUrl("ssh://git:pass@example.com/repo", "ssh")).toThrow(
      "The git remote must not embed a password.",
    );
    for (const url of [
      "http://example.com/repo.git",
      "git://example.com/repo.git",
      "ext::sh -c 'touch /tmp/pwned'",
      "https://example.com/repo\n.git",
      "https://example.com/repo git",
      " -oProxyCommand=sh",
      "ssh://-oProxyCommand=sh/repo.git",
      "example.com:repo.git",
    ]) {
      expect(() => validateRemoteUrl(url, "https")).toThrow(GitCredentialValidationError);
    }
    expect(() => validateRemoteUrl("git@-oProxyCommand=sh:repo.git", "ssh")).toThrow(
      GitCredentialValidationError,
    );
    expect(() => validateRemoteUrl(`https://example.com/${"a".repeat(2048)}`, "https")).toThrow(
      GitCredentialValidationError,
    );
  });
});
