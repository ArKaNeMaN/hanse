import { rmSync } from "node:fs";
import path from "node:path";
import type { SqliteDatabase } from "../store/index.js";
import { attachmentFilePath } from "./paths.js";
import { deleteAttachmentRowById, markAttachmentAvailable, writeUploadMetadata } from "./store.js";
import type { AttachmentKind } from "./types.js";

/** The subset of `app_attachments` a commit/reconcile needs. */
export interface CommitRow {
  id: string;
  appId: string;
  sessionId: string;
  storedName: string | null;
  relPath: string | null;
  tempRelPath: string | null;
  mime: string | null;
  size: number | null;
  kind: AttachmentKind | null;
}

export function finalPathFor(appRoot: string, row: CommitRow): string | undefined {
  if (row.relPath === null) return undefined;
  return attachmentFilePath(appRoot, row.relPath);
}

export function tempPathFor(appRoot: string, row: CommitRow): string | undefined {
  if (row.tempRelPath === null) return undefined;
  return attachmentFilePath(appRoot, row.tempRelPath);
}

export function writeCommitMetadata(
  db: SqliteDatabase,
  input: {
    id: string;
    storedName: string;
    relPath: string;
    mime: string;
    size: number;
    kind: AttachmentKind;
    now: string;
  },
): void {
  writeUploadMetadata(db, input);
}

export function completeUpload(db: SqliteDatabase, id: string, now: string): void {
  markAttachmentAvailable(db, id, now);
}

export function discardUpload(db: SqliteDatabase, row: CommitRow, appRoot: string): void {
  for (const file of [tempPathFor(appRoot, row), finalPathFor(appRoot, row)]) {
    if (file === undefined) continue;
    try {
      rmSync(file, { force: true });
    } catch {
      // The orphan pass repairs leftovers.
    }
  }
  deleteAttachmentRowById(db, row.id);
}

export function finalDirFor(appRoot: string, row: CommitRow): string {
  const final = finalPathFor(appRoot, row);
  return final === undefined ? path.join(appRoot, "attachments") : path.dirname(final);
}
