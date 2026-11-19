<script setup lang="ts">
/** Collapsed group of one contiguous cycle of reasoning and non-question tool calls. */
import type { ChatWorkGroupView } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";
import ReasoningPart from "./ReasoningPart.vue";
import ToolPart from "./ToolPart.vue";

defineProps<{ group: ChatWorkGroupView }>();
</script>

<template>
  <details
    class="tool-call chat-work-group"
    :data-work-group-id="group.id"
    :open="group.hasError || undefined"
  >
    <summary>
      <AppIcon name="activity" />
      <span class="mono">Working</span>
      <span class="chat-work-group__metrics">{{ group.metricsText }}</span>
      <AppIcon name="chevron-down" class-name="chat-work-group__chevron" />
    </summary>
    <div class="chat-work-group__body">
      <template v-for="part in group.parts" :key="part.id">
        <ReasoningPart v-if="part.type === 'reasoning'" :part="part" />
        <ToolPart v-else-if="part.type === 'tool'" :part="part" />
      </template>
    </div>
  </details>
</template>
