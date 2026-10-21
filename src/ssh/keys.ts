import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SshError } from "./types.js";

const MAX_KEY_BYTES = 32 * 1024;
const KEYGEN_TIMEOUT_MS = 5_000;

export interface SshKeygenResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type RunSshKeygen = (args: string[]) => SshKeygenResult;

export const runSshKeygen: RunSshKeygen = (args) => {
  const result = spawnSync("ssh-keygen", args, {
    encoding: "utf8",
    timeout: KEYGEN_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: [result.stderr ?? "", result.error?.message ?? ""].filter(Boolean).join("\n"),
  };
};

export interface ValidatedPrivateKey {
  publicKey: string;
  fingerprint: string;
  keyType: string;
  bits: number | null;
  validatedAt: string;
}

function hasControlExceptNewline(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character !== "\n" && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) {
      return true;
    }
  }
  return false;
}

function normalizePrivateKey(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0 || normalized.length > MAX_KEY_BYTES) {
    throw new SshError("ssh_invalid_argument", "The private key must be between 1 byte and 32 KiB");
  }
  if (hasControlExceptNewline(normalized)) {
    throw new SshError(
      "ssh_invalid_argument",
      "The private key contains unsupported control characters",
    );
  }
  if (!normalized.startsWith("-----BEGIN ") || !normalized.trimEnd().endsWith("-----")) {
    throw new SshError("ssh_invalid_argument", "The private key is not in PEM/OpenSSH format");
  }
  if (!normalized.includes("PRIVATE KEY-----") || normalized.includes("PUBLIC KEY-----")) {
    throw new SshError("ssh_invalid_argument", "The value must be a private key, not a public key");
  }
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function parseKeygenList(output: string): { bits: number; fingerprint: string; type: string } {
  const match = /^(\d+)\s+(SHA256:\S+)\s+.*\(([^)]+)\)\s*$/m.exec(output.trim());
  if (match === null) {
    throw new SshError(
      "ssh_invalid_argument",
      "ssh-keygen did not return a usable public-key fingerprint",
    );
  }
  return {
    bits: Number(match[1]),
    fingerprint: match[2] as string,
    type: (match[3] as string).toUpperCase(),
  };
}

export function validatePrivateKey(
  value: string,
  run: RunSshKeygen = runSshKeygen,
  now: () => Date = () => new Date(),
): ValidatedPrivateKey {
  const normalized = normalizePrivateKey(value);
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ssh-key-"));
  try {
    const keyFile = path.join(dir, "id");
    const publicFile = path.join(dir, "id.pub");
    writeFileSync(keyFile, normalized, { mode: 0o600 });
    const derived = run(["-y", "-P", "", "-f", keyFile]);
    if (derived.status !== 0) {
      const message = derived.stderr.trim();
      if (/passphrase|encrypted|incorrect passphrase/i.test(message)) {
        throw new SshError(
          "ssh_invalid_argument",
          "This SSH key is passphrase-protected. Use an unencrypted deploy key.",
        );
      }
      throw new SshError("ssh_invalid_argument", "The SSH private key is invalid");
    }
    const publicKey = derived.stdout.trim();
    if (!/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa)\s+\S+/.test(publicKey)) {
      throw new SshError(
        "ssh_invalid_argument",
        "Unsupported SSH key type (use Ed25519, ECDSA, or RSA)",
      );
    }
    if (publicKey.startsWith("ssh-dss ")) {
      throw new SshError("ssh_invalid_argument", "DSA SSH keys are not supported");
    }
    writeFileSync(publicFile, `${publicKey}\n`, { mode: 0o600 });
    const listed = run(["-lf", publicFile]);
    if (listed.status !== 0) {
      throw new SshError("ssh_invalid_argument", "The SSH public key could not be fingerprinted");
    }
    const parsed = parseKeygenList(listed.stdout);
    if (parsed.type === "RSA" && parsed.bits < 2048) {
      throw new SshError("ssh_invalid_argument", "RSA SSH keys must be at least 2048 bits");
    }
    return {
      publicKey,
      fingerprint: parsed.fingerprint,
      keyType: publicKey.split(/\s+/, 1)[0] as string,
      bits: parsed.bits,
      validatedAt: now().toISOString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** OpenSSH SHA256 fingerprint of a raw SSH host-key blob. */
export function fingerprintOfBlob(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** Canonical `type base64` OpenSSH public-key text for a raw host-key blob. */
export function hostKeyPublicText(key: Buffer): {
  text: string;
  type: string;
  bits: number | null;
} {
  if (key.length < 5) {
    throw new SshError("ssh_transport_error", "The host presented an invalid SSH key");
  }
  const typeLength = key.readUInt32BE(0);
  if (typeLength <= 0 || typeLength > 64 || 4 + typeLength > key.length) {
    throw new SshError("ssh_transport_error", "The host presented an invalid SSH key");
  }
  const type = key.subarray(4, 4 + typeLength).toString("ascii");
  let bits: number | null = null;
  if (type === "ssh-ed25519") {
    bits = 256;
  } else if (type === "ecdsa-sha2-nistp256") {
    bits = 256;
  } else if (type === "ecdsa-sha2-nistp384") {
    bits = 384;
  } else if (type === "ecdsa-sha2-nistp521") {
    bits = 521;
  }
  return { text: `${type} ${key.toString("base64")}`, type, bits };
}
