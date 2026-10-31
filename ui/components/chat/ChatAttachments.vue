<script setup lang="ts">
/**
 * Composer attachment chips, attach button, file input, drag/drop target, and quota warning.
 * Upload transport and lifecycle stay in `useChatComposer`; this component only presents state and
 * emits user intents.
 */
import { computed, ref } from "vue";
import {
  attachmentIsMutable,
  attachmentModeLabel,
  attachmentModeOptions,
  attachmentModeValue,
  attachmentSupportsInlineMode,
  formatAttachmentSize,
} from "../../../assets/chat-core.js";
import {
  ATTACHMENT_QUOTA_WARN_PERCENT,
  type AttachmentChip,
  attachmentStateText,
} from "../../chat/attachments.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{
  attachments: readonly AttachmentChip[];
  quotaPercent?: number | null;
  disabled?: boolean;
  commandActive?: boolean;
}>();

const emit = defineEmits<{
  "add-files": [files: File[]];
  retry: [key: string];
  remove: [key: string];
  cancel: [key: string];
  mode: [key: string, mode: "auto" | "inline" | "file"];
}>();

const dragging = ref(false);
let dragDepth = 0;

const quotaWarning = computed(
  () =>
    typeof props.quotaPercent === "number" && props.quotaPercent >= ATTACHMENT_QUOTA_WARN_PERCENT,
);

function hasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return types === undefined ? false : Array.from(types).includes("Files");
}

function onDragEnter(event: DragEvent): void {
  if (props.disabled === true || props.commandActive === true || !hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dragging.value = true;
}

function onDragOver(event: DragEvent): void {
  if (props.disabled === true || props.commandActive === true || !hasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
}

function onDragLeave(event: DragEvent): void {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

function onDrop(event: DragEvent): void {
  if (props.disabled === true || props.commandActive === true || !hasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth = 0;
  dragging.value = false;
  const files = event.dataTransfer?.files;
  if (files !== undefined && files.length > 0) emit("add-files", Array.from(files));
}

function chipSub(chip: AttachmentChip): string {
  if (chip.status === "uploading") {
    return `Uploading ${Math.round(chip.progress)}% · ${formatAttachmentSize(chip.size)}`;
  }
  if (chip.status === "error") return chip.error ?? "Upload failed";
  const parts = [formatAttachmentSize(chip.size)];
  if (chip.mime.length > 0) parts.push(chip.mime);
  const state = attachmentStateText(chip.state);
  if (state.length > 0) parts.push(state);
  parts.push(attachmentModeLabel(chip.kind, chip.mode));
  return parts.join(" · ");
}

function modeOptions(chip: AttachmentChip): ReturnType<typeof attachmentModeOptions> {
  return chip.status === "ready" && attachmentIsMutable(chip)
    ? attachmentModeOptions(chip.kind)
    : [];
}

function modeValue(chip: AttachmentChip): string {
  return attachmentModeValue(chip.kind, chip.mode);
}

function canRemove(chip: AttachmentChip): boolean {
  return chip.status !== "uploading" && !(chip.status === "ready" && chip.state !== "draft");
}
</script>

<template>
  <!-- biome-ignore lint/a11y/useSemanticElements: the legacy attachment strip is a labelled group -->
  <div
    class="chat-attachments"
    :class="{
      'is-drop-target': dragging,
      'chat-attachments--empty': attachments.length === 0 && !quotaWarning,
    }"
    role="group"
    aria-label="Attachments"
    data-chat-attachments
    :data-drop-target="dragging ? 'true' : undefined"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div v-if="attachments.length > 0" class="chat-attachments__list" data-chat-attachment-list>
      <div
        v-for="chip in attachments"
        :key="chip.key"
        class="chat-attachment"
        :data-attachment-key="chip.key"
        :data-attachment-id="chip.id.length > 0 ? chip.id : undefined"
        :data-status="chip.status"
        :data-kind="chip.kind"
        :data-state="chip.state"
      >
        <span class="chat-attachment__icon">
          <AppIcon :name="chip.kind === 'image' ? 'image' : 'file'" />
        </span>
        <div class="chat-attachment__meta">
          <span class="chat-attachment__name" :title="chip.name || 'Attachment'">
            {{ chip.name || "Attachment" }}
          </span>
          <span class="chat-attachment__sub">{{ chipSub(chip) }}</span>
        </div>
        <div class="chat-attachment__actions">
          <button
            v-if="chip.status === 'error'"
            class="btn btn-secondary btn-sm"
            type="button"
            data-attachment-retry
            :aria-label="`Retry ${chip.name || 'attachment'}`"
            @click="emit('retry', chip.key)"
          >
            Retry
          </button>
          <select
            v-if="modeOptions(chip).length > 0"
            class="chat-attachment__mode-select"
            :value="modeValue(chip)"
            :aria-label="`Delivery mode for ${chip.name || 'attachment'}`"
            title="Delivery mode"
            data-attachment-mode
            @change="
              emit(
                'mode',
                chip.key,
                attachmentModeValue(chip.kind, ($event.target as HTMLSelectElement | null)?.value),
              )
            "
          >
            <option v-for="option in modeOptions(chip)" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <span
            v-else-if="chip.status === 'ready'"
            class="chat-attachment__mode"
            :data-inline="attachmentSupportsInlineMode(chip.kind) ? undefined : 'false'"
          >
            {{
              attachmentIsMutable(chip) ? "File only" : attachmentModeLabel(chip.kind, chip.mode)
            }}
          </span>
          <button
            v-if="chip.status === 'uploading'"
            class="btn btn-ghost btn-icon btn-sm chat-attachment__remove"
            type="button"
            :aria-label="`Cancel ${chip.name || 'attachment'} upload`"
            title="Cancel upload"
            data-attachment-cancel
            @click="emit('cancel', chip.key)"
          >
            <AppIcon name="x" />
          </button>
          <button
            v-else
            class="btn btn-ghost btn-icon btn-sm chat-attachment__remove"
            type="button"
            :aria-label="`Remove ${chip.name || 'attachment'}`"
            :disabled="!canRemove(chip)"
            :title="canRemove(chip) ? 'Remove' : 'This attachment has already been delivered'"
            data-attachment-remove
            @click="emit('remove', chip.key)"
          >
            <AppIcon name="x" />
          </button>
        </div>
        <div
          v-if="chip.status === 'uploading'"
          class="chat-attachment__progress"
          role="progressbar"
          :aria-label="`Uploading ${chip.name || 'attachment'}`"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(chip.progress)"
        >
          <span
            class="chat-attachment__progress-fill"
            :style="{ '--attachment-progress': `${Math.round(chip.progress)}%` }"
          />
        </div>
      </div>
    </div>
    <p v-if="quotaWarning" class="chat-attachments__quota" data-chat-attachment-quota>
      Attachment storage {{ Math.round(quotaPercent ?? 0) }}% full
    </p>
  </div>
</template>
