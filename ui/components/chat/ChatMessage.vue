<script setup lang="ts">
/** One chat feed message: OMO/handoff cards, text, reasoning, tools, details, and unknown parts. */
import { computed, ref } from "vue";
import {
  type AttachmentView,
  agentInitials,
  attachmentViewFromFilePart,
  isHiddenSyntheticTextPart,
} from "../../../assets/chat-core.js";
import { isKnownPartType } from "../../chat/feed-store.js";
import type { ChatMessagePartView, ChatMessageView, InlineQuestionView } from "../../chat/types.js";
import ChatAttachmentCard from "./ChatAttachmentCard.vue";
import ChatQuestionCard from "./ChatQuestionCard.vue";
import HandoffCard from "./HandoffCard.vue";
import MarkdownBlock from "./MarkdownBlock.vue";
import OmoCard from "./OmoCard.vue";
import ReasoningPart from "./ReasoningPart.vue";
import ToolPart from "./ToolPart.vue";

const HIDDEN_PART_TYPES = new Set([
  "step-start",
  "step-finish",
  "retry",
  "compaction",
  "snapshot",
  "agent",
  "patch",
]);

const props = defineProps<{
  record: ChatMessageView;
  appKey?: string;
  questionViewForPart?: (part: ChatMessagePartView, messageID: string) => InlineQuestionView | null;
}>();

const emit = defineEmits<{
  "question-submit": [view: InlineQuestionView, answers: string[][]];
  "question-reject": [view: InlineQuestionView];
  "open-image": [attachment: AttachmentView];
}>();

function questionView(part: ChatMessagePartView): InlineQuestionView | null {
  return props.questionViewForPart === undefined
    ? null
    : props.questionViewForPart(part, props.record.id);
}

function fileAttachment(part: ChatMessagePartView): AttachmentView | null {
  return part.type === "file" ? attachmentViewFromFilePart(part) : null;
}

const stripAttachments = computed<readonly AttachmentView[]>(() => {
  const attachments = props.record.attachments ?? [];
  if (attachments.length === 0) return [];
  const inlineIDs = new Set<string>();
  for (const part of props.record.parts) {
    if (part.type !== "file") continue;
    const attachment = attachmentViewFromFilePart(part);
    if (attachment !== null) inlineIDs.add(attachment.id);
  }
  const seen = new Set<string>();
  const out: AttachmentView[] = [];
  for (const attachment of attachments) {
    if (attachment.inline && inlineIDs.has(attachment.id)) continue;
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    out.push(attachment);
  }
  return out;
});

const showParts = computed(
  () => props.record.omo === null && (props.record.handoff ?? null) === null,
);
const roleLabel = computed(() =>
  props.record.role === "user" ? "operator" : (props.appKey ?? "").trim() || "agent",
);
const avatarText = computed(() => agentInitials(roleLabel.value));
const timeLabel = computed(() => {
  const value = props.record.time?.created;
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
});

function dataOf(part: ChatMessagePartView): Record<string, unknown> {
  return part.data ?? {};
}

function stringField(part: ChatMessagePartView, key: string): string {
  const value = dataOf(part)[key];
  return typeof value === "string" ? value : "";
}

function detailsLabel(part: ChatMessagePartView): string {
  if (part.type === "reasoning") return "Thinking";
  return part.type;
}

function detailsPreview(part: ChatMessagePartView): string {
  const data = dataOf(part);
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return "";
  };
  if (part.type === "file") return first("filename", "path", "name", "title");
  if (part.type === "subtask") return first("description", "agent", "title", "prompt");
  return "";
}

