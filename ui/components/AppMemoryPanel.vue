<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAppMemory } from "../composables/useAppMemory.js";
import { timeAgo } from "../format.js";
import {
  axisTicks,
  bandPath,
  chartDescription,
  coalesceOomEvents,
  formatBytes,
  formatClock,
  isMemoryBucket,
  isMemoryWindow,
  linePath,
  MEMORY_WINDOWS,
  type MemoryBucket,
  type MemoryOomEvent,
  type MemorySampleBucket,
  type MemoryWindow,
  scaleY,
} from "../memory-chart.js";
import type { RuntimeState } from "../status.js";
import AppIcon from "./AppIcon.vue";

const CHART_WIDTH = 720;
const CHART_HEIGHT = 176;
const CHART_PAD = 8;
const DEFAULT_WINDOW: MemoryWindow = "24h";
const DEFAULT_BUCKET: MemoryBucket = "auto";

const props = defineProps<{
  projectId: string;
  appKey: string;
  runtimeState: RuntimeState;
}>();

const route = useRoute();
const router = useRouter();

function queryValue(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw : "";
}

interface MemorySelection {
  readonly window: MemoryWindow;
  readonly bucket: MemoryBucket;
}

function parseMem(raw: unknown): MemorySelection {
  const value = queryValue(raw);
  const [rawWindow, rawBucket] = value.split(":");
  const window = rawWindow !== undefined && isMemoryWindow(rawWindow) ? rawWindow : DEFAULT_WINDOW;
  const bucket = rawBucket !== undefined && isMemoryBucket(rawBucket) ? rawBucket : DEFAULT_BUCKET;
  // A hand-edited `72h:10m` would be a 400 from the API; clamp it to the supported bucket.
  if (window === "72h" && bucket === "10m") return { window, bucket: "30m" };
  return { window, bucket };
}

const initial = parseMem(route.query.mem);
const selectedWindow = ref<MemoryWindow>(initial.window);
const selectedBucket = ref<MemoryBucket>(initial.bucket);

const viewportWidth = ref(typeof window === "undefined" ? 1024 : window.innerWidth || 1024);
function onResize(): void {
  viewportWidth.value = typeof window === "undefined" ? 1024 : window.innerWidth || 1024;
}

onMounted(() => {
  if (typeof window !== "undefined") window.addEventListener("resize", onResize);
});
onUnmounted(() => {
  if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
});

const isNarrow = computed(() => viewportWidth.value < 768);
const tickCount = computed(() =>
  viewportWidth.value >= 1024 ? 4 : viewportWidth.value >= 768 ? 3 : 2,
);
const chartOpen = ref(false);
const chartVisible = computed(() => !isNarrow.value || chartOpen.value);

const disable10m = computed(() => selectedWindow.value === "72h" || isNarrow.value);
const bucketReason = computed(() => {
  const reasons: string[] = [];
  if (selectedWindow.value === "72h") reasons.push("the 72-hour range");
  if (isNarrow.value) reasons.push("screens narrower than 768 px");
  if (reasons.length === 0) return "";
  return `10-minute buckets are unavailable for ${reasons.join(" or ")}.`;
});

function applySelection(nextWindow: MemoryWindow, nextBucket: MemoryBucket): void {
  const bucket = nextWindow === "72h" && nextBucket === "10m" ? "30m" : nextBucket;
  selectedWindow.value = nextWindow;
  selectedBucket.value = bucket;
  const mem = `${nextWindow}:${bucket}`;
  if (queryValue(route.query.mem) === mem) return;
  void router.replace({ query: { ...route.query, mem } });
}

function selectWindow(next: MemoryWindow): void {
  applySelection(next, selectedBucket.value);
}

function onBucketChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (isMemoryBucket(target.value)) applySelection(selectedWindow.value, target.value);
}

watch(
  () => route.query.mem,
  (raw) => {
    const next = parseMem(raw);
    if (next.window !== selectedWindow.value || next.bucket !== selectedBucket.value) {
      selectedWindow.value = next.window;
      selectedBucket.value = next.bucket;
    }
  },
);

