import { lstatSync } from "node:fs";
import path from "node:path";
import { type AppRuntimeSpec, parseGitSshCommand, validateAppRuntimeSpec } from "../agent/spec.js";
import { ConfigError } from "../config/load.js";
import { isInside, resolveWithinRoot } from "../runtime/app-path.js";
import { defaultImageReference } from "../runtime/build-spec.js";
import { appContainerName, appNetworkName, mapToContainerPath, mapToHostPath } from "./names.js";

export const RUNNER_APP_PORT = 4100;
export const RUNNER_CONTAINER_WORKSPACE_ROOT = "/data/workspace";
export const RUNNER_CONTAINER_AGENTS_ROOT = "/data/agents";
export const DEFAULT_BUILD_NETWORK = "hanse-build";

/** A bind source that is missing, symlinked, or not a real directory. Always fails closed. */
export class MountSourceUnsafeError extends Error {
  readonly status = 409;
  readonly code = "mount_source_unsafe";

  constructor(message: string) {
    super(message);
    this.name = "MountSourceUnsafeError";
  }
}

const MAX_IMAGE_REFERENCE_LENGTH = 255;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Trim and validate an image reference. Returns `undefined` for an empty, oversized, whitespace,
 * control-character, or otherwise malformed reference.
 */
export function normalizeImageReference(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IMAGE_REFERENCE_LENGTH) return undefined;
  if (/\s/.test(trimmed) || hasControlCharacters(trimmed)) return undefined;
  return IMAGE_REFERENCE.test(trimmed) ? trimmed : undefined;
}

function optionalImageReference(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (!(key in env)) return undefined;
  const raw = env[key];
  if (raw === undefined) return undefined;
  const normalized = normalizeImageReference(raw);
  if (normalized === undefined) {
    throw new ConfigError("VALIDATION_FAILED", `${key} must be a valid image reference`);
  }
  return normalized;
}

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

/** Optional environment surface added for the runner isolation phases. */
export interface RunnerEnvironmentConfig {
  /** Absolute host root that replaces workspace/agents as the bind-source root. */
  readonly hostMounts?: string;
  /** Absolute host path of the Docker data root, mounted read-only for disk guards. */
  readonly dockerDataRoot?: string;
  /** Build bridge network; `none` disables build egress. */
  readonly buildNetwork: string;
  /** Optional HTTP(S) proxy injected into image builds. */
  readonly buildProxy?: string;
  /** Exact image references allowed as build `FROM` sources. */
  readonly buildAllowedImages?: ReadonlySet<string>;
  readonly appMemoryMaxMb?: number;
  readonly appCpusMax?: number;
  readonly appPidsMax?: number;
  readonly pullMaxBytes?: number;
  /** Absolute durable directory for bounded build records. */
  readonly buildRecordsDir?: string;
}

export interface RunnerConfig extends RunnerEnvironmentConfig {
  readonly token: string;
  readonly hostWorkspace: string;
  readonly hostAgents: string;
  readonly allowedImages: ReadonlySet<string>;
  /** Configured default agent image, when `HANSE_AGENT_IMAGE` is set. */
  readonly defaultImage?: string;
  /** Configured shared base image, when `HANSE_AGENT_BASE_IMAGE` is set. */
  readonly baseImage?: string;
  readonly coordinatorContainer: string;
  readonly dockerSocket: string;
  readonly dockerApiVersion: string;
  /** Absolute host directory for ephemeral Test-connection credential dirs, mounted at the same path. */
  readonly hostRunnerTmp: string;
}

/** A validated spec with the host/container paths the runner needs to create the container. */
export interface RunnerSpec extends AppRuntimeSpec {
  /**
   * Pinned Docker image ID carried beside the hashed spec (never part of `specHash`).
   *
   * When present the runner verifies the allowlisted reference still resolves to this ID and
   * creates the container from the ID instead of the mutable tag.
   */
  readonly expectedImageId?: string;
  readonly hostAppDir: string;
  readonly hostStateDir: string;
  readonly hostAgentsRoot: string;
  readonly containerAppDir: string;
  readonly containerAgentsRoot: string;
  readonly containerName: string;
  readonly networkName: string;
  readonly port: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new ConfigError("VALIDATION_FAILED", `${key} is required by the runner`);
  }
  return value;
}

