import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RUNTIME_DIRS = new Set<string>();
let cleanupRegistered = false;

/** Create a `0700` runtime directory swept on process exit. */
export function createRuntimeDir(prefix: string, root: string = tmpdir()): string {
  const dir = mkdtempSync(path.join(root, prefix));
  chmodSync(dir, 0o700);
  RUNTIME_DIRS.add(dir);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      for (const entry of RUNTIME_DIRS) {
        try {
          rmSync(entry, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup during process exit.
        }
      }
      RUNTIME_DIRS.clear();
    });
  }
  return dir;
}

export interface SweepStaleRuntimeDirsOptions {
  root?: string;
  prefix: string;
  maxAgeMs?: number;
  now?: number;
  /** Never delete a directory inside this root (for example the workspace). */
  protectedRoot?: string;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Remove directories older than `maxAgeMs` (default one hour) from a temp root. */
export function sweepStaleRuntimeDirs(options: SweepStaleRuntimeDirsOptions): void {
  const root = options.root ?? tmpdir();
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(options.prefix)) {
      continue;
    }
    const target = path.join(root, name);
    if (RUNTIME_DIRS.has(target)) {
      continue;
    }
    if (options.protectedRoot !== undefined && isInside(options.protectedRoot, target)) {
      continue;
    }
    try {
      const info = lstatSync(target);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        continue;
      }
      if (uid !== undefined && info.uid !== uid) {
        continue;
      }
      if (now - info.mtimeMs < maxAgeMs) {
        continue;
      }
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Another process may have removed it; the sweep stays best-effort.
    }
  }
}
