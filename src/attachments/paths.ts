import path from "node:path";
import { DEFAULT_AGENT_AGENTS_ROOT } from "../agent/spec.js";
import { isSessionId } from "../chat/state.js";
import { sanitizeAppKey } from "../opencode/instance.js";
import { isInside, resolveWithinRoot } from "../runtime/app-path.js";

/** Host-side app root under the agents volume. */
export function appStateRoot(agentsHome: string, projectId: string, appKey: string): string {
  return path.join(agentsHome, sanitizeAppKey(projectId), sanitizeAppKey(appKey));
}

/** Host attachments root: `<appRoot>/attachments`. */
export function attachmentsHostRoot(agentsHome: string, projectId: string, appKey: string): string {
  return path.join(appStateRoot(agentsHome, projectId, appKey), "attachments");
}

export type AttachmentPathMode = "host" | "container";

/**
 * The one model-visible attachments root used by the manifest and the permission policy.
 *
 * Runner mode maps the per-app agents directory to the fixed container root; supervisor mode shares
 * the host filesystem with the agent process, so the host root is model-visible.
 */
export function attachmentVisibleRoot(input: {
  agentsHome: string;
  projectId: string;
  appKey: string;
  pathMode: AttachmentPathMode;
}): string {
  const suffix = path.join("attachments");
  if (input.pathMode === "host") {
    return path.posix.join(
      DEFAULT_AGENT_AGENTS_ROOT,
      sanitizeAppKey(input.projectId),
      sanitizeAppKey(input.appKey),
      suffix,
    );
  }
  return path.join(
    input.agentsHome,
    sanitizeAppKey(input.projectId),
    sanitizeAppKey(input.appKey),
    suffix,
  );
}

/** Raw on-disk path for a stored rel_path; rejects absolute/parent segments and containment escapes. */
export function attachmentReadPath(appRoot: string, relPath: string): string | undefined {
  const relative = relPath.replaceAll("\\", "/");
  if (relative.length === 0 || path.isAbsolute(relative) || relative.split("/").includes("..")) {
    return undefined;
  }
  const attachmentsRoot = path.join(appRoot, "attachments");
  const file = path.join(appRoot, relative);
  return isInside(attachmentsRoot, file) ? file : undefined;
}

/** Resolve the session folder without ever letting a caller-provided id become a path segment. */
export function sessionAttachmentsDir(appRoot: string, sessionId: string): string | undefined {
  if (!isSessionId(sessionId)) return undefined;
  try {
    return resolveWithinRoot({
      target: path.join(appRoot, "attachments", sessionId),
      root: path.join(appRoot, "attachments"),
      label: "attachment session folder",
    });
  } catch {
    return undefined;
  }
}

export function attachmentFilePath(appRoot: string, relPath: string): string | undefined {
  try {
    return resolveWithinRoot({
      target: path.join(appRoot, relPath),
      root: appRoot,
      label: "attachment file",
    });
  } catch {
    return undefined;
  }
}

/** Forward-slash relative path stored in `app_attachments.rel_path`. */
export function attachmentRelPath(sessionId: string, storedName: string): string {
  return path.posix.join("attachments", sessionId, storedName);
}

/** Forward-slash relative temp path stored in `app_attachments.temp_rel_path`. */
export function attachmentTempRelPath(sessionId: string, id: string): string {
  return path.posix.join("attachments", sessionId, ".tmp", `${id}.part`);
}
