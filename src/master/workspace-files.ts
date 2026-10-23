import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isInside } from "../runtime/app-path.js";
import { MASTER_DIR_NAME } from "./constants.js";

/** Largest file the master tools read or write, in decoded UTF-8 bytes. */
export const MAX_READ_BYTES = 256 * 1024;
/** Largest directory listing returned by `list_dir`. */
export const MAX_DIR_ENTRIES = 500;

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export type WorkspaceFileErrorCode =
  | "invalid_path"
  | "not_found"
  | "not_a_file"
  | "not_a_directory"
  | "too_large"
  | "binary"
  | "denied"
  | "io_error";

/** A contained workspace file operation failed with a stable code. */
export class WorkspaceFileError extends Error {
  readonly code: WorkspaceFileErrorCode;

  constructor(code: WorkspaceFileErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceFileError";
    this.code = code;
  }
}

export interface ReadWorkspaceFileResult {
  path: string;
  bytes: number;
  content: string;
}

export interface WriteWorkspaceFileResult {
  path: string;
  bytes: number;
  created: boolean;
}

export type WorkspaceDirEntryType = "file" | "directory" | "symlink" | "other";

export interface WorkspaceDirEntry {
  name: string;
  type: WorkspaceDirEntryType;
  size: number;
}

export interface ListWorkspaceDirResult {
  path: string;
  entries: WorkspaceDirEntry[];
  truncated: boolean;
}

function ioError(error: unknown, context: string): WorkspaceFileError {
  if (error instanceof WorkspaceFileError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WorkspaceFileError("not_found", `${context} does not exist`);
  }
  if (code === "EACCES" || code === "EPERM" || code === "ELOOP") {
    return new WorkspaceFileError("denied", `${context} is not accessible`);
  }
  return new WorkspaceFileError(
    "io_error",
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Canonical workspace root; the workspace directory must already exist. */
export function workspaceRealRoot(workspaceRoot: string): string {
  try {
    return realpathSync(workspaceRoot);
  } catch (error) {
    throw ioError(error, "workspace root");
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

interface NormalizedRelativePath {
  relative: string;
  segments: string[];
}

function normalizeRelativePath(input: unknown, allowRoot: boolean): NormalizedRelativePath {
  if (typeof input !== "string") {
    throw new WorkspaceFileError("invalid_path", "path must be a string");
  }
  if (input.includes("\0") || hasControlCharacters(input)) {
    throw new WorkspaceFileError("invalid_path", "path must not contain control characters");
  }
  if (input.includes("\\")) {
    throw new WorkspaceFileError("invalid_path", "paths use forward slashes");
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new WorkspaceFileError("invalid_path", "path must be workspace-relative");
  }
  const rawSegments = input.split("/");
  if (rawSegments.some((segment) => segment === "..")) {
    throw new WorkspaceFileError("invalid_path", 'path must not contain ".."');
  }
  const segments = rawSegments.filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    if (!allowRoot) {
      throw new WorkspaceFileError("invalid_path", "path must name a workspace entry");
    }
    return { relative: "", segments: [] };
  }
  return { relative: segments.join("/"), segments };
}

interface ResolvedWorkspacePath extends NormalizedRelativePath {
  root: string;
  absolute: string;
}

function resolveWorkspacePath(
  workspaceRoot: string,
  input: unknown,
  options: { allowRoot: boolean },
): ResolvedWorkspacePath {
  const normalized = normalizeRelativePath(input, options.allowRoot);
  const root = workspaceRealRoot(workspaceRoot);
  const absolute = path.resolve(root, normalized.relative);
  if (!isInside(root, absolute)) {
    throw new WorkspaceFileError("invalid_path", "path escapes the workspace");
  }
  if (absolute === root && !options.allowRoot) {
    throw new WorkspaceFileError("invalid_path", "path must name a workspace entry");
  }
  return { ...normalized, root, absolute };
}

/** Reject a symlinked path segment. Existing ancestors only; missing segments are created later. */
function assertNoSymlinkSegments(root: string, segments: readonly string[]): void {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw ioError(error, current);
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspaceFileError("denied", `symlink path segments are not allowed: ${segment}`);
    }
  }
}

function isForbiddenTarget(root: string, relative: string, absolute: string): boolean {
  const segments = relative.split("/");
  if (segments.includes(".git")) {
    return true;
  }
  if (
    segments.length >= 2 &&
    segments.at(-2) === ".hanse" &&
    (segments.at(-1) === "project.yaml" || segments.at(-1) === "app.yaml")
  ) {
    return true;
  }
  return absolute === path.join(root, MASTER_DIR_NAME, "AGENTS.md");
}

/** True when a string contains no lone UTF-16 surrogates. */
function isWellFormed(value: string): boolean {
  const candidate = value as string & { isWellFormed?: () => boolean };
  if (typeof candidate.isWellFormed === "function") {
    return candidate.isWellFormed();
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateWriteContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new WorkspaceFileError("invalid_path", "content must be a string");
  }
  if (!isWellFormed(content)) {
    throw new WorkspaceFileError("invalid_path", "content must be well-formed Unicode");
  }
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && character !== "\t" && character !== "\n" && character !== "\r") {
      throw new WorkspaceFileError(
        "invalid_path",
        "content must not contain control characters other than tab, line feed, or carriage return",
      );
    }
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_READ_BYTES) {
    throw new WorkspaceFileError(
      "too_large",
      `content is ${bytes} bytes; the limit is ${MAX_READ_BYTES} bytes`,
    );
  }
  return content;
}

