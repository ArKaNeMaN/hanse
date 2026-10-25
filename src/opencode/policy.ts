import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationFor } from "./endpoint-auth.js";

/** Action opencode applies when a permission rule matches. */
export type PermissionAction = "allow" | "deny" | "ask";

/** A permission matcher map: pattern -> action, evaluated in insertion order. */
export type PermissionRules = Record<string, PermissionAction>;

/** Explicit permission overlay injected into every managed instance. */
export interface PermissionPolicy {
  external_directory: PermissionRules;
  question: PermissionAction;
  todowrite: PermissionAction;
  todoread: PermissionAction;
  webfetch: PermissionAction;
  websearch: PermissionAction;
  hanse_web_search?: PermissionAction;
  hanse_web_fetch?: PermissionAction;
  read: PermissionRules;
  edit: PermissionRules;
  doom_loop: PermissionAction;
}

/** Web-tool permission decisions derived from the effective settings. */
export interface WebPermissionOptions {
  /** Action for opencode's built-in fetch tool. Defaults to `allow`. */
  webfetch?: PermissionAction;
  /** Action for opencode's built-in search tool. Defaults to `allow`. */
  websearch?: PermissionAction;
  /** Register the managed `hanse_web_search` tool. Defaults to false. */
  managedSearch?: boolean;
  /** Register the managed `hanse_web_fetch` tool. Defaults to false. */
  managedFetch?: boolean;
}

/** Environment-derived roots that agent tools may read outside the app directory. */
export interface PermissionRootOptions {
  xdgDataHome?: string;
  xdgConfigHome?: string;
  xdgCacheHome?: string;
  home?: string;
  tmpdir?: string;
  /** Explicit model-visible attachments root; the agent may read but never write it in runner mode. */
  attachmentsRoot?: string;
  /** Baseline plugin specs; `file://` entries contribute a `<plugin-root>/skills` root. */
  baselinePlugins?: string[];
}

/**
 * Policy generation version. Bumping it changes every launch/settings hash so the existing
 * "Restart required" marker appears after a policy change.
 */
export const ATTACHMENTS_POLICY_VERSION = 1;

/** A single rule as exposed by `GET /agent` in the final (merged) ruleset. */
export interface AgentPermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/** Minimal agent shape needed to verify the effective permission ruleset. */
export interface AgentPolicy {
  name: string;
  hidden: boolean;
  mode?: string;
  rules: AgentPermissionRule[];
}

export type PolicyFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface VerifyPolicyOptions {
  endpoint: string;
  appDir: string;
  trustedRoots: string[];
  /** Per-request timeout. Defaults to 1000 ms. */
  timeoutMs?: number;
  /** Number of retries after the first attempt. Defaults to 2. */
  retries?: number;
  /** Base retry backoff. Defaults to 100 ms. */
  retryDelayMs?: number;
  /** Injectable fetch for tests. */
  fetch?: PolicyFetch;
}

/** Coordinator-only and inherited git environment keys that must never reach a managed agent. */
export const SCRUBBED_ENV_KEYS = [
  "HANSE_OPERATOR_TOKEN",
  "OPENCODE_PERMISSION",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OMO_PROFILE",
  "OCX_PROFILE",
  "HANSE_API_BASE",
  "HANSE_AUTH_FILE",
  "HANSE_DB",
  "HANSE_STATE_HOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_ASKPASS",
  "GIT_ASKPASS_REQUIRE",
  "GIT_TERMINAL_PROMPT",
  "GIT_SSL_CAINFO",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "HANSE_CREDENTIALS_DIR",
  "HANSE_CREDENTIALS_READONLY",
] as const;

/** Sandbox operation variables that are not credentials and must survive scrubbing. */
const RETAINED_GIT_OPERATION_KEYS = new Set([
  "HANSE_GIT_OP",
  "HANSE_GIT_APP_DIR",
  "HANSE_GIT_BRANCH",
  "HANSE_GIT_MESSAGE",
]);

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Convert a trusted root directory into a forward-slash `root/*` permission pattern. */
export function permissionPattern(root: string): string {
  return path.posix.join(toPosix(root), "*");
}

/**
 * Resolve the trusted external roots from the instance environment.
 *
 * Order is load-bearing: opencode evaluates permission rules in insertion order and the last match
 * wins, so these allow patterns must be appended after the leading `"*": "deny"` entry.
 */