function absolute(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const value = env[key]?.trim() ?? fallback;
  if (value === undefined || value.length === 0) {
    throw new ConfigError("VALIDATION_FAILED", `${key} is required by the runner`);
  }
  if (!path.isAbsolute(value)) {
    throw new ConfigError("VALIDATION_FAILED", `${key} must be an absolute host path: ${value}`);
  }
  return path.resolve(value);
}

function optionalTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value.length === 0 ? undefined : value;
}

function optionalAbsolute(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = optionalTrimmed(env, key);
  if (value === undefined) return undefined;
  if (!path.isAbsolute(value)) {
    throw new ConfigError("VALIDATION_FAILED", `${key} must be an absolute host path: ${value}`);
  }
  return path.resolve(value);
}

function optionalPositiveInteger(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = optionalTrimmed(env, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError("VALIDATION_FAILED", `${key} must be a positive integer: ${value}`);
  }
  return parsed;
}

function optionalPositiveNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = optionalTrimmed(env, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError("VALIDATION_FAILED", `${key} must be a positive number: ${value}`);
  }
  return parsed;
}

function parseBuildNetwork(env: NodeJS.ProcessEnv): string {
  const value = optionalTrimmed(env, "HANSE_BUILD_NETWORK") ?? DEFAULT_BUILD_NETWORK;
  if (value === "none") return value;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new ConfigError(
      "VALIDATION_FAILED",
      `HANSE_BUILD_NETWORK must be a Docker network name or "none": ${value}`,
    );
  }
  return value;
}

function parseBuildProxy(env: NodeJS.ProcessEnv): string | undefined {
  const value = optionalTrimmed(env, "HANSE_BUILD_PROXY");
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(
      "VALIDATION_FAILED",
      `HANSE_BUILD_PROXY must be an HTTP(S) URL: ${value}`,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0
  ) {
    throw new ConfigError(
      "VALIDATION_FAILED",
      `HANSE_BUILD_PROXY must be an HTTP(S) URL: ${value}`,
    );
  }
  return value;
}

function parseBuildAllowedImages(env: NodeJS.ProcessEnv): ReadonlySet<string> | undefined {
  const raw = optionalTrimmed(env, "HANSE_BUILD_ALLOWED_IMAGES");
  if (raw === undefined) return undefined;
  const images = raw
    .split(",")
    .map((image) => image.trim())
    .filter((image) => image.length > 0);
  if (images.length === 0) {
    throw new ConfigError("VALIDATION_FAILED", "HANSE_BUILD_ALLOWED_IMAGES is empty");
  }
  const allowed = new Set<string>();
  for (const image of images) {
    const normalized = normalizeImageReference(image);
    if (normalized === undefined) {
      throw new ConfigError(
        "VALIDATION_FAILED",
        `HANSE_BUILD_ALLOWED_IMAGES contains an invalid reference: ${image}`,
      );
    }
    allowed.add(normalized);
  }
  return allowed;
}

/**
 * Parse and validate the optional bind-source root shared by the coordinator and runner.
 *
 * A relative path or a root overlapping the workspace/agents trees would let an app reach its own
 * bind sources, so both fail startup instead of falling back.
 */
export function loadHostMountsRoot(
  env: NodeJS.ProcessEnv = process.env,
  roots: { workspace?: string; agents?: string } = {},
): string | undefined {
  const hostMounts = optionalAbsolute(env, "HANSE_HOST_MOUNTS");
  if (hostMounts === undefined) return undefined;
  for (const [label, root] of [
    ["HANSE_HOST_WORKSPACE", roots.workspace],
    ["HANSE_HOST_AGENTS", roots.agents],
  ] as const) {
    if (root !== undefined && overlaps(hostMounts, root)) {
      throw new ConfigError(
        "VALIDATION_FAILED",
        `HANSE_HOST_MOUNTS must not overlap ${label}: ${hostMounts}`,
      );
    }
  }
  return hostMounts;
}

