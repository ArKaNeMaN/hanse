<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { FeedPartRecord as PartRecord } from "../../assets/chat-feed-store.js";
import type { RuntimeState } from "../../src/http/ui.js";
import type { ContextSnapshot } from "../../src/opencode/context.js";
import type { NormalizedTodo } from "../../src/opencode/prompts.js";
import { ApiError, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import type { InboundChatEvent } from "../chat/event-reducer.js";
import { reduceEvent } from "../chat/event-reducer.js";
import { applyChatActions, type RenderIntent } from "../chat/state-actions.js";
import type {
  ChatCommandsResponse,
  ChatMessagePartView,
  ChatMessagesResponse,
  ChatMessageView,
  ChatNoticesResponse,
  ChatResponse,
  ChatRuntimeResponse,
  ChatSessionsResponse,
  ChatThreadItem,
} from "../chat/types.js";
import { useChatRouteState } from "../chat/useChatRouteState.js";
import AppIcon from "../components/AppIcon.vue";
import ChatComposer from "../components/chat/ChatComposer.vue";
import ChatScrim from "../components/chat/ChatScrim.vue";
import ChatSessionsRail from "../components/chat/ChatSessionsRail.vue";
import ChatThread from "../components/chat/ChatThread.vue";
import { useChatStream } from "../composables/useChatStream.js";
import { applyChrome } from "../composables/useChrome.js";
import { useWorkspaceShell } from "../composables/useWorkspaceShell.js";
import { useChatContextStore } from "../stores/chat-context.js";
import { useChatFeedStore } from "../stores/chat-feed.js";
import { useChatSessionStore } from "../stores/chat-session.js";
import { useChatUiStore } from "../stores/chat-ui.js";
import { useToastStore } from "../stores/toasts.js";

const props = defineProps<{ boot: BootPayload }>();
const route = useRoute();
const router = useRouter();
const routeState = useChatRouteState(router, route);
useWorkspaceShell(
  "page--chat",
  "width=device-width, initial-scale=1, interactive-widget=resizes-content",
);

const feed = useChatFeedStore();
const sessionStore = useChatSessionStore();
const contextStore = useChatContextStore();
const chatUi = useChatUiStore();
const toasts = useToastStore();

function encoded(value: string): string {
  return encodeURIComponent(value);
}

const bootProps = computed<ChatResponse | undefined>(() => {
  if (props.boot.route.id !== "chat") {
    return undefined;
  }
  const value = props.boot.props;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as ChatResponse;
  if (
    candidate.app?.projectId !== routeState.project.value ||
    candidate.app?.appKey !== routeState.app.value
  ) {
    return undefined;
  }
  return candidate;
});

const apiBase = computed(() => `/api/apps/${encoded(routeState.app.value)}`);
const projectQuery = computed(() =>
  routeState.project.value.length === 0 ? "" : `?project=${encoded(routeState.project.value)}`,
);
const withProject = (path: string): string => `${path}${projectQuery.value}`;

const chatPath = computed(() => {
  const params = new URLSearchParams({ app: routeState.app.value });
  if (routeState.project.value.length > 0) {
    params.set("project", routeState.project.value);
  }
  return `/api/ui/chat?${params.toString()}`;
});

const chatQuery = useQuery<ChatResponse>({
  queryKey: computed(() => ["chat", routeState.project.value, routeState.app.value]),
  queryFn: () => apiQuery<ChatResponse>(chatPath.value),
  initialData: () => bootProps.value,
  initialDataUpdatedAt: 0,
  staleTime: 30_000,
  retry: false,
  enabled: computed(() => routeState.app.value.length > 0),
});

const view = computed(() => chatQuery.data.value);

watch(
  () => view.value?.chrome,
  (chrome) => {
    if (chrome !== undefined) {
      applyChrome(chrome);
    }
  },
  { immediate: true },
);

watch(
  () => view.value?.topbar,
  (topbar) => {
    if (topbar !== undefined) {
      chatUi.activate(topbar);
    }
  },
  { immediate: true },
);

watch(
  () => view.value?.runtime.state,
  (state) => {
    contextStore.setRuntime(state === undefined ? null : state);
  },
  { immediate: true },
);

const sessionsQuery = useQuery<ChatSessionsResponse>({
  queryKey: computed(() => ["chat-sessions", routeState.project.value, routeState.app.value]),
  queryFn: () => apiQuery<ChatSessionsResponse>(withProject(`${apiBase.value}/sessions`)),
  staleTime: 15_000,
  retry: false,
  enabled: computed(() => routeState.app.value.length > 0),
});

function isStopped(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "agent_stopped" || error.status === 503);
}

