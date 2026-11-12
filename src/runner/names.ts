import { createHash } from "node:crypto";
import path from "node:path";

const MAX_NAME = 63;
const NAME_PREFIX = "hanse-app-";
const HASH_LENGTH = 12;
const PREFIX_MAX = MAX_NAME - NAME_PREFIX.length - HASH_LENGTH - 1;

function prefixFor(appId: string): string {
  const normalized = appId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  const prefix = normalized.length === 0 ? "app" : normalized.slice(0, PREFIX_MAX);
  return prefix.replace(/[^a-z0-9]+$/, "") || "app";
}

/**
 * Docker resource name derived from the exact, case-sensitive app id.
 *
 * The readable prefix is lowercased for Docker's name grammar; the hash preserves the exact id so
 * `web` and `Web` (or any ids that sanitize identically) never share a container or network.
 */
function exactAppName(appId: string): string {
  const hash = createHash("sha256").update(appId).digest("hex").slice(0, HASH_LENGTH);
  return `${NAME_PREFIX}${prefixFor(appId)}-${hash}`;
}

/** Docker network name for one application. */
export function appNetworkName(appId: string): string {
  return exactAppName(appId);
}

/** Docker container name for one application. */
export function appContainerName(appId: string): string {
  return exactAppName(appId);
}

function legacySlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (normalized.length === 0) {
    return "app";
  }
  if (normalized.length <= MAX_NAME) {
    return normalized;
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${normalized.slice(0, MAX_NAME - hash.length - 1)}-${hash}`;
}

/**
 * Pre-v2 name used by earlier releases. It exists only to find and clean up old containers and
 * networks; never use it to create resources.
 */
export function legacyAppContainerName(appId: string): string {
  return `${NAME_PREFIX}${legacySlug(appId)}`;
}

/** Pre-v2 network name; containers and networks shared the same derived name. */
export function legacyAppNetworkName(appId: string): string {
  return legacyAppContainerName(appId);
}

/** Map an absolute path under a host root to its fixed container path. */
export function mapToContainerPath(
  hostRoot: string,
  hostPath: string,
  containerRoot: string,
  label: string,
): string {
  const relative = path.relative(hostRoot, hostPath);
  if (relative.length === 0 || path.isAbsolute(relative) || relative.startsWith("..")) {
    throw new Error(`${label} is not inside ${hostRoot}: ${hostPath}`);
  }
  return path.posix.join(containerRoot, ...relative.split(path.sep));
}

/** Map a container path under a container root back to its host path. */
export function mapToHostPath(
  containerRoot: string,
  containerPath: string,
  hostRoot: string,
  label: string,
): string {
  const relative = path.posix.relative(containerRoot, containerPath);
  if (relative.length === 0 || relative.startsWith("..") || path.posix.isAbsolute(relative)) {
    throw new Error(`${label} is not inside ${containerRoot}: ${containerPath}`);
  }
  return path.join(hostRoot, ...relative.split("/"));
}