export function resolvePermissionPaths(options: PermissionRootOptions = {}): string[] {
  const home = options.home ?? os.homedir();
  const xdgDataHome =
    options.xdgDataHome ?? process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  const xdgConfigHome =
    options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const xdgCacheHome =
    options.xdgCacheHome ?? process.env.XDG_CACHE_HOME ?? path.join(home, ".cache");
  const tmpdir = options.tmpdir ?? os.tmpdir();

  const roots = [
    path.join(xdgDataHome, "opencode", "tool-output"),
    path.join(xdgDataHome, "opencode", "repos"),
    path.join(tmpdir, "opencode"),
    path.join(xdgConfigHome, "opencode", "skills"),
    path.join(xdgCacheHome, "opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    ...(options.attachmentsRoot === undefined ? [] : [options.attachmentsRoot]),
    ...pluginSkillRoots(options.baselinePlugins ?? []),
  ];
  return roots.map(toPosix);
}

function pluginSkillRoots(specs: string[]): string[] {
  const roots: string[] = [];
  for (const spec of specs) {
    if (!spec.startsWith("file://")) continue;
    try {
      roots.push(path.join(fileURLToPath(new URL(spec)), "skills"));
    } catch {
      // Ignore malformed or non-local plugin specs; they cannot be resolved to a trusted root.
    }
  }
  return roots;
}

/**
 * Build the explicit permission overlay.
 *
 * `external_directory` starts with a deny-all entry, then trusted roots. The `read` map deliberately
 * has no `"*": "allow"`: opencode's defaults already allow reads, and a user-level wildcard would
 * override narrower project/plugin denies. The `edit` config/plugin denies are duplicated in bare and
 * star-slash-prefixed forms because opencode matches worktree-relative paths.
 */
export function buildPermissionPolicy(
  roots: string[],
  options: WebPermissionOptions = {},
): PermissionPolicy {
  const external: PermissionRules = { "*": "deny" };
  for (const root of roots) {
    external[permissionPattern(root)] = "allow";
  }
  const policy: PermissionPolicy = {
    external_directory: external,
    question: "allow",
    todowrite: "allow",
    todoread: "allow",
    webfetch: options.webfetch ?? "allow",
    websearch: options.websearch ?? "allow",
    ...(options.managedSearch === true ? { hanse_web_search: "allow" as const } : {}),
    ...(options.managedFetch === true ? { hanse_web_fetch: "allow" as const } : {}),
    read: {
      "*.env": "allow",
      "*.env.*": "allow",
      "*.env.example": "allow",
    },
    edit: {
      "*.env": "allow",
      "*.env.*": "allow",
      "*.env.example": "allow",
      "opencode.json": "deny",
      "opencode.jsonc": "deny",
      "*/opencode.json": "deny",
      "*/opencode.jsonc": "deny",
      ".opencode/opencode.json": "deny",
      ".opencode/opencode.jsonc": "deny",
      "*/.opencode/opencode.json": "deny",
      "*/.opencode/opencode.jsonc": "deny",
      ".opencode/plugin/*": "deny",
      ".opencode/plugins/*": "deny",
      "*/.opencode/plugin/*": "deny",
      "*/.opencode/plugins/*": "deny",
    },
    doom_loop: "ask",
  };
  return policy;
}

/** Coordinator-only environment keys that must never reach a managed agent. */
export function scrubInstanceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
      delete env[key];
      continue;
    }
    if (key.startsWith("HANSE_GIT_") && !RETAINED_GIT_OPERATION_KEYS.has(key)) {
      delete env[key];
    }
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "deny" || value === "ask";
}

function parseRules(value: unknown): AgentPermissionRule[] {
  if (!Array.isArray(value)) return [];
  const rules: AgentPermissionRule[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { permission, pattern, action } = item;
    if (typeof permission !== "string" || typeof pattern !== "string" || !isAction(action))
      continue;
    rules.push({ permission, pattern, action });
  }
  return rules;
}

/** Parse the `GET /agent` response (array or name-keyed map) into verifiable agents. */
export function parseAgents(value: unknown): AgentPolicy[] {
  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (isRecord(value)) {
    entries = Object.entries(value).map(([name, agent]) =>
      isRecord(agent) ? { ...agent, name: agent.name ?? name } : { name },
    );
  } else {
    return [];
  }
  const agents: AgentPolicy[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    agents.push({
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "unknown",
      hidden: entry.hidden === true,
      mode: typeof entry.mode === "string" ? entry.mode : undefined,
      rules: parseRules(entry.permission),
    });
  }
  return agents;
}