function typeOf(stat: Stats): WorkspaceDirEntryType {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

/**
 * Write a single regular file inside an already-resolved real directory.
 *
 * Used by the master tools and by manifest provisioning. The file is written through an
 * `O_EXCL | O_NOFOLLOW` temporary file in the same directory and renamed over the target, so a
 * symlink can never redirect the write.
 */
export function writeRegularFileNoFollow(
  directory: string,
  name: string,
  content: string,
  mode = 0o600,
): { created: boolean; bytes: number } {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    throw new WorkspaceFileError("invalid_path", "file name must be a single path segment");
  }
  let directoryStat: Stats;
  try {
    directoryStat = lstatSync(directory);
  } catch (error) {
    throw ioError(error, directory);
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new WorkspaceFileError("denied", `${directory} must be a real directory`);
  }
  const parent = realpathSync(directory);
  if (parent !== directory) {
    throw new WorkspaceFileError("denied", `${directory} is not canonical`);
  }
  const target = path.join(directory, name);
  let created = true;
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new WorkspaceFileError("denied", `${name} must not be a symlink`);
    }
    if (!stat.isFile()) {
      throw new WorkspaceFileError("not_a_file", `${name} is not a regular file`);
    }
    created = false;
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw ioError(error, target);
    }
  }
  const bytes = Buffer.byteLength(content, "utf8");
  const temp = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      mode,
    );
    writeSync(descriptor, content, null, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    if (realpathSync(directory) !== directory) {
      throw new WorkspaceFileError("denied", "the target directory changed during the write");
    }
    renameSync(temp, target);
    return { created, bytes };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // best effort
      }
    }
    rmSync(temp, { force: true });
    throw ioError(error, target);
  }
}

function readAllBounded(target: string): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(target, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    throw ioError(error, target);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new WorkspaceFileError("not_a_file", "path is not a regular file");
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new WorkspaceFileError(
        "too_large",
        `file is ${stat.size} bytes; the limit is ${MAX_READ_BYTES} bytes`,
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read <= 0) {
        break;
      }
      total += read;
      if (total > MAX_READ_BYTES) {
        throw new WorkspaceFileError("too_large", `file exceeds ${MAX_READ_BYTES} bytes`);
      }
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(descriptor);
  }
}

/** Read a bounded UTF-8 text file inside the workspace. */
export function readWorkspaceFile(workspaceRoot: string, input: unknown): ReadWorkspaceFileResult {
  const resolved = resolveWorkspacePath(workspaceRoot, input, { allowRoot: false });
  assertNoSymlinkSegments(resolved.root, resolved.segments);
  const segments = resolved.relative.split("/");
  if (segments.includes(".git")) {
    throw new WorkspaceFileError("denied", "reading .git internals is not allowed");
  }
  const buffer = readAllBounded(resolved.absolute);
  if (buffer.includes(0)) {
    throw new WorkspaceFileError("binary", "file contains NUL bytes");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new WorkspaceFileError("binary", "file is not valid UTF-8");
  }
  return { path: resolved.relative, bytes: buffer.length, content };
}

/** Write a bounded UTF-8 text file inside the workspace. */
export function writeWorkspaceFile(
  workspaceRoot: string,
  input: unknown,
  content: unknown,
): WriteWorkspaceFileResult {
  const resolved = resolveWorkspacePath(workspaceRoot, input, { allowRoot: false });
  const validated = validateWriteContent(content);
  assertNoSymlinkSegments(resolved.root, resolved.segments);
  if (isForbiddenTarget(resolved.root, resolved.relative, resolved.absolute)) {
    throw new WorkspaceFileError(
      "denied",
      "writing .git internals, Hanse manifests, or the master instructions is not allowed",
    );
  }
  const parentSegments = resolved.segments.slice(0, -1);
  let current = resolved.root;
  for (const segment of parentSegments) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw ioError(error, current);
      }
      mkdirSync(current, { mode: 0o755 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceFileError("denied", `parent is not a real directory: ${segment}`);
    }
  }
  const name = resolved.segments.at(-1) ?? "";
  const written = writeRegularFileNoFollow(path.dirname(resolved.absolute), name, validated, 0o600);
  return { path: resolved.relative, bytes: written.bytes, created: written.created };
}

/** List one workspace directory without following entries. */
export function listWorkspaceDir(
  workspaceRoot: string,
  input: unknown = "",
): ListWorkspaceDirResult {
  const resolved = resolveWorkspacePath(workspaceRoot, input ?? "", { allowRoot: true });
  assertNoSymlinkSegments(resolved.root, resolved.segments);
  let stat: Stats;
  try {
    stat = lstatSync(resolved.absolute);
  } catch (error) {
    throw ioError(error, resolved.absolute);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkspaceFileError("not_a_directory", "path is not a directory");
  }
  const entries: WorkspaceDirEntry[] = [];
  let truncated = false;
  const handle = opendirSync(resolved.absolute);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (entries.length >= MAX_DIR_ENTRIES) {
        truncated = true;
        break;
      }
      const entryPath = path.join(resolved.absolute, entry.name);
      let entryStat: Stats;
      try {
        entryStat = lstatSync(entryPath);
      } catch {
        continue;
      }
      entries.push({ name: entry.name, type: typeOf(entryStat), size: entryStat.size });
    }
  } finally {
    handle.closeSync();
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { path: resolved.relative, entries, truncated };
}
