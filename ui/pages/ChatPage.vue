<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  handoffBodyFromText,
  handoffNoteFromText,
  imageGateFromView,
  imagePollDelay,
  messageCountLabel,
  normalizeHandoffMeta,
  resolveActiveStatusLabel,
} from "../../assets/chat-core.js";
import type {
  FeedMessageRecord,
  FeedPartRecord as PartRecord,
} from "../../assets/chat-feed-store.js";
import { disposeHighlightController } from "../../assets/chat-highlight.js";
import type { RuntimeState } from "../../src/http/ui.js";
import type { ContextSnapshot } from "../../src/opencode/context.js";
import type { NormalizedTodo } from "../../src/opencode/prompts.js";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import type { InboundChatEvent } from "../chat/event-reducer.js";
import { reduceEvent } from "../chat/event-reducer.js";
import { deriveQueueRows } from "../chat/queue.js";
import { isPendingResolved } from "../chat/send.js";
import { clearChatSessionState, clearChatWorkspaceState } from "../chat/session-storage.js";
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
import { normalizeChatQuery, useChatRouteState } from "../chat/useChatRouteState.js";
import AppIcon from "../components/AppIcon.vue";
import ChatComposer from "../components/chat/ChatComposer.vue";
import ChatImageGate from "../components/chat/ChatImageGate.vue";
import ChatImageWarning from "../components/chat/ChatImageWarning.vue";
import ChatQueueDialog from "../components/chat/ChatQueueDialog.vue";
import ChatQueueStrip from "../components/chat/ChatQueueStrip.vue";
import ChatScrim from "../components/chat/ChatScrim.vue";
import ChatSessionsRail from "../components/chat/ChatSessionsRail.vue";
import ChatThread from "../components/chat/ChatThread.vue";
import { useChatComposer } from "../composables/useChatComposer.js";
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
let composerApi: ReturnType<typeof useChatComposer> | undefined;
const routeState = useChatRouteState(router, route, {
  onBeforeSessionChange: (previous, next) => {
    if (previous !== null && previous !== next) {
      composerApi?.flushForSwitch(previous);
    }
  },
  onBeforeAppSwitch: () => {
    composerApi?.flushForSwitch();
    const previous = normalizeChatQuery(route.query as Record<string, unknown>);
    if (previous.app.length > 0) {
      clearChatWorkspaceState({ app: previous.app, project: previous.project });
    }
  },
});
useWorkspaceShell(
  "page--chat",
  "width=device-width, initial-scale=1, interactive-widget=resizes-content",
);

const feed = useChatFeedStore();
const sessionStore = useChatSessionStore();
const contextStore = useChatContextStore();
const chatUi = useChatUiStore();
const toasts = useToastStore();

if (sessionStore.bindWorkspace(routeState.workspaceKey.value)) {
  feed.reset(null);
}
// A keyed remount can arrive with a deep-linked session before any store data exists; mirror it so
// the next `setSessions` still expands the target's ancestors.
sessionStore.setActive(routeState.session.value);

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

const imageQuery = useQuery<Record<string, unknown>>({
  queryKey: computed(() => ["chat-image", routeState.project.value, routeState.app.value]),
  queryFn: () => apiQuery<Record<string, unknown>>(withProject(`${apiBase.value}/image`)),
  staleTime: 5_000,
  retry: false,
  enabled: computed(() => routeState.app.value.length > 0),
});
const imageView = computed<unknown>(() => imageQuery.data.value ?? null);
const imageGate = computed(() => imageGateFromView(imageView.value));
const imageBlocked = computed(() => imageGate.value.blocked);
const imageActionBusy = ref(false);
let imagePollTimer: ReturnType<typeof setTimeout> | undefined;
let imagePollMode: "build_start" | "rebuild_restart" | null = null;
let imagePollStartedAt = 0;

function stopImagePolling(): void {
  if (imagePollTimer !== undefined) {
    clearTimeout(imagePollTimer);
    imagePollTimer = undefined;
  }
  imagePollMode = null;
}

