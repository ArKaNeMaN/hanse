import { ConfigError } from "../config/load.js";
import {
  MAX_KNOWN_HOSTS_BYTES,
  MAX_REMOTE_CHARS,
  MAX_SSH_KEY_BYTES,
  normalizeSshPrivateKey,
  validateHttpsCredential,
} from "./credentials.js";
import { validateRemoteUrl } from "./env.js";
import { GitError } from "./errors.js";

export const GIT_OPERATIONS = ["status", "fetch", "update", "switch", "commit", "push"] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];

export interface GitRequest {
  operation: GitOperation;
  branch?: string;
  message?: string;
}

export type GitTestKind = "ssh" | "https";

export interface GitSshTestDraft {
  privateKey: string;
  knownHosts?: string;
}

export interface GitHttpsTestDraft {
  hosts: string[];
  username: string;
  token: string;
}

export interface GitTestRequest {
  kind: GitTestKind;
  remote?: string;
  ssh?: GitSshTestDraft;
  https?: GitHttpsTestDraft;
}

export interface GitTestResult {
  ok: true;
  kind: GitTestKind;
  remote: string;
  refs: number;
  head?: string;
  warnings: string[];
}

const SCP_LIKE_REMOTE = /^[^@\s:/]+@[^:\s/]+:\S+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ConfigError {
  return new ConfigError("VALIDATION_FAILED", message);
}

function safeBranch(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw invalid("branch must be a non-empty string of at most 200 characters");
  }
  if (
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("\0") ||
    /\s/.test(value) ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw invalid(`invalid branch name: ${value}`);
  }
  return value;
}

/**
 * Validate the fixed git operation set used by the runner and its sandbox helper.
 *
 * Callers never accept arbitrary git arguments. B1.5 executes the validated operation in a one-shot
 * container with only the app directory and a read-only credential directory mounted.
 */
export function validateGitRequest(value: unknown): GitRequest {
  if (!isRecord(value)) {
    throw invalid("git request must be an object");
  }
  const allowed = new Set(["operation", "branch", "message"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalid(`unknown git request field: ${key}`);
    }
  }
  const operation = value.operation;
  if (typeof operation !== "string" || !(GIT_OPERATIONS as readonly string[]).includes(operation)) {
    throw invalid(`git operation must be one of: ${GIT_OPERATIONS.join(", ")}`);
  }
  const result: GitRequest = { operation: operation as GitOperation };
  if (value.branch !== undefined) {
    if (operation !== "switch") {
      throw invalid("branch is only valid for the switch operation");
    }
    result.branch = safeBranch(value.branch);
  }
  if (value.message !== undefined) {
    if (operation !== "commit") {
      throw invalid("message is only valid for the commit operation");
    }
    if (typeof value.message !== "string" || value.message.trim().length === 0) {
      throw invalid("commit message is required");
    }
    const message = value.message.trim();
    if (message.length > 4000 || message.includes("\0")) {
      throw invalid("commit message is invalid");
    }
    result.message = message;
  }
  if (operation === "switch" && result.branch === undefined) {
    throw invalid("branch is required for the switch operation");
  }
  if (operation === "commit" && result.message === undefined) {
    throw invalid("message is required for the commit operation");
  }
  return result;
}

function invalidTest(message: string): GitError {
  return new GitError("invalid_input", message);
}

