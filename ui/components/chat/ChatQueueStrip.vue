<script setup lang="ts">
import type { QueueRow } from "../../chat/queue.js";

defineProps<{ rows: readonly QueueRow[] }>();
const emit = defineEmits<{ open: [] }>();

function label(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"} queued`;
}
</script>

<template>
  <div v-if="rows.length > 0" class="chat-queue-strip" data-chat-queue-strip>
    <button
      class="btn btn-ghost btn-sm chat-queue-strip__count"
      type="button"
      aria-haspopup="dialog"
      data-chat-queue-open
      @click="emit('open')"
    >
      {{ label(rows.length) }}
    </button>
    <ol class="chat-queue-strip__list">
      <li
        v-for="row in rows.slice(0, 3)"
        :key="row.id"
        class="chat-queue-strip__item"
        :data-queue-id="row.id"
        :data-state="row.state"
      >
        <span class="chat-queue-strip__preview" :title="row.preview">{{ row.preview }}</span>
        <span class="chat-queue-strip__state">{{ row.state }}</span>
      </li>
      <li v-if="rows.length > 3" class="chat-queue-strip__more">+{{ rows.length - 3 }} more</li>
    </ol>
  </div>
</template>
