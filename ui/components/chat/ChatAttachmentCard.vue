<script setup lang="ts">
/** One attachment card from a projected file part or a message attachment strip. */
import { computed } from "vue";
import {
  type AttachmentView,
  attachmentModeLabel,
  canRedeliverAsFile,
  formatAttachmentSize,
  safeAttachmentUrl,
} from "../../../assets/chat-core.js";
import { attachmentStateText } from "../../chat/attachments.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{ attachment: AttachmentView }>();
const emit = defineEmits<{ redeliver: [attachment: AttachmentView] }>();

const downloadURL = computed(() => safeAttachmentUrl(props.attachment.downloadURL));
const thumbnailURL = computed(() =>
  props.attachment.kind === "image" && props.attachment.state !== "missing"
    ? downloadURL.value
    : null,
);
const meta = computed(() => {
  const parts = [formatAttachmentSize(props.attachment.size)];
  if (props.attachment.mime.length > 0) parts.push(props.attachment.mime);
  const state = attachmentStateText(props.attachment.state);
  if (state.length > 0) parts.push(state);
  parts.push(
    props.attachment.inline
      ? "Inline"
      : attachmentModeLabel(props.attachment.kind, props.attachment.mode),
  );
  return parts.join(" · ");
});
const name = computed(() => props.attachment.name || "Attachment");
</script>

<template>
  <article
    class="attachment-card"
    :class="{ 'attachment-card--inline': attachment.inline }"
    :data-attachment-id="attachment.id"
    :data-kind="attachment.kind"
    :data-state="attachment.state"
    :data-inline="attachment.inline ? 'true' : 'false'"
  >
    <div class="attachment-card__preview">
      <img
        v-if="thumbnailURL !== null"
        class="attachment-card__thumb"
        :src="thumbnailURL"
        :alt="name"
        loading="lazy"
        decoding="async"
      >
      <AppIcon v-else :name="attachment.kind === 'image' ? 'image' : 'file'" />
    </div>
    <div class="attachment-card__body">
      <span class="attachment-card__name" :title="name">{{ name }}</span>
      <span class="attachment-card__meta">{{ meta }}</span>
    </div>
    <div class="attachment-card__action">
      <span
        v-if="attachment.state === 'missing'"
        class="attachment-card__unavailable"
        data-attachment-missing
      >
        Missing file
      </span>
      <span
        v-else-if="attachment.state === 'in_flight'"
        class="attachment-card__pending"
        data-attachment-pending
      >
        Sending…
      </span>
      <span v-else-if="downloadURL === null" class="attachment-card__unavailable">Unavailable</span>
      <a
        v-else
        class="attachment-card__download"
        :href="downloadURL"
        :download="name"
        data-attachment-download
      >
        <AppIcon name="download" />Download
      </a>
      <button
        v-if="canRedeliverAsFile(attachment)"
        class="btn btn-ghost btn-sm attachment-card__redeliver"
        type="button"
        title="Send a new file-only copy; this message is unchanged"
        :aria-label="`Send ${name} again as a file`"
        data-attachment-redeliver
        @click="emit('redeliver', attachment)"
      >
        Send again as file
      </button>
    </div>
  </article>
</template>
