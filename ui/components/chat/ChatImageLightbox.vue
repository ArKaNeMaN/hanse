<script setup lang="ts">
/** Full-size chat image viewer using the native modal dialog primitive. */
import { nextTick, ref, watch } from "vue";
import { safeAttachmentUrl } from "../../../assets/chat-core.js";
import AppIcon from "../AppIcon.vue";

interface LightboxImage {
  readonly src: string;
  readonly name: string;
  readonly downloadURL: string;
  readonly caption?: string;
}

const props = defineProps<{ image: LightboxImage | null }>();
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);

const src = (): string => (props.image === null ? "" : (safeAttachmentUrl(props.image.src) ?? ""));
const downloadURL = (): string =>
  props.image === null ? "" : (safeAttachmentUrl(props.image.downloadURL) ?? "");

function onDialogClick(event: MouseEvent): void {
  if (event.target === dialog.value) emit("close");
}

watch(
  [dialog, () => props.image],
  ([element, image]) => {
    if (element === null) return;
    if (image !== null && !element.open) {
      element.showModal();
      void nextTick().then(() => closeButton.value?.focus());
    } else if (image === null && element.open) {
      element.close();
    }
  },
  { flush: "post", immediate: true },
);

function close(): void {
  emit("close");
}
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog lightbox"
    aria-labelledby="chat-lightbox-title"
    data-chat-lightbox
    @cancel.prevent="close"
    @close="close"
    @keydown.esc.prevent="close"
    @click="onDialogClick"
  >
    <div v-if="image !== null" class="lightbox__frame">
      <div class="lightbox__head">
        <h2 class="lightbox__title" id="chat-lightbox-title">{{ image.name }}</h2>
        <button
          ref="closeButton"
          class="btn btn-ghost btn-icon lightbox__close"
          type="button"
          aria-label="Close image"
          data-chat-lightbox-close
          @click="close"
        >
          <AppIcon name="x" />
        </button>
      </div>
      <img class="lightbox__image" :src="src()" :alt="image.name">
      <div class="lightbox__foot">
        <span v-if="image.caption" class="lightbox__caption">{{ image.caption }}</span>
        <a
          v-if="downloadURL().length > 0"
          class="btn btn-ghost btn-sm"
          :href="downloadURL()"
          :download="image.name"
          data-chat-lightbox-download
        >
          <AppIcon name="download" />Download
        </a>
      </div>
    </div>
  </dialog>
</template>
