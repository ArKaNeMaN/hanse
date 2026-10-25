/**
 * Process-local keyed mutex for the short chat state critical sections (design §D6.7).
 *
 * The lock is deliberately in-memory: SQLite writes are serialized by the database, and the lock
 * only closes the read/decide/write window between the HTTP routes, the confirmation service, and
 * the sweep in this coordinator process. It is never held across an upstream prompt dispatch.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

/** One lock domain for every writer that touches a session's chat state. */
export const sessionLocks = new KeyedMutex();

export function sessionLockKey(appId: string, sessionId: string): string {
  return `${appId}\u0000${sessionId}`;
}
