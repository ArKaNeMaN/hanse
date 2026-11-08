import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger.js";
import type { SqliteDatabase } from "../store/index.js";
import type { LifecycleActivity } from "./lifecycle-activity.js";

export interface DrainState {
  draining: boolean;
  drainId: string | null;
  drainingSince: string | null;
}

export interface WalCheckpoint {
  busy: number;
  log: number;
  checkpointed: number;
}

export interface DrainReport {
  drainId: string;
  draining: true;
  drained: boolean;
  inFlightLifecycle: number;
  inFlightHttp: number;
  schemaVersion: number | null;
  revision: string;
  walCheckpoint: WalCheckpoint;
}

export interface DrainOptions {
  timeoutSeconds?: number;
  schemaVersion?: number | null;
  revision?: string;
}

export interface DrainControllerOptions {
  db: SqliteDatabase;
  lifecycle: LifecycleActivity;
  logger?: Logger;
  now?: () => number;
  startedAt?: string;
}

interface DeployStateRow {
  draining: number;
  drain_id: string | null;
  draining_since: string | null;
  updated_at: string;
}

const DEFAULT_DRAIN_TIMEOUT_SECONDS = 25;
const MAX_DRAIN_TIMEOUT_SECONDS = 120;
const QUIESCE_POLL_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class DrainController {
  readonly startedAt: string;
  readonly #db: SqliteDatabase;
  readonly #lifecycle: LifecycleActivity;
  readonly #logger: Logger | undefined;
  readonly #now: () => number;
  readonly #streams = new Set<() => void>();
  #draining = false;
  #drainId: string | null = null;
  #drainingSince: string | null = null;
  #inFlightHttp = 0;
  #shuttingDown = false;
  #shutdownAt: string | null = null;
  #drainPromise: Promise<DrainReport> | undefined;

  constructor(options: DrainControllerOptions) {
    this.#db = options.db;
    this.#lifecycle = options.lifecycle;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? new Date(this.#now()).toISOString();
    this.#read();
  }

  initialize(options: { startDrained?: boolean } = {}): void {
    if (options.startDrained === true) {
      this.#applyDrain(randomUUID());
      return;
    }
    this.#clear();
  }

  get inFlightHttp(): number {
    return this.#inFlightHttp;
  }

  get shutdownAt(): string | null {
    return this.#shutdownAt;
  }

  state(): DrainState {
    return {
      draining: this.#draining,
      drainId: this.#drainId,
      drainingSince: this.#drainingSince,
    };
  }

  isDraining(): boolean {
    return this.#draining;
  }

  isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  trackHttp(counted = true): () => void {
    if (!counted) {
      return () => undefined;
    }
    this.#inFlightHttp += 1;
    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      this.#inFlightHttp = Math.max(0, this.#inFlightHttp - 1);
    };
  }

  registerStream(close: () => void): () => void {
    this.#streams.add(close);
    return () => {
      this.#streams.delete(close);
    };
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
    this.#shutdownAt = new Date(this.#now()).toISOString();
    this.#applyDrain(this.#drainId ?? randomUUID());
    this.#closeStreams();
  }

  resume(): DrainState {
    this.#shuttingDown = false;
    this.#shutdownAt = null;
    this.#clear();
    return this.state();
  }

  async drain(options: DrainOptions = {}): Promise<DrainReport> {
    this.#applyDrain(this.#drainId ?? randomUUID());
    this.#closeStreams();
    if (this.#drainPromise !== undefined) {
      return await this.#drainPromise;
    }
    const timeoutSeconds = clampTimeout(options.timeoutSeconds);
    const task = this.#waitAndCheckpoint(timeoutSeconds * 1000, options);
    this.#drainPromise = task;
    try {
      return await task;
    } finally {
      this.#drainPromise = undefined;
    }
  }

  async awaitQuiescence(timeoutMs: number): Promise<boolean> {
    this.#closeStreams();
    return await this.#waitUntilQuiet(timeoutMs);
  }

  checkpoint(): WalCheckpoint {
    try {
      const raw = this.#db.pragma("wal_checkpoint(TRUNCATE)") as unknown;
      const row = Array.isArray(raw)
        ? (raw[0] as Record<string, unknown> | undefined)
        : (raw as Record<string, unknown> | undefined);
      return {
        busy: Number(row?.busy ?? 0),
        log: Number(row?.log ?? 0),
        checkpointed: Number(row?.checkpointed ?? 0),
      };
    } catch (error) {
      this.#logger?.warn("wal_checkpoint_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { busy: 1, log: 0, checkpointed: 0 };
    }
  }

  async #waitAndCheckpoint(timeoutMs: number, options: DrainOptions): Promise<DrainReport> {
    const drained = await this.#waitUntilQuiet(timeoutMs);
    const walCheckpoint = this.checkpoint();
    return {
      drainId: this.#drainId ?? "",
      draining: true,
      drained,
      inFlightLifecycle: this.#lifecycle.count,
      inFlightHttp: this.#inFlightHttp,
      schemaVersion: options.schemaVersion ?? null,
      revision: options.revision ?? "unknown",
      walCheckpoint,
    };
  }

  async #waitUntilQuiet(timeoutMs: number): Promise<boolean> {
    const deadline = this.#now() + Math.max(0, timeoutMs);
    while (this.#now() < deadline) {
      if (this.#lifecycle.count === 0 && this.#inFlightHttp === 0) {
        return true;
      }
      await sleep(QUIESCE_POLL_MS);
    }
    return this.#lifecycle.count === 0 && this.#inFlightHttp === 0;
  }

  #closeStreams(): void {
    for (const close of [...this.#streams]) {
      this.#streams.delete(close);
      try {
        close();
      } catch {
        // A stream that is already gone must not abort the drain.
      }
    }
  }

  #read(): void {
    let row: DeployStateRow | undefined;
    try {
      row = this.#db
        .prepare(
          "SELECT draining, drain_id, draining_since, updated_at FROM deploy_state WHERE id = 1",
        )
        .get() as DeployStateRow | undefined;
    } catch {
      row = undefined;
    }
    this.#draining = row?.draining === 1;
    this.#drainId = row?.drain_id ?? null;
    this.#drainingSince = row?.draining_since ?? null;
  }

  #applyDrain(drainId: string): void {
    if (!this.#draining) {
      this.#draining = true;
      this.#drainingSince = new Date(this.#now()).toISOString();
    }
    this.#drainId = drainId;
    this.#write(true, drainId, this.#drainingSince);
  }

  #clear(): void {
    this.#draining = false;
    this.#drainId = null;
    this.#drainingSince = null;
    this.#write(false, null, null);
  }

  #write(draining: boolean, drainId: string | null, drainingSince: string | null): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO deploy_state (id, draining, drain_id, draining_since, updated_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             draining = excluded.draining,
             drain_id = excluded.drain_id,
             draining_since = excluded.draining_since,
             updated_at = excluded.updated_at`,
        )
        .run(draining ? 1 : 0, drainId, drainingSince, new Date(this.#now()).toISOString());
    } catch (error) {
      this.#logger?.warn("deploy_state_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_DRAIN_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_DRAIN_TIMEOUT_SECONDS, Math.max(0, Math.floor(value)));
}
