<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  commandBlockedByPending,
  commandLine,
  hanseFallbackEntries,
  parseComposerCommand,
  resolveComposerCommand,
  shellRequiresConfirmation,
} from "../../assets/chat-commands.js";
import {
  type AttachmentView,
  handoffBodyFromText,
  handoffNoteFromText,
  imageGateFromView,
  imagePollDelay,
  messageCountLabel,
  normalizeAttachments,
  normalizeHandoffMeta,
  resolveActiveStatusLabel,
} from "../../assets/chat-core.js";
import type {
  FeedMessageRecord,
  FeedPartRecord as PartRecord,
} from "../../assets/chat-feed-store.js";
import { disposeHighlightController } from "../../assets/chat-highlight.js";
import type { RuntimeState } from "../../src/http/ui.js";
import type { CommandEntry } from "../../src/opencode/commands.js";
import type { ContextSnapshot } from "../../src/opencode/context.js";
import type { NormalizedTodo } from "../../src/opencode/prompts.js";
import type { PreviewView } from "../../src/preview/types.js";
import { ApiError, apiMutation, apiQuery } from "../api.js";
import type { BootPayload } from "../boot.js";
import type { InboundChatEvent } from "../chat/event-reducer.js";
import { reduceEvent } from "../chat/event-reducer.js";
import {
  isQuestionToolPart,
  partAnswers,
  partCorrelationKey,
  partQuestions,
  partTerminal,
} from "../chat/prompt-utils.js";
import { deriveQueueRows } from "../chat/queue.js";
import { commandListUrl, commandSendUrl, isPendingResolved, localMessageID } from "../chat/send.js";
import { clearChatSessionState, clearChatWorkspaceState } from "../chat/session-storage.js";
import { applyChatActions, type RenderIntent } from "../chat/state-actions.js";
import type {
  ChatCommandsResponse,
  ChatMessagePartView,
  ChatMessagesResponse,
  ChatMessageView,
  ChatNoticesResponse,
  ChatPromptsResponse,
  ChatResponse,
  ChatRuntimeResponse,
  ChatSavedPermissionsResponse,
  ChatSessionsResponse,
  ChatThreadItem,
  ChatTodoResponse,
  CommandConfirmRequest,
  CommandPaletteStatus,
  InlineQuestionView,
  QuestionOutcome,
} from "../chat/types.js";
import { normalizeChatQuery, useChatRouteState } from "../chat/useChatRouteState.js";
import AppIcon from "../components/AppIcon.vue";
import ChatAttachments from "../components/chat/ChatAttachments.vue";
import ChatCommandPalette from "../components/chat/ChatCommandPalette.vue";
import ChatComposer from "../components/chat/ChatComposer.vue";
import ChatContextRail from "../components/chat/ChatContextRail.vue";
import ChatImageGate from "../components/chat/ChatImageGate.vue";
import ChatImageWarning from "../components/chat/ChatImageWarning.vue";
import ChatPromptDock from "../components/chat/ChatPromptDock.vue";
import ChatQueueDialog from "../components/chat/ChatQueueDialog.vue";
import ChatQueueStrip from "../components/chat/ChatQueueStrip.vue";
import ChatScrim from "../components/chat/ChatScrim.vue";
import ChatSessionsRail from "../components/chat/ChatSessionsRail.vue";
import ChatSshApprovals from "../components/chat/ChatSshApprovals.vue";
import ChatThread from "../components/chat/ChatThread.vue";
import { useChatComposer } from "../composables/useChatComposer.js";
import { useChatStream } from "../composables/useChatStream.js";
import { applyChrome } from "../composables/useChrome.js";
import { useWorkspaceShell } from "../composables/useWorkspaceShell.js";
import { useChatContextStore } from "../stores/chat-context.js";
import { useChatFeedStore } from "../stores/chat-feed.js";
import { type PromptEntry, useChatPromptsStore } from "../stores/chat-prompts.js";
import { chatSessionLabel, useChatSessionStore } from "../stores/chat-session.js";
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
const promptsStore = useChatPromptsStore();
const chatUi = useChatUiStore();
const toasts = useToastStore();
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null);
const previewsView = ref<readonly PreviewView[]>([]);
const sshApprovalCount = ref(0);
const compactBusy = ref(false);
const compactError = ref<string | null>(null);

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

function projectSuffix(path: string): string {
  return routeState.project.value.length === 0
    ? path
    : `${path}${path.includes("?") ? "&" : "?"}project=${encoded(routeState.project.value)}`;
}

let previewRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let contextPollTimer: ReturnType<typeof setInterval> | undefined;
let contextPollStartedAt = 0;
const CONTEXT_POLL_MS = 2_000;
const CONTEXT_POLL_MAX_MS = 10 * 60_000;

function stopContextPolling(): void {
  if (contextPollTimer !== undefined) {
    clearInterval(contextPollTimer);
    contextPollTimer = undefined;
  }
  contextPollStartedAt = 0;
}

