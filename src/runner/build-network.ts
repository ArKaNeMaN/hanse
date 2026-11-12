import type { DockerNetworkInspect, DockerNetworkSpec } from "./docker.js";

/** Label marking a Docker resource owned by the runner. */
export const BUILD_NETWORK_MANAGED_LABEL = "hanse.managed";
/** Label distinguishing the dedicated build network from app networks. */
export const BUILD_NETWORK_ROLE_LABEL = "hanse.role";
/** Role value for the dedicated build network. */
export const BUILD_NETWORK_ROLE = "build";

export class BuildNetworkError extends Error {
  readonly code = "build_network_unavailable";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BuildNetworkError";
  }
}

/** Docker surface needed to create and verify the dedicated build network. */
export interface BuildNetworkRuntime {
  ensureNetwork(spec: DockerNetworkSpec): Promise<void>;
  inspectNetwork?(name: string): Promise<DockerNetworkInspect | undefined>;
}

export function buildNetworkLabels(): Record<string, string> {
  return {
    [BUILD_NETWORK_MANAGED_LABEL]: "true",
    [BUILD_NETWORK_ROLE_LABEL]: BUILD_NETWORK_ROLE,
  };
}

/**
 * Ensure the configured build network exists and belongs to the runner.
 *
 * `none` needs no Docker resource. A network that already exists with missing or foreign labels is
 * rejected instead of reused, so an app network can never carry build egress.
 */
export async function ensureBuildNetwork(
  name: string,
  runtime: BuildNetworkRuntime,
): Promise<void> {
  if (name === "none") return;
  const inspect = runtime.inspectNetwork?.bind(runtime);
  const existing = await inspectOrThrow(inspect, name);
  if (existing !== undefined) {
    assertBuildNetwork(name, existing);
    return;
  }

  try {
    await runtime.ensureNetwork({ name, labels: buildNetworkLabels() });
  } catch (error) {
    throw new BuildNetworkError(`cannot create build network ${name}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (inspect === undefined) return;
  const created = await inspectOrThrow(inspect, name);
  if (created === undefined) {
    throw new BuildNetworkError(`build network ${name} is missing after creation`);
  }
  assertBuildNetwork(name, created);
}

async function inspectOrThrow(
  inspect: ((name: string) => Promise<DockerNetworkInspect | undefined>) | undefined,
  name: string,
): Promise<DockerNetworkInspect | undefined> {
  if (inspect === undefined) return undefined;
  try {
    return await inspect(name);
  } catch (error) {
    throw new BuildNetworkError(`cannot inspect build network ${name}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function assertBuildNetwork(name: string, inspected: DockerNetworkInspect): void {
  const labels = inspected.Labels ?? {};
  if (
    labels[BUILD_NETWORK_MANAGED_LABEL] !== "true" ||
    labels[BUILD_NETWORK_ROLE_LABEL] !== BUILD_NETWORK_ROLE
  ) {
    throw new BuildNetworkError(
      `network ${name} exists without the expected ${BUILD_NETWORK_MANAGED_LABEL}=true and ${BUILD_NETWORK_ROLE_LABEL}=${BUILD_NETWORK_ROLE} labels`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
