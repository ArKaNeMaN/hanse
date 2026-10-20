import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Default Dockerfile path, relative to the application directory. */
export const DEFAULT_DOCKERFILE = ".hanse/Dockerfile";
/** Default maximum total size of regular files in one build context (64 MiB). */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Default maximum number of tar entries (directories and files) in one build context. */
export const DEFAULT_MAX_ENTRIES = 20_000;

const TAR_BLOCK = 512;
const TAR_NAME_MAX = 100;
const TAR_PREFIX_MAX = 155;

/**
 * Top-level application entries that never belong in a build context.
 *
 * The check is deliberately limited to the application root: a user source directory called
 * `state` or `node_modules` deeper in the tree is ordinary source and must be kept.
 */
const TOP_LEVEL_EXCLUSIONS: ReadonlySet<string> = new Set([
  ".git",
  ".codegraph",
  "node_modules",
  "state",
  "agents",
  ".cache",
  ".mise",
]);

export type BuildContextErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_APP_DIR"
  | "INVALID_DOCKERFILE"
  | "PATH_ESCAPE"
  | "SYMLINK_REJECTED"
  | "SPECIAL_FILE"
  | "TOO_LARGE"
  | "TOO_MANY_ENTRIES"
  | "PATH_TOO_LONG"
  | "READ_FAILED";

/** Typed error thrown while assembling a build context. There is no silent fallback. */
export class BuildContextError extends Error {
  readonly code: BuildContextErrorCode;
  readonly path: string | undefined;

  constructor(
    code: BuildContextErrorCode,
    message: string,
    options: { path?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BuildContextError";
    this.code = code;
    this.path = options.path;
  }
}

export interface BuildContextOptions {
  /** Dockerfile path relative to the application directory. Defaults to `.hanse/Dockerfile`. */
  readonly dockerfile?: string;
  /** Maximum total size of regular files in bytes. Defaults to 64 MiB. */
  readonly maxBytes?: number;
  /** Maximum number of tar entries. Defaults to 20,000. */
  readonly maxEntries?: number;
}

export interface BuildContext {
  /** Uncompressed POSIX/ustar archive suitable for Docker Engine `/build`. */
  readonly tar: Buffer;
  /** Context-relative paths of every regular file, sorted. */
  readonly files: readonly string[];
  /** Context-relative Dockerfile path, suitable for Docker's `-f`. */
  readonly dockerfile: string;
  /** Size of {@link tar} in bytes. */
  readonly bytes: number;
}

interface ContextEntry {
  readonly relative: string;
  readonly absolute: string;
  readonly kind: "file" | "directory";
  readonly size: number;
}

interface Limits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

/**
 * Build a deterministic, no-follow tar context for one application directory.
 *
 * Security properties:
 * - `appDir` and the Dockerfile are resolved with `realpath`; the app directory itself, the
 *   Dockerfile, and every path component used to reach it must not be a symlink.
 * - The directory walk never follows symlinks: any symlink or special file (socket, fifo, device)
 *   is rejected instead of skipped.
 * - Only top-level `.git`, `.codegraph`, `node_modules`, `state`, `agents`, `.cache`, and `.mise`
 *   are excluded. Nested directories with those names are kept as source.
 * - Limits are enforced before data is copied, so an oversized context fails closed.
 */
export async function createBuildContext(
  appDir: string,
  options: BuildContextOptions = {},
): Promise<BuildContext> {
  const limits = resolveLimits(options);
  const root = await resolveAppRoot(appDir);
  const dockerfile = await resolveDockerfile(root, options.dockerfile ?? DEFAULT_DOCKERFILE);
  const entries = await collectEntries(root, limits);

  const dockerfileEntry = entries.find(
    (entry) => entry.relative === dockerfile && entry.kind === "file",
  );
  if (dockerfileEntry === undefined) {
    throw new BuildContextError(
      "INVALID_DOCKERFILE",
      `Dockerfile is not part of the build context: ${dockerfile}`,
      { path: dockerfile },
    );
  }

  const tar = await buildTar(entries);
  return {
    tar,
    files: entries.filter((entry) => entry.kind === "file").map((entry) => entry.relative),
    dockerfile,
    bytes: tar.length,
  };
}

function resolveLimits(options: BuildContextOptions): Limits {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new BuildContextError(
      "INVALID_OPTIONS",
      `maxBytes must be a positive safe integer: ${String(maxBytes)}`,
    );
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new BuildContextError(
      "INVALID_OPTIONS",
      `maxEntries must be a positive safe integer: ${String(maxEntries)}`,
    );
  }
  return { maxBytes, maxEntries };
}

