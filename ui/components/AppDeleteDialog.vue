<script setup lang="ts">
import { computed, ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { AppDeleteProps, AppDeleteResult } from "../app-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ deletion: AppDeleteProps }>();
const emit = defineEmits<{ deleted: [result: AppDeleteResult] }>();

const toasts = useToastStore();
const confirmInput = ref("");
const deleteFiles = ref(false);
const deleting = ref(false);
const dialog = ref<HTMLDialogElement | null>(null);

const matches = computed(() => confirmInput.value === props.deletion.confirmName);
const projectDialog = computed(() => props.deletion.dialog === "project");

function open(): void {
  confirmInput.value = "";
  deleteFiles.value = false;
  if (dialog.value !== null && !dialog.value.open) {
    dialog.value.showModal();
  }
}

function close(): void {
  if (!deleting.value) dialog.value?.close();
}

function onClose(): void {
  if (!deleting.value) {
    confirmInput.value = "";
    deleteFiles.value = false;
  }
}

async function submit(): Promise<void> {
  if (!matches.value || deleting.value) return;
  deleting.value = true;
  try {
    const result = await apiMutation<AppDeleteResult>(props.deletion.action, {
      form: {
        confirm: confirmInput.value,
        ...(deleteFiles.value ? { deleteFiles: "true" } : {}),
        return_to: props.deletion.returnTo,
      },
    });
    dialog.value?.close();
    emit("deleted", result);
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Deletion failed; retry or check the coordinator logs.";
    toasts.push(message, "error");
  } finally {
    deleting.value = false;
  }
}

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    id="application-delete-dialog"
    aria-labelledby="application-delete-title"
    @close="onClose"
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="application-delete-title">{{ deletion.title }}</h2>
        <p class="dialog__meta">{{ deletion.confirmName }} / {{ deletion.returnTo }}</p>
      </header>
      <form class="dialog__form" method="post" :action="deletion.action" @submit.prevent="submit">
        <div class="dialog__body">
          <p class="body">
            {{ deletion.description }}
            Checking <strong>Delete files too</strong> also deletes the source files on disk.
          </p>
          <div class="field">
            <label class="label" for="application-delete-confirm">
              Type {{ deletion.confirmName }} to confirm (required)
            </label>
            <input
              id="application-delete-confirm"
              v-model="confirmInput"
              class="input"
              name="confirm"
              required
              autocomplete="off"
              spellcheck="false"
              aria-describedby="application-delete-confirm-hint"
              :disabled="deleting"
            >
            <p class="hint" id="application-delete-confirm-hint">
              The {{ projectDialog ? "project name" : "application key" }} must match exactly.
            </p>
          </div>
          <label class="check">
            <input
              v-model="deleteFiles"
              class="checkbox"
              type="checkbox"
              name="deleteFiles"
              value="true"
              :disabled="deleting"
            >
            <span>Delete files too</span>
          </label>
          <input type="hidden" name="return_to" :value="deletion.returnTo">
        </div>
        <footer class="dialog__foot">
          <button
            class="btn btn-ghost"
            type="button"
            data-dialog-close
            :disabled="deleting"
            @click="close"
          >
            Cancel
          </button>
          <button
            class="btn btn-danger"
            type="submit"
            :disabled="!matches || deleting"
            :aria-busy="deleting ? 'true' : undefined"
          >
            <AppIcon name="trash" />
            {{ deleting ? "Deleting…" : deletion.actionLabel }}
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
