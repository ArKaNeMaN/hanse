<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  type AttachmentView,
  contextChipLabel,
  contextDetail,
  contextMeterPercent,
  contextStateClass,
} from "../../../assets/chat-core.js";
import type { ContextSnapshot } from "../../../src/opencode/context.js";
import type { NormalizedTodo } from "../../../src/opencode/prompts.js";
import {
  type ChatScrollMemory,
  readScrollMemory,
  scrollMemoryKey,
  writeScrollMemory,
} from "../../chat/scroll-memory.js";
import type { ChatStreamStatusKind } from "../../chat/stream.js";
import type { ChatMessagePartView, ChatThreadItem, InlineQuestionView } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";
import ChatGeneratingRow from "./ChatGeneratingRow.vue";
import ChatMessage from "./ChatMessage.vue";
import ChatNoticeRow from "./ChatNoticeRow.vue";

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
  messageCount?: string;
  generatingLabel?: string | null;
  sessionTitle?: string;
  streamStatus?: ChatStreamStatusKind;
  waiting?: boolean;
  todos?: readonly NormalizedTodo[];
  contextSnapshot?: ContextSnapshot | null;
  approvalCount?: number;
  questionViewForPart?: (part: ChatMessagePartView, messageID: string) => InlineQuestionView | null;
}>();

const emit = defineEmits<{
  "load-earlier": [];
  "question-submit": [view: InlineQuestionView, answers: string[][]];
  "question-reject": [view: InlineQuestionView];
  "attachment-redeliver": [attachment: AttachmentView];
  "open-context": [section: "context" | "plan"];
}>();

const sessionTitleText = computed(() => {
  const title = props.sessionTitle?.trim();
  if (title !== undefined && title.length > 0) return title;
  return props.sessionId === null ? "Session" : `Session ${props.sessionId.slice(0, 8)}`;
});
const sessionShortId = computed(() =>
  props.sessionId === null ? "" : props.sessionId.slice(0, 8),
);
const liveState = computed(() => {
  if (props.streamStatus === "live") return "live";
  if (props.streamStatus === "paused") return "paused";
  return "starting";
});
const liveLabel = computed(() => {
  if (props.streamStatus === "live") return "Live";
  if (props.streamStatus === "paused") return "Paused";
  return "Connecting";
});
const planCounts = computed(() => {
  const counts = { completed: 0, total: 0 };
  for (const todo of props.todos ?? []) {
    if (todo.status === "cancelled") continue;
    counts.total += 1;
    if (todo.status === "completed") counts.completed += 1;
  }
  return counts;
});
const planLabel = computed(() => `Plan ${planCounts.value.completed}/${planCounts.value.total}`);
const hasPlan = computed(() => (props.todos ?? []).length > 0);
const contextPercent = computed(() => contextMeterPercent(props.contextSnapshot ?? null));
const contextState = computed(() => contextStateClass(props.contextSnapshot ?? null));
const contextLabel = computed(() => contextChipLabel(props.contextSnapshot ?? null));
const contextDetailText = computed(() => contextDetail(props.contextSnapshot ?? null));
const contextTitle = computed(() =>
  props.contextSnapshot === null || props.contextSnapshot === undefined
    ? undefined
    : contextDetailText.value === "—"
      ? undefined
      : contextDetailText.value,
);
const scroll = ref<HTMLElement | null>(null);
const pinned = ref(true);
const unseen = ref(0);
const topRequested = ref(false);
let lastCount = props.items.length;
let restorePending: ChatScrollMemory | null = null;
let bottomFrame: number | null = null;

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

function cancelScheduledBottom(): void {
  if (bottomFrame === null) {
    return;
  }
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(bottomFrame);
  } else {
    clearTimeout(bottomFrame);
  }
  bottomFrame = null;
}

