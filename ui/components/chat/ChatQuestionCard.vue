<script setup lang="ts">
/**
 * One question request: either the prompt-dock card or an inline card correlated with a
 * `question` tool part. Draft state is keyed by the request so a resolved request cannot leak an
 * answer into the next one. Ctrl/Cmd+Enter submits from anywhere inside the card.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { NormalizedQuestion } from "../../../src/opencode/prompts.js";
import { answersForQuestion, questionLabel, questionNeedsReview } from "../../chat/prompt-utils.js";
import type { InlineQuestionView } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";

const props = defineProps<{
  view: InlineQuestionView;
  inline?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  queueCount?: number;
}>();

const emit = defineEmits<{
  submit: [answers: string[][]];
  reject: [];
}>();

const root = ref<HTMLElement | null>(null);
const selected = ref<string[][]>([]);
const custom = ref<string[]>([]);
const index = ref(0);
const confirm = ref<"dismiss" | "empty" | null>(null);
const focusTick = ref(0);

const questions = computed<readonly NormalizedQuestion[]>(() => props.view.questions);
const interactive = computed(
  () => !props.view.readOnly && props.view.state === "pending" && !props.disabled,
);
const needsReview = computed(() => questionNeedsReview(questions.value));
const current = computed(() => questions.value[index.value]);
const atReview = computed(() => needsReview.value && index.value >= questions.value.length);

function resetDraft(): void {
  selected.value = questions.value.map(() => []);
  custom.value = questions.value.map(() => "");
  index.value = 0;
  confirm.value = null;
}

watch(
  () => props.view.key,
  () => {
    resetDraft();
    focusTick.value += 1;
  },
  { immediate: true },
);

function selectOption(questionIndex: number, label: string): void {
  if (!interactive.value) return;
  const question = questions.value[questionIndex];
  if (question === undefined) return;
  const next = selected.value.map((answers) => [...answers]);
  const answers = next[questionIndex] ?? [];
  if (question.multiple) {
    const at = answers.indexOf(label);
    if (at >= 0) answers.splice(at, 1);
    else answers.push(label);
  } else {
    next[questionIndex] = [label];
  }
  selected.value = next;
  if (!question.multiple && questionIndex < questions.value.length - 1) {
    index.value = questionIndex + 1;
  }
}

function updateCustom(value: string): void {
  const next = [...custom.value];
  next[index.value] = value;
  custom.value = next;
}

function advance(delta: number): void {
  const max = questions.value.length;
  index.value = Math.min(max, Math.max(0, index.value + delta));
}

function submit(): void {
  if (!interactive.value || props.view.busy) return;
  const answers = questions.value.map((_, position) => [
    ...answersForQuestion(selected.value[position] ?? [], custom.value[position] ?? ""),
  ]);
  if (answers.some((answer) => answer.length === 0) && confirm.value !== "empty") {
    confirm.value = "empty";
    return;
  }
  confirm.value = null;
  emit("submit", answers);
}

function reject(): void {
  if (props.view.readOnly || props.disabled) return;
  if (confirm.value !== "dismiss") {
    confirm.value = "dismiss";
    return;
  }
  confirm.value = null;
  emit("reject");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
  if (!interactive.value) return;
  event.preventDefault();
  submit();
}

function focusFirstControl(): void {
  const node = root.value;
  if (node === null) return;
  const target = node.querySelector<HTMLElement>(
    "[data-question-option]:not(:disabled), textarea:not(:disabled), [data-question-primary]:not(:disabled)",
  );
  target?.focus();
}

onMounted(() => {
  if (props.autoFocus === true) void nextTick(focusFirstControl);
});

watch(focusTick, () => {
  if (props.autoFocus === true) void nextTick(focusFirstControl);
});

defineExpose({ submit, reject, focusFirstControl });
</script>

<template>
  <article
    ref="root"
    class="prompt-dock__card chat-question"
    :class="{ 'chat-question--inline': inline === true }"
    :data-question-key="view.key"
    :data-correlation-key="view.correlationKey"
    :data-state="view.state"
    :aria-labelledby="`question-title-${view.key}`"
    @keydown="onKeydown"
  >
    <header class="prompt-dock__head">
      <div class="prompt-dock__identity">
        <span class="overline" :id="`question-title-${view.key}`" tabindex="-1"> Question </span>
        <span v-if="!atReview && questions.length > 1" class="prompt-dock__step-label">
          {{ Math.min(index + 1, questions.length) }}
          of {{ questions.length }}
        </span>
        <span v-if="atReview" class="prompt-dock__step-label">Review</span>
        <span v-if="queueCount !== undefined && queueCount > 0" class="prompt-dock__queue-count">
          {{ queueCount }}
          more waiting
        </span>
        <span
          v-if="view.stateLabel.length > 0"
          class="chat-question__state"
          :data-state="view.state"
        >
          {{ view.stateLabel }}
        </span>
      </div>
    </header>

    <div class="prompt-dock__body">
      <template v-if="view.state === 'pending' || view.state === 'tooLarge'">
        <p v-if="view.tooLarge" class="prompt-dock__title">This question is too large to answer.</p>
        <p v-if="view.tooLarge && view.tooLargeReason !== undefined" class="prompt-dock__copy">
          {{ view.tooLargeReason }}
        </p>
        <template v-else-if="questions.length > 0">
          <template v-if="atReview">
            <div class="chat-question__answers">
              <div
                v-for="(question, position) in questions"
                :key="`review-${position}`"
                class="chat-question__answer"
              >
                <span class="chat-question__answer-label">{{
                  questionLabel(question, position)
                }}</span>
                <span class="chat-question__answer-value">
                  {{
                    (selected[position] ?? []).length === 0 && (custom[position] ?? "").length === 0
                      ? "No answer"
                      : answersForQuestion(selected[position] ?? [], custom[position] ?? "").join(
                          ", ",
                        )
                  }}
                </span>
              </div>
            </div>
          </template>
          <template v-else-if="current !== undefined">
            <p class="prompt-dock__title">{{ questionLabel(current, index) }}</p>
            <div class="prompt-dock__tabs">
              <button
                v-for="option in current.options"
                :key="option.label"
                class="prompt-dock__tab"
                type="button"
                data-question-option
                :data-label="option.label"
                :aria-pressed="(selected[index] ?? []).includes(option.label)"
                :disabled="view.busy || disabled"
                @click="selectOption(index, option.label)"
              >
                <AppIcon
                  :name="(selected[index] ?? []).includes(option.label) ? 'check' : 'circle'"
                />
                <span>{{ option.label }}</span>
                <span v-if="option.description.length > 0" class="caption">
                  {{ option.description }}
                </span>
              </button>
            </div>
            <label
              v-if="current.custom"
              class="label"
              :for="`question-custom-${view.key}-${index}`"
            >
              Custom answer (optional)
            </label>
            <textarea
              v-if="current.custom"
              :id="`question-custom-${view.key}-${index}`"
              class="textarea prompt-feedback"
              rows="2"
              :value="custom[index] ?? ''"
              :disabled="view.busy || disabled"
              @input="updateCustom(($event.target as HTMLTextAreaElement).value)"
            />
          </template>
        </template>
        <p v-else class="prompt-dock__copy">This question has no answer fields.</p>
      </template>

      <template v-else-if="view.state === 'answered'">
        <div
          v-if="view.answers !== null && view.answers !== undefined"
          class="chat-question__answers"
        >
          <div
            v-for="(question, position) in questions"
            :key="`answered-${position}`"
            class="chat-question__answer"
          >
            <span class="chat-question__answer-label">{{ questionLabel(question, position) }}</span>
            <span class="chat-question__answer-value">
              {{ (view.answers[position] ?? []).join(", ") || "No answer" }}
            </span>
          </div>
        </div>
        <p v-else class="prompt-dock__copy">{{ view.stateLabel || "Answered" }}</p>
      </template>

      <p v-else class="prompt-dock__copy">
        {{
          view.stateLabel ||
          (view.state === "dismissed" ? "Dismissed" : "Request no longer pending")
        }}
      </p>

      <div v-if="confirm === 'dismiss'" class="prompt-confirm">
        <p class="prompt-confirm__text">Dismiss this question?</p>
        <div class="cluster">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            data-question-cancel-dismiss
            @click="confirm = null"
          >
            Cancel
          </button>
          <button
            class="btn btn-danger btn-sm"
            type="button"
            data-question-confirm-dismiss
            @click="reject"
          >
            Dismiss
          </button>
        </div>
      </div>
      <div v-else-if="confirm === 'empty'" class="prompt-confirm">
        <p class="prompt-confirm__text">Some questions have no answer. Send anyway?</p>
        <div class="cluster">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            data-question-cancel-empty
            @click="confirm = null"
          >
            Review answers
          </button>
          <button
            class="btn btn-primary btn-sm"
            type="button"
            data-question-confirm-empty
            @click="submit"
          >
            Send without answering
          </button>
        </div>
      </div>

      <p v-if="view.error !== undefined" class="field-error prompt-dock__error" role="alert">
        {{ view.error }}
      </p>
    </div>

    <div
      v-if="interactive && confirm !== 'dismiss' && confirm !== 'empty'"
      class="prompt-dock__foot"
    >
      <div class="cluster">
        <button class="btn btn-ghost btn-sm" type="button" data-question-reject @click="reject">
          Dismiss
        </button>
      </div>
      <div class="cluster">
        <button
          v-if="needsReview && index > 0"
          class="btn btn-ghost btn-sm"
          type="button"
          data-question-back
          @click="advance(-1)"
        >
          Back
        </button>
        <button
          v-if="needsReview && !atReview"
          class="btn btn-ghost btn-sm"
          type="button"
          data-question-next
          @click="advance(1)"
        >
          {{ index === questions.length - 1 ? "Review" : "Next" }}
        </button>
        <button
          class="btn btn-primary btn-sm"
          type="button"
          data-question-primary
          :disabled="view.busy || disabled"
          :aria-busy="view.busy"
          @click="submit"
        >
          {{
            view.busy ? "Sending answer…" : view.error !== undefined ? "Try again" : "Send answer"
          }}
        </button>
      </div>
    </div>
    <div v-else-if="!view.readOnly && view.state === 'tooLarge'" class="prompt-dock__foot">
      <button class="btn btn-danger btn-sm" type="button" data-question-reject @click="reject">
        Dismiss
      </button>
    </div>
  </article>
</template>
