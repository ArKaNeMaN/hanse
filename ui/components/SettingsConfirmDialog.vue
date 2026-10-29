<script setup lang="ts">
import { ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  title: string;
  body: string;
  submitLabel: string;
  busy?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialogEl = ref<HTMLDialogElement | null>(null);

watch(
  () => props.open,
  (open) => {
    const dialog = dialogEl.value;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  },
);

function submit(): void {
  if (props.busy === true) {
    return;
  }
  emit("confirm");
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog"
    aria-labelledby="settings-confirm-title"
    @cancel.prevent="emit('cancel')"
  >
    <div class="dialog__frame">
      <form class="dialog__form" @submit.prevent="submit">
        <div class="dialog__head">
          <h2 class="dialog__title" id="settings-confirm-title">{{ title }}</h2>
        </div>
        <div class="dialog__body">
          <p>{{ body }}</p>
        </div>
        <div class="dialog__foot">
          <button class="btn btn-ghost" type="button" :disabled="busy" @click="emit('cancel')">
            Cancel
          </button>
          <button class="btn btn-danger" type="submit" :disabled="busy">{{ submitLabel }}</button>
        </div>
      </form>
    </div>
  </dialog>
</template>
