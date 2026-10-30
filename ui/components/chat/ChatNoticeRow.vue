<script setup lang="ts">
/** Full-width notice break row (agent restart/resume/interruption). */
import { computed } from "vue";
import { noticeLabel } from "../../../assets/chat-core.js";
import type { NoticeView } from "../../stores/chat-feed.js";

const props = defineProps<{ notice: NoticeView }>();
const label = computed(() => noticeLabel(props.notice));
</script>

<template>
  <div
    class="feed-notice chat-notice"
    :data-notice-id="notice.id"
    :data-kind="notice.kind ?? ''"
    role="note"
  >
    <span class="feed-notice__rule"></span>
    <p class="feed-notice__body">
      <span class="feed-notice__label">{{ label.label }}</span>
      <span v-if="label.reason.length > 0" class="feed-notice__reason">{{ label.reason }}</span>
    </p>
    <span class="feed-notice__rule"></span>
  </div>
</template>
