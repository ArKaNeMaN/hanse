import { Buffer } from "node:buffer";
import { type BigIntStats, constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Ignore } from "@balena/dockerignore";
import {
  DOCKERIGNORE_FILENAME,
  DockerignoreFileError,
  MAX_DOCKERIGNORE_BYTES,
} from "../runtime/dockerignore.js";

type DockerignoreFactory = (options?: { ignorecase?: boolean }) => Ignore;

const createDockerignore = createRequire(import.meta.url)(
  "@balena/dockerignore",
) as DockerignoreFactory;

/** Default Dockerfile path, relative to the application directory. */
export const DEFAULT_DOCKERFILE = ".hanse/Dockerfile";
/** Default maximum total size of regular files in one build context (64 MiB). */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Default maximum number of tar entries (directories and files) in one build context. */
export const DEFAULT_MAX_ENTRIES = 20_000;

const TAR_BLOCK = 512;
const TAR_NAME_MAX = 100;
const TAR_PREFIX_MAX = 155;
const DEFAULT_PROC_FD_ROOT = "/proc/self/fd";
/**
 * Node/libuv already opens descriptors close-on-exec, but `fs.constants` does not expose
 * `O_CLOEXEC` on every supported Node version. Use it when present, otherwise use the Linux ABI
 * value (the runner target) and rely on the libuv default elsewhere.
 */
const O_CLOEXEC =
  (constants as { readonly O_CLOEXEC?: number }).O_CLOEXEC ??
  (process.platform === "linux" ? 0o2000000 : 0);

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

/**
 * Generated agent-runtime dependency trees that never belong in a build context.
 *
 * `.opencode/node_modules` is created by the local opencode plugin install and contains npm `.bin`
 * symlinks. It is not application source; the rest of `.opencode` (config and plugin sources) is
 * kept.
 */
const NESTED_EXCLUSIONS: ReadonlySet<string> = new Set([".opencode/node_modules"]);

