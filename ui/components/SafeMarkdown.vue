<script setup lang="ts">
/**
 * Renders Markdown through the shared `assets/markdown.js` DOM builder.
 *
 * The renderer creates text nodes with `textContent`; this component never assigns HTML. The
 * container is cleared before every render so a changed `text` replaces the previous nodes instead
 * of appending a duplicate copy.
 */
import { onMounted, ref, watch } from "vue";
import { renderMarkdown } from "../../assets/markdown.js";

const props = defineProps<{ text: string; class?: string }>();

const container = ref<HTMLElement | null>(null);

function render(): void {
  const node = container.value;
  if (node === null) {
    return;
  }
  node.replaceChildren();
  renderMarkdown(node, props.text);
}

onMounted(render);
watch(() => props.text, render);
</script>

<template>
  <div ref="container" :class="props.class"></div>
</template>
