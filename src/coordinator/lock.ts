import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LockHandle {
  app: string;
  owner: string;
  path: string;
  release(): void;
}

export class LockUnavailableError extends Error {
  constructor(app: string, owner: string) {
    super(`Writer lock for "${app}" is already held (attempted owner: ${owner})`);
    this.name = "LockUnavailableError";
  }
}

interface LockHolder {
  owner: string;
  pid: number;
  startedAt: string;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EEXIST"
  );
}

/**
 * Cross-process writer lock for one application.
 *
 * Node exposes no kernel `flock`, so this uses an `O_EXCL` lock file carrying the holder's pid plus a
 * liveness check to reclaim a lock left by a dead process. Correct on a single node; not a
 * distributed lock.
 */
export class FileWriterLock {
  readonly #root: string;
  readonly #isAlive: (pid: number) => boolean;

  constructor(root: string, isAlive: (pid: number) => boolean = defaultIsAlive) {
    this.#root = root;
    this.#isAlive = isAlive;
  }

  lockPath(app: string): string {
    const safe = app.replace(/[^a-zA-Z0-9._-]/g, "-");
    return path.join(this.#root, "locks", `${safe}.lock`);
  }

  acquire(app: string, owner: string): LockHandle {
    const file = this.lockPath(app);
    mkdirSync(path.dirname(file), { recursive: true });
    const holder: LockHolder = { owner, pid: process.pid, startedAt: new Date().toISOString() };

    if (!this.#tryWrite(file, holder)) {
      const existing = this.#readHolder(file);
      if (existing !== undefined && this.#isAlive(existing.pid)) {
        throw new LockUnavailableError(app, owner);
      }
      this.#steal(file, holder, app, owner);
    }

    return {
      app,
      owner,
      path: file,
      release: () => {
        rmSync(file, { force: true });
      },
    };
  }

  isHeld(app: string): boolean {
    const existing = this.#readHolder(this.lockPath(app));
    return existing !== undefined && this.#isAlive(existing.pid);
  }

  #tryWrite(file: string, holder: LockHolder): boolean {
    try {
      writeFileSync(file, JSON.stringify(holder), { flag: "wx" });
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) {
        return false;
      }
      throw error;
    }
  }

  #steal(file: string, holder: LockHolder, app: string, owner: string): void {
    writeFileSync(file, JSON.stringify(holder));
    const check = this.#readHolder(file);
    if (check === undefined || check.owner !== owner || check.pid !== holder.pid) {
      throw new LockUnavailableError(app, owner);
    }
  }

  #readHolder(file: string): LockHolder | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as LockHolder).pid === "number" &&
        typeof (parsed as LockHolder).owner === "string"
      ) {
        return parsed as LockHolder;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
