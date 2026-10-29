<script setup lang="ts">
import AppIcon from "./AppIcon.vue";

defineProps<{ from: string; to: string }>();
</script>

<template>
  <span class="table__route">
    <span class="mono">{{ from }}</span>
    <AppIcon name="arrow-right" class-name="icon--sm" />
    <span class="mono">{{ to }}</span>
  </span>
</template>