function isNestedExcludedPath(relative: string): boolean {
  for (const excluded of NESTED_EXCLUSIONS) {
    if (relative === excluded || relative.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

export type BuildContextErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_APP_DIR"
  | "INVALID_DOCKERFILE"
  | "INVALID_DOCKERIGNORE"
  | "PATH_ESCAPE"
  | "SYMLINK_REJECTED"
  | "SPECIAL_FILE"
  | "TOO_LARGE"
  | "TOO_MANY_ENTRIES"
  | "PATH_TOO_LONG"
  | "READ_FAILED"
  | "PROC_UNAVAILABLE"
  | "ROOT_CHANGED";

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

/** Device/inode identity captured at the last path-validation point for the app root. */
export interface RootIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Internal test seams used to exercise filesystem races. Production callers must not set them.
 */
export interface BuildContextHooks {
  /** Runs after a directory's entries are read and before any child is opened. */
  readonly afterReaddir?: (relativeDirectory: string) => void | Promise<void>;
  /** Runs immediately before an accepted (non-ignored) entry is opened. */
  readonly beforeOpen?: (relative: string) => void | Promise<void>;
}

export interface BuildContextOptions {
  /** Dockerfile path relative to the application directory. Defaults to `.hanse/Dockerfile`. */
  readonly dockerfile?: string;
  /** Maximum total size of regular files in bytes. Defaults to 64 MiB. */
  readonly maxBytes?: number;
  /** Maximum number of tar entries. Defaults to 20,000. */
  readonly maxEntries?: number;
  /** Root identity captured at the last validation point; a mismatch fails the build. */
  readonly rootIdentity?: RootIdentity;
  /** Test-only override for the procfs directory used to anchor opens. */
  readonly procFdRoot?: string;
  /** Test-only filesystem race hooks. */
  readonly hooks?: BuildContextHooks;
}

export interface BuildContext {
  /** Uncompressed POSIX/ustar archive suitable for Docker Engine `/build`. */
  readonly tar: Buffer;
  /** Context-relative paths of every regular file, sorted. */
  readonly files: readonly string[];
  /** Context-relative Dockerfile path, suitable for Docker's `-f`. */
  readonly dockerfile: string;
  /** Exact Dockerfile bytes that entered {@link tar}, so callers need not re-read by path. */
  readonly dockerfileContent: Buffer;
  /** Size of {@link tar} in bytes. */
  readonly bytes: number;
}

type ContextEntry =
  | { readonly relative: string; readonly kind: "directory"; readonly size: 0 }
  | {
      readonly relative: string;
      readonly kind: "file";
      readonly size: number;
      readonly data: Buffer;
    };

interface Limits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

interface DockerIgnoreRules {
  readonly matcher: Ignore | null;
  readonly hasNegations: boolean;
  readonly content: Buffer | null;
}

type DirentKind = "file" | "directory" | "symlink" | "other" | "unknown";

/**
 * Build a deterministic, no-follow tar context for one application directory.
 *
 * Security properties:
 * - The application root is opened with `O_NOFOLLOW` and its `dev`/`ino` are compared with the
 *   identity captured at the last validation point.
 * - The walk is anchored to directory file descriptors: entries are enumerated through
 *   `/proc/self/fd/<fd>` and opened through `/proc/self/fd/<parent-fd>/<name>` with `O_NOFOLLOW`.
 *   The final path component is never followed, so a directory or file swapped for a symlink
 *   between `readdir` and the open fails the build instead of leaking outside bytes.
 * - Regular file bytes are read while the parent directory fd is open and stored on the entry;
 *   nothing is re-opened by path afterwards.
 * - FIFOs and other special files are opened with `O_NONBLOCK` so a swapped FIFO cannot block, and
 *   are rejected after `fstat`.
 * - A symlink or special file (socket, fifo, device) is rejected only when it survives the ignore
 *   rules; ignored entries are skipped without being opened.
 * - Top-level `.git`, `.codegraph`, `node_modules`, `state`, `agents`, `.cache`, `.mise`, and the
 *   generated `.opencode/node_modules` dependency tree are a hard floor. `.dockerignore` can exclude
 *   more, but cannot re-include them; nested directories with those names are kept as source.
 * - `.dockerignore` follows Docker's pattern rules. The Dockerfile and `.dockerignore` are always
 *   included, even when a rule matches them, and are read through the same anchored API.
 * - Limits are enforced before data is copied, so an oversized context fails closed.
 * - If `/proc/self/fd` is unavailable the build is refused; there is no path-walk fallback.
 */
export async function createBuildContext(
  appDir: string,
  options: BuildContextOptions = {},
): Promise<BuildContext> {
  const limits = resolveLimits(options);
  const procRoot = options.procFdRoot ?? DEFAULT_PROC_FD_ROOT;
  await assertProcAvailable(procRoot);

  const rootPath = await resolveAppRoot(appDir);
  const root = await openRoot(rootPath, appDir);
  try {
    await verifyRootIdentity(root, rootPath, options.rootIdentity);
    const dockerfile = await resolveDockerfile(
      root.fd,
      procRoot,
      options.dockerfile ?? DEFAULT_DOCKERFILE,
    );
    const ignoreRules = await loadDockerignore(root, procRoot);
    const forcedFiles = new Set<string>([dockerfile]);
    if (ignoreRules.content !== null) forcedFiles.add(DOCKERIGNORE_FILENAME);
    const forcedDirectories = ancestorDirectories(forcedFiles);
    const entries = await collectEntries(
      root.fd,
      procRoot,
      limits,
      ignoreRules,
      forcedFiles,
      forcedDirectories,
      options.hooks,
    );

    const dockerfileEntry = entries.find((entry) => entry.relative === dockerfile);
    if (dockerfileEntry === undefined || dockerfileEntry.kind !== "file") {
      throw new BuildContextError(
        "INVALID_DOCKERFILE",
        `Dockerfile is not part of the build context: ${dockerfile}`,
        { path: dockerfile },
      );
    }

    const tar = buildTar(entries);
    return {
      tar,
      files: entries.filter((entry) => entry.kind === "file").map((entry) => entry.relative),
      dockerfile,
      dockerfileContent: dockerfileEntry.data,
      bytes: tar.length,
    };
  } finally {
    await root.close();
  }
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

async function assertProcAvailable(procRoot: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await stat(procRoot);
  } catch (error) {
    throw new BuildContextError(
      "PROC_UNAVAILABLE",
      `anchored build context requires a readable ${procRoot}`,
      { path: procRoot, cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new BuildContextError(
      "PROC_UNAVAILABLE",
      `anchored build context requires a directory at ${procRoot}`,
      { path: procRoot },
    );
  }
}

async function openRoot(rootPath: string, appDir: string): Promise<FileHandle> {
  try {
    return await open(
      rootPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC,
    );
  } catch (error) {
    if (errnoCode(error) === "ELOOP") {
      throw new BuildContextError("SYMLINK_REJECTED", `appDir must not be a symlink: ${appDir}`, {
        path: appDir,
        cause: error,
      });
    }
    throw new BuildContextError("INVALID_APP_DIR", `cannot open appDir: ${appDir}`, {
      path: appDir,
      cause: error,
    });
  }
}

async function verifyRootIdentity(
  root: FileHandle,
  rootPath: string,
  expected: RootIdentity | undefined,
): Promise<void> {
  let stats: BigIntStats;
  try {
    stats = await root.stat({ bigint: true });
  } catch (error) {
    throw new BuildContextError("INVALID_APP_DIR", `cannot stat appDir: ${rootPath}`, {
      path: rootPath,
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw new BuildContextError("INVALID_APP_DIR", `appDir is not a directory: ${rootPath}`, {
      path: rootPath,
    });
  }
  if (expected !== undefined && (stats.dev !== expected.dev || stats.ino !== expected.ino)) {
    throw new BuildContextError("ROOT_CHANGED", `appDir changed since validation: ${rootPath}`, {
      path: rootPath,
    });
  }
}

async function loadDockerignore(root: FileHandle, procRoot: string): Promise<DockerIgnoreRules> {
  let content: Buffer | null;
  try {
    content = await readAnchoredDockerignore(root, procRoot);
  } catch (error) {
    throw dockerignoreContextError(error);
  }
  if (content === null) {
    return { matcher: null, hasNegations: false, content: null };
  }

  const text = content.toString("utf8");
  let matcher: Ignore;
  try {
    matcher = createDockerignore().add(text);
  } catch (error) {
    throw new BuildContextError(
      "INVALID_DOCKERIGNORE",
      `invalid ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
      { path: DOCKERIGNORE_FILENAME, cause: error },
    );
  }
  return { matcher, hasNegations: text.includes("!"), content };
}

async function readAnchoredDockerignore(
  root: FileHandle,
  procRoot: string,
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await openChildHandle(procRoot, root.fd, DOCKERIGNORE_FILENAME, false);
  } catch (error) {
    if (isMissingError(error)) return null;
    if (errnoCode(error) === "ELOOP") {
      throw new DockerignoreFileError(
        "symlink",
        `${DOCKERIGNORE_FILENAME} must not be a symlink`,
        DOCKERIGNORE_FILENAME,
        { cause: error },
      );
    }
    throw new DockerignoreFileError(
      "read_failed",
      `cannot inspect ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
      DOCKERIGNORE_FILENAME,
      { cause: error },
    );
  }

  try {
    let stats: Stats;
    try {
      stats = await handle.stat();
    } catch (error) {
      throw new DockerignoreFileError(
        "read_failed",
        `cannot inspect ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
        DOCKERIGNORE_FILENAME,
        { cause: error },
      );
    }
    if (!stats.isFile()) {
      throw new DockerignoreFileError(
        "not_file",
        `${DOCKERIGNORE_FILENAME} is not a regular file`,
        DOCKERIGNORE_FILENAME,
      );
    }
    if (stats.size > MAX_DOCKERIGNORE_BYTES) {
      throw new DockerignoreFileError(
        "too_large",
        `${DOCKERIGNORE_FILENAME} exceeds ${MAX_DOCKERIGNORE_BYTES} bytes`,
        DOCKERIGNORE_FILENAME,
      );
    }

    let data: Buffer;
    try {
      data = await handle.readFile();
    } catch (error) {
      throw new DockerignoreFileError(
        "read_failed",
        `cannot read ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
        DOCKERIGNORE_FILENAME,
        { cause: error },
      );
    }
    if (data.length !== stats.size) {
      throw new DockerignoreFileError(
        "read_failed",
        `short read while reading ${DOCKERIGNORE_FILENAME}`,
        DOCKERIGNORE_FILENAME,
      );
    }
    return data;
  } finally {
    await handle.close();
  }
}

function dockerignoreContextError(error: unknown): BuildContextError {
  if (error instanceof DockerignoreFileError) {
    return new BuildContextError(
      error.code === "symlink" ? "SYMLINK_REJECTED" : "INVALID_DOCKERIGNORE",
      error.message,
      { path: DOCKERIGNORE_FILENAME, cause: error },
    );
  }
  return new BuildContextError(
    "INVALID_DOCKERIGNORE",
    `cannot read ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
    { path: DOCKERIGNORE_FILENAME, cause: error },
  );
}

function ancestorDirectories(files: ReadonlySet<string>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const file of files) {
    let current = path.posix.dirname(file);
    while (current !== "." && current !== "") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return directories;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
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

  let resolvedStats: Stats;
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
 * Resolve the Dockerfile inside the root fd without following any symlink, and return its
 * canonical context-relative POSIX path.
 */
async function resolveDockerfile(rootFd: number, procRoot: string, value: string): Promise<string> {
  const segments = dockerfileSegments(value);
  const relative = segments.join("/");

  if (TOP_LEVEL_EXCLUSIONS.has(segments[0] ?? "")) {
    throw new BuildContextError(
      "INVALID_DOCKERFILE",
      `Dockerfile must not be inside an excluded top-level entry: ${value}`,
      { path: value },
    );
  }
  if (isNestedExcludedPath(relative)) {
    throw new BuildContextError(
      "INVALID_DOCKERFILE",
      `Dockerfile must not be inside an excluded dependency tree: ${value}`,
      { path: value },
    );
  }

  const opened: FileHandle[] = [];
  let parentFd = rootFd;
  try {
    for (const [index, segment] of segments.entries()) {
      const last = index === segments.length - 1;
      const relativeSoFar = segments.slice(0, index + 1).join("/");

      let handle: FileHandle;
      try {
        handle = await openChildHandle(procRoot, parentFd, segment, !last);
      } catch (error) {
        const code = errnoCode(error);
        const symlink =
          code === "ELOOP" ||
          (!last && code === "ENOTDIR" && (await isAnchoredSymlink(procRoot, parentFd, segment)));
        throw dockerfileOpenError(error, value, relativeSoFar, last, symlink);
      }

      let stats: Stats;
      try {
        stats = await handle.stat();
      } catch (error) {
        await handle.close();
        throw new BuildContextError("INVALID_DOCKERFILE", `cannot inspect Dockerfile: ${value}`, {
          path: value,
          cause: error,
        });
      }

      if (last) {
        await handle.close();
        if (!stats.isFile()) {
          throw new BuildContextError(
            "INVALID_DOCKERFILE",
            `Dockerfile is not a regular file: ${value}`,
            { path: value },
          );
        }
        return relative;
      }

      if (!stats.isDirectory()) {
        await handle.close();
        throw new BuildContextError(
          "INVALID_DOCKERFILE",
          `Dockerfile path component is not a directory: ${relativeSoFar}`,
          { path: relativeSoFar },
        );
      }

      opened.push(handle);
      parentFd = handle.fd;
    }
  } finally {
    await Promise.all(opened.map((handle) => handle.close()));
  }

  // `dockerfileSegments` always returns at least one segment, so the loop returns above.
  throw new BuildContextError("INVALID_DOCKERFILE", `Dockerfile does not exist: ${value}`, {
    path: value,
  });
}

function dockerfileOpenError(
  error: unknown,
  value: string,
  relativeSoFar: string,
  last: boolean,
  symlink: boolean,
): BuildContextError {
  const code = errnoCode(error);
  if (symlink) {
    return new BuildContextError(
      "SYMLINK_REJECTED",
      `Dockerfile path must not contain a symlink: ${relativeSoFar}`,
      { path: relativeSoFar, cause: error },
    );
  }
  if (!last && code === "ENOTDIR") {
    return new BuildContextError(
      "INVALID_DOCKERFILE",
      `Dockerfile path component is not a directory: ${relativeSoFar}`,
      { path: relativeSoFar, cause: error },
    );
  }
  if (code === "ENOENT") {
    return new BuildContextError("INVALID_DOCKERFILE", `Dockerfile does not exist: ${value}`, {
      path: value,
      cause: error,
    });
  }
  return new BuildContextError("INVALID_DOCKERFILE", `cannot open Dockerfile: ${value}`, {
    path: value,
    cause: error,
  });
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

async function collectEntries(
  rootFd: number,
  procRoot: string,
  limits: Limits,
  ignoreRules: DockerIgnoreRules,
  forcedFiles: ReadonlySet<string>,
  forcedDirectories: ReadonlySet<string>,
  hooks: BuildContextHooks | undefined,
): Promise<ContextEntry[]> {
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

  const isIgnored = (relative: string, forced: boolean): boolean => {
    if (forced || ignoreRules.matcher === null) return false;
    try {
      return ignoreRules.matcher.ignores(relative);
    } catch (error) {
      throw new BuildContextError(
        "INVALID_DOCKERIGNORE",
        `cannot apply ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
        { path: relative, cause: error },
      );
    }
  };

  const visit = async (directoryFd: number, relativeDirectory: string): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(anchoredPath(procRoot, directoryFd), { withFileTypes: true });
    } catch (error) {
      throw new BuildContextError(
        "READ_FAILED",
        `cannot read directory in build context: ${relativeDirectory || "."}`,
        { path: relativeDirectory, cause: error },
      );
    }
    dirents.sort((left, right) => compareStrings(left.name, right.name));
    if (hooks?.afterReaddir !== undefined) {
      await hooks.afterReaddir(relativeDirectory);
    }

    for (const dirent of dirents) {
      const name = dirent.name;
      const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      assertSafeMember(relative);

      // Excluded roots and generated dependency trees are dropped before inspection; their
      // contents are never traversed and cannot be re-included by .dockerignore.
      if (
        (relativeDirectory === "" && TOP_LEVEL_EXCLUSIONS.has(name)) ||
        isNestedExcludedPath(relative)
      ) {
        continue;
      }

      const forced = forcedFiles.has(relative) || forcedDirectories.has(relative);
      const ignored = isIgnored(relative, forced);
      const kind = direntKind(dirent);

      if (ignored) {
        // `d_type` is usually present on the Linux runner. When it is not, classify with an
        // anchored `lstat` (which never follows the final component) so negated descendants are
        // still reachable; ignored entries are never opened for inspection.
        const ignoredKind =
          kind === "unknown" ? await anchoredEntryKind(procRoot, directoryFd, name) : kind;
        if (ignoredKind !== "directory") continue;
        // A negated rule can re-include a descendant even when its parent matches. Walk ignored
        // directories only when the file contains an exception, and keep the parent entry when a
        // descendant survives. Ignored symlinks and special files are never opened.
        if (!ignoreRules.hasNegations) continue;
        const before = entries.length;
        let handle: FileHandle | undefined;
        try {
          handle = await openChildHandle(procRoot, directoryFd, name, true);
        } catch (error) {
          const code = errnoCode(error);
          if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT") continue;
          throw new BuildContextError(
            "READ_FAILED",
            `cannot open ignored directory in build context: ${relative}`,
            { path: relative, cause: error },
          );
        }
        try {
          await visit(handle.fd, relative);
        } finally {
          await handle.close();
        }
        if (entries.length > before) {
          push({ relative, kind: "directory", size: 0 });
        }
        continue;
      }

      if (kind === "symlink") {
        throw new BuildContextError(
          "SYMLINK_REJECTED",
          `refusing symlink in build context: ${relative}`,
          { path: relative },
        );
      }
      if (kind === "other") {
        throw new BuildContextError(
          "SPECIAL_FILE",
          `refusing special file in build context: ${relative}`,
          { path: relative },
        );
      }

      if (hooks?.beforeOpen !== undefined) {
        await hooks.beforeOpen(relative);
      }

      if (kind === "directory") {
        const handle = await openWalkEntry(procRoot, directoryFd, name, true, relative);
        try {
          const stats = await handle.stat();
          if (!stats.isDirectory()) {
            throw new BuildContextError(
              "READ_FAILED",
              `entry changed while building context: ${relative}`,
              { path: relative },
            );
          }
          push({ relative, kind: "directory", size: 0 });
          await visit(handle.fd, relative);
        } finally {
          await handle.close();
        }
        continue;
      }

      // A regular file, or an entry whose dirent type is unavailable on this filesystem.
      const handle = await openWalkEntry(procRoot, directoryFd, name, false, relative);
      try {
        const stats = await handle.stat();
        if (stats.isDirectory()) {
          if (kind === "file") {
            throw new BuildContextError(
              "READ_FAILED",
              `entry changed while building context: ${relative}`,
              { path: relative },
            );
          }
          push({ relative, kind: "directory", size: 0 });
          await visit(handle.fd, relative);
          continue;
        }
        if (!stats.isFile()) {
          throw new BuildContextError(
            "SPECIAL_FILE",
            `refusing special file in build context: ${relative}`,
            { path: relative },
          );
        }
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
        const data = await handle.readFile();
        if (data.length !== stats.size) {
          throw new BuildContextError(
            "READ_FAILED",
            `short read while building context: ${relative}`,
            { path: relative },
          );
        }
        push({ relative, kind: "file", size: stats.size, data });
      } finally {
        await handle.close();
      }
    }
  };

  await visit(rootFd, "");
  entries.sort((left, right) => compareStrings(left.relative, right.relative));
  return entries;
}

async function anchoredEntryKind(
  procRoot: string,
  parentFd: number,
  name: string,
): Promise<DirentKind> {
  try {
    const stats = await lstat(anchoredPath(procRoot, parentFd, name));
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    if (stats.isSymbolicLink()) return "symlink";
    return "other";
  } catch {
    return "unknown";
  }
}

function direntKind(dirent: Dirent): DirentKind {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "symlink";
  if (
    dirent.isFIFO() ||
    dirent.isSocket() ||
    dirent.isBlockDevice() ||
    dirent.isCharacterDevice()
  ) {
    return "other";
  }
  return "unknown";
}

function anchoredPath(procRoot: string, fd: number, name?: string): string {
  const base = `${procRoot}/${fd}`;
  return name === undefined ? base : `${base}/${name}`;
}

async function openChildHandle(
  procRoot: string,
  parentFd: number,
  name: string,
  directory: boolean,
): Promise<FileHandle> {
  const flags =
    constants.O_RDONLY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK |
    O_CLOEXEC |
    (directory ? constants.O_DIRECTORY : 0);
  return open(anchoredPath(procRoot, parentFd, name), flags);
}

async function openWalkEntry(
  procRoot: string,
  parentFd: number,
  name: string,
  directory: boolean,
  relative: string,
): Promise<FileHandle> {
  try {
    return await openChildHandle(procRoot, parentFd, name, directory);
  } catch (error) {
    const code = errnoCode(error);
    const symlink =
      code === "ELOOP" ||
      (directory && code === "ENOTDIR" && (await isAnchoredSymlink(procRoot, parentFd, name)));
    if (symlink) {
      throw new BuildContextError(
        "SYMLINK_REJECTED",
        `refusing symlink in build context: ${relative}`,
        { path: relative, cause: error },
      );
    }
    throw new BuildContextError(
      "READ_FAILED",
      `cannot open ${directory ? "directory" : "file"} in build context: ${relative}`,
      { path: relative, cause: error },
    );
  }
}

async function isAnchoredSymlink(
  procRoot: string,
  parentFd: number,
  name: string,
): Promise<boolean> {
  try {
    return (await lstat(anchoredPath(procRoot, parentFd, name))).isSymbolicLink();
  } catch {
    return false;
  }
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

function buildTar(entries: readonly ContextEntry[]): Buffer {
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

    const data = entry.data;
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

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