async function resolveAppRoot(appDir: string): Promise<string> {
  if (typeof appDir !== "string" || appDir.length === 0 || appDir.includes("\0")) {
    throw new BuildContextError(
      "INVALID_APP_DIR",
      "appDir must be a non-empty path without NUL bytes",
      { path: appDir },
    );
  }

  const absolute = path.resolve(appDir);
  let linkStats: Awaited<ReturnType<typeof lstat>>;
  try {
    linkStats = await lstat(absolute);
  } catch (error) {
    throw new BuildContextError("INVALID_APP_DIR", `appDir does not exist: ${appDir}`, {
      path: appDir,
      cause: error,
    });
  }
  if (linkStats.isSymbolicLink()) {
    throw new BuildContextError("SYMLINK_REJECTED", `appDir must not be a symlink: ${appDir}`, {
      path: appDir,
    });
  }

  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (error) {
    throw new BuildContextError("INVALID_APP_DIR", `cannot resolve appDir: ${appDir}`, {
      path: appDir,
      cause: error,
    });
  }

  let resolvedStats: Awaited<ReturnType<typeof stat>>;
  try {
    resolvedStats = await stat(resolved);
  } catch (error) {
    throw new BuildContextError("INVALID_APP_DIR", `cannot stat appDir: ${appDir}`, {
      path: appDir,
      cause: error,
    });
  }
  if (!resolvedStats.isDirectory()) {
    throw new BuildContextError("INVALID_APP_DIR", `appDir is not a directory: ${appDir}`, {
      path: appDir,
    });
  }
  return resolved;
}

/**
 * Resolve the Dockerfile inside `root` without following any symlink, and return its canonical
 * context-relative POSIX path.
 */
async function resolveDockerfile(root: string, value: string): Promise<string> {
  const segments = dockerfileSegments(value);
  const relative = segments.join("/");

  if (TOP_LEVEL_EXCLUSIONS.has(segments[0] ?? "")) {
    throw new BuildContextError(
      "INVALID_DOCKERFILE",
      `Dockerfile must not be inside an excluded top-level entry: ${value}`,
      { path: value },
    );
  }

  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const relativeSoFar = segments.slice(0, index + 1).join("/");
    const last = index === segments.length - 1;

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      throw new BuildContextError("INVALID_DOCKERFILE", `Dockerfile does not exist: ${value}`, {
        path: value,
        cause: error,
      });
    }

    if (stats.isSymbolicLink()) {
      throw new BuildContextError(
        "SYMLINK_REJECTED",
        `Dockerfile path must not contain a symlink: ${relativeSoFar}`,
        { path: relativeSoFar },
      );
    }
    if (!last && !stats.isDirectory()) {
      throw new BuildContextError(
        "INVALID_DOCKERFILE",
        `Dockerfile path component is not a directory: ${relativeSoFar}`,
        { path: relativeSoFar },
      );
    }
    if (last && !stats.isFile()) {
      throw new BuildContextError(
        "INVALID_DOCKERFILE",
        `Dockerfile is not a regular file: ${value}`,
        { path: value },
      );
    }
  }

  const realDockerfile = await realpath(current);
  if (!isInside(root, realDockerfile)) {
    throw new BuildContextError(
      "PATH_ESCAPE",
      `Dockerfile escapes the application directory: ${value}`,
      {
        path: value,
        cause: new Error(`${realDockerfile} is outside ${root}`),
      },
    );
  }
  return relative;
}

function dockerfileSegments(value: string): string[] {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new BuildContextError(
      "INVALID_DOCKERFILE",
      "Dockerfile must be a non-empty relative path without NUL bytes",
      { path: String(value) },
    );
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new BuildContextError("INVALID_DOCKERFILE", `Dockerfile must be relative: ${value}`, {
      path: value,
    });
  }

  // Accept both separators for input validation, but only "/" is ever used in the context path.
  const segments = value.split(/[\\/]/);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new BuildContextError(
        "INVALID_DOCKERFILE",
        `Dockerfile path must not contain empty, "." or ".." segments: ${value}`,
        { path: value },
      );
    }
  }
  return segments;
}

async function collectEntries(root: string, limits: Limits): Promise<ContextEntry[]> {
  const entries: ContextEntry[] = [];
  let totalBytes = 0;

  const push = (entry: ContextEntry): void => {
    if (entries.length >= limits.maxEntries) {
      throw new BuildContextError(
        "TOO_MANY_ENTRIES",
        `build context exceeds maxEntries (${limits.maxEntries})`,
      );
    }
    entries.push(entry);
  };

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      throw new BuildContextError(
        "READ_FAILED",
        `cannot read directory in build context: ${relativeDirectory || "."}`,
        { path: relativeDirectory, cause: error },
      );
    }
    names.sort(compareStrings);

    for (const name of names) {
      const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;

      // Excluded roots are dropped before inspection; their contents are never traversed.
      if (relativeDirectory === "" && TOP_LEVEL_EXCLUSIONS.has(name)) {
        continue;
      }

      assertSafeMember(relative);
      const absolute = path.join(directory, name);

      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(absolute);
      } catch (error) {
        throw new BuildContextError(
          "READ_FAILED",
          `cannot stat entry in build context: ${relative}`,
          {
            path: relative,
            cause: error,
          },
        );
      }

      if (stats.isSymbolicLink()) {
        throw new BuildContextError(
          "SYMLINK_REJECTED",
          `refusing symlink in build context: ${relative}`,
          { path: relative },
        );
      }

      if (stats.isDirectory()) {
        push({ relative, absolute, kind: "directory", size: 0 });
        await visit(absolute, relative);
        continue;
      }

      if (stats.isFile()) {
        if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
          throw new BuildContextError("READ_FAILED", `invalid file size: ${relative}`, {
            path: relative,
          });
        }
        if (stats.size > limits.maxBytes - totalBytes) {
          throw new BuildContextError(
            "TOO_LARGE",
            `build context exceeds maxBytes (${limits.maxBytes} bytes)`,
            { path: relative },
          );
        }
        totalBytes += stats.size;
        push({ relative, absolute, kind: "file", size: stats.size });
        continue;
      }

      throw new BuildContextError(
        "SPECIAL_FILE",
        `refusing special file in build context: ${relative}`,
        { path: relative },
      );
    }
  };

  await visit(root, "");
  entries.sort((left, right) => compareStrings(left.relative, right.relative));
  return entries;
}

