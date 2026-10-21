// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal shell wrappers contain parameter expansion.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { sanitizeAppKey } from "../opencode/instance.js";
import type { GitHttpsCredential, GitSshCredential } from "./credentials.js";

/** Ownership applied to managed directories and credential files. */
export interface GitCredentialOwnership {
  uid: number;
  gid: number;
}

/** Injectable chown seam: file targets are open file descriptors, directory targets are paths. */
export type GitCredentialChown = (target: number | string, uid: number, gid: number) => void;

export interface GitIdentity {
  name?: string | null;
  email?: string | null;
}

export interface GitCredentialAuth {
  ssh?: GitSshCredential;
  https?: GitHttpsCredential;
}

export interface GitCredentialWriteOptions {
  identity: GitIdentity;
  auth: GitCredentialAuth;
  /** Directory path as visible in the consumer container (used by config `core.sshCommand`). */
  visibleDir: string;
  /** Explicit ownership, or `null` to never chown. Defaults to 1000:1000 only when running as root. */
  ownership?: GitCredentialOwnership | null;
  /** Injectable chown implementation for tests. */
  chown?: GitCredentialChown;
}

export interface MaterializeGitCredentialsInput {
  agentsRoot: string;
  appRoot: string;
  home: string;
  projectId: string;
  appKey: string;
  identity: GitIdentity;
  auth: GitCredentialAuth;
  ownership?: GitCredentialOwnership | null;
  chown?: GitCredentialChown;
}

export type GitCredentialEnv = Record<string, string>;

export class GitCredentialsMaterializeError extends Error {
  readonly code = "git_credentials_materialize_failed";

  constructor(message: string) {
    super(message);
    this.name = "GitCredentialsMaterializeError";
  }
}

const MANAGED_SEGMENTS = [".config", "hanse", "git"] as const;

const SSH_WRAPPER = [
  "#!/bin/sh",
  "# Hanse managed SSH wrapper. Do not edit; it is rewritten by the coordinator.",
  'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
  "",
  'if [ ! -f "$dir/id" ]; then',
  '  echo "hanse: no SSH credential is configured for this application" >&2',
  "  exit 1",
  "fi",
  "",
  'if [ -s "$dir/known_hosts" ]; then',
  "  strict=yes",
  '  user_kh="$dir/known_hosts"',
  "else",
  "  strict=accept-new",
  '  if [ "${HANSE_CREDENTIALS_READONLY:-0}" = "1" ]; then',
  '    user_kh="${TMPDIR:-/tmp}/hanse-known_hosts"',
  "  else",
  '    user_kh="$dir/known_hosts"',
  "  fi",
  "fi",
  "",
  "exec ssh -F /dev/null \\",
  '  -i "$dir/id" \\',
  "  -o IdentitiesOnly=yes \\",
  "  -o IdentityAgent=none \\",
  "  -o BatchMode=yes \\",
  "  -o ConnectTimeout=20 \\",
  "  -o GlobalKnownHostsFile=/dev/null \\",
  '  -o UserKnownHostsFile="$user_kh" \\',
  '  -o StrictHostKeyChecking="$strict" \\',
  '  "$@"',
  "",
].join("\n");

