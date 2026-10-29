<script setup lang="ts">
import { ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import { fullDocumentNavigate } from "../navigation.js";
import { useToastStore } from "../stores/toasts.js";

interface CreateProjectResponse {
  readonly ok: true;
  readonly project: { readonly id: string; readonly name: string };
}

const toasts = useToastStore();
const nameInput = ref("");
const creating = ref(false);
const dialog = ref<HTMLDialogElement | null>(null);

/** Open the native dialog from a page action; the same component serves every page. */
function open(): void {
  nameInput.value = "";
  if (dialog.value !== null && !dialog.value.open) {
    dialog.value.showModal();
  }
}

function close(): void {
  if (!creating.value) {
    dialog.value?.close();
  }
}

function onClose(): void {
  if (!creating.value) {
    nameInput.value = "";
  }
}

async function createProject(): Promise<void> {
  const name = nameInput.value.trim();
  if (name.length === 0 || creating.value) {
    return;
  }
  creating.value = true;
  try {
    const result = await apiMutation<CreateProjectResponse>("/api/projects", {
      form: { name },
    });
    const params = new URLSearchParams({ notice: "Project created.", tone: "success" });
    fullDocumentNavigate(`/projects/${encodeURIComponent(result.project.id)}?${params.toString()}`);
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not create project.";
    toasts.push(message, "error");
  } finally {
    creating.value = false;
  }
}

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    id="new-project"
    aria-labelledby="new-project-title"
    @close="onClose"
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="new-project-title">New project</h2>
        <p class="dialog__meta">Creates a project manifest in the workspace</p>
      </header>
      <form
        class="dialog__form"
        method="post"
        action="/api/projects"
        @submit.prevent="createProject"
      >
        <div class="dialog__body">
          <div class="field">
            <label class="label" for="new-project-name">Project name (required)</label>
            <input
              id="new-project-name"
              v-model="nameInput"
              class="input"
              name="name"
              required
              autocomplete="off"
              placeholder="northbank"
              aria-describedby="new-project-hint"
              :disabled="creating"
            >
            <p class="hint" id="new-project-hint">
              A slugged folder with .hanse/project.yaml is created under the workspace root.
            </p>
          </div>
        </div>
        <footer class="dialog__foot">
          <button
            class="btn btn-ghost"
            type="button"
            data-dialog-close
            :disabled="creating"
            @click="close"
          >
            Cancel
          </button>
          <button
            class="btn btn-primary"
            type="submit"
            :disabled="creating"
            :aria-busy="creating ? 'true' : undefined"
          >
            {{ creating ? "Creating…" : "Create project" }}
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