function stopPreviewRefresh(): void {
  if (previewRefreshTimer !== undefined) {
    clearTimeout(previewRefreshTimer);
    previewRefreshTimer = undefined;
  }
}

const COMMANDS_CACHE_MS = 30_000;
const SHELL_CONFIRM_BODY =
  "This command contains shell blocks, or its shell usage cannot be verified, and it runs on the server outside the agent permission flow.";
const commandEntries = ref<readonly CommandEntry[]>([]);
const commandStatus = ref<CommandPaletteStatus>("loading");
const commandWarning = ref<string | null>(null);
const commandShadowed = ref<readonly string[]>([]);
let commandFetchedAt = 0;
const paletteOpen = ref(false);
const paletteFilter = ref("");
const commandConfirm = ref<CommandConfirmRequest | null>(null);
let commandConfirmResolver: ((accepted: boolean) => void) | null = null;

function commandScope(): { app: string; project: string } {
  return { app: routeState.app.value, project: routeState.project.value };
}

function commandWarningsFrom(value: unknown): { warning: string | null; shadowed: string[] } {
  const shadowed: string[] = [];
  let warning: string | null = null;
  if (!Array.isArray(value)) return { warning, shadowed };
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const code = typeof entry.code === "string" ? entry.code : "";
    const message = typeof entry.message === "string" ? entry.message.trim() : "";
    if (code === "command_shadowed" && typeof entry.command === "string") {
      shadowed.push(entry.command);
      continue;
    }
    if (warning === null && message.length > 0) warning = message;
  }
  return { warning, shadowed };
}

async function loadCommands(force = false): Promise<void> {
  if (routeState.app.value.length === 0) return;
  if (
    !force &&
    commandEntries.value.length > 0 &&
    Date.now() - commandFetchedAt < COMMANDS_CACHE_MS
  ) {
    return;
  }
  try {
    const data = await apiQuery<ChatCommandsResponse>(commandListUrl(commandScope()));
    const commands = Array.isArray(data.commands) ? (data.commands as CommandEntry[]) : [];
    const sources =
      typeof data.sources === "object" && data.sources !== null
        ? (data.sources as Record<string, unknown>)
        : {};
    const opencode = typeof sources.opencode === "string" ? sources.opencode : "unavailable";
    commandStatus.value =
      opencode === "ok"
        ? "ready"
        : opencode === "stopped"
          ? "stopped"
          : opencode === "unconfigured"
            ? "unconfigured"
            : "unavailable";
    commandEntries.value = commands;
    const mapped = commandWarningsFrom(data.warnings);
    commandWarning.value = mapped.warning;
    commandShadowed.value = mapped.shadowed;
    commandFetchedAt = Date.now();
  } catch {
    commandEntries.value = hanseFallbackEntries(view.value?.app.master === true);
    commandStatus.value = "unavailable";
    commandWarning.value = "Application commands are unavailable; Hanse commands still work.";
    commandShadowed.value = [];
    commandFetchedAt = Date.now();
  }
}

function openCommands(): void {
  paletteOpen.value = true;
  const parsed = parseComposerCommand(composerDraft.value);
  paletteFilter.value = parsed.kind === "command" ? parsed.token : "";
  void loadCommands();
}

function closeCommands(): void {
  paletteOpen.value = false;
  paletteFilter.value = "";
}

function selectCommand(entry: CommandEntry): void {
  composerHandleInput(commandLine(entry.name));
  closeCommands();
  focusComposer();
}

function askCommandConfirm(request: CommandConfirmRequest): Promise<boolean> {
  if (commandConfirmResolver !== null) {
    commandConfirmResolver(false);
    commandConfirmResolver = null;
  }
  commandConfirm.value = request;
  return new Promise<boolean>((resolve) => {
    commandConfirmResolver = resolve;
  });
}

function resolveCommandConfirm(accepted: boolean): void {
  const resolve = commandConfirmResolver;
  commandConfirmResolver = null;
  commandConfirm.value = null;
  resolve?.(accepted);
  focusComposer();
}

function openNewTab(url: string): void {
  if (url.length === 0) {
    toasts.push("No link is available.", "error");
    return;
  }
  let opened: Window | null = null;
  try {
    opened = window.open(url, "_blank");
  } catch {
    opened = null;
  }
  if (opened === null) {
    toasts.push("Opened in this tab because the popup was blocked.", "success");
    window.location.assign(url);
    return;
  }
  try {
    opened.opener = null;
  } catch {
    // Cross-origin handle; the tab is already open.
  }
}

async function ensureCommandSession(title?: string): Promise<string | null> {
  if (routeState.session.value !== null) return routeState.session.value;
  return composerCreateSession(title === undefined ? {} : { title });
}