/**
 * Parse and validate the optional runner-isolation environment without changing behavior when a
 * key is unset. Invalid values fail startup instead of falling back.
 */
export function loadRunnerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  roots: { workspace?: string; agents?: string } = {},
): RunnerEnvironmentConfig {
  const hostMounts = loadHostMountsRoot(env, roots);
  const dockerDataRoot = optionalAbsolute(env, "HANSE_DOCKER_DATA_ROOT");
  const buildProxy = parseBuildProxy(env);
  const buildAllowedImages = parseBuildAllowedImages(env);
  const appMemoryMaxMb = optionalPositiveInteger(env, "HANSE_APP_MEMORY_MAX_MB");
  const appCpusMax = optionalPositiveNumber(env, "HANSE_APP_CPUS_MAX");
  const appPidsMax = optionalPositiveInteger(env, "HANSE_APP_PIDS_MAX");
  const pullMaxBytes = optionalPositiveInteger(env, "HANSE_PULL_MAX_BYTES");
  const buildRecordsDir = optionalAbsolute(env, "HANSE_BUILD_RECORDS_DIR");
  return {
    ...(hostMounts === undefined ? {} : { hostMounts }),
    ...(dockerDataRoot === undefined ? {} : { dockerDataRoot }),
    buildNetwork: parseBuildNetwork(env),
    ...(buildProxy === undefined ? {} : { buildProxy }),
    ...(buildAllowedImages === undefined ? {} : { buildAllowedImages }),
    ...(appMemoryMaxMb === undefined ? {} : { appMemoryMaxMb }),
    ...(appCpusMax === undefined ? {} : { appCpusMax }),
    ...(appPidsMax === undefined ? {} : { appPidsMax }),
    ...(pullMaxBytes === undefined ? {} : { pullMaxBytes }),
    ...(buildRecordsDir === undefined ? {} : { buildRecordsDir }),
  };
}

function parseAllowedImages(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env.HANSE_ALLOWED_AGENT_IMAGES?.trim() || env.HANSE_AGENT_IMAGE?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new ConfigError(
      "VALIDATION_FAILED",
      "HANSE_ALLOWED_AGENT_IMAGES or HANSE_AGENT_IMAGE is required by the runner",
    );
  }
  const images = raw
    .split(",")
    .map((image) => image.trim())
    .filter((image) => image.length > 0);
  if (images.length === 0) {
    throw new ConfigError("VALIDATION_FAILED", "runner image allowlist is empty");
  }
  return new Set(images);
}

