import { lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { isInside } from "../runtime/app-path.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  type CommitRow,
  completeUpload,
  discardUpload,
  finalPathFor,
  tempPathFor,
} from "./commit.js";
import { attachmentsHostRoot } from "./paths.js";
import { moveIntoPlace } from "./storage.js";
import {
  deleteAttachmentRowById,
  listAllAttachments,
  listUploadingAttachments,
  markAttachmentMissing,
} from "./store.js";
import {
  type AttachmentRow,
  FILE_ORPHAN_AGE_MS,
  TEMP_ORPHAN_AGE_MS,
  UPLOAD_RECONCILE_AGE_MS,
} from "./types.js";

export interface AppAttachmentRoot {
  appId: string;
  projectId: string;
  appKey: string;
  appRoot: string;
}

export function listAppAttachmentRoots(
  db: SqliteDatabase,
  agentsHome: string,
): AppAttachmentRoot[] {
  const rows = db
    .prepare("SELECT id AS appId, project_id AS projectId, app_key AS appKey FROM apps")
    .all() as Array<{ appId: string; projectId: string; appKey: string }>;
  return rows.map((row) => ({
    ...row,
    appRoot: path.dirname(attachmentsHostRoot(agentsHome, row.projectId, row.appKey)),
  }));
}

function statSize(file: string): number | undefined {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    return stat?.isFile() === true && !stat.isSymbolicLink() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function commitComplete(row: AttachmentRow): row is AttachmentRow & {
  storedName: string;
  relPath: string;
  mime: string;
  size: number;
  kind: NonNullable<AttachmentRow["kind"]>;
} {
  return (
    row.storedName !== null &&
    row.relPath !== null &&
    row.mime !== null &&
    row.size !== null &&
    row.kind !== null
  );
}

/**
 * Settle `uploading` rows. Only a final file with complete matching metadata or a complete
 * commit-window temp is promoted; everything else is discarded with its files.
 */
export function reconcileUploading(
  db: SqliteDatabase,
  appRootFor: (appId: string) => string | undefined,
  options: { olderThanMs?: number; activeIds?: ReadonlySet<string>; now?: number } = {},
): number {
  const now = options.now ?? Date.now();
  const cutoff =
    options.olderThanMs === undefined
      ? undefined
      : new Date(now - options.olderThanMs).toISOString();
  let changed = 0;
  for (const row of listUploadingAttachments(db, cutoff)) {
    if (options.activeIds?.has(row.id) === true) continue;
    const appRoot = appRootFor(row.appId);
    if (appRoot === undefined) {
      // No app row (cascade edge); remove the orphan row rather than keeping a reservation forever.
      deleteAttachmentRowById(db, row.id);
      changed += 1;
      continue;
    }
    const iso = new Date(now).toISOString();
    const final = finalPathFor(appRoot, row);
    const temp = tempPathFor(appRoot, row);
    if (final !== undefined && commitComplete(row) && statSize(final) === row.size) {
      completeUpload(db, row.id, iso);
      changed += 1;
      continue;
    }
    if (temp !== undefined && commitComplete(row) && statSize(temp) === row.size) {
      try {
        moveIntoPlace(
          temp,
          finalPathFor(appRoot, row) as string,
          path.dirname(finalPathFor(appRoot, row) as string),
        );
        completeUpload(db, row.id, iso);
        changed += 1;
        continue;
      } catch {
        // Fall through to discard; the row cannot be completed safely.
      }
    }
    discardUpload(db, row as CommitRow, appRoot);
    changed += 1;
  }
  return changed;
}

/** Mark available rows whose file vanished. Missing rows are excluded from quota and prompts. */
export function markMissingFiles(
  db: SqliteDatabase,
  roots: AppAttachmentRoot[],
  options: { now?: number } = {},
): number {
  const iso = new Date(options.now ?? Date.now()).toISOString();
  let changed = 0;
  const rootById = new Map(roots.map((root) => [root.appId, root.appRoot]));
  for (const row of listAllAttachments(db)) {
    if (row.state !== "available") continue;
    const appRoot = rootById.get(row.appId);
    if (appRoot === undefined) continue;
    const final = row.relPath === null ? undefined : finalPathFor(appRoot, row);
    if (final === undefined || statSize(final) !== row.size) {
      markAttachmentMissing(db, row.id, iso);
      changed += 1;
    }
  }
  return changed;
}

function walkFiles(directory: string, output: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walkFiles(full, output);
    else if (stat.isFile()) output.push(full);
  }
}

/** Remove unreferenced temp files older than an hour and orphan files older than a day. */
export function sweepOrphanFiles(
  db: SqliteDatabase,
  roots: AppAttachmentRoot[],
  options: { now?: number; activeIds?: ReadonlySet<string> } = {},
): number {
  const now = options.now ?? Date.now();
  const rows = listAllAttachments(db);
  const referenced = new Set<string>();
  for (const row of rows) {
    if (row.relPath !== null) referenced.add(path.normalize(row.relPath));
    if (row.tempRelPath !== null) referenced.add(path.normalize(row.tempRelPath));
  }
  let removed = 0;
  for (const root of roots) {
    const attachmentsDir = path.join(root.appRoot, "attachments");
    const directory = lstatSync(attachmentsDir, { throwIfNoEntry: false });
    if (directory === undefined || directory.isSymbolicLink() || !directory.isDirectory()) continue;
    let realRoot: string;
    let realAttachments: string;
    try {
      realRoot = realpathSync(root.appRoot);
      realAttachments = realpathSync(attachmentsDir);
    } catch {
      continue;
    }
    if (!isInside(realRoot, realAttachments)) continue;
    const files: string[] = [];
    walkFiles(attachmentsDir, files);
    for (const file of files) {
      if (options.activeIds?.has(path.basename(file).replace(/\.part$/, "")) === true) continue;
      const relative = path.relative(root.appRoot, file);
      if (referenced.has(path.normalize(relative))) continue;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      const inTemp = relative.split(path.sep).includes(".tmp");
      const age = now - stat.mtimeMs;
      if ((inTemp && age > TEMP_ORPHAN_AGE_MS) || (!inTemp && age > FILE_ORPHAN_AGE_MS)) {
        try {
          rmSync(file, { force: true });
          removed += 1;
        } catch {
          // Retry next pass.
        }
      }
    }
  }
  return removed;
}

export interface AttachmentMaintenanceResult {
  reconciled: number;
  missing: number;
  orphans: number;
}

export function runAttachmentMaintenance(
  db: SqliteDatabase,
  agentsHome: string | undefined,
  options: { now?: number; activeIds?: ReadonlySet<string>; startup?: boolean } = {},
): AttachmentMaintenanceResult {
  if (agentsHome === undefined) return { reconciled: 0, missing: 0, orphans: 0 };
  const roots = listAppAttachmentRoots(db, agentsHome);
  const rootById = new Map(roots.map((root) => [root.appId, root.appRoot]));
  const reconciled = reconcileUploading(
    db,
    (appId) => rootById.get(appId),
    options.startup === true
      ? { activeIds: options.activeIds, now: options.now }
      : { olderThanMs: UPLOAD_RECONCILE_AGE_MS, activeIds: options.activeIds, now: options.now },
  );
  if (options.startup === true) {
    return { reconciled, missing: 0, orphans: 0 };
  }
  const missing = markMissingFiles(db, roots, { now: options.now });
  const orphans = sweepOrphanFiles(db, roots, { now: options.now, activeIds: options.activeIds });
  return { reconciled, missing, orphans };
}