const stopped = computed(
  () =>
    isStopped(sessionsQuery.error.value) ||
    view.value?.runtime.state === "stopped" ||
    view.value?.runtime.state === "error",
);

watch(
  () => sessionsQuery.data.value,
  (data) => {
    if (data === undefined) {
      return;
    }
    sessionStore.setSessions(data.sessions);
    routeState.canonicalize(data.sessions);
  },
);

const sessionsError = computed(() => {
  if (stopped.value || sessionsQuery.error.value === null) {
    return null;
  }
  return sessionsQuery.error.value instanceof Error
    ? sessionsQuery.error.value.message
    : "Could not load sessions.";
});

const appEmpty = computed(() => routeState.app.value.length === 0);
const viewError = computed(() => {
  const error = chatQuery.error.value;
  if (error === null) {
    return null;
  }
  if (error instanceof ApiError && error.status === 404) {
    return "This chat does not exist. The application may have been deleted or renamed.";
  }
  return error instanceof Error ? error.message : "Could not load this chat.";
});

const deletionPending = computed(
  () =>
    view.value?.deleting.pending === true ||
    (sessionsQuery.error.value instanceof ApiError &&
      sessionsQuery.error.value.code === "deletion_pending"),
);

const messages = ref<readonly unknown[]>([]);
const loadingMessages = ref(false);
const messagesError = ref<string | null>(null);
const loadingEarlier = ref(false);
const historyError = ref<string | null>(null);
const historyCursor = ref<string | null>(null);
const messageCount = ref(0);
const threadRef = ref<InstanceType<typeof ChatThread> | null>(null);
let loadGeneration = 0;
let messageAbort: AbortController | undefined;
let historyAbort: AbortController | undefined;
let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
let noticeSequence = 0;

function messagePath(sessionID: string, before?: string): string {
  const params = new URLSearchParams();
  if (routeState.project.value.length > 0) {
    params.set("project", routeState.project.value);
  }
  params.set("limit", "30");
  if (before !== undefined) {
    params.set("before", before);
  }
  return `${apiBase.value}/sessions/${encoded(sessionID)}/messages?${params.toString()}`;
}

function classifyUserMessages(): void {
  for (const id of feed.thread.order) {
    const record = feed.thread.messages.get(id);
    if (record?.role === "user") {
      feed.classifyUserMessage(id);
    }
  }
}

function abortLoads(): void {
  messageAbort?.abort();
  messageAbort = undefined;
  historyAbort?.abort();
  historyAbort = undefined;
}

