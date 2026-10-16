/** Handle for a held writer lock. */
export interface LockHandle {
  app: string;
  owner: string;
  release(): Promise<void>;
}

export interface WriterLock {
  acquire(app: string, owner: string): Promise<LockHandle>;
  isHeld(app: string): boolean;
}

/** Thrown when a writer lock is already held. */
export class LockUnavailableError extends Error {
  constructor(app: string, owner: string) {
    super(`Writer lock for "${app}" is already held (attempted owner: ${owner})`);
    this.name = "LockUnavailableError";
  }
}

/**
 * In-memory writer lock: one writer lane per application.
 * TODO(concurrency): replace with a cross-process lock (file or kernel) so multiple coordinator
 * processes and plugins cannot run two writers against the same application.
 */
export class InMemoryWriterLock implements WriterLock {
  readonly #held = new Map<string, string>();

  async acquire(app: string, owner: string): Promise<LockHandle> {
    if (this.#held.has(app)) {
      throw new LockUnavailableError(app, owner);
    }
    this.#held.set(app, owner);
    return {
      app,
      owner,
      release: async () => {
        if (this.#held.get(app) === owner) {
          this.#held.delete(app);
        }
      },
    };
  }

  isHeld(app: string): boolean {
    return this.#held.has(app);
  }
}