async function sendServerCommand(entry: CommandEntry, args: string): Promise<void> {
  const session = await ensureCommandSession();
  if (session === null) return;
  let confirmShell = shellRequiresConfirmation(entry.shell);
  if (confirmShell) {
    const accepted = await askCommandConfirm({
      title: `Run /${entry.name}?`,
      body: SHELL_CONFIRM_BODY,
      confirmLabel: "Run command",
      cancelLabel: "Cancel",
    });
    if (!accepted) return;
  }
  const originalDraft = composerDraft.value;
  const lineText = commandLine(entry.name, args).trim();
  const tempID = localMessageID();
  composerHandleInput("");
  feed.insertOptimisticMessage({ id: tempID, text: lineText, attachments: [] });
  let retried = false;
  for (;;) {
    try {
      const response = await apiMutation<{ messageID?: unknown }>(
        commandSendUrl(commandScope(), session),
        { json: { name: entry.name, arguments: args, confirmShell } },
      );
      const serverID =
        typeof response === "object" &&
        response !== null &&
        typeof (response as { messageID?: unknown }).messageID === "string" &&
        (response as { messageID: string }).messageID.length > 0
          ? (response as { messageID: string }).messageID
          : null;
      if (serverID === null) {
        throw Object.assign(new TypeError("Delivery unknown; checking…"), { outcome: "unknown" });
      }
      feed.rekeyOptimistic({
        tempID,
        serverID,
        allowPromotion: composerPromotionAllowed(),
      });
      feed.clearOptimisticState(serverID);
      toasts.push("Command accepted.", "success");
      void sessionsQuery.refetch();
      return;
    } catch (caught) {
      if (
        !retried &&
        caught instanceof ApiError &&
        caught.status === 400 &&
        caught.code === "shell_confirmation_required"
      ) {
        const accepted = await askCommandConfirm({
          title: `Run /${entry.name}?`,
          body: SHELL_CONFIRM_BODY,
          confirmLabel: "Run command",
          cancelLabel: "Cancel",
        });
        if (accepted) {
          retried = true;
          confirmShell = true;
          continue;
        }
      }
      feed.removeMessage(tempID);
      composerHandleInput(originalDraft);
      const message =
        caught instanceof ApiError && caught.code === "command_not_found"
          ? "Command not found; refreshing the list."
          : errorText(caught, "Could not run the command.");
      toasts.push(message, "error");
      if (caught instanceof ApiError && caught.code === "command_not_found") {
        void loadCommands(true);
      }
      return;
    }
  }
}

async function runHanseAction(entry: CommandEntry, args: string): Promise<void> {
  switch (entry.action) {
    case "new":
      composerHandleInput("");
      await createSession();
      focusComposer();
      return;
    case "help": {
      const filter = args.trim().length === 0 ? "" : (args.trim().split(/\s+/)[0] ?? "");
      composerHandleInput("");
      paletteOpen.value = true;
      paletteFilter.value = filter;
      void loadCommands();
      focusComposer();
      return;
    }
    case "editor":
      composerHandleInput("");
      openNewTab(view.value?.links.ide ?? "");
      return;
    case "diff":
      composerHandleInput("");
      openNewTab(view.value === undefined ? "" : `${view.value.links.app}#changes-title`);
      return;
    case "compact":
      composerHandleInput("");
      await compactSession();
      return;
    case "restart": {
      const accepted = await askCommandConfirm({
        title: `Restart ${appKey.value}?`,
        body: "An active turn will be interrupted.",
        confirmLabel: "Restart agent",
        cancelLabel: "Cancel",
      });
      if (!accepted) return;
      composerHandleInput("");
      await restartAgent();
      return;
    }
    default:
      toasts.push(`/${entry.name} is not available in this build.`, "error");
  }
}

async function runComposerCommand(parsed: { token: string; args: string }): Promise<void> {
  if (composerAttachments.value.length > 0) {
    toasts.push("Remove attachments before using a slash command.", "error");
    return;
  }
  if (commandEntries.value.length === 0) {
    await loadCommands(true);
  }
  const listAvailable = commandEntries.value.length > 0;
  const resolved = resolveComposerCommand(listAvailable ? commandEntries.value : [], parsed.token, {
    listAvailable,
    master: view.value?.app.master === true,
  });
  if (resolved.kind === "unknown") {
    const accepted = await askCommandConfirm({
      title: "Unknown command",
      body: `/${parsed.token} is not a command in this workspace. Send it as a message instead?`,
      confirmLabel: "Send message",
      cancelLabel: "Cancel",
    });
    if (accepted) {
      await composerSend();
    }
    return;
  }
  if (resolved.kind === "disabled") {
    toasts.push(resolved.reason, "error");
    return;
  }
  if (
    commandBlockedByPending(
      resolved.entry,
      promptsStore.dockEntriesForSession(routeState.session.value).length > 0,
    )
  ) {
    toasts.push("Answer the pending request first.", "error");
    focusComposer();
    return;
  }
  if (resolved.kind === "opencode") {
    if (resolved.shadowed) {
      toasts.push(`/${parsed.token} is provided by the application.`, "error");
    }
    await sendServerCommand(resolved.entry, parsed.args);
    return;
  }
  if (resolved.action !== "help" && parsed.args.trim().length > 0) {
    toasts.push(`/${resolved.entry.name} does not take arguments.`, "error");
    return;
  }
  await runHanseAction(resolved.entry, parsed.args);
}

