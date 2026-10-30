<script setup lang="ts">
import { computed, ref } from "vue";
import { collectSubtreeIds, type SessionTree } from "../../../assets/chat-core.js";
import { type ChatSessionSummary, chatSessionLabel } from "../../stores/chat-session.js";
import AppIcon from "../AppIcon.vue";
import ChatSessionNode from "./ChatSessionNode.vue";

const props = defineProps<{
  sessions: readonly ChatSessionSummary[];
  tree: SessionTree | null;
  activeSession: string | null;
  expanded: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
  stopped: boolean;
  deleting: ReadonlySet<string>;
  waitingCounts: ReadonlyMap<string, number>;
}>();

const emit = defineEmits<{
  select: [sessionID: string];
  toggle: [sessionID: string];
  delete: [sessionID: string];
  new: [];
  close: [];
}>();

const search = ref("");
const needle = computed(() => search.value.trim().toLowerCase());
const empty = computed(() => !props.loading && props.error === null && props.sessions.length === 0);

function label(session: ChatSessionSummary): string {
  return chatSessionLabel(session);
}

const visible = computed<ReadonlySet<string>>(() => {
  const tree = props.tree;
  if (tree === null) {
    return new Set<string>();
  }
  const query = needle.value;
  if (query.length === 0) {
    return new Set(tree.nodes.keys());
  }
  const result = new Set<string>();
  for (const [id, session] of tree.nodes) {
    const matches =
      label(session as ChatSessionSummary)
        .toLowerCase()
        .includes(query) || id.toLowerCase().includes(query);
    if (!matches) {
      continue;
    }
    result.add(id);
    for (const ancestor of ancestorIDs(tree, id)) {
      result.add(ancestor);
    }
  }
  return result;
});

function ancestorIDs(tree: SessionTree, id: string): string[] {
  const nodes = tree.nodes;
  const out: string[] = [];
  const seen = new Set([id]);
  let current = id;
  while (true) {
    const record = nodes.get(current);
    const raw = record === undefined ? undefined : (record as { parentID?: unknown }).parentID;
    const parentID = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    if (parentID === undefined || !nodes.has(parentID) || seen.has(parentID)) {
      break;
    }
    out.push(parentID);
    seen.add(parentID);
    current = parentID;
  }
  return out.reverse();
}

const noMatches = computed(
  () => !props.loading && !empty.value && needle.value.length > 0 && visible.value.size === 0,
);

const waitingTotals = computed<ReadonlyMap<string, number>>(() => {
  const tree = props.tree;
  const totals = new Map<string, number>();
  if (tree === null) {
    return totals;
  }
  for (const id of tree.nodes.keys()) {
    let total = 0;
    for (const member of collectSubtreeIds(tree, id)) {
      if (member === props.activeSession) {
        continue;
      }
      total += props.waitingCounts.get(member) ?? 0;
    }
    if (total > 0) {
      totals.set(id, total);
    }
  }
  return totals;
});

function requestDelete(sessionID: string): void {
  const tree = props.tree;
  const session = tree?.nodes.get(sessionID) as ChatSessionSummary | undefined;
  const subtree = tree === null ? [sessionID] : collectSubtreeIds(tree, sessionID);
  const labelText = session === undefined ? `Session ${sessionID.slice(0, 8)}` : label(session);
  const descendants = Math.max(subtree.length - 1, 0);
  const prompt =
    descendants > 0
      ? `Delete session "${labelText}" and ${descendants} subagent session(s)? This cannot be undone.`
      : `Delete session "${labelText}"? This cannot be undone.`;
  const confirmFn = typeof window === "undefined" ? undefined : window.confirm;
  if (typeof confirmFn !== "function" || !confirmFn(prompt)) {
    return;
  }
  emit("delete", sessionID);
}
</script>

<template>
  <aside class="chat-sessions" aria-label="Sessions" data-chat-sessions-rail>
    <div class="chat-pane-head">
      <p class="overline">Sessions</p>
      <div class="cluster">
        <button
          class="btn btn-ghost btn-icon btn-sm"
          type="button"
          data-chat-new-session
          aria-label="New session"
          title="New session"
          :disabled="stopped"
          @click="emit('new')"
        >
          <AppIcon name="plus" />
        </button>
        <button
          class="btn btn-ghost btn-icon btn-sm chat-sessions-close"
          type="button"
          aria-label="Close sessions"
          @click="emit('close')"
        >
          <AppIcon name="x" />
        </button>
      </div>
    </div>
    <div class="chat-sessions__tools">
      <label class="sr-only" for="session-search">Search sessions</label>
      <input
        id="session-search"
        v-model="search"
        class="input"
        type="search"
        placeholder="Filter sessions"
        autocomplete="off"
        data-chat-session-search
      >
    </div>
    <div class="chat-sessions__list">
      <div v-if="loading" class="skeleton-stack chat-sessions__skeleton" role="status">
        <span class="skeleton skeleton--line"></span>
        <span class="skeleton skeleton--line"></span>
      </div>
      <p v-else-if="error !== null" class="form-error chat-sessions__error" role="alert">
        {{ error }}
      </p>
      <p v-else-if="empty" class="chat-empty">
        {{ stopped ? "Sessions load when the agent starts." : "No sessions yet." }}
      </p>
      <p v-else-if="noMatches" class="chat-empty">No sessions match this filter.</p>
      <template v-else-if="tree !== null">
        <ChatSessionNode
          v-for="rootID in tree.roots.filter((id) => visible.has(id))"
          :key="rootID"
          :tree="tree"
          :node-id="rootID"
          :depth="0"
          :visible="visible"
          :expanded="expanded"
          :forced-open="needle.length > 0"
          :active-session="activeSession"
          :deleting="deleting"
          :waiting-totals="waitingTotals"
          @select="emit('select', $event)"
          @toggle="emit('toggle', $event)"
          @delete="requestDelete"
        />
      </template>
    </div>
  </aside>
</template>
