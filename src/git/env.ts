import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitError } from "./errors.js";

/** Environment variables that are safe to inherit from the coordinator process. */
const PASSTHROUGH_ENV = [
  "PATH",
  "LANGUAGE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Coordinator-controlled git settings; only these `HANSE_GIT_*` keys reach the child. */
const CONTROLLED_GIT_ENV = [
  "HANSE_GIT_SSH_COMMAND",
  "HANSE_GIT_SSH_KEY",
  "HANSE_GIT_KNOWN_HOSTS",
  "HANSE_GIT_ASKPASS",
  "HANSE_GIT_TOKEN",
  "HANSE_GIT_AUTHOR_NAME",
  "HANSE_GIT_AUTHOR_EMAIL",
  "HANSE_GIT_COMMITTER_NAME",
  "HANSE_GIT_COMMITTER_EMAIL",
  "HANSE_GIT_SSL_CAINFO",
] as const;

const IDENTITY_ENV = [
  ["HANSE_GIT_AUTHOR_NAME", "GIT_AUTHOR_NAME"],
  ["HANSE_GIT_AUTHOR_EMAIL", "GIT_AUTHOR_EMAIL"],
  ["HANSE_GIT_COMMITTER_NAME", "GIT_COMMITTER_NAME"],
  ["HANSE_GIT_COMMITTER_EMAIL", "GIT_COMMITTER_EMAIL"],
] as const;

const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCP_LIKE_REMOTE = /^[^@\s:/]+@[^:\s/]+:\S+$/;
const SAFE_SSH_USER = /^[A-Za-z0-9._-]+$/;

export class GitEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitEnvError";
  }
}

export interface GitChildEnvOptions {
  source: NodeJS.ProcessEnv;
  home: string;
  sshCommand: string;
  askpass?: string;
}

/**
 * Build the minimal environment for a git child process.
 *
 * Never spread `process.env`: coordinator tokens, database/state paths, agent credentials, and
 * ambient `GIT_*`/`SSH_*` configuration must not be inherited. Only an explicit allowlist crosses
 * the boundary.
 */
export function gitChildEnv(options: GitChildEnvOptions): NodeJS.ProcessEnv {
  const source = options.source;
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of CONTROLLED_GIT_ENV) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Reproducible git output regardless of the coordinator's locale.
  env.LC_ALL = "C";
  env.LANG = "C";
  env.PATH = source.PATH ?? "/usr/local/bin:/usr/bin:/bin";

  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.GIT_EDITOR = ":";
  env.GIT_MERGE_AUTOEDIT = "no";
  env.GCM_INTERACTIVE = "never";
  env.HOME = options.home;
  env.GIT_SSH_COMMAND = options.sshCommand;
  if (options.askpass !== undefined) {
    env.GIT_ASKPASS = options.askpass;
  }

  for (const [hanseKey, gitKey] of IDENTITY_ENV) {
    const value = source[hanseKey];
    if (value !== undefined && value.length > 0) {
      env[gitKey] = value;
    }
  }
  if (source.HANSE_GIT_SSL_CAINFO !== undefined) {
    env.GIT_SSL_CAINFO = source.HANSE_GIT_SSL_CAINFO;
  }
  return env;
}

export interface GitConfigOptions {
  sshCommand: string;
  askpass?: string;
  remotes?: readonly string[];
}

/** Command-line config, which takes precedence over repository and global config. */
export function gitConfigArgs(options: GitConfigOptions): string[] {
  const args = [
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
    `core.sshCommand=${options.sshCommand}`,
  ];
  if (options.askpass !== undefined) {
    args.push("-c", `core.askpass=${options.askpass}`);
  }
  for (const name of options.remotes ?? []) {
    if (!isSafeRemoteName(name)) {
      throw new GitEnvError(`Unsafe git remote name: ${name}`);
    }
    args.push(
      "-c",
      `remote.${name}.uploadpack=git-upload-pack`,
      "-c",
      `remote.${name}.receivepack=git-receive-pack`,
    );
  }
  return args;
}

