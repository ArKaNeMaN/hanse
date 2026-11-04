import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isInside } from "./app-path.js";

/** Docker ignore file name at the application/context root. */
export const DOCKERIGNORE_FILENAME = ".dockerignore";

/** Maximum accepted `.dockerignore` file size (1 MiB). */
export const MAX_DOCKERIGNORE_BYTES = 1024 * 1024;

export type DockerignoreFileErrorCode =
  | "not_file"
  | "symlink"
  | "too_large"
  | "outside"
  | "read_failed";

/** Typed failure while reading an application `.dockerignore` file. */
export class DockerignoreFileError extends Error {
  readonly code: DockerignoreFileErrorCode;
  readonly path: string;

  constructor(
    code: DockerignoreFileErrorCode,
    message: string,
    filePath: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DockerignoreFileError";
    this.code = code;
    this.path = filePath;
  }
}

/**
 * Read the application `.dockerignore` file, or return `null` when it does not exist.
 *
 * The file must be a regular non-symlink file inside the application directory and no larger than
 * {@link MAX_DOCKERIGNORE_BYTES}. The reader is deliberately fail-closed: a symlinked, oversized,
 * or unreadable ignore file is an error instead of being silently ignored.
 */
export function readDockerignoreFile(appDir: string): Buffer | null {
  const absolute = path.join(appDir, DOCKERIGNORE_FILENAME);

  let linkStats: ReturnType<typeof lstatSync>;
  try {
    linkStats = lstatSync(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new DockerignoreFileError(
      "read_failed",
      `cannot inspect ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
      absolute,
      { cause: error },
    );
  }

  if (linkStats.isSymbolicLink()) {
    throw new DockerignoreFileError(
      "symlink",
      `${DOCKERIGNORE_FILENAME} must not be a symlink`,
      absolute,
    );
  }
  if (!linkStats.isFile()) {
    throw new DockerignoreFileError(
      "not_file",
      `${DOCKERIGNORE_FILENAME} is not a regular file`,
      absolute,
    );
  }
  if (linkStats.size > MAX_DOCKERIGNORE_BYTES) {
    throw new DockerignoreFileError(
      "too_large",
      `${DOCKERIGNORE_FILENAME} exceeds ${MAX_DOCKERIGNORE_BYTES} bytes`,
      absolute,
    );
  }

  let root: string;
  let resolved: string;
  try {
    root = realpathSync(appDir);
    resolved = realpathSync(absolute);
  } catch (error) {
    throw new DockerignoreFileError(
      "read_failed",
      `cannot resolve ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
      absolute,
      { cause: error },
    );
  }
  if (!isInside(root, resolved)) {
    throw new DockerignoreFileError(
      "outside",
      `${DOCKERIGNORE_FILENAME} escapes the application directory`,
      absolute,
    );
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch (error) {
    throw new DockerignoreFileError(
      "read_failed",
      `cannot inspect ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
      absolute,
      { cause: error },
    );
  }
  if (!stats.isFile()) {
    throw new DockerignoreFileError(
      "not_file",
      `${DOCKERIGNORE_FILENAME} is not a regular file`,
      absolute,
    );
  }
  if (stats.size > MAX_DOCKERIGNORE_BYTES) {
    throw new DockerignoreFileError(
      "too_large",
      `${DOCKERIGNORE_FILENAME} exceeds ${MAX_DOCKERIGNORE_BYTES} bytes`,
      absolute,
    );
  }

  try {
    return readFileSync(resolved);
  } catch (error) {
    throw new DockerignoreFileError(
      "read_failed",
      `cannot read ${DOCKERIGNORE_FILENAME}: ${errorMessage(error)}`,
      absolute,
      { cause: error },
    );
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
