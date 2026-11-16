/**
 * Pure helpers for the application Memory card.
 *
 * The card draws a hand-rolled SVG: a per-bucket working-set average line and a min-max band over
 * the same buckets. The API omits buckets that have no samples, so every helper here treats missing
 * buckets as gaps, never as zero values. Formatting and geometry stay framework-free so they can be
 * unit tested without a chart library.
 */

export type MemoryWindow = "6h" | "24h" | "72h";
export type MemoryBucket = "auto" | "10m" | "30m";
export type ResolvedMemoryBucket = "10m" | "30m";

/** One aggregated bucket from `GET /api/apps/:app/memory`; absent buckets are gaps. */
export interface MemorySampleBucket {
  readonly start: string;
  readonly minBytes: number;
  readonly averageBytes: number;
  readonly maxBytes: number;
  /** Present on newer payloads; the chart uses the summary/latest value when absent. */
  readonly limitBytes?: number;
  readonly samples: number;
}

/** Window summary. `currentBytes`/`limitBytes` come from the latest in-window sample. */
export interface MemorySummary {
  readonly currentBytes: number | null;
  readonly minBytes: number | null;
  readonly peakBytes: number | null;
  readonly averageBytes: number | null;
  readonly limitBytes: number | null;
  readonly samples: number;
  /** Latest sample at or before the window end, even when it is older than the window. */
  readonly lastSampleAt: string | null;
}

/** One OOM-killed event returned by the memory endpoint. */
export interface MemoryOomEvent {
  readonly at: string;
  readonly kind: "oom_killed";
  readonly message: string | null;
}

/** Exact response shape of the memory endpoint. */
export interface MemoryPayload {
  readonly appId: string;
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly bucketSeconds: number;
  };
  readonly summary: MemorySummary;
  readonly buckets: readonly MemorySampleBucket[];
  readonly events: readonly MemoryOomEvent[];
}

export const MEMORY_WINDOWS: readonly MemoryWindow[] = ["6h", "24h", "72h"];
export const MEMORY_BUCKETS: readonly MemoryBucket[] = ["auto", "10m", "30m"];

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MINUTE_MS = 60_000;

export function isMemoryWindow(value: unknown): value is MemoryWindow {
  return value === "6h" || value === "24h" || value === "72h";
}

export function isMemoryBucket(value: unknown): value is MemoryBucket {
  return value === "auto" || value === "10m" || value === "30m";
}

/**
 * Resolve a selection to a bucket the API accepts.
 *
 * `auto` means 10 minutes for 6 hours and 30 minutes for 24/72 hours. An explicit 10-minute bucket
 * is clamped to 30 minutes at 72 hours so a hand-edited URL cannot produce a 400.
 */
export function resolveBucket(window: MemoryWindow, bucket: MemoryBucket): ResolvedMemoryBucket {
  if (bucket === "10m") {
    return window === "72h" ? "30m" : "10m";
  }
  if (bucket === "30m") {
    return "30m";
  }
  return window === "6h" ? "10m" : "30m";
}

export function bucketSeconds(bucket: ResolvedMemoryBucket): number {
  return bucket === "10m" ? 600 : 1_800;
}

export function memoryWindowLabel(window: MemoryWindow): string {
  if (window === "6h") return "6 hours";
  if (window === "24h") return "24 hours";
  return "72 hours";
}

function roundNumber(value: number): number {
  const rounded =
    value >= 100
      ? Math.round(value)
      : value >= 10
        ? Math.round(value * 10) / 10
        : Math.round(value * 100) / 100;
  return rounded;
}

/** `412 MiB`, `1.84 GiB`; `—` for missing or invalid values. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes >= GIB) {
    return `${roundNumber(bytes / GIB)} GiB`;
  }
  return `${roundNumber(bytes / MIB)} MiB`;
}

/** `13:42` in a fixed 24-hour clock; `unknown` for an unparseable timestamp. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Map a value in `[min, max]` to a y coordinate in `[height, 0]`.
 *
 * Values outside the domain are clamped so a late sample cannot draw outside the plot. A flat
 * domain returns the baseline instead of dividing by zero.
 */
export function scaleY(value: number, min: number, max: number, height: number): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return 0;
  }
  if (max <= min) {
    return height;
  }
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return height - ratio * height;
}

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
  /** Set on the last point before a missing bucket so the next point starts a new subpath. */
  readonly gapAfter?: boolean;
}

export interface ChartBandPoint {
  readonly x: number;
  /** Screen y of the peak (largest byte value) at this bucket. */
  readonly upperY: number;
  /** Screen y of the trough (smallest byte value) at this bucket. */
  readonly lowerY: number;
  readonly gapAfter?: boolean;
}

