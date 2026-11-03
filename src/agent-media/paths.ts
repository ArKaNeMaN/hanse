import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { isInside } from "../runtime/app-path.js";
import type { AgentMediaRow } from "./types.js";

function ensureSafeDirectory(directory: string): void {
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("agent media directory is not safe");
    }
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created = lstatSync(directory, { throwIfNoEntry: false });
  if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error("agent media directory is not safe");
  }
}

export function agentMediaRoot(appRoot: string): string {
  return path.join(appRoot, "agent-media");
}

export function agentMediaTempDir(appRoot: string): string {
  return path.join(agentMediaRoot(appRoot), ".tmp");
}

export function agentMediaRelPath(storedName: string): string {
  return path.posix.join("agent-media", storedName);
}

export function agentMediaTempPath(appRoot: string, id: string): string {
  return path.join(agentMediaTempDir(appRoot), `${id}.part`);
}

export function agentMediaFinalPath(appRoot: string, storedName: string): string {
  return path.join(agentMediaRoot(appRoot), storedName);
}

export function ensureAgentMediaRoot(appRoot: string): void {
  ensureSafeDirectory(agentMediaRoot(appRoot));
  ensureSafeDirectory(agentMediaTempDir(appRoot));
}

export function revalidateAgentMediaRoot(appRoot: string): void {
  const root = agentMediaRoot(appRoot);
  const temp = agentMediaTempDir(appRoot);
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  const tempStat = lstatSync(temp, { throwIfNoEntry: false });
  if (
    rootStat === undefined ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    tempStat === undefined ||
    tempStat.isSymbolicLink() ||
    !tempStat.isDirectory()
  ) {
    throw new Error("agent media directory is not safe");
  }
  if (!isInside(realpathSync(appRoot), realpathSync(root))) {
    throw new Error("agent media directory escaped the app root");
  }
}

export interface OpenedAgentSource {
  fd: number;
  size: number;
}

/** Open a model-supplied source file and verify its identity in one lstat/open/fstat sequence. */
export function openAgentMediaSource(sourcePath: string): OpenedAgentSource | undefined {
  const before = lstatSync(sourcePath, { throwIfNoEntry: false });
  if (before === undefined || before.isSymbolicLink() || !before.isFile()) return undefined;
  let fd: number;
  try {
    fd = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      closeSync(fd);
      return undefined;
    }
    return { fd, size: after.size };
  } catch {
    closeSync(fd);
    return undefined;
  }
}

export function openAgentMediaFile(
  appRoot: string,
  row: Pick<AgentMediaRow, "relPath" | "size">,
): OpenedAgentSource | undefined {
  const root = agentMediaRoot(appRoot);
  const file = path.resolve(appRoot, row.relPath);
  if (!isInside(root, file)) return undefined;
  const parent = path.dirname(file);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    return undefined;
  }
  if (realParent !== parent || !statSync(realParent).isDirectory() || !isInside(root, realParent)) {
    return undefined;
  }
  const before = lstatSync(file, { throwIfNoEntry: false });
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size !== row.size
  ) {
    return undefined;
  }
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== row.size
    ) {
      closeSync(fd);
      return undefined;
    }
    return { fd, size: after.size };
  } catch {
    closeSync(fd);
    return undefined;
  }
}

export function renameAgentMedia(tempPath: string, finalPath: string): void {
  const finalDir = path.dirname(finalPath);
  ensureSafeDirectory(finalDir);
  revalidateAgentMediaRoot(path.dirname(finalDir));
  renameSync(tempPath, finalPath);
}
