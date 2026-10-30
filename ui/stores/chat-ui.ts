/**
 * Route-derived chat UI state: the topbar control set, stream/status vocabulary, and drawer flags.
 *
 * `ChatPage` activates it on mount and resets it on leave; the App-level `TopbarActions` renders the
 * default IDE action whenever this store is inactive. It never writes the URL.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { ChatStreamStatusKind } from "../chat/stream.js";

export const useChatUiStore = defineStore("chat-ui", () => {
  const active = ref(false);
  const ideHref = ref("");
  const needsInputCount = ref(0);
  const policyVisible = ref(false);
  const sessionsOpen = ref(false);
  const contextOpen = ref(false);
  const streamStatus = ref<ChatStreamStatusKind>("connecting");
  const streamDetail = ref<string | undefined>(undefined);

  function activate(topbar: {
    ideHref: string;
    needsInputCount?: number;
    policyVisible?: boolean;
  }): void {
    active.value = true;
    ideHref.value = topbar.ideHref;
    needsInputCount.value = topbar.needsInputCount ?? 0;
    policyVisible.value = topbar.policyVisible ?? false;
  }

  function setStreamStatus(kind: ChatStreamStatusKind, detail?: string): void {
    streamStatus.value = kind;
    streamDetail.value = detail;
  }

  function setNeedsInput(count: number): void {
    needsInputCount.value = Math.max(0, Math.trunc(count));
  }

  function setSessionsOpen(open: boolean): void {
    sessionsOpen.value = open;
    if (open) {
      contextOpen.value = false;
    }
  }

  function setContextOpen(open: boolean): void {
    contextOpen.value = open;
    if (open) {
      sessionsOpen.value = false;
    }
  }

  function reset(): void {
    active.value = false;
    ideHref.value = "";
    needsInputCount.value = 0;
    policyVisible.value = false;
    sessionsOpen.value = false;
    contextOpen.value = false;
    streamStatus.value = "connecting";
    streamDetail.value = undefined;
  }

  return {
    active,
    ideHref,
    needsInputCount,
    policyVisible,
    sessionsOpen,
    contextOpen,
    streamStatus,
    streamDetail,
    activate,
    setStreamStatus,
    setNeedsInput,
    setSessionsOpen,
    setContextOpen,
    reset,
  };
});
