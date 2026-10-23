import path from "node:path";

/** Reserved project id for the built-in Hanse master agent. */
export const MASTER_PROJECT_ID = "hanse-master";
/** Reserved application key for the master agent inside {@link MASTER_PROJECT_ID}. */
export const MASTER_APP_KEY = "master";
/** Stable application id of the master agent. */
export const MASTER_APP_ID = `${MASTER_PROJECT_ID}:${MASTER_APP_KEY}`;
/** Display name of the reserved project. */
export const MASTER_PROJECT_NAME = "Hanse master";
/** Workspace-level directory owned by the master agent. */
export const MASTER_DIR_NAME = ".hanse-master";

/** Absolute master application directory for a workspace root. */
export function masterAppDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, MASTER_DIR_NAME);
}

/** True when the id names the reserved master project. */
export function isMasterProject(projectId: string): boolean {
  return projectId === MASTER_PROJECT_ID;
}

/** True when the pair names the reserved master application. */
export function isMasterApp(projectId: string, appKey: string): boolean {
  return projectId === MASTER_PROJECT_ID && appKey === MASTER_APP_KEY;
}

/** True when the id names the reserved master application. */
export function isMasterAppId(appId: string): boolean {
  return appId === MASTER_APP_ID;
}

/** Chat workspace URL for the master agent. */
export function masterChatHref(): string {
  return `/chat?app=${encodeURIComponent(MASTER_APP_KEY)}&project=${encodeURIComponent(MASTER_PROJECT_ID)}`;
}
