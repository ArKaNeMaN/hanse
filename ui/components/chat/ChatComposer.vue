<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import {
  type PendingSendView,
  pendingSendActions,
  pendingSendLabel,
} from "../../../assets/chat-core.js";
import type { SendDelivery } from "../../chat/send.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{
  draft: string;
  delivery: SendDelivery;
  error: string | null;
  pending: readonly PendingSendView[];
  mode: "send" | "stop";
  disabled: boolean;
  sendDisabled: boolean;
  stopDisabled: boolean;
  showRecovery: boolean;
  placeholder: string;
}>();

const emit = defineEmits<{
  "update:draft": [value: string];
  send: [];
  stop: [];
  "check-unknown": [];
  "remove-unknown": [];
  "retry-pending": [entry: PendingSendView];
  "dismiss-pending": [entry: PendingSendView];
  "restore-pending": [entry: PendingSendView];
  escape: [];
  "attach-files": [files: File[]];
  "open-commands": [];
}>();

const input = ref<HTMLTextAreaElement | null>(null);
const dragging = ref(false);
let dragDepth = 0;

function resize(): void {
  const node = input.value;
  if (node === null) {
    return;
  }
  node.style.height = "auto";
  const height = Math.min(Math.max(node.scrollHeight, 44), 160);
  node.style.height = `${height}px`;
}

function focus(): void {
  input.value?.focus();
}

function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

function submitSend(): void {
  if (props.disabled || props.sendDisabled) {
    return;
  }
  emit("send");
  void nextTick(focus);
}

function primary(): void {
  if (props.mode === "stop") {
    if (!props.stopDisabled) {
      emit("stop");
    }
    return;
  }
  submitSend();
}

function onInput(event: Event): void {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement) {
    emit("update:draft", target.value);
    resize();
  }
}

function clipboardFiles(event: ClipboardEvent): File[] {
  const transfer = event.clipboardData;
  if (transfer === null) return [];
  const files: File[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files;
}

function onPaste(event: ClipboardEvent): void {
  if (props.disabled) return;
  const files = clipboardFiles(event);
  if (files.length === 0) return;
  event.preventDefault();
  emit("attach-files", files);
}

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types === undefined ? false : Array.from(types).includes("Files");
}

function onDragEnter(event: DragEvent): void {
  if (props.disabled || !hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dragging.value = true;
}

function onDragOver(event: DragEvent): void {
  if (props.disabled || !hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
}

function onDragLeave(event: DragEvent): void {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

function onDrop(event: DragEvent): void {
  if (props.disabled || !hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  const files = event.dataTransfer?.files;
  if (files !== undefined && files.length > 0) emit("attach-files", Array.from(files));
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing) {
    return;
  }
  if (event.key === "Escape") {
    emit("escape");
    return;
  }
  if (event.key !== "Enter") {
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    submitSend();
    return;
  }
  if (isCoarsePointer()) {
    return;
  }
  if (event.shiftKey) {
    return;
  }
  event.preventDefault();
  submitSend();
}

watch(
  () => props.draft,
  () => {
    void nextTick(resize);
  },
);

defineExpose({ focus, resize });
</script>

<template>
  <form
    class="composer chat-composer"
    :class="{ 'is-drop-target': dragging }"
    data-chat-composer
    :data-drop-target="dragging ? 'true' : undefined"
    @submit.prevent="primary"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <slot name="attachments" />
    <div class="composer__row">
      <button
        class="btn btn-ghost btn-icon chat-commands-button"
        type="button"
        aria-label="Commands"
        title="Commands"
        data-chat-commands-button
        @click="emit('open-commands')"
      >
        <AppIcon name="slash" />
      </button>
      <label class="sr-only" for="chat-composer-input">Message</label>
      <textarea
        id="chat-composer-input"
        ref="input"
        class="textarea"
        name="prompt"
        rows="1"
        enterkeyhint="enter"
        :value="draft"
        :disabled="disabled"
        :placeholder="placeholder"
        :aria-busy="delivery === 'sending' || delivery === 'unknown'"
        aria-describedby="chat-composer-hint"
        data-chat-composer-input
        @input="onInput"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>
      <button
        class="btn btn-primary"
        type="button"
        :data-chat-send="mode === 'send' ? 'true' : undefined"
        :data-chat-abort="mode === 'stop' ? 'true' : undefined"
        :disabled="mode === 'stop' ? stopDisabled : sendDisabled"
        @click="primary"
      >
        <AppIcon :name="mode === 'stop' ? 'stop' : 'send'" />
        <span class="btn__label">{{ mode === "stop" ? "Stop" : "Send" }}</span>
      </button>
    </div>
    <div class="composer__hint" id="chat-composer-hint">
      <span>Enter to send / Shift+Enter for a new line</span>
      <span v-if="delivery === 'sending'">Sending…</span>
      <span v-else-if="delivery === 'unknown'">Delivery unknown</span>
      <span v-else-if="delivery === 'queued'">Queued</span>
    </div>
    <p v-if="error !== null" class="field-error" role="alert" data-chat-send-error>
      {{ error }}
    </p>
    <div v-if="showRecovery" class="chat-send-recovery" role="status" data-chat-send-recovery>
      <span>Delivery unknown; checking…</span>
      <button
        class="btn btn-secondary btn-sm"
        type="button"
        data-chat-send-check
        @click="emit('check-unknown')"
      >
        Check again
      </button>
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        data-chat-send-remove
        @click="emit('remove-unknown')"
      >
        Remove
      </button>
    </div>
    <div
      v-for="entry in pending"
      :key="entry.id"
      class="chat-send-recovery"
      role="status"
      :data-pending-id="entry.id"
      :data-state="entry.state"
    >
      <span>{{ pendingSendLabel(entry) }}</span>
      <button
        v-if="pendingSendActions(entry.state).canRestore"
        class="btn btn-secondary btn-sm"
        type="button"
        data-pending-restore
        @click="emit('restore-pending', entry)"
      >
        Restore
      </button>
      <button
        v-if="pendingSendActions(entry.state).canRetry"
        class="btn btn-secondary btn-sm"
        type="button"
        data-pending-retry
        @click="emit('retry-pending', entry)"
      >
        {{ pendingSendActions(entry.state).retryLabel }}
      </button>
      <button
        v-if="!pendingSendActions(entry.state).readOnly"
        class="btn btn-ghost btn-sm"
        type="button"
        data-pending-dismiss
        @click="emit('dismiss-pending', entry)"
      >
        Dismiss
      </button>
    </div>
  </form>
</template>
