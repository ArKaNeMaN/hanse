<script setup lang="ts">
/**
 * Renders a symbol from the server-owned icon sprite (`iconSprite()` in `src/http/ui.ts`).
 * No per-icon markup is duplicated in the client.
 */
defineProps<{ name: string; className?: string }>();
</script>

<template>
  <svg
    :class="className === undefined ? 'icon' : `icon ${className}`"
    aria-hidden="true"
    focusable="false"
  >
    <use :href="`#i-${name}`" />
  </svg>
</template>
