import path from "node:path";
import { ConfigError } from "../config/load.js";
import { isInside, resolveWithinRoot } from "../runtime/app-path.js";
import { hashValue } from "../settings/hash.js";

/** Container workspace root that `appDir` must stay inside. */
export const DEFAULT_AGENT_WORKSPACE_ROOT = "/data/workspace";
/** Agents root that `stateDir` must stay inside. */
export const DEFAULT_AGENT_AGENTS_ROOT = "/data/agents";
/** Coordinator state root; no agent path or supervisor write may touch it. */
export const FORBIDDEN_AGENT_STATE_ROOT = "/data/state";

export interface RuntimeResources {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
}

/** Validated runtime spec accepted by the supervisor/runner and consumed by the agent host. */
export interface AppRuntimeSpec {
  appId: string;
  image: string;
  pathMode: "host" | "container";
  appDir: string;
  /**
   * Mount the application directory read-only inside the agent container.
   *
   * Omitted for ordinary applications so their spec hashes stay unchanged; set only for the
   * coordinator-owned master application.
   */
  appDirReadOnly?: boolean;
  stateDir: string;
  networkName: string;
  port?: number;
  env: Record<string, string>;
  resources: RuntimeResources;
  labels: Record<string, string>;
  specHash: string;
}

export type SpecHashInput = Omit<AppRuntimeSpec, "specHash">;

export interface SpecValidationOptions {
  workspaceRoot?: string;
  agentsRoot?: string;
}

const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_KEY_PATTERN =
  /(?:^|_)(?:API_?KEY|SECRET(?:_KEY)?|ACCESS_KEY(?:_ID)?|TOKEN|PASSWORD)$/i;
const PROVIDER_PREFIX_PATTERN =
  /^(?:ANTHROPIC|OPENAI|DEEPSEEK|GOOGLE|GEMINI|GROQ|MISTRAL|OPENROUTER|AZURE|AWS|COHERE|XAI|TOGETHER|FIREWORKS|PERPLEXITY|OLLAMA)_/;
const ENV_PATH_KEYS = new Set([
  "HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "OPENCODE_DB",
  "TMPDIR",
  "MISE_DATA_DIR",
  "HANSE_OPENCODE_AUTH_FILE",
  "HANSE_OPENCODE_PASSWORD_FILE",
  "GIT_CONFIG_GLOBAL",
  "GIT_ASKPASS",
  "HANSE_CREDENTIALS_DIR",
]);

/** Environment keys that would expose coordinator state or secrets to an agent. */
export const FORBIDDEN_AGENT_ENV_KEYS: readonly string[] = [
  "HANSE_OPERATOR_TOKEN",
  "HANSE_RUNTIME_TOKEN",
  "HANSE_DB",
  "HANSE_STATE_HOME",
  "OPENCODE_AUTH_CONTENT",
  "HANSE_AUTH_FILE",
  "OPENCODE_SERVER_PASSWORD",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, pathValue?: string): ConfigError {
  return new ConfigError("VALIDATION_FAILED", message, { path: pathValue });
}

/** True when `value` is a safe single-segment application id. */
export function isValidAppId(value: unknown): value is string {
  return typeof value === "string" && APP_ID_PATTERN.test(value) && value !== "." && value !== "..";
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw invalid(`${key} must be a non-empty string`);
  }
  return value;
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw invalid("port must be an integer between 1 and 65535");
  }
  return value;
}

function parseResources(value: unknown): RuntimeResources {
  if (!isRecord(value)) {
    throw invalid("resources must be an object");
  }
  const memoryBytes = value.memoryBytes;
  const nanoCpus = value.nanoCpus;
  const pidsLimit = value.pidsLimit;
  if (typeof memoryBytes !== "number" || !Number.isInteger(memoryBytes) || memoryBytes <= 0) {
    throw invalid("resources.memoryBytes must be a positive integer");
  }
  if (typeof nanoCpus !== "number" || !Number.isFinite(nanoCpus) || nanoCpus <= 0) {
    throw invalid("resources.nanoCpus must be a positive number");
  }
  if (typeof pidsLimit !== "number" || !Number.isInteger(pidsLimit) || pidsLimit <= 0) {
    throw invalid("resources.pidsLimit must be a positive integer");
  }
  return { memoryBytes, nanoCpus, pidsLimit };
}

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY_PATTERN.test(key) || PROVIDER_PREFIX_PATTERN.test(key);
}

