import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** File name of the per-app opencode server password under `XDG_STATE_HOME`. */
export const OPENCODE_PASSWORD_FILENAME = "opencode-password";

/** Path of the per-app opencode server password file. */
export function opencodePasswordPath(stateDir: string): string {
  return path.join(stateDir, OPENCODE_PASSWORD_FILENAME);
}

/**
 * Read a small file without following a symlink in the final component.
 *
 * The path can be agent-writable (the per-app state directory is mounted read-write into the app
 * container), so a symlink planted there must never make the coordinator or the runner read an
 * arbitrary host file. Missing files return `undefined`; every other failure throws.
 */
export function readRegularFileNoFollow(file: string, maxBytes = 4096): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("secret file is not a regular file");
    }
    if (stat.size > maxBytes) {
      throw new Error("secret file is too large");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > maxBytes) {
      throw new Error("secret file is too large");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Read the existing password, or `undefined` when the file is missing, empty, or not a regular file. */
export function readOpencodePassword(file: string): string | undefined {
  try {
    const password = readRegularFileNoFollow(file)?.trim();
    return password === undefined || password.length === 0 ? undefined : password;
  } catch {
    return undefined;
  }
}

/**
 * Reuse the per-app password or mint a new random one, writing it atomically with mode 0600.
 *
 * The supervisor host reads this file and exports `OPENCODE_SERVER_PASSWORD` to `opencode serve`; the
 * coordinator registers the same value as the endpoint's Basic authorization.
 */
export function ensureOpencodePassword(file: string): string {
  const existing = readOpencodePassword(file);
  if (existing !== undefined) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // The file is readable; a metadata change is not worth failing a healthy instance.
    }
    return existing;
  }

  const password = randomBytes(32).toString("base64url");
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${password}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return password;
}
