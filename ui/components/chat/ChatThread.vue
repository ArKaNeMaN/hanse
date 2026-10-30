<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type { ChatThreadItem } from "../../chat/types.js";
import ChatMessage from "./ChatMessage.vue";

const props = defineProps<{
  items: readonly ChatThreadItem[];
  sessionId: string | null;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  empty: boolean;
  stopped: boolean;
  loadEarlierEnabled: boolean;
}>();

const emit = defineEmits<{ "load-earlier": [] }>();
const scroll = ref<HTMLElement | null>(null);

function nearBottom(): boolean {
  const element = scroll.value;
  if (element === null) {
    return true;
  }
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function scrollToBottom(): void {
  const element = scroll.value;
  if (element === null) {
    return;
  }
  element.scrollTop = element.scrollHeight;
}

function captureAnchor(): { scrollTop: number; scrollHeight: number } | null {
  const element = scroll.value;
  return element === null
    ? null
    : { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
}

function restoreAnchor(anchor: { scrollTop: number; scrollHeight: number } | null): void {
  const element = scroll.value;
  if (element === null || anchor === null) {
    return;
  }
  element.scrollTop = element.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
}

watch(
  () => [props.sessionId, props.items.length] as const,
  async ([sessionID], previous) => {
    const previousSession = previous?.[0];
    if (sessionID !== previousSession || nearBottom()) {
      await nextTick();
      scrollToBottom();
    }
  },
  { flush: "post" },
);

defineExpose({ captureAnchor, restoreAnchor, scrollToBottom });
</script>

<template>
  <section class="chat-thread" aria-label="Conversation" data-chat-thread>
    <div class="chat-thread__scroll" id="chat-scroll" ref="scroll">
      <div class="chat-thread__inner">
        <div v-if="loadEarlierEnabled || loadingEarlier" class="chat-history-row">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            data-chat-load-earlier
            :disabled="loadingEarlier"
            @click="emit('load-earlier')"
          >
            {{ loadingEarlier ? "Loading earlier messages…" : "Load earlier messages" }}
          </button>
        </div>
        <p v-else-if="items.length > 0" class="hint chat-history-start">Start of conversation</p>

        <div v-if="loading" class="skeleton-stack" role="status" aria-live="polite">
          <span class="skeleton skeleton--line"></span>
          <span class="skeleton skeleton--line"></span>
          <span class="skeleton skeleton--line"></span>
        </div>
        <p v-else-if="error !== null" class="form-error" role="alert">{{ error }}</p>
        <div v-else-if="stopped" class="empty-state" data-chat-stopped>
          <h3 class="empty-state__title">Agent is not running</h3>
          <p class="empty-state__body">
            The conversation is preserved. Start the agent from the application page to read live
            updates.
          </p>
        </div>
        <p v-else-if="empty" class="chat-empty" data-chat-empty>
          No messages yet. This build is read-only.
        </p>

        <template
          v-for="item in items"
          :key="item.type === 'message' ? item.message.id : `notice:${item.notice.id}`"
        >
          <ChatMessage
            v-if="item.type === 'message'"
            :record="item.message"
            :data-message-id="item.message.id"
          />
          <div v-else class="feed-notice chat-notice" :data-notice-id="item.notice.id">
            <span class="feed-notice__rule"></span>
            <span>{{ item.notice.reason ?? item.notice.kind ?? "Session notice" }}</span>
            <span class="feed-notice__rule"></span>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
