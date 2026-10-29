<script setup lang="ts">
import type { PillSpec } from "../status.js";
import AppIcon from "./AppIcon.vue";

defineProps<{ pill: PillSpec }>();
</script>

<template>
  <span v-if="pill.variant === 'status'" class="status" :data-state="pill.dataState">
    <AppIcon :name="pill.icon" />{{ pill.label }}
  </span>
  <span v-else class="badge"><AppIcon :name="pill.icon" />{{ pill.label }}</span>
</template>
