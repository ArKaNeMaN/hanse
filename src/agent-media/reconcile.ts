import { lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { isInside } from "../runtime/app-path.js";
import type { SqliteDatabase } from "../store/index.js";
import { agentMediaFinalPath, agentMediaRoot, agentMediaTempPath } from "./paths.js";
import {
  listAgentMediaRoots,
  listAllAgentMedia,
  listAttachedAgentMedia,
  listStagedAgentMedia,
  markAgentMediaMissing,
  removeStagedAgentMedia,
} from "./store.js";
import { AGENT_MEDIA_ORPHAN_AGE_MS, AGENT_MEDIA_STALE_RESERVATION_MS } from "./types.js";

export interface ReconcileAgentMediaOptions {
  db: SqliteDatabase;
  agentsHome: string | undefined;
  startup: boolean;
  activeIds?: ReadonlySet<string>;
  now?: number;
}

export interface ReconcileAgentMediaResult {
  repaired: number;
  missing: number;
  orphans: number;
}

function fileSize(file: string): number | undefined {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    return stat?.isFile() === true && !stat.isSymbolicLink() ? stat.size : undefined;
  } catch {
    return undefined;
  }
}

function walk(directory: string, output: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) walk(full, output);
    else if (stat.isFile()) output.push(full);
  }
}

function removeQuiet(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Retry next pass.
  }
}

export function reconcileAgentMedia(
  options: ReconcileAgentMediaOptions,
): ReconcileAgentMediaResult {
  const { db, agentsHome, startup } = options;
  if (agentsHome === undefined) return { repaired: 0, missing: 0, orphans: 0 };
  const now = options.now ?? Date.now();
  const active = options.activeIds;
  const roots = listAgentMediaRoots(db, agentsHome);
  const rootById = new Map(roots.map((root) => [root.appId, root.appRoot]));
  let repaired = 0;
  let missing = 0;
  let orphans = 0;

  for (const row of listStagedAgentMedia(db)) {
    if (active?.has(row.id) === true) continue;
    if (!startup && now - Date.parse(row.createdAt) < AGENT_MEDIA_STALE_RESERVATION_MS) continue;
    const appRoot = rootById.get(row.appId);
    if (appRoot === undefined) continue;
    const final = agentMediaFinalPath(appRoot, row.storedName);
    const finalSize = fileSize(final);
    if (finalSize === row.size) continue;
    // A completed staged reservation with a matching file is valid; everything else is broken.
    removeStagedAgentMedia(db, appRoot, row);
    repaired += 1;
  }

  for (const [appId, appRoot] of rootById) {
    for (const row of listAttachedAgentMedia(db, appId)) {
      const size = fileSize(agentMediaFinalPath(appRoot, row.storedName));
      if (size !== row.size) {
        markAgentMediaMissing(db, row.id, new Date(now).toISOString());
        missing += 1;
      }
    }
    if (startup) continue;
    const rows = listAllAgentMedia(db, appId);
    const referenced = new Set<string>();
    for (const row of rows) {
      referenced.add(path.normalize(row.relPath));
      referenced.add(path.normalize(path.relative(appRoot, agentMediaTempPath(appRoot, row.id))));
    }
    const files: string[] = [];
    walk(agentMediaRoot(appRoot), files);
    let realRoot: string;
    try {
      realRoot = realpathSync(appRoot);
    } catch {
      continue;
    }
    for (const file of files) {
      const relative = path.normalize(path.relative(appRoot, file));
      if (referenced.has(relative)) continue;
      if (!isInside(realRoot, file)) continue;
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > AGENT_MEDIA_ORPHAN_AGE_MS) {
        removeQuiet(file);
        orphans += 1;
      }
    }
  }
  return { repaired, missing, orphans };
}