async function continueImageAction(mode: "build_start" | "rebuild_restart"): Promise<void> {
  await apiMutation<unknown>(
    withProject(`${apiBase.value}/${mode === "rebuild_restart" ? "restart" : "start"}`),
    {
      json: {},
    },
  );
  await imageQuery.refetch();
}

function scheduleImagePoll(): void {
  if (imagePollMode === null) {
    return;
  }
  const delay = imagePollDelay(Date.now() - imagePollStartedAt);
  if (delay <= 0) {
    stopImagePolling();
    return;
  }
  imagePollTimer = setTimeout(() => {
    imagePollTimer = undefined;
    void pollImageBuild();
  }, delay);
}

async function pollImageBuild(): Promise<void> {
  const mode = imagePollMode;
  if (mode === null) {
    return;
  }
  const result = await imageQuery.refetch();
  const view = result.data;
  if (view?.state === "building") {
    scheduleImagePoll();
    return;
  }
  stopImagePolling();
  if (typeof view?.usableImageRef === "string" && view.usableImageRef.length > 0) {
    try {
      await continueImageAction(mode);
    } catch (error) {
      toasts.push(errorText(error, "The image action failed. Try again."), "error");
    }
  }
}

async function runImageAction(action: string): Promise<void> {
  if (imageActionBusy.value || action === "none") {
    return;
  }
  imageActionBusy.value = true;
  try {
    if (action === "build_start" || action === "rebuild_restart") {
      stopImagePolling();
      imagePollMode = action;
      imagePollStartedAt = Date.now();
      await apiMutation<unknown>(withProject(`${apiBase.value}/build`), { json: {} });
      await imageQuery.refetch();
      if (imageQuery.data.value?.state === "building") {
        scheduleImagePoll();
      } else {
        await pollImageBuild();
      }
    } else {
      await apiMutation<unknown>(withProject(`${apiBase.value}/restart`), { json: {} });
      await imageQuery.refetch();
    }
  } catch (error) {
    stopImagePolling();
    toasts.push(errorText(error, "The image action failed. Try again."), "error");
  } finally {
    imageActionBusy.value = false;
  }
}

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
    routeState.canonicalize(data.sessions, { stopped: stopped.value });
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

function dropActiveSession(sessionID: string): void {
  sessionStore.removeSessions([sessionID]);
  clearChatSessionState(chatStorageScope(), sessionID);
  void (async () => {
    await sessionsQuery.refetch();
    await nextTick();
    if (routeState.session.value !== sessionID) {
      return;
    }
    const next = sessionStore.firstRoot() ?? sessionStore.sessions[0]?.id ?? null;
    if (next !== null) {
      routeState.selectSession(next);
      return;
    }
    await router.replace({
      name: "chat",
      query: {
        app: routeState.app.value,
        ...(routeState.project.value.length === 0 ? {} : { project: routeState.project.value }),
      },
    });
  })();
}

composerApi = useChatComposer({
  app: routeState.app,
  project: routeState.project,
  sessionID: routeState.session,
  stopped,
  deletionPending,
  selectSession: routeState.selectSession,
  hasHistory: () => feed.thread.order.length > 0,
  refreshMessages: (sessionID) => loadMessages(sessionID, false),
  onSessionGone: (sessionID) => dropActiveSession(sessionID),
  onSessionDeleted: (sessionID) => dropActiveSession(sessionID),
  onToast: (message, tone) => toasts.push(message, tone),
  onSent: () => {
    void sessionsQuery.refetch();
  },
});
const composer = composerApi;
const {
  draft: composerDraft,
  error: composerError,
  delivery: composerDelivery,
  pendingSends: composerPendingSends,
  abortPending: composerAbortPending,
  mode: composerMode,
  sendDisabled: composerSendDisabled,
  stopDisabled: composerStopDisabled,
  showRecovery: composerShowRecovery,
  handleInput: composerHandleInput,
  send: composerSend,
  stop: composerStop,
  checkAgain: composerCheckAgain,
  removeUnknown: composerRemoveUnknown,
  retryPending: composerRetryPending,
  dismissPending: composerDismissPending,
  restorePending: composerRestorePending,
  shouldSuppressAbort: composerShouldSuppressAbort,
  noteAgentStatus: composerNoteAgentStatus,
  promotionAllowed: composerPromotionAllowed,
} = composer;

