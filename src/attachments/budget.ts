/**
 * Read budgets for attachment-heavy payloads (design §D5/D8).
 *
 * These are *read-budget* ceilings, not hard RSS limits: a caller reserves the worst-case peak
 * (raw chunks + concatenation + decoded string + parsed object = cap x 4) and releases it when the
 * projection is done. The accounted ceiling is 320 MiB: 192 MiB history + 96 MiB app stream +
 * 32 MiB blocking.
 */

export const HISTORY_READ_BUDGET_BYTES = 192 * 1024 * 1024;
export const HISTORY_READ_WAIT_MS = 2_000;
export const APP_STREAM_FRAME_BUDGET_BYTES = 32 * 1024 * 1024;
export const APP_STREAM_HEAP_MULTIPLIER = 3;
export const BLOCKING_RESPONSE_BUDGET_BYTES = 32 * 1024 * 1024;

interface Waiter {
  bytes: number;
  resolve: (release: (() => void) | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

function releaseOnce(amount: number, release: (bytes: number) => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release(amount);
  };
}

/**
 * Heap-aware semaphore for history reads. A read reserves `cap * 4`; a full 48 MiB read consumes
 * the budget and smaller reads wait. A waiter gives up after the configured timeout.
 */
export class HistoryReadBudget {
  readonly #limit: number;
  readonly #waitMs: number;
  #used = 0;
  #waiters: Waiter[] = [];
  #disposed = false;

  constructor(limit = HISTORY_READ_BUDGET_BYTES, waitMs = HISTORY_READ_WAIT_MS) {
    this.#limit = limit;
    this.#waitMs = waitMs;
  }

  get usedBytes(): number {
    return this.#used;
  }

  get limitBytes(): number {
    return this.#limit;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  /** Reserve `bytes`, or wait up to `waitMs` for room. Returns undefined on timeout. */
  async acquire(bytes: number): Promise<(() => void) | undefined> {
    if (this.#disposed) return undefined;
    const amount = Math.max(0, bytes);
    if (amount > this.#limit) return undefined;
    if (this.#used + amount <= this.#limit) {
      this.#used += amount;
      return releaseOnce(amount, (value) => this.release(value));
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        bytes: amount,
        resolve,
        timer: setTimeout(() => {
          this.#removeWaiter(waiter);
          resolve(undefined);
        }, this.#waitMs),
      };
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
    });
  }

  release(bytes: number): void {
    this.#used = Math.max(0, this.#used - Math.max(0, bytes));
    this.#drain();
  }

  resetForTests(): void {
    this.#used = 0;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(undefined);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.resetForTests();
  }

  #removeWaiter(waiter: Waiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
  }

  #drain(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0];
      if (waiter === undefined) return;
      if (this.#used + waiter.bytes > this.#limit) return;
      this.#waiters.shift();
      clearTimeout(waiter.timer);
      this.#used += waiter.bytes;
      waiter.resolve(releaseOnce(waiter.bytes, (value) => this.release(value)));
    }
  }
}

interface StreamWaiter {
  bytes: number;
  priority: boolean;
  resolve: (release: (() => void) | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Reserved headroom for an active sender; zero keeps the full 32 MiB available to every stream. */
export const APP_STREAM_PRIORITY_RESERVE_BYTES = 0;

/**
 * Process-global raw-byte budget for app/legacy event streams. `bytes` are raw frame bytes; the
 * heap multiplier (3x) is reported separately so the accounted ceiling stays 96 MiB.
 */
export class RawStreamBudget {
  readonly #limit: number;
  readonly #priorityReserve: number;
  readonly #waitMs: number;
  #used = 0;
  #waiters: StreamWaiter[] = [];

  constructor(
    limit = APP_STREAM_FRAME_BUDGET_BYTES,
    priorityReserve = APP_STREAM_PRIORITY_RESERVE_BYTES,
    waitMs = 0,
  ) {
    this.#limit = limit;
    this.#priorityReserve = Math.min(priorityReserve, limit);
    this.#waitMs = waitMs;
  }

  get usedBytes(): number {
    return this.#used;
  }

  get limitBytes(): number {
    return this.#limit;
  }

  get heapBytes(): number {
    return this.#limit * APP_STREAM_HEAP_MULTIPLIER;
  }

  /** Synchronous admission for one chunk/partial frame. */
  tryReserve(bytes: number, priority = false): boolean {
    const amount = Math.max(0, bytes);
    const ceiling = priority ? this.#limit : this.#limit - this.#priorityReserve;
    if (this.#used + amount <= ceiling) {
      this.#used += amount;
      return true;
    }
    return false;
  }

  release(bytes: number): void {
    this.#used = Math.max(0, this.#used - Math.max(0, bytes));
    this.#drain();
  }

  resetForTests(): void {
    this.#used = 0;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(undefined);
    }
  }

  /** Optional async admission for callers that can wait; the SSE parser uses `tryReserve`. */
  acquire(bytes: number, priority = false): Promise<(() => void) | undefined> {
    if (this.tryReserve(bytes, priority)) {
      return Promise.resolve(releaseOnce(bytes, (value) => this.release(value)));
    }
    if (this.#waitMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: StreamWaiter = {
        bytes,
        priority,
        resolve,
        timer: setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve(undefined);
        }, this.#waitMs),
      };
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
    });
  }

  #drain(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0];
      if (waiter === undefined) return;
      const ceiling = waiter.priority ? this.#limit : this.#limit - this.#priorityReserve;
      if (this.#used + waiter.bytes > ceiling) return;
      this.#waiters.shift();
      clearTimeout(waiter.timer);
      this.#used += waiter.bytes;
      waiter.resolve(releaseOnce(waiter.bytes, (value) => this.release(value)));
    }
  }
}

/** Process-global budgets shared by every HTTP route in the coordinator process. */
export const historyReadBudget = new HistoryReadBudget();
export const appStreamBudget = new RawStreamBudget();
export const blockingResponseBudget = new HistoryReadBudget(BLOCKING_RESPONSE_BUDGET_BYTES, 2_000);