function coord(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function lineRun(run: readonly ChartPoint[]): string {
  const first = run[0];
  if (first === undefined) return "";
  let path = `M ${coord(first.x)} ${coord(first.y)}`;
  if (run.length === 1) {
    // A one-point run has no visible length; nudge it so the stroke renders.
    return `${path} l 0.01 0`;
  }
  for (let index = 1; index < run.length; index += 1) {
    const point = run[index];
    if (point === undefined) continue;
    path += ` L ${coord(point.x)} ${coord(point.y)}`;
  }
  return path;
}

/** Build a line path, splitting into separate subpaths at each `gapAfter`. */
export function linePath(points: readonly ChartPoint[]): string {
  const runs: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    current.push(point);
    if (point.gapAfter === true) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs
    .map(lineRun)
    .filter((path) => path.length > 0)
    .join(" ");
}

function bandRun(run: readonly ChartBandPoint[]): string {
  const first = run[0];
  if (first === undefined) return "";
  let path = `M ${coord(first.x)} ${coord(first.upperY)}`;
  for (let index = 1; index < run.length; index += 1) {
    const point = run[index];
    if (point === undefined) continue;
    path += ` L ${coord(point.x)} ${coord(point.upperY)}`;
  }
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const point = run[index];
    if (point === undefined) continue;
    path += ` L ${coord(point.x)} ${coord(point.lowerY)}`;
  }
  return `${path} Z`;
}

/** Build a closed min-max band path, splitting into separate shapes at each `gapAfter`. */
export function bandPath(points: readonly ChartBandPoint[]): string {
  const runs: ChartBandPoint[][] = [];
  let current: ChartBandPoint[] = [];
  for (const point of points) {
    current.push(point);
    if (point.gapAfter === true) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs
    .map(bandRun)
    .filter((path) => path.length > 0)
    .join(" ");
}

/** Index of the bucket start nearest to `at`; `-1` for an empty or unparseable set. */
export function nearestBucket(
  buckets: readonly { readonly start: string }[],
  at: string | number,
): number {
  if (buckets.length === 0) return -1;
  const target = typeof at === "number" ? at : Date.parse(at);
  if (Number.isNaN(target)) return -1;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  buckets.forEach((bucket, index) => {
    const start = Date.parse(bucket.start);
    if (Number.isNaN(start)) return;
    const distance = Math.abs(start - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/**
 * Keep at most one OOM event per 60 seconds.
 *
 * The pipeline can record many kills inside a crash loop; one marker per minute keeps the chart
 * readable while the caption states the coalescing rule.
 */
export function coalesceOomEvents(events: readonly MemoryOomEvent[]): MemoryOomEvent[] {
  const sorted = [...events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const kept: MemoryOomEvent[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const event of sorted) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) continue;
    if (at - previous < MINUTE_MS) continue;
    kept.push(event);
    previous = at;
  }
  return kept;
}

/** Accessible summary for the chart's `<desc>`. */
export function chartDescription(
  window: MemoryWindow,
  buckets: readonly MemorySampleBucket[],
  events: readonly MemoryOomEvent[],
  summary?: Pick<MemorySummary, "samples" | "peakBytes" | "currentBytes">,
): string {
  const label = memoryWindowLabel(window);
  const samples = summary?.samples ?? buckets.reduce((total, bucket) => total + bucket.samples, 0);
  if (samples === 0 || buckets.length === 0) {
    return `Working set memory over the last ${label}. No samples in this range.`;
  }
  const parts = [
    `Working set memory over the last ${label}`,
    `${buckets.length} buckets with samples`,
  ];
  if (summary?.currentBytes !== null && summary?.currentBytes !== undefined) {
    parts.push(`current ${formatBytes(summary.currentBytes)}`);
  }
  if (summary?.peakBytes !== null && summary?.peakBytes !== undefined) {
    parts.push(`peak ${formatBytes(summary.peakBytes)}`);
  }
  const oom = coalesceOomEvents(events);
  if (oom.length > 0) {
    parts.push(`${oom.length} OOM ${oom.length === 1 ? "event" : "events"}`);
  }
  return `${parts.join(", ")}. Buckets with no samples are omitted.`;
}

export interface AxisTick {
  readonly at: number;
  readonly label: string;
}

function tickLabel(at: number, includeDay: boolean): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (!includeDay) return time;
  const day = date.toLocaleDateString("en-GB", { weekday: "short" });
  return `${day} ${time}`;
}

/** Evenly spaced x-axis ticks, including both window ends. */
export function axisTicks(
  from: string | number,
  to: string | number,
  count: number,
  includeDay = false,
): AxisTick[] {
  const start = typeof from === "number" ? from : Date.parse(from);
  const end = typeof to === "number" ? to : Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || count <= 0) {
    return [];
  }
  const tickCount = Math.floor(count);
  const timestamps =
    tickCount === 1
      ? [start]
      : Array.from(
          { length: tickCount },
          (_, index) => start + ((end - start) * index) / (tickCount - 1),
        );
  return timestamps.map((at) => ({ at, label: tickLabel(at, includeDay) }));
}
