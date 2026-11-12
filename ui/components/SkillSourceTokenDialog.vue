<script setup lang="ts">
import { onMounted, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  mode: "replace" | "clear";
  sourceName: string;
  busy?: boolean;
}>();

const emit = defineEmits<{ submit: [token: string]; cancel: [] }>();

const dialogEl = ref<HTMLDialogElement | null>(null);
const token = ref("");
const error = ref<string | null>(null);

function reset(): void {
  token.value = "";
  error.value = null;
}

function syncOpenState(open: boolean): void {
  const dialog = dialogEl.value;
  if (dialog === null) {
    return;
  }
  if (open) {
    reset();
    if (!dialog.open) {
      dialog.showModal();
    }
  } else if (dialog.open) {
    dialog.close();
  }
}

watch(() => props.open, syncOpenState);
onMounted(() => syncOpenState(props.open));

function onSubmit(): void {
  if (props.busy === true) {
    return;
  }
  if (props.mode === "clear") {
    emit("submit", "");
    return;
  }
  if (token.value.trim().length === 0) {
    error.value = "Enter the new token.";
    return;
  }
  const value = token.value;
  token.value = "";
  emit("submit", value);
}

function onCancel(): void {
  if (props.busy === true) {
    return;
  }
  reset();
  emit("cancel");
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog skill-source-token-dialog"
    aria-labelledby="skill-source-token-title"
    @cancel.prevent="onCancel"
  >
    <div class="dialog__frame">
      <form class="dialog__form" @submit.prevent="onSubmit">
        <div class="dialog__head">
          <h2 class="dialog__title" id="skill-source-token-title">
            {{ mode === "replace" ? "Replace token?" : "Clear token?" }}
          </h2>
          <p class="dialog__meta mono">{{ sourceName }}</p>
        </div>

        <div class="dialog__body">
          <template v-if="mode === 'replace'">
            <p>The current token is never shown. Replacing it takes effect for the next sync.</p>
            <div class="field">
              <label class="label" for="skill-source-new-token">New token</label>
              <input
                id="skill-source-new-token"
                v-model="token"
                class="input"
                name="token"
                type="password"
                autocomplete="new-password"
                required
              >
            </div>
            <p v-if="error !== null" class="field-error" role="alert">{{ error }}</p>
          </template>
          <p v-else>
            Background sync will fail until a new token is set. Cached skills remain available.
          </p>
        </div>

        <div class="dialog__foot">
          <button class="btn btn-ghost" type="button" :disabled="busy" @click="onCancel">
            Cancel
          </button>
          <button
            class="btn"
            :class="mode === 'clear' ? 'btn-danger' : 'btn-primary'"
            type="submit"
            :disabled="busy"
          >
            {{ mode === "replace" ? "Replace token" : "Clear token" }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>