async function submitComposer(): Promise<void> {
  const parsed = parseComposerCommand(composerDraft.value);
  if (parsed.kind !== "command") {
    await composerSend();
    return;
  }
  await runComposerCommand(parsed);
}

function onAppSelect(event: Event): void {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  const option = select.selectedOptions[0];
  const app = option?.dataset.app ?? "";
  const project = option?.dataset.project ?? "";
  if (app.length === 0 || (app === routeState.app.value && project === routeState.project.value)) {
    return;
  }
  routeState.switchApp(app, project);
}

function redeliverAttachment(attachment: AttachmentView): void {
  void composerRedeliverAttachment(attachment);
}

async function loadPrompts(signal?: AbortSignal): Promise<void> {
  if (routeState.app.value.length === 0) return;
  try {
    const data = await apiQuery<ChatPromptsResponse>(
      withProject(`${apiBase.value}/prompts`),
      signal === undefined ? {} : { signal },
    );
    promptsStore.hydrate(data.questions ?? [], data.permissions ?? []);
    chatUi.setPolicyWarnings(data.warnings ?? []);
  } catch {
    // Keep the last prompt state; a stopped agent or a transient read must not clear the dock.
  }
}

async function loadSavedPermissions(signal?: AbortSignal): Promise<void> {
  if (routeState.app.value.length === 0) return;
  try {
    const data = await apiQuery<ChatSavedPermissionsResponse>(
      withProject(`${apiBase.value}/permissions/saved`),
      signal === undefined ? {} : { signal },
    );
    promptsStore.setSavedPermissions(data.permissions ?? []);
  } catch {
    // Saved permissions are optional in the rail.
  }
}

async function loadPreviews(): Promise<void> {
  if (routeState.app.value.length === 0 || routeState.project.value.length === 0) return;
  try {
    const data = await apiQuery<{ previews?: readonly PreviewView[] }>(
      projectSuffix(`${apiBase.value}/previews`),
    );
    previewsView.value = data.previews ?? [];
  } catch {
    // Preview listing is optional (runner-only).
  }
}

function schedulePreviewRefresh(): void {
  if (previewRefreshTimer !== undefined) return;
  previewRefreshTimer = setTimeout(() => {
    previewRefreshTimer = undefined;
    void loadPreviews();
  }, 50);
}

async function refreshContext(sessionID: string): Promise<void> {
  try {
    const snapshot = await apiQuery<ContextSnapshot>(
      `${apiBase.value}/sessions/${encoded(sessionID)}/context${projectQuery.value}`,
    );
    if (routeState.session.value === sessionID) {
      contextStore.setSnapshot(sessionID, snapshot, true);
      if (snapshot.state !== "compacting") stopContextPolling();
    }
  } catch {
    // Context is optional; stream/status refreshes retry it.
  }
}

function startContextPolling(sessionID: string): void {
  stopContextPolling();
  contextPollStartedAt = Date.now();
  contextPollTimer = setInterval(() => {
    if (Date.now() - contextPollStartedAt >= CONTEXT_POLL_MAX_MS) {
      stopContextPolling();
      return;
    }
    if (typeof document !== "undefined" && document.hidden) return;
    if (routeState.session.value !== sessionID) {
      stopContextPolling();
      return;
    }
    void refreshContext(sessionID);
  }, CONTEXT_POLL_MS);
}

function contextErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Compaction failed. Try again.";
  if (error.status === 401) return "Sign in again to compact this session.";
  if (error.status === 403) return "You do not have permission to compact this session.";
  if (error.status === 404) return "Session not found.";
  if (error.status === 409) {
    if (error.code === "not_top_level")
      return "Compaction is only available for top-level sessions.";
    if (error.code === "session_busy") return "Wait for the agent to finish before compacting.";
    if (error.code === "compact_in_progress") return "Compaction is already in progress.";
    if (error.code === "model_unavailable") return "No model is available for this session.";
    return "Compaction is not available right now.";
  }
  if (error.status === 502) return "Compaction failed. Try again.";
  if (error.status === 503) return "Context is unavailable. Try again.";
  return "Compaction failed. Try again.";
}

async function compactSession(): Promise<void> {
  const sessionID = routeState.session.value;
  if (sessionID === null || compactBusy.value) return;
  compactBusy.value = true;
  compactError.value = null;
  try {
    const result = await apiMutation<{ accepted?: boolean }>(
      `${apiBase.value}/sessions/${encoded(sessionID)}/compact${projectQuery.value}`,
      { json: {} },
    );
    if (result.accepted !== true) {
      throw new Error("Compaction was not accepted.");
    }
    contextStore.setCompacting(sessionID);
    startContextPolling(sessionID);
    toasts.push("Compaction started.", "success");
    await refreshContext(sessionID);
  } catch (error) {
    const message = contextErrorMessage(error);
    compactError.value = message;
    toasts.push(message, "error");
  } finally {
    compactBusy.value = false;
  }
}

