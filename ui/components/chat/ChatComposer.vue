<script setup lang="ts">
/**
 * Read-only composer shell. Stage 3B has no send/queue/abort/attachment/command path; the textarea
 * and button are disabled placeholders so the layout is stable without offering a mutation.
 */
</script>

<template>
  <div class="composer chat-composer" data-chat-composer-readonly>
    <label class="sr-only" for="chat-composer-input">Message (read-only)</label>
    <textarea
      id="chat-composer-input"
      class="composer__input"
      rows="2"
      disabled
      readonly
      placeholder="Read-only in this build"
      data-chat-composer-input
    ></textarea>
    <div class="composer__actions">
      <span class="hint chat-composer__note">Read-only chat preview</span>
      <button class="btn btn-primary btn-sm" type="button" disabled data-chat-send>Send</button>
    </div>
  </div>
</template>
