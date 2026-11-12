<script setup lang="ts">
/**
 * Renders a symbol from the server-owned icon sprite (`iconSprite()` in `src/http/ui.ts`) or a
 * small client-owned fallback for icons only the SPA uses. No per-icon markup is duplicated in
 * legacy server markup.
 */
import { computed } from "vue";

const props = defineProps<{ name: string; className?: string }>();

const LOCAL_PATHS: Record<string, readonly string[]> = {
  paperclip: [
    "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
  ],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
  image: [
    "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
    "M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
  ],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  circle: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z"],
  stop: ["M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"],
  cpu: ["M4 4h16v16H4z", "M9 9h6v6H9z", "M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"],
  globe: [
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z",
    "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20",
    "M2 12h20",
  ],
  bell: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  git: [
    "M6 3v12",
    "M18 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M18 9a9 9 0 0 1-9 9",
  ],
};

const localPaths = computed(() => LOCAL_PATHS[props.name]);
</script>

<template>
  <svg
    :class="className === undefined ? 'icon' : `icon ${className}`"
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="localPaths !== undefined">
      <path v-for="(path, index) in localPaths" :key="index" :d="path" />
    </template>
    <use v-else :href="`#i-${name}`" />
  </svg>
</template>