const composerPendingRows = computed(() => {
  feed.revision;
  return composerPendingSends.value.filter(
    (entry) => !isPendingResolved(entry, (id) => feed.thread.messages.has(id)),
  );
});

const queueRows = computed(() => {
  feed.revision;
  return deriveQueueRows(feed.thread, composerPromotionAllowed());
});

const deleting = ref<ReadonlySet<string>>(new Set<string>());
const creatingSession = ref(false);

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function chatStorageScope(): { app: string; project: string } {
  return { app: routeState.app.value, project: routeState.project.value };
}

async function createSession(): Promise<void> {
  if (creatingSession.value || routeState.app.value.length === 0) {
    return;
  }
  creatingSession.value = true;
  try {
    const created = await apiMutation<{ id?: unknown }>(withProject(`${apiBase.value}/sessions`), {
      json: {},
    });
    const createdID = typeof created.id === "string" && created.id.length > 0 ? created.id : null;
    await sessionsQuery.refetch();
    await nextTick();
    if (createdID !== null) {
      routeState.selectSession(createdID);
    }
  } catch (error) {
    toasts.push(errorText(error, "Could not create a session."), "error");
  } finally {
    creatingSession.value = false;
  }
}

async function deleteSession(sessionID: string): Promise<void> {
  const removed = sessionStore.subtreeIDs(sessionID);
  const targets = removed.length === 0 ? [sessionID] : removed;
  if (deleting.value.has(sessionID)) {
    return;
  }
  const nextDeleting = new Set(deleting.value);
  for (const id of targets) {
    nextDeleting.add(id);
  }
  deleting.value = nextDeleting;
  try {
    await apiMutation<{ deleted?: boolean }>(
      withProject(`${apiBase.value}/sessions/${encoded(sessionID)}`),
      { form: {} },
      { method: "DELETE" },
    );
    sessionStore.removeSessions(targets);
    const scope = chatStorageScope();
    for (const id of targets) {
      clearChatSessionState(scope, id);
    }
    const activeRemoved =
      routeState.session.value !== null && targets.includes(routeState.session.value);
    await sessionsQuery.refetch();
    await nextTick();
    if (activeRemoved) {
      const next = sessionStore.firstRoot() ?? sessionStore.sessions[0]?.id ?? null;
      if (next !== null) {
        routeState.selectSession(next);
      } else {
        await router.replace({
          name: "chat",
          query: {
            app: routeState.app.value,
            ...(routeState.project.value.length === 0 ? {} : { project: routeState.project.value }),
          },
        });
      }
    }
  } catch (error) {
    toasts.push(errorText(error, "Could not delete this session."), "error");
  } finally {
    const remaining = new Set(deleting.value);
    for (const id of targets) {
      remaining.delete(id);
    }
    deleting.value = remaining;
  }
}

const messages = ref<readonly unknown[]>([]);
const loadingMessages = ref(false);
const messagesError = ref<string | null>(null);
const loadingEarlier = ref(false);
const historyError = ref<string | null>(null);
const historyCursor = ref<string | null>(null);
const historyExhausted = ref(false);
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
  const previousCursor = historyCursor.value;
  if (reset) {
    historyCursor.value = null;
    historyExhausted.value = false;
    loadingEarlier.value = false;
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
    // A tail refresh must not rewind paging to a cursor inside the already-loaded older prefix.
    if (reset) {
      historyCursor.value = data.nextCursor ?? null;
      historyExhausted.value = historyCursor.value === null;
    } else if (!historyExhausted.value && previousCursor === null) {
      historyCursor.value = data.nextCursor ?? null;
      historyExhausted.value = historyCursor.value === null;
    } else {
      historyCursor.value = previousCursor;
    }
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
    historyExhausted.value = historyCursor.value === null;
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
        if (intent.targets.includes("messages")) {
          void loadMessages(sessionID, false);
        }
        const sidecars = intent.targets.some((target) => target !== "messages");
        if (sidecars) {
          void loadSidecars(sessionID, generation);
        }
      }
    } else if (intent.type === "stream-paused") {
      feed.setStreamPaused(intent.message !== null);
    }
  }
}

