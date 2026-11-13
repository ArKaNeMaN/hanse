import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isValidAppId } from "../agent/spec.js";
import { boundedErrorMessage } from "../runtime/build-spec.js";
import type { RunnerBaseKind, RunnerImageRecord, RunnerImageStatus } from "./images.js";
import { RECORD_VERSION } from "./versions.js";

/** Persisted build logs keep only this tail; the live record may hold a larger bounded tail. */
export const MAX_BUILD_RECORD_LOG_BYTES = 128 * 1024;
export const MAX_BUILD_RECORDS = 200;
export const MAX_BUILD_RECORD_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const BUILD_ID = /^[A-Za-z0-9-]{1,64}$/;
const RECORD_FILE = /^[A-Za-z0-9-]{1,64}\.json$/;
const STATUSES: ReadonlySet<string> = new Set([
  "missing",
  "building",
  "ready",
  "error",
  "interrupted",
  "cancelled",
]);
const BASE_KINDS: ReadonlySet<string> = new Set(["default", "base", "explicit", "unknown"]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOG_TRUNCATED_PREFIX = "[logs truncated]\n";

export interface BuildRecordStoreOptions {
  readonly dir: string;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

interface LoadedEntry {
  record: RunnerImageRecord;
  file: string;
  timestamp: number;
}

/**
 * Durable, bounded build records.
 *
 * One JSON file per build under `dir` (0600, atomic temp+rename, 0700 directory). Loading adopts
 * only the current record version; unknown, newer, or invalid files are skipped. A record that was
 * still `building` becomes `interrupted` on load because the process that owned it is gone.
 *
 * Every filesystem failure is swallowed into a bounded warning: the runner keeps serving from
 * in-memory records rather than crashing because its records volume is missing or read-only.
 */
export class BuildRecordStore {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #warn: (message: string) => void;

  constructor(options: BuildRecordStoreOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? Date.now;
    this.#warn =
      options.warn ??
      ((message: string) => {
        process.stderr.write(`hanse runner: ${message}\n`);
      });
  }

  /** Load adopted records, newest first, after pruning and converting interrupted builds. */
  load(): RunnerImageRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch (error) {
      if (!isMissing(error)) {
        this.#warn(`cannot read build records: ${boundedErrorMessage(error)}`);
      }
      return [];
    }

    const now = this.#now();
    const entries: LoadedEntry[] = [];
    for (const name of names) {
      if (!RECORD_FILE.test(name)) continue;
      const file = path.join(this.#dir, name);
      let text: string;
      let mtimeMs: number;
      try {
        const info = statSync(file);
        if (!info.isFile()) continue;
        mtimeMs = info.mtimeMs;
        text = readFileSync(file, "utf8");
      } catch (error) {
        this.#warn(`cannot read build record: ${boundedErrorMessage(error)}`);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        continue;
      }
      const record = parseStoredRecord(raw);
      if (record === undefined) continue;
      const parsed = record.updatedAt === null ? Number.NaN : Date.parse(record.updatedAt);
      entries.push({
        record,
        file,
        timestamp: Number.isFinite(parsed) ? parsed : mtimeMs,
      });
    }

    entries.sort((left, right) => right.timestamp - left.timestamp);
    const kept: LoadedEntry[] = [];
    for (const entry of entries) {
      if (now - entry.timestamp > MAX_BUILD_RECORD_AGE_MS || kept.length >= MAX_BUILD_RECORDS) {
        removeQuietly(entry.file);
        continue;
      }
      kept.push(entry);
    }

    for (const entry of kept) {
      if (entry.record.status !== "building") continue;
      entry.record = {
        ...entry.record,
        status: "interrupted",
        error: "runner restarted during image build",
        updatedAt: new Date(now).toISOString(),
      };
      this.#write(entry.record);
    }
    return kept.map((entry) => ({ ...entry.record }));
  }

  /** Persist one record and prune old/overflow files. Never throws. */
  save(record: RunnerImageRecord): void {
    this.#write(record);
  }

  /** Remove every persisted record for an app. Never throws. */
  removeApp(appId: string): void {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch (error) {
      if (!isMissing(error)) {
        this.#warn(`cannot read build records: ${boundedErrorMessage(error)}`);
      }
      return;
    }
    for (const name of names) {
      if (!RECORD_FILE.test(name)) continue;
      const file = path.join(this.#dir, name);
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
        const record = parseStoredRecord(raw);
        if (record !== undefined && record.appId === appId) {
          removeQuietly(file);
        }
      } catch {
        // Unreadable or invalid records are left for the loader to skip.
      }
    }
  }

  #write(record: RunnerImageRecord): boolean {
    const buildId = record.buildId;
    if (buildId === null || !BUILD_ID.test(buildId)) {
      this.#warn("cannot persist an image build record without a safe build id");
      return false;
    }
    const finalPath = path.join(this.#dir, `${buildId}.json`);
    const tempPath = path.join(this.#dir, `.${buildId}.${randomUUID()}.tmp`);
    let handle: number | undefined;
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const directory = statSync(this.#dir);
      if ((directory.mode & 0o077) !== 0) {
        // The runner has no CAP_FOWNER and cannot chmod a directory owned by the host user;
        // records are still 0600, but the directory should be tightened by the operator.
        this.#warn("build records directory permissions are broader than 0700");
      }
      const payload = {
        version: RECORD_VERSION,
        ...record,
        logs: boundRecordLogs(record.logs),
      };
      handle = openSync(tempPath, "wx", 0o600);
      writeSync(handle, Buffer.from(JSON.stringify(payload), "utf8"));
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      renameSync(tempPath, finalPath);
    } catch (error) {
      if (handle !== undefined) {
        try {
          closeSync(handle);
        } catch {
          // already closed
        }
      }
      removeQuietly(tempPath);
      this.#warn(`cannot write image build record: ${boundedErrorMessage(error)}`);
      return false;
    }
    this.#prune();
    return true;
  }

  /** Enforce the count and age caps by file time; the just-written record is the newest. */
  #prune(): void {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch (error) {
      this.#warn(`cannot prune image build records: ${boundedErrorMessage(error)}`);
      return;
    }
    const now = this.#now();
    const entries: { file: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!RECORD_FILE.test(name)) continue;
      const file = path.join(this.#dir, name);
      try {
        entries.push({ file, mtimeMs: statSync(file).mtimeMs });
      } catch {
        // Concurrently removed; nothing to prune.
      }
    }
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      if (index >= MAX_BUILD_RECORDS || now - entry.mtimeMs > MAX_BUILD_RECORD_AGE_MS) {
        removeQuietly(entry.file);
      }
    }
  }
}