watch(
  isNarrow,
  (narrow) => {
    if (narrow && selectedBucket.value === "10m") applySelection(selectedWindow.value, "30m");
  },
  { immediate: true },
);

const widerWindow = computed<MemoryWindow | null>(() => {
  if (selectedWindow.value === "6h") return "24h";
  if (selectedWindow.value === "24h") return "72h";
  return null;
});

function widenRange(): void {
  if (widerWindow.value !== null) selectWindow(widerWindow.value);
}

const { query, payload } = useAppMemory({
  projectId: () => props.projectId,
  appKey: () => props.appKey,
  window: selectedWindow,
  bucket: selectedBucket,
  enabled: () => true,
});

const loading = computed(() => payload.value === null && query.isPending.value);
const failed = computed(() => query.isError.value);
const errorText = computed(() => {
  const error = query.error.value;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Could not load memory samples.";
});
const fatalError = computed(() => failed.value && payload.value === null);
const staleError = computed(() => failed.value && payload.value !== null);

function retry(): void {
  void query.refetch();
}

const summary = computed(() => payload.value?.summary ?? null);
const stopped = computed(() => props.runtimeState === "stopped");
const currentValue = computed(() =>
  stopped.value ? "—" : formatBytes(summary.value?.currentBytes ?? null),
);
const peakValue = computed(() => formatBytes(summary.value?.peakBytes ?? null));
const averageValue = computed(() => formatBytes(summary.value?.averageBytes ?? null));
const limitValue = computed(() => formatBytes(summary.value?.limitBytes ?? null));
const peakAt = computed(() => {
  const data = payload.value;
  if (data === null || data.summary.peakBytes === null) return null;
  const bucket = data.buckets.find((entry) => entry.maxBytes === data.summary.peakBytes);
  return bucket?.start ?? null;
});
const peakLabel = computed(() => (peakAt.value === null ? "" : formatClock(peakAt.value)));

const hasData = computed(() => (summary.value?.samples ?? 0) > 0);
const neverSampled = computed(
  () => payload.value !== null && !hasData.value && summary.value?.lastSampleAt === null,
);
const noDataInRange = computed(
  () => payload.value !== null && !hasData.value && summary.value?.lastSampleAt !== null,
);

const windowLabel = computed(() => {
  if (selectedWindow.value === "6h") return "6 hours";
  if (selectedWindow.value === "24h") return "24 hours";
  return "72 hours";
});

const chartDomainMax = computed(() => {
  const data = payload.value;
  if (data === null) return 1;
  const bucketPeak = data.buckets.reduce((max, bucket) => Math.max(max, bucket.maxBytes), 0);
  return Math.max(data.summary.peakBytes ?? 0, data.summary.limitBytes ?? 0, bucketPeak, 1) * 1.05;
});
const chartScaleHeight = CHART_HEIGHT - CHART_PAD * 2;

interface GeoBucket {
  readonly start: string;
  readonly x: number;
  readonly avgY: number;
  readonly topY: number;
  readonly bottomY: number;
  readonly gapAfter: boolean;
  readonly bucket: MemorySampleBucket;
}

