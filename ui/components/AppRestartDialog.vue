<script setup lang="ts">
import { ref } from "vue";
import type { AppRestartProps } from "../app-types.js";
import AppIcon from "./AppIcon.vue";

defineProps<{ restart: AppRestartProps; busy: boolean }>();
const emit = defineEmits<{ confirm: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);

function open(): void {
  if (dialog.value !== null && !dialog.value.open) {
    dialog.value.showModal();
  }
}

function close(): void {
  dialog.value?.close();
}

defineExpose({ open, close });
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    id="app-restart-dialog"
    aria-labelledby="app-restart-dialog-title"
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="app-restart-dialog-title">
          {{ restart.dialogTitle }}
        </h2>
      </header>
      <div class="dialog__body">
        <p class="body">{{ restart.dialogBody }}</p>
      </div>
      <footer class="dialog__foot">
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="close">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="busy" @click="emit('confirm')">
          <AppIcon name="refresh" />{{ busy ? "Restarting…" : "Restart agent" }}
        </button>
      </footer>
    </div>
  </dialog>
</template>
