import path from "node:path";
import { type AppRuntimeSpec, parseGitSshCommand, validateAppRuntimeSpec } from "../agent/spec.js";
import { ConfigError } from "../config/load.js";
import { isInside, resolveWithinRoot } from "../runtime/app-path.js";
import { defaultImageReference } from "../runtime/build-spec.js";
import { appContainerName, appNetworkName, mapToContainerPath, mapToHostPath } from "./names.js";

export const RUNNER_APP_PORT = 4100;
export const RUNNER_CONTAINER_WORKSPACE_ROOT = "/data/workspace";
export const RUNNER_CONTAINER_AGENTS_ROOT = "/data/agents";

const MAX_IMAGE_REFERENCE_LENGTH = 255;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/;

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

export interface RunnerConfig {
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
  const configuredDefaultImage = env.HANSE_AGENT_IMAGE?.trim();
  const baseImage = optionalImageReference(env, "HANSE_AGENT_BASE_IMAGE");
  const allowedImages = new Set(parseAllowedImages(env));
  if (baseImage !== undefined) {
    allowedImages.add(baseImage);
  }
  return {
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