/** Load and validate the runner process configuration. Missing or relative paths fail closed. */
export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const token = required(env, "HANSE_RUNTIME_TOKEN");
  const coordinatorContainer = env.HANSE_COORDINATOR_CONTAINER?.trim() || "hanse";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(coordinatorContainer)) {
    throw new ConfigError(
      "VALIDATION_FAILED",
      `HANSE_COORDINATOR_CONTAINER is not a valid Docker name: ${coordinatorContainer}`,
    );
  }
  const dockerApiVersion = env.HANSE_DOCKER_API_VERSION?.trim() || "v1.41";
  if (!/^v\d+\.\d+$/.test(dockerApiVersion)) {
    throw new ConfigError(
      "VALIDATION_FAILED",
      `HANSE_DOCKER_API_VERSION must look like v1.41: ${dockerApiVersion}`,
    );
  }
  const hostWorkspace = absolute(env, "HANSE_HOST_WORKSPACE");
  const hostAgents = absolute(env, "HANSE_HOST_AGENTS");
  const hostRunnerTmp = absolute(env, "HANSE_HOST_RUNNER_TMP", "/var/lib/hanse/tmp");
  for (const [label, root] of [
    ["HANSE_HOST_WORKSPACE", hostWorkspace],
    ["HANSE_HOST_AGENTS", hostAgents],
  ] as const) {
    if (overlaps(hostRunnerTmp, root)) {
      throw new ConfigError(
        "VALIDATION_FAILED",
        `HANSE_HOST_RUNNER_TMP must not overlap ${label}: ${hostRunnerTmp}`,
      );
    }
  }
  const environment = loadRunnerEnvironment(env, {
    workspace: hostWorkspace,
    agents: hostAgents,
  });
  const configuredDefaultImage = env.HANSE_AGENT_IMAGE?.trim();
  const baseImage = optionalImageReference(env, "HANSE_AGENT_BASE_IMAGE");
  const allowedImages = new Set(parseAllowedImages(env));
  if (baseImage !== undefined) {
    allowedImages.add(baseImage);
  }
  return {
    ...environment,
    token,
    hostWorkspace,
    hostAgents,
    allowedImages,
    ...(configuredDefaultImage === undefined || configuredDefaultImage.length === 0
      ? {}
      : { defaultImage: defaultImageReference(env) }),
    ...(baseImage === undefined ? {} : { baseImage }),
    coordinatorContainer,
    dockerSocket: absolute(env, "HANSE_DOCKER_SOCKET", "/var/run/docker.sock"),
    dockerApiVersion,
    hostRunnerTmp,
  };
}

function overlaps(left: string, right: string): boolean {
  return isInside(left, right) || isInside(right, left);
}

function invalid(message: string): ConfigError {
  return new ConfigError("VALIDATION_FAILED", message);
}

function parseExpectedImageId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !IMAGE_ID.test(value)) {
    throw invalid("expectedImageId must be sha256:<64 lowercase hex>");
  }
  return value;
}

function resolveHostMountsAppDir(hostMounts: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw invalid("hostMountsAppDir must be a non-empty absolute path");
  }
  const literal = path.resolve(raw);
  let resolved: string;
  try {
    resolved = resolveWithinRoot({
      target: literal,
      root: hostMounts,
      label: "hostMountsAppDir",
    });
  } catch {
    throw new MountSourceUnsafeError("hostMountsAppDir escapes HANSE_HOST_MOUNTS");
  }
  const info = lstatSync(literal, { throwIfNoEntry: false });
  if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) {
    throw new MountSourceUnsafeError("hostMountsAppDir is missing or not a real directory");
  }
  const relative = path.relative(hostMounts, resolved);
  if (relative.length === 0 || relative.split(path.sep).length !== 2) {
    throw new MountSourceUnsafeError("hostMountsAppDir must be <mounts>/<project>/<app>");
  }
  return resolved;
}

/**
 * Validate an untrusted runtime spec for the per-app runner.
 *
 * The coordinator sends host paths in B1. The runner derives the fixed network/container names and
 * the fixed container paths; it never accepts a caller-selected mount root, network, or port.
 */