const HTTPS_ASKPASS = [
  "#!/bin/sh",
  'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
  "prompt=$1",
  "",
  'case "$prompt" in',
  '  *"Username for \'"*|*"Password for \'"*) ;;',
  '  *) echo "hanse: unexpected git credential prompt" >&2; exit 1 ;;',
  "esac",
  "",
  "url=${prompt#*\\'}",
  "url=${url%%\\'*}",
  'case "$url" in',
  "  https://*) ;;",
  '  *) echo "hanse: refusing a non-HTTPS credential prompt" >&2; exit 1 ;;',
  "esac",
  "",
  "host=${url#*://}",
  "host=${host%%/*}",
  "host=${host##*@}",
  "host=$(printf '%s' \"$host\" | tr '[:upper:]' '[:lower:]')",
  'case "$host" in',
  '  \\[*\\]:*) host="${host%]:*}]" ;;',
  "  \\[*\\]*)  ;;",
  "  *:*)     host=${host%%:*};",
  "esac",
  "",
  'if [ ! -s "$dir/https_hosts" ]; then',
  '  echo "hanse: no HTTPS credential is configured for this application" >&2',
  "  exit 1",
  "fi",
  "",
  'if ! grep -Fxiq -- "$host" "$dir/https_hosts"; then',
  "  echo \"hanse: git host '$host' is not in the HTTPS allowlist\" >&2",
  "  exit 1",
  "fi",
  "",
  'case "$prompt" in',
  '  *"Username for"*) cat "$dir/username" ;;',
  '  *"Password for"*) cat "$dir/token" ;;',
  '  *) echo "hanse: unsupported git credential prompt" >&2; exit 1 ;;',
  "esac",
  "",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** POSIX single-quote escaping; the inverse accepted by `parseGitSshCommand`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quote a value for a git-config `name = value` line. */
export function gitConfigQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function defaultOwnership(
  ownership: GitCredentialOwnership | null | undefined,
): GitCredentialOwnership | null {
  if (ownership !== undefined) {
    return ownership;
  }
  const getuid = process.getuid;
  if (typeof getuid !== "function") {
    return null;
  }
  const uid = getuid();
  if (uid === 1000) {
    return null;
  }
  if (uid === 0 || process.env.NODE_ENV === "production") {
    return { uid: 1000, gid: 1000 };
  }
  return null;
}

function defaultChown(target: number | string, uid: number, gid: number): void {
  if (typeof target === "number") {
    fchownSync(target, uid, gid);
    return;
  }
  chownSync(target, uid, gid);
}

interface WriteContext {
  ownership: GitCredentialOwnership | null;
  chown: GitCredentialChown;
}

function ensureDirectory(directory: string, context: WriteContext): void {
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing === undefined) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    if (context.ownership !== null) {
      context.chown(directory, context.ownership.uid, context.ownership.gid);
    }
    return;
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new GitCredentialsMaterializeError(
      `managed directory is not a real directory: ${directory}`,
    );
  }
  chmodSync(directory, 0o700);
  if (context.ownership !== null) {
    context.chown(directory, context.ownership.uid, context.ownership.gid);
  }
}

function prepareManagedDirectory(home: string, context: WriteContext): string {
  let current = home;
  for (const segment of MANAGED_SEGMENTS) {
    current = path.join(current, segment);
    const existing = lstatSync(current, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      unlinkSync(current);
    }
    ensureDirectory(current, context);
  }
  return current;
}

function writeAtomic(
  directory: string,
  name: string,
  content: string,
  mode: number,
  context: WriteContext,
): void {
  const target = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.tmp-${randomBytes(8).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    fchmodSync(fd, mode);
    if (context.ownership !== null) {
      context.chown(fd, context.ownership.uid, context.ownership.gid);
    }
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

function removeFile(target: string): void {
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing === undefined) {
    return;
  }
  if (existing.isDirectory() && !existing.isSymbolicLink()) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  unlinkSync(target);
}

function managedConfig(identity: GitIdentity, visibleDir: string): string {
  const lines: string[] = [];
  const name = identity.name?.trim() ?? "";
  const email = identity.email?.trim() ?? "";
  if (name.length > 0 || email.length > 0) {
    lines.push("[user]");
    if (name.length > 0) {
      lines.push(`\tname = ${gitConfigQuote(name)}`);
    }
    if (email.length > 0) {
      lines.push(`\temail = ${gitConfigQuote(email)}`);
    }
    lines.push("");
  }
  lines.push("[credential]", "\thelper =", "", "[core]");
  lines.push(`\tsshCommand = ${shellQuote(path.join(visibleDir, "ssh"))}`);
  lines.push(`\taskpass = ${path.join(visibleDir, "askpass")}`, "");
  return lines.join("\n");
}

function requireAuth(auth: GitCredentialAuth): {
  ssh?: GitSshCredential;
  https?: GitHttpsCredential;
} {
  if (!isRecord(auth)) {
    throw new GitCredentialsMaterializeError("git credential snapshot is invalid");
  }
  return auth;
}

/**
 * Write the managed git credential file set into `dir`.
 *
 * This core writer does not perform the canonical app-root checks; the app path must call
 * {@link materializeGitCredentials}. The Phase 3 Test connection path uses it with an ephemeral
 * directory and the container-visible `visibleDir`.
 */
export function writeGitCredentialFiles(
  dir: string,
  options: GitCredentialWriteOptions,
): GitCredentialEnv {
  const context: WriteContext = {
    ownership: defaultOwnership(options.ownership),
    chown: options.chown ?? defaultChown,
  };
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new GitCredentialsMaterializeError(
      `credential directory is not a real directory: ${dir}`,
    );
  }
  if (existing === undefined) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(dir, 0o700);
  if (context.ownership !== null) {
    context.chown(dir, context.ownership.uid, context.ownership.gid);
  }

  const auth = requireAuth(options.auth);
  writeAtomic(dir, "config", managedConfig(options.identity, options.visibleDir), 0o600, context);
  writeAtomic(dir, "ssh", SSH_WRAPPER, 0o700, context);
  writeAtomic(dir, "askpass", HTTPS_ASKPASS, 0o700, context);

  if (auth.ssh !== undefined) {
    writeAtomic(dir, "id", auth.ssh.privateKey, 0o600, context);
    if (auth.ssh.knownHosts !== undefined && auth.ssh.knownHosts.trim().length > 0) {
      writeAtomic(dir, "known_hosts", auth.ssh.knownHosts, 0o600, context);
    } else {
      removeFile(path.join(dir, "known_hosts"));
    }
  } else {
    removeFile(path.join(dir, "id"));
    removeFile(path.join(dir, "known_hosts"));
  }

  if (auth.https !== undefined) {
    writeAtomic(dir, "token", auth.https.token, 0o600, context);
    writeAtomic(dir, "username", auth.https.username, 0o600, context);
    writeAtomic(dir, "https_hosts", `${auth.https.hosts.join("\n")}\n`, 0o600, context);
  } else {
    removeFile(path.join(dir, "token"));
    removeFile(path.join(dir, "username"));
    removeFile(path.join(dir, "https_hosts"));
  }

  return credentialEnv(options.visibleDir);
}

