<script setup lang="ts">
/**
 * Dispatcher handoff card. All copy is rendered through text interpolation or the safe Markdown
 * builder; the handoff id only ever becomes an internal inbox link.
 */
import { computed } from "vue";
import { agentInitials } from "../../../assets/chat-core.js";
import type { ChatHandoffView } from "../../chat/types.js";
import MarkdownBlock from "./MarkdownBlock.vue";

const HANDOFF_CARD_DETAIL_CHARS = 900;
const HANDOFF_CARD_DETAIL_LINES = 14;

const props = defineProps<{ handoff: ChatHandoffView }>();

function tone(outcome: string | null | undefined): string {
  if (outcome === "completed") return "success";
  if (outcome === "blocked") return "warning";
  if (outcome === "failed") return "error";
  return "neutral";
}

const initials = computed(() => agentInitials(props.handoff.agent));
const needsDetails = computed(
  () =>
    props.handoff.body.length > HANDOFF_CARD_DETAIL_CHARS ||
    props.handoff.body.split("\n").length > HANDOFF_CARD_DETAIL_LINES,
);
const preview = computed(() => {
  const firstLine = props.handoff.body.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
});
</script>

<template>
  <div
    class="handoff-card"
    data-handoff-card
    :data-direction="handoff.direction"
    :data-outcome="handoff.outcome ?? undefined"
  >
    <div class="handoff-card__head">
      <span class="avatar avatar--sm" aria-hidden="true">{{ initials }}</span>
      <span class="handoff-card__route">
        <span class="mono">{{ handoff.from }}</span>
        <span aria-hidden="true">→</span>
        <span class="mono">{{ handoff.to }}</span>
      </span>
      <span class="handoff-card__kind">
        {{ handoff.direction === "request" ? "Request" : "Reply" }}
      </span>
      <span
        v-if="handoff.direction === 'reply' && handoff.outcome != null"
        class="handoff-card__outcome"
        :data-tone="tone(handoff.outcome)"
      >
        {{ handoff.outcome }}
      </span>
      <a
        class="handoff-card__link mono"
        :href="`/handoffs?q=${encodeURIComponent(handoff.id)}`"
        target="_blank"
        rel="noreferrer noopener"
        :title="`Open handoff ${handoff.id} in the inbox`"
      >
        #{{ handoff.id.slice(0, 8) }}
      </a>
    </div>
    <p class="handoff-card__summary">{{ handoff.summary }}</p>
    <details v-if="needsDetails" class="handoff-card__details">
      <summary class="handoff-card__preview">
        {{ preview || (handoff.direction === "request" ? "Request body" : "Reply body") }}
      </summary>
      <MarkdownBlock
        v-if="handoff.body.length > 0"
        :text="handoff.body"
        class="message__body handoff-card__body"
        sealed
      />
      <p v-else class="hint">No handoff body is available yet.</p>
    </details>
    <MarkdownBlock
      v-else-if="handoff.body.length > 0"
      :text="handoff.body"
      class="message__body handoff-card__body"
      sealed
    />
    <p v-else class="hint">No handoff body is available yet.</p>
    <div v-if="handoff.note.length > 0" class="handoff-card__note">
      <p class="overline">Operator note</p>
      <MarkdownBlock :text="handoff.note" class="message__body" sealed />
    </div>
  </div>
</template>
