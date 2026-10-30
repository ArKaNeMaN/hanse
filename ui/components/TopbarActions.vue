<script setup lang="ts">
import { computed } from "vue";
import type { BootTopbar } from "../boot.js";
import AppIcon from "./AppIcon.vue";

/**
 * The single App-level topbar owner. `ui/main.ts` clears the server fallback once before mount;
 * this component teleports into the same `.topbar__actions` container and renders the boot seed.
 * Chat counters start at zero until the chat store lands; terminal and every other route render
 * the default IDE action.
 */
const props = defineProps<{ topbar: BootTopbar }>();

const needsInputCount = computed(() => props.topbar.needsInputCount ?? 0);
const needsInputLabel = computed(() =>
  needsInputCount.value === 0
    ? "No requests need input"
    : `${needsInputCount.value} requests need input`,
);
</script>

<template>
  <Teleport to=".topbar__actions">
    <template v-if="topbar.contextToggle === true">
      <button
        class="btn btn-ghost btn-sm chat-input-needed"
        id="chat-input-needed"
        type="button"
        aria-haspopup="dialog"
        aria-controls="chat-queue"
        aria-expanded="false"
        :aria-label="needsInputLabel"
        :hidden="needsInputCount === 0"
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
        aria-expanded="false"
        :hidden="topbar.policyVisible !== true"
      >
        <AppIcon name="alert-triangle" />
        <span id="chat-policy-chip-label">Policy warning</span>
      </button>
      <button
        class="btn btn-ghost btn-icon chat-context-toggle"
        type="button"
        data-chat-context-toggle
        aria-controls="chat-context"
        aria-expanded="false"
        aria-label="Open context panel"
        title="Context panel"
      >
        <AppIcon name="panel-right" />
      </button>
    </template>
    <a
      class="btn btn-ghost btn-icon"
      :href="topbar.ideHref"
      target="_blank"
      rel="noreferrer"
      :aria-label="
        topbar.contextToggle === true ? 'Open application in IDE' : 'Open IDE in a new tab'
      "
      :title="topbar.contextToggle === true ? 'Open in IDE' : 'Open IDE'"
    >
      <AppIcon name="external" />
    </a>
  </Teleport>
</template>