function scheduleBottomScroll(): void {
  if (bottomFrame !== null) {
    return;
  }
  const run = (): void => {
    bottomFrame = null;
    if (pinned.value) {
      scrollToBottom();
    }
  };
  bottomFrame =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(run)
      : (setTimeout(run, 16) as unknown as number);
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
        scheduleBottomScroll();
      } else {
        unseen.value += count - previousCount;
        persist();
      }
      return;
    }
    if (pinned.value) {
      scheduleBottomScroll();
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

watch(
  () => props.approvalCount ?? 0,
  (next, previous) => {
    if (next > (previous ?? 0) && pinned.value) {
      scheduleBottomScroll();
    }
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  cancelScheduledBottom();
  persist();
});

defineExpose({ captureAnchor, restoreAnchor, scrollToBottom, onScroll, unseen });
</script>

<template>
  <section class="chat-thread chat-thread--spa" aria-label="Conversation" data-chat-thread>
    <div class="chat-thread__meta">
      <span class="chat-session-title" data-chat-session-title :title="sessionTitleText">
        {{ sessionTitleText }}
      </span>
      <span v-if="sessionId !== null" class="mono" data-chat-session-id :title="sessionId">{{
        sessionShortId
      }}</span>
      <span
        class="chat-live"
        :data-state="liveState"
        data-chat-live
        role="status"
        aria-live="polite"
      >
        {{ liveLabel }}
      </span>
      <span
        v-if="messageCount !== undefined && messageCount.length > 0"
        class="caption"
        data-chat-message-count
      >
        {{ messageCount }}
      </span>
      <span
        class="chat-waiting"
        :class="{ 'chat-meta-placeholder': waiting !== true }"
        :aria-hidden="waiting !== true"
        data-chat-waiting
        role="status"
        aria-live="polite"
      >
        <AppIcon name="stamp" />Waiting for you
      </span>
      <button
        class="btn btn-ghost btn-sm chat-plan-chip"
        :class="{ 'chat-meta-placeholder': !hasPlan }"
        :aria-hidden="!hasPlan"
        type="button"
        data-chat-plan-chip
        aria-controls="chat-plan-section"
        title="Open the plan panel"
        @click="emit('open-context', 'plan')"
      >
        <AppIcon name="activity" /><span>{{ planLabel }}</span>
      </button>
      <button
        class="btn btn-ghost btn-sm chat-context-chip"
        :class="{
          'chat-meta-placeholder': contextSnapshot === null || contextSnapshot === undefined,
        }"
        :aria-hidden="contextSnapshot === null || contextSnapshot === undefined"
        type="button"
        data-chat-context-chip
        aria-controls="chat-context-usage"
        :data-state="contextState"
        :title="contextTitle"
        @click="emit('open-context', 'context')"
      >
        <AppIcon name="gauge" /><span>{{ contextLabel }}</span>
        <span class="sr-only">{{ contextDetailText }}</span>
        <!-- biome-ignore lint/a11y/useSemanticElements: keep the legacy meter markup and classes -->
        <span
          class="chat-context-chip__meter"
          role="meter"
          aria-label="Context usage"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="contextPercent"
          :aria-valuetext="contextLabel"
        >
          <span
            class="chat-context-chip__fill"
            :style="{ width: `${contextPercent}%` }"
            aria-hidden="true"
          />
        </span>
      </button>
    </div>
    <slot name="policy-warning" />
    <slot name="image-gate" />
    <slot name="image-warning" />
    <div class="chat-thread__viewport">
      <div class="chat-thread__scroll" id="chat-scroll" ref="scroll" @scroll.passive="onScroll">
        <div class="chat-thread__inner" id="chat-messages" role="log" aria-live="off">
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
            Send the first message to start the agent. Its reply appears here, with tool calls in
            place.
          </p>

          <template
            v-for="item in items"
            :key="item.type === 'message' ? item.message.id : `notice:${item.notice.id}`"
          >
            <ChatMessage
              v-if="item.type === 'message'"
              :record="item.message"
              :question-view-for-part="questionViewForPart"
              :data-message-id="item.message.id"
              @question-submit="(view, answers) => emit('question-submit', view, answers)"
              @question-reject="(view) => emit('question-reject', view)"
              @attachment-redeliver="(attachment) => emit('attachment-redeliver', attachment)"
            />
            <ChatNoticeRow v-else :notice="item.notice" />
          </template>
        </div>
        <div class="chat-thread__approvals">
          <slot name="approvals" />
        </div>
        <ChatGeneratingRow
          v-if="
            !stopped &&
            generatingLabel !== undefined &&
            generatingLabel !== null &&
            generatingLabel.length > 0
          "
          :label="generatingLabel"
        />
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
    <slot name="queue-strip" />
    <slot name="session-notice" />
    <slot name="prompt-dock" />
    <slot name="composer" />
  </section>
</template>
