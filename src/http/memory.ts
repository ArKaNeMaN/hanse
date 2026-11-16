import type { SqliteDatabase } from "../store/index.js";
import {
  readLatestMemorySample,
  readMemoryBuckets,
  readMemorySummary,
} from "../store/memory-samples.js";
import { findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const MEMORY_PATH = /^\/api\/apps\/([^/]+)\/memory$/;

const WINDOW_SECONDS: Record<string, number> = {
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
  "72h": 72 * 60 * 60,
};
const BUCKET_SECONDS: Record<string, number> = {
  "10m": 10 * 60,
  "30m": 30 * 60,
};
const DEFAULT_WINDOW = "24h";
const DEFAULT_BUCKET = "30m";

interface OomRow {
  at: string;
  message: string | null;
}

function json(status: number, value: unknown, headers?: Record<string, string>): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    ...(headers === undefined ? {} : { headers }),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Route matcher for the human-only container-memory read endpoint. */
export function isMemoryRoute(method: string, pathname: string): boolean {
  return method === "GET" && MEMORY_PATH.test(pathname);
}

function readOomEvents(
  db: SqliteDatabase,
  appId: string,
  from: string,
  to: string,
): Array<{ at: string; kind: "oom_killed"; message: string | null }> {
  const rows = db
    .prepare(
      `SELECT created_at AS at, message
       FROM agent_run_events
       WHERE app_id = ?
         AND created_at >= ?
         AND created_at < ?
         AND (reason = 'oom_killed' OR error_code = 'oom_killed')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(appId, from, to) as OomRow[];
  return rows.map((row) => ({ at: row.at, kind: "oom_killed", message: row.message }));
}

/**
 * `GET /api/apps/:app/memory?project=<id>&window=24h&bucket=30m`
 *
 * Human-only, project-scoped, `no-store`, with the same 400/404/409 semantics as `/process`.
 * Buckets with no samples are omitted (a gap); the client derives gaps from `start` and
 * `bucketSeconds`. Summary `current`/`limit` are the latest sample inside the window while
 * `lastSampleAt` is the latest overall at or before `to`.
 */
export function handleMemory(deps: HttpDeps, request: HttpRequest): HttpResponse {
  const match = MEMORY_PATH.exec(request.path);
  if (match === null || request.method !== "GET") {
    return json(404, { error: "not found" });
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may read memory metrics" });
  }
  const projectId = request.query?.project;
  if (projectId === undefined || projectId.length === 0) {
    return json(400, { error: "project query is required" });
  }
  const project = deps.getProjects().find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return json(404, { error: "project not found" });
  }
  const found = findApp(deps, project.id, safeDecode(match[1] ?? ""));
  if (found === undefined) {
    return json(404, { error: "application not found" });
  }
  if (found.app.deleting || found.project.deleting) {
    return json(409, { error: "application is pending deletion", code: "deletion_pending" });
  }

  const rawWindow = request.query?.window;
  const window = rawWindow === undefined ? DEFAULT_WINDOW : rawWindow;
  const windowSeconds = WINDOW_SECONDS[window];
  if (windowSeconds === undefined) {
    return json(400, { error: "window must be one of 6h, 24h, 72h" });
  }
  const rawBucket = request.query?.bucket;
  const bucket = rawBucket === undefined ? DEFAULT_BUCKET : rawBucket;
  const bucketSeconds = BUCKET_SECONDS[bucket];
  if (bucketSeconds === undefined) {
    return json(400, { error: "bucket must be one of 10m, 30m" });
  }
  if (window === "72h" && bucket === "10m") {
    return json(400, { error: "bucket 10m is not allowed for a 72h window" });
  }

  const bucketMs = bucketSeconds * 1_000;
  const now = Date.now();
  const to = new Date(now).toISOString();
  // Align the window start down to a bucket boundary so the first/last buckets are full shaped.
  const from = new Date(
    Math.floor((now - windowSeconds * 1_000) / bucketMs) * bucketMs,
  ).toISOString();

  const summary = readMemorySummary(deps.db, found.app.id, from, to);
  const latest = readLatestMemorySample(deps.db, found.app.id, to);
  const buckets = readMemoryBuckets(deps.db, found.app.id, from, to, bucketSeconds);
  const events = readOomEvents(deps.db, found.app.id, from, to);

  return json(
    200,
    {
      appId: found.app.id,
      window: { from, to, bucketSeconds },
      summary: {
        currentBytes: summary.currentBytes,
        minBytes: summary.minBytes,
        peakBytes: summary.peakBytes,
        averageBytes: summary.averageBytes,
        limitBytes: summary.limitBytes,
        samples: summary.samples,
        lastSampleAt: latest?.sampledAt ?? null,
      },
      buckets,
      events,
    },
    { "cache-control": "no-store" },
  );
}
