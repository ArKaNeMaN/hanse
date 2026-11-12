import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { appStateRoot } from "../attachments/paths.js";
import { sanitizeAppKey } from "../opencode/instance.js";
import { MOUNTS_ATTACHMENTS_DIR, MOUNTS_GIT_DIR } from "../shared/mounts.js";

const MARKER_VERSION = 1;
const MIGRATION_TEMP_PREFIX = ".hanse-migration-";
const MAX_CHUNK_BYTES = 64 * 1024;

export class RunnerLayoutMigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunnerLayoutMigrationError";
    this.code = code;
  }
}

export interface RunnerLayoutMigrationApp {
  projectId: string;
  appKey: string;
}

export interface RunnerLayoutMigrationOptions {
  agentsHome: string;
  mountsRoot: string;
  apps: readonly RunnerLayoutMigrationApp[];
  markerPath: string;
  now?: () => Date;
}

export interface TreeSummary {
  files: number;
  bytes: number;
  sha256: string;
}

interface MarkerApp extends RunnerLayoutMigrationApp {
  attachments: TreeSummary | null;
  git: TreeSummary | null;
}

interface Marker {
  version: 1;
  mountsRoot: string;
  completedAt: string;
  apps: MarkerApp[];
}

export interface RunnerLayoutMigrationResult {
  migrated: number;
  skipped: number;
  alreadyDone: boolean;
}