function assertSafeMember(relative: string): void {
  const unsafe =
    relative.length === 0 ||
    relative.includes("\0") ||
    relative.startsWith("/") ||
    /^[A-Za-z]:/.test(relative) ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe) {
    throw new BuildContextError("PATH_ESCAPE", `unsafe path in build context: ${relative}`, {
      path: relative,
    });
  }
}

async function readRegularFile(entry: ContextEntry): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(entry.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new BuildContextError(
        "SYMLINK_REJECTED",
        `refusing symlink in build context: ${entry.relative}`,
        { path: entry.relative, cause: error },
      );
    }
    throw new BuildContextError(
      "READ_FAILED",
      `cannot open file in build context: ${entry.relative}`,
      {
        path: entry.relative,
        cause: error,
      },
    );
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new BuildContextError(
        "SPECIAL_FILE",
        `refusing special file in build context: ${entry.relative}`,
        { path: entry.relative },
      );
    }
    if (stats.size !== entry.size) {
      throw new BuildContextError(
        "READ_FAILED",
        `file changed while building context: ${entry.relative}`,
        { path: entry.relative },
      );
    }
    const data = await handle.readFile();
    if (data.length !== stats.size) {
      throw new BuildContextError(
        "READ_FAILED",
        `short read while building context: ${entry.relative}`,
        { path: entry.relative },
      );
    }
    return data;
  } finally {
    await handle.close();
  }
}

async function buildTar(entries: readonly ContextEntry[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;

  const push = (chunk: Buffer): void => {
    chunks.push(chunk);
    length += chunk.length;
  };

  for (const entry of entries) {
    if (entry.kind === "directory") {
      push(createHeader(`${entry.relative}/`, "5", 0o755, 0));
      continue;
    }

    const data = await readRegularFile(entry);
    push(createHeader(entry.relative, "0", 0o644, data.length));
    push(data);
    const padding = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding > 0) {
      push(Buffer.alloc(padding));
    }
  }

  // POSIX tar ends with at least two zero blocks; two are enough and keep the archive minimal.
  push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(chunks, length);
}

/**
 * Create a deterministic ustar header: zero uid/gid, mtime 0, fixed mode, no user/group names.
 */
function createHeader(memberPath: string, typeflag: "0" | "5", mode: number, size: number): Buffer {
  if (Buffer.byteLength(memberPath) === 0) {
    throw new BuildContextError("PATH_ESCAPE", "tar member path must not be empty", {
      path: memberPath,
    });
  }

  const { name, prefix } = splitUstarPath(memberPath);
  const header = Buffer.alloc(TAR_BLOCK);
  writeAscii(header, 0, TAR_NAME_MAX, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0;
  header.write("00", 263, 2, "ascii");
  if (prefix.length > 0) {
    writeAscii(header, 345, TAR_PREFIX_MAX, prefix);
  }

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8).padStart(6, "0");
  if (checksumText.length !== 6) {
    throw new BuildContextError("TOO_LARGE", "tar header checksum does not fit");
  }
  writeAscii(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitUstarPath(memberPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(memberPath) <= TAR_NAME_MAX) {
    return { name: memberPath, prefix: "" };
  }

  for (let index = memberPath.length - 1; index > 0; index -= 1) {
    if (memberPath[index] !== "/") {
      continue;
    }
    const prefix = memberPath.slice(0, index);
    const name = memberPath.slice(index + 1);
    if (name.length === 0) {
      continue;
    }
    if (Buffer.byteLength(name) > TAR_NAME_MAX || Buffer.byteLength(prefix) > TAR_PREFIX_MAX) {
      continue;
    }
    return { name, prefix };
  }

  throw new BuildContextError(
    "PATH_TOO_LONG",
    `path is too long for a ustar header: ${memberPath}`,
    { path: memberPath },
  );
}

function writeAscii(buffer: Buffer, offset: number, length: number, value: string): void {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > length) {
    throw new BuildContextError("PATH_TOO_LONG", "value does not fit in the tar header field", {
      path: value,
    });
  }
  buffer.write(value, offset, byteLength, "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || text.length > length - 1) {
    throw new BuildContextError("TOO_LARGE", `tar numeric field overflow: ${String(value)}`);
  }
  writeAscii(buffer, offset, length - 1, text.padStart(length - 1, "0"));
  buffer[offset + length - 1] = 0;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
