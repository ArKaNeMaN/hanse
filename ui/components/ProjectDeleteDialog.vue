<script setup lang="ts">
import { computed, ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import { fullDocumentNavigate } from "../navigation.js";
import type { ProjectDeletion } from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";

interface DeleteResult {
  readonly deleted: true;
  readonly kind: "project" | "app";
  readonly projectId: string;
  readonly warnings: readonly string[];
}

const props = defineProps<{ deletion: ProjectDeletion }>();
const emit = defineEmits<{ deleted: [] }>();

const toasts = useToastStore();
const confirmInput = ref("");
const deleteFiles = ref(false);
const deleting = ref(false);
const dialog = ref<HTMLDialogElement | null>(null);

const matches = computed(() => confirmInput.value === props.deletion.confirmName);
const retrying = computed(() => props.deletion.deleting);

function open(): void {
  confirmInput.value = "";
  deleteFiles.value = false;
  if (dialog.value !== null && !dialog.value.open) {
    dialog.value.showModal();
  }
}

function close(): void {
  if (!deleting.value) {
    dialog.value?.close();
  }
}

function onClose(): void {
  if (!deleting.value) {
    confirmInput.value = "";
    deleteFiles.value = false;
  }
}

async function deleteProject(): Promise<void> {
  if (!matches.value || deleting.value) {
    return;
  }
  deleting.value = true;
  try {
    const result = await apiMutation<DeleteResult>(props.deletion.action, {
      form: {
        confirm: confirmInput.value,
        ...(deleteFiles.value ? { deleteFiles: "true" } : {}),
        return_to: props.deletion.returnTo,
      },
    });
    const warningCount = result.warnings.length;
    const message =
      warningCount === 0
        ? "Project deleted."
        : `Project deleted. Completed with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`;
    const params = new URLSearchParams({
      notice: message,
      tone: warningCount === 0 ? "success" : "error",
    });
    emit("deleted");
    fullDocumentNavigate(`/projects?${params.toString()}`);
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
    id="project-delete-dialog"
    aria-labelledby="project-delete-title"
    @close="onClose"
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="project-delete-title">
          {{ retrying ? "Retry project deletion?" : "Delete project?" }}
        </h2>
        <p class="dialog__meta">
          {{ deletion.projectName }} /
          {{ deletion.appCount }} application{{ deletion.appCount === 1 ? "" : "s" }}
        </p>
      </header>
      <form
        class="dialog__form"
        method="post"
        :action="deletion.action"
        @submit.prevent="deleteProject"
      >
        <div class="dialog__body">
          <p class="body">
            This removes every application in the project, including their sessions, handoffs,
            credentials, and managed images. Checking <strong>Delete files too</strong> also deletes
            the project and application source files on disk.
          </p>
          <div class="field">
            <label class="label" for="project-delete-confirm">
              Type {{ deletion.confirmName }} to confirm (required)
            </label>
            <input
              id="project-delete-confirm"
              v-model="confirmInput"
              class="input"
              name="confirm"
              required
              autocomplete="off"
              spellcheck="false"
              aria-describedby="project-delete-confirm-hint"
              :disabled="deleting"
            >
            <p class="hint" id="project-delete-confirm-hint">
              The project name must match exactly.
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
            {{ deleting ? "Deleting…" : retrying ? "Retry deletion" : "Delete project" }}
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
