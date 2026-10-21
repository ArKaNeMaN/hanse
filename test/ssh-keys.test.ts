import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintOfBlob, hostKeyPublicText, validatePrivateKey } from "../src/ssh/keys.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function keypair(passphrase = ""): { privateKey: string; publicKey: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-keys-"));
  dirs.push(dir);
  const file = path.join(dir, "id");
  const args = ["-t", "ed25519", "-N", passphrase, "-f", file, "-q"];
  execFileSync("ssh-keygen", args);
  return {
    privateKey: readFileSync(file, "utf8"),
    publicKey: readFileSync(`${file}.pub`, "utf8").trim(),
    dir,
  };
}

describe("SSH key material", () => {
  it("validates an Ed25519 key and derives its public key and fingerprint", () => {
    const pair = keypair();
    const result = validatePrivateKey(pair.privateKey);
    expect(result.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
    expect(result.fingerprint).toMatch(/^SHA256:/);
    expect(result.keyType).toBe("ssh-ed25519");
    expect(result.bits).toBe(256);
  });

  it("rejects passphrase-protected and malformed keys", () => {
    const protectedKey = keypair("secret").privateKey;
    expect(() => validatePrivateKey(protectedKey)).toThrow(/passphrase/i);
    expect(() => validatePrivateKey("not a key")).toThrow(/PEM|OpenSSH/i);
    expect(() => validatePrivateKey("")).toThrow(/between 1 byte/i);
  });

  it("formats a host-key blob and fingerprints it", () => {
    const pair = keypair();
    const blob = Buffer.from(pair.publicKey.split(/\s+/)[1] as string, "base64");
    const formatted = hostKeyPublicText(blob);
    expect(formatted.type).toBe("ssh-ed25519");
    expect(formatted.bits).toBe(256);
    expect(formatted.text).toBe(pair.publicKey.split(/\s+/).slice(0, 2).join(" "));
    expect(fingerprintOfBlob(blob)).toMatch(/^SHA256:/);
  });
});
