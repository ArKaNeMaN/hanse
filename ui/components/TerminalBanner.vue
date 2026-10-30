<script setup lang="ts">
defineProps<{ text: string | null }>();
</script>

<template>
  <div class="terminal-banner" id="terminal-banner" :hidden="text === null">{{ text }}</div>
</template>
