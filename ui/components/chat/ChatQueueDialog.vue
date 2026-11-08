<script setup lang="ts">
/**
 * Queue modal. Uses the native modal dialog primitive so the browser owns the focus trap and the
 * inert background; `open` drives `showModal()`/`close()` and closing returns focus to the queue
 * count button (or the composer when the count disappeared).
 */
import { nextTick, ref, watch } from "vue";
import type { QueueRow } from "../../chat/queue.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{
  open: boolean;
  rows: readonly QueueRow[];
  runningId?: string | null;
  failed?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
let returnFocus: HTMLElement | null = null;

function rememberFocus(): void {
  const active = document.activeElement;
  returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
}

function focusIfPossible(element: HTMLElement | null): void {
  if (element === null) return;
  const disabled = element instanceof HTMLButtonElement && element.disabled;
  if (!disabled) element.focus();
}

function restoreFocus(): void {
  const previous = returnFocus;
  returnFocus = null;
  if (previous?.isConnected) {
    focusIfPossible(previous);
    if (document.activeElement === previous) return;
  }
  focusIfPossible(document.querySelector<HTMLElement>("[data-chat-queue-open]"));
  if (document.activeElement?.hasAttribute("data-chat-queue-open") === true) return;
  focusIfPossible(document.querySelector<HTMLElement>("[data-chat-composer-input]"));
}

function close(): void {
  emit("close");
}

function onClosed(): void {
  restoreFocus();
}

function onDialogClick(event: MouseEvent): void {
  if (event.target === dialog.value) close();
}

function focusableElements(): HTMLElement[] {
  const node = dialog.value;
  if (node === null) return [];
  return Array.from(
    node.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hidden);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.value?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  [dialog, () => props.open],
  ([element, open]) => {
    if (element === null) return;
    if (open && !element.open) {
      rememberFocus();
      element.showModal();
      void nextTick().then(() => closeButton.value?.focus());
    } else if (!open && element.open) {
      element.close();
    }
  },
  { flush: "post", immediate: true },
);
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog chat-queue"
    id="chat-queue-dialog"
    aria-modal="true"
    aria-labelledby="chat-queue-title"
    data-chat-queue-dialog
    @cancel.prevent="close"
    @close="onClosed"
    @keydown="onKeydown"
    @click="onDialogClick"
  >
    <div class="dialog__frame chat-queue__frame">
      <div class="chat-queue__head">
        <p class="overline" id="chat-queue-title">Queued messages</p>
        <button
          ref="closeButton"
          class="btn btn-ghost btn-icon btn-sm"
          type="button"
          aria-label="Close queued messages"
          data-chat-queue-close
          @click="close"
        >
          <AppIcon name="x" />
        </button>
      </div>
      <p v-if="failed === true" class="chat-queue__error" role="alert" data-chat-queue-failed>
        Could not refresh the queue. Showing the last known messages.
      </p>
      <p v-else-if="rows.length === 0" class="chat-queue__empty" data-chat-queue-empty>
        No messages are queued.
      </p>
      <div v-if="rows.length > 0" class="chat-queue__list">
        <div
          v-for="row in rows"
          :key="row.id"
          class="chat-queue__row"
          :data-queue-id="row.id"
          :data-state="row.id === runningId ? 'active' : row.state"
          :data-active="row.id === runningId ? 'true' : undefined"
          :aria-current="row.id === runningId ? 'true' : undefined"
        >
          <span class="chat-queue__kind">{{ row.id === runningId ? "Active" : row.state }}</span>
          <span class="chat-queue__title">{{ row.preview }}</span>
        </div>
      </div>
    </div>
  </dialog>
</template>
