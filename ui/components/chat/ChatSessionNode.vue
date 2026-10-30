<script setup lang="ts">
import { computed } from "vue";
import type { SessionTree } from "../../../assets/chat-core.js";
import { type ChatSessionSummary, chatSessionLabel } from "../../stores/chat-session.js";
import AppIcon from "../AppIcon.vue";

defineOptions({ name: "ChatSessionNode" });

const props = defineProps<{
  tree: SessionTree;
  nodeId: string;
  depth: number;
  visible: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  forcedOpen: boolean;
  activeSession: string | null;
  deleting: ReadonlySet<string>;
  waitingTotals: ReadonlyMap<string, number>;
}>();

const emit = defineEmits<{
  select: [sessionID: string];
  toggle: [sessionID: string];
  delete: [sessionID: string];
}>();

const session = computed<ChatSessionSummary | undefined>(() => {
  const value = props.tree.nodes.get(props.nodeId);
  return value === undefined ? undefined : (value as ChatSessionSummary);
});
const label = computed(() => chatSessionLabel(session.value));
const active = computed(() => props.nodeId === props.activeSession);
const children = computed(() =>
  (props.tree.childrenByParent.get(props.nodeId) ?? []).filter(
    (id) => props.visible.has(id) && props.tree.nodes.has(id),
  ),
);
const hasChildren = computed(() => children.value.length > 0);
const isExpanded = computed(
  () => hasChildren.value && (props.forcedOpen || props.expanded.has(props.nodeId)),
);
const childrenID = computed(() => `session-children-${props.nodeId}`);
const waiting = computed(() => props.waitingTotals.get(props.nodeId) ?? 0);
const isDeleting = computed(() => props.deleting.has(props.nodeId));
const depth = computed(() => Math.min(props.depth, 5));
</script>

<template>
  <div
    class="session-node"
    :data-session-id="nodeId"
    :data-depth="depth"
    :style="{ '--session-depth': String(depth) }"
  >
    <div class="session-row">
      <button
        v-if="hasChildren"
        class="session-chevron"
        type="button"
        :aria-label="`Subagent sessions for ${label}`"
        :aria-expanded="isExpanded ? 'true' : 'false'"
        :aria-controls="childrenID"
        :aria-disabled="forcedOpen ? 'true' : undefined"
        @click="emit('toggle', nodeId)"
      >
        <AppIcon :name="isExpanded ? 'chevron-down' : 'chevron-right'" class-name="icon--sm" />
      </button>
      <span v-else class="session-chevron__spacer" aria-hidden="true"></span>
      <button
        class="session-item"
        type="button"
        :class="{ 'is-active': active }"
        :aria-current="active ? 'true' : undefined"
        :data-session-id="nodeId"
        :title="label"
        @click="emit('select', nodeId)"
      >
        <span class="session-item__top">
          <span class="session-item__title">{{ label }}</span>
          <AppIcon v-if="active" name="check" class-name="icon--sm" />
        </span>
        <span class="session-item__meta">
          <span class="mono">{{ nodeId.slice(0, 8) }}</span>
          <span
            v-if="waiting > 0"
            class="session-item__flag"
            :aria-label="`${waiting} requests need input`"
            >{{ waiting }}
            waiting</span
          >
        </span>
      </button>
      <button
        class="session-delete"
        type="button"
        :data-session-delete="nodeId"
        :title="`Delete ${label}`"
        :aria-label="`Delete ${label}`"
        :disabled="isDeleting"
        @click="emit('delete', nodeId)"
      >
        <AppIcon name="trash" class-name="icon--sm" />
      </button>
    </div>
    <fieldset
      v-if="hasChildren"
      :id="childrenID"
      class="session-children"
      :aria-label="`Subagent sessions of ${label}`"
      :hidden="!isExpanded"
    >
      <ChatSessionNode
        v-for="childID in children"
        :key="childID"
        :tree="tree"
        :node-id="childID"
        :depth="depth + 1"
        :visible="visible"
        :expanded="expanded"
        :forced-open="forcedOpen"
        :active-session="activeSession"
        :deleting="deleting"
        :waiting-totals="waitingTotals"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
        @delete="emit('delete', $event)"
      />
    </fieldset>
  </div>
</template>
