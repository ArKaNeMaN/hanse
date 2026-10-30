<script setup lang="ts">
import { computed } from "vue";
import type { RuntimeState } from "../status.js";
import { runtimePill } from "../status.js";
import { TERMINAL_STATUS, type TerminalStatusKind } from "../terminal/socket.js";
import AppIcon from "./AppIcon.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<{
  title: string;
  runtime: RuntimeState;
  status: TerminalStatusKind;
  detail?: string;
  copyEnabled: boolean;
}>();

defineEmits<{
  copy: [];
  reconnect: [];
  close: [];
}>();

const runtime = computed(() => runtimePill(props.runtime));
const status = computed(() => TERMINAL_STATUS[props.status]);
</script>

<template>
  <div class="terminal-toolbar">
    <h1 class="terminal-toolbar__title" id="terminal-title">{{ title }}</h1>
    <span class="terminal-toolbar__meta"><StatusPill :pill="runtime" /></span>
    <span class="terminal-toolbar__status">
      <span
        class="status"
        id="terminal-status"
        :data-state="status.state"
        role="status"
        aria-live="polite"
      >
        <AppIcon :name="status.icon" />
        <span>{{ status.label }}</span>
        <span data-status-detail aria-hidden="true">{{
          detail === undefined ? "" : ` ${detail}`
        }}</span>
      </span>
    </span>
    <div class="terminal-toolbar__actions">
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        id="terminal-copy"
        aria-label="Copy selection"
        :title="copyEnabled ? 'Copy selection' : 'Select terminal text to copy'"
        :disabled="!copyEnabled"
        @click="$emit('copy')"
      >
        <AppIcon name="copy" /><span class="btn__label">Copy</span>
      </button>
      <button
        class="btn btn-secondary btn-sm"
        type="button"
        id="terminal-reconnect"
        aria-label="Reconnect terminal"
        title="Reconnect terminal"
        @click="$emit('reconnect')"
      >
        <AppIcon name="refresh" /><span class="btn__label">Reconnect</span>
      </button>
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        id="terminal-close"
        aria-label="Close terminal"
        title="Close terminal"
        @click="$emit('close')"
      >
        <AppIcon name="x" /><span class="btn__label">Close</span>
      </button>
    </div>
  </div>
</template>
