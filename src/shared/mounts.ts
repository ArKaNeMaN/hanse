import path from "node:path";
import { sanitizeAppKey } from "../opencode/instance.js";

/** App-writable attachment leaf name under the mounts root. */
export const MOUNTS_ATTACHMENTS_DIR = "attachments";
/** Managed git credential leaf name under the mounts root. */
export const MOUNTS_GIT_DIR = "git";

/**
 * Coordinator-owned bind-source root for one application: `<mounts>/<project>/<app>`.
 *
 * The mounts root is mounted read-write into the coordinator and read-only into the runner; app
 * containers only ever see read-only leaves. Reuse `sanitizeAppKey` so the layout matches the
 * agents-root segments and cannot introduce a second path-traversal surface.
 */
export function mountsAppRoot(mountsRoot: string, projectId: string, appKey: string): string {
  return path.join(mountsRoot, sanitizeAppKey(projectId), sanitizeAppKey(appKey));
}

/** `<mounts>/<project>/<app>/attachments`. */
export function mountsAttachmentsDir(
  mountsRoot: string,
  projectId: string,
  appKey: string,
): string {
  return path.join(mountsAppRoot(mountsRoot, projectId, appKey), MOUNTS_ATTACHMENTS_DIR);
}

/** `<mounts>/<project>/<app>/git`. */
export function mountsGitDir(mountsRoot: string, projectId: string, appKey: string): string {
  return path.join(mountsAppRoot(mountsRoot, projectId, appKey), MOUNTS_GIT_DIR);
}
