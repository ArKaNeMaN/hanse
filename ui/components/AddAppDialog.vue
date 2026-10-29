<script setup lang="ts">
import { ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { AddAppDialogProps } from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";

interface AddAppResponse {
  readonly ok: true;
  readonly app: { readonly id: string; readonly appKey: string };
}

const props = defineProps<{ dialog: AddAppDialogProps }>();
const emit = defineEmits<{ saved: [] }>();

const toasts = useToastStore();
const nameInput = ref("");
const pathInput = ref("");
const remoteInput = ref("");
const creating = ref(false);
const dialogEl = ref<HTMLDialogElement | null>(null);

function open(): void {
  nameInput.value = "";
  pathInput.value = "";
  remoteInput.value = "";
  if (dialogEl.value !== null && !dialogEl.value.open) {
    dialogEl.value.showModal();
  }
}

function close(): void {
  if (!creating.value) {
    dialogEl.value?.close();
  }
}

function onClose(): void {
  if (!creating.value) {
    nameInput.value = "";
    pathInput.value = "";
    remoteInput.value = "";
  }
}

async function addApplication(): Promise<void> {
  const name = nameInput.value.trim();
  if (name.length === 0 || creating.value) {
    return;
  }
  creating.value = true;
  try {
    const form: Record<string, string> = {
      name,
      return_to: props.dialog.returnTo,
    };
    const path = pathInput.value.trim();
    if (path.length > 0) {
      form.path = path;
    }
    const remote = remoteInput.value.trim();
    if (remote.length > 0) {
      form.remote = remote;
    }
    await apiMutation<AddAppResponse>(props.dialog.action, { form });
    toasts.push("Application added.", "success");
    emit("saved");
    dialogEl.value?.close();
  } catch (error) {
    const message =
      error instanceof ApiError || error instanceof Error
        ? error.message
        : "Could not add application.";
    toasts.push(message, "error");
  } finally {
    creating.value = false;
  }
}

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog"
    id="add-app"
    aria-labelledby="add-app-title"
    @close="onClose"
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="add-app-title">Add application</h2>
        <p class="dialog__meta">{{ dialog.projectName }} / {{ dialog.rootPath }}</p>
      </header>
      <form
        class="dialog__form"
        method="post"
        :action="dialog.action"
        @submit.prevent="addApplication"
      >
        <div class="dialog__body">
          <div class="field">
            <label class="label" for="add-app-name">Application name (required)</label>
            <input
              id="add-app-name"
              v-model="nameInput"
              class="input"
              name="name"
              required
              autocomplete="off"
              placeholder="gateway"
              aria-describedby="add-app-name-hint"
              :disabled="creating"
            >
            <p class="hint" id="add-app-name-hint">Used as the app key in routes and handoffs.</p>
          </div>
          <div class="field">
            <label class="label" for="add-app-path">Path, optional</label>
            <input
              id="add-app-path"
              v-model="pathInput"
              class="input"
              name="path"
              autocomplete="off"
              placeholder="apps/gateway"
              aria-describedby="add-app-path-hint"
              :disabled="creating"
            >
            <p class="hint" id="add-app-path-hint">
              Relative to the project root. Defaults to apps/&lt;slug&gt;.
            </p>
          </div>
          <div class="field">
            <label class="label" for="add-app-remote">Git remote, optional</label>
            <input
              id="add-app-remote"
              v-model="remoteInput"
              class="input"
              name="remote"
              autocomplete="off"
              placeholder="git@github.com:org/gateway.git"
              aria-describedby="add-app-remote-hint"
              :disabled="creating"
            >
            <p class="hint" id="add-app-remote-hint">
              Clones the repository into the path when provided.
            </p>
          </div>
          <input type="hidden" name="return_to" :value="dialog.returnTo">
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
            <AppIcon name="plus" />{{ creating ? "Adding…" : "Add application" }}
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
