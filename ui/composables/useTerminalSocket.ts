import { onBeforeUnmount, onMounted, type Ref, ref } from "vue";
import {
  createTerminalSocket,
  type TerminalSocket,
  type TerminalSocketDeps,
  type TerminalSocketOptions,
  type TerminalStatusKind,
} from "../terminal/socket.js";

export interface UseTerminalSocketOptions {
  readonly wsPath: string;
  readonly runtimeUrl: string;
  readonly onData?: (bytes: Uint8Array) => void;
  readonly onOpen?: (reconnect: boolean) => void;
  readonly onExit?: TerminalSocketOptions["onExit"];
  readonly onAuthExpired?: () => void;
  /** TerminalView enables this after the xterm instance exists. */
  readonly autoConnect?: boolean;
  readonly deps?: TerminalSocketDeps;
}

export interface UseTerminalSocket {
  readonly status: Ref<TerminalStatusKind>;
  readonly detail: Ref<string | undefined>;
  readonly banner: Ref<string | null>;
  readonly socket: TerminalSocket;
  connect(manual?: boolean): void;
  close(): void;
  sendInput(data: string | Uint8Array): void;
  sendResize(cols: number, rows: number, force?: boolean): void;
}

/**
 * Reactive wrapper around the terminal socket. It owns the pagehide/pageshow lifecycle so bfcache
 * restore reconnects once when visible, and disposes the socket with the component.
 */
export function useTerminalSocket(options: UseTerminalSocketOptions): UseTerminalSocket {
  const status = ref<TerminalStatusKind>("connecting");
  const detail = ref<string | undefined>(undefined);
  const banner = ref<string | null>(null);
  const socket = createTerminalSocket({
    wsPath: options.wsPath,
    runtimeUrl: options.runtimeUrl,
    ...(options.onData === undefined ? {} : { onData: options.onData }),
    ...(options.onOpen === undefined ? {} : { onOpen: options.onOpen }),
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
    ...(options.onAuthExpired === undefined ? {} : { onAuthExpired: options.onAuthExpired }),
    ...(options.deps === undefined ? {} : { deps: options.deps }),
    onStatus: (kind, nextDetail) => {
      status.value = kind;
      detail.value = nextDetail;
    },
    onBanner: (text) => {
      banner.value = text;
    },
  });

  let suspended = false;
  const win =
    options.deps?.document?.defaultView ?? (typeof window === "undefined" ? undefined : window);

  const onPageHide = (): void => {
    suspended = true;
    socket.suspend();
  };
  const onPageShow = (): void => {
    if (!suspended) {
      return;
    }
    suspended = false;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    socket.connect(false);
  };
  const onBeforeUnload = (): void => {
    socket.suspend();
  };

  onMounted(() => {
    win?.addEventListener("pagehide", onPageHide);
    win?.addEventListener("pageshow", onPageShow);
    win?.addEventListener("beforeunload", onBeforeUnload);
    if (options.autoConnect === true) {
      socket.connect(false);
    }
  });

  onBeforeUnmount(() => {
    win?.removeEventListener("pagehide", onPageHide);
    win?.removeEventListener("pageshow", onPageShow);
    win?.removeEventListener("beforeunload", onBeforeUnload);
    socket.dispose();
  });

  return {
    status,
    detail,
    banner,
    socket,
    connect: (manual = false) => socket.connect(manual),
    close: () => socket.close(),
    sendInput: (data) => socket.sendInput(data),
    sendResize: (cols, rows, force = false) => socket.sendResize(cols, rows, force),
  };
}
