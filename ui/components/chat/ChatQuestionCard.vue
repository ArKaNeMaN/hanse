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
const body = ref<HTMLElement | null>(null);
const selected = ref<string[][]>([]);
const custom = ref<string[]>([]);
const customSelected = ref<boolean[]>([]);
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
const showSteps = computed(() => props.view.state === "pending");
const panelLabelledBy = computed(() => {
  if (!showSteps.value || questions.value.length <= 1) return undefined;
  return index.value < questions.value.length
    ? `question-tab-${props.view.key}-${index.value}`
    : `question-tab-${props.view.key}-review`;
});
const progressValue = computed(() =>
  atReview.value ? questions.value.length : Math.min(index.value + 1, questions.value.length),
);
const stepLabel = computed(() =>
  atReview.value ? "Review" : `${progressValue.value} of ${questions.value.length}`,
);
const progressPercent = computed(() =>
  questions.value.length === 0
    ? "0%"
    : `${Math.round((progressValue.value / questions.value.length) * 100)}%`,
);

function resetDraft(): void {
  selected.value = questions.value.map(() => []);
  custom.value = questions.value.map(() => "");
  customSelected.value = questions.value.map(() => false);
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
    const nextCustom = [...custom.value];
    nextCustom[questionIndex] = "";
    custom.value = nextCustom;
    deactivateCustom(questionIndex);
  }
  selected.value = next;
  if (!question.multiple && questions.value.length > 1) {
    index.value = Math.min(questions.value.length, questionIndex + 1);
  }
}

function activateCustom(questionIndex: number): void {
  const question = questions.value[questionIndex];
  if (!interactive.value || question === undefined || !question.custom) return;
  if (!question.multiple) {
    const nextSelected = selected.value.map((answers) => [...answers]);
    nextSelected[questionIndex] = [];
    selected.value = nextSelected;
  }
  const nextCustomSelected = [...customSelected.value];
  nextCustomSelected[questionIndex] = true;
  customSelected.value = nextCustomSelected;
}

function deactivateCustom(questionIndex: number): void {
  const next = [...customSelected.value];
  next[questionIndex] = false;
  customSelected.value = next;
}

function updateCustom(value: string, questionIndex: number): void {
  const next = [...custom.value];
  next[questionIndex] = value;
  custom.value = next;
  if (value.trim().length === 0) deactivateCustom(questionIndex);
  else activateCustom(questionIndex);
}

function questionAnswered(position: number): boolean {
  if ((selected.value[position] ?? []).length > 0) return true;
  return (
    customSelected.value[position] === true && (custom.value[position] ?? "").trim().length > 0
  );
}

function questionTabLabel(question: NormalizedQuestion, position: number): string {
  return question.header.trim() || questionLabel(question, position);
}

function goTo(target: number): void {
  index.value = Math.min(questions.value.length, Math.max(0, target));
}

function onTabKeydown(event: KeyboardEvent, position: number): void {
  const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const total = questions.value.length + (needsReview.value ? 1 : 0);
  if (total === 0) return;
  event.preventDefault();
  let next = position;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = total - 1;
  else if (event.key === "ArrowRight") next = (position + 1) % total;
  else next = (position - 1 + total) % total;
  goTo(next);
  void nextTick().then(() => focusTab(next));
}

function focusTab(position: number): void {
  const node = root.value;
  if (node === null) return;
  const selector =
    position >= questions.value.length
      ? "[data-question-tab-review]"
      : `[data-question-tab="${position}"]`;
  node.querySelector<HTMLElement>(selector)?.focus();
}

function advance(delta: number): void {
  const max = questions.value.length;
  index.value = Math.min(max, Math.max(0, index.value + delta));
}

