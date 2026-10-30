/**
 * Cookie-authenticated chat SSE adapter.
 *
 * One `EventSource` per adapter. Every frame carries a per-connection `seq` and `streamID`; the
 * adapter owns duplicate/gap detection, bounded visible-failure recovery, the one-shot
 * stream-limit probe, and the cookie-only auth probe. It owns no DOM listeners, timers outside its
 * probes, or Pinia state; `useChatStream` drives the page lifecycle.
 */

import type { InboundChatEvent } from "./event-reducer.js";

export type ChatStreamStatusKind = "connecting" | "live" | "reconnecting" | "paused" | "stopped";

interface MessageEventLike {
  readonly data: unknown;
}

export interface ChatEventSource {
  readonly readyState: number;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: MessageEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface EventSourceFactory {
  new (url: string): ChatEventSource;
}

export interface ChatStreamDeps {
  readonly EventSource?: EventSourceFactory;
  readonly fetch?: typeof fetch;
  readonly document?: Document;
  readonly location?: Location;
  readonly now?: () => number;
}

export interface ChatStreamOptions {
  readonly url: string;
  readonly onEvent?: (event: InboundChatEvent) => void;
  readonly onReady?: (event: InboundChatEvent) => void;
  readonly onResync?: (reason: "gap" | "stream-id") => void;
  readonly onStatus?: (kind: ChatStreamStatusKind, detail?: string) => void;
  readonly onLimit?: (message: string) => void;
  readonly onAuthExpired?: () => void;
  readonly deps?: ChatStreamDeps;
}

export interface ChatStream {
  connect(manual?: boolean): void;
  disconnect(): void;
  dispose(): void;
  status(): ChatStreamStatusKind;
  failures(): number;
  streamID(): string | null;
  lastSeq(streamID: string): number;
}

const AUTH_PROBE_COOLDOWN_MS = 5000;
const LIMIT_PROBE_TIMEOUT_MS = 3000;
const MAX_VISIBLE_FAILURES = 3;
const OPEN = 1;
const CLOSED = 2;

function parseFrame(data: unknown): InboundChatEvent | null {
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
  const event = parsed as Record<string, unknown>;
  if (typeof event.type !== "string" || event.type.length === 0) {
    return null;
  }
  return parsed as InboundChatEvent;
}

function finiteSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function streamIdOf(event: InboundChatEvent): string | null {
  const value = (event as { streamID?: unknown }).streamID;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function seqOf(event: InboundChatEvent): number | null {
  return finiteSeq((event as { seq?: unknown }).seq);
}

export function createChatStream(options: ChatStreamOptions): ChatStream {
  const deps = options.deps ?? {};
  const doc = deps.document ?? (typeof document === "undefined" ? undefined : document);
  const win = doc?.defaultView ?? undefined;
  const eventSource =
    deps.EventSource ?? (win?.EventSource as unknown as EventSourceFactory | undefined);
  const fetchImpl = deps.fetch ?? (win?.fetch.bind(win) as typeof fetch | undefined) ?? fetch;
  const location = deps.location ?? win?.location;
  const now = deps.now ?? (() => Date.now());

  let disposed = false;
  let source: ChatEventSource | null = null;
  let statusKind: ChatStreamStatusKind = "connecting";
  let failures = 0;
  let currentStreamID: string | null = null;
  const lastSeqByStream = new Map<string, number>();
  let paused = false;
  let probedThisPause = false;
  let limitProbeInFlight = false;
  let probedAuthThisWindow = false;
  let authProbeInFlight = false;
  let lastAuthProbeAt = Number.NEGATIVE_INFINITY;
  let limitController: AbortController | undefined;

  function setStatus(kind: ChatStreamStatusKind, detail?: string): void {
    statusKind = kind;
    options.onStatus?.(kind, detail);
  }

  function closeSource(): void {
    if (source === null) {
      return;
    }
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

  function resetPauseWindow(): void {
    paused = false;
    probedThisPause = false;
    probedAuthThisWindow = false;
  }

  function acceptFrame(raw: unknown): void {
    const event = parseFrame(raw);
    if (event === null) {
      return;
    }
    if (event.type === "stream.ready") {
      const streamID = streamIdOf(event) ?? currentStreamID;
      if (streamID !== null) {
        currentStreamID = streamID;
      }
      if (streamID !== null) {
        lastSeqByStream.set(streamID, seqOf(event) ?? 0);
      }
      failures = 0;
      resetPauseWindow();
      setStatus("live");
      options.onReady?.(event);
      return;
    }

    const streamID = streamIdOf(event);
    const seq = seqOf(event);
    if (streamID !== null && seq !== null) {
      if (currentStreamID !== streamID) {
        currentStreamID = streamID;
        lastSeqByStream.set(streamID, seq);
        options.onResync?.("stream-id");
      } else {
        const last = lastSeqByStream.get(streamID) ?? 0;
        if (seq <= last) {
          return;
        }
        if (last > 0 && seq > last + 1) {
          options.onResync?.("gap");
        }
        lastSeqByStream.set(streamID, seq);
      }
    }
    options.onEvent?.(event);
  }

  function redirectToLogin(): void {
    if (location === undefined) {
      return;
    }
    const nextPath = `${location.pathname}${location.search}${location.hash}`;
    location.assign(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  async function probeAuth(): Promise<boolean> {
    if (doc?.hidden === true || authProbeInFlight || probedAuthThisWindow) {
      return false;
    }
    if (now() - lastAuthProbeAt < AUTH_PROBE_COOLDOWN_MS) {
      return false;
    }
    authProbeInFlight = true;
    probedAuthThisWindow = true;
    lastAuthProbeAt = now();
    try {
      const response = await fetchImpl("/api/ui/chrome?path=/chat", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (disposed) {
        return true;
      }
      if (response.status === 401 || response.status === 403) {
        closeSource();
        setStatus("paused", "sign-in required");
        if (options.onAuthExpired !== undefined) {
          options.onAuthExpired();
        } else {
          redirectToLogin();
        }
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      authProbeInFlight = false;
    }
  }

  async function probeStreamLimit(): Promise<void> {
    if (probedThisPause || limitProbeInFlight) {
      return;
    }
    probedThisPause = true;
    limitProbeInFlight = true;
    const controller = new AbortController();
    limitController = controller;
    const timer = setTimeout(() => controller.abort(), LIMIT_PROBE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(options.url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (disposed) {
        return;
      }
      if (response.status === 429) {
        let code = "";
        try {
          const payload: unknown = await response.json();
          code =
            typeof payload === "object" &&
            payload !== null &&
            typeof (payload as { code?: unknown }).code === "string"
              ? (payload as { code: string }).code
              : "";
        } catch {
          code = "";
        }
        const message =
          code === "stream_limit"
            ? "Too many live chat streams for this application. Retry shortly."
            : "The live stream is rate limited. Retry shortly.";
        setStatus("paused", "stream limit");
        options.onLimit?.(message);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        await probeAuth();
        return;
      }
      setStatus("paused", "stream unavailable");
    } catch {
      if (!disposed) {
        setStatus("paused", "stream unavailable");
      }
    } finally {
      clearTimeout(timer);
      if (limitController === controller) {
        limitController = undefined;
      }
      limitProbeInFlight = false;
    }
  }

  function handleError(): void {
    if (disposed) {
      return;
    }
    // Native EventSource keeps reconnecting while hidden. Do not count it, probe, or schedule an
    // app-level retry; a successful ready frame resets the client state on visibility return.
    if (doc?.hidden === true) {
      setStatus("reconnecting");
      return;
    }
    failures += 1;
    if (failures < MAX_VISIBLE_FAILURES) {
      setStatus("reconnecting", `${failures} of ${MAX_VISIBLE_FAILURES}`);
      return;
    }
    closeSource();
    paused = true;
    setStatus("paused", "reconnect paused");
    void probeStreamLimit();
  }

  return {
    connect(manual = false): void {
      if (disposed || eventSource === undefined) {
        return;
      }
      if (source !== null && source.readyState !== CLOSED) {
        return;
      }
      closeSource();
      if (manual) {
        failures = 0;
        resetPauseWindow();
      }
      setStatus(paused ? "paused" : failures > 0 ? "reconnecting" : "connecting");
      let current: ChatEventSource;
      try {
        current = new eventSource(options.url);
      } catch {
        handleError();
        return;
      }
      source = current;
      current.onopen = () => {
        if (source !== current || disposed) {
          return;
        }
        if (!paused) {
          setStatus("live");
        }
      };
      current.onmessage = (event) => {
        if (source !== current || disposed) {
          return;
        }
        acceptFrame(event.data);
      };
      current.onerror = () => {
        if (source !== current || disposed) {
          return;
        }
        handleError();
      };
    },
    disconnect(): void {
      closeSource();
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      closeSource();
      limitController?.abort();
      limitController = undefined;
    },
    status(): ChatStreamStatusKind {
      return statusKind;
    },
    failures(): number {
      return failures;
    },
    streamID(): string | null {
      return currentStreamID;
    },
    lastSeq(streamID: string): number {
      return lastSeqByStream.get(streamID) ?? 0;
    },
  };
}

/** Exported for the stream tests: readiness states match the DOM `EventSource` constants. */
export const CHAT_STREAM_OPEN = OPEN;
