<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { SkillSourceView } from "../skill-sources-types.js";

const props = defineProps<{
  open: boolean;
  source: SkillSourceView | null;
  busy?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const dialogEl = ref<HTMLDialogElement | null>(null);
const typed = ref("");

const matches = computed(() => props.source !== null && typed.value.trim() === props.source.slug);

function syncOpenState(open: boolean): void {
  const dialog = dialogEl.value;
  if (dialog === null) {
    return;
  }
  if (open) {
    typed.value = "";
    if (!dialog.open) {
      dialog.showModal();
    }
  } else if (dialog.open) {
    dialog.close();
  }
}

watch(() => props.open, syncOpenState);
onMounted(() => syncOpenState(props.open));

function confirm(): void {
  if (!matches.value || props.busy === true) {
    return;
  }
  emit("confirm");
}

function cancel(): void {
  if (props.busy === true) {
    return;
  }
  emit("cancel");
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="dialog skill-source-delete-dialog"
    aria-labelledby="skill-source-delete-title"
    @cancel.prevent="cancel"
  >
    <div class="dialog__frame">
      <form class="dialog__form" @submit.prevent="confirm">
        <div class="dialog__head">
          <h2 class="dialog__title" id="skill-source-delete-title">Delete skill source?</h2>
          <p v-if="source !== null" class="dialog__meta mono">{{ source.name }}</p>
        </div>

        <div class="dialog__body">
          <ul class="skill-source-consequences">
            <li>Removes the source, its stored token, and its sync schedule.</li>
            <li>
              The cached snapshot is retained for the cleanup window; local skills are not deleted.
            </li>
            <li>
              {{ source?.skillCount ?? 0 }} skills from this source will stop resolving for new
              launches.
            </li>
            <li>Local skills are not deleted.</li>
          </ul>
          <p class="hint">
            Disable is the reversible action: it stops scheduled sync and resolution but keeps the
            source configuration.
          </p>
          <div class="field">
            <label class="label" for="skill-source-delete-slug">
              Type <span class="mono">{{ source?.slug }}</span> to confirm
            </label>
            <input
              id="skill-source-delete-slug"
              v-model="typed"
              class="input mono"
              name="slug"
              type="text"
              autocomplete="off"
              aria-describedby="skill-source-delete-hint"
            >
            <p class="hint" id="skill-source-delete-hint">
              This permanently removes the source. The cached snapshot follows the cleanup policy.
            </p>
          </div>
        </div>

        <div class="dialog__foot">
          <button class="btn btn-ghost" type="button" :disabled="busy" @click="cancel">
            Cancel
          </button>
          <button class="btn btn-danger" type="submit" :disabled="busy || !matches">
            Delete source
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>
