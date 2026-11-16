import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { apiQuery } from "../api.js";
import {
  bucketSeconds,
  type MemoryBucket,
  type MemoryPayload,
  type MemoryWindow,
  resolveBucket,
} from "../memory-chart.js";

export type {
  MemoryBucket,
  MemoryOomEvent,
  MemoryPayload,
  MemorySampleBucket,
  MemorySummary,
  MemoryWindow,
} from "../memory-chart.js";

export interface UseAppMemoryOptions {
  readonly projectId: MaybeRefOrGetter<string>;
  readonly appKey: MaybeRefOrGetter<string>;
  readonly window: MaybeRefOrGetter<MemoryWindow>;
  readonly bucket: MaybeRefOrGetter<MemoryBucket>;
  /** Optional gate for surfaces that only poll while visible. Defaults to enabled. */
  readonly enabled?: MaybeRefOrGetter<boolean>;
}

/** 60 s poll keeps the card live without a retry storm; the server samples every 30 s. */
const REFETCH_INTERVAL_MS = 60_000;
const STALE_TIME_MS = 30_000;

export function memoryPath(
  projectId: string,
  appKey: string,
  window: MemoryWindow,
  bucket: MemoryBucket,
): string {
  const resolved = resolveBucket(window, bucket);
  const params = new URLSearchParams({
    project: projectId,
    window,
    bucket: resolved,
  });
  return `/api/apps/${encodeURIComponent(appKey)}/memory?${params.toString()}`;
}

/**
 * Polled read for the application Memory card.
 *
 * The window/bucket are reactive so changing a control swaps the query key; `keepPreviousData`
 * leaves the previous chart visible while the new range loads. The resolved bucket is part of the
 * key so `auto` and an explicit bucket that resolve to the same request share one cache entry.
 */
export function useAppMemory(options: UseAppMemoryOptions) {
  const resolvedBucket = computed(() =>
    resolveBucket(toValue(options.window), toValue(options.bucket)),
  );
  const path = computed(() =>
    memoryPath(
      toValue(options.projectId),
      toValue(options.appKey),
      toValue(options.window),
      toValue(options.bucket),
    ),
  );
  const enabled = computed(() => {
    const gate = options.enabled === undefined ? true : toValue(options.enabled);
    return gate && toValue(options.projectId).length > 0 && toValue(options.appKey).length > 0;
  });

  const query = useQuery<MemoryPayload>({
    queryKey: computed(
      () =>
        [
          "app-memory",
          toValue(options.projectId),
          toValue(options.appKey),
          toValue(options.window),
          resolvedBucket.value,
          bucketSeconds(resolvedBucket.value),
        ] as const,
    ),
    queryFn: () => apiQuery<MemoryPayload>(path.value),
    enabled,
    refetchInterval: REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: STALE_TIME_MS,
    placeholderData: keepPreviousData,
    // A failed poll must not multiply requests; the next 60 s interval is the retry.
    retry: false,
  });

  const payload = computed<MemoryPayload | null>(() => query.data.value ?? null);

  return { query, payload, path, resolvedBucket };
}
