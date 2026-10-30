<script setup lang="ts">
/**
 * OMO/system-reminder card. The body is rendered through the safe Markdown builder; long or
 * structured bodies stay behind a native `<details>` disclosure.
 */
import { computed } from "vue";
import type { ChatOmoView } from "../../chat/types.js";
import MarkdownBlock from "./MarkdownBlock.vue";

const OMO_DETAILS_CHAR_LIMIT = 600;
const OMO_DETAILS_LINE_LIMIT = 8;

const props = defineProps<{ omo: ChatOmoView }>();

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

const title = computed(() => (props.omo.title.length > 0 ? props.omo.title : props.omo.kind));
const body = computed(() => props.omo.body);
const needsDetails = computed(() => {
  const value = body.value;
  return (
    value.length > OMO_DETAILS_CHAR_LIMIT ||
    value.split("\n").length > OMO_DETAILS_LINE_LIMIT ||
    /\*\*(ID|Description):\*\*/.test(value)
  );
});
const preview = computed(() => {
  const patterns = [
    /\*\*ID:\*\*\s*([^\n]+)/,
    /\*\*Description:\*\*\s*([^\n]+)/,
    /\*\*Duration:\*\*\s*([^\n]+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(body.value);
    if (match?.[1] !== undefined) {
      return collapse(match[1]);
    }
  }
  const firstLine = body.value.split("\n").find((line) => line.trim().length > 0) ?? "";
  return collapse(firstLine);
});
</script>

<template>
  <div class="omo-card" data-omo-card :data-kind="omo.kind" :data-tone="omo.tone">
    <div class="omo-card__head">
      <div class="omo-card__title">{{ title }}</div>
      <span class="omo-card__kind">{{ omo.kind }}</span>
    </div>
    <template v-if="body.trim().length > 0">
      <details v-if="needsDetails" class="omo-card__details">
        <summary class="omo-card__preview">{{ preview }}</summary>
        <MarkdownBlock :text="body" class="omo-card__body message__body" sealed />
      </details>
      <MarkdownBlock v-else :text="body" class="omo-card__body message__body" sealed />
    </template>
  </div>
</template>