/** Bound persisted logs while keeping the newest bytes. */
export function boundRecordLogs(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_BUILD_RECORD_LOG_BYTES) return text;
  const prefixBytes = Buffer.byteLength(LOG_TRUNCATED_PREFIX);
  const tail = bytes.subarray(bytes.length - (MAX_BUILD_RECORD_LOG_BYTES - prefixBytes));
  return `${LOG_TRUNCATED_PREFIX}${tail.toString("utf8")}`;
}

function parseStoredRecord(value: unknown): RunnerImageRecord | undefined {
  if (!isRecord(value) || value.version !== RECORD_VERSION) return undefined;
  const appId = value.appId;
  if (typeof appId !== "string" || !isValidAppId(appId)) return undefined;
  const buildId = value.buildId;
  if (typeof buildId !== "string" || !BUILD_ID.test(buildId)) return undefined;
  const status = value.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined;
  return {
    appId,
    status: status as RunnerImageStatus,
    imageRef: stringOrNull(value.imageRef),
    imageId: stringOrNull(value.imageId),
    buildId,
    logs: typeof value.logs === "string" ? value.logs : "",
    error: stringOrNull(value.error),
    updatedAt: stringOrNull(value.updatedAt),
    targetRef: stringOrNull(value.targetRef),
    specHash: stringOrNull(value.specHash),
    specHashVersion: integerOrNull(value.specHashVersion),
    hashVersion: integerOrNull(value.hashVersion),
    baseKind: baseKindOrNull(value.baseKind),
    baseRef: stringOrNull(value.baseRef),
    baseDigest: digestOrNull(value.baseDigest),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function baseKindOrNull(value: unknown): RunnerBaseKind | null {
  return typeof value === "string" && BASE_KINDS.has(value) ? (value as RunnerBaseKind) : null;
}

function digestOrNull(value: unknown): string | null {
  return typeof value === "string" && DIGEST.test(value) ? value : null;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort; a stale file is pruned on the next load/save.
  }
}
