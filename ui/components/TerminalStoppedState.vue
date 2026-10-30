<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

defineProps<{ chatHref: string }>();
defineEmits<{ reconnect: [] }>();
</script>

<template>
  <div class="empty-state terminal-empty">
    <span class="empty-state__mark">
      <AppIcon name="terminal" class-name="icon--lg" />
    </span>
    <h3 class="empty-state__title">Agent is not running</h3>
    <p class="empty-state__body">
      The terminal attaches to the running application container. Open chat to start the agent, then
      reconnect.
    </p>
    <div class="cluster">
      <a class="btn btn-secondary" data-terminal-chat :href="chatHref">Open chat</a>
      <button class="btn btn-ghost" type="button" data-terminal-retry @click="$emit('reconnect')">
        Reconnect
      </button>
    </div>
  </div>
</template>
