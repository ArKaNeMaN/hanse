<script setup lang="ts">
/** The prompt dock shows the oldest uncorrelated request for the active session. */
import { computed } from "vue";
import type { PromptEntry } from "../../stores/chat-prompts.js";
import AppIcon from "../AppIcon.vue";
import ChatPermissionCard from "./ChatPermissionCard.vue";
import ChatQuestionCard from "./ChatQuestionCard.vue";

const props = defineProps<{
  entries: readonly PromptEntry[];
  busyFor: (key: string) => boolean;
  errorFor: (key: string) => string | undefined;
  autoFocus?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "question-submit": [entry: PromptEntry, answers: string[][]];
  "question-reject": [entry: PromptEntry];
  "permission-once": [entry: PromptEntry];
  "permission-always": [entry: PromptEntry];
  "permission-deny": [entry: PromptEntry, message: string];
  "open-saved": [];
}>();

const current = computed<PromptEntry | undefined>(() => props.entries[0]);
const queueCount = computed(() => Math.max(0, props.entries.length - 1));
const questionView = computed(() => {
  const entry = current.value;
  if (entry === undefined || entry.kind !== "question") return null;
  return {
    key: entry.request.key,
    correlationKey: "",
    questions: entry.request.questions,
    state: entry.request.tooLarge ? ("tooLarge" as const) : ("pending" as const),
    stateLabel: entry.request.tooLarge ? "Too large" : "",
    ...(entry.request.tooLarge && entry.request.tooLargeReason !== undefined
      ? { tooLargeReason: entry.request.tooLargeReason }
      : {}),
    answers: null,
    busy: props.busyFor(entry.request.key),
    ...(props.errorFor(entry.request.key) === undefined
      ? {}
      : { error: props.errorFor(entry.request.key) }),
    tooLarge: entry.request.tooLarge,
    readOnly: false,
  };
});
</script>

<template>
  <section
    v-if="current !== undefined"
    class="prompt-dock"
    data-chat-prompt-dock
    aria-label="Agent requests"
    :data-prompt-kind="current.kind"
    :data-prompt-key="current.request.key"
  >
    <ChatQuestionCard
      v-if="current.kind === 'question' && questionView !== null"
      :view="questionView"
      :auto-focus="autoFocus"
      :disabled="disabled"
      :queue-count="queueCount"
      @submit="(answers) => emit('question-submit', current as PromptEntry, answers)"
      @reject="emit('question-reject', current as PromptEntry)"
    />
    <ChatPermissionCard
      v-else-if="current.kind === 'permission'"
      :request="current.request"
      :busy="busyFor(current.request.key)"
      :error="errorFor(current.request.key)"
      :disabled="disabled"
      :queue-count="queueCount"
      @once="emit('permission-once', current as PromptEntry)"
      @always="emit('permission-always', current as PromptEntry)"
      @deny="(message) => emit('permission-deny', current as PromptEntry, message)"
      @open-saved="emit('open-saved')"
    />
    <p v-if="entries.length > 1" class="prompt-dock__queue-count" data-prompt-queue-count>
      <AppIcon name="inbox" />{{ entries.length - 1 }} more waiting
    </p>
  </section>
</template>
