<script setup lang="ts">
/** One attachment card from a projected file part or a message attachment strip. */
import { computed, ref } from "vue";
import {
  type AttachmentView,
  attachmentModeLabel,
  formatAttachmentSize,
  safeAttachmentUrl,
} from "../../../assets/chat-core.js";
import { attachmentStateText } from "../../chat/attachments.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{ attachment: AttachmentView }>();

const emit = defineEmits<{ open: [attachment: AttachmentView] }>();

const failed = ref(false);
const downloadURL = computed(() => safeAttachmentUrl(props.attachment.downloadURL));
const isImage = computed(() => props.attachment.kind === "image");
const imageURL = computed(() =>
  isImage.value && props.attachment.state !== "missing" && !failed.value ? downloadURL.value : null,
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
const caption = computed(() => props.attachment.caption?.trim() ?? "");
</script>

<template>
  <article
    class="attachment-card"
    :class="{
      'attachment-card--inline': attachment.inline,
      'attachment-card--image': isImage,
    }"
    :data-attachment-id="attachment.id"
    :data-kind="attachment.kind"
    :data-state="attachment.state"
    :data-inline="attachment.inline ? 'true' : 'false'"
    :data-origin="attachment.origin"
  >
    <div v-if="isImage" class="attachment-card__preview attachment-card__preview--image">
      <button
        v-if="imageURL !== null"
        class="attachment-card__open"
        type="button"
        :aria-label="`Open image: ${name}`"
        data-attachment-open
        @click="emit('open', attachment)"
      >
        <img
          class="attachment-card__image"
          :src="imageURL"
          :alt="name"
          loading="lazy"
          decoding="async"
          @error="failed = true"
        >
      </button>
      <div v-else class="attachment-card__unavailable-image">
        <AppIcon name="image" />
        <span>{{ attachment.state === "missing" ? "Missing file" : "Image unavailable" }}</span>
      </div>
    </div>
    <div v-else class="attachment-card__preview">
      <AppIcon :name="attachment.kind === 'image' ? 'image' : 'file'" />
    </div>
    <div class="attachment-card__body">
      <div class="attachment-card__head">
        <span class="attachment-card__name" :title="name">{{ name }}</span>
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
          <span v-else-if="downloadURL === null" class="attachment-card__unavailable">
            Unavailable
          </span>
          <a
            v-else
            class="attachment-card__download"
            :href="downloadURL"
            :download="name"
            :aria-label="`Download ${name}`"
            data-attachment-download
          >
            <AppIcon name="download" /><span class="attachment-card__download-label">Download</span>
          </a>
        </div>
      </div>
      <span class="attachment-card__meta">{{ meta }}</span>
      <span v-if="caption.length > 0" class="attachment-card__caption">{{ caption }}</span>
    </div>
  </article>
</template>
