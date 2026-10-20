import { createHash } from "node:crypto";
import path from "node:path";

const MAX_NAME = 63;

function slug(value: string): string {
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

/** Docker network name for one application. */
export function appNetworkName(appId: string): string {
  return `hanse-app-${slug(appId)}`;
}

/** Docker container name for one application. */
export function appContainerName(appId: string): string {
  return `hanse-app-${slug(appId)}`;
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