function hasControl(value: string, allowNewline: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (allowNewline && (code === 0x09 || code === 0x0a)) {
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function sshDraft(value: unknown): GitSshTestDraft {
  if (!isRecord(value)) {
    throw invalidTest("ssh must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "privateKey" && key !== "knownHosts") {
      throw invalidTest(`unknown ssh draft field: ${key}`);
    }
  }
  if (typeof value.privateKey !== "string") {
    throw invalidTest("ssh.privateKey must be a string");
  }
  const privateKey = normalizeSshPrivateKey(value.privateKey);
  const bytes = Buffer.byteLength(privateKey, "utf8");
  if (bytes < 1 || bytes > MAX_SSH_KEY_BYTES) {
    throw invalidTest(`ssh.privateKey must be between 1 and ${MAX_SSH_KEY_BYTES} bytes`);
  }
  if (hasControl(privateKey, true)) {
    throw invalidTest("ssh.privateKey contains control characters");
  }
  const begin = /^-----BEGIN ([A-Z0-9 ]+)-----/m.exec(privateKey);
  if (begin === null || begin[1] === undefined) {
    throw invalidTest("ssh.privateKey is not a supported private key");
  }
  const label = begin[1];
  if (
    !label.endsWith("PRIVATE KEY") ||
    label.includes("PUBLIC") ||
    label.includes("CERTIFICATE") ||
    !privateKey.includes(`-----END ${label}-----`)
  ) {
    throw invalidTest("ssh.privateKey is not a supported private key");
  }
  if (value.knownHosts === undefined) {
    return { privateKey };
  }
  if (typeof value.knownHosts !== "string") {
    throw invalidTest("ssh.knownHosts must be a string");
  }
  const knownHosts = value.knownHosts.replace(/\r\n/g, "\n");
  if (Buffer.byteLength(knownHosts, "utf8") > MAX_KNOWN_HOSTS_BYTES) {
    throw invalidTest(`ssh.knownHosts must be at most ${MAX_KNOWN_HOSTS_BYTES} bytes`);
  }
  if (hasControl(knownHosts, true)) {
    throw invalidTest("ssh.knownHosts contains control characters");
  }
  if (knownHosts.trim().length === 0) {
    return { privateKey };
  }
  if (
    !knownHosts.split("\n").some((line) => line.trim().length > 0 && !line.trim().startsWith("#"))
  ) {
    throw invalidTest("ssh.knownHosts does not contain a host key");
  }
  return { privateKey, knownHosts };
}

function httpsDraft(value: unknown): GitHttpsTestDraft {
  if (!isRecord(value)) {
    throw invalidTest("https must be an object");
  }
  try {
    return validateHttpsCredential(value);
  } catch (error) {
    throw invalidTest(error instanceof Error ? error.message : "https credential is invalid");
  }
}

function hostFromRemote(remote: string): string | undefined {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    return undefined;
  }
  try {
    const parsed = new URL(remote);
    if (parsed.hostname.length === 0) {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function remoteScheme(remote: string): GitTestKind | undefined {
  const lower = remote.toLowerCase();
  if (lower.startsWith("https://")) {
    return "https";
  }
  if (lower.startsWith("ssh://") || SCP_LIKE_REMOTE.test(remote)) {
    return "ssh";
  }
  return undefined;
}

/**
 * Validate a draft Test-connection request.
 *
 * Shape and size checks only: the runner does not run `ssh-keygen`, so an invalid key fails at
 * `ls-remote` instead of being rejected up front. Secrets are only accepted in the body and are
 * never echoed in an error.
 */
export async function validateGitTestRequest(value: unknown): Promise<GitTestRequest> {
  if (!isRecord(value)) {
    throw invalidTest("git test request must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!["kind", "remote", "ssh", "https"].includes(key)) {
      throw invalidTest(`unknown git test request field: ${key}`);
    }
  }
  const kind = value.kind;
  if (kind !== "ssh" && kind !== "https") {
    throw invalidTest("kind must be ssh or https");
  }
  if (kind === "ssh") {
    if (value.ssh === undefined || value.https !== undefined) {
      throw invalidTest("an ssh test requires exactly the ssh draft");
    }
  } else if (value.https === undefined || value.ssh !== undefined) {
    throw invalidTest("an https test requires exactly the https draft");
  }
  const ssh = kind === "ssh" ? sshDraft(value.ssh) : undefined;
  const https = kind === "https" ? httpsDraft(value.https) : undefined;
  const request: GitTestRequest = {
    kind,
    ...(ssh === undefined ? {} : { ssh }),
    ...(https === undefined ? {} : { https }),
  };
  if (value.remote !== undefined) {
    if (typeof value.remote !== "string") {
      throw invalidTest("remote must be a string");
    }
    if (value.remote.length < 1 || value.remote.length > MAX_REMOTE_CHARS) {
      throw invalidTest(`remote must be between 1 and ${MAX_REMOTE_CHARS} characters`);
    }
    try {
      await validateRemoteUrl(value.remote, "/");
    } catch (error) {
      if (error instanceof GitError) {
        throw error;
      }
      throw invalidTest(error instanceof Error ? error.message : "remote is invalid");
    }
    if (remoteScheme(value.remote) !== kind) {
      throw new GitError(
        "credential_scheme_mismatch",
        "The remote scheme does not match the selected credential type.",
      );
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.remote)) {
      const parsed = new URL(value.remote);
      if (parsed.password.length > 0) {
        throw new GitError("invalid_remote", "Git remote URLs must not contain a password.");
      }
    }
    if (kind === "https" && https !== undefined) {
      const host = hostFromRemote(value.remote);
      if (host === undefined || !https.hosts.includes(host)) {
        throw new GitError(
          "host_not_allowed",
          "The remote host is not in the HTTPS allowlist for this credential.",
        );
      }
    }
    request.remote = value.remote;
  }
  return request;
}
