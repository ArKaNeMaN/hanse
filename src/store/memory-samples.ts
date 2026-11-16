import type { SqliteDatabase } from "./database.js";

/** One persisted container memory sample (working set is the charted series). */
export interface MemorySample {
  appId: string;
  sampledAt: string;
  usageBytes: number;
  workingSetBytes: number;
  limitBytes: number;
  anonBytes: number | null;
  fileBytes: number | null;
}

/** One aggregated chart bucket. Sampled rows with no data produce no bucket (a gap). */
export interface MemoryBucket {
  /** ISO timestamp of the bucket start, aligned to `bucketSeconds`. */
  start: string;
  minBytes: number;
  maxBytes: number;
  averageBytes: number;
  samples: number;
}

/** Window summary; `lastSampleAt` is the latest sample at or before `to`, even outside the window. */
export interface MemorySummary {
  currentBytes: number | null;
  minBytes: number | null;
  peakBytes: number | null;
  averageBytes: number | null;
  limitBytes: number | null;
  samples: number;
  lastSampleAt: string | null;
}

/** Counts from one insert batch: durable rows plus app ids skipped because the app is gone. */
export interface MemoryInsertResult {
  inserted: number;
  skipped: number;
}

export const MEMORY_SAMPLE_INTERVAL_MS = 30_000;
export const MEMORY_SAMPLE_RETENTION_MS = 72 * 60 * 60 * 1_000;
export const MEMORY_SAMPLE_PRUNE_BATCH = 500;

const SAMPLE_COLUMNS = `
  app_id AS appId,
  sampled_at AS sampledAt,
  usage_bytes AS usageBytes,
  working_set_bytes AS workingSetBytes,
  limit_bytes AS limitBytes,
  anon_bytes AS anonBytes,
  file_bytes AS fileBytes`;

interface BucketRow {
  bucket_epoch: number;
  min_bytes: number;
  max_bytes: number;
  average_bytes: number;
  samples: number;
}

/**
 * Insert one batch with a coordinator-assigned `sampledAt` in a single transaction.
 *
 * `INSERT ... SELECT ... WHERE EXISTS` skips a container whose app was deleted between listing and
 * insert without aborting the batch; `ON CONFLICT DO NOTHING` makes a replayed tick idempotent.
 * Unlike `INSERT OR IGNORE`, CHECK/FK violations still surface.
 */
