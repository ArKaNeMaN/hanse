import { onBeforeUnmount, onMounted, type Ref, ref } from "vue";
import {
  type ChatStream,
  type ChatStreamDeps,
  type ChatStreamOptions,
  type ChatStreamStatusKind,
  createChatStream,
} from "../chat/stream.js";

export interface UseChatStreamOptions {
  readonly url: string;
  readonly onEvent?: ChatStreamOptions["onEvent"];
  readonly onReady?: ChatStreamOptions["onReady"];
  readonly onResync?: ChatStreamOptions["onResync"];
  readonly onLimit?: ChatStreamOptions["onLimit"];
  readonly onAuthExpired?: ChatStreamOptions["onAuthExpired"];
  readonly deps?: ChatStreamDeps;
}

export interface UseChatStream {
  readonly status: Ref<ChatStreamStatusKind>;
  readonly detail: Ref<string | undefined>;
  readonly stream: ChatStream;
  connect(manual?: boolean): void;
  disconnect(): void;
  dispose(): void;
}

/**
 * Page lifecycle wrapper for the chat stream. It owns exactly one adapter and one connection:
 * mount connects, pagehide closes for bfcache, pageshow reconnects once when visible, and unmount
 * disposes every handler/timer/listener. Hidden documents never trigger an app-level reconnect.
 */
export function useChatStream(options: UseChatStreamOptions): UseChatStream {
  const status = ref<ChatStreamStatusKind>("connecting");
  const detail = ref<string | undefined>(undefined);
  const stream = createChatStream({
    url: options.url,
    onEvent: (event) => options.onEvent?.(event),
    onReady: (event) => options.onReady?.(event),
    onResync: (reason) => options.onResync?.(reason),
    onLimit: (message) => options.onLimit?.(message),
    onAuthExpired: () => options.onAuthExpired?.(),
    ...(options.deps === undefined ? {} : { deps: options.deps }),
    onStatus: (kind, nextDetail) => {
      status.value = kind;
      detail.value = nextDetail;
    },
  });

  let suspended = false;
  const win =
    options.deps?.document?.defaultView ?? (typeof window === "undefined" ? undefined : window);
  const doc = options.deps?.document ?? (typeof document === "undefined" ? undefined : document);

  const onPageHide = (): void => {
    suspended = true;
    stream.disconnect();
  };
  const onPageShow = (): void => {
    if (!suspended) {
      return;
    }
    suspended = false;
    if (doc?.visibilityState === "hidden") {
      return;
    }
    stream.connect(false);
  };
  const onBeforeUnload = (): void => {
    stream.disconnect();
  };
  const onVisibility = (): void => {
    if (doc?.visibilityState !== "visible" || suspended) {
      return;
    }
    if (stream.status() !== "live") {
      stream.connect(false);
    }
  };

  onMounted(() => {
    win?.addEventListener("pagehide", onPageHide);
    win?.addEventListener("pageshow", onPageShow);
    win?.addEventListener("beforeunload", onBeforeUnload);
    doc?.addEventListener("visibilitychange", onVisibility);
    stream.connect(false);
  });

  onBeforeUnmount(() => {
    win?.removeEventListener("pagehide", onPageHide);
    win?.removeEventListener("pageshow", onPageShow);
    win?.removeEventListener("beforeunload", onBeforeUnload);
    doc?.removeEventListener("visibilitychange", onVisibility);
    stream.dispose();
  });

  return {
    status,
    detail,
    stream,
    connect: (manual = false) => stream.connect(manual),
    disconnect: () => stream.disconnect(),
    dispose: () => stream.dispose(),
  };
}