export interface GitSshCommandRoots {
  agentsRoot: string;
  appDir: string;
}

/**
 * Unwrap the managed single-quoted `GIT_SSH_COMMAND` form and reject anything else.
 *
 * `GIT_SSH_COMMAND` is shell-interpreted, so it must never be treated as a plain path or accept
 * arbitrary shell syntax. Only the coordinator-generated `shellQuote(<absolute path>)` value is
 * allowed, and when roots are supplied the path must stay inside the application's mounts.
 */
export function parseGitSshCommand(value: string, roots?: GitSshCommandRoots): string {
  if (value.length < 2 || !value.startsWith("'") || !value.endsWith("'")) {
    throw invalid("GIT_SSH_COMMAND must be a single-quoted absolute path");
  }
  let unwrapped = "";
  let index = 1;
  const end = value.length - 1;
  while (index < end) {
    const character = value.charAt(index);
    if (character !== "'") {
      unwrapped += character;
      index += 1;
      continue;
    }
    if (value.slice(index, index + 4) !== "'\\''") {
      throw invalid("GIT_SSH_COMMAND must be a single-quoted absolute path");
    }
    unwrapped += "'";
    index += 4;
  }
  if (unwrapped.includes("\0") || /[\r\n]/.test(unwrapped)) {
    throw invalid("GIT_SSH_COMMAND must be a single-quoted absolute path");
  }
  if (!path.isAbsolute(unwrapped)) {
    throw invalid("GIT_SSH_COMMAND must be a single-quoted absolute path");
  }
  if (isInside(FORBIDDEN_AGENT_STATE_ROOT, path.resolve(unwrapped))) {
    throw invalid(`GIT_SSH_COMMAND must never point at ${FORBIDDEN_AGENT_STATE_ROOT}`);
  }
  if (roots !== undefined) {
    const target = path.resolve(unwrapped);
    if (!isInside(roots.agentsRoot, target) && !isInside(roots.appDir, target)) {
      throw invalid("GIT_SSH_COMMAND must stay inside the application's mounts");
    }
  }
  return unwrapped;
}

function parseEnv(value: unknown, roots?: GitSshCommandRoots): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw invalid("env must be an object of strings");
  }
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw invalid(`invalid environment key: ${JSON.stringify(key)}`);
    }
    if (typeof item !== "string" || item.includes("\0")) {
      throw invalid(`environment value for ${key} must be a string`);
    }
    if (FORBIDDEN_AGENT_ENV_KEYS.includes(key)) {
      throw invalid(`environment key is not allowed for agents: ${key}`);
    }
    if (isCredentialKey(key)) {
      throw invalid(`provider credentials must not be passed in the runtime spec: ${key}`);
    }
    if (key === "GIT_SSH_COMMAND") {
      parseGitSshCommand(item, roots);
    }
    if (ENV_PATH_KEYS.has(key)) {
      if (!path.isAbsolute(item)) {
        throw invalid(`${key} must be an absolute path`);
      }
      if (isInside(FORBIDDEN_AGENT_STATE_ROOT, path.resolve(item))) {
        throw invalid(`${key} must never point at ${FORBIDDEN_AGENT_STATE_ROOT}`);
      }
      if (roots !== undefined) {
        const target = path.resolve(item);
        if (!isInside(roots.agentsRoot, target) && !isInside(roots.appDir, target)) {
          throw invalid(`${key} must stay inside the application's mounts`);
        }
      }
    }
    env[key] = item;
  }
  return env;
}

function parseLabels(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw invalid("labels must be an object of strings");
  }
  const labels: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.includes("\0")) {
      throw invalid("label keys must be non-empty strings");
    }
    if (typeof item !== "string" || item.includes("\0")) {
      throw invalid(`label value for ${key} must be a string`);
    }
    labels[key] = item;
  }
  return labels;
}

