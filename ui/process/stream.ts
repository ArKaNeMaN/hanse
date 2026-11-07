/**
 * Cookie-authenticated process SSE adapter.
 *
 * One `EventSource` per application. The adapter owns the per-app `lastEventId`, snapshot
 * hydration, duplicate/out-of-order suppression, the one-shot resync request, and the 429/terminal
 * close path. It owns no DOM listeners or Pinia state; the page lifecycle drives it.
 */

export type ProcessState = "starting" | "running" | "stopped" | "error";

export type ProcessPhase =
  | "requested"
  | "preparing"
  | "creating"
  | "waiting_ready"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"
  | "interrupted";

export type ProcessSource = "operator" | "runtime" | "reconciler" | "system";

export interface ProcessError {
  readonly code: string | null;
  readonly message: string | null;
  readonly at: string | null;
}

export interface ProcessCurrent {
  readonly state: ProcessState;
  readonly phase: ProcessPhase | null;
  readonly attemptId: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly error: ProcessError | null;
}

export interface ProcessTransition {
  readonly id: number;
  readonly attemptId: string;
  readonly seq: number;
  readonly state: ProcessState;
  readonly phase: ProcessPhase | null;
  readonly source: ProcessSource;
  readonly reason: string | null;
  readonly errorCode: string | null;
  readonly message: string | null;
  readonly createdAt: string;
}

export type ProcessStreamStatus = "connecting" | "live" | "reconnecting" | "paused" | "closed";

export type ProcessResyncReason = "gap" | "stream-id" | "warning";

interface MessageEventLike {
  readonly data: unknown;
}

