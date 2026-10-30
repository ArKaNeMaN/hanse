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
  const queueOpen = ref(false);
  const streamStatus = ref<ChatStreamStatusKind>("connecting");
  const streamDetail = ref<string | undefined>(undefined);
  const policyWarnings = ref<readonly string[]>([]);

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

  function setPolicyWarnings(warnings: readonly string[]): void {
    const next = warnings
      .filter((warning) => typeof warning === "string")
      .map((warning) => warning.trim())
      .filter((warning) => warning.length > 0);
    policyWarnings.value = next;
    policyVisible.value = next.length > 0;
  }

  function dismissPolicyWarnings(): void {
    policyWarnings.value = [];
    policyVisible.value = false;
  }

  function dismissPolicyWarning(warning: string): void {
    setPolicyWarnings(policyWarnings.value.filter((entry) => entry !== warning));
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
      queueOpen.value = false;
    }
  }

  function setQueueOpen(open: boolean): void {
    queueOpen.value = open;
    if (open) {
      sessionsOpen.value = false;
      contextOpen.value = false;
    }
  }

  function setContextOpen(open: boolean): void {
    contextOpen.value = open;
    if (open) {
      sessionsOpen.value = false;
      queueOpen.value = false;
    }
  }

  function reset(): void {
    active.value = false;
    ideHref.value = "";
    needsInputCount.value = 0;
    policyVisible.value = false;
    sessionsOpen.value = false;
    contextOpen.value = false;
    queueOpen.value = false;
    streamStatus.value = "connecting";
    streamDetail.value = undefined;
    policyWarnings.value = [];
  }

  return {
    active,
    ideHref,
    needsInputCount,
    policyVisible,
    sessionsOpen,
    contextOpen,
    queueOpen,
    streamStatus,
    streamDetail,
    policyWarnings,
    activate,
    setStreamStatus,
    setNeedsInput,
    setPolicyWarnings,
    dismissPolicyWarnings,
    dismissPolicyWarning,
    setSessionsOpen,
    setContextOpen,
    setQueueOpen,
    reset,
  };
});
