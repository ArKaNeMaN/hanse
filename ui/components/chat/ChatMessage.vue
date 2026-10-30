<script setup lang="ts">
import type { ChatMessageView } from "../../chat/types.js";

defineProps<{ record: ChatMessageView }>();
</script>

<template>
  <article
    class="message chat-message"
    :class="`chat-message--${record.role}`"
    :data-message-id="record.id"
    :data-role="record.role"
  >
    <div v-if="record.omo !== null" class="chat-omo" data-omo-card>
      <p class="overline">System</p>
      <h3 class="chat-omo__title">{{ record.omo.title }}</h3>
      <p v-if="record.omo.body.length > 0" class="chat-omo__body">{{ record.omo.body }}</p>
    </div>
    <template v-for="part in record.parts" :key="part.id">
      <p
        v-if="part.type === 'text' && part.text.length > 0"
        class="chat-text"
        :data-part-id="part.id"
      >
        {{ part.text }}
      </p>
      <details v-else-if="part.type === 'reasoning' && part.text.length > 0" class="chat-reasoning">
        <summary>Reasoning</summary>
        <p class="chat-text">{{ part.text }}</p>
      </details>
      <div
        v-else-if="part.type === 'tool'"
        class="chat-tool"
        :data-tool="part.title"
        :data-part-id="part.id"
      >
        <span class="chat-tool__name">{{ part.title }}</span>
        <span v-if="part.status.length > 0" class="chat-tool__status">{{ part.status }}</span>
      </div>
      <p v-else-if="part.text.length > 0" class="chat-part" :data-part-type="part.type">
        {{ part.text }}
      </p>
    </template>
    <p v-if="record.optimistic === 'failed'" class="form-error chat-message__error" role="alert">
      This message was not delivered.
    </p>
  </article>
</template>
