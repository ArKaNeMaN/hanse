<script setup lang="ts">
/**
 * Streaming-safe Markdown renderer over the shared DOM builder.
 *
 * The container is cleared before every render and `renderMarkdown` only appends `textContent`
 * nodes, so untrusted HTML/XML stays text. During streaming rerenders are capped at 50 ms; sealing
 * (or an idle update) renders immediately so the final frame is never lost.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { renderMarkdown } from "../../../assets/markdown.js";

const MARKDOWN_THROTTLE_MS = 50;

const props = defineProps<{
  text: string;
  sealed?: boolean;
  class?: string;
}>();

const container = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let lastRenderedAt = 0;

function renderNow(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  const node = container.value;
  if (node === null) {
    return;
  }
  node.replaceChildren();
  renderMarkdown(node, props.text);
  lastRenderedAt = Date.now();
}

function scheduleRender(): void {
  if (props.sealed === true) {
    renderNow();
    return;
  }
  const now = Date.now();
  const elapsed = now - lastRenderedAt;
  if (elapsed >= MARKDOWN_THROTTLE_MS) {
    renderNow();
    return;
  }
  if (timer !== undefined) {
    return;
  }
  timer = setTimeout(() => {
    timer = undefined;
    renderNow();
  }, MARKDOWN_THROTTLE_MS - elapsed);
}

onMounted(renderNow);
watch(() => props.text, scheduleRender);
watch(
  () => props.sealed,
  (sealed) => {
    if (sealed === true) {
      renderNow();
    }
  },
);

onBeforeUnmount(() => {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
});

defineExpose({ renderNow });
</script>

<template>
  <div ref="container" :class="props.class" data-markdown-block></div>
</template>