function markerKey(app: RunnerLayoutMigrationApp): string {
  return `${app.projectId}\u0000${app.appKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSummary(value: unknown): TreeSummary | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      "runner layout marker contains an invalid tree summary",
    );
  }
  const { files, bytes, sha256 } = value;
  if (
    typeof files !== "number" ||
    !Number.isSafeInteger(files) ||
    files < 0 ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    typeof sha256 !== "string"
  ) {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      "runner layout marker contains an invalid tree summary",
    );
  }
  return { files, bytes, sha256 };
}

function parseMarker(raw: string, mountsRoot: string): Marker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      "runner layout marker is not valid JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      "runner layout marker must be an object",
    );
  }
  if (parsed.version !== MARKER_VERSION) {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      `unsupported runner layout marker version: ${String(parsed.version)}`,
    );
  }
  if (parsed.mountsRoot !== mountsRoot) {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      "runner layout marker belongs to a different mounts root",
    );
  }
  if (!Array.isArray(parsed.apps)) {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      "runner layout marker apps must be an array",
    );
  }
  const apps: MarkerApp[] = [];
  for (const entry of parsed.apps) {
    if (
      !isRecord(entry) ||
      typeof entry.projectId !== "string" ||
      typeof entry.appKey !== "string"
    ) {
      throw new RunnerLayoutMigrationError(
        "runner_layout_marker_invalid",
        "runner layout marker contains an invalid app entry",
      );
    }
    apps.push({
      projectId: entry.projectId,
      appKey: entry.appKey,
      attachments: parseSummary(entry.attachments),
      git: parseSummary(entry.git),
    });
  }
  return {
    version: MARKER_VERSION,
    mountsRoot,
    completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : "",
    apps,
  };
}

function readMarker(markerPath: string, mountsRoot: string): Marker | undefined {
  if (!existsSync(markerPath)) return undefined;
  let raw: string;
  try {
    raw = requireReadFile(markerPath);
  } catch {
    throw new RunnerLayoutMigrationError(
      "runner_layout_marker_invalid",
      "runner layout marker cannot be read",
    );
  }
  return parseMarker(raw, mountsRoot);
}

function requireReadFile(file: string): string {
  const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      if (chunks.length > 64) {
        throw new RunnerLayoutMigrationError(
          "runner_layout_marker_invalid",
          "runner layout marker is too large",
        );
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function entries(directory: string): string[] {
  return readdirSync(directory).sort();
}

function digestEntry(
  hash: ReturnType<typeof createHash>,
  kind: "d" | "f",
  relative: string,
  mode: number,
  size: number,
): void {
  hash.update(`${kind}\u0000${relative}\u0000${mode.toString(8)}\u0000${size}\u0000`);
}

function summarizeTree(root: string): TreeSummary {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;

  const walk = (directory: string, relative: string): void => {
    for (const name of entries(directory)) {
      const full = path.join(directory, name);
      const rel = relative.length === 0 ? name : `${relative}/${name}`;
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (stat === undefined) {
        throw new RunnerLayoutMigrationError(
          "runner_layout_source_unstable",
          `migration source disappeared: ${rel}`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new RunnerLayoutMigrationError(
          "runner_layout_source_unsafe",
          `migration source contains a symlink: ${rel}`,
        );
      }
      const mode = stat.mode & 0o777;
      if (stat.isDirectory()) {
        digestEntry(hash, "d", rel, mode, 0);
        walk(full, rel);
        continue;
      }
      if (!stat.isFile()) {
        throw new RunnerLayoutMigrationError(
          "runner_layout_source_unsafe",
          `migration source contains a non-regular entry: ${rel}`,
        );
      }
      const fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.size !== stat.size) {
          throw new RunnerLayoutMigrationError(
            "runner_layout_source_unstable",
            `migration source changed during verification: ${rel}`,
          );
        }
        digestEntry(hash, "f", rel, mode, opened.size);
        const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
        for (;;) {
          const read = readSync(fd, buffer, 0, buffer.length, null);
          if (read === 0) break;
          hash.update(buffer.subarray(0, read));
        }
        files += 1;
        bytes += opened.size;
      } finally {
        closeSync(fd);
      }
    }
  };

  walk(root, "");
  return { files, bytes, sha256: hash.digest("hex") };
}

function sameSummary(left: TreeSummary | null, right: TreeSummary | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.files === right.files &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const shouldChown = typeof process.getuid === "function" && process.getuid() === 0;

  const walk = (sourceDir: string, destinationDir: string, relative: string): void => {
    for (const name of entries(sourceDir)) {
      const sourcePath = path.join(sourceDir, name);
      const destinationPath = path.join(destinationDir, name);
      const rel = relative.length === 0 ? name : `${relative}/${name}`;
      const stat = lstatSync(sourcePath, { throwIfNoEntry: false });
      if (stat === undefined) {
        throw new RunnerLayoutMigrationError(
          "runner_layout_source_unstable",
          `migration source disappeared: ${rel}`,
        );
      }
      if (stat.isSymbolicLink()) {
        throw new RunnerLayoutMigrationError(
          "runner_layout_source_unsafe",
          `migration source contains a symlink: ${rel}`,
        );
      }
      if (stat.isDirectory()) {
        mkdirSync(destinationPath, { mode: stat.mode & 0o777 });
        chmodSync(destinationPath, stat.mode & 0o777);
        walk(sourcePath, destinationPath, rel);
        continue;
      }
      if (!stat.isFile()) {
        throw new RunnerLayoutMigrationError(
          "runner_layout_source_unsafe",
          `migration source contains a non-regular entry: ${rel}`,
        );
      }
      const sourceFd = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let destinationFd: number | undefined;
      try {
        const opened = fstatSync(sourceFd);
        if (!opened.isFile() || opened.size !== stat.size) {
          throw new RunnerLayoutMigrationError(
            "runner_layout_source_unstable",
            `migration source changed during copy: ${rel}`,
          );
        }
        destinationFd = openSync(
          destinationPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          stat.mode & 0o777,
        );
        fchmodSync(destinationFd, stat.mode & 0o777);
        if (shouldChown) {
          fchownSync(destinationFd, opened.uid, opened.gid);
        }
        const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
        for (;;) {
          const read = readSync(sourceFd, buffer, 0, buffer.length, null);
          if (read === 0) break;
          let written = 0;
          while (written < read) {
            written += writeSync(destinationFd, buffer, written, read - written);
          }
        }
        fsyncSync(destinationFd);
      } finally {
        if (destinationFd !== undefined) closeSync(destinationFd);
        closeSync(sourceFd);
      }
    }
  };

  walk(source, destination, "");
  const sync = (directory: string): void => {
    for (const name of entries(directory)) {
      const full = path.join(directory, name);
      const stat = lstatSync(full, { throwIfNoEntry: false });
      if (stat?.isDirectory() === true && !stat.isSymbolicLink()) sync(full);
    }
    fsyncDirectory(directory);
  };
  sync(destination);
}

function ensureMountsAppDir(mountsRoot: string, projectId: string, appKey: string): string {
  let current = path.resolve(mountsRoot);
  if (!existsSync(current)) {
    mkdirSync(current, { recursive: true, mode: 0o700 });
  }
  current = realpathSync(current);
  const segments = [sanitizeAppKey(projectId), sanitizeAppKey(appKey)];
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() === true) {
      throw new RunnerLayoutMigrationError(
        "runner_layout_destination_unsafe",
        `mounts destination component is a symlink: ${current}`,
      );
    }
    if (stat === undefined) {
      mkdirSync(current, { recursive: true, mode: 0o700 });
    }
    if (realpathSync(current) !== current) {
      throw new RunnerLayoutMigrationError(
        "runner_layout_destination_unsafe",
        `mounts destination escapes the mounts root: ${current}`,
      );
    }
  }
  return current;
}

function cleanupStaleTemps(mountsAppDir: string): void {
  for (const name of readdirSync(mountsAppDir)) {
    if (!name.startsWith(MIGRATION_TEMP_PREFIX)) continue;
    const target = path.join(mountsAppDir, name);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true && !stat.isSymbolicLink()) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

function copyLeaf(
  source: string,
  destination: string,
  mountsAppDir: string,
  label: string,
): TreeSummary {
  const sourceSummary = summarizeTree(source);
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new RunnerLayoutMigrationError(
        "runner_layout_destination_unsafe",
        `${label} destination is not a real directory`,
      );
    }
    const destinationSummary = summarizeTree(destination);
    if (!sameSummary(sourceSummary, destinationSummary)) {
      throw new RunnerLayoutMigrationError(
        "runner_layout_conflict",
        `${label} exists in both the old and new layout with different content`,
      );
    }
    return destinationSummary;
  }

  const temp = path.join(
    mountsAppDir,
    `${MIGRATION_TEMP_PREFIX}${label}-${randomBytes(8).toString("hex")}`,
  );
  try {
    copyTree(source, temp);
    const copied = summarizeTree(temp);
    if (!sameSummary(sourceSummary, copied)) {
      throw new RunnerLayoutMigrationError(
        "runner_layout_verify_failed",
        `${label} copy did not verify byte-for-byte`,
      );
    }
    renameSync(temp, destination);
    fsyncDirectory(mountsAppDir);
    return copied;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function migrateLeaf(
  source: string,
  destination: string,
  mountsAppDir: string,
  label: string,
): TreeSummary | null {
  const sourceStat = lstatSync(source, { throwIfNoEntry: false });
  if (sourceStat === undefined) {
    const destinationStat = lstatSync(destination, { throwIfNoEntry: false });
    if (destinationStat === undefined) return null;
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
      throw new RunnerLayoutMigrationError(
        "runner_layout_destination_unsafe",
        `${label} destination is not a real directory`,
      );
    }
    return summarizeTree(destination);
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new RunnerLayoutMigrationError(
      "runner_layout_source_unsafe",
      `${label} source is not a real directory`,
    );
  }
  return copyLeaf(source, destination, mountsAppDir, label);
}

function leafNeedsRecovery(source: string, destination: string): boolean {
  const sourceStat = lstatSync(source, { throwIfNoEntry: false });
  if (sourceStat === undefined || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    return false;
  }
  const destinationStat = lstatSync(destination, { throwIfNoEntry: false });
  return (
    destinationStat === undefined ||
    destinationStat.isSymbolicLink() ||
    !destinationStat.isDirectory()
  );
}

function writeMarker(markerPath: string, marker: Marker): void {
  mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporary = `${markerPath}.tmp-${randomBytes(8).toString("hex")}`;
  const body = `${JSON.stringify(marker, null, 2)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, markerPath);
    fsyncDirectory(path.dirname(markerPath));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

/**
 * Copy legacy attachment and git-credential trees into the coordinator-owned mounts root.
 *
 * The old trees are never modified or deleted. A missing marker is not a rollback signal: the
 * marker records verified apps, a rerun is idempotent, and conflicting old/new content fails
 * closed before any destination is published.
 */
export async function runRunnerLayoutMigration(
  options: RunnerLayoutMigrationOptions,
): Promise<RunnerLayoutMigrationResult> {
  const mountsRoot = path.resolve(options.mountsRoot);
  const marker = readMarker(options.markerPath, mountsRoot);
  const completed = new Set((marker?.apps ?? []).map(markerKey));
  const markerApps: MarkerApp[] = marker === undefined ? [] : [...marker.apps];
  let migrated = 0;
  let skipped = 0;

  for (const app of options.apps) {
    const key = markerKey(app);
    const oldAppRoot = appStateRoot(options.agentsHome, app.projectId, app.appKey);
    const oldAttachments = path.join(oldAppRoot, MOUNTS_ATTACHMENTS_DIR);
    const oldGit = path.join(oldAppRoot, "home", ".config", "hanse", MOUNTS_GIT_DIR);
    const mountsAppDir = ensureMountsAppDir(mountsRoot, app.projectId, app.appKey);
    const newAttachments = path.join(mountsAppDir, MOUNTS_ATTACHMENTS_DIR);
    const newGit = path.join(mountsAppDir, MOUNTS_GIT_DIR);
    if (
      completed.has(key) &&
      !leafNeedsRecovery(oldAttachments, newAttachments) &&
      !leafNeedsRecovery(oldGit, newGit)
    ) {
      skipped += 1;
      continue;
    }
    cleanupStaleTemps(mountsAppDir);
    const attachments = migrateLeaf(
      oldAttachments,
      newAttachments,
      mountsAppDir,
      MOUNTS_ATTACHMENTS_DIR,
    );
    const git = migrateLeaf(oldGit, newGit, mountsAppDir, MOUNTS_GIT_DIR);
    const entry: MarkerApp = { projectId: app.projectId, appKey: app.appKey, attachments, git };
    const existingIndex = markerApps.findIndex((item) => markerKey(item) === key);
    if (existingIndex === -1) markerApps.push(entry);
    else markerApps[existingIndex] = entry;
    completed.add(key);
    migrated += 1;
  }

  if (marker === undefined || migrated > 0) {
    const now = options.now?.() ?? new Date();
    writeMarker(options.markerPath, {
      version: MARKER_VERSION,
      mountsRoot,
      completedAt: now.toISOString(),
      apps: markerApps,
    });
  }

  return { migrated, skipped, alreadyDone: migrated === 0 && marker !== undefined };
}
