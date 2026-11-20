<script setup lang="ts">
/** Collapsed group of one contiguous cycle of reasoning and non-question tool calls. */
import { inject, ref, watch } from "vue";
import {
  TRANSCRIPT_DETAIL_SCOPE,
  type TranscriptDetailScope,
} from "../../chat/transcript-memory.js";
import type { ChatWorkGroupView } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";
import ReasoningPart from "./ReasoningPart.vue";
import ToolPart from "./ToolPart.vue";

const props = defineProps<{ group: ChatWorkGroupView }>();
const scope = inject<TranscriptDetailScope | null>(TRANSCRIPT_DETAIL_SCOPE, null);
const remembered = scope?.isOpen(props.group.id);
const open = ref(props.group.hasError || remembered === true);

function setOpen(value: boolean): void {
  open.value = value;
  scope?.setOpen(props.group.id, value);
}

function onToggle(event: Event): void {
  setOpen((event.target as HTMLDetailsElement).open === true);
}

watch(
  () => props.group.hasError,
  (hasError) => {
    if (hasError) {
      setOpen(true);
    }
  },
);
</script>

<template>
  <details
    class="tool-call chat-work-group"
    :data-work-group-id="group.id"
    :open="open"
    @toggle="onToggle"
  >
    <summary>
      <AppIcon name="activity" />
      <span class="mono">Working</span>
      <span class="chat-work-group__metrics">{{ group.metricsText }}</span>
      <AppIcon name="chevron-down" class-name="chat-work-group__chevron" />
    </summary>
    <div v-if="open" class="chat-work-group__body">
      <template v-for="part in group.parts" :key="part.id">
        <ReasoningPart v-if="part.type === 'reasoning'" :part="part" />
        <ToolPart v-else-if="part.type === 'tool'" :part="part" />
      </template>
    </div>
  </details>
</template>