async function restartAgent(): Promise<void> {
  try {
    await apiMutation<unknown>(withProject(`${apiBase.value}/restart`), { json: {} });
    await chatQuery.refetch();
    await sessionsQuery.refetch();
    toasts.push("Agent restart requested.", "success");
  } catch (error) {
    toasts.push(errorText(error, "Could not restart the agent."), "error");
  }
}

async function closePreview(key: string): Promise<void> {
  try {
    await apiMutation<unknown>(projectSuffix(`${apiBase.value}/previews/${encoded(key)}/close`), {
      json: {},
    });
    previewsView.value = previewsView.value.filter((preview) => preview.key !== key);
  } catch (error) {
    toasts.push(errorText(error, "Could not close the preview."), "error");
  }
}

async function revokeSavedPermission(id: string): Promise<void> {
  try {
    await apiMutation<unknown>(
      withProject(`${apiBase.value}/permissions/saved/${encoded(id)}`),
      { json: {} },
      { method: "DELETE" },
    );
    promptsStore.removeSavedPermission(id);
    toasts.push("Saved permission revoked.", "success");
  } catch (error) {
    toasts.push(errorText(error, "Could not revoke the saved permission."), "error");
  }
}

function focusComposer(): void {
  void nextTick().then(() => composerRef.value?.focus());
}

