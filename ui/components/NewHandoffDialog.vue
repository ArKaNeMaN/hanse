<script setup lang="ts">
import { ref } from "vue";
import { ApiError, apiMutation } from "../api.js";
import type { NewHandoffDialogProps } from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppIcon from "./AppIcon.vue";

interface HandoffCreateResponse {
  readonly ok: true;
  readonly handoffId: string;
  readonly status: "queued" | "awaiting_approval";
  readonly state: string;
}

const props = defineProps<{ dialog: NewHandoffDialogProps }>();
const emit = defineEmits<{ saved: [] }>();

const toasts = useToastStore();
const summaryInput = ref("");
const specInput = ref("");
const fromKey = ref<string | null>(null);
const toKey = ref<string | null>(null);
const requiresApproval = ref(true);
const creating = ref(false);
const dialogEl = ref<HTMLDialogElement | null>(null);

function open(): void {
  summaryInput.value = "";
  specInput.value = "";
  fromKey.value = props.dialog.fromKey;
  toKey.value = props.dialog.toKey;
  requiresApproval.value = true;
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
    summaryInput.value = "";
    specInput.value = "";
  }
}

function createHandoff(): void {
  const summary = summaryInput.value.trim();
  if (
    summary.length === 0 ||
    creating.value ||
    props.dialog.disabled ||
    fromKey.value === null ||
    toKey.value === null
  ) {
    return;
  }
  creating.value = true;
  void apiMutation<HandoffCreateResponse>(props.dialog.action, {
    form: {
      summary,
      from: fromKey.value,
      to: toKey.value,
      spec: specInput.value,
      ...(requiresApproval.value ? { requires_approval: "1" } : {}),
      project: props.dialog.projectId,
      return_to: props.dialog.returnTo,
    },
  })
    .then((result) => {
      toasts.push(
        result.status === "awaiting_approval"
          ? "Handoff created; awaiting operator approval."
          : "Handoff created.",
        "success",
      );
      emit("saved");
      dialogEl.value?.close();
    })
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "handoff_exists") {
        toasts.push("Handoff already exists.", "success");
        emit("saved");
        dialogEl.value?.close();
        return;
      }
      const message =
        error instanceof ApiError || error instanceof Error
          ? error.message
          : "Could not create handoff.";
      toasts.push(message, "error");
    })
    .finally(() => {
      creating.value = false;
    });
}

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog"
    id="new-handoff"
    aria-labelledby="new-handoff-title"
    @close="onClose"
  >
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="new-handoff-title">New handoff</h2>
        <p class="dialog__meta">
          {{ dialog.projectName }} /
          {{ dialog.appOptions.length }} application{{ dialog.appOptions.length === 1 ? "" : "s" }}
        </p>
      </header>
      <form
        class="dialog__form"
        method="post"
        :action="dialog.action"
        @submit.prevent="createHandoff"
      >
        <div class="dialog__body">
          <div class="field">
            <label class="label" for="handoff-summary">Summary (required)</label>
            <input
              id="handoff-summary"
              v-model="summaryInput"
              class="input"
              name="summary"
              required
              autocomplete="off"
              placeholder="Add an idempotency key to invoice sync"
              aria-describedby="handoff-summary-hint"
              :disabled="creating"
            >
            <p class="hint" id="handoff-summary-hint">The receiving agent sees this first.</p>
          </div>
          <div class="field">
            <label class="label" for="handoff-from">From application</label>
            <div class="select-wrap">
              <select
                id="handoff-from"
                v-model="fromKey"
                class="select"
                name="from"
                :disabled="dialog.disabled || creating"
              >
                <option v-if="dialog.appOptions.length === 0" value="">No applications</option>
                <option v-for="appKey in dialog.appOptions" :key="appKey" :value="appKey">
                  {{ appKey }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-to">To application</label>
            <div class="select-wrap">
              <select
                id="handoff-to"
                v-model="toKey"
                class="select"
                name="to"
                :disabled="dialog.disabled || creating"
              >
                <option v-if="dialog.appOptions.length === 0" value="">No applications</option>
                <option v-for="appKey in dialog.appOptions" :key="appKey" :value="appKey">
                  {{ appKey }}
                </option>
              </select>
              <AppIcon name="chevron-down" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-spec">Specification</label>
            <textarea
              id="handoff-spec"
              v-model="specInput"
              class="textarea"
              name="spec"
              placeholder="Describe the change, constraints, and expected result"
              aria-describedby="handoff-spec-hint"
              :disabled="creating"
            ></textarea>
            <p class="hint" id="handoff-spec-hint">
              Plain text. The target agent reads this as the task contract.
            </p>
          </div>
          <label class="check">
            <input
              v-model="requiresApproval"
              class="checkbox"
              type="checkbox"
              name="requires_approval"
              value="1"
              :disabled="creating"
            >
            <span>Require operator approval for this handoff</span>
          </label>
          <p v-if="dialog.disabled" class="hint">
            Add an application to this project before creating a handoff.
          </p>
          <input type="hidden" name="project" :value="dialog.projectId">
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
            :disabled="dialog.disabled || creating"
            :aria-busy="creating ? 'true' : undefined"
          >
            <AppIcon name="branch" />{{ creating ? "Creating…" : "Create handoff" }}
          </button>
        </footer>
      </form>
    </div>
  </dialog>
</template>
