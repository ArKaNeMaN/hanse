import type { AgentRuntimeClient } from "../agent/client.js";
import type { Logger } from "../logging/logger.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  insertMemorySamples,
  MEMORY_SAMPLE_INTERVAL_MS,
  pruneMemorySamples,
} from "../store/memory-samples.js";

/** Prune at most once per hour; retention is enforced by `pruneMemorySamples`. */
export const MEMORY_SAMPLER_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
/** First retry delay after a runtime failure. */
export const MEMORY_SAMPLER_BASE_BACKOFF_MS = 30_000;
/** Retry delay ceiling; the sampler never disables permanently. */
export const MEMORY_SAMPLER_MAX_BACKOFF_MS = 5 * 60 * 1_000;

export interface AppMemorySamplerOptions {
  db: SqliteDatabase;
  runtime: AgentRuntimeClient;
  logger: Logger;
  /** Sampling cadence. Defaults to {@link MEMORY_SAMPLE_INTERVAL_MS} (30 s). */
  intervalMs?: number;
  /** Injectable clock for tests/backoff. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Coordinator-side container-memory sampler (design §7).
 *
 * One tick asks the runner for the current stats of every running managed container and inserts
 * them with a single coordinator timestamp; a replayed tick is idempotent. A runner that does not
 * expose `appStats` (old version, 404, or a transport failure) is retried with capped exponential
 * backoff rather than disabled. This never writes process state or OOM events; the status
 * reconciler owns those.
 */
export class AppMemorySampler {
  readonly #db: SqliteDatabase;
  readonly #runtime: AgentRuntimeClient;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;
  #failing = false;
  #backoffMs = 0;
  #nextAttemptAt = 0;
  #lastPruneAt = 0;

  constructor(options: AppMemorySamplerOptions) {
    this.#db = options.db;
    this.#runtime = options.runtime;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? MEMORY_SAMPLE_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Start the loop and run one immediate tick. Idempotent while running. */
  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#stopped = false;
    const timer = setInterval(() => this.#onInterval(), this.#intervalMs);
    timer.unref?.();
    this.#timer = timer;
    void this.runOnce();
  }

  /**
   * Stop scheduling, await the in-flight tick, and guarantee no further write.
   *
   * The tick re-checks the stopped flag after the runtime call, so a sample collected during
   * shutdown is dropped instead of written after `stop()` resolves. The caller awaits this before
   * closing the database.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const running = this.#running;
    if (running !== undefined) {
      await running;
    }
  }

  /** Run one sampling pass; concurrent callers share the same in-flight promise. */
  runOnce(): Promise<void> {
    if (this.#running !== undefined) {
      return this.#running;
    }
    const run = this.#tick().finally(() => {
      if (this.#running === run) {
        this.#running = undefined;
      }
    });
    this.#running = run;
    return run;
  }

  #onInterval(): void {
    if (this.#stopped) {
      return;
    }
    if (this.#now() < this.#nextAttemptAt) {
      return;
    }
    void this.runOnce();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    const sampledAt = new Date(this.#now()).toISOString();
    let stats: Awaited<ReturnType<NonNullable<AgentRuntimeClient["appStats"]>>>;
    try {
      stats = await this.#runtime.appStats?.();
    } catch (error) {
      this.#recordFailure(error);
      return;
    }
    // A stop() that arrived during the runtime call wins: never write after it.
    if (this.#stopped) {
      return;
    }
    if (stats === undefined) {
      this.#recordFailure(new Error("app stats unavailable (runner 404 or transport failure)"));
      return;
    }
    try {
      insertMemorySamples(
        this.#db,
        stats.apps.map((app) => ({
          appId: app.appId,
          usageBytes: app.usageBytes,
          workingSetBytes: app.workingSetBytes,
          limitBytes: app.limitBytes,
          anonBytes: app.anonBytes,
          fileBytes: app.fileBytes,
        })),
        sampledAt,
      );
      this.#maybePrune();
      this.#recordSuccess();
    } catch (error) {
      this.#recordFailure(error);
    }
  }

  #maybePrune(): void {
    const now = this.#now();
    if (now - this.#lastPruneAt < MEMORY_SAMPLER_PRUNE_INTERVAL_MS) {
      return;
    }
    const removed = pruneMemorySamples(this.#db, new Date(now).toISOString());
    this.#lastPruneAt = now;
    if (removed > 0) {
      this.#logger.debug("app_memory_samples_pruned", { removed });
    }
  }

  #recordFailure(error: unknown): void {
    const message =
      error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    if (!this.#failing) {
      this.#failing = true;
      this.#logger.warn("app_memory_sampler_unavailable", { error: message });
    }
    this.#backoffMs =
      this.#backoffMs === 0
        ? MEMORY_SAMPLER_BASE_BACKOFF_MS
        : Math.min(this.#backoffMs * 2, MEMORY_SAMPLER_MAX_BACKOFF_MS);
    this.#nextAttemptAt = this.#now() + this.#backoffMs;
  }

  #recordSuccess(): void {
    if (this.#failing) {
      this.#failing = false;
      this.#logger.info("app_memory_sampler_recovered");
    }
    this.#backoffMs = 0;
    this.#nextAttemptAt = 0;
  }
}