async function loadSidecars(sessionID: string, generation: number): Promise<void> {
  const signal = messageAbort?.signal;
  const path = (suffix: string): string =>
    `${apiBase.value}/sessions/${encoded(sessionID)}/${suffix}${projectQuery.value}`;
  try {
    const notices = await apiQuery<ChatNoticesResponse>(
      `${path("notices")}${projectQuery.value.length === 0 ? "?" : "&"}limit=50`,
      { ...(signal === undefined ? {} : { signal }) },
    );
    if (generation !== loadGeneration || routeState.session.value !== sessionID) {
      return;
    }
    for (const notice of notices.notices) {
      feed.upsertNotice({ ...notice });
    }
  } catch {
    // Notices are best effort; the message feed and notices stream still drive the surface.
  }

  try {
    const snapshot = await apiQuery<ContextSnapshot>(path("context"), {
      ...(signal === undefined ? {} : { signal }),
    });
    if (generation === loadGeneration && routeState.session.value === sessionID) {
      contextStore.setSnapshot(sessionID, snapshot, true);
    }
  } catch {
    // Context is optional in the read-only shell.
  }

  try {
    const todos = await apiQuery<readonly NormalizedTodo[]>(path("todo"), {
      ...(signal === undefined ? {} : { signal }),
    });
    if (generation === loadGeneration && routeState.session.value === sessionID) {
      contextStore.setTodos(sessionID, todos, false, true);
    }
  } catch {
    // Todo/plan is optional in the read-only shell.
  }

  try {
    const runtime = await apiQuery<ChatRuntimeResponse>(withProject(`${apiBase.value}/runtime`), {
      ...(signal === undefined ? {} : { signal }),
    });
    if (generation === loadGeneration) {
      contextStore.setRuntime(runtime.state as RuntimeState);
    }
  } catch {
    // Runtime state also comes from the boot props and stream ready refresh.
  }

  try {
    await apiQuery<ChatCommandsResponse>(withProject(`${apiBase.value}/commands`), {
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    // Command metadata is not rendered in the read-only shell; the read keeps parity.
  }
}

async function loadMessages(sessionID: string, reset: boolean): Promise<void> {
  if (sessionID.length === 0) {
    return;
  }
  const generation = ++loadGeneration;
  abortLoads();
  const controller = new AbortController();
  messageAbort = controller;
  loadingMessages.value = true;
  messagesError.value = null;
  historyError.value = null;
  historyCursor.value = null;
  if (reset) {
    feed.reset(sessionID);
    messages.value = [];
    messageCount.value = 0;
  }
  try {
    const data = await apiQuery<ChatMessagesResponse>(messagePath(sessionID), {
      signal: controller.signal,
    });
    if (generation !== loadGeneration || routeState.session.value !== sessionID) {
      return;
    }
    feed.applySnapshot(data.messages, { position: reset ? "replace" : "tail", sessionID });
    historyCursor.value = data.nextCursor ?? null;
    messages.value = data.messages;
    messageCount.value = feed.thread.order.length;
    classifyUserMessages();
    await loadSidecars(sessionID, generation);
  } catch (error) {
    if (generation !== loadGeneration || routeState.session.value !== sessionID) {
      return;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    messagesError.value =
      error instanceof Error ? error.message : "Could not load this conversation.";
  } finally {
    if (generation === loadGeneration) {
      loadingMessages.value = false;
    }
  }
}

async function loadEarlier(): Promise<void> {
  const sessionID = routeState.session.value;
  const cursor = historyCursor.value;
  if (sessionID === null || cursor === null || loadingEarlier.value) {
    return;
  }
  const generation = loadGeneration;
  historyAbort?.abort();
  const controller = new AbortController();
  historyAbort = controller;
  loadingEarlier.value = true;
  historyError.value = null;
  const anchor = threadRef.value?.captureAnchor() ?? null;
  try {
    const data = await apiQuery<ChatMessagesResponse>(messagePath(sessionID, cursor), {
      signal: controller.signal,
    });
    if (generation !== loadGeneration || routeState.session.value !== sessionID) {
      return;
    }
    feed.applySnapshot(data.messages, { position: "older", sessionID });
    historyCursor.value = data.nextCursor ?? null;
    messageCount.value = feed.thread.order.length;
    classifyUserMessages();
    await nextTick();
    threadRef.value?.restoreAnchor(anchor);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    historyError.value =
      error instanceof ApiError && error.status === 400
        ? "Could not load earlier messages; refresh this conversation."
        : error instanceof Error
          ? error.message
          : "Could not load earlier messages.";
  } finally {
    if (generation === loadGeneration) {
      loadingEarlier.value = false;
    }
  }
}

function scheduleReconcile(reason: string, delayMs: number): void {
  if (reconcileTimer !== undefined) {
    clearTimeout(reconcileTimer);
  }
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    const sessionID = routeState.session.value;
    if (sessionID !== null && reason.length > 0) {
      void loadMessages(sessionID, false);
    }
  }, delayMs);
}

function handleIntents(intents: readonly RenderIntent[]): void {
  for (const intent of intents) {
    if (intent.type === "toast") {
      toasts.push(intent.message, intent.tone);
    } else if (intent.type === "notice") {
      noticeSequence += 1;
      feed.upsertNotice({
        id: `intent-notice-${noticeSequence}`,
        kind: intent.tone,
        reason: intent.message,
        createdAt: new Date().toISOString(),
      });
    } else if (intent.type === "reconcile") {
      scheduleReconcile(intent.reason, intent.delayMs);
    } else if (intent.type === "refresh") {
      const sessionID = routeState.session.value;
      if (sessionID !== null) {
        const generation = loadGeneration;
        void loadSidecars(sessionID, generation);
      }
    } else if (intent.type === "stream-paused") {
      feed.setStreamPaused(intent.message !== null);
    }
  }
}

function handleEvent(event: InboundChatEvent): void {
  const result = reduceEvent(event, {
    sessionID: routeState.session.value,
    currentStreamID: null,
    lastSeqByStream: new Map<string, number>(),
  });
  if (!result.accepted) {
    return;
  }
  handleIntents(applyChatActions(result.actions));
}

const chatStream = useChatStream({
  url: computed(() => withProject(`${apiBase.value}/events`)).value,
  onEvent: handleEvent,
  onReady: () => {
    const sessionID = routeState.session.value;
    feed.setStreamReady(chatStream.stream.streamID(), true);
    if (sessionID !== null) {
      void loadMessages(sessionID, false);
    }
  },
  onResync: (reason) => {
    const message =
      reason === "gap"
        ? "Live updates skipped a frame; refreshing the conversation."
        : "The live stream reconnected; refreshing the conversation.";
    feed.setStreamWarning(message);
    scheduleReconcile(reason, 0);
  },
  onLimit: (message) => {
    feed.setStreamWarning(message);
    feed.setStreamPaused(true);
  },
});

watch(
  () => chatStream.status.value,
  (status, detail) => {
    chatUi.setStreamStatus(status, detail);
  },
  { immediate: true },
);

watch(
  () => [routeState.app.value, routeState.project.value, routeState.session.value] as const,
  ([appKey, , sessionID], previous) => {
    if (previous !== undefined && (previous[0] !== appKey || previous[2] !== sessionID)) {
      abortLoads();
    }
    if (appKey.length === 0) {
      feed.reset(null);
      messages.value = [];
      messageCount.value = 0;
      return;
    }
    if (sessionID === null) {
      feed.reset(null);
      messages.value = [];
      messageCount.value = 0;
      return;
    }
    void loadMessages(sessionID, true);
  },
  { immediate: true },
);

function partView(part: PartRecord, pendingDelta: string): ChatMessagePartView {
  const base = typeof part.data.text === "string" ? part.data.text : "";
  const text = `${base}${pendingDelta}`;
  const tool = typeof part.data.tool === "string" ? part.data.tool : "";
  const title = tool.length > 0 ? tool : part.type;
  const state = part.data.state;
  const status =
    typeof state === "object" &&
    state !== null &&
    typeof (state as Record<string, unknown>).status === "string"
      ? ((state as Record<string, unknown>).status as string)
      : typeof part.data.status === "string"
        ? part.data.status
        : "";
  return { id: part.id, type: part.type, text, title, status };
}

const threadMessages = computed<ChatMessageView[]>(() => {
  // The feed thread is a shallowRef with mutable maps; `revision` is the invalidation signal.
  // Projecting to plain view objects keeps ChatMessage updates reactive during streaming.
  feed.revision;
  const out: ChatMessageView[] = [];
  for (const id of feed.thread.order) {
    const record = feed.thread.messages.get(id);
    if (record === undefined) {
      continue;
    }
    const parts: ChatMessagePartView[] = [];
    for (const partID of record.partOrder) {
      const part = record.parts.get(partID);
      if (part === undefined || part.omitted === true) {
        continue;
      }
      parts.push(partView(part, feed.thread.pendingDeltas.get(partID) ?? ""));
    }
    const system = record.system;
    out.push({
      id: record.id,
      role: record.role,
      ...(record.optimistic === undefined ? {} : { optimistic: record.optimistic }),
      omo:
        system === undefined
          ? null
          : {
              title: typeof system.title === "string" ? system.title : "System reminder",
              body: typeof system.body === "string" ? system.body : "",
            },
      parts,
    });
  }
  return out;
});
const messageNodes = computed(() => {
  messageCount.value;
  return threadMessages.value;
});
const notices = computed(() => {
  feed.revision;
  return feed.notices;
});
const threadItems = computed<ChatThreadItem[]>(() => {
  feed.revision;
  const messagesByID = new Map(threadMessages.value.map((message) => [message.id, message]));
  const noticesByID = new Map(notices.value.map((notice) => [notice.id, notice]));
  const items: ChatThreadItem[] = [];
  for (const entry of feed.feedOrder) {
    if (entry.type === "message") {
      const message = messagesByID.get(entry.id);
      if (message !== undefined) {
        items.push({ type: "message", message });
      }
    } else {
      const notice = noticesByID.get(entry.id);
      if (notice !== undefined) {
        items.push({ type: "notice", notice });
      }
    }
  }
  return items;
});
const empty = computed(
  () =>
    !loadingMessages.value &&
    messagesError.value === null &&
    !stopped.value &&
    messageNodes.value.length === 0,
);

const title = computed(() => view.value?.title ?? "Chat");
const appKey = computed(() => view.value?.app.appKey ?? routeState.app.value);

onBeforeUnmount(() => {
  abortLoads();
  if (reconcileTimer !== undefined) {
    clearTimeout(reconcileTimer);
    reconcileTimer = undefined;
  }
  chatUi.reset();
});
</script>

<template>
  <div class="page__body page__body--chat">
    <h1 class="sr-only">{{ appEmpty ? "Chat" : `Chat with ${appKey}` }}</h1>

    <section
      v-if="viewError !== null"
      class="card section"
      aria-labelledby="chat-error-title"
      data-chat-error
    >
      <div class="card__head">
        <h2 class="card__title" id="chat-error-title">Chat could not be loaded</h2>
      </div>
      <div class="card__body stack--tight">
        <p class="form-error" role="alert">{{ viewError }}</p>
        <button class="btn btn-secondary btn-sm" type="button" @click="chatQuery.refetch()">
          <AppIcon name="refresh" />Retry
        </button>
      </div>
    </section>

    <section
      v-else
      class="chat-shell chat-shell--workspace"
      id="chat-shell"
      :data-app-key="routeState.app.value"
      :data-project-id="routeState.project.value"
      :data-chat-sessions="chatUi.sessionsOpen ? 'open' : 'closed'"
      data-chat-context="closed"
      :aria-label="title"
    >
      <div
        v-if="deletionPending"
        class="chat-session-notice"
        role="status"
        data-chat-deletion-pending
      >
        This application is pending deletion. Chat is read-only.
      </div>

      <ChatSessionsRail
        :sessions="sessionStore.sessions"
        :active-session="routeState.session.value"
        :loading="sessionsQuery.isPending.value"
        :error="sessionsError"
        :stopped="stopped"
        @select="routeState.selectSession"
        @close="chatUi.setSessionsOpen(false)"
      />

      <div class="chat-main">
        <div class="chat-pane-head">
          <button
            class="btn btn-ghost btn-icon btn-sm chat-sessions-toggle"
            type="button"
            aria-label="Open sessions"
            @click="chatUi.setSessionsOpen(true)"
          >
            <AppIcon name="menu" />
          </button>
          <span class="chat-pane-head__title">{{ title }}</span>
          <span class="chat-runtime status" :data-status="chatStream.status.value">
            {{
              chatStream.status.value === "paused"
                ? "Paused"
                : chatStream.status.value === "live"
                  ? "Live"
                  : "Connecting"
            }}
          </span>
        </div>
        <ChatThread
          ref="threadRef"
          :items="threadItems"
          :session-id="routeState.session.value"
          :loading="loadingMessages"
          :loading-earlier="loadingEarlier"
          :error="stopped ? null : (messagesError ?? historyError)"
          :empty="empty"
          :stopped="stopped"
          :load-earlier-enabled="historyCursor !== null"
          @load-earlier="loadEarlier"
        />
        <ChatComposer />
      </div>

      <ChatScrim :open="chatUi.sessionsOpen" @close="chatUi.setSessionsOpen(false)" />
    </section>
  </div>
</template>