export function validateRunnerSpec(
  value: unknown,
  config: RunnerConfig,
  extraAllowedImages?: ReadonlySet<string>,
): RunnerSpec {
  const spec = validateAppRuntimeSpec(value, {
    workspaceRoot: config.hostWorkspace,
    agentsRoot: config.hostAgents,
  });
  const expectedImageId = parseExpectedImageId(
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).expectedImageId
      : undefined,
  );
  if (spec.pathMode !== "host") {
    throw invalid("runner requires pathMode: host");
  }
  if (
    !config.allowedImages.has(spec.image) &&
    spec.image !== config.defaultImage &&
    extraAllowedImages?.has(spec.image) !== true
  ) {
    throw invalid(`image is not allowed by the runner: ${spec.image}`);
  }
  if (spec.port !== RUNNER_APP_PORT) {
    throw invalid(`runner requires port ${RUNNER_APP_PORT}`);
  }
  const expectedNetwork = appNetworkName(spec.appId);
  if (spec.networkName !== expectedNetwork) {
    throw invalid(`networkName must be ${expectedNetwork}`);
  }

  const hostAppDir = resolveWithinRoot({
    target: spec.appDir,
    root: config.hostWorkspace,
    label: "appDir",
  });
  const hostStateDir = resolveWithinRoot({
    target: spec.stateDir,
    root: config.hostAgents,
    label: "stateDir",
  });
  if (path.basename(hostStateDir) !== "state") {
    throw invalid(`stateDir must be the application's "state" directory: ${hostStateDir}`);
  }
  const hostAgentsRoot = path.dirname(hostStateDir);
  if (!isInside(config.hostAgents, hostAgentsRoot)) {
    throw invalid(`application agents root escapes HANSE_HOST_AGENTS: ${hostAgentsRoot}`);
  }
  const relativeAgents = path.relative(config.hostAgents, hostAgentsRoot);
  if (relativeAgents.length === 0 || relativeAgents.split(path.sep).length < 2) {
    throw invalid(`application agents root must be <project>/<app>: ${hostAgentsRoot}`);
  }

  const rawHostMountsAppDir =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).hostMountsAppDir
      : undefined;
  let hostMountsAppDir: string | undefined;
  if (rawHostMountsAppDir !== undefined) {
    if (config.hostMounts === undefined) {
      throw new MountSourceUnsafeError("hostMountsAppDir requires HANSE_HOST_MOUNTS");
    }
    hostMountsAppDir = resolveHostMountsAppDir(config.hostMounts, rawHostMountsAppDir);
  }
  if (spec.attachmentsReadOnly === true && hostMountsAppDir === undefined) {
    throw new MountSourceUnsafeError("hostMountsAppDir is required for the attachments bind");
  }

  const containerAppDir = mapToContainerPath(
    config.hostWorkspace,
    hostAppDir,
    RUNNER_CONTAINER_WORKSPACE_ROOT,
    "appDir",
  );
  const containerAgentsRoot = mapToContainerPath(
    config.hostAgents,
    hostAgentsRoot,
    RUNNER_CONTAINER_AGENTS_ROOT,
    "agentsRoot",
  );

  for (const [key, value] of Object.entries(spec.env)) {
    if (!ENV_PATH_KEYS.has(key)) continue;
    if (!isInside(containerAgentsRoot, value) && !isInside(containerAppDir, value)) {
      throw invalid(`${key} must stay inside the application's container mounts: ${value}`);
    }
  }
  const sshCommand = spec.env.GIT_SSH_COMMAND;
  if (sshCommand !== undefined) {
    const sshPath = parseGitSshCommand(sshCommand);
    if (!isInside(containerAgentsRoot, sshPath) && !isInside(containerAppDir, sshPath)) {
      throw invalid(`GIT_SSH_COMMAND must stay inside the application's container mounts`);
    }
  }

  return {
    ...spec,
    ...(expectedImageId === undefined ? {} : { expectedImageId }),
    ...(hostMountsAppDir === undefined ? {} : { hostMountsAppDir }),
    pathMode: "host",
    port: RUNNER_APP_PORT,
    hostAppDir,
    hostStateDir,
    hostAgentsRoot,
    containerAppDir,
    containerAgentsRoot,
    containerName: appContainerName(spec.appId),
    networkName: expectedNetwork,
  };
}

/** Map an env path from the app container back to the host path the runner must read. */
export function hostPathForSpecEnv(spec: RunnerSpec, key: string): string | undefined {
  const value = spec.env[key];
  if (value === undefined) return undefined;
  if (!ENV_PATH_KEYS.has(key)) {
    throw invalid(`${key} is not a path environment key`);
  }
  if (isInside(spec.containerAgentsRoot, value)) {
    return mapToHostPath(spec.containerAgentsRoot, value, spec.hostAgentsRoot, key);
  }
  if (isInside(spec.containerAppDir, value)) {
    return mapToHostPath(spec.containerAppDir, value, spec.hostAppDir, key);
  }
  throw invalid(`${key} is outside the application's mounts: ${value}`);
}