export function isSafeRemoteName(name: string): boolean {
  return SAFE_REMOTE_NAME.test(name);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function requireAbsolute(value: string, key: string): void {
  if (!path.isAbsolute(value)) {
    throw new GitEnvError(`${key} must be an absolute path.`);
  }
}

/**
 * Resolve the controlled SSH command.
 *
 * An explicit `HANSE_GIT_SSH_COMMAND` wins; otherwise a key builds a fixed `ssh` invocation;
 * otherwise the fixed command is plain `ssh`. The value is always passed as `core.sshCommand`, so a
 * repository cannot substitute its own command.
 */
export function resolveGitSshCommand(source: NodeJS.ProcessEnv): string {
  const explicit = source.HANSE_GIT_SSH_COMMAND?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const key = source.HANSE_GIT_SSH_KEY?.trim();
  if (key === undefined || key.length === 0) {
    return "ssh";
  }
  requireAbsolute(key, "HANSE_GIT_SSH_KEY");

  const parts = ["ssh", "-i", shellQuote(key), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes"];
  const knownHosts = source.HANSE_GIT_KNOWN_HOSTS?.trim();
  if (knownHosts !== undefined && knownHosts.length > 0) {
    requireAbsolute(knownHosts, "HANSE_GIT_KNOWN_HOSTS");
    parts.push("-o", shellQuote(`UserKnownHostsFile=${knownHosts}`));
    parts.push("-o", "StrictHostKeyChecking=yes");
  } else {
    parts.push("-o", "StrictHostKeyChecking=accept-new");
  }
  return parts.join(" ");
}

/**
 * Resolve the askpass helper. An explicit `HANSE_GIT_ASKPASS` wins; otherwise a token is written to
 * a generated 0700 helper so no ambient askpass is ever inherited.
 */
export function resolveGitAskpass(
  source: NodeJS.ProcessEnv,
  directory: string,
): string | undefined {
  const explicit = source.HANSE_GIT_ASKPASS?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    requireAbsolute(explicit, "HANSE_GIT_ASKPASS");
    return explicit;
  }

  const token = source.HANSE_GIT_TOKEN;
  if (token === undefined || token.length === 0) {
    return undefined;
  }

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const helper = path.join(directory, "askpass.sh");
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    "  *sername*) printf '%s\\n' 'x-access-token' ;;",
    `  *) printf '%s\\n' ${shellQuote(token)} ;;`,
    "esac",
    "",
  ].join("\n");
  writeFileSync(helper, script, { mode: 0o700 });
  chmodSync(helper, 0o700);
  return helper;
}

function hasControlChars(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function invalidRemote(message: string): GitError {
  return new GitError("invalid_remote", message);
}

/**
 * Validate a configured remote URL.
 *
 * Accepted: `https://`, `ssh://`, scp-like `user@host:path`, and `file://` paths that resolve
 * inside the application directory. Rejected: `ext::`, `git://`, option-looking values, control
 * characters, and file paths outside the application.
 */
export async function validateRemoteUrl(url: string, appDir: string): Promise<void> {
  if (url.length === 0) {
    throw invalidRemote("Git remote URL is empty.");
  }
  if (hasControlChars(url)) {
    throw invalidRemote(`Git remote URL contains control characters: ${redactRemote(url)}`);
  }
  if (/\s/.test(url)) {
    throw invalidRemote(`Git remote URL contains whitespace: ${redactRemote(url)}`);
  }
  if (url.startsWith("-")) {
    throw invalidRemote(`Git remote URL looks like an option: ${redactRemote(url)}`);
  }

  const lower = url.toLowerCase();
  if (lower.startsWith("ext::")) {
    throw invalidRemote(`Git remote protocol is not allowed: ${redactRemote(url)}`);
  }
  if (lower.startsWith("git://")) {
    throw invalidRemote(`Git remote protocol is not allowed: ${redactRemote(url)}`);
  }

  if (lower.startsWith("file://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidRemote(`Invalid file:// git remote: ${redactRemote(url)}`);
    }
    if (parsed.host.length > 0) {
      throw invalidRemote("file:// git remotes must use a local path.");
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
      throw invalidRemote("file:// git remotes must not contain a query or fragment.");
    }
    let filePath: string;
    try {
      filePath = fileURLToPath(parsed);
    } catch {
      throw invalidRemote(`Invalid file:// git remote: ${redactRemote(url)}`);
    }
    let target: string;
    let app: string;
    try {
      [target, app] = await Promise.all([realpath(filePath), realpath(appDir)]);
    } catch {
      throw invalidRemote(
        `file:// git remote path does not resolve inside the application directory: ${redactRemote(url)}`,
      );
    }
    if (!isContained(app, target)) {
      throw invalidRemote(
        `file:// git remote path is outside the application directory: ${redactRemote(url)}`,
      );
    }
    return;
  }

  if (lower.startsWith("https://") || lower.startsWith("ssh://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw invalidRemote(`Invalid git remote URL: ${redactRemote(url)}`);
    }
    if (parsed.hostname.length === 0 || parsed.hostname.startsWith("-")) {
      throw invalidRemote(`Invalid git remote host: ${redactRemote(url)}`);
    }
    if (parsed.protocol === "ssh:" && parsed.username.length > 0) {
      if (!SAFE_SSH_USER.test(parsed.username)) {
        throw invalidRemote(`Invalid git remote user: ${redactRemote(url)}`);
      }
    }
    return;
  }

  if (SCP_LIKE_REMOTE.test(url)) {
    const separator = url.indexOf(":");
    const user = url.slice(0, url.indexOf("@"));
    const host = url.slice(url.indexOf("@") + 1, separator);
    if (!SAFE_SSH_USER.test(user) || host.startsWith("-")) {
      throw invalidRemote(`Invalid git remote user or host: ${redactRemote(url)}`);
    }
    return;
  }

  throw invalidRemote(`Unsupported git remote URL: ${redactRemote(url)}`);
}

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

function redactRemote(value: string): string {
  return value.replace(URL_USERINFO, "$1***@").slice(0, 400);
}