const geoBuckets = computed<GeoBucket[]>(() => {
  const data = payload.value;
  if (data === null) return [];
  const from = Date.parse(data.window.from);
  const to = Date.parse(data.window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const span = to - from;
  const bucketMs = data.window.bucketSeconds * 1_000;
  const domainMax = chartDomainMax.value;
  const sorted = [...data.buckets].sort(
    (left, right) => Date.parse(left.start) - Date.parse(right.start),
  );
  return sorted.map((bucket, index) => {
    const start = Date.parse(bucket.start);
    const next = sorted[index + 1];
    const nextStart = next === undefined ? null : Date.parse(next.start);
    const gapAfter = nextStart !== null && nextStart - start > bucketMs * 1.5;
    const x = ((start + bucketMs / 2 - from) / span) * CHART_WIDTH;
    return {
      start: bucket.start,
      x,
      avgY: CHART_PAD + scaleY(bucket.averageBytes, 0, domainMax, chartScaleHeight),
      topY: CHART_PAD + scaleY(bucket.maxBytes, 0, domainMax, chartScaleHeight),
      bottomY: CHART_PAD + scaleY(bucket.minBytes, 0, domainMax, chartScaleHeight),
      gapAfter,
      bucket,
    };
  });
});

const workingSetPath = computed(() =>
  linePath(
    geoBuckets.value.map((bucket) => ({ x: bucket.x, y: bucket.avgY, gapAfter: bucket.gapAfter })),
  ),
);
const band = computed(() =>
  bandPath(
    geoBuckets.value.map((bucket) => ({
      x: bucket.x,
      upperY: bucket.topY,
      lowerY: bucket.bottomY,
      gapAfter: bucket.gapAfter,
    })),
  ),
);

const limitY = computed<number | null>(() => {
  const limit = summary.value?.limitBytes ?? null;
  if (limit === null) return null;
  return CHART_PAD + scaleY(limit, 0, chartDomainMax.value, chartScaleHeight);
});
const limitPct = computed(() => (limitY.value === null ? 0 : (limitY.value / CHART_HEIGHT) * 100));

const tickMarks = computed(() => {
  const data = payload.value;
  if (data === null) return [];
  const from = Date.parse(data.window.from);
  const to = Date.parse(data.window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  return axisTicks(
    data.window.from,
    data.window.to,
    tickCount.value,
    selectedWindow.value === "72h",
  ).map((tick) => ({ ...tick, xPct: ((tick.at - from) / (to - from)) * 100 }));
});

interface CurrentPoint {
  readonly xPct: number;
  readonly yPct: number;
  readonly atRight: boolean;
  readonly at: string;
}

const currentPoint = computed<CurrentPoint | null>(() => {
  const data = payload.value;
  if (data === null || data.summary.currentBytes === null || stopped.value) return null;
  const last = geoBuckets.value[geoBuckets.value.length - 1];
  if (last === undefined) return null;
  const from = Date.parse(data.window.from);
  const to = Date.parse(data.window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const y =
    CHART_PAD + scaleY(data.summary.currentBytes, 0, chartDomainMax.value, chartScaleHeight);
  return {
    xPct: (last.x / CHART_WIDTH) * 100,
    yPct: (y / CHART_HEIGHT) * 100,
    atRight: last.x / CHART_WIDTH > 0.82,
    at: data.summary.lastSampleAt ?? last.start,
  };
});

interface OomMarker {
  readonly key: string;
  readonly at: string;
  readonly time: string;
  readonly xPct: number;
  readonly count: number;
  readonly message: string | null;
}

const oomEvents = computed<readonly MemoryOomEvent[]>(() =>
  coalesceOomEvents(payload.value?.events ?? []),
);
const oomCount = computed(() => oomEvents.value.length);

const oomMarkers = computed<OomMarker[]>(() => {
  const data = payload.value;
  if (data === null || oomEvents.value.length === 0) return [];
  const from = Date.parse(data.window.from);
  const to = Date.parse(data.window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const span = to - from;
  const bucketMs = data.window.bucketSeconds * 1_000;
  const grouped = new Map<number, { at: number; times: number[]; first: MemoryOomEvent }>();
  for (const event of oomEvents.value) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) continue;
    const key = Math.floor((at - from) / bucketMs);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { at, times: [at], first: event });
      continue;
    }
    existing.times.push(at);
    if (at < existing.at) {
      existing.at = at;
      existing.first = event;
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([key, group]) => ({
      key: String(key),
      at: new Date(group.at).toISOString(),
      time: formatClock(new Date(group.at).toISOString()),
      xPct: Math.min(100, Math.max(0, ((group.at - from) / span) * 100)),
      count: group.times.length,
      message: group.first.message,
    }));
});

const readout = ref("");

function markerLabel(marker: OomMarker): string {
  return marker.count > 1
    ? `${marker.count} OOM events near ${marker.time}`
    : `OOM at ${marker.time}`;
}

function announceOom(marker: OomMarker): void {
  const message =
    marker.message === null || marker.message.length === 0 ? "" : ` · ${marker.message}`;
  readout.value = `${markerLabel(marker)}${message}`;
}

function announceCurrent(): void {
  const data = payload.value;
  if (data === null) return;
  const at =
    data.summary.lastSampleAt === null ? "" : ` at ${formatClock(data.summary.lastSampleAt)}`;
  readout.value = `Current working set ${formatBytes(data.summary.currentBytes)}${at}`;
}

const description = computed(() => {
  const data = payload.value;
  if (data === null) return "No memory samples loaded.";
  return chartDescription(selectedWindow.value, data.buckets, data.events, data.summary);
});

const lastSampleLabel = computed(() => {
  const at = summary.value?.lastSampleAt ?? null;
  if (at === null) return "No samples yet";
  if (stopped.value) return `Agent stopped · last sample ${formatClock(at)}`;
  return `Last sample ${timeAgo(at)}`;
});

const staleNotice = computed(() => {
  const data = payload.value;
  if (data === null) return "";
  const at = data.summary.lastSampleAt ?? data.window.to;
  return `Showing data from ${formatClock(at)} · refresh failed`;
});

interface TableRow {
  readonly key: string;
  readonly time: string;
  readonly min: string;
  readonly average: string;
  readonly max: string;
  readonly oom: number;
}

const tableRows = computed<TableRow[]>(() => {
  const data = payload.value;
  if (data === null) return [];
  const bucketMs = data.window.bucketSeconds * 1_000;
  return [...data.buckets]
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
    .map((bucket) => {
      const start = Date.parse(bucket.start);
      const oom = oomEvents.value.filter((event) => {
        const at = Date.parse(event.at);
        return at >= start && at < start + bucketMs;
      }).length;
      return {
        key: bucket.start,
        time: formatClock(bucket.start),
        min: formatBytes(bucket.minBytes),
        average: formatBytes(bucket.averageBytes),
        max: formatBytes(bucket.maxBytes),
        oom,
      };
    });
});

const editHref = computed(
  () =>
    `/projects/${encodeURIComponent(props.projectId)}/apps/${encodeURIComponent(props.appKey)}/settings#setting-runtime-memory`,
);
</script>

<template>
  <section
    id="app-memory"
    class="card memory-panel"
    aria-labelledby="memory-title"
    :aria-busy="loading ? 'true' : 'false'"
  >
    <header class="card__head memory-panel__head">
      <div class="memory-panel__identity">
        <p class="overline">Memory</p>
        <h2 class="card__title" id="memory-title">Memory</h2>
      </div>
      <div class="memory-toolbar">
        <!-- biome-ignore lint/a11y/useSemanticElements: keep the legacy segmented control markup -->
        <div class="segmented" role="group" aria-label="Memory range">
          <button
            v-for="option in MEMORY_WINDOWS"
            :key="option"
            class="segmented__item"
            type="button"
            :aria-pressed="selectedWindow === option ? 'true' : 'false'"
            @click="selectWindow(option)"
          >
            {{ option === "6h" ? "6 h" : option === "24h" ? "24 h" : "72 h" }}
          </button>
        </div>
        <label class="memory-bucket" for="memory-bucket">
          <span class="label">Bucket</span>
          <span class="select-wrap">
            <select
              id="memory-bucket"
              class="select"
              :value="selectedBucket"
              :aria-describedby="disable10m ? 'memory-bucket-reason' : undefined"
              @change="onBucketChange"
            >
              <option value="auto">Auto</option>
              <option value="10m" :disabled="disable10m">10 min</option>
              <option value="30m">30 min</option>
            </select>
            <AppIcon name="chevron-down" />
          </span>
        </label>
        <span v-if="oomCount > 0" class="badge badge-error memory-oom-badge"
          >{{ oomCount }}
          OOM</span
        >
      </div>
    </header>
    <p v-if="disable10m" id="memory-bucket-reason" class="hint memory-bucket-reason">
      {{ bucketReason }}
    </p>

    <template v-if="loading">
      <div class="watch-strip watch-strip--4 memory-summary" aria-hidden="true">
        <div v-for="index in 4" :key="index" class="watch">
          <span class="skeleton skeleton--title"></span>
          <span class="skeleton skeleton--short"></span>
        </div>
      </div>
      <div class="card__body memory-panel__body" aria-hidden="true">
        <span class="skeleton memory-chart__skeleton"></span>
        <span class="skeleton skeleton--short"></span>
      </div>
    </template>

    <div v-else class="watch-strip watch-strip--4 memory-summary">
      <div class="watch">
        <p class="watch__value">{{ currentValue }}</p>
        <p class="watch__label">Current</p>
      </div>
      <div class="watch">
        <p class="watch__value">{{ peakValue }}</p>
        <p class="watch__label">
          Peak<template v-if="peakLabel !== ''"> · {{ peakLabel }}</template>
        </p>
      </div>
      <div class="watch">
        <p class="watch__value">{{ averageValue }}</p>
        <p class="watch__label">Average</p>
      </div>
      <div class="watch">
        <p class="watch__value">{{ limitValue }}</p>
        <p class="watch__label">Limit</p>
      </div>
    </div>

    <div v-if="!loading" class="card__body memory-panel__body">
      <p v-if="fatalError" class="field-error memory-error" role="alert">
        <AppIcon name="alert-triangle" />
        <span>{{ errorText }}</span>
        <button class="btn btn-secondary btn-sm" type="button" @click="retry">Retry</button>
      </p>
      <template v-else>
        <p v-if="staleError" class="field-error memory-error" role="alert">
          <AppIcon name="alert-triangle" />
          <span>{{ staleNotice }}</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="retry">Retry</button>
        </p>
        <p v-if="neverSampled" class="hint memory-empty">
          No memory samples yet. Samples appear after this agent starts.
        </p>
        <div v-else-if="noDataInRange" class="memory-empty">
          <p class="hint">No samples in the last {{ windowLabel }}.</p>
          <button
            v-if="widerWindow !== null"
            class="btn btn-secondary btn-sm"
            type="button"
            @click="widenRange"
          >
            Show {{ widerWindow === "24h" ? "24 hours" : "72 hours" }}
          </button>
        </div>
        <template v-else-if="payload !== null">
          <button
            v-if="isNarrow"
            class="btn btn-ghost btn-sm memory-chart-toggle"
            type="button"
            :aria-expanded="chartOpen ? 'true' : 'false'"
            aria-controls="memory-chart-body"
            @click="chartOpen = !chartOpen"
          >
            {{ chartOpen ? "Hide chart" : "Show chart" }}
          </button>
          <div v-if="chartVisible" id="memory-chart-body" class="memory-chart">
            <div class="memory-chart__plot">
              <div class="chart-ground memory-chart__ground" aria-hidden="true"></div>
              <svg
                class="memory-chart__svg"
                :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
                preserveAspectRatio="none"
                role="img"
                aria-labelledby="memory-chart-title memory-chart-desc"
              >
                <title id="memory-chart-title">Memory working set</title>
                <desc id="memory-chart-desc">{{ description }}</desc>
                <path
                  v-if="band !== ''"
                  class="memory-chart__band"
                  :d="band"
                  vector-effect="non-scaling-stroke"
                />
                <path
                  v-if="workingSetPath !== ''"
                  class="memory-chart__line"
                  :d="workingSetPath"
                  vector-effect="non-scaling-stroke"
                />
                <line
                  v-if="limitY !== null"
                  class="memory-chart__limit"
                  x1="0"
                  :x2="CHART_WIDTH"
                  :y1="limitY"
                  :y2="limitY"
                  vector-effect="non-scaling-stroke"
                />
              </svg>
              <span
                v-if="limitY !== null"
                class="memory-chart__limit-label"
                :style="{ top: `${limitPct}%` }"
              >
                Limit {{ limitValue }}
              </span>
              <button
                v-for="marker in oomMarkers"
                :key="marker.key"
                class="memory-oom"
                type="button"
                :style="{ left: `${marker.xPct}%` }"
                :aria-label="markerLabel(marker)"
                @click="announceOom(marker)"
                @focus="announceOom(marker)"
              >
                <span class="memory-oom__mark" aria-hidden="true"></span>
                <span v-if="marker.count > 1" class="memory-oom__count" aria-hidden="true">{{
                  marker.count
                }}</span>
              </button>
              <button
                v-if="currentPoint !== null"
                class="memory-chart__now"
                :class="{ 'is-right': currentPoint.atRight }"
                type="button"
                :style="{ left: `${currentPoint.xPct}%`, top: `${currentPoint.yPct}%` }"
                :aria-label="`Current working set ${currentValue} at ${formatClock(currentPoint.at)}`"
                @click="announceCurrent"
                @focus="announceCurrent"
              >
                <span class="memory-chart__dot" aria-hidden="true"></span>
                <span class="memory-chart__now-label" aria-hidden="true">now</span>
              </button>
              <span class="memory-chart__floor" aria-hidden="true">0</span>
            </div>
            <div class="memory-chart__axis" aria-hidden="true">
              <span
                v-for="(tick, index) in tickMarks"
                :key="tick.at"
                class="memory-chart__tick"
                :class="{ 'is-first': index === 0, 'is-last': index === tickMarks.length - 1 }"
                :style="{ left: `${tick.xPct}%` }"
                >{{
                  tick.label
                }}</span
              >
            </div>
            <div class="memory-legend">
              <span class="memory-legend__item"
                ><span class="memory-legend__band" aria-hidden="true"></span>min–max band</span
              >
              <span class="memory-legend__item"
                ><span class="memory-legend__line" aria-hidden="true"></span>working-set
                average</span
              >
              <span class="memory-legend__item"
                ><span class="memory-legend__limit" aria-hidden="true"></span>limit</span
              >
              <span class="memory-legend__item"
                ><span class="memory-legend__oom" aria-hidden="true"></span>OOM</span
              >
            </div>
            <p class="memory-readout" role="status" aria-live="polite">{{ readout }}</p>
            <p v-if="oomCount > 0" class="caption memory-chart__note">
              OOM markers are coalesced to at most one per minute per app; a crash loop may show one
              marker per minute rather than every kill.
            </p>
            <details class="disclosure memory-table">
              <summary>
                Data table<AppIcon name="chevron-down" class-name="disclosure__chevron" />
              </summary>
              <div class="table-wrap">
                <table class="table">
                  <caption class="caption">
                    Buckets with no samples are omitted; a gap in the chart means no data.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Bucket start</th>
                      <th scope="col">Min</th>
                      <th scope="col">Average</th>
                      <th scope="col">Max</th>
                      <th scope="col">OOM</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in tableRows" :key="row.key">
                      <th scope="row" class="mono">{{ row.time }}</th>
                      <td>{{ row.min }}</td>
                      <td>{{ row.average }}</td>
                      <td>{{ row.max }}</td>
                      <td>{{ row.oom }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </template>
      </template>
    </div>

    <footer class="card__foot memory-foot">
      <p class="caption memory-foot__meta">
        {{ loading ? "Loading memory samples…" : lastSampleLabel }}
      </p>
      <div class="memory-foot__actions">
        <a class="btn btn-ghost btn-sm" :href="editHref"
          >Edit memory limit<AppIcon name="arrow-right" /></a
        >
      </div>
    </footer>
  </section>
</template>
