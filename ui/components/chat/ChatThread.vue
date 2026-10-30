<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  type ChatScrollMemory,
  readScrollMemory,
  scrollMemoryKey,
  writeScrollMemory,
} from "../../chat/scroll-memory.js";
import type { ChatThreadItem } from "../../chat/types.js";
import ChatMessage from "./ChatMessage.vue";

const props = defineProps<{
  items: readonly ChatThreadItem[];
  sessionId: string | null;
  workspaceKey: string;
  revision: number;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  empty: boolean;
  stopped: boolean;
  loadEarlierEnabled: boolean;
}>();

const emit = defineEmits<{ "load-earlier": [] }>();
const scroll = ref<HTMLElement | null>(null);
const pinned = ref(true);
const unseen = ref(0);
const topRequested = ref(false);
let lastCount = props.items.length;
let restorePending: ChatScrollMemory | null = null;

interface ScrollAnchor extends ChatScrollMemory {
  readonly messageID?: string;
  readonly messageOffset?: number;
}

function element(): HTMLElement | null {
  return scroll.value;
}

function memoryKey(sessionID: string | null = props.sessionId): string | null {
  return scrollMemoryKey(props.workspaceKey, sessionID);
}

function nearBottom(): boolean {
  const node = element();
  if (node === null) {
    return true;
  }
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function persist(sessionID: string | null = props.sessionId): void {
  const node = element();
  if (node === null) {
    return;
  }
  writeScrollMemory(memoryKey(sessionID), {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
  });
}

function messageNodes(): HTMLElement[] {
  const node = element();
  if (node === null) {
    return [];
  }
  return Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"));
}

function scrollToBottom(): void {
  const node = element();
  if (node === null) {
    return;
  }
  node.scrollTop = node.scrollHeight;
  pinned.value = true;
  unseen.value = 0;
  topRequested.value = false;
  persist();
}

function captureAnchor(): ScrollAnchor | null {
  const node = element();
  if (node === null) {
    return null;
  }
  const anchor: ScrollAnchor = {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
  };
  for (const message of messageNodes()) {
    if (message.offsetHeight > 0 && message.offsetTop + message.offsetHeight > node.scrollTop) {
      return {
        ...anchor,
        messageID: message.dataset.messageId,
        messageOffset: message.offsetTop - node.scrollTop,
      };
    }
  }
  return anchor;
}

function restoreAnchor(anchor: ScrollAnchor | ChatScrollMemory | null): void {
  const node = element();
  if (node === null || anchor === null) {
    return;
  }
  const target =
    "messageID" in anchor && anchor.messageID !== undefined
      ? messageNodes().find((message) => message.dataset.messageId === anchor.messageID)
      : undefined;
  const delta = node.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
  if (delta > 0) {
    // Prepend: keep the same content under the viewport by preserving the distance from the top.
    node.scrollTop = delta;
  } else if (target !== undefined && "messageOffset" in anchor) {
    node.scrollTop = target.offsetTop - (anchor.messageOffset ?? 0);
  } else {
    node.scrollTop = delta;
  }
  pinned.value = nearBottom();
  unseen.value = 0;
  topRequested.value = node.scrollTop > 32;
  persist();
}

function applyRestore(): void {
  const memory = restorePending;
  if (memory === null) {
    return;
  }
  restorePending = null;
  restoreAnchor(memory);
}

function onScroll(): void {
  const node = element();
  if (node === null) {
    return;
  }
  pinned.value = nearBottom();
  if (pinned.value) {
    unseen.value = 0;
  }
  if (node.scrollTop <= 32) {
    if (props.loadEarlierEnabled && !props.loadingEarlier && !topRequested.value) {
      topRequested.value = true;
      emit("load-earlier");
    }
  } else if (node.scrollTop > 64) {
    topRequested.value = false;
  }
  persist();
}

function onNewMessages(): void {
  scrollToBottom();
}

onMounted(async () => {
  await nextTick();
  const memory = readScrollMemory(memoryKey());
  if (memory !== null) {
    restorePending = memory;
    if (props.items.length > 0) {
      applyRestore();
    }
    return;
  }
  if (props.items.length > 0) {
    scrollToBottom();
  }
});

// A session change saves the previous anchor and restores the target session's anchor (or bottom).
watch(
  () => props.sessionId,
  async (next, previous) => {
    if (previous !== undefined && previous !== next) {
      persist(previous);
    }
    pinned.value = false;
    unseen.value = 0;
    topRequested.value = false;
    restorePending = readScrollMemory(memoryKey(next));
    await nextTick();
    if (props.items.length === 0) {
      return;
    }
    if (restorePending !== null) {
      applyRestore();
      lastCount = props.items.length;
      return;
    }
    pinned.value = true;
    scrollToBottom();
    lastCount = props.items.length;
  },
  { flush: "post" },
);

// Content changes: follow the bottom only while pinned; a prepend keeps the captured anchor.
watch(
  () => [props.items.length, props.revision] as const,
  async ([count]) => {
    const previousCount = lastCount;
    lastCount = count;
    await nextTick();
    if (restorePending !== null) {
      applyRestore();
      return;
    }
    if (props.loadingEarlier) {
      return;
    }
    if (count > previousCount && previousCount > 0) {
      if (pinned.value) {
        scrollToBottom();
      } else {
        unseen.value += count - previousCount;
        persist();
      }
      return;
    }
    if (pinned.value) {
      scrollToBottom();
    }
  },
  { flush: "post" },
);

watch(
  () => props.loadingEarlier,
  (loading) => {
    if (!loading) {
      const node = element();
      if (node !== null && node.scrollTop > 32) {
        topRequested.value = false;
      }
    }
  },
);

onBeforeUnmount(() => {
  persist();
});

defineExpose({ captureAnchor, restoreAnchor, scrollToBottom, onScroll, unseen });
</script>

<template>
  <section class="chat-thread" aria-label="Conversation" data-chat-thread>
    <div class="chat-thread__viewport">
      <div class="chat-thread__scroll" id="chat-scroll" ref="scroll" @scroll.passive="onScroll">
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
          <p v-else-if="items.length > 0" class="hint chat-history-start" data-chat-history-start>
            Start of conversation
          </p>

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
      <button
        v-if="unseen > 0"
        class="btn btn-secondary btn-sm chat-new-messages"
        type="button"
        data-chat-new-messages
        @click="onNewMessages"
      >
        New messages ({{ unseen }})
      </button>
    </div>
  </section>
</template>