export interface ProcessEventSource {
  readonly readyState: number;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: MessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface EventSourceFactory {
  new (url: string): ProcessEventSource;
}

export interface ProcessStreamDeps {
  readonly EventSource?: EventSourceFactory;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface ProcessStreamOptions {
  readonly url: string;
  readonly initialLastEventId?: number;
  readonly onSnapshot?: (current: ProcessCurrent, lastEventId: number) => void;
  readonly onTransition?: (event: ProcessTransition) => void;
  readonly onWarning?: (code: string, message?: string) => void;
  readonly onResync?: (reason: ProcessResyncReason) => void;
  readonly onStatus?: (status: ProcessStreamStatus) => void;
  readonly onLimit?: (message: string) => void;
  readonly onAuthExpired?: () => void;
  readonly deps?: ProcessStreamDeps;
}

export interface ProcessStream {
  connect(manual?: boolean): void;
  disconnect(): void;
  dispose(): void;
  status(): ProcessStreamStatus;
  lastEventId(): number;
  streamID(): string | null;
}

const OPEN = 1;
const CLOSED = 2;
const PROBE_TIMEOUT_MS = 3000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15_000;
const MAX_FAILURES = 3;
const RESYNC_COOLDOWN_MS = 1000;

function parseFrame(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string" || data.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const frame = parsed as Record<string, unknown>;
  return typeof frame.type === "string" && frame.type.length > 0 ? frame : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asCurrent(value: unknown): ProcessCurrent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as ProcessCurrent;
}

function asTransition(value: unknown): ProcessTransition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const event = value as Record<string, unknown>;
  return numberField(event.id) === null ? null : (value as ProcessTransition);
}

export function createProcessStream(options: ProcessStreamOptions): ProcessStream {
  const deps = options.deps ?? {};
  const eventSource =
    deps.EventSource ??
    (typeof window === "undefined"
      ? undefined
      : (window.EventSource as unknown as EventSourceFactory | undefined));
  const fetchImpl = deps.fetch ?? (typeof fetch === "undefined" ? undefined : fetch);
  const now = deps.now ?? (() => Date.now());

  let disposed = false;
  let terminal = false;
  let source: ProcessEventSource | null = null;
  let statusKind: ProcessStreamStatus = "connecting";
  let failures = 0;
  let currentStreamID: string | null = null;
  let lastEventId = options.initialLastEventId ?? 0;
  let lastResyncAt = Number.NEGATIVE_INFINITY;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let probeController: AbortController | undefined;
  let probing = false;

  function setStatus(kind: ProcessStreamStatus): void {
    if (statusKind === kind) return;
    statusKind = kind;
    options.onStatus?.(kind);
  }

  function closeSource(): void {
    if (source === null) return;
    const current = source;
    source = null;
    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    try {
      current.close();
    } catch {
      // already closing
    }
  }

  function scheduleResync(reason: ProcessResyncReason): void {
    const at = now();
    if (at - lastResyncAt < RESYNC_COOLDOWN_MS) return;
    lastResyncAt = at;
    options.onResync?.(reason);
  }

  function acceptFrame(raw: unknown): void {
    const frame = parseFrame(raw);
    if (frame === null) return;
    if (frame.type === "stream.ready") {
      const streamID = stringField(frame.streamID) ?? currentStreamID;
      if (streamID !== null) {
        if (currentStreamID !== null && currentStreamID !== streamID) {
          scheduleResync("stream-id");
        }
        currentStreamID = streamID;
      }
      failures = 0;
      // A ready frame is not "live" until the snapshot hydrates; keep the connecting status.
      return;
    }
    if (frame.type === "process.snapshot") {
      const current = asCurrent(frame.current);
      const snapshotId = numberField(frame.lastEventId);
      if (snapshotId !== null && snapshotId > lastEventId) {
        lastEventId = snapshotId;
      }
      if (current !== null) {
        options.onSnapshot?.(current, lastEventId);
      }
      setStatus("live");
      return;
    }
    if (frame.type === "process.transition") {
      const transition = asTransition(frame.event);
      if (transition === null) return;
      if (transition.id <= lastEventId) {
        scheduleResync("gap");
        return;
      }
      lastEventId = transition.id;
      setStatus("live");
      options.onTransition?.(transition);
      return;
    }
    if (frame.type === "stream.warning") {
      const code = stringField(frame.code) ?? "stream_warning";
      const message = stringField(frame.message) ?? undefined;
      options.onWarning?.(code, message);
      scheduleResync("warning");
    }
  }

  function scheduleReconnect(): void {
    if (disposed || terminal || reconnectTimer !== undefined) return;
    if (failures >= MAX_FAILURES) {
      terminal = true;
      setStatus("paused");
      options.onLimit?.("The live process stream is unavailable. Polling will continue.");
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, failures - 1));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!disposed && !terminal) connect(false);
    }, delay);
  }

  async function probe(): Promise<void> {
    if (probing || disposed || fetchImpl === undefined) {
      scheduleReconnect();
      return;
    }
    probing = true;
    const controller = new AbortController();
    probeController = controller;
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(options.url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (disposed) return;
      if (response.status === 429) {
        terminal = true;
        setStatus("paused");
        options.onLimit?.(
          "Too many live process streams for this application. Polling will continue.",
        );
        return;
      }
      if (response.status === 401 || response.status === 403) {
        terminal = true;
        setStatus("paused");
        options.onAuthExpired?.();
        return;
      }
      scheduleReconnect();
    } catch {
      if (!disposed) scheduleReconnect();
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (probeController === controller) probeController = undefined;
      probing = false;
    }
  }

  function handleError(): void {
    if (disposed) return;
    failures += 1;
    closeSource();
    if (terminal) return;
    setStatus("reconnecting");
    void probe();
  }

  function connect(manual = false): void {
    if (disposed) return;
    if (manual) {
      terminal = false;
      failures = 0;
      lastResyncAt = Number.NEGATIVE_INFINITY;
    }
    if (terminal) return;
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (source !== null && source.readyState !== CLOSED) return;
    closeSource();
    if (eventSource === undefined) return;
    setStatus(failures > 0 ? "reconnecting" : "connecting");
    let current: ProcessEventSource;
    try {
      current = new eventSource(options.url);
    } catch {
      handleError();
      return;
    }
    source = current;
    current.onopen = () => {
      if (source !== current || disposed) return;
      if (statusKind === "connecting") setStatus("live");
    };
    current.onmessage = (event) => {
      if (source !== current || disposed) return;
      acceptFrame(event.data);
    };
    current.onerror = () => {
      if (source !== current || disposed) return;
      handleError();
    };
  }

  return {
    connect,
    disconnect(): void {
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      closeSource();
      setStatus("closed");
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      probeController?.abort();
      probeController = undefined;
      closeSource();
      setStatus("closed");
    },
    status(): ProcessStreamStatus {
      return statusKind;
    },
    lastEventId(): number {
      return lastEventId;
    },
    streamID(): string | null {
      return currentStreamID;
    },
  };
}

/** Exported for the stream test: matches the DOM `EventSource` open constant. */
export const PROCESS_STREAM_OPEN = OPEN;