/** Stable path-only environment fragment for a managed credential directory. */
export function credentialEnv(visibleDir: string): GitCredentialEnv {
  const config = path.join(visibleDir, "config");
  const ssh = path.join(visibleDir, "ssh");
  const askpass = path.join(visibleDir, "askpass");
  return {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: shellQuote(ssh),
    GIT_ASKPASS: askpass,
    GIT_ASKPASS_REQUIRE: "force",
    HANSE_CREDENTIALS_DIR: visibleDir,
    LC_ALL: "C",
    LANG: "C",
  };
}

function requireRealDirectory(directory: string, label: string): string {
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new GitCredentialsMaterializeError(`${label} is not a real directory: ${directory}`);
  }
  return realpathSync(directory);
}

/**
 * Materialize the effective git identity and credentials into an app's isolated HOME.
 *
 * Every path is checked against the canonical app root derived from `realpath(agentsRoot)`; a
 * symlinked app root, HOME, managed component, or final component never redirects a write.
 */
export function materializeGitCredentials(input: MaterializeGitCredentialsInput): GitCredentialEnv {
  const agentsRoot = realpathSync(input.agentsRoot);
  const expectedAppRoot = path.join(
    agentsRoot,
    sanitizeAppKey(input.projectId),
    sanitizeAppKey(input.appKey),
  );
  const appRoot = requireRealDirectory(input.appRoot, "application root");
  if (appRoot !== expectedAppRoot) {
    throw new GitCredentialsMaterializeError(
      "application root does not match the expected agents root path",
    );
  }
  const home = requireRealDirectory(input.home, "application home");
  const expectedHome = path.join(expectedAppRoot, "home");
  if (home !== expectedHome) {
    throw new GitCredentialsMaterializeError(
      "application home does not match the expected agents root path",
    );
  }

  const context: WriteContext = {
    ownership: defaultOwnership(input.ownership),
    chown: input.chown ?? defaultChown,
  };
  if (context.ownership !== null) {
    try {
      context.chown(input.appRoot, context.ownership.uid, context.ownership.gid);
      context.chown(input.home, context.ownership.uid, context.ownership.gid);
    } catch {
      throw new GitCredentialsMaterializeError(
        "cannot apply the required ownership to the application directories",
      );
    }
  }
  const managedDir = prepareManagedDirectory(home, context);
  const realManaged = realpathSync(managedDir);
  const expectedManaged = path.join(expectedHome, ".config", "hanse", "git");
  if (realManaged !== expectedManaged) {
    throw new GitCredentialsMaterializeError(
      "managed credential directory does not match the expected app HOME path",
    );
  }
  if (
    !isInside(home, realManaged) ||
    !isInside(path.join(expectedHome, ".config", "hanse"), realManaged)
  ) {
    throw new GitCredentialsMaterializeError(
      "managed credential directory escapes the expected app HOME path",
    );
  }

  return writeGitCredentialFiles(managedDir, {
    identity: input.identity,
    auth: input.auth,
    visibleDir: managedDir,
    ownership: context.ownership,
    chown: context.chown,
  });
}
