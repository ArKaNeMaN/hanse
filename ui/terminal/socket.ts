/**
 * Cookie-authenticated operator terminal WebSocket adapter.
 *
 * One socket per page. Every connect increments a generation, so callbacks from a replaced or
 * disposed socket are ignored. Automatic reconnects are bounded: exactly five attempts with the
 * `[1,2,4,8,15]s` delays, then a manual Reconnect. A failed WebSocket upgrade cannot expose an HTTP
 * status, so auth expiry is detected through the cookie-only `/api/ui/chrome?path=/terminal` probe
 * (at most once per retry window, 5 s cooldown, never while hidden).
 */

export type TerminalStatusKind =
  | "connecting"
  | "live"
  | "reconnecting"
  | "paused"
  | "stopped"
  | "closed"
  | "exited"
  | "failed";

export interface TerminalStatusMeta {
  readonly label: string;
  readonly state: string;
  readonly icon: string;
}

export const TERMINAL_STATUS: Record<TerminalStatusKind, TerminalStatusMeta> = {
  connecting: { label: "Connecting", state: "queued", icon: "loader" },
  live: { label: "Live", state: "in_progress", icon: "activity" },
  reconnecting: { label: "Reconnecting", state: "dispatching", icon: "refresh" },
  paused: { label: "Paused", state: "cancelled", icon: "slash" },
  stopped: { label: "Agent stopped", state: "queued", icon: "clock" },
  closed: { label: "Terminal closed", state: "cancelled", icon: "slash" },
  exited: { label: "Shell exited", state: "cancelled", icon: "slash" },
  failed: { label: "Connection failed", state: "failed", icon: "alert-triangle" },
};

export const TERMINAL_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000] as const;
export const INPUT_CHUNK = 16 * 1024;
const AUTH_PROBE_COOLDOWN_MS = 5000;
const OPEN = 1;

interface CloseEventLike {
  readonly code?: number;
}

interface MessageEventLike {
  readonly data: unknown;
}

export interface TerminalWebSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: MessageEventLike) => void) | null;
  onclose: ((event: CloseEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface WebSocketFactory {
  new (url: string): TerminalWebSocket;
}

export interface TerminalSocketDeps {
  readonly WebSocket?: WebSocketFactory;
  readonly fetch?: typeof fetch;
  readonly document?: Document;
  readonly location?: Location;
  readonly now?: () => number;
}

export interface TerminalSocketOptions {
  readonly wsPath: string;
  readonly runtimeUrl: string;
  readonly onData?: (bytes: Uint8Array) => void;
  readonly onStatus?: (kind: TerminalStatusKind, detail?: string) => void;
  readonly onBanner?: (text: string | null) => void;
  readonly onOpen?: (reconnect: boolean) => void;
  readonly onExit?: (kind: "stopped" | "closed" | "exited" | "failed") => void;
  readonly onAuthExpired?: () => void;
  readonly deps?: TerminalSocketDeps;
}

export interface TerminalSocket {
  connect(manual?: boolean): void;
  close(): void;
  /** Close the transport for bfcache without marking a manual close or disposing the adapter. */
  suspend(): void;
  dispose(): void;
  sendInput(data: string | Uint8Array): void;
  sendResize(cols: number, rows: number, force?: boolean): void;
  status(): TerminalStatusKind;
}

function clampSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(1000, Math.trunc(value)));
}

function runtimeUnavailable(state: string | undefined): boolean {
  return state === "stopped" || state === "error" || state === "failed";
}