function parsePath(value: unknown, field: "appDir" | "stateDir", root: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${field} must be a non-empty absolute path`);
  }
  const resolved = resolveWithinRoot({ target: value, root, label: field });
  if (isInside(FORBIDDEN_AGENT_STATE_ROOT, resolved)) {
    throw new ConfigError(
      "PATH_OUTSIDE_ROOT",
      `${field} must never point at ${FORBIDDEN_AGENT_STATE_ROOT}: ${value}`,
      { path: value },
    );
  }
  return resolved;
}

function hashableEnv(env: Record<string, string>): Record<string, string> {
  const stable: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (isCredentialKey(key) || /(?:TOKEN|PASSWORD|SECRET)/i.test(key)) {
      continue;
    }
    const value = env[key];
    if (value !== undefined) {
      stable[key] = value;
    }
  }
  return stable;
}

/** Stable hash of the configuration that must recreate a host; ports and credentials are excluded. */
export function computeSpecHash(spec: SpecHashInput): string {
  return hashValue({
    appId: spec.appId,
    image: spec.image,
    pathMode: spec.pathMode,
    appDir: spec.appDir,
    ...(spec.appDirReadOnly === true ? { appDirReadOnly: true } : {}),
    stateDir: spec.stateDir,
    networkName: spec.networkName,
    env: hashableEnv(spec.env),
    resources: spec.resources,
    labels: spec.labels,
  });
}

/** Validate an untrusted spec and return it with a recomputed, verified `specHash`. */
export function validateAppRuntimeSpec(
  value: unknown,
  options: SpecValidationOptions = {},
): AppRuntimeSpec {
  if (!isRecord(value)) {
    throw invalid("runtime spec must be an object");
  }
  const workspaceRoot = options.workspaceRoot ?? DEFAULT_AGENT_WORKSPACE_ROOT;
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENT_AGENTS_ROOT;
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(agentsRoot)) {
    throw invalid("workspaceRoot and agentsRoot must be absolute paths");
  }

  const appId = value.appId;
  if (!isValidAppId(appId)) {
    throw invalid("appId must be a safe single path segment");
  }
  const image = requireString(value, "image");
  const networkName = requireString(value, "networkName");
  if (networkName.includes("/") || /\s/.test(networkName)) {
    throw invalid("networkName must not contain whitespace or slashes");
  }
  const pathMode = value.pathMode;
  if (pathMode !== "host" && pathMode !== "container") {
    throw invalid('pathMode must be "host" or "container"');
  }

  const port = parsePort(value.port);
  const appDir = parsePath(value.appDir, "appDir", workspaceRoot);
  const stateDir = parsePath(value.stateDir, "stateDir", agentsRoot);
  if (value.appDirReadOnly !== undefined && typeof value.appDirReadOnly !== "boolean") {
    throw invalid("appDirReadOnly must be a boolean");
  }
  const appDirReadOnly = value.appDirReadOnly === true;
  const envRoots = pathMode === "container" ? { agentsRoot, appDir } : undefined;
  const base: SpecHashInput = {
    appId,
    image,
    pathMode,
    appDir,
    ...(appDirReadOnly ? { appDirReadOnly: true } : {}),
    stateDir,
    networkName,
    ...(port === undefined ? {} : { port }),
    env: parseEnv(value.env, envRoots),
    resources: parseResources(value.resources),
    labels: parseLabels(value.labels),
  };
  const specHash = computeSpecHash(base);
  if (value.specHash !== undefined) {
    if (typeof value.specHash !== "string" || value.specHash !== specHash) {
      throw invalid("specHash does not match the runtime spec");
    }
  }
  return { ...base, specHash };
}

/** Read and validate a JSON spec file (used by the host and by tests). */
export function parseAppRuntimeSpecJson(
  raw: string,
  options: SpecValidationOptions = {},
): AppRuntimeSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid(
      `runtime spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateAppRuntimeSpec(parsed, options);
}
