import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

export const MAX_SSH_KEY_BYTES = 32 * 1024;
export const MAX_KNOWN_HOSTS_BYTES = 16 * 1024;
export const MAX_HTTPS_HOSTS = 32;
export const MAX_HTTPS_USERNAME_CHARS = 256;
export const MAX_HTTPS_TOKEN_CHARS = 4096;
export const MAX_REMOTE_CHARS = 2048;
const KEYGEN_TIMEOUT_MS = 5000;

function isControlCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    if (isControlCode(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

function hasControlExceptNewline(value: string): boolean {
  for (const character of value) {
    if (character !== "\n" && isControlCode(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    result += isControlCode(character.codePointAt(0) ?? 0) ? " " : character;
  }
  return result;
}

export class GitCredentialValidationError extends Error {
  readonly code = "invalid_git_credential";
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "GitCredentialValidationError";
    this.field = field;
  }
}

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
  const failure = result.error === undefined ? "" : result.error.message;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: [result.stderr ?? "", failure].filter((part) => part.length > 0).join("\n"),
  };
};

export const gitSshDraftSchema = z
  .object({
    privateKey: z.string(),
    knownHosts: z.string().optional(),
  })
  .strict();

export const gitHttpsDraftSchema = z
  .object({
    hosts: z.array(z.string()),
    username: z.string(),
    token: z.string(),
  })
  .strict();

export interface GitSshCredential {
  privateKey: string;
  knownHosts?: string;
}

export interface GitHttpsCredential {
  hosts: string[];
  username: string;
  token: string;
}

export interface ValidatedSshCredential extends GitSshCredential {
  publicKey: string;
  fingerprint: string;
  hasKnownHosts: boolean;
}

export type ValidatedHttpsCredential = GitHttpsCredential;

const storedSshCredentialSchema = z
  .object({
    privateKey: z.string().min(1),
    knownHosts: z.string().optional(),
  })
  .strict();

const storedHttpsCredentialSchema = z
  .object({
    hosts: z.array(z.string()).min(1),
    username: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

export function parseStoredSshCredential(value: unknown): GitSshCredential | undefined {
  const parsed = storedSshCredentialSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseStoredHttpsCredential(value: unknown): GitHttpsCredential | undefined {
  const parsed = storedHttpsCredentialSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

export function normalizeSshPrivateKey(value: string): string {
  // Pasted keys often carry indentation, trailing spaces, or a BOM. OpenSSH's PEM parser
  // rejects those with an opaque "error in libcrypto", so normalize the envelope first.
  const lines = value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  while (lines[0] === "") {
    lines.shift();
  }
  while (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
}

function hasForbiddenControl(value: string, allowNewline: boolean): boolean {
  return allowNewline ? hasControlExceptNewline(value) : hasControlCharacters(value);
}

function invalid(message: string, field: string): GitCredentialValidationError {
  return new GitCredentialValidationError(message, field);
}

function redactStderr(stderr: string): string {
  return stripControlCharacters(stderr).replace(/\s+/g, " ").trim().slice(0, 200);
}

function withTempFile<T>(content: string, run: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-sshkey-"));
  const file = path.join(dir, "draft");
  try {
    writeFileSync(file, content, { mode: 0o600 });
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isPassphraseError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("incorrect passphrase") ||
    lower.includes("passphrase is needed") ||
    lower.includes("encrypted")
  );
}

const PASSPHRASE_MESSAGE =
  "This SSH key is passphrase-protected. Passphrase-protected keys are not supported in v1; use an unencrypted deploy key.";

function validatePrivateKeyFormat(privateKey: string): void {
  const begin = /^-----BEGIN ([A-Z0-9 ]+)-----/m.exec(privateKey);
  if (begin === null || begin[1] === undefined) {
    throw invalid("The SSH private key is not a supported PEM/OpenSSH private key.", "privateKey");
  }
  const label = begin[1];
  if (!label.endsWith("PRIVATE KEY") || label.includes("PUBLIC") || label.includes("CERTIFICATE")) {
    throw invalid(
      "The value is not an SSH private key; public keys and certificates are not accepted.",
      "privateKey",
    );
  }
  if (!privateKey.includes(`-----END ${label}-----`)) {
    throw invalid("The SSH private key is missing its matching END marker.", "privateKey");
  }
}

function deriveFingerprint(publicKey: string, runner: RunSshKeygen): string {
  const result = withTempFile(publicKey, (file) => runner(["-lf", file]));
  if (result.status !== 0) {
    throw invalid("The SSH public key could not be read for fingerprinting.", "privateKey");
  }
  const match = /\b(SHA256:[A-Za-z0-9+/=]+)\b/.exec(result.stdout);
  if (match === null || match[1] === undefined) {
    throw invalid("The SSH key fingerprint could not be derived.", "privateKey");
  }
  return match[1];
}

export function validateSshCredential(
  value: unknown,
  runner: RunSshKeygen = runSshKeygen,
): ValidatedSshCredential {
  const draft = gitSshDraftSchema.safeParse(value);
  if (!draft.success) {
    const field = draft.error.issues[0]?.path[0];
    throw invalid(
      "The SSH credential payload is invalid.",
      typeof field === "string" ? field : "value",
    );
  }
  const privateKey = normalizeSshPrivateKey(draft.data.privateKey);
  const bytes = Buffer.byteLength(privateKey, "utf8");
  if (bytes < 1 || bytes > MAX_SSH_KEY_BYTES) {
    throw invalid(
      `The SSH private key must be between 1 byte and ${MAX_SSH_KEY_BYTES} bytes.`,
      "privateKey",
    );
  }
  if (hasForbiddenControl(privateKey, true)) {
    throw invalid("The SSH private key contains control characters.", "privateKey");
  }
  validatePrivateKeyFormat(privateKey);

  const knownHosts = validateKnownHosts(draft.data.knownHosts, runner);

  const output = withTempFile(privateKey, (file) => runner(["-y", "-P", "", "-f", file]));
  if (output.status !== 0) {
    if (isPassphraseError(output.stderr)) {
      throw invalid(PASSPHRASE_MESSAGE, "privateKey");
    }
    const detail = redactStderr(output.stderr);
    throw invalid(
      detail.length > 0
        ? `The SSH private key could not be read: ${detail}`
        : "The SSH private key could not be read.",
      "privateKey",
    );
  }
  const publicKey = (output.stdout.split("\n")[0] ?? "").trim();
  if (!/^(ssh-|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)/.test(publicKey)) {
    throw invalid("ssh-keygen did not return a public key for this private key.", "privateKey");
  }
  if (publicKey.startsWith("ssh-dss ")) {
    throw invalid("DSA SSH keys are not supported.", "privateKey");
  }
  const fingerprint = deriveFingerprint(publicKey, runner);

  return {
    privateKey,
    ...(knownHosts === undefined ? {} : { knownHosts }),
    publicKey,
    fingerprint,
    hasKnownHosts: knownHosts !== undefined,
  };
}

export function validateKnownHosts(
  value: string | undefined,
  runner: RunSshKeygen = runSshKeygen,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const knownHosts = normalizeNewlines(value);
  if (Buffer.byteLength(knownHosts, "utf8") > MAX_KNOWN_HOSTS_BYTES) {
    throw invalid(
      `The known_hosts content must be at most ${MAX_KNOWN_HOSTS_BYTES} bytes.`,
      "knownHosts",
    );
  }
  if (hasForbiddenControl(knownHosts, true)) {
    throw invalid("The known_hosts content contains control characters.", "knownHosts");
  }
  if (knownHosts.trim().length === 0) {
    return undefined;
  }
  const hasEntry = knownHosts
    .split("\n")
    .some((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  if (!hasEntry) {
    throw invalid(
      "The known_hosts file is not valid; paste the output of `ssh-keyscan <host>`.",
      "knownHosts",
    );
  }
  const result = withTempFile(knownHosts, (file) => runner(["-l", "-f", file]));
  if (result.status !== 0) {
    throw invalid(
      "The known_hosts file is not valid; paste the output of `ssh-keyscan <host>`.",
      "knownHosts",
    );
  }
  return knownHosts;
}

const BRACKETED_IPV6 = /^\[([0-9a-f:.]+)\]$/;
const DNS_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeHost(value: string, field: string): string {
  const host = value.trim().toLowerCase();
  if (hasForbiddenControl(host, false) || /\s/.test(host)) {
    throw invalid("HTTPS hosts must not contain whitespace or control characters.", field);
  }
  if (host.length === 0) {
    throw invalid("HTTPS hosts must not be empty.", field);
  }
  if (host.includes("/") || host.includes("@") || host.includes("*") || host.includes("#")) {
    throw invalid(
      "HTTPS hosts must be exact hostnames without schemes, paths, userinfo, or wildcards.",
      field,
    );
  }
  const bracketed = BRACKETED_IPV6.exec(host);
  if (bracketed !== null) {
    if (net.isIP(bracketed[1] ?? "") !== 6) {
      throw invalid("HTTPS hosts must be valid hostnames or IP literals.", field);
    }
    return host;
  }
  if (net.isIP(host) === 4) {
    return host;
  }
  if (host.includes(":") || net.isIP(host) !== 0) {
    throw invalid("HTTPS hosts must be valid hostnames or IP literals.", field);
  }
  if (!DNS_HOST.test(host)) {
    throw invalid("HTTPS hosts must be exact DNS names or IP literals.", field);
  }
  return host;
}

export function validateHttpsCredential(value: unknown): ValidatedHttpsCredential {
  const draft = gitHttpsDraftSchema.safeParse(value);
  if (!draft.success) {
    const field = draft.error.issues[0]?.path[0];
    throw invalid(
      "The HTTPS credential payload is invalid.",
      typeof field === "string" ? field : "value",
    );
  }
  if (draft.data.hosts.length < 1 || draft.data.hosts.length > MAX_HTTPS_HOSTS) {
    throw invalid(`HTTPS hosts must contain 1 to ${MAX_HTTPS_HOSTS} entries.`, "hosts");
  }
  const hosts: string[] = [];
  for (const entry of draft.data.hosts) {
    const host = normalizeHost(entry, "hosts");
    if (!hosts.includes(host)) {
      hosts.push(host);
    }
  }
  const username = draft.data.username.trim();
  if (username.length < 1 || username.length > MAX_HTTPS_USERNAME_CHARS) {
    throw invalid(
      `The HTTPS username must be between 1 and ${MAX_HTTPS_USERNAME_CHARS} characters.`,
      "username",
    );
  }
  if (hasForbiddenControl(username, false)) {
    throw invalid("The HTTPS username contains control characters.", "username");
  }
  const token = draft.data.token.trim();
  if (token.length < 1 || token.length > MAX_HTTPS_TOKEN_CHARS) {
    throw invalid(
      `The HTTPS token must be between 1 and ${MAX_HTTPS_TOKEN_CHARS} characters.`,
      "token",
    );
  }
  if (hasForbiddenControl(token, false)) {
    throw invalid("The HTTPS token contains control characters.", "token");
  }
  return { hosts, username, token };
}

export function validateRemoteUrl(url: string, kind: "ssh" | "https"): void {
  const field = "remote";
  if (url.length < 1 || url.length > MAX_REMOTE_CHARS) {
    throw invalid(`The git remote must be between 1 and ${MAX_REMOTE_CHARS} characters.`, field);
  }
  if (hasForbiddenControl(url, false) || /\s/.test(url)) {
    throw invalid("The git remote must not contain whitespace or control characters.", field);
  }
  if (url.startsWith("-")) {
    throw invalid("The git remote must not look like an option.", field);
  }
  const lower = url.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("git://") || lower.startsWith("ext::")) {
    throw invalid("The git remote protocol is not allowed.", field);
  }
  if (kind === "https") {
    if (!lower.startsWith("https://")) {
      throw invalid("The HTTPS git remote must start with https://.", field);
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid("The git remote is not a valid URL.", field);
    }
    if (parsed.hostname.length === 0 || parsed.hostname.startsWith("-")) {
      throw invalid("The git remote must include a valid host.", field);
    }
    if (parsed.password.length > 0) {
      throw invalid("The git remote must not embed a password.", field);
    }
    return;
  }
  if (lower.startsWith("ssh://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid("The git remote is not a valid URL.", field);
    }
    if (parsed.hostname.length === 0 || parsed.hostname.startsWith("-")) {
      throw invalid("The git remote must include a valid host.", field);
    }
    if (parsed.username.length > 0 && !/^[A-Za-z0-9._-]+$/.test(parsed.username)) {
      throw invalid("The git remote user is not valid.", field);
    }
    if (parsed.password.length > 0) {
      throw invalid("The git remote must not embed a password.", field);
    }
    return;
  }
  const scpLike = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):([^\s]+)$/.exec(url);
  if (scpLike !== null) {
    if ((scpLike[2] ?? "").startsWith("-")) {
      throw invalid("The git remote host is not valid.", field);
    }
    return;
  }
  throw invalid("The SSH git remote must use ssh:// or scp-like user@host:path syntax.", field);
}
