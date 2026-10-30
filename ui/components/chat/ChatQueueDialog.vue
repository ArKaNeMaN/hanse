<script setup lang="ts">
import type { QueueRow } from "../../chat/queue.js";
import AppIcon from "../AppIcon.vue";

defineProps<{ open: boolean; rows: readonly QueueRow[] }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div
    v-if="open"
    class="chat-queue"
    role="dialog"
    aria-modal="false"
    aria-labelledby="chat-queue-title"
    data-chat-queue-dialog
  >
    <div class="chat-queue__head">
      <p class="overline" id="chat-queue-title">Queued messages</p>
      <button
        class="btn btn-ghost btn-icon btn-sm"
        type="button"
        aria-label="Close queued messages"
        data-chat-queue-close
        @click="emit('close')"
      >
        <AppIcon name="x" />
      </button>
    </div>
    <div class="chat-queue__list">
      <p v-if="rows.length === 0" class="chat-queue__empty">No messages are queued.</p>
      <div
        v-for="row in rows"
        :key="row.id"
        class="chat-queue__row"
        :data-queue-id="row.id"
        :data-state="row.state"
      >
        <span class="chat-queue__kind">{{ row.state }}</span>
        <span class="chat-queue__title">{{ row.preview }}</span>
      </div>
    </div>
  </div>
</template>
