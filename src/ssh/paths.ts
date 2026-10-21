import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { SshError } from "./types.js";

export interface OpenAppFile {
  fd: number;
  size: number;
  close: () => void;
}

export interface OpenAppDestination {
  dirfd: number;
  name: string;
  write: (data: Buffer) => void;
  close: () => void;
}

function pathError(message: string): SshError {
  return new SshError("ssh_path_not_allowed", message);
}

function hasBadCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function componentsFor(appDir: string, userPath: string): string[] {
  if (userPath.length === 0 || userPath.length > 4096 || hasBadCharacters(userPath)) {
    throw pathError("The local path is empty or contains unsupported characters");
  }
  let relative = userPath;
  if (path.isAbsolute(relative)) {
    const rel = path.relative(appDir, relative);
    if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw pathError("The local path is outside the application directory");
    }
    relative = rel;
  }
  const components = relative.split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw pathError("The local path contains an empty, '.' or '..' component");
  }
  return components;
}

function appDirFd(appDir: string): { fd: number; real: string } {
  const real = realpathSync(appDir);
  const fd = openSync(real, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = realpathSync(`/proc/self/fd/${fd}`);
  if (opened !== real) {
    closeSync(fd);
    throw pathError("The application directory changed while it was opened");
  }
  return { fd, real };
}

function procPath(fd: number, name: string): string {
  return `/proc/self/fd/${fd}/${name}`;
}

/** Open a regular file inside the app directory without a check/open race. */
export function openAppFile(appDir: string, userPath: string): OpenAppFile {
  const components = componentsFor(appDir, userPath);
  const { fd: baseFd } = appDirFd(appDir);
  let dirfd = baseFd;
  try {
    for (const component of components.slice(0, -1)) {
      const next = openSync(
        procPath(dirfd, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (dirfd !== baseFd) {
        closeSync(dirfd);
      }
      dirfd = next;
    }
    const finalName = components[components.length - 1] as string;
    const fd = openSync(
      procPath(dirfd, finalName),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      throw pathError("The local path is not a regular file");
    }
    let closed = false;
    return {
      fd,
      size: stat.size,
      close: () => {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      },
    };
  } catch (error) {
    if (error instanceof SshError) throw error;
    throw pathError("The local path could not be opened safely");
  } finally {
    if (dirfd !== baseFd) {
      closeSync(dirfd);
    }
    closeSync(baseFd);
  }
}

/** Open a destination directory and atomically write one file inside it. */
export function openAppDestination(appDir: string, userPath: string): OpenAppDestination {
  const components = componentsFor(appDir, userPath);
  const { fd: baseFd } = appDirFd(appDir);
  let dirfd = baseFd;
  try {
    for (const component of components.slice(0, -1)) {
      const next = openSync(
        procPath(dirfd, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (dirfd !== baseFd) {
        closeSync(dirfd);
      }
      dirfd = next;
    }
    const name = components[components.length - 1] as string;
    const destinationDir = dirfd;
    let closed = false;
    return {
      dirfd: destinationDir,
      name,
      write: (data: Buffer) => {
        const tempName = `.hanse-tmp-${randomUUID()}`;
        const temp = procPath(destinationDir, tempName);
        const fd = openSync(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          let offset = 0;
          while (offset < data.length) {
            offset += writeSync(fd, data, offset, data.length - offset);
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          renameSync(temp, procPath(destinationDir, name));
        } catch (error) {
          try {
            unlinkSync(temp);
          } catch {
            // ignore cleanup failure
          }
          throw error;
        }
      },
      close: () => {
        if (!closed) {
          closed = true;
          closeSync(destinationDir);
        }
      },
    };
  } catch (error) {
    if (dirfd !== baseFd) {
      closeSync(dirfd);
    }
    closeSync(baseFd);
    if (error instanceof SshError) throw error;
    throw pathError("The local destination could not be opened safely");
  }
}

/** Read a local app file into memory (bounded by the caller's file cap). */
export function readAppFile(appDir: string, userPath: string): { data: Buffer; size: number } {
  const file = openAppFile(appDir, userPath);
  try {
    return { data: readFileSync(file.fd), size: file.size };
  } finally {
    file.close();
  }
}

/** Normalize an absolute remote POSIX path and confine it to `remoteRoot` when present. */
export function remotePath(remotePathValue: string, remoteRoot: string | null): string {
  if (
    remotePathValue.length === 0 ||
    remotePathValue.length > 4096 ||
    !remotePathValue.startsWith("/") ||
    hasBadCharacters(remotePathValue)
  ) {
    throw pathError("The remote path must be an absolute POSIX path");
  }
  if (remotePathValue.split("/").some((component) => component === "..")) {
    throw pathError("The remote path contains '..'");
  }
  const normalized = path.posix.normalize(remotePathValue);
  if (remoteRoot !== null) {
    const root = path.posix.normalize(remoteRoot);
    if (normalized !== root && !normalized.startsWith(`${root.replace(/\/+$/, "")}/`)) {
      throw pathError("The remote path is outside the configured remote root");
    }
  }
  return normalized;
}

/** True when the resolved path is inside the remote root (used after sftp.realpath). */
export function remotePathInside(remotePathValue: string, remoteRoot: string | null): boolean {
  if (remoteRoot === null) {
    return true;
  }
  const root = path.posix.normalize(remoteRoot).replace(/\/+$/, "");
  return remotePathValue === root || remotePathValue.startsWith(`${root}/`);
}