function detailsBody(part: ChatMessagePartView): string {
  const data = dataOf(part);
  if (part.type === "reasoning") return stringField(part, "text") || "Reasoning";
  if (part.type === "file" && fileAttachment(part) === null) {
    return data.truncated === true ? "Inline content is not available." : "No preview";
  }
  for (const key of ["output", "error", "text", "content", "patch"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return part.text.length > 0 ? part.text : "No output";
}

function isHidden(part: ChatMessagePartView): boolean {
  return (
    HIDDEN_PART_TYPES.has(part.type) ||
    (isKnownPartType(part.type) &&
      part.type !== "text" &&
      part.type !== "reasoning" &&
      part.type !== "tool" &&
      part.type !== "file" &&
      part.type !== "subtask")
  );
}

function isUnknown(part: ChatMessagePartView): boolean {
  return !isKnownPartType(part.type) && !HIDDEN_PART_TYPES.has(part.type);
}

defineExpose({ detailsBody, isDetailOpen });

const openDetails = ref<ReadonlySet<string>>(new Set<string>());

function isDetailOpen(id: string): boolean {
  return openDetails.value.has(id);
}

function onDetailToggle(id: string, event: Event): void {
  const details = event.target as HTMLDetailsElement | null;
  const next = new Set(openDetails.value);
  if (details?.open === true) {
    next.add(id);
  } else {
    next.delete(id);
  }
  openDetails.value = next;
}

const optimisticLabel = computed(() => {
  switch (props.record.optimistic) {
    case "sending":
      return "Sending…";
    case "queued":
      return "Queued";
    case "unknown":
      return "Delivery unknown; checking…";
    case "failed":
      return "Failed";
    default:
      return "";
  }
});
</script>

<template>
  <article
    class="message chat-message"
    :class="[
      `chat-message--${record.role}`,
      record.handoff != null ? 'message--handoff' : '',
      record.omo != null ? 'message--system' : '',
      record.role === 'user' && record.handoff == null && record.omo == null ? 'message--user' : '',
      record.optimistic != null ? 'message--optimistic' : '',
    ]"
    :data-message-id="record.id"
    :data-role="record.role"
    :data-optimistic="record.optimistic ?? undefined"
    :data-state="record.optimistic ?? undefined"
  >
    <OmoCard v-if="record.omo !== null" :omo="record.omo" />
    <HandoffCard v-else-if="record.handoff != null" :handoff="record.handoff" />

    <div v-if="showParts" class="message__meta" data-message-meta>
      <span class="avatar avatar--sm" aria-hidden="true">{{ avatarText }}</span>
      <span class="message__role" data-message-role>{{ roleLabel }}</span>
      <span v-if="timeLabel.length > 0" class="message__time" data-message-time>{{
        timeLabel
      }}</span>
    </div>

    <template v-if="showParts">
      <template v-for="part in record.parts" :key="part.id">
        <MarkdownBlock
          v-if="part.type === 'text' && part.text.length > 0 && !isHiddenSyntheticTextPart(part)"
          :text="part.text"
          :sealed="part.sealed"
          class="message__body chat-text"
          :data-part-id="part.id"
          data-part-type="text"
        />
        <ReasoningPart v-else-if="part.type === 'reasoning'" :part="part" />
        <ChatQuestionCard
          v-else-if="questionView(part) !== null"
          :view="questionView(part) as InlineQuestionView"
          inline
          @submit="
            (answers) => emit('question-submit', questionView(part) as InlineQuestionView, answers)
          "
          @reject="emit('question-reject', questionView(part) as InlineQuestionView)"
        />
        <ToolPart v-else-if="part.type === 'tool'" :part="part" />
        <ChatAttachmentCard
          v-else-if="fileAttachment(part) !== null"
          :attachment="fileAttachment(part) as AttachmentView"
          @open="(attachment) => emit('open-image', attachment)"
        />
        <details
          v-else-if="part.type === 'file' || part.type === 'subtask'"
          class="tool-call chat-detail"
          :data-part-id="part.id"
          :data-part-type="part.type"
          @toggle="onDetailToggle(part.id, $event)"
        >
          <summary>
            <span class="mono">{{ detailsLabel(part) }}</span>
            <span v-if="detailsPreview(part).length > 0" class="tool-call__path">
              {{ detailsPreview(part) }}
            </span>
          </summary>
          <pre class="chat-detail__text">{{ detailsBody(part) }}</pre>
        </details>
        <p
          v-else-if="isUnknown(part)"
          class="chat-part chat-part--unsupported"
          :data-part-id="part.id"
          :data-part-type="part.type"
        >
          Unsupported content: {{ part.type }}
        </p>
        <span
          v-else-if="isHidden(part)"
          hidden
          :data-part-id="part.id"
          :data-part-type="part.type"
        />
      </template>
    </template>

    <div v-if="stripAttachments.length > 0" class="message__attachments" data-message-attachments>
      <ChatAttachmentCard
        v-for="attachment in stripAttachments"
        :key="attachment.id"
        :attachment="attachment"
        @open="(entry) => emit('open-image', entry)"
      />
    </div>

    <div v-if="optimisticLabel.length > 0" class="message__state" aria-hidden="true">
      {{ optimisticLabel }}
    </div>
    <p v-if="record.optimistic === 'failed'" class="form-error chat-message__error" role="alert">
      This message was not delivered.
    </p>
  </article>
</template>
