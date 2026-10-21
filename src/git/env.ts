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
  "HANSE_CREDENTIALS_READONLY",
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

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
