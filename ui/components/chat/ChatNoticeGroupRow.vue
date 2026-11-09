<script setup lang="ts">
/** Grouped notice break rows with a detailed collapsed caption and accessible expansion. */
import { computed, ref } from "vue";
import type { ChatNoticeGroupView } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";
import ChatNoticeRow from "./ChatNoticeRow.vue";

const props = defineProps<{ group: ChatNoticeGroupView }>();
const open = ref(false);
const bodyId = computed(() => `${props.group.id}-body`);
</script>

<template>
  <div
    class="chat-notice-group"
    :class="{ 'chat-notice-group--open': open }"
    :data-notice-group-id="group.id"
  >
    <div class="feed-notice chat-notice">
      <span class="feed-notice__rule"></span>
      <button
        type="button"
        class="feed-notice__body chat-notice-group__toggle"
        :aria-expanded="open"
        :aria-controls="bodyId"
        :title="group.timeTitle"
        @click="open = !open"
      >
        <span class="feed-notice__label">{{ group.reasonLabel }}</span>
        <span class="feed-notice__reason">{{ group.metricsText }}</span>
        <span class="chat-notice-group__breakdown">{{ group.breakdownText }}</span>
        <span class="chat-notice-group__time">{{ group.timeText }}</span>
        <span aria-hidden="true">
          <AppIcon name="chevron-down" class-name="chat-notice-group__chevron" />
        </span>
      </button>
      <span class="feed-notice__rule"></span>
    </div>
    <div :id="bodyId" v-show="open" class="chat-notice-group__body">
      <ChatNoticeRow v-for="notice in group.notices" :key="notice.id" :notice="notice" />
    </div>
  </div>
</template>