function handleEvent(event: InboundChatEvent): void {
  if (event.type === "session.error" && composerShouldSuppressAbort(event)) {
    feed.setAgentStatus({ type: "idle" });
    feed.settleIdle();
    return;
  }
  if (event.type === "session.status") {
    composerNoteAgentStatus(event.sessionID, event.status?.type);
  }
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
  return {
    id: part.id,
    type: part.type,
    text,
    title,
    status,
    data: { ...part.data },
    provisional: part.provisional === true,
    partial: part.partial === true,
    sealed: part.sealed === true,
    omitted: part.omitted === true,
    ...(part.truncation === undefined ? {} : { truncation: part.truncation }),
  };
}

function recordTextContent(record: FeedMessageRecord): string {
  const chunks: string[] = [];
  for (const partID of record.partOrder) {
    const part = record.parts.get(partID);
    if (part === undefined || part.type !== "text") {
      continue;
    }
    const text = typeof part.data.text === "string" ? part.data.text : "";
    if (text.length > 0) {
      chunks.push(text);
    }
  }
  return chunks.join("\n");
}

function normalizeHandoffMetadata(record: FeedMessageRecord) {
  const normalized = normalizeHandoffMeta(record.handoff);
  if (normalized === null) {
    return null;
  }
  const direction = normalized.direction === "request" ? "request" : "reply";
  const raw = recordTextContent(record);
  const body =
    typeof normalized.body === "string" && normalized.body.length > 0
      ? normalized.body
      : handoffBodyFromText(raw, direction);
  const note =
    typeof normalized.operatorNote === "string" && normalized.operatorNote.length > 0
      ? normalized.operatorNote
      : direction === "reply"
        ? handoffNoteFromText(raw)
        : "";
  return {
    id: String(normalized.id),
    direction: direction as "request" | "reply",
    agent: String(normalized.agent),
    from: String(normalized.from),
    to: String(normalized.to),
    state: typeof normalized.state === "string" ? normalized.state : undefined,
    summary: String(normalized.summary),
    body,
    note,
    outcome:
      normalized.outcome === "completed" ||
      normalized.outcome === "blocked" ||
      normalized.outcome === "failed"
        ? (normalized.outcome as "completed" | "blocked" | "failed")
        : normalized.outcome === null
          ? null
          : undefined,
    replyState: typeof normalized.replyState === "string" ? normalized.replyState : undefined,
  };
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
      if (part === undefined) {
        continue;
      }
      parts.push(partView(part, feed.thread.pendingDeltas.get(partID) ?? ""));
    }
    const system = record.system;
    const handoff = record.handoff === undefined ? null : normalizeHandoffMetadata(record);
    out.push({
      id: record.id,
      role: record.role,
      ...(record.optimistic === undefined ? {} : { optimistic: record.optimistic }),
      ...(record.time === undefined ? {} : { time: record.time }),
      omo:
        system === undefined
          ? null
          : {
              kind: typeof system.kind === "string" ? system.kind : "system",
              tone: typeof system.tone === "string" ? system.tone : "neutral",
              title: typeof system.title === "string" ? system.title : "System reminder",
              body: typeof system.body === "string" ? system.body : "",
              ...(Array.isArray(system.headers)
                ? { headers: system.headers.filter((value) => typeof value === "string") }
                : {}),
            },
      handoff,
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
const messageCountText = computed(() =>
  messageCountLabel(feed.thread.order.length, historyCursor.value === null),
);
const generatingLabel = computed(() => {
  feed.revision;
  const type = feed.thread.agentStatus?.type;
  const busy = type === "busy" || type === "retry";
  if (!busy && feed.thread.queue.length === 0 && feed.thread.activePromptID === null) {
    return null;
  }
  return resolveActiveStatusLabel({
    statusType: type,
    queueLength: feed.thread.queue.length,
    activePromptID: feed.thread.activePromptID,
    queueBlocked: false,
  });
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

function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") {
    return;
  }
  if (chatUi.queueOpen) {
    event.preventDefault();
    chatUi.setQueueOpen(false);
    return;
  }
  if (chatUi.sessionsOpen) {
    event.preventDefault();
    chatUi.setSessionsOpen(false);
  }
}

onMounted(() => {
  document.addEventListener("keydown", onGlobalKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  abortLoads();
  stopImagePolling();
  disposeHighlightController();
  if (reconcileTimer !== undefined) {
    clearTimeout(reconcileTimer);
    reconcileTimer = undefined;
  }
  const scope = chatStorageScope();
  if (scope.app.length > 0) {
    if (routeState.session.value !== null) {
      clearChatSessionState(scope, routeState.session.value);
    } else {
      clearChatWorkspaceState(scope);
    }
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
      <ChatImageGate :view="imageView" :busy="imageActionBusy" @action="runImageAction" />
      <ChatImageWarning
        :view="imageView"
        :blocked="imageBlocked"
        :busy="imageActionBusy"
        @action="runImageAction"
      />

      <ChatSessionsRail
        :sessions="sessionStore.sessions"
        :tree="sessionStore.tree"
        :active-session="routeState.session.value"
        :expanded="sessionStore.expanded"
        :waiting-counts="sessionStore.waitingCountBySession"
        :loading="sessionsQuery.isPending.value"
        :error="sessionsError"
        :stopped="stopped"
        :deleting="deleting"
        @select="routeState.selectSession"
        @toggle="sessionStore.toggleExpanded"
        @delete="deleteSession"
        @new="createSession"
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
          :workspace-key="routeState.workspaceKey.value"
          :revision="feed.revision"
          :loading="loadingMessages"
          :loading-earlier="loadingEarlier"
          :error="stopped ? null : (messagesError ?? historyError)"
          :empty="empty"
          :stopped="stopped"
          :load-earlier-enabled="historyCursor !== null"
          :message-count="messageCountText"
          :generating-label="generatingLabel"
          @load-earlier="loadEarlier"
        />
        <ChatQueueStrip
          v-if="!stopped && !deletionPending"
          :rows="queueRows"
          @open="chatUi.setQueueOpen(true)"
        />
        <ChatComposer
          :draft="composerDraft"
          :delivery="composerDelivery"
          :error="composerError"
          :pending="composerPendingRows"
          :mode="composerMode"
          :disabled="stopped || deletionPending || imageBlocked"
          :send-disabled="composerSendDisabled"
          :stop-disabled="composerStopDisabled"
          :show-recovery="composerShowRecovery"
          :aria-busy="composerAbortPending"
          :placeholder="`Message ${appKey} agent`"
          @update:draft="composerHandleInput"
          @send="composerSend"
          @stop="composerStop"
          @check-unknown="composerCheckAgain"
          @remove-unknown="composerRemoveUnknown"
          @retry-pending="composerRetryPending"
          @dismiss-pending="composerDismissPending"
          @restore-pending="composerRestorePending"
          @escape="
            chatUi.setQueueOpen(false);
            chatUi.setSessionsOpen(false);
          "
        />
      </div>

      <ChatQueueDialog
        :open="chatUi.queueOpen"
        :rows="queueRows"
        @close="chatUi.setQueueOpen(false)"
      />
      <ChatScrim :open="chatUi.sessionsOpen" @close="chatUi.setSessionsOpen(false)" />
    </section>
  </div>
</template>