export function createTerminalSocket(options: TerminalSocketOptions): TerminalSocket {
  const deps = options.deps ?? {};
  const doc = deps.document ?? (typeof document === "undefined" ? undefined : document);
  const win = doc?.defaultView ?? undefined;
  const websocket = deps.WebSocket ?? (win?.WebSocket as unknown as WebSocketFactory | undefined);
  const fetchImpl = deps.fetch ?? (win?.fetch.bind(win) as typeof fetch | undefined) ?? fetch;
  const location = deps.location ?? win?.location;
  const now = deps.now ?? (() => Date.now());
  const encoder = typeof TextEncoder === "undefined" ? undefined : new TextEncoder();

  let disposed = false;
  let socket: TerminalWebSocket | null = null;
  let generation = 0;
  let connectedOnce = false;
  let closedByOperator = false;
  let retryAttempt = 0;
  let retryFailure = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let retryDeadline = 0;
  let lastCols = 0;
  let lastRows = 0;
  let statusKind: TerminalStatusKind = "connecting";
  let probedThisWindow = false;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let probeInFlight = false;

  function setStatus(kind: TerminalStatusKind, detail?: string): void {
    statusKind = kind;
    options.onStatus?.(kind, detail);
  }

  function setBanner(text: string | null): void {
    options.onBanner?.(text);
  }

  function clearRetry(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (countdownTimer !== undefined) {
      clearInterval(countdownTimer);
      countdownTimer = undefined;
    }
    retryDeadline = 0;
  }

  function closeSocketSilently(): void {
    if (socket === null) {
      return;
    }
    const current = socket;
    socket = null;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close();
    } catch {
      // already closing or closed
    }
  }

  function retrySeconds(): number {
    return Math.max(0, Math.ceil((retryDeadline - now()) / 1000));
  }

  function renderRetry(): void {
    const seconds = retrySeconds();
    if (retryFailure) {
      setStatus("failed");
    } else {
      setStatus("reconnecting", `in ${seconds}s`);
    }
    setBanner(`Connection failed. Reconnecting in ${seconds}s.`);
  }

  function showStopped(): void {
    closedByOperator = false;
    connectedOnce = false;
    clearRetry();
    closeSocketSilently();
    setStatus("stopped");
    setBanner(null);
    options.onExit?.("stopped");
  }

  function scheduleRetry(): void {
    clearRetry();
    if (closedByOperator || disposed) {
      return;
    }
    if (retryAttempt >= TERMINAL_RETRY_DELAYS.length) {
      retryFailure = false;
      setStatus("paused");
      setBanner("Connection lost. Automatic reconnects stopped; reconnect to try again.");
      return;
    }
    const delay = TERMINAL_RETRY_DELAYS[retryAttempt] ?? TERMINAL_RETRY_DELAYS.at(-1) ?? 15000;
    retryAttempt += 1;
    retryDeadline = now() + delay;
    renderRetry();
    countdownTimer = setInterval(renderRetry, 1000);
    retryTimer = setTimeout(() => {
      clearRetry();
      void prepareConnect(false);
    }, delay);
  }

  async function fetchRuntimeState(): Promise<string | undefined> {
    try {
      const response = await fetchImpl(options.runtimeUrl, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        return undefined;
      }
      const payload: unknown = await response.json();
      return typeof payload === "object" &&
        payload !== null &&
        typeof (payload as { state?: unknown }).state === "string"
        ? (payload as { state: string }).state
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Ask the cookie-only chrome endpoint whether the session is still alive. Returns true when the
   * adapter must stop (auth expired) and false when retries may continue.
   */
  async function probeAuth(): Promise<boolean> {
    if (doc?.hidden === true || probedThisWindow || probeInFlight) {
      return false;
    }
    if (now() - lastProbeAt < AUTH_PROBE_COOLDOWN_MS) {
      return false;
    }
    probeInFlight = true;
    probedThisWindow = true;
    lastProbeAt = now();
    try {
      const response = await fetchImpl("/api/ui/chrome?path=/terminal", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) {
        generation += 1;
        clearRetry();
        closeSocketSilently();
        setStatus("paused");
        setBanner(null);
        if (options.onAuthExpired !== undefined) {
          options.onAuthExpired();
        } else if (location !== undefined) {
          const nextPath = `${location.pathname}${location.search}${location.hash}`;
          location.assign(`/login?next=${encodeURIComponent(nextPath)}`);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      probeInFlight = false;
    }
  }

  function connectSocket(expectedGeneration: number): void {
    if (websocket === undefined || location === undefined) {
      retryFailure = false;
      scheduleRetry();
      return;
    }
    lastCols = 0;
    lastRows = 0;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    let current: TerminalWebSocket;
    try {
      current = new websocket(`${scheme}//${location.host}${options.wsPath}`);
    } catch {
      retryFailure = false;
      scheduleRetry();
      return;
    }
    socket = current;
    current.binaryType = "arraybuffer";
    current.onopen = () => {
      if (socket !== current || generation !== expectedGeneration || disposed) {
        return;
      }
      const reconnect = connectedOnce;
      retryAttempt = 0;
      probedThisWindow = false;
      connectedOnce = true;
      setStatus("live");
      setBanner(null);
      options.onOpen?.(reconnect);
    };
    current.onmessage = (event) => {
      if (socket !== current || disposed) {
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        options.onData?.(new Uint8Array(event.data));
      }
    };
    current.onerror = () => {
      // The close event carries the failure code; do not double-report here.
    };
    current.onclose = (event) => {
      if (socket !== current) {
        return;
      }
      socket = null;
      void handleClose(event);
    };
  }

  async function handleClose(event: CloseEventLike): Promise<void> {
    const currentGeneration = generation;
    const manual = closedByOperator;
    closedByOperator = false;
    const code = typeof event.code === "number" ? event.code : 0;
    const normalExit = code === 1000 || code === 1001;
    if (manual) {
      setStatus("closed");
      setBanner("Terminal closed. The application keeps running.");
      options.onExit?.("closed");
    } else if (normalExit) {
      setStatus("exited");
      setBanner("Shell exited. Reconnect to start a new shell.");
      options.onExit?.("exited");
    } else {
      retryFailure = code === 1011;
      setStatus(retryFailure ? "failed" : "reconnecting");
      setBanner("Connection failed. Checking the runtime...");
      options.onExit?.("failed");
    }
    const state = await fetchRuntimeState();
    if (currentGeneration !== generation || disposed) {
      return;
    }
    if (runtimeUnavailable(state)) {
      showStopped();
      return;
    }
    if (manual || normalExit) {
      return;
    }
    if (await probeAuth()) {
      return;
    }
    if (currentGeneration !== generation || disposed) {
      return;
    }
    scheduleRetry();
  }

  async function prepareConnect(manual: boolean): Promise<void> {
    if (disposed) {
      return;
    }
    generation += 1;
    const currentGeneration = generation;
    closedByOperator = false;
    clearRetry();
    closeSocketSilently();
    if (manual) {
      retryAttempt = 0;
      probedThisWindow = false;
    }
    setStatus("connecting");
    setBanner(null);
    const state = await fetchRuntimeState();
    if (currentGeneration !== generation || disposed) {
      return;
    }
    if (runtimeUnavailable(state)) {
      showStopped();
      return;
    }
    connectSocket(currentGeneration);
  }

  function sendBytes(bytes: Uint8Array): void {
    if (socket === null || socket.readyState !== OPEN || bytes.length === 0) {
      return;
    }
    let offset = 0;
    while (offset < bytes.length) {
      let end = Math.min(offset + INPUT_CHUNK, bytes.length);
      if (end < bytes.length) {
        while (end > offset && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
          end -= 1;
        }
        if (end === offset) {
          end = Math.min(offset + INPUT_CHUNK, bytes.length);
        }
      }
      socket.send(bytes.subarray(offset, end));
      offset = end;
    }
  }

  return {
    connect(manual = false): void {
      void prepareConnect(manual);
    },
    close(): void {
      if (disposed) {
        return;
      }
      closedByOperator = true;
      generation += 1;
      clearRetry();
      setStatus("closed");
      setBanner("Terminal closed. The application keeps running.");
      const current = socket;
      if (current === null) {
        options.onExit?.("closed");
        return;
      }
      if (current.readyState === OPEN) {
        try {
          current.close(1000, "closed by operator");
        } catch {
          closeSocketSilently();
        }
        return;
      }
      closeSocketSilently();
      options.onExit?.("closed");
    },
    suspend(): void {
      if (disposed) {
        return;
      }
      generation += 1;
      clearRetry();
      closeSocketSilently();
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      generation += 1;
      clearRetry();
      closeSocketSilently();
    },
    sendInput(data: string | Uint8Array): void {
      if (typeof data === "string") {
        if (encoder === undefined) {
          return;
        }
        sendBytes(encoder.encode(data));
        return;
      }
      sendBytes(data);
    },
    sendResize(cols: number, rows: number, force = false): void {
      if (socket === null || socket.readyState !== OPEN) {
        return;
      }
      const nextCols = clampSize(cols);
      const nextRows = clampSize(rows);
      if (!force && nextCols === lastCols && nextRows === lastRows) {
        return;
      }
      lastCols = nextCols;
      lastRows = nextRows;
      socket.send(JSON.stringify({ type: "resize", cols: nextCols, rows: nextRows }));
    },
    status(): TerminalStatusKind {
      return statusKind;
    },
  };
}
