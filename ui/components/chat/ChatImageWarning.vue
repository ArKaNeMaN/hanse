<script setup lang="ts">
/** App-level image warning banner for a running app. */
import { computed } from "vue";
import { imageActionLabel, imageWarningFromView } from "../../../assets/chat-core.js";

const props = defineProps<{ view: unknown; blocked?: boolean; busy?: boolean }>();
const notify = defineEmits<{ action: [action: string] }>();

const warning = computed(() => (props.blocked === true ? null : imageWarningFromView(props.view)));
const actionLabel = computed(() =>
  warning.value === null ? "" : imageActionLabel(warning.value.action),
);
</script>

<template>
  <div
    v-if="warning !== null"
    class="chat-image-warning"
    data-chat-image-warning
    role="status"
    :data-tone="warning.tone"
  >
    <h2 class="chat-image-warning__title">{{ warning.title }}</h2>
    <p class="chat-image-warning__body">{{ warning.body }}</p>
    <div v-if="actionLabel.length > 0" class="chat-image-warning__actions">
      <button
        class="btn btn-secondary btn-sm"
        type="button"
        data-chat-image-action
        :disabled="busy === true"
        @click="notify('action', warning.action)"
      >
        {{ actionLabel }}
      </button>
    </div>
  </div>
</template>
