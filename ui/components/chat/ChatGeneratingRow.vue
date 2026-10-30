<script setup lang="ts">
/** Decorative generation row mirroring the active status label. */
defineProps<{ label: string; elapsed?: string }>();
</script>

<template>
  <div class="chat-generating" data-chat-generating aria-hidden="true">
    <span class="chat-generating__dots" aria-hidden="true">
      <span></span><span></span><span></span>
    </span>
    <span class="chat-generating__label" data-chat-generating-label>{{ label }}</span>
    <span v-if="elapsed" class="chat-generating__elapsed">{{ elapsed }}</span>
  </div>
</template>
