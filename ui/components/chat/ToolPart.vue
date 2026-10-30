<script setup lang="ts">
/**
 * Tool card. `extractToolView` selects a structured read/write/diff view; everything else stays a
 * text-only summary/output body. Running output is coalesced to 100 ms so a fast stream cannot
 * rebuild the DOM per token.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  isHanseTool,
  parseToolJsonOutput,
  toolDisplayName,
  toolFailure,
  toolStatusChip,
  toolSummaryText,
} from "../../../assets/chat-core.js";
import {
  allocateView,
  extractToolView,
  type ToolView,
  truncationNotice,
} from "../../../assets/chat-diff.js";
import type { ChatMessagePartView } from "../../chat/types.js";
import AppIcon from "../AppIcon.vue";
import DiffView from "./DiffView.vue";
import ReadView from "./ReadView.vue";
import WriteView from "./WriteView.vue";

const TOOL_OUTPUT_THROTTLE_MS = 100;

const props = defineProps<{ part: ChatMessagePartView }>();

const open = ref(false);
const outputEl = ref<HTMLElement | null>(null);
let throttleTimer: ReturnType<typeof setTimeout> | undefined;
let lastOutputAt = 0;
let hasRenderedOutput = false;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const data = computed(() => props.part.data ?? {});
const state = computed(() => record(data.value.state));
const input = computed(() => record(state.value.input));
const metadata = computed(() => record(state.value.metadata));
const tool = computed(() =>
  typeof data.value.tool === "string" && data.value.tool.length > 0
    ? data.value.tool
    : typeof data.value.type === "string"
      ? data.value.type
      : "tool",
);
const displayName = computed(() => toolDisplayName(tool.value));
const status = computed(() => {
  if (props.part.status.length > 0) {
    return props.part.status;
  }
  if (typeof state.value.status === "string") {
    return state.value.status;
  }
  return typeof data.value.status === "string" ? data.value.status : "completed";
});
const running = computed(() => status.value === "running" || status.value === "pending");
const output = computed(() => {
  if (running.value) {
    if (typeof metadata.value.output === "string" && metadata.value.output.length > 0) {
      return metadata.value.output;
    }
    if (tool.value === "bash") {
      return "Waiting for output…";
    }
  }
  if (
    status.value === "error" &&
    typeof state.value.error === "string" &&
    state.value.error.length > 0
  ) {
    return state.value.error;
  }
  for (const value of [
    state.value.output,
    metadata.value.output,
    data.value.output,
    data.value.text,
  ]) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  if (typeof state.value.error === "string" && state.value.error.length > 0) {
    return state.value.error;
  }
  return "No output";
});
const shownOutput = ref(output.value);
const parsed = computed(() =>
  running.value
    ? null
    : (parseToolJsonOutput(output.value) as Record<string, unknown> | unknown[] | null),
);
const failure = computed(() => (parsed.value === null ? null : toolFailure(parsed.value)));
const preview = computed(() => {
  const summary = toolSummaryText(tool.value, input.value, parsed.value);
  if (summary !== null && summary.length > 0) {
    return summary;
  }
  const stringOf = (key: string): string =>
    typeof input.value[key] === "string" ? (input.value[key] as string) : "";
  const pathLike =
    stringOf("filePath") || stringOf("path") || stringOf("url") || stringOf("pattern");
  switch (tool.value) {
    case "bash":
      return stringOf("command") || stringOf("title");
    case "grep": {
      const pattern = stringOf("pattern");
      const target = stringOf("path") || stringOf("filePath");
      return pattern.length > 0 && target.length > 0 ? `${pattern} in ${target}` : pattern;
    }
    case "glob":
      return stringOf("pattern");
    case "webfetch":
      return stringOf("url");
    case "websearch":
      return stringOf("query");
    case "task":
      return stringOf("description") || stringOf("agent") || stringOf("subagent");
    default:
      return (
        pathLike || (typeof data.value.title === "string" ? data.value.title : displayName.value)
      );
  }
});
const chip = computed(() => toolStatusChip(status.value));
const view = computed<ToolView | null>(() => extractToolView(data.value, tool.value, status.value));
const allocated = computed<ToolView | null>(() =>
  view.value === null ? null : allocateView(view.value),
);
const viewKind = computed(() => (allocated.value === null ? "" : String(allocated.value.kind)));
const hasView = computed(
  () =>
    allocated.value !== null &&
    (viewKind.value === "diff" ||
      viewKind.value === "files" ||
      viewKind.value === "read" ||
      viewKind.value === "write"),
);
const todos = computed(() => {
  const list = input.value.todos;
  return Array.isArray(list) ? list : [];
});
const notice = computed(() =>
  truncationNotice(
    {
      ...data.value,
      truncation: props.part.truncation,
      omitted: props.part.omitted,
      partial: props.part.partial,
    },
    status.value,
    allocated.value,
  ),
);
const structuredEntries = computed(() => {
  if (parsed.value === null || Array.isArray(parsed.value) || failure.value !== null) {
    return [];
  }
  return Object.entries(parsed.value).filter(([, value]) => {
    return (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    );
  });
});
const structuredJson = computed(() => {
  if (parsed.value === null || Array.isArray(parsed.value) || failure.value !== null) {
    return "";
  }
  try {
    return JSON.stringify(parsed.value, null, 2);
  } catch {
    return "";
  }
});
const bodyKind = computed(() => {
  if (props.part.omitted) return "none";
  if (hasView.value) return "view";
  if (tool.value === "todowrite") return "todo";
  if (tool.value === "bash") return "bash";
  if (
    status.value !== "running" &&
    status.value !== "pending" &&
    (isHanseTool(tool.value) || parsed.value !== null)
  ) {
    return "structured";
  }
  return "pre";
});

function hash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x01000193);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

const viewKey = computed(() => {
  if (!hasView.value || allocated.value === null) {
    return "";
  }
  const descriptor = (allocated.value.files ?? []).map((file) => {
    const patch = typeof file.patch === "string" ? file.patch.length : 0;
    const content = typeof file.content === "string" ? file.content.length : 0;
    return `${file.path ?? ""}:${file.newPath ?? ""}:${file.type ?? ""}:${patch}:${content}`;
  });
  return `${props.part.id}:${viewKind.value}:${hash(descriptor.join("|"))}`;
});

function applyOutput(value: string): void {
  if (throttleTimer !== undefined) {
    clearTimeout(throttleTimer);
    throttleTimer = undefined;
  }
  const element = outputEl.value;
  shownOutput.value = value;
  lastOutputAt = Date.now();
  hasRenderedOutput = true;
  if (element === null) {
    return;
  }
  const follow = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  void nextTick().then(() => {
    if (follow && outputEl.value !== null) {
      outputEl.value.scrollTop = outputEl.value.scrollHeight;
    }
  });
}

watch(
  output,
  (value) => {
    if (!running.value || !hasRenderedOutput) {
      applyOutput(value);
      return;
    }
    const elapsed = Date.now() - lastOutputAt;
    if (elapsed >= TOOL_OUTPUT_THROTTLE_MS) {
      applyOutput(value);
      return;
    }
    if (throttleTimer !== undefined) {
      return;
    }
    throttleTimer = setTimeout(() => {
      throttleTimer = undefined;
      applyOutput(output.value);
    }, TOOL_OUTPUT_THROTTLE_MS - elapsed);
  },
  { immediate: true },
);

watch(
  status,
  (value, previous) => {
    if (value === "error" && previous !== "error") {
      open.value = true;
    }
  },
  { immediate: true },
);

function onToggle(event: Event): void {
  const details = event.target as HTMLDetailsElement | null;
  open.value = details?.open === true;
}

function todoStatus(statusValue: unknown): { icon: string; label: string } {
  switch (statusValue) {
    case "completed":
      return { icon: "check", label: "Done" };
    case "in_progress":
      return { icon: "activity", label: "Now" };
    case "cancelled":
      return { icon: "slash", label: "Dropped" };
    default:
      return { icon: "clock", label: "Pending" };
  }
}

onBeforeUnmount(() => {
  if (throttleTimer !== undefined) {
    clearTimeout(throttleTimer);
    throttleTimer = undefined;
  }
});
</script>

<template>
  <details
    class="tool-call"
    :data-part-id="part.id"
    :data-tool="tool"
    data-part-type="tool"
    :open="open"
    @toggle="onToggle"
  >
    <summary>
      <AppIcon name="terminal" />
      <span class="mono" data-tool-name>{{ displayName }}</span>
      <span v-if="preview.length > 0" class="tool-call__path" :title="preview">{{ preview }}</span>
      <span v-if="failure !== null" class="badge tool-call__result" data-tone="error"
        >returned error</span
      >
      <span class="status" :data-state="chip.state">
        <AppIcon :name="chip.icon" />{{ chip.label }}
      </span>
    </summary>

    <DiffView
      v-if="bodyKind === 'view' && viewKind === 'diff'"
      :view="allocated as ToolView"
      :part-id="part.id"
      :view-key="viewKey"
      :open="open"
    />
    <DiffView
      v-else-if="bodyKind === 'view' && viewKind === 'files'"
      :view="allocated as ToolView"
      :part-id="part.id"
      :view-key="viewKey"
      :open="open"
    />
    <ReadView
      v-else-if="bodyKind === 'view' && viewKind === 'read'"
      :view="allocated as ToolView"
      :part-id="part.id"
      :view-key="viewKey"
      :open="open"
    />
    <WriteView
      v-else-if="bodyKind === 'view' && viewKind === 'write'"
      :view="allocated as ToolView"
      :part-id="part.id"
      :view-key="viewKey"
      :open="open"
    />
    <ul v-else-if="bodyKind === 'todo'" class="tool-todo" data-tool-todos>
      <li
        v-for="(todo, index) in todos"
        :key="index"
        class="tool-todo__item"
        :data-status="record(todo).status ?? 'unknown'"
      >
        <span class="tool-todo__status">
          <AppIcon :name="todoStatus(record(todo).status).icon" />
          {{ todoStatus(record(todo).status).label }}
        </span>
        <span class="tool-todo__content">{{
          typeof record(todo).content === "string" ? record(todo).content : ""
        }}</span>
      </li>
    </ul>
    <pre
      v-else-if="bodyKind === 'bash'"
      ref="outputEl"
      class="tool-call__output"
      data-tool-output
    >{{ shownOutput }}</pre>
    <div v-else-if="bodyKind === 'structured'" class="tool-call__structured">
      <div v-if="failure !== null" class="tool-error" data-tool-error>
        <span class="tool-error__code mono">{{ failure.code || "error" }}</span>
        <p v-if="failure.message.length > 0" class="tool-error__message">{{ failure.message }}</p>
      </div>
      <template v-else>
        <dl v-if="structuredEntries.length > 0" class="tool-kv">
          <template v-for="[ label, value ] in structuredEntries" :key="label">
            <dt>{{ label }}</dt>
            <dd class="mono">{{ value === null ? "" : String(value) }}</dd>
          </template>
        </dl>
        <pre
          v-if="structuredJson.length > 0"
          class="tool-code tool-code--json"
        >{{ structuredJson }}</pre>
      </template>
    </div>
    <pre
      v-else-if="bodyKind === 'pre'"
      ref="outputEl"
      class="tool-call__output"
      data-tool-output
    >{{ shownOutput }}</pre>
    <p v-if="notice.length > 0" class="tool-call__truncated" data-tool-truncated>{{ notice }}</p>
  </details>
</template>
