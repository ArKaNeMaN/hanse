<script setup lang="ts">
import { computed } from "vue";
import type { ChatSessionSummary } from "../../stores/chat-session.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{
  sessions: readonly ChatSessionSummary[];
  activeSession: string | null;
  loading: boolean;
  error: string | null;
  stopped: boolean;
}>();

const emit = defineEmits<{ select: [sessionID: string]; close: [] }>();

function label(session: ChatSessionSummary): string {
  if (typeof session.title === "string" && session.title.trim().length > 0) {
    return session.title.trim();
  }
  return session.id.slice(0, 8);
}

const empty = computed(() => !props.loading && props.error === null && props.sessions.length === 0);
</script>

<template>
  <aside class="chat-sessions" aria-label="Sessions" data-chat-sessions-rail>
    <div class="chat-pane-head">
      <p class="overline">Sessions</p>
      <button
        class="btn btn-ghost btn-icon btn-sm chat-sessions-close"
        type="button"
        aria-label="Close sessions"
        @click="emit('close')"
      >
        <AppIcon name="x" />
      </button>
    </div>
    <div class="chat-sessions__list">
      <div v-if="loading" class="skeleton-stack chat-sessions__skeleton" role="status">
        <span class="skeleton skeleton--line"></span>
        <span class="skeleton skeleton--line"></span>
      </div>
      <p v-else-if="error !== null" class="form-error chat-sessions__error" role="alert">
        {{ error }}
      </p>
      <p v-else-if="empty" class="chat-empty">
        {{ stopped ? "Sessions load when the agent starts." : "No sessions yet." }}
      </p>
      <button
        v-for="session in sessions"
        :key="session.id"
        class="session-item"
        type="button"
        :class="{ 'is-active': session.id === activeSession }"
        :aria-current="session.id === activeSession ? 'true' : undefined"
        :data-session-id="session.id"
        :title="label(session)"
        @click="emit('select', session.id)"
      >
        <span class="session-item__title">{{ label(session) }}</span>
        <span class="session-item__meta mono">{{ session.id.slice(0, 8) }}</span>
      </button>
    </div>
  </aside>
</template>
