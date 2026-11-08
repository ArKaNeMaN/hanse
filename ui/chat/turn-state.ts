/**
 * Client turn slice and the coalescing `/turn` fetch client.
 *
 * The server snapshot is authoritative for the turn phase and queue. Live SSE status is applied
 * immediately with `source:"sse"`; the abort settle outranks both. Every response is guarded by
 * its request epoch, session, and live revision so a late response cannot overwrite newer state.
 */

import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import { ApiError, apiQuery } from "../api.js";
import type { TurnProjection } from "../stores/chat-feed.js";

export type TurnStatusType = "idle" | "busy" | "retry" | "unknown";

export interface TurnStatus {
  type: TurnStatusType;
  attempt?: number;
  message?: string;
  next?: number;
}

/** Mirrors `TurnSnapshot` from `src/chat/turn.ts`; the UI tsconfig excludes the node-side module. */
export interface TurnSnapshot {
  sessionID: string;
  status: TurnStatus;
  turnContinues: boolean;
  runningPromptID: string | null;
  activePromptID: string | null;
  queuedPromptIDs: string[];
  queuedTruncated: boolean;
  settling: boolean;
  revision: string;
}

export type TurnSource = "snapshot" | "sse" | "abort" | null;

export interface TurnApplyGuard {
  readonly sessionID: string;
  readonly requestEpoch: number;
  readonly liveRevision: number;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function turnUrl(app: string, project: string, sessionID: string): string {
  const path = `/api/apps/${encoded(app)}/sessions/${encoded(sessionID)}/turn`;
  return project.length === 0 ? path : `${path}?project=${encoded(project)}`;
}

/** T13 display count: the running prompt is excluded; an idle head is included. */
export function queuedDisplayCount(
  queuedPromptIDs: readonly string[],
  runningPromptID: string | null,
): number {
  return Math.max(0, queuedPromptIDs.length - (runningPromptID === null ? 0 : 1));
}

export const useChatTurnStore = defineStore("chat-turn", () => {
  const sessionID = ref<string | null>(null);
  const app = ref("");
  const project = ref("");
  const status = ref<TurnStatus | null>(null);
  const turnContinues = ref(false);
  const runningPromptID = ref<string | null>(null);
  const activePromptID = ref<string | null>(null);
  const queuedPromptIDs = shallowRef<readonly string[]>(markRaw([]));
  const queuedTruncated = ref(false);
  const settling = ref(false);
  const turnRevision = ref<string | null>(null);
  const source = ref<TurnSource>(null);
  const requestEpoch = ref(0);
  const liveRevision = ref(0);
  const stale = ref(false);
  const hidden = ref(false);
  const abortSettling = ref(false);

  let inFlight: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  let refetchScheduled = false;
  let disposed = false;
  let onSessionGone: ((sessionID: string) => void) | null = null;

  function clearRetry(resetAttempt = true): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (resetAttempt) {
      retryAttempt = 0;
    }
  }

  function cancelInFlight(): void {
    if (inFlight !== null) {
      const current = inFlight;
      inFlight = null;
      current.abort();
    }
  }

  function clearSlice(): void {
    status.value = null;
    turnContinues.value = false;
    runningPromptID.value = null;
    activePromptID.value = null;
    queuedPromptIDs.value = markRaw([]);
    queuedTruncated.value = false;
    settling.value = false;
    turnRevision.value = null;
    source.value = null;
    stale.value = false;
    hidden.value = false;
    abortSettling.value = false;
  }

  function bindScope(nextApp: string, nextProject: string): void {
    if (app.value === nextApp && project.value === nextProject) {
      return;
    }
    app.value = nextApp;
    project.value = nextProject;
    clearRetry();
    cancelInFlight();
    requestEpoch.value += 1;
    liveRevision.value += 1;
    sessionID.value = null;
    clearSlice();
  }

  function open(nextSessionID: string | null): void {
    if (sessionID.value === nextSessionID) {
      return;
    }
    clearRetry();
    cancelInFlight();
    requestEpoch.value += 1;
    liveRevision.value += 1;
    sessionID.value = nextSessionID;
    clearSlice();
  }

  function setSessionGoneHandler(handler: ((sessionID: string) => void) | null): void {
    onSessionGone = handler;
  }

  function projection(): TurnProjection {
    return {
      statusType: status.value?.type ?? null,
      turnContinues: turnContinues.value,
      runningPromptID: runningPromptID.value,
      activePromptID: activePromptID.value,
      queuedPromptIDs: queuedPromptIDs.value,
    };
  }

  function displayCount(): number {
    return queuedDisplayCount(queuedPromptIDs.value, runningPromptID.value);
  }

  function applyTurnSnapshot(snapshot: TurnSnapshot, guard: TurnApplyGuard): boolean {
    if (guard.sessionID !== sessionID.value || guard.requestEpoch !== requestEpoch.value) {
      return false;
    }
    if (guard.liveRevision !== liveRevision.value) {
      return false;
    }
    if (
      abortSettling.value &&
      (snapshot.status.type === "busy" || snapshot.status.type === "retry")
    ) {
      return false;
    }
    if (abortSettling.value && snapshot.status.type === "idle") {
      abortSettling.value = false;
    }
    const keepPhase =
      snapshot.status.type === "unknown" && status.value !== null ? status.value.type : null;
    status.value = keepPhase === null ? snapshot.status : { ...snapshot.status, type: keepPhase };
    turnContinues.value = snapshot.turnContinues;
    runningPromptID.value = snapshot.runningPromptID;
    activePromptID.value = snapshot.activePromptID;
    queuedPromptIDs.value = markRaw([...snapshot.queuedPromptIDs]);
    queuedTruncated.value = snapshot.queuedTruncated;
    settling.value = snapshot.settling;
    turnRevision.value = snapshot.revision;
    source.value = "snapshot";
    stale.value = false;
    hidden.value = false;
    return true;
  }

  function scheduleRetry(target: string): void {
    if (disposed || retryAttempt >= RETRY_DELAYS_MS.length) {
      return;
    }
    const delay = RETRY_DELAYS_MS[retryAttempt] ?? 30_000;
    retryAttempt += 1;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (target === sessionID.value) {
        refresh(target, "retry");
      }
    }, delay);
  }

  function scheduleRefetch(target: string): void {
    if (disposed || refetchScheduled) {
      return;
    }
    refetchScheduled = true;
    setTimeout(() => {
      refetchScheduled = false;
      if (target === sessionID.value) {
        refresh(target, "guard-refetch");
      }
    }, 0);
  }

  function handleFailure(error: unknown, target: string): void {
    if (!(error instanceof ApiError)) {
      return;
    }
    if (error.status === 502 || error.status === 503) {
      stale.value = true;
      scheduleRetry(target);
      return;
    }
    if (error.status === 409) {
      hidden.value = true;
      return;
    }
    if (error.status === 404) {
      hidden.value = true;
      onSessionGone?.(target);
    }
  }

  function refresh(nextSessionID?: string | null, _reason = "manual"): Promise<void> {
    const target = nextSessionID ?? sessionID.value;
    if (disposed || target === null || app.value.length === 0) {
      return Promise.resolve();
    }
    if (target !== sessionID.value) {
      open(target);
    }
    clearRetry(_reason !== "retry");
    cancelInFlight();
    const epoch = ++requestEpoch.value;
    const capturedLive = liveRevision.value;
    const controller = new AbortController();
    inFlight = controller;
    return (async () => {
      try {
        const snapshot = await apiQuery<TurnSnapshot>(turnUrl(app.value, project.value, target), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (epoch !== requestEpoch.value || target !== sessionID.value) {
          return;
        }
        if (capturedLive !== liveRevision.value) {
          scheduleRefetch(target);
          return;
        }
        const applied = applyTurnSnapshot(snapshot, {
          sessionID: target,
          requestEpoch: epoch,
          liveRevision: capturedLive,
        });
        if (applied) {
          clearRetry();
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (epoch !== requestEpoch.value || target !== sessionID.value) {
          return;
        }
        handleFailure(error, target);
      } finally {
        if (inFlight === controller) {
          inFlight = null;
        }
      }
    })();
  }

  function applySseStatus(nextSessionID: string, nextStatus: TurnStatus): void {
    if (nextSessionID !== sessionID.value) {
      return;
    }
    if (abortSettling.value) {
      if (nextStatus.type === "idle") {
        finishAbortSettle(nextSessionID);
      }
      return;
    }
    status.value = nextStatus;
    source.value = "sse";
    liveRevision.value += 1;
  }

  function startAbortSettle(nextSessionID: string): void {
    if (nextSessionID !== sessionID.value) {
      return;
    }
    abortSettling.value = true;
    source.value = "abort";
    liveRevision.value += 1;
  }

  function finishAbortSettle(nextSessionID: string): void {
    if (nextSessionID !== sessionID.value) {
      return;
    }
    abortSettling.value = false;
    status.value = { type: "idle" };
    turnContinues.value = false;
    runningPromptID.value = null;
    activePromptID.value = queuedPromptIDs.value[0] ?? null;
    settling.value = false;
    source.value = "abort";
    liveRevision.value += 1;
  }

  function reset(): void {
    clearRetry();
    cancelInFlight();
    requestEpoch.value += 1;
    liveRevision.value += 1;
    sessionID.value = null;
    clearSlice();
  }

  function dispose(): void {
    disposed = true;
    clearRetry();
    cancelInFlight();
  }

  return {
    sessionID,
    app,
    project,
    status,
    turnContinues,
    runningPromptID,
    activePromptID,
    queuedPromptIDs,
    queuedTruncated,
    settling,
    turnRevision,
    source,
    requestEpoch,
    liveRevision,
    stale,
    hidden,
    abortSettling,
    bindScope,
    open,
    setSessionGoneHandler,
    projection,
    displayCount,
    applyTurnSnapshot,
    refresh,
    applySseStatus,
    startAbortSettle,
    finishAbortSettle,
    reset,
    dispose,
  };
});
