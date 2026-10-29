<script setup lang="ts">
import { onMounted } from "vue";
import type { BootNotice } from "../boot.js";
import { useToastStore } from "../stores/toasts.js";

const props = defineProps<{ notice?: BootNotice }>();
const store = useToastStore();

onMounted(() => {
  if (props.notice !== undefined) {
    store.push(props.notice.message, props.notice.tone);
  }
});
</script>

<template>
  <Teleport to="#toast-region">
    <div
      v-for="toast in store.toasts"
      :key="toast.id"
      class="toast"
      :data-tone="toast.tone"
      :data-autodismiss="toast.tone === 'success' ? '6000' : undefined"
      :role="toast.tone === 'error' ? 'alert' : 'status'"
    >
      <span class="toast__icon" aria-hidden="true">
        <svg
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path
            v-if="toast.tone === 'error'"
            d="M12 9v4M12 17h.01M10.3 3.9 2.3 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14.1a2 2 0 0 0-3.4 0Z"
          />
          <path v-else d="m20 6-11 11-5-5" />
        </svg>
      </span>
      <div class="toast__copy"><strong>{{ toast.message }}</strong></div>
      <button
        class="btn btn-ghost btn-icon btn-sm"
        type="button"
        aria-label="Dismiss"
        @click="store.dismiss(toast.id)"
      >
        <svg
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>
