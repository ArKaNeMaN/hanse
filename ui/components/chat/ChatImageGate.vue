<script setup lang="ts">
/** Cold-start image gate: a build-configured app with no usable image and not running. */
import { computed } from "vue";
import { imageCardFromView, imageGateFromView } from "../../../assets/chat-core.js";

const props = defineProps<{ view: unknown; busy?: boolean }>();
const notify = defineEmits<{ action: [action: string] }>();

const gate = computed(() => imageGateFromView(props.view));
const card = computed(() => imageCardFromView(props.view));
const tone = computed(() => {
  if (gate.value.state === "build_error") return "error";
  if (gate.value.state === "building") return "info";
  return "warning";
});
</script>

<template>
  <section
    v-if="gate.blocked && card !== null"
    class="chat-image-gate"
    data-chat-image-gate
    role="region"
    aria-live="polite"
    :data-tone="tone"
    :data-state="gate.state"
  >
    <h2 class="chat-image-gate__title">{{ card.title }}</h2>
    <p class="chat-image-gate__body">{{ card.body }}</p>
    <div v-if="card.action !== 'none'" class="chat-image-gate__actions">
      <button
        class="btn btn-primary btn-sm"
        type="button"
        data-chat-image-action
        :disabled="busy === true"
        @click="notify('action', card.action)"
      >
        {{ card.actionLabel }}
      </button>
    </div>
  </section>
</template>