export function insertMemorySamples(
  db: SqliteDatabase,
  samples: ReadonlyArray<Omit<MemorySample, "sampledAt">>,
  sampledAt: string,
): MemoryInsertResult {
  if (samples.length === 0) {
    return { inserted: 0, skipped: 0 };
  }

  const exists = db.prepare("SELECT 1 AS present FROM apps WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO app_memory_samples
       (app_id, sampled_at, usage_bytes, working_set_bytes, limit_bytes, anon_bytes, file_bytes)
     SELECT @appId, @sampledAt, @usageBytes, @workingSetBytes, @limitBytes, @anonBytes, @fileBytes
     WHERE EXISTS (SELECT 1 FROM apps WHERE id = @appId)
     ON CONFLICT(app_id, sampled_at) DO NOTHING`,
  );

  let inserted = 0;
  let skipped = 0;
  const loggedUnknown = new Set<string>();

  const run = db.transaction(() => {
    for (const sample of samples) {
      if (exists.get(sample.appId) === undefined) {
        skipped += 1;
        if (!loggedUnknown.has(sample.appId)) {
          loggedUnknown.add(sample.appId);
          console.warn(`[store] memory_sample_unknown_app app=${sample.appId}`);
        }
        continue;
      }
      const result = insert.run({
        appId: sample.appId,
        sampledAt,
        usageBytes: sample.usageBytes,
        workingSetBytes: sample.workingSetBytes,
        limitBytes: sample.limitBytes,
        anonBytes: sample.anonBytes,
        fileBytes: sample.fileBytes,
      });
      inserted += result.changes;
    }
  });
  run();

  return { inserted, skipped };
}

/**
 * Read working-set min/max/average per time bucket.
 *
 * The explicit `CAST` is required: better-sqlite3 binds JS numbers as REAL, and REAL division would
 * create one bucket per sample instead of one group per `bucketSeconds` interval.
 */
export function readMemoryBuckets(
  db: SqliteDatabase,
  appId: string,
  from: string,
  to: string,
  bucketSeconds: number,
): MemoryBucket[] {
  if (!Number.isInteger(bucketSeconds) || bucketSeconds <= 0) {
    throw new RangeError("bucketSeconds must be a positive integer");
  }

  const rows = db
    .prepare(
      `SELECT CAST(strftime('%s', sampled_at) AS INTEGER) / CAST(@bucketSeconds AS INTEGER) AS bucket_epoch,
              MIN(working_set_bytes) AS min_bytes,
              MAX(working_set_bytes) AS max_bytes,
              CAST(AVG(working_set_bytes) AS INTEGER) AS average_bytes,
              COUNT(*) AS samples
       FROM app_memory_samples
       WHERE app_id = @appId AND sampled_at >= @from AND sampled_at < @to
       GROUP BY bucket_epoch
       ORDER BY bucket_epoch`,
    )
    .all({ appId, from, to, bucketSeconds }) as BucketRow[];

  return rows.map((row) => ({
    start: new Date(row.bucket_epoch * bucketSeconds * 1_000).toISOString(),
    minBytes: row.min_bytes,
    maxBytes: row.max_bytes,
    averageBytes: row.average_bytes,
    samples: row.samples,
  }));
}

/**
 * Window aggregates. `currentBytes`/`limitBytes` come from the latest sample inside
 * `[from, to)`; every other field is `null` for an empty window while `lastSampleAt` still reports
 * the newest sample at or before `to`.
 */
export function readMemorySummary(
  db: SqliteDatabase,
  appId: string,
  from: string,
  to: string,
): MemorySummary {
  const aggregate = db
    .prepare(
      `SELECT MIN(working_set_bytes) AS minBytes,
              MAX(working_set_bytes) AS maxBytes,
              CAST(AVG(working_set_bytes) AS INTEGER) AS averageBytes,
              COUNT(*) AS samples
       FROM app_memory_samples
       WHERE app_id = @appId AND sampled_at >= @from AND sampled_at < @to`,
    )
    .get({ appId, from, to }) as {
    minBytes: number | null;
    maxBytes: number | null;
    averageBytes: number | null;
    samples: number;
  };

  const latest = readLatestMemorySample(db, appId, to);
  const inWindow = latest !== null && latest.sampledAt >= from ? latest : null;
  if (aggregate.samples === 0) {
    return {
      currentBytes: null,
      minBytes: null,
      peakBytes: null,
      averageBytes: null,
      limitBytes: null,
      samples: 0,
      lastSampleAt: latest?.sampledAt ?? null,
    };
  }

  return {
    currentBytes: inWindow?.workingSetBytes ?? null,
    minBytes: aggregate.minBytes,
    peakBytes: aggregate.maxBytes,
    averageBytes: aggregate.averageBytes,
    limitBytes: inWindow?.limitBytes ?? null,
    samples: aggregate.samples,
    lastSampleAt: latest?.sampledAt ?? null,
  };
}

/** Newest sample at or before `to`, or `null`; bounded so a future clock cannot leak in. */
export function readLatestMemorySample(
  db: SqliteDatabase,
  appId: string,
  to: string,
): MemorySample | null {
  const row = db
    .prepare(
      `SELECT ${SAMPLE_COLUMNS} FROM app_memory_samples
       WHERE app_id = ? AND sampled_at <= ?
       ORDER BY sampled_at DESC LIMIT 1`,
    )
    .get(appId, to) as MemorySample | undefined;
  return row ?? null;
}

/** Delete samples older than {@link MEMORY_SAMPLE_RETENTION_MS} before `now`, in bounded batches. */
export function pruneMemorySamples(db: SqliteDatabase, now: string): number {
  const cutoff = new Date(Date.parse(now) - MEMORY_SAMPLE_RETENTION_MS).toISOString();
  let removed = 0;
  while (true) {
    const result = db
      .prepare(
        `DELETE FROM app_memory_samples
         WHERE rowid IN (
           SELECT rowid FROM app_memory_samples
           WHERE sampled_at < ?
           ORDER BY sampled_at ASC
           LIMIT ?
         )`,
      )
      .run(cutoff, MEMORY_SAMPLE_PRUNE_BATCH);
    removed += result.changes;
    if (result.changes < MEMORY_SAMPLE_PRUNE_BATCH) return removed;
  }
}
