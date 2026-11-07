import type { ProcessEvent } from "../store/process.js";

/** One live process transition frame; the SSE route wraps it in the stream envelope. */
export interface ProcessTransitionFrame {
  type: "process.transition";
  event: ProcessEvent;
}

/** Listener invoked after a process transition commits. */
export type ProcessEventListener = (event: ProcessEvent) => void;

const listeners = new Map<string, Set<ProcessEventListener>>();

/**
 * Module-level process transition bus.
 *
 * The manager emits after its transaction commits; the SSE route (Phase D) subscribes without
 * needing an `InstanceManager` instance, so a stopped app still receives transitions.
 */
export const processEvents = {
  subscribe(appId: string, listener: ProcessEventListener): () => void {
    let appListeners = listeners.get(appId);
    if (appListeners === undefined) {
      appListeners = new Set();
      listeners.set(appId, appListeners);
    }
    appListeners.add(listener);
    return () => {
      const current = listeners.get(appId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(appId);
    };
  },

  emit(appId: string, event: ProcessEvent): void {
    const appListeners = listeners.get(appId);
    if (appListeners === undefined) return;
    for (const listener of [...appListeners]) {
      try {
        listener(event);
      } catch {
        // One closed consumer must not affect the writer or the other consumers.
      }
    }
  },

  /** Test-only reset; production has no lifecycle that drops every subscriber. */
  reset(): void {
    listeners.clear();
  },
};
