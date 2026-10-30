<script setup lang="ts">
defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <button
    v-if="open"
    class="chat-scrim is-open"
    type="button"
    aria-label="Close sessions drawer"
    data-chat-scrim
    @click="emit('close')"
  ></button>
</template>