function onCustomEnter(event: KeyboardEvent): void {
  if (!interactive.value || event.isComposing || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  if (questions.value.length === 1) {
    submit();
    return;
  }
  advance(1);
}

// The dock body scrolls inside a capped height. Moving to a question with more content must keep
// the bottom edge (the custom-answer field) visible instead of leaving the scroll position behind.
// A new request resets the index; that is not a step change and must not jump the scroll.
watch(
  () => [props.view.key, index.value] as const,
  ([key], previous) => {
    if (previous !== undefined && previous[0] !== key) return;
    void nextTick().then(() => {
      const node = body.value;
      if (node !== null) node.scrollTop = node.scrollHeight;
    });
  },
);

function submit(): void {
  if (!interactive.value || props.view.busy) return;
  const answers = questions.value.map((_, position) => [
    ...answersForQuestion(
      selected.value[position] ?? [],
      custom.value[position] ?? "",
      customSelected.value[position] === true,
    ),
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
    "[data-question-option]:not(:disabled), [data-question-custom]:not(:disabled), [data-question-primary]:not(:disabled)",
  );
  target?.focus();
}

function onOptionKeydown(event: KeyboardEvent, questionIndex: number): void {
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const node = root.value;
  if (node === null) return;
  const options = Array.from(
    node.querySelectorAll<HTMLButtonElement>(
      `[data-question-field="${questionIndex}"] [data-question-option]:not(:disabled)`,
    ),
  );
  const at = options.indexOf(event.currentTarget as HTMLButtonElement);
  if (at < 0 || options.length === 0) return;
  event.preventDefault();
  let next = at;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  else if (event.key === "ArrowDown" || event.key === "ArrowRight")
    next = (at + 1) % options.length;
  else next = (at - 1 + options.length) % options.length;
  options[next]?.focus();
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
        <span
          v-if="view.state === 'answered' && questions.length > 1"
          class="prompt-dock__step-label"
        >
          {{ questions.length }}
          questions
        </span>
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
      <div v-if="showSteps && questions.length > 1" class="prompt-dock__progress">
        <span class="prompt-dock__step-label" data-question-step-label>{{ stepLabel }}</span>
        <div
          class="prompt-dock__progress-track"
          role="progressbar"
          aria-label="Question progress"
          aria-valuemin="0"
          :aria-valuemax="questions.length"
          :aria-valuenow="progressValue"
          :aria-valuetext="stepLabel"
        >
          <span class="prompt-dock__progress-fill" :style="{ inlineSize: progressPercent }"></span>
        </div>
      </div>
    </header>

    <div ref="body" class="prompt-dock__body">
      <div
        v-if="showSteps && questions.length > 1"
        class="prompt-dock__tabs"
        role="tablist"
        aria-label="Questions"
      >
        <button
          v-for="(question, position) in questions"
          :key="`tab-${position}`"
          class="prompt-dock__tab"
          type="button"
          role="tab"
          :id="`question-tab-${view.key}-${position}`"
          :aria-selected="index === position"
          :tabindex="index === position ? 0 : -1"
          :data-question-tab="position"
          :title="questionTabLabel(question, position)"
          @click="goTo(position)"
          @keydown="onTabKeydown($event, position)"
        >
          <span class="prompt-dock__tab-label">{{ questionTabLabel(question, position) }}</span>
          <AppIcon v-if="questionAnswered(position)" name="check" class="icon--sm" />
        </button>
        <button
          v-if="needsReview"
          class="prompt-dock__tab prompt-dock__tab--review"
          type="button"
          role="tab"
          :id="`question-tab-${view.key}-review`"
          :aria-selected="atReview"
          :tabindex="atReview ? 0 : -1"
          data-question-tab-review
          @click="goTo(questions.length)"
          @keydown="onTabKeydown($event, questions.length)"
        >
          Review
        </button>
      </div>
      <template v-if="view.state === 'pending' || view.state === 'tooLarge'">
        <p v-if="view.tooLarge" class="prompt-dock__title">This question is too large to answer.</p>
        <p v-if="view.tooLarge && view.tooLargeReason !== undefined" class="prompt-dock__copy">
          {{ view.tooLargeReason }}
        </p>
        <template v-else-if="questions.length > 0">
          <div class="chat-question__panel" role="tabpanel" :aria-labelledby="panelLabelledBy">
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
                      questionAnswered(position)
                        ? answersForQuestion(
                            selected[position] ?? [],
                            custom[position] ?? "",
                            customSelected[position] === true,
                          ).join(", ")
                        : "No answer"
                    }}
                  </span>
                </div>
              </div>
            </template>
            <template v-else-if="current !== undefined">
              <p class="prompt-dock__title">{{ questionLabel(current, index) }}</p>
              <div class="chat-question__answers">
                <div
                  class="chat-question__answers chat-question__answers--options"
                  :role="current.multiple ? 'group' : 'radiogroup'"
                  :aria-label="questionLabel(current, index)"
                  :data-question-field="index"
                >
                  <button
                    v-for="option in current.options"
                    :key="option.label"
                    class="chat-question__answer chat-question__answer--option"
                    :class="{
                      'is-selected': (selected[index] ?? []).includes(option.label),
                    }"
                    type="button"
                    :role="current.multiple ? 'checkbox' : 'radio'"
                    data-question-option
                    :data-label="option.label"
                    :data-selected="
                      (selected[index] ?? []).includes(option.label) ? 'true' : 'false'
                    "
                    :aria-checked="(selected[index] ?? []).includes(option.label)"
                    :disabled="view.busy || disabled"
                    @click="selectOption(index, option.label)"
                    @keydown="onOptionKeydown($event, index)"
                  >
                    <span class="chat-question__answer-marker" aria-hidden="true">
                      <AppIcon
                        :name="(selected[index] ?? []).includes(option.label) ? 'check' : 'circle'"
                      />
                    </span>
                    <span class="chat-question__answer-body">
                      <span class="chat-question__answer-text">{{ option.label }}</span>
                      <span v-if="option.description.length > 0" class="chat-question__answer-desc">
                        {{ option.description }}
                      </span>
                    </span>
                  </button>
                </div>
                <!-- biome-ignore lint/a11y/noLabelWithoutControl: the dynamic :for binds the row label to its custom-answer input -->
                <label
                  v-if="current.custom"
                  class="chat-question__answer chat-question__answer--custom"
                  :class="{ 'is-selected': customSelected[index] === true }"
                  :data-selected="customSelected[index] === true ? 'true' : 'false'"
                  :for="`question-custom-${view.key}-${index}`"
                >
                  <span class="chat-question__answer-marker" aria-hidden="true">
                    <AppIcon :name="customSelected[index] === true ? 'check' : 'circle'" />
                  </span>
                  <span class="chat-question__answer-body chat-question__answer-body--custom">
                    <input
                      :id="`question-custom-${view.key}-${index}`"
                      class="chat-question__custom-input"
                      type="text"
                      data-question-custom
                      placeholder="Type a custom answer"
                      :value="custom[index] ?? ''"
                      :disabled="view.busy || disabled"
                      @focus="activateCustom(index)"
                      @input="updateCustom(($event.target as HTMLInputElement).value, index)"
                      @keydown.enter="onCustomEnter"
                    >
                  </span>
                </label>
              </div>
            </template>
          </div>
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
          :disabled="view.busy"
          @click="advance(-1)"
        >
          Prev
        </button>
        <button
          v-if="needsReview && !atReview"
          class="btn btn-primary btn-sm"
          type="button"
          data-question-next
          :disabled="view.busy"
          @click="advance(1)"
        >
          {{ index === questions.length - 1 ? "Review" : "Next" }}
        </button>
        <button
          v-if="!needsReview || atReview"
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