async function submitQuestion(entry: PromptEntry, answers: string[][]): Promise<void> {
  if (entry.kind !== "question") return;
  const request = entry.request;
  promptsStore.markBusy(request.key, true);
  promptsStore.setError(request.key, null);
  try {
    await apiMutation<unknown>(
      withProject(`${apiBase.value}/questions/${encoded(request.id)}/reply`),
      { json: { source: request.source, answers } },
    );
    promptsStore.resolveQuestion(request.id, request.source, "answered", {
      answers,
      questions: request.questions,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      promptsStore.resolveQuestion(request.id, request.source, "expired", {
        reason: "Already answered or expired",
        questions: request.questions,
      });
      toasts.push("Already answered or expired.", "error");
    } else {
      promptsStore.setError(request.key, errorText(error, "Could not send the answer."));
    }
  } finally {
    promptsStore.markBusy(request.key, false);
    focusComposer();
  }
}

async function rejectQuestion(entry: PromptEntry): Promise<void> {
  if (entry.kind !== "question") return;
  const request = entry.request;
  promptsStore.markBusy(request.key, true);
  promptsStore.setError(request.key, null);
  try {
    await apiMutation<unknown>(
      withProject(`${apiBase.value}/questions/${encoded(request.id)}/reject`),
      { json: { source: request.source } },
    );
    promptsStore.resolveQuestion(request.id, request.source, "dismissed", {
      questions: request.questions,
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      promptsStore.resolveQuestion(request.id, request.source, "expired", {
        reason: "Already answered or expired",
        questions: request.questions,
      });
      toasts.push("Already answered or expired.", "error");
    } else {
      promptsStore.setError(request.key, errorText(error, "Could not dismiss the question."));
    }
  } finally {
    promptsStore.markBusy(request.key, false);
    focusComposer();
  }
}

async function replyPermission(
  entry: PromptEntry,
  reply: "once" | "always" | "reject",
  message?: string,
): Promise<void> {
  if (entry.kind !== "permission") return;
  const request = entry.request;
  promptsStore.markBusy(request.key, true);
  promptsStore.setError(request.key, null);
  try {
    const body: Record<string, unknown> = { source: request.source, reply };
    if (typeof message === "string" && message.length > 0) body.message = message;
    await apiMutation<unknown>(
      withProject(`${apiBase.value}/permissions/${encoded(request.id)}/reply`),
      { json: body },
    );
    promptsStore.resolvePermission(request.id, request.source);
    if (reply === "always") {
      await loadSavedPermissions();
      if (request.source === "v2") void loadPrompts();
    }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      promptsStore.resolvePermission(request.id, request.source);
      toasts.push("Already answered or expired.", "error");
    } else {
      promptsStore.setError(request.key, errorText(error, "Could not reply to the request."));
    }
  } finally {
    promptsStore.markBusy(request.key, false);
    focusComposer();
  }
}

function outcomeLabel(outcome: QuestionOutcome): string {
  if (outcome.kind === "answered") {
    return outcome.elsewhere === true ? "Answered elsewhere" : "Answered";
  }
  if (outcome.kind === "dismissed") return "Dismissed";
  return outcome.reason ?? "Request no longer pending";
}

function inlineQuestionView(
  part: ChatMessagePartView,
  messageID: string,
): InlineQuestionView | null {
  if (!isQuestionToolPart(part)) return null;
  const partKey = partCorrelationKey(part, routeState.session.value, messageID);
  if (partKey === null) return null;
  const data = part.data;
  const toolMessageID = typeof data.messageID === "string" ? data.messageID : "";
  const toolCallID =
    typeof data.callID === "string" && data.callID.length > 0 ? data.callID : part.id;
  const entry =
    promptsStore.questionByCorrelation(partKey) ??
    promptsStore.questionByToolRef(toolMessageID, toolCallID);
  const correlationKey =
    entry === undefined ? partKey : (promptsStore.promptCorrelationKey(entry) ?? partKey);
  const outcome =
    entry === undefined
      ? (promptsStore.outcomeForCorrelation(correlationKey) ??
        promptsStore.outcomeForToolRef(toolMessageID, toolCallID))
      : promptsStore.outcomeFor(entry.key);
  if (entry === undefined && outcome === undefined) {
    if (!partTerminal(part)) return null;
    return {
      key: correlationKey,
      correlationKey,
      questions: partQuestions(part),
      state: "answered",
      stateLabel: "Answered",
      answers: partAnswers(part),
      busy: false,
      tooLarge: false,
      readOnly: true,
    };
  }
  if (entry !== undefined) {
    const error = promptsStore.errorFor(entry.key);
    return {
      key: entry.key,
      correlationKey,
      questions: entry.questions,
      state: entry.tooLarge ? "tooLarge" : "pending",
      stateLabel: entry.tooLarge ? "Too large" : "",
      ...(entry.tooLarge && entry.tooLargeReason !== undefined
        ? { tooLargeReason: entry.tooLargeReason }
        : {}),
      answers: null,
      busy: promptsStore.isBusy(entry.key),
      ...(error === undefined ? {} : { error }),
      tooLarge: entry.tooLarge,
      readOnly: false,
    };
  }
  const resolved = outcome as QuestionOutcome;
  return {
    key: promptsStore.questionKeyForCorrelation(correlationKey) ?? correlationKey,
    correlationKey,
    questions: resolved.questions ?? partQuestions(part),
    state: resolved.kind === "answered" ? "answered" : resolved.kind,
    stateLabel: outcomeLabel(resolved),
    answers: resolved.answers ?? partAnswers(part),
    busy: false,
    tooLarge: false,
    readOnly: true,
  };
}

function submitInlineQuestion(view: InlineQuestionView, answers: string[][]): void {
  const entry = promptsStore.questions.find((request) => request.key === view.key);
  if (entry === undefined) return;
  void submitQuestion({ kind: "question", request: entry }, answers);
}

function rejectInlineQuestion(view: InlineQuestionView): void {
  const entry = promptsStore.questions.find((request) => request.key === view.key);
  if (entry === undefined) return;
  void rejectQuestion({ kind: "question", request: entry });
}

const dockEntries = computed(() => {
  promptsStore.revision;
  return promptsStore.dockEntriesForSession(routeState.session.value);
});
const composerEmpty = computed(() => composerDraft.value.trim().length === 0);

watch(
  [() => promptsStore.revision, () => routeState.session.value],
  () => {
    chatUi.setNeedsInput(promptsStore.needsInputCount(routeState.session.value));
  },
  { immediate: true },
);

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

watch(
  () => view.value?.previews,
  (previews) => {
    if (previews !== undefined) {
      previewsView.value = previews;
    }
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
  attachments: composerAttachments,
  attachmentQuota: composerAttachmentQuota,
  createSession: composerCreateSession,
  addFiles: composerAddFiles,
  retryAttachment: composerRetryAttachment,
  removeAttachment: composerRemoveAttachment,
  cancelUpload: composerCancelUpload,
  setAttachmentMode: composerSetAttachmentMode,
  redeliverAttachmentAsFile: composerRedeliverAttachment,
} = composer;

watch(
  composerDraft,
  (value) => {
    const tokenDraft = /^\/(?!\/)\S*$/.test(value) ? value.slice(1) : null;
    if (tokenDraft !== null) {
      paletteOpen.value = true;
      paletteFilter.value = tokenDraft;
      if (commandEntries.value.length === 0) void loadCommands();
      return;
    }
    if (paletteOpen.value) closeCommands();
  },
  { immediate: true },
);

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
    const todoData = await apiQuery<ChatTodoResponse | readonly NormalizedTodo[]>(path("todo"), {
      ...(signal === undefined ? {} : { signal }),
    });
    const normalized = Array.isArray(todoData)
      ? { todos: todoData, truncated: false }
      : (todoData as ChatTodoResponse);
    const todos = normalized.todos ?? [];
    const truncated = normalized.truncated === true;
    if (generation === loadGeneration && routeState.session.value === sessionID) {
      contextStore.setTodos(sessionID, todos, truncated, true);
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

  if (generation === loadGeneration) {
    void loadCommands();
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
    } else if (intent.type === "prompt-upsert") {
      if (intent.kind === "question") {
        promptsStore.upsert("question", intent.request as never);
      } else {
        promptsStore.upsert("permission", intent.request as never);
      }
    } else if (intent.type === "prompt-resolve") {
      if (intent.kind === "question") {
        const outcome =
          intent.outcome === "dismissed"
            ? "dismissed"
            : intent.outcome === "answered"
              ? "answered"
              : "expired";
        promptsStore.resolveQuestion(intent.requestID, intent.source, outcome);
      } else {
        promptsStore.resolvePermission(intent.requestID, intent.source);
      }
    }
  }
}

function eventTouchesPreviews(event: InboundChatEvent): boolean {
  if (event.type !== "message.part.updated") return false;
  const tool = event.part?.tool;
  return (
    tool === "preview_open" ||
    tool === "preview_close" ||
    tool === "hanse_preview_open" ||
    tool === "hanse_preview_close"
  );
}

function handleEvent(event: InboundChatEvent): void {
  if (eventTouchesPreviews(event)) {
    schedulePreviewRefresh();
  }
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
    void loadPrompts();
    void loadSavedPermissions();
    void loadPreviews();
    void loadCommands(true);
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
  ([appKey, projectID, sessionID], previous) => {
    if (previous !== undefined && (previous[0] !== appKey || previous[2] !== sessionID)) {
      abortLoads();
    }
    const workspaceChanged =
      previous === undefined || previous[0] !== appKey || previous[1] !== projectID;
    if (workspaceChanged) {
      promptsStore.clear();
      chatUi.setPolicyWarnings([]);
      previewsView.value = [];
      sshApprovalCount.value = 0;
      stopContextPolling();
      compactError.value = null;
    }
    if (appKey.length === 0) {
      feed.reset(null);
      messages.value = [];
      messageCount.value = 0;
      return;
    }
    if (workspaceChanged) {
      void loadPrompts();
      void loadSavedPermissions();
      void loadPreviews();
      void loadCommands(true);
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
    const attachments = normalizeAttachments(record.attachments);
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
      ...(attachments.length === 0 ? {} : { attachments }),
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
const activeSession = computed(() => {
  const sessionID = routeState.session.value;
  if (sessionID === null) return undefined;
  return sessionStore.sessions.find((session) => session.id === sessionID);
});
const sessionTitle = computed(() => {
  const sessionID = routeState.session.value;
  if (sessionID === null) return "Session";
  const session = activeSession.value;
  return session === undefined ? `Session ${sessionID.slice(0, 8)}` : chatSessionLabel(session);
});
const sessionSnapshot = computed(() => contextStore.snapshotFor(routeState.session.value));
const sessionTodos = computed(() => contextStore.todosFor(routeState.session.value)?.todos ?? []);
const sessionWaiting = computed(() => {
  promptsStore.revision;
  const sessionID = routeState.session.value;
  return sessionID !== null && promptsStore.countForSession(sessionID) > 0;
});

function openContextSection(section: "context" | "plan"): void {
  chatUi.setContextOpen(true);
  void nextTick().then(() => {
    const target = document.getElementById(
      section === "plan" ? "chat-plan-section" : "chat-context-usage",
    );
    if (target === null) return;
    target.scrollIntoView?.({ block: "start" });
    const heading = target.querySelector<HTMLElement>("h2");
    heading?.focus();
  });
}
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
    return;
  }
  if (chatUi.contextOpen) {
    event.preventDefault();
    chatUi.setContextOpen(false);
  }
}

onMounted(() => {
  document.addEventListener("keydown", onGlobalKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onGlobalKeydown);
  if (commandConfirmResolver !== null) {
    const resolve = commandConfirmResolver;
    commandConfirmResolver = null;
    commandConfirm.value = null;
    resolve(false);
  }
  abortLoads();
  stopImagePolling();
  stopContextPolling();
  stopPreviewRefresh();
  promptsStore.clear();
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
      :data-chat-context="chatUi.contextOpen ? 'open' : 'closed'"
      :aria-label="title"
    >
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
          <label class="sr-only" for="chat-app-select">Application</label>
          <div v-if="view !== undefined && view.appOptions.length > 0" class="chat-app-select">
            <select
              id="chat-app-select"
              class="select"
              data-chat-app-select
              :value="`${routeState.project.value}:${routeState.app.value}`"
              @change="onAppSelect"
            >
              <template v-for="group in view.appOptions" :key="group.projectId">
                <optgroup :label="group.projectName">
                  <option
                    v-for="option in group.apps"
                    :key="option.value"
                    :value="`${option.projectId}:${option.appKey}`"
                    :data-app="option.appKey"
                    :data-project="option.projectId"
                    :selected="option.selected"
                  >
                    {{ group.projectName }} / {{ option.appKey }}
                  </option>
                </optgroup>
              </template>
            </select>
          </div>
          <span v-if="view === undefined" class="chat-pane-head__title">{{ title }}</span>
          <button
            class="btn btn-ghost btn-icon btn-sm chat-pane-head__new"
            type="button"
            aria-label="New session"
            title="New session"
            data-chat-new-session-head
            :disabled="stopped || creatingSession"
            @click="createSession"
          >
            <AppIcon name="plus" />
          </button>
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
          :session-title="sessionTitle"
          :stream-status="chatStream.status.value"
          :waiting="sessionWaiting"
          :todos="sessionTodos"
          :context-snapshot="sessionSnapshot"
          :approval-count="sshApprovalCount"
          :question-view-for-part="inlineQuestionView"
          @load-earlier="loadEarlier"
          @question-submit="submitInlineQuestion"
          @question-reject="rejectInlineQuestion"
          @attachment-redeliver="redeliverAttachment"
          @open-context="openContextSection"
        >
          <template #image-gate>
            <ChatImageGate :view="imageView" :busy="imageActionBusy" @action="runImageAction" />
          </template>
          <template #image-warning>
            <ChatImageWarning
              :view="imageView"
              :blocked="imageBlocked"
              :busy="imageActionBusy"
              @action="runImageAction"
            />
          </template>
          <template #approvals>
            <ChatSshApprovals
              v-if="view !== undefined && !stopped"
              class="ssh-approval-slot"
              :app-key="view.app.appKey"
              :project="view.app.projectId"
              :disabled="deletionPending"
              @update:count="sshApprovalCount = $event"
            />
          </template>
          <template #queue-strip>
            <ChatQueueStrip
              v-if="!stopped && !deletionPending"
              :rows="queueRows"
              @open="chatUi.setQueueOpen(true)"
            />
          </template>
          <template #session-notice>
            <div
              v-if="deletionPending"
              class="chat-session-notice"
              role="status"
              data-chat-deletion-pending
            >
              This application is pending deletion. Chat is read-only.
            </div>
          </template>
          <template #prompt-dock>
            <ChatPromptDock
              v-if="!stopped && !appEmpty"
              :entries="dockEntries"
              :busy-for="(key: string) => promptsStore.isBusy(key)"
              :error-for="(key: string) => promptsStore.errorFor(key)"
              :auto-focus="composerEmpty"
              :disabled="deletionPending"
              @question-submit="submitQuestion"
              @question-reject="rejectQuestion"
              @permission-once="(entry: PromptEntry) => replyPermission(entry, 'once')"
              @permission-always="(entry: PromptEntry) => replyPermission(entry, 'always')"
              @permission-deny="
                (entry: PromptEntry, message: string) => replyPermission(entry, 'reject', message)
              "
              @open-saved="chatUi.setContextOpen(true)"
            />
          </template>
          <template #composer>
            <ChatComposer
              ref="composerRef"
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
              :command-active="
                paletteOpen || parseComposerCommand(composerDraft).kind === 'command'
              "
              :placeholder="`Message ${appKey}`"
              @update:draft="composerHandleInput"
              @send="submitComposer"
              @stop="composerStop"
              @check-unknown="composerCheckAgain"
              @remove-unknown="composerRemoveUnknown"
              @retry-pending="composerRetryPending"
              @dismiss-pending="composerDismissPending"
              @restore-pending="composerRestorePending"
              @attach-files="composerAddFiles"
              @open-commands="openCommands"
              @escape="
                closeCommands();
                chatUi.setQueueOpen(false);
                chatUi.setSessionsOpen(false);
                chatUi.setContextOpen(false);
              "
            >
              <template #attachments>
                <ChatAttachments
                  :attachments="composerAttachments"
                  :quota-percent="composerAttachmentQuota"
                  :disabled="stopped || deletionPending || imageBlocked"
                  :command-active="
                    paletteOpen || parseComposerCommand(composerDraft).kind === 'command'
                  "
                  @add-files="composerAddFiles"
                  @retry="composerRetryAttachment"
                  @remove="composerRemoveAttachment"
                  @cancel="composerCancelUpload"
                  @mode="composerSetAttachmentMode"
                />
              </template>
            </ChatComposer>
          </template>
        </ChatThread>
      </div>

      <ChatContextRail
        v-if="view !== undefined"
        :view="view"
        :session-id="routeState.session.value"
        :snapshot="contextStore.snapshot"
        :todos="contextStore.todos"
        :todos-truncated="contextStore.todosTruncated"
        :previews="previewsView"
        :saved-permissions="promptsStore.savedPermissions"
        :policy-warnings="chatUi.policyWarnings"
        :compact-busy="compactBusy"
        :compact-error="compactError"
        :deletion-pending="deletionPending"
        @close="chatUi.setContextOpen(false)"
        @compact="compactSession"
        @restart="restartAgent"
        @close-preview="closePreview"
        @revoke-saved="revokeSavedPermission"
        @dismiss-policy="chatUi.dismissPolicyWarning"
      />

      <ChatCommandPalette
        :open="paletteOpen"
        :filter="paletteFilter"
        :commands="commandEntries"
        :status="commandStatus"
        :warning="commandWarning"
        :shadowed="commandShadowed"
        :confirm="commandConfirm"
        :master="view?.app.master === true"
        @select="selectCommand"
        @close="closeCommands"
        @confirm-result="resolveCommandConfirm"
      />
      <ChatQueueDialog
        :open="chatUi.queueOpen"
        :rows="queueRows"
        @close="chatUi.setQueueOpen(false)"
      />
      <ChatScrim :open="chatUi.sessionsOpen" @close="chatUi.setSessionsOpen(false)" />
    </section>
  </div>
</template>