/** Wildcard matcher for opencode permission patterns; `*` deliberately crosses `/`. */
export function matchesPermissionPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const source = toPosix(pattern)
    .split("")
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`).test(toPosix(value));
}

/**
 * Resolve a permission with last-match semantics against an ordered ruleset.
 *
 * A `"*"` tool permission matches every tool, mirroring opencode's wildcard permission behavior.
 */
export function evaluatePermission(
  rules: AgentPermissionRule[],
  permission: string,
  value: string,
): PermissionAction | undefined {
  let result: PermissionAction | undefined;
  for (const rule of rules) {
    if (rule.permission !== permission && rule.permission !== "*") continue;
    if (!matchesPermissionPattern(rule.pattern, value)) continue;
    result = rule.action;
  }
  return result;
}

function probePath(root: string): string {
  return path.posix.join(toPosix(root), "probe");
}

/**
 * Evaluate one agent's final ruleset against the guardrail policy.
 *
 * Hidden system agents (compaction/title/summary) have intentional deny profiles, so they are not
 * evaluated. Subagents are checked for external-directory denial only: their question/todowrite
 * denials and narrower external roots are intentional. Primary (and `all`) agents are checked
 * against the full capability allowlist.
 */
export function evaluateAgentPolicy(
  agent: AgentPolicy,
  options: { externalPath: string; siblingPath: string; trustedRoots: string[] },
): string[] {
  if (agent.hidden) return [];
  const warnings: string[] = [];
  const external = evaluatePermission(agent.rules, "external_directory", options.externalPath);
  if (external !== "deny") {
    warnings.push(
      `agent "${agent.name}": external_directory does not deny ${options.externalPath}`,
    );
  }
  const sibling = evaluatePermission(agent.rules, "external_directory", options.siblingPath);
  if (sibling !== "deny") {
    warnings.push(
      `agent "${agent.name}": external_directory does not deny sibling path ${options.siblingPath}`,
    );
  }
  if (agent.mode === "subagent") return warnings;
  for (const root of options.trustedRoots) {
    const trusted = evaluatePermission(agent.rules, "external_directory", probePath(root));
    if (trusted !== "allow") {
      warnings.push(
        `agent "${agent.name}": external_directory does not allow trusted root ${root}`,
      );
    }
  }
  if (evaluatePermission(agent.rules, "question", "*") !== "allow") {
    warnings.push(`agent "${agent.name}": question is not allowed`);
  }
  if (evaluatePermission(agent.rules, "todowrite", "*") === "deny") {
    warnings.push(`agent "${agent.name}": todowrite is denied`);
  }
  return warnings;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function pathWarnings(value: unknown, appDir: string): string[] {
  const info = isRecord(value) ? value : {};
  const directory = typeof info.directory === "string" ? info.directory : undefined;
  const worktree = typeof info.worktree === "string" ? info.worktree : undefined;
  const warnings: string[] = [];
  if (directory === undefined || !samePath(directory, appDir)) {
    warnings.push(
      `instance path.directory is ${JSON.stringify(directory ?? null)} but expected ${JSON.stringify(appDir)}`,
    );
  }
  if (worktree === undefined || (!samePath(worktree, appDir) && worktree !== "/")) {
    warnings.push(
      `instance path.worktree is ${JSON.stringify(worktree ?? null)} but expected ${JSON.stringify(appDir)} or "/"`,
    );
  }
  return warnings;
}

async function fetchJson(
  fetchImpl: PolicyFetch,
  url: string,
  timeoutMs: number,
  authorization: string | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        ...(authorization === undefined ? {} : { authorization }),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("abort");
}

function siblingPathFor(appDir: string): string {
  return path.join(path.dirname(path.resolve(appDir)), "sibling-app", "notes.txt");
}

/**
 * Best-effort post-start verification of the effective policy.
 *
 * Never throws: any mismatch, failure, or timeout becomes a warning. Startup is not blocked.
 */
export async function verifyInstancePolicy(options: VerifyPolicyOptions): Promise<string[]> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1000;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 100;
  let timedOut = false;
  const authorization = authorizationFor(options.endpoint);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const [agentsValue, pathValue] = await Promise.all([
        fetchJson(fetchImpl, `${options.endpoint}/agent`, timeoutMs, authorization),
        fetchJson(fetchImpl, `${options.endpoint}/path`, timeoutMs, authorization),
      ]);
      const warnings = pathWarnings(pathValue, options.appDir);
      const externalPath = "/etc/hostname";
      const siblingPath = siblingPathFor(options.appDir);
      for (const agent of parseAgents(agentsValue)) {
        warnings.push(
          ...evaluateAgentPolicy(agent, {
            externalPath,
            siblingPath,
            trustedRoots: options.trustedRoots,
          }),
        );
      }
      return warnings;
    } catch (error) {
      timedOut = isTimeoutError(error);
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  return [
    timedOut
      ? "policy_unverified: agent policy verification timed out"
      : "policy_unverified: agent policy verification failed",
  ];
}
