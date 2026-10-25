import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { isInside } from "../runtime/app-path.js";
import { attachmentReadPath } from "./paths.js";
import type { AttachmentRow } from "./types.js";

export class AttachmentStorageError extends Error {
  readonly code: "invalid_session" | "storage_full";
  constructor(code: "invalid_session" | "storage_full", message: string) {
    super(message);
    this.name = "AttachmentStorageError";
    this.code = code;
  }
}

function ensureDirectory(directory: string): void {
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new AttachmentStorageError("invalid_session", "attachment session folder is not safe");
    }
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const created = lstatSync(directory, { throwIfNoEntry: false });
  if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) {
    throw new AttachmentStorageError("invalid_session", "attachment session folder is not safe");
  }
}

/** Create `<appRoot>/attachments/<session>/.tmp` without following a planted symlink. */
export function ensureSessionFolder(appRoot: string, sessionId: string): string {
  const attachmentsRoot = path.join(appRoot, "attachments");
  const sessionDir = path.join(attachmentsRoot, sessionId);
  ensureDirectory(attachmentsRoot);
  ensureDirectory(sessionDir);
  ensureDirectory(path.join(sessionDir, ".tmp"));
  if (!isInside(appRoot, sessionDir)) {
    throw new AttachmentStorageError("invalid_session", "attachment folder escaped the app root");
  }
  return sessionDir;
}

export function removeFileQuiet(file: string | undefined): void {
  if (file === undefined) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort; the daily orphan pass repairs leftovers.
  }
}

export function fsyncPath(file: string): void {
  const fd = openSync(file, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDirectory(directory: string): void {
  try {
    const fd = openSync(directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort on filesystems that reject it.
  }
}

export function moveIntoPlace(tempPath: string, finalPath: string, finalDir: string): void {
  ensureDirectory(finalDir);
  fsyncPath(tempPath);
  renameSync(tempPath, finalPath);
  fsyncDirectory(finalDir);
}

export interface OpenedAttachment {
  fd: number;
  size: number;
}

/**
 * Open a stored attachment for download with `O_NOFOLLOW`, prove the parent is a real directory
 * inside the app root, and verify the stored size.
 */
export function openAttachmentFile(
  appRoot: string,
  row: AttachmentRow,
): OpenedAttachment | undefined {
  if (row.relPath === null || row.size === null) return undefined;
  const file = attachmentReadPath(appRoot, row.relPath);
  if (file === undefined) return undefined;
  const attachmentsRoot = path.join(appRoot, "attachments");
  const parent = path.dirname(file);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    return undefined;
  }
  if (
    realParent !== parent ||
    !statSync(realParent).isDirectory() ||
    !isInside(attachmentsRoot, realParent)
  ) {
    return undefined;
  }
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info === undefined || info.isSymbolicLink() || !info.isFile() || info.size !== row.size) {
    return undefined;
  }
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== row.size) {
      closeSync(fd);
      return undefined;
    }
    return { fd, size: stat.size };
  } catch {
    closeSync(fd);
    return undefined;
  }
}
