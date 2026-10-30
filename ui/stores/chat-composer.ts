/**
 * Composer state: active draft, delivery state, optimistic acceptance, pending sends, and abort.
 *
 * The store never writes the URL, storage, or network. `useChatComposer` owns those side effects.
 */

import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type { PendingSendView } from "../../assets/chat-core.js";
import type { AttachmentChip } from "../chat/attachments.js";
import type { SendDelivery } from "../chat/send.js";

export interface ComposerAcceptance {
  readonly tempID: string | null;
  readonly serverID: string | null;
  readonly text: string;
  readonly sessionID: string;
  readonly state: SendDelivery;
  readonly exposeRecovery: boolean;
}

export const useChatComposerStore = defineStore("chat-composer", () => {
  const workspaceKey = ref<string | null>(null);
  const sessionID = ref<string | null>(null);
  const draft = ref("");
  const error = ref<string | null>(null);
  const delivery = ref<SendDelivery>("idle");
  const inFlight = ref(false);
  const acceptance = ref<ComposerAcceptance | null>(null);
  const pendingSends = shallowRef<readonly PendingSendView[]>(markRaw([]));
  const abortPending = ref(false);
  const lastSaved = shallowRef<ReadonlyMap<string, string>>(markRaw(new Map<string, string>()));
  const attachments = shallowRef<readonly AttachmentChip[]>(markRaw([]));
  const attachmentQuota = ref<number | null>(null);

  function bindWorkspace(key: string): boolean {
    if (workspaceKey.value === key) {
      return false;
    }
    workspaceKey.value = key;
    reset();
    return true;
  }

  function setSession(id: string | null): void {
    sessionID.value = id;
  }

  function setDraft(text: string): void {
    draft.value = text;
  }

  function setError(message: string | null): void {
    error.value = message;
  }

  function setDelivery(next: SendDelivery): void {
    delivery.value = next;
    inFlight.value = next === "sending" || next === "unknown";
  }

  function setPending(list: readonly PendingSendView[]): void {
    pendingSends.value = markRaw([...list]);
  }

  function setAttachments(list: readonly AttachmentChip[]): void {
    attachments.value = markRaw([...list]);
  }

  function updateAttachment(key: string, patch: Partial<AttachmentChip>): void {
    attachments.value = markRaw(
      attachments.value.map((chip) => (chip.key === key ? { ...chip, ...patch } : chip)),
    );
  }

  function removeAttachment(key: string): void {
    attachments.value = markRaw(attachments.value.filter((chip) => chip.key !== key));
  }

  function setAttachmentQuota(percent: number | null): void {
    attachmentQuota.value = percent;
  }

  function lastSavedFor(session: string): string | undefined {
    return lastSaved.value.get(session);
  }

  function setLastSaved(session: string, text: string): void {
    const next = new Map(lastSaved.value);
    if (text.length === 0) {
      next.delete(session);
    } else {
      next.set(session, text);
    }
    lastSaved.value = markRaw(next);
  }

  function beginAcceptance(input: { tempID: string; text: string; sessionID: string }): void {
    const next: ComposerAcceptance = {
      tempID: input.tempID,
      serverID: null,
      text: input.text,
      sessionID: input.sessionID,
      state: "sending",
      exposeRecovery: false,
    };
    acceptance.value = markRaw(next);
    error.value = null;
    setDelivery("sending");
  }

  function markUnknown(serverID: string | null): void {
    const current = acceptance.value;
    if (current === null) {
      return;
    }
    const next: ComposerAcceptance = {
      ...current,
      tempID: serverID === null ? current.tempID : null,
      serverID: serverID ?? current.serverID,
      state: "unknown",
      exposeRecovery: false,
    };
    acceptance.value = markRaw(next);
    setDelivery("unknown");
  }

  function setServerID(serverID: string): void {
    const current = acceptance.value;
    if (current === null) {
      return;
    }
    acceptance.value = markRaw({ ...current, tempID: null, serverID });
  }

  function exposeRecovery(expose: boolean): void {
    const current = acceptance.value;
    if (current === null) {
      return;
    }
    acceptance.value = markRaw({ ...current, exposeRecovery: expose });
  }

  function setAcceptanceState(next: SendDelivery): void {
    const current = acceptance.value;
    if (current !== null) {
      acceptance.value = markRaw({ ...current, state: next, exposeRecovery: false });
    }
    setDelivery(next);
  }

  function clearAcceptance(): void {
    acceptance.value = null;
    setDelivery("idle");
  }

  function removePending(pendingID: string): void {
    pendingSends.value = markRaw(pendingSends.value.filter((entry) => entry.id !== pendingID));
  }

  function setAbortPending(value: boolean): void {
    abortPending.value = value;
  }

  function reset(): void {
    sessionID.value = null;
    draft.value = "";
    error.value = null;
    delivery.value = "idle";
    inFlight.value = false;
    acceptance.value = null;
    pendingSends.value = markRaw([]);
    abortPending.value = false;
    lastSaved.value = markRaw(new Map<string, string>());
    attachments.value = markRaw([]);
    attachmentQuota.value = null;
  }

  return {
    workspaceKey,
    sessionID,
    draft,
    error,
    delivery,
    inFlight,
    acceptance,
    pendingSends,
    abortPending,
    lastSaved,
    attachments,
    attachmentQuota,
    bindWorkspace,
    setSession,
    setDraft,
    setError,
    setDelivery,
    setPending,
    lastSavedFor,
    setLastSaved,
    setAttachments,
    updateAttachment,
    removeAttachment,
    setAttachmentQuota,
    beginAcceptance,
    markUnknown,
    setServerID,
    exposeRecovery,
    setAcceptanceState,
    clearAcceptance,
    removePending,
    setAbortPending,
    reset,
  };
});
