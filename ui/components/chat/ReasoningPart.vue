<script setup lang="ts">
/** Reasoning details with the legacy elapsed-time affordance and a text-only body. */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { reasoningElapsedMs } from "../../../assets/chat-core.js";
import type { ChatMessagePartView } from "../../chat/types.js";

const props = defineProps<{ part: ChatMessagePartView }>();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

function epochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatElapsed(ms: number | null): string {
  if (ms === null) return "";
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 1) return "";
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

const start = computed(() =>
  epochMs(props.part.data.time && (props.part.data.time as Record<string, unknown>).start),
);
const end = computed(() =>
  epochMs(props.part.data.time && (props.part.data.time as Record<string, unknown>).end),
);
const elapsed = computed(() =>
  formatElapsed(reasoningElapsedMs(start.value, end.value, now.value)),
);

function syncTimer(): void {
  const live = start.value !== null && end.value === null;
  if (live && timer === undefined) {
    timer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  } else if (!live && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

watch([start, end], syncTimer, { immediate: true });
onBeforeUnmount(() => {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
});
</script>

<template>
  <details class="tool-call chat-reasoning" :data-part-id="part.id" data-part-type="reasoning">
    <summary>
      <span class="mono">Thinking</span>
      <span v-if="elapsed.length > 0" class="tool-call__elapsed mono">{{ elapsed }}</span>
    </summary>
    <pre class="chat-reasoning__text">{{ part.text.length > 0 ? part.text : "Reasoning" }}</pre>
  </details>
</template>
