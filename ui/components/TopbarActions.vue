<script setup lang="ts">
import { computed } from "vue";
import type { BootTopbar } from "../boot.js";
import { useChatUiStore } from "../stores/chat-ui.js";
import AppIcon from "./AppIcon.vue";

/**
 * The single App-level topbar owner. `ui/main.ts` clears the server fallback once before mount;
 * this component teleports into the same `.topbar__actions` container and renders the boot seed.
 * Chat counters start at zero until the chat store lands; leaving chat restores the default IDE
 * action because the persistent component is never route-unmounted.
 */
const props = defineProps<{
  topbar: BootTopbar;
  workspace?: "chat" | "terminal";
}>();

const chatUi = useChatUiStore();

const chat = computed(() => props.workspace === "chat" || chatUi.active);
const ideHref = computed(() =>
  chat.value && chatUi.ideHref.length > 0 ? chatUi.ideHref : props.topbar.ideHref,
);
const needsInputCount = computed(() =>
  chat.value ? (chatUi.active ? chatUi.needsInputCount : (props.topbar.needsInputCount ?? 0)) : 0,
);
const needsInputLabel = computed(() =>
  needsInputCount.value === 0
    ? "No requests need input"
    : `${needsInputCount.value} ${needsInputCount.value === 1 ? "request needs" : "requests need"} input`,
);
const policyVisible = computed(() =>
  chat.value ? (chatUi.active ? chatUi.policyVisible : props.topbar.policyVisible === true) : false,
);

function openQueue(): void {
  chatUi.setQueueOpen(true);
}

function openPolicy(): void {
  chatUi.setContextOpen(true);
}

function toggleContext(): void {
  chatUi.setContextOpen(!chatUi.contextOpen);
}
</script>

<template>
  <Teleport to=".topbar__actions">
    <template v-if="chat">
      <button
        class="btn btn-ghost btn-sm chat-input-needed"
        id="chat-input-needed"
        type="button"
        aria-haspopup="dialog"
        aria-controls="chat-queue"
        :aria-label="needsInputLabel"
        :aria-expanded="chatUi.queueOpen ? 'true' : 'false'"
        :hidden="needsInputCount === 0"
        @click="openQueue"
      >
        <AppIcon name="message" />
        <span class="chat-input-needed__count" id="chat-input-needed-count" aria-hidden="true">
          {{ needsInputCount }}
        </span>
      </button>
      <button
        class="btn btn-ghost btn-sm policy-chip"
        id="chat-policy-chip"
        type="button"
        aria-controls="chat-policy-warning"
        :aria-expanded="chatUi.contextOpen ? 'true' : 'false'"
        :hidden="!policyVisible"
        @click="openPolicy"
      >
        <AppIcon name="alert-triangle" />
        <span id="chat-policy-chip-label">Policy warning</span>
      </button>
      <button
        class="btn btn-ghost btn-icon chat-context-toggle"
        type="button"
        data-chat-context-toggle
        aria-controls="chat-context"
        :aria-expanded="chatUi.contextOpen ? 'true' : 'false'"
        aria-label="Open context panel"
        title="Context panel"
        @click="toggleContext"
      >
        <AppIcon name="panel-right" />
      </button>
    </template>
    <a
      class="btn btn-ghost btn-icon"
      :href="ideHref"
      target="_blank"
      rel="noreferrer"
      :aria-label="chat ? 'Open application in IDE' : 'Open IDE in a new tab'"
      :title="chat ? 'Open in IDE' : 'Open IDE'"
    >
      <AppIcon name="external" />
    </a>
  </Teleport>
</template>
