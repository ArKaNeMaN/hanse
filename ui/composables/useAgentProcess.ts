/**
 * Chat process view.
 *
 * Hydrates from the chat page props and `GET /api/apps/:app/process`, subscribes to the per-app
 * process SSE adapter, and keeps a local reactive snapshot. Vue Query owns the `/process` read and
 * its refetch; no Pinia store is involved because this is server data.
 *
 * The chat props poll (5s in `ChatPage.vue`) remains the fallback when the stream is paused or the
 * endpoint is unavailable. A stream gap, a new stream id, or a stream warning triggers one refetch.
 */
import { useQuery } from "@tanstack/vue-query";
import { type ComputedRef, computed, onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";
import { apiQuery } from "../api.js";
import { createProcessStream, type ProcessStream } from "../process/stream.js";
import type {
  ProcessError,
  ProcessEvent,
  ProcessPhase,
  ProcessResponse,
  ProcessSnapshot,
  ProcessState,
} from "../process/types.js";

export interface UseAgentProcessOptions {
  readonly appKey: () => string;
  readonly project: () => string;
  /** Latest process payload from `/api/ui/chat` props, or null on a legacy server. */
  readonly initial: () => ProcessSnapshot | null | undefined;
}

export interface UseAgentProcess {
  readonly current: Ref<ProcessSnapshot | null>;
  readonly state: ComputedRef<ProcessState | null>;
  readonly phase: ComputedRef<ProcessPhase | null>;
  readonly startedAt: ComputedRef<string | null>;
  readonly updatedAt: ComputedRef<string | null>;
  readonly elapsed: ComputedRef<string>;
  readonly error: ComputedRef<ProcessError | null>;
  readonly lastEventId: ComputedRef<number>;
  readonly refetch: () => Promise<void>;
}

const TICK_MS = 1_000;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function processPath(appKey: string, project: string): string {
  return `/api/apps/${encoded(appKey)}/process?project=${encoded(project)}`;
}

function processEventsPath(appKey: string, project: string): string {
  return `/api/apps/${encoded(appKey)}/process/events?project=${encoded(project)}`;
}

function timestamp(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rank(snapshot: ProcessSnapshot): number {
  return snapshot.lastEventId * 1_000_000_000_000 + timestamp(snapshot.updatedAt);
}

/** Pick the payload that is at least as new as the local snapshot. */
function newerOrEqual(candidate: ProcessSnapshot, current: ProcessSnapshot | null): boolean {
  return current === null || rank(candidate) >= rank(current);
}

function strictlyNewer(candidate: ProcessSnapshot, current: ProcessSnapshot | null): boolean {
  return current === null || rank(candidate) > rank(current);
}

function errorFromTransition(
  event: ProcessEvent,
  previous: ProcessSnapshot | null,
): ProcessError | null {
  if (event.state === "error") {
    if (event.errorCode !== null || event.message !== null) {
      return { code: event.errorCode, message: event.message, at: event.createdAt };
    }
    return previous?.error ?? null;
  }
  if (event.state === "running" || event.state === "stopped") {
    return null;
  }
  return previous?.attemptId === event.attemptId ? (previous?.error ?? null) : null;
}

function snapshotFromTransition(
  event: ProcessEvent,
  previous: ProcessSnapshot | null,
): ProcessSnapshot {
  const sameAttempt = previous?.attemptId === event.attemptId;
  return {
    state: event.state,
    phase: event.phase,
    attemptId: event.attemptId,
    startedAt: sameAttempt ? (previous?.startedAt ?? event.createdAt) : event.createdAt,
    updatedAt: event.createdAt,
    error: errorFromTransition(event, sameAttempt ? previous : null),
    lastEventId: event.id,
  };
}

export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function useAgentProcess(options: UseAgentProcessOptions): UseAgentProcess {
  const current = ref<ProcessSnapshot | null>(null);
  const now = ref(Date.now());
  let ticker: ReturnType<typeof setInterval> | undefined;
  let mounted = false;
  let stream: ProcessStream | undefined;
  let streamKey = "";
  let refetching: Promise<void> | undefined;
  let connectQueued = false;

  const processQuery = useQuery<ProcessResponse>({
    queryKey: computed(() => ["agent-process", options.project(), options.appKey()]),
    queryFn: ({ signal }) =>
      apiQuery<ProcessResponse>(processPath(options.appKey(), options.project()), { signal }),
    enabled: computed(() => options.appKey().length > 0),
    staleTime: 5_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  function adopt(snapshot: ProcessSnapshot, force = false): void {
    if (force || newerOrEqual(snapshot, current.value)) {
      current.value = snapshot;
    }
  }

  watch(
    () => options.initial(),
    (snapshot) => {
      if (snapshot === null || snapshot === undefined) {
        return;
      }
      // Props are the 5s fallback: only accept a payload that moved forward.
      if (strictlyNewer(snapshot, current.value)) {
        adopt(snapshot, true);
      }
    },
    { immediate: true },
  );

  watch(
    processQuery.data,
    (response) => {
      if (response !== undefined) {
        adopt(response.current);
      }
    },
    { immediate: true },
  );

  const state = computed<ProcessState | null>(() => current.value?.state ?? null);
  const phase = computed<ProcessPhase | null>(() => current.value?.phase ?? null);
  const startedAt = computed<string | null>(() => current.value?.startedAt ?? null);
  const updatedAt = computed<string | null>(() => current.value?.updatedAt ?? null);
  const error = computed<ProcessError | null>(() => current.value?.error ?? null);
  const lastEventId = computed(() => current.value?.lastEventId ?? 0);

  const active = computed(() => state.value === "starting" || phase.value === "stopping");

  const elapsed = computed(() => {
    const since = startedAt.value ?? updatedAt.value;
    if (since === null || !active.value) {
      return "";
    }
    const started = timestamp(since);
    if (started === 0) {
      return "";
    }
    return formatElapsed(now.value - started);
  });

  watch(
    active,
    (running) => {
      if (running && ticker === undefined) {
        now.value = Date.now();
        ticker = setInterval(() => {
          now.value = Date.now();
        }, TICK_MS);
        return;
      }
      if (!running && ticker !== undefined) {
        clearInterval(ticker);
        ticker = undefined;
      }
    },
    { immediate: true },
  );

  async function refetch(): Promise<void> {
    const result = await processQuery.refetch();
    if (result.data !== undefined) {
      adopt(result.data.current);
    }
  }

  /** Coalesce a gap/warning resync with the props fallback into one read. */
  function requestRefetch(): void {
    if (refetching !== undefined) {
      return;
    }
    refetching = refetch().finally(() => {
      refetching = undefined;
    });
  }

  function buildStream(): ProcessStream {
    return createProcessStream({
      url: processEventsPath(options.appKey(), options.project()),
      initialLastEventId: current.value?.lastEventId ?? 0,
      onSnapshot: (snapshot, id) => {
        if (current.value !== null && id < current.value.lastEventId) {
          return;
        }
        adopt({ ...snapshot, lastEventId: id }, true);
      },
      onTransition: (event) => {
        const previous = current.value;
        if (previous !== null && event.id <= previous.lastEventId) {
          return;
        }
        current.value = snapshotFromTransition(event, previous);
      },
      onWarning: () => requestRefetch(),
      onResync: () => requestRefetch(),
    });
  }

  function scheduleConnect(): void {
    if (connectQueued) {
      return;
    }
    connectQueued = true;
    queueMicrotask(() => {
      connectQueued = false;
      if (mounted && options.appKey().length > 0) {
        stream?.connect(false);
      }
    });
  }

  function ensureStream(): void {
    const key = `${options.project()}:${options.appKey()}`;
    if (key === streamKey) {
      return;
    }
    stream?.dispose();
    streamKey = key;
    current.value = null;
    const initial = options.initial();
    if (initial !== null && initial !== undefined) {
      adopt(initial, true);
    }
    stream = buildStream();
    if (mounted) {
      scheduleConnect();
    }
  }

  watch(
    () => [options.project(), options.appKey()] as const,
    () => {
      ensureStream();
    },
    { immediate: true },
  );

  const win = typeof window === "undefined" ? undefined : window;
  let suspended = false;
  const onPageHide = (): void => {
    suspended = true;
    stream?.disconnect();
  };
  const onPageShow = (): void => {
    if (!suspended) {
      return;
    }
    suspended = false;
    stream?.connect(false);
  };

  onMounted(() => {
    mounted = true;
    if (stream === undefined) {
      ensureStream();
    } else {
      scheduleConnect();
    }
    win?.addEventListener("pagehide", onPageHide);
    win?.addEventListener("pageshow", onPageShow);
  });

  onBeforeUnmount(() => {
    mounted = false;
    win?.removeEventListener("pagehide", onPageHide);
    win?.removeEventListener("pageshow", onPageShow);
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    stream?.dispose();
    stream = undefined;
  });

  return {
    current,
    state,
    phase,
    startedAt,
    updatedAt,
    elapsed,
    error,
    lastEventId,
    refetch,
  };
}
