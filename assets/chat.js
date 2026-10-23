import {
  applySnapshot,
  autoCompactText,
  classifyOmo,
  contextChipLabel,
  contextDetail,
  contextErrorText,
  contextMeterPercent,
  contextStateClass,
  contextSummary,
  deriveQueue,
  rekeyOptimistic,
  resolveActiveStatusLabel,
  runtimeChip as runtimeChipSpec,
  toolStatusChip as toolStatusChipSpec,
} from "./chat-core.js";
import {
  commandBlockedByPending,
  commandLine,
  filterCommands,
  groupCommands,
  hanseFallbackEntries,
  parseComposerCommand,
  resolveComposerCommand,
  shellRequiresConfirmation,
} from "./chat-commands.js";
import {
  allocateView,
  extractToolView,
  patchPartView,
  truncationNotice as buildTruncationNotice,
} from "./chat-diff.js";
import {
  mountToolView,
  resetHighlightController,
  setToolViewOpen,
} from "./chat-highlight.js";
import { element, renderMarkdown } from "./markdown.js";

const UNKNOWN_ACCEPTANCE_GRACE_MS = 5000;
const HYDRATION_BUFFER_EVENTS = 200;
const HYDRATION_BUFFER_BYTES = 256 * 1024;
const MARKDOWN_THROTTLE_MS = 50;
const TOOL_OUTPUT_THROTTLE_MS = 100;
const IDLE_RECONCILE_MS = 200;
const RECONCILE_MS = 500;
const OMO_CLASSIFY_QUIET_MS = 100;
const OMO_DETAILS_CHAR_LIMIT = 600;
const OMO_DETAILS_LINE_LIMIT = 8;
const MESSAGES_PAGE_SIZE = 30;
const HISTORY_SCROLL_THRESHOLD_PX = 120;
const HISTORY_MAX_CONTINUE_PAGES = 3;
const RUNTIME_POLL_MS = 10000;
const RUNTIME_UNAVAILABLE_TITLE = "Runtime status unavailable";
const CONTEXT_POLL_MS = 2000;
const CONTEXT_POLL_MAX_MS = 10 * 60 * 1000;
const CONTEXT_COMPACT_GRACE_MS = 5000;
const COMMANDS_CACHE_MS = 30000;
const PALETTE_RENDER_LIMIT = 200;
const SHELL_CONFIRM_BODY =
  "This command contains shell blocks, or its shell usage cannot be verified, and it runs on the server outside the agent permission flow.";

const KNOWN_PART_TYPES = new Set([
  "text",
  "reasoning",
  "tool",
  "step-start",
  "step-finish",
  "patch",
  "file",
  "subtask",
  "retry",
  "compaction",
  "snapshot",
  "agent",
]);
const HIDDEN_PART_TYPES = new Set([
  "step-start",
  "step-finish",
  "retry",
  "compaction",
  "snapshot",
  "agent",
]);

function main() {
  const shell = document.getElementById("chat-shell");
  if (shell === null) {
    return;
  }

  const appKey = shell.dataset.appKey || "";
  const projectId = shell.dataset.projectId || "";
  const appInitials = shell.dataset.appInitials || "AP";
  const operatorInitials = shell.dataset.operatorInitials || "OP";
  const sessionsList = document.getElementById("session-list");
  const sessionSearch = document.getElementById("session-search");
  const sessionError = document.getElementById("session-error");
  const messagesEl = document.getElementById("chat-messages");
  const scrollEl = document.getElementById("chat-scroll");
  const historyEl = document.getElementById("chat-history");
  const historyLabelEl = document.getElementById("chat-history-label");
  const generatingEl = document.getElementById("chat-generating");
  const generatingLabelEl = document.getElementById("chat-generating-label");
  const generatingElapsedEl = document.getElementById("chat-generating-elapsed");
  const composer = document.getElementById("chat-composer");
  const promptEl = document.getElementById("chat-prompt");
  const sendButton = document.getElementById("chat-send");
  const sendError = document.getElementById("chat-send-error");
  const liveEl = document.getElementById("chat-live");
  const countEl = document.getElementById("chat-message-count");
  const workingEl = document.getElementById("chat-working");
  const workingLabelEl = document.getElementById("chat-working-label");
  const workingElapsedEl = document.getElementById("chat-working-elapsed");
  const workingQueuedEl = document.getElementById("chat-working-queued");
  const streamRetry = document.getElementById("chat-stream-retry");
  const newMessages = document.getElementById("chat-new-messages");
  const appSelect = document.getElementById("chat-app-select");
  const sessionTitleEl = document.getElementById("chat-session-title");
  const sessionIdEl = document.getElementById("chat-session-id");
  const runtimeEl = document.getElementById("chat-runtime");
  const contextRuntimeEl = document.getElementById("chat-context-runtime");
  const contextChip = document.getElementById("chat-context-chip");
  const contextChipLabelEl = document.getElementById("chat-context-chip-label");
  const contextChipExactEl = document.getElementById("chat-context-chip-exact");
  const contextChipMeter =
    contextChip === null ? null : contextChip.querySelector(".chat-context-chip__meter");
  const contextChipFill =
    contextChip === null ? null : contextChip.querySelector(".chat-context-chip__fill");
  const contextUsage = document.getElementById("chat-context-usage");
  const contextSummaryEl = document.getElementById("chat-context-summary");
  const contextMeter = document.getElementById("chat-context-meter");
  const contextMeterFill = document.getElementById("chat-context-meter-fill");
  const contextDetailEl = document.getElementById("chat-context-detail");
  const contextAutoEl = document.getElementById("chat-context-auto");
  const contextSettingsEl = document.getElementById("chat-context-settings");
  const contextCompactButton = document.getElementById("chat-context-compact");
  const contextCompactReason = document.getElementById("chat-context-compact-reason");
  const contextConfirm = document.getElementById("chat-context-confirm");
  const contextConfirmCompact = document.getElementById("chat-context-confirm-compact");
  const contextConfirmCancel = document.getElementById("chat-context-confirm-cancel");
  const contextErrorEl = document.getElementById("chat-context-error");
  const runtimeUrl = shell.dataset.runtimeUrl || "";
  const ideUrl = shell.dataset.ideUrl || "";
  const appPageUrl = shell.dataset.appUrl || "";
  const isMaster = shell.dataset.master === "1";
  const contextClose = document.querySelector("[data-chat-context-close]");
  const sessionsClose = document.querySelector("[data-chat-sessions-close]");
  const contextToggles = Array.from(
    document.querySelectorAll("[data-chat-context-toggle]"),
  );
  const sessionsToggles = Array.from(
    document.querySelectorAll("[data-chat-sessions-toggle]"),
  );
  const scrim = document.querySelector("[data-chat-scrim]");
  const promptDock = document.getElementById("chat-prompt-dock");
  const questionPlaceholderEl = document.getElementById("chat-question-placeholder");
  const policyWarning = document.getElementById("chat-policy-warning");
  const policyChip = document.getElementById("chat-policy-chip");
  const policyChipLabel = document.getElementById("chat-policy-chip-label");
  const inputNeeded = document.getElementById("chat-input-needed");
  const inputNeededCount = document.getElementById("chat-input-needed-count");
  const queueEl = document.getElementById("chat-queue");
  const queueList = document.getElementById("chat-queue-list");
  const queueClose = document.querySelector("[data-chat-queue-close]");
  const commandPalette = document.getElementById("chat-command-palette");
  const commandListbox = document.getElementById("chat-command-listbox");
  const commandStatusEl = document.getElementById("chat-command-status");
  const commandShadowEl = document.getElementById("chat-command-shadow");
  const commandsButton = document.getElementById("chat-commands-button");
  const commandConfirm = document.getElementById("chat-command-confirm");
  const commandConfirmTitle = document.getElementById("chat-command-confirm-title");
  const commandConfirmBody = document.getElementById("chat-command-confirm-body");
  const commandConfirmAccept = document.getElementById("chat-command-confirm-accept");
  const commandConfirmCancel = document.getElementById("chat-command-confirm-cancel");
  const announcer = document.getElementById("chat-announcer");
  const planList = document.getElementById("chat-plan-list");
  const planEmpty = document.getElementById("chat-plan-empty");
  const planSummary = document.getElementById("chat-plan-summary");
  const planChip = document.getElementById("chat-plan-chip");
  const planChipLabel = document.getElementById("chat-plan-chip-label");
  const planSection = document.getElementById("chat-plan-section");
  const planHeading = document.getElementById("context-plan-title");
  const savedSection = document.getElementById("chat-saved-section");
  const savedList = document.getElementById("chat-saved-list");
  const savedBadge = document.getElementById("chat-saved-badge");
  const waitingEl = document.getElementById("chat-waiting");
  const composerHintText = document.getElementById("chat-composer-hint-text");
  const queueStrip = document.getElementById("chat-queue-strip");
  const queueStripCount = document.getElementById("chat-queue-strip-count");
  const queueStripList = document.getElementById("chat-queue-strip-list");
  const sessionNotice = document.getElementById("chat-session-notice");
  const sendRecovery = document.getElementById("chat-send-recovery");
  const sendRecoveryText = document.getElementById("chat-send-recovery-text");
  const sendCheck = document.getElementById("chat-send-check");
  const sendRemove = document.getElementById("chat-send-remove");

  let sessions = [];
  let sessionId = null;
  let eventSource = null;
  let failures = 0;
  let creatingSession = false;
  const deletingSessions = new Set();
  let queueStripSignature = "";
  let sessionSnapshotTooLarge = false;
  let historyCursor = null;
  let historyLoaded = false;
  let historyRequestSeq = 0;
  let historyRequest = null;
  let prependPending = false;
  let historyScrollFrame = null;

  let store = createThreadStore(null);
  const sessionRuntime = new Map();
  const acceptanceBySession = new Map();
  let messageNodes = new Map();
  let partNodes = new Map();
  const partOwner = new Map();
  const partRenderState = new Map();
  const omoClassifyTimers = new Map();
  const omoCardState = new WeakMap();
  let dirtyMessages = new Set();
  let dirtyParts = new Set();
  let orderDirty = false;
  let flushHandle = null;
  let flushTimer = null;
  let flushPending = false;
  let forceFinalRender = false;
  let lastRenderedCount = 0;
  let hydrationSeq = 0;
  let hydrating = false;
  let hydrationBuffer = null;
  let reconcileTimer = null;
  let idleReconcileTimer = null;
  let followUpHydration = false;
  let sessionsSignature = "";
  let sessionsFailed = false;
  let sessionsLoaded = false;
  let runtimeState = null;
  let runtimeTimer = null;
  const contextBySession = new Map();
  const contextSeqBySession = new Map();
  let contextEpoch = 0;
  let contextPollTimer = null;
  let contextPollSession = null;
  let contextPollStartedAt = 0;
  let contextPollGraceUntil = 0;
  let contextRetryTimer = null;
  let contextCompactingSession = null;
  let contextPosting = false;
  let contextClientError = null;
  let elapsedAccumulated = 0;
  let elapsedStartedAt = null;
  let elapsedTimer = null;
  let elapsedText = "";
  let elapsedPromptID = null;
  const promptActivation = new Map();
  let workingLabel = "";

  const prompts = new Map();
  const promptDrafts = new Map();
  const promptSeen = new Map();
  const tombstones = new Map();
  const promptBusy = new Set();
  const promptErrors = new Map();
  const promptOutcomes = new Map();
  const correlationQuestionKeys = new Map();
  const inlineUnavailable = new Set();
  const deferredUnavailable = new Set();
  const omittedPartIDs = new Set();
  let inlineCards = new Map();
  let inlineCardByPart = new Map();
  let messagesHydratedSession = null;
  let promptEventSeq = 0;
  const promptEventLog = [];
  let promptHydrationSeq = 0;
  let promptHydrationRetried = false;
  let dockRequestKey = null;
  let dockCollapsed = false;
  let hasStreamReady = false;
  let promptStale = false;
  let announceTimer = null;

  let commands = [];
  let commandsStatus = "idle";
  let commandsFetchedAt = 0;
  let commandsSources = { hanse: "ok", opencode: "ok" };
  let commandsWarnings = [];
  let commandsShadowed = [];
  let commandsRequest = null;
  let commandsDispatching = false;
  let paletteOpen = false;
  let paletteFilter = "";
  let paletteActive = 0;
  let paletteRows = [];

  const todoCache = new Map();
  const todoEventSeq = new Map();
  let todoFetchSeq = 0;
  let todoState = "idle";
  let planProgress = { completed: 0, total: 0 };
  let lastPlanSummary = "";

  let savedPermissions = [];
  let savedHydrated = false;
  let savedBadgeTimer = null;

  let policyWarnings = [];
  const dismissedWarnings = new Set();

  function iconNode(name, className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", className === undefined ? "icon" : `icon ${className}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function createThreadStore(id) {
    return {
      sessionID: id,
      generation: 0,
      turnGeneration: 0,
      order: [],
      messages: new Map(),
      activePromptID: null,
      queue: [],
      openParts: new Set(),
      lastSeqByStream: new Map(),
      currentStreamID: null,
      pendingDeltas: new Map(),
      agentStatus: null,
    };
  }

  function acceptanceFor(id) {
    let state = acceptanceBySession.get(id);
    if (state === undefined) {
      state = {
        chain: Promise.resolve(),
        inFlight: false,
        posting: false,
        state: "idle",
        sessionID: null,
        tempID: null,
        serverID: null,
        text: "",
        knownUserIDs: new Set(),
        bufferedEvents: [],
        absenceSince: null,
        graceTimer: null,
        exposeRecovery: false,
        commandAccepted: false,
      };
      acceptanceBySession.set(id, state);
    }
    return state;
  }

  function activeAcceptance() {
    return acceptanceFor(sessionId === null ? "draft" : sessionId);
  }

  function acceptanceInFlight() {
    const state = activeAcceptance();
    return state !== null && state.inFlight === true;
  }

  function acceptancePosting() {
    const state = activeAcceptance();
    return state !== null && state.posting === true;
  }

  function acceptanceUnknown() {
    const state = activeAcceptance();
    return state !== null && state.state === "unknown";
  }

  function clearAcceptanceGrace(state) {
    state.absenceSince = null;
    state.exposeRecovery = false;
    if (state.graceTimer !== null) window.clearTimeout(state.graceTimer);
    state.graceTimer = null;
    renderSendRecovery();
  }

  function resolveAcceptance(state) {
    state.state = "accepted";
    state.inFlight = false;
    state.posting = false;
    state.tempID = null;
    state.commandAccepted = false;
    clearAcceptanceGrace(state);
    if (state.serverID !== null) {
      const record = store.messages.get(state.serverID);
      if (record !== undefined) {
        record.optimistic = undefined;
        delete record.optimistic;
        record.version += 1;
      }
    }
    recomputeQueue();
    syncComposer();
    renderSendRecovery();
    scheduleFlush();
  }

  function startAcceptanceGrace(state) {
    if (state.absenceSince !== null) return;
    state.absenceSince = Date.now();
    state.exposeRecovery = false;
    state.graceTimer = window.setTimeout(() => {
      state.graceTimer = null;
      if (state.state !== "unknown") return;
      state.exposeRecovery = true;
      renderSendRecovery();
    }, UNKNOWN_ACCEPTANCE_GRACE_MS);
  }

  function bufferPre202(event) {
    const state = activeAcceptance();
    if (state === null || state.serverID !== null || state.state !== "sending") return false;
    if (
      event !== null &&
      typeof event === "object" &&
      event.type === "message.updated" &&
      event.role !== undefined &&
      event.role !== "user"
    ) {
      return false;
    }
    state.bufferedEvents.push(event);
    if (state.bufferedEvents.length > HYDRATION_BUFFER_EVENTS) state.bufferedEvents.shift();
    return true;
  }

  function matchingUserMessage(state) {
    if (state.text.length === 0) return null;
    let matched = null;
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined || record.role !== "user") continue;
      if (state.knownUserIDs.has(id)) continue;
      if (record.optimistic === "sending" || record.optimistic === "unknown") continue;
      for (const partID of record.partOrder) {
        const part = record.parts.get(partID);
        if (part === undefined || part.type !== "text" || partIgnored(part)) continue;
        if (partTextValue(part).trim() === state.text) {
          matched = id;
          break;
        }
      }
      if (matched !== null) break;
    }
    return matched;
  }

  function resolveUnknownFromSnapshot(snapshotIDs) {
    const state = activeAcceptance();
    if (state === null) return;
    if (state.state === "accepted" && state.commandAccepted === true) {
      const present =
        state.serverID !== null &&
        (snapshotIDs instanceof Set
          ? snapshotIDs.has(state.serverID)
          : store.messages.has(state.serverID));
      state.commandAccepted = false;
      if (present) return;
      state.state = "unknown";
      startAcceptanceGrace(state);
      syncComposer();
      renderSendRecovery();
      scheduleFlush();
      return;
    }
    if (state.state !== "unknown") return;
    if (state.serverID !== null) {
      const present =
        snapshotIDs instanceof Set ? snapshotIDs.has(state.serverID) : store.messages.has(state.serverID);
      if (present) resolveAcceptance(state);
      else startAcceptanceGrace(state);
      return;
    }
    const matched = matchingUserMessage(state);
    if (matched === null) {
      startAcceptanceGrace(state);
      return;
    }
    const tempID = state.tempID;
    state.serverID = matched;
    if (tempID !== null && store.messages.has(tempID)) {
      rekeyAcceptanceRow(state, matched, false);
    }
    resolveAcceptance(state);
  }

  async function checkUnknownAcceptance(id) {
    const state = acceptanceBySession.get(id);
    if (state === undefined || state.state !== "unknown") return;
    state.exposeRecovery = false;
    state.absenceSince = null;
    if (state.graceTimer !== null) {
      window.clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
    renderSendRecovery();
    await hydrateMessages({ reason: "unknown-check", silent: true });
  }

  function removeUnknownAcceptance(id) {
    const state = acceptanceBySession.get(id);
    if (state === undefined || state.state !== "unknown") return;
    const target = state.serverID !== null ? state.serverID : state.tempID;
    if (target !== null) removeStoredMessage(target);
    state.state = "idle";
    state.inFlight = false;
    state.posting = false;
    state.tempID = null;
    state.serverID = null;
    clearAcceptanceGrace(state);
    recomputeQueue();
    syncComposer();
    renderSendRecovery();
    scheduleFlush();
  }

  function currentStatusType() {
    const status = store.agentStatus;
    if (status === null || typeof status !== "object") return undefined;
    if (typeof status.type === "string") return status.type;
    if (status.status && typeof status.status.type === "string") return status.status.type;
    return undefined;
  }

  function lastAssistantRecord() {
    for (let index = store.order.length - 1; index >= 0; index -= 1) {
      const record = store.messages.get(store.order[index]);
      if (record !== undefined && record.role === "assistant") return record;
    }
    return null;
  }

  function partTextValue(part) {
    if (part === undefined || part === null) return "";
    const data = part.data && typeof part.data === "object" ? part.data : part;
    return typeof data.text === "string" ? data.text : "";
  }

  function partIgnored(part) {
    if (part === undefined || part === null) return false;
    const data = part.data && typeof part.data === "object" ? part.data : part;
    return data.ignored === true;
  }

  function findRunningTool() {
    for (let index = store.order.length - 1; index >= 0; index -= 1) {
      const record = store.messages.get(store.order[index]);
      if (record === undefined || record.role !== "assistant") continue;
      for (let partIndex = record.partOrder.length - 1; partIndex >= 0; partIndex -= 1) {
        const part = record.parts.get(record.partOrder[partIndex]);
        if (part === undefined || part.type !== "tool") continue;
        const data = part.data && typeof part.data === "object" ? part.data : part;
        const status = data.state && typeof data.state === "object" ? data.state : {};
        if (status.status === "running") return data;
      }
    }
    return null;
  }

  function lastAssistantHasUnsealed(type) {
    const record = lastAssistantRecord();
    if (record === null) return false;
    for (const partID of record.partOrder) {
      const part = record.parts.get(partID);
      if (part === undefined || part.type !== type || part.sealed === true) continue;
      if (partTextValue(part).trim().length > 0) return true;
    }
    return false;
  }

  function humanizeTool(tool) {
    const map = {
      bash: "bash",
      edit: "edit",
      write: "write",
      read: "read",
      grep: "grep",
      glob: "glob",
      webfetch: "fetch",
      websearch: "search",
      task: "task",
      todowrite: "plan",
      question: "question",
      patch: "patch",
    };
    const name = typeof tool === "string" && tool.length > 0 ? tool : "tool";
    return map[name] || name;
  }

  function firstAssistantForPrompt(promptID) {
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record !== undefined && record.role === "assistant" && record.parentID === promptID) {
        return record;
      }
    }
    return null;
  }

  function operatorPromptRecord() {
    const activeID = store.activePromptID;
    if (typeof activeID === "string") {
      const record = store.messages.get(activeID);
      if (
        record !== undefined &&
        record.role === "user" &&
        record.system == null &&
        record.optimistic !== "queued"
      ) {
        return record;
      }
    }
    for (let index = store.order.length - 1; index >= 0; index -= 1) {
      const record = store.messages.get(store.order[index]);
      if (record === undefined || record.role !== "assistant") continue;
      if (record.time?.completed != null && record.finish !== "tool-calls") return null;
      if (typeof record.parentID === "string") {
        const parent = store.messages.get(record.parentID);
        if (
          parent !== undefined &&
          parent.role === "user" &&
          parent.system == null &&
          parent.optimistic !== "queued"
        ) {
          return parent;
        }
      }
    }
    return null;
  }

  function notePromptActivation() {
    const prompt = operatorPromptRecord();
    if (prompt === null || promptActivation.has(prompt.id)) return;
    promptActivation.set(prompt.id, Date.now());
  }

  function statusSeedTime(prompt) {
    if (prompt === null) return null;
    const activated = promptActivation.get(prompt.id);
    if (typeof activated === "number") return activated;
    const assistant = firstAssistantForPrompt(prompt.id);
    const created = assistant?.time?.created;
    if (typeof created !== "number") return null;
    return created < 1_000_000_000_000 ? created * 1000 : created;
  }

  function activeStatusLabel() {
    const type = currentStatusType();
    const runningTool = findRunningTool();
    const turnActive =
      type === "busy" ||
      type === "retry" ||
      store.queue.length > 0 ||
      store.activePromptID !== null;
    return resolveActiveStatusLabel({
      waiting: activePromptEntries().length > 0,
      sending: acceptancePosting(),
      paused: liveEl !== null && liveEl.dataset.state === "paused" && turnActive,
      statusType: type,
      runningTool: runningTool === null ? null : humanizeTool(runningTool.tool),
      unsealedReasoning: lastAssistantHasUnsealed("reasoning"),
      unsealedText: lastAssistantHasUnsealed("text"),
      queueLength: store.queue.length,
      activePromptID: store.activePromptID,
    });
  }

  function queueSuffixAllowed(label) {
    return (
      label === "Thinking" ||
      label === "Working" ||
      label === "Retrying" ||
      label === "Ready" ||
      label.startsWith("Running ")
    );
  }

  function elapsedMs() {
    return elapsedAccumulated + (elapsedStartedAt === null ? 0 : Date.now() - elapsedStartedAt);
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 1) return "";
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }

  function renderElapsed() {
    const text = elapsedText;
    for (const target of [workingElapsedEl, generatingElapsedEl]) {
      if (target === null) continue;
      target.hidden = text.length === 0;
      if (target.textContent !== text) target.textContent = text;
    }
  }

  function tickElapsed() {
    elapsedText = elapsedStartedAt === null && elapsedAccumulated <= 0
      ? ""
      : formatElapsed(elapsedMs());
    renderElapsed();
  }

  function ensureElapsedTimer() {
    if (elapsedTimer !== null) return;
    elapsedTimer = window.setInterval(tickElapsed, 1000);
  }

  function resetElapsed() {
    elapsedAccumulated = 0;
    elapsedStartedAt = null;
    elapsedText = "";
    elapsedPromptID = null;
    if (elapsedTimer !== null) {
      window.clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    renderElapsed();
  }

  function startElapsed() {
    if (elapsedStartedAt !== null) return;
    const prompt = operatorPromptRecord();
    elapsedPromptID = prompt === null ? null : prompt.id;
    const seed = statusSeedTime(prompt);
    elapsedStartedAt = seed === null ? Date.now() : seed;
    ensureElapsedTimer();
    tickElapsed();
  }

  function freezeElapsed() {
    if (elapsedStartedAt === null) return;
    elapsedAccumulated += Date.now() - elapsedStartedAt;
    elapsedStartedAt = null;
    tickElapsed();
  }

  function resumeElapsed() {
    if (elapsedStartedAt !== null) return;
    elapsedStartedAt = Date.now();
    ensureElapsedTimer();
  }

  function updateWorkingStatus() {
    const label = activeStatusLabel();
    const waiting = label === "Waiting for you";
    const paused = label === "Paused";
    const active = !waiting && !paused && label !== "Ready";
    const prompt = operatorPromptRecord();
    const promptID = prompt === null ? null : prompt.id;
    if (active && promptID !== null && promptID !== elapsedPromptID) resetElapsed();
    if (waiting || paused) freezeElapsed();
    else if (label === "Ready") resetElapsed();
    else if (label === "Retrying" || label.startsWith("Running ") || label === "Thinking" || label === "Working") {
      if (elapsedStartedAt === null) {
        if (elapsedAccumulated > 0) resumeElapsed();
        else startElapsed();
      }
    }
    if (generatingEl !== null) generatingEl.hidden = !active;
    if (generatingLabelEl !== null && generatingLabelEl.textContent !== label) {
      generatingLabelEl.textContent = label;
    }
    if (workingEl === null) return;
    if (waiting) {
      workingEl.hidden = true;
    } else {
      workingEl.hidden = false;
      const spinner = workingEl.querySelector("[data-chat-working-spinner]");
      if (spinner !== null) spinner.hidden = label === "Ready" || paused;
      if (workingLabelEl !== null && workingLabel !== label) {
        workingLabel = label;
        workingLabelEl.textContent = label;
      }
      if (workingQueuedEl !== null) {
        const suffix = store.queue.length > 0 && queueSuffixAllowed(label)
          ? `· ${store.queue.length} queued`
          : "";
        workingQueuedEl.hidden = suffix.length === 0;
        if (workingQueuedEl.textContent !== suffix) workingQueuedEl.textContent = suffix;
      }
    }
  }

  function sessionStatusType() {
    return currentStatusType();
  }

  function recomputeQueue() {
    const derived = deriveQueue(store, { sessionStatusType: sessionStatusType() });
    store.queue = [...derived.queuedIDs];
    store.activePromptID = derived.nextActivePromptID;
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined || record.optimistic === undefined) continue;
      if (record.optimistic === "sending" || record.optimistic === "unknown") continue;
      if (record.optimistic === "failed") continue;
      const wasQueued = record.optimistic === "queued";
      if (id === derived.activeID) {
        if (wasQueued) promptActivation.set(id, Date.now());
        record.optimistic = "accepted";
      } else if (derived.queuedIDs.includes(id)) record.optimistic = "queued";
      else record.optimistic = "accepted";
    }
    updateWorkingStatus();
    renderQueueStrip();
  }

  function queueQueueState(record) {
    if (record.optimistic === "sending") return "Sending…";
    if (record.optimistic === "unknown") return "Delivery unknown";
    return "Queued";
  }

  function queuePreview(record) {
    for (const partID of record.partOrder) {
      const part = record.parts.get(partID);
      if (part === undefined || part.type !== "text" || partIgnored(part)) continue;
      const text = partTextValue(part);
      const firstLine = text.split("\n")[0].trim();
      if (firstLine.length === 0) continue;
      return {
        preview: firstLine.replace(/\s+/g, " ").slice(0, 120),
        title: firstLine,
      };
    }
    return { preview: "Queued message", title: "Queued message" };
  }

  function renderQueueStrip() {
    if (queueStrip === null || queueStripList === null) return;
    const ids = store.queue.filter((id) => store.messages.has(id));
    const signature = JSON.stringify(
      ids.map((id) => {
        const record = store.messages.get(id);
        const preview = queuePreview(record);
        return [id, preview.preview, queueQueueState(record)];
      }),
    );
    const count = ids.length;
    queueStrip.hidden = count === 0;
    if (queueStripCount !== null) {
      const text =
        count === 0 ? "" : `${count} ${count === 1 ? "message" : "messages"} queued`;
      if (queueStripCount.textContent !== text) queueStripCount.textContent = text;
    }
    if (signature === queueStripSignature) return;
    queueStripSignature = signature;
    if (count === 0) {
      queueStripList.replaceChildren();
      return;
    }
    const rows = [];
    for (const id of ids.slice(0, 3)) {
      const record = store.messages.get(id);
      const preview = queuePreview(record);
      const item = element("li", "chat-queue-strip__item");
      const previewEl = element("span", "chat-queue-strip__preview", preview.preview);
      previewEl.title = preview.title;
      item.append(previewEl, element("span", "chat-queue-strip__state", queueQueueState(record)));
      rows.push(item);
    }
    if (count > 3) {
      rows.push(element("li", "chat-queue-strip__more", `+${count - 3} more`));
    }
    queueStripList.replaceChildren(...rows);
  }

  function apiBase() {
    return `/api/apps/${encodeURIComponent(appKey)}`;
  }

  function withProject(url) {
    return projectId.length === 0 ? url : `${url}?project=${encodeURIComponent(projectId)}`;
  }

  function sessionsUrl() {
    return withProject(`${apiBase()}/sessions`);
  }

  function sessionUrl(id) {
    return withProject(`${apiBase()}/sessions/${encodeURIComponent(id)}`);
  }

  function messagesUrl(id, options) {
    const session = id === undefined ? sessionId : id;
    const settings = options || {};
    const params = new URLSearchParams();
    if (projectId.length > 0) params.set("project", projectId);
    if (settings.limit !== undefined) params.set("limit", String(settings.limit));
    if (settings.before !== undefined && settings.before !== null) {
      params.set("before", settings.before);
    }
    const query = params.toString();
    const base = `${apiBase()}/sessions/${encodeURIComponent(session || "")}/messages`;
    return query.length === 0 ? base : `${base}?${query}`;
  }

  function asyncMessagesUrl(id) {
    const url = messagesUrl(id);
    return `${url}${url.includes("?") ? "&" : "?"}async=1`;
  }

  function eventsUrl() {
    return withProject(`${apiBase()}/events`);
  }

  function promptsUrl() {
    return withProject(`${apiBase()}/prompts`);
  }

  function todoUrl(id) {
    return withProject(`${apiBase()}/sessions/${encodeURIComponent(id)}/todo`);
  }

  function contextUrl(id) {
    return withProject(`${apiBase()}/sessions/${encodeURIComponent(id)}/context`);
  }

  function compactUrl(id) {
    return withProject(`${apiBase()}/sessions/${encodeURIComponent(id)}/compact`);
  }

  function savedPermissionsUrl() {
    return withProject(`${apiBase()}/permissions/saved`);
  }

  function savedPermissionUrl(id) {
    return withProject(`${apiBase()}/permissions/saved/${encodeURIComponent(id)}`);
  }

  function questionReplyUrl(id) {
    return withProject(`${apiBase()}/questions/${encodeURIComponent(id)}/reply`);
  }

  function questionRejectUrl(id) {
    return withProject(`${apiBase()}/questions/${encodeURIComponent(id)}/reject`);
  }

  function permissionReplyUrl(id) {
    return withProject(`${apiBase()}/permissions/${encodeURIComponent(id)}/reply`);
  }

  async function api(url, options) {
    const response = await fetch(url, { cache: "no-store", ...(options || {}) });
    if (!response.ok) {
      const raw = await response.text();
      let message = raw;
      let code;
      let parsed;
      try {
        parsed = JSON.parse(raw);
        if (parsed && typeof parsed.error === "string") {
          message = parsed.error;
        }
        if (parsed && typeof parsed.code === "string") {
          code = parsed.code;
        }
      } catch (error) {
        void error;
      }
      const failure = new Error(
        message.slice(0, 400) || `Request failed (${response.status})`,
      );
      failure.status = response.status;
      failure.code = code;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.outcome === "string") failure.outcome = parsed.outcome;
        if (typeof parsed.messageID === "string") failure.messageID = parsed.messageID;
        if (typeof parsed.sessionID === "string") failure.sessionID = parsed.sessionID;
      }
      throw failure;
    }
    return response.json();
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
  }

  function messageCountLabel(count) {
    if (historyCursor === null) return plural(count, "message");
    return `${count}+ ${count === 1 ? "message" : "messages"}`;
  }

  function relativeTime(value) {
    if (value === undefined || value === null) {
      return "";
    }
    let date = new Date(value);
    if (typeof value === "number" && value < 1_000_000_000_000) {
      date = new Date(value * 1000);
    }
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }

  function sessionTimestamp(session) {
    const time = session.time;
    if (time && typeof time === "object") {
      if (typeof time.updated === "number") return time.updated;
      if (typeof time.created === "number") return time.created;
    }
    if (typeof session.updatedAt === "string" || typeof session.updatedAt === "number") {
      return session.updatedAt;
    }
    if (typeof session.createdAt === "string" || typeof session.createdAt === "number") {
      return session.createdAt;
    }
    return undefined;
  }

  function sessionLabel(session) {
    return typeof session.title === "string" && session.title.trim().length > 0
      ? session.title.trim()
      : `Session ${String(session.id).slice(0, 8)}`;
  }

  function setConnection(label, state) {
    if (liveEl === null) return;
    liveEl.textContent = label;
    liveEl.dataset.state = state;
    if (streamRetry !== null) {
      streamRetry.hidden = state !== "paused";
    }
    updateWorkingStatus();
    if (sessionId !== null) refreshInlineQuestions();
  }

  function requestKey(request) {
    return `${request.source}:${request.id}`;
  }

  function validToolRef(request) {
    const tool = request && request.tool && typeof request.tool === "object" ? request.tool : null;
    if (tool === null) return false;
    return (
      typeof tool.messageID === "string" &&
      tool.messageID.length > 0 &&
      typeof tool.callID === "string" &&
      tool.callID.length > 0
    );
  }

  function questionCorrelationKey(request) {
    return `${request.source}:${request.sessionID}:${request.tool.messageID}:${request.tool.callID}`;
  }

  function isCorrelatedQuestion(entry) {
    return entry !== undefined && entry.kind === "question" && validToolRef(entry.request);
  }

  function allPendingForSession(id) {
    const items = [];
    for (const entry of prompts.values()) {
      if (entry.request.sessionID === id) items.push(entry);
    }
    return items.sort((a, b) => (promptSeen.get(a.key) || 0) - (promptSeen.get(b.key) || 0));
  }

  function dockRenderEntries(id) {
    return allPendingForSession(id).filter((entry) => !isCorrelatedQuestion(entry));
  }

  function pendingForSession(id) {
    return allPendingForSession(id);
  }

  function activePromptEntries() {
    return sessionId === null ? [] : allPendingForSession(sessionId);
  }

  function activeDockEntries() {
    return sessionId === null ? [] : dockRenderEntries(sessionId);
  }

  function otherSessionPromptCount() {
    let count = 0;
    for (const entry of prompts.values()) {
      if (entry.request.sessionID !== sessionId) count += 1;
    }
    return count;
  }

  function promptCountForSession(id) {
    let count = 0;
    for (const entry of prompts.values()) {
      if (entry.request.sessionID === id) count += 1;
    }
    return count;
  }

  function pruneTombstones() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, at] of tombstones) {
      if (at < cutoff) tombstones.delete(key);
    }
    for (const [key, outcome] of promptOutcomes) {
      if (outcome.at < cutoff) promptOutcomes.delete(key);
    }
  }

  function recordTombstone(key) {
    tombstones.set(key, Date.now());
    promptDrafts.delete(key);
    promptErrors.delete(key);
    promptBusy.delete(key);
  }

  function recordQuestionOutcome(key, outcome) {
    promptOutcomes.set(key, { at: Date.now(), ...outcome });
  }

  function questionOutcomeFor(entry) {
    if (entry === undefined) return undefined;
    return promptOutcomes.get(entry.key);
  }

  function questionKeyForCorrelation(correlationKey) {
    return correlationQuestionKeys.get(correlationKey);
  }

  function announce(message) {
    if (announcer === null) return;
    window.clearTimeout(announceTimer);
    announcer.textContent = "";
    announceTimer = window.setTimeout(() => {
      announcer.textContent = message;
    }, 300);
  }

  function showToast(message, tone) {
    const region = document.getElementById("toast-region");
    if (region === null) {
      announce(message);
      return;
    }
    const toast = element("div", "toast");
    toast.dataset.tone = tone;
    toast.setAttribute("role", tone === "error" ? "alert" : "status");
    const icon = element("span", "toast__icon");
    icon.append(iconNode(tone === "error" ? "alert-triangle" : "check"));
    const copy = element("div", "toast__copy");
    copy.append(element("strong", "", message));
    const close = element("button", "btn btn-ghost btn-icon btn-sm");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.append(iconNode("x"));
    close.addEventListener("click", () => toast.remove());
    toast.append(icon, copy, close);
    region.append(toast);
    window.setTimeout(() => toast.remove(), 6000);
  }

  function composerHasDraft() {
    return promptEl instanceof HTMLTextAreaElement && promptEl.value.trim().length > 0;
  }

  function syncComposer() {
    const promptsWaiting = activePromptEntries().length > 0;
    const sending = acceptanceInFlight() || acceptanceUnknown();
    if (sendButton instanceof HTMLButtonElement) {
      sendButton.disabled = sending || promptsWaiting;
    }
    if (waitingEl !== null) waitingEl.hidden = !promptsWaiting;
    updateWorkingStatus();
    if (composerHintText !== null) {
      composerHintText.textContent = promptsWaiting
        ? "Answer the request above to continue."
        : "Enter to send / Shift+Enter for a new line";
    }
    setNewSessionBusy(creatingSession);
    renderSessions();
    updateInputNeeded();
    updatePlanChip();
  }

  function renderSendRecovery() {
    if (sendRecovery === null) return;
    const state = activeAcceptance();
    const unknown = state !== null && state.state === "unknown";
    const visible = unknown && state.exposeRecovery === true;
    sendRecovery.hidden = !visible;
    if (sendCheck instanceof HTMLButtonElement) sendCheck.hidden = !visible;
    if (sendRemove instanceof HTMLButtonElement) sendRemove.hidden = !visible;
    if (sendRecoveryText !== null) {
      sendRecoveryText.textContent = unknown
        ? "Delivery unknown; checking…"
        : "";
    }
  }

  function setSessionNotice(visible) {
    if (sessionNotice === null) return;
    sessionNotice.hidden = !visible;
  }

  function setBusy(button, busy) {
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = busy;
    if (busy) {
      button.setAttribute("aria-busy", "true");
      if (button.querySelector("[data-chat-spinner]") === null) {
        const spinner = element("span", "spinner");
        spinner.dataset.chatSpinner = "true";
        spinner.setAttribute("aria-hidden", "true");
        button.prepend(spinner);
      }
    } else {
      button.removeAttribute("aria-busy");
      const spinner = button.querySelector("[data-chat-spinner]");
      if (spinner !== null) spinner.remove();
    }
  }

  function newSessionButtons() {
    return Array.from(document.querySelectorAll("[data-chat-new-session]"));
  }

  function setNewSessionBusy(busy) {
    for (const button of newSessionButtons()) {
      setBusy(button, busy);
    }
  }

  function showSessionsLoading() {
    if (sessionsList === null) return;
    sessionsFailed = false;
    sessionsLoaded = false;
    sessionsSignature = "";
    const skeleton = element("div", "skeleton-stack chat-sessions__skeleton");
    skeleton.setAttribute("aria-hidden", "true");
    skeleton.append(
      element("span", "skeleton skeleton--title"),
      element("span", "skeleton"),
      element("span", "skeleton skeleton--short"),
      element("span", "skeleton"),
    );
    sessionsList.replaceChildren(skeleton);
  }

  function showSessionsError(error, retry) {
    if (sessionsList === null) return;
    sessionsFailed = true;
    sessionsSignature = "";
    const state = element("div", "error-state chat-error");
    state.setAttribute("role", "alert");
    const mark = element("span", "error-state__mark");
    mark.append(iconNode("alert-triangle", "icon--lg"));
    state.append(mark);
    const body = element("div");
    body.append(
      element("h3", "error-state__title", "Sessions unavailable"),
      element("p", "error-state__body", error.message || String(error)),
    );
    const button = element("button", "btn btn-secondary btn-sm", "Retry");
    button.type = "button";
    button.addEventListener("click", retry);
    body.append(button);
    state.append(body);
    sessionsList.replaceChildren(state);
  }

  function showSessionsEmpty() {
    if (sessionsList === null) return;
    sessionsList.replaceChildren(
      element("p", "chat-empty", "No sessions yet. Send a message to start one."),
    );
  }

  function showSessionError(message) {
    if (sessionError === null) return;
    sessionError.hidden = message === null;
    sessionError.textContent = message === null ? "" : message;
  }

  function sessionsSignatureValue() {
    const needle = (sessionSearch === null ? "" : sessionSearch.value).trim().toLowerCase();
    return JSON.stringify({
      sessionId,
      needle,
      sessions: sessions.map((session) => {
        const id = String(session.id);
        return [id, sessionLabel(session), promptCountForSession(id)];
      }),
      runtime: runtimeState,
      deleting: [...deletingSessions].sort(),
      creating: creatingSession,
    });
  }

  function renderSessions() {
    if (sessionsList === null || sessionsFailed || !sessionsLoaded) return;
    const signature = sessionsSignatureValue();
    if (signature === sessionsSignature) return;
    sessionsSignature = signature;
    const needle = (sessionSearch === null ? "" : sessionSearch.value).trim().toLowerCase();
    const visible = sessions.filter((session) => {
      if (needle.length === 0) return true;
      return (
        sessionLabel(session).toLowerCase().includes(needle) ||
        String(session.id).toLowerCase().includes(needle)
      );
    });
    if (sessions.length === 0) {
      showSessionsEmpty();
      return;
    }
    if (visible.length === 0) {
      sessionsList.replaceChildren(
        element("p", "chat-empty", "No sessions match this filter."),
      );
      return;
    }
    const list = document.createDocumentFragment();
    for (const session of visible) {
      const id = String(session.id);
      const row = element("div", "session-row");
      const button = element("button", "session-item");
      button.type = "button";
      button.dataset.sessionId = id;
      const active = session.id === sessionId;
      if (active) {
        button.classList.add("is-active");
        button.setAttribute("aria-current", "true");
      }
      const top = element("span", "session-item__top");
      top.append(element("span", "session-item__title", sessionLabel(session)));
      if (active) top.append(iconNode("check", "icon--sm"));
      const meta = element("span", "session-item__meta");
      meta.append(element("span", "mono", id.slice(0, 8)));
      const stamp = relativeTime(sessionTimestamp(session));
      if (stamp.length > 0) meta.append(element("span", "", stamp));
      const waitingCount = id === sessionId ? 0 : promptCountForSession(id);
      if (waitingCount > 0) {
        const flag = element("span", "session-item__flag");
        flag.setAttribute("aria-label", `${waitingCount} requests need input`);
        flag.append(iconNode("message", "icon--sm"), document.createTextNode(`${waitingCount} waiting`));
        meta.append(flag);
      }
      button.append(top, meta);
      button.addEventListener("click", () => {
        selectSession(id, { focus: true });
      });

      const remove = element("button", "session-delete");
      remove.type = "button";
      remove.dataset.sessionDelete = id;
      remove.title = "Delete session";
      remove.setAttribute("aria-label", `Delete ${sessionLabel(session)}`);
      remove.append(iconNode("trash", "icon--sm"));
      remove.disabled = deletingSessions.has(id);
      remove.addEventListener("click", () => {
        removeSession(id);
      });

      row.append(button, remove);
      list.append(row);
    }
    sessionsList.replaceChildren(list);
  }

  function emptyThread() {
    const state = element("div", "empty-state");
    const mark = element("span", "empty-state__mark");
    mark.append(iconNode("message", "icon--lg"));
    state.append(
      mark,
      element("h3", "empty-state__title", `Chat with ${appKey}`),
      element(
        "p",
        "empty-state__body",
        "Send the first message to start the agent. Its reply appears here, with tool calls in place.",
      ),
    );
    return state;
  }

  function showMessagesLoading() {
    if (messagesEl === null) return;
    if (newMessages !== null) newMessages.hidden = true;
    messagesEl.setAttribute("aria-busy", "true");
    const skeleton = element("div", "skeleton-stack");
    skeleton.setAttribute("aria-hidden", "true");
    skeleton.append(
      element("span", "skeleton skeleton--title"),
      element("span", "skeleton"),
      element("span", "skeleton skeleton--short"),
      element("span", "skeleton"),
    );
    messagesEl.replaceChildren(skeleton);
  }

  function showThreadError(error, retry) {
    if (messagesEl === null) return;
    resetFeedDom();
    sessionSnapshotTooLarge = false;
    setSessionNotice(false);
    messagesEl.removeAttribute("aria-busy");
    const state = element("div", "error-state chat-error");
    state.setAttribute("role", "alert");
    const mark = element("span", "error-state__mark");
    mark.append(iconNode("alert-triangle", "icon--lg"));
    const body = element("div");
    body.append(
      element("h3", "error-state__title", "Chat unavailable"),
      element("p", "error-state__body", error.message || String(error)),
    );
    const button = element("button", "btn btn-secondary btn-sm", "Retry");
    button.type = "button";
    button.addEventListener("click", retry);
    body.append(button);
    state.append(mark, body);
    messagesEl.replaceChildren(state);
    if (countEl !== null) countEl.textContent = plural(0, "message");
    if (newMessages !== null) newMessages.hidden = true;
  }

  function statusChipFrom(entry) {
    const chip = element("span", "status");
    chip.dataset.state = entry.state;
    chip.append(iconNode(entry.icon), document.createTextNode(entry.label));
    return chip;
  }

  function runtimeChip(state) {
    return statusChipFrom(runtimeChipSpec(state));
  }

  function toolStatusChip(status) {
    return statusChipFrom(toolStatusChipSpec(status));
  }

  function applyRuntimeState(state) {
    const normalized = state === "failed" ? "error" : state;
    runtimeState = normalized;
    for (const target of [runtimeEl, contextRuntimeEl]) {
      if (target === null) continue;
      target.replaceChildren(runtimeChip(normalized));
      target.removeAttribute("title");
    }
    renderSessions();
  }

  function markRuntimeUnavailable() {
    for (const target of [runtimeEl, contextRuntimeEl]) {
      if (target !== null) target.title = RUNTIME_UNAVAILABLE_TITLE;
    }
  }

  async function refreshRuntime() {
    if (runtimeUrl.length === 0) return;
    try {
      const response = await fetch(runtimeUrl, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (response.status === 401) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      if (!response.ok) throw new Error(`runtime status unavailable (${response.status})`);
      const data = await response.json();
      const state =
        data !== null && typeof data === "object" && typeof data.state === "string"
          ? data.state
          : null;
      if (state === null) throw new Error("runtime status unavailable");
      applyRuntimeState(state);
    } catch {
      markRuntimeUnavailable();
    }
  }

  function startRuntimePolling() {
    if (runtimeTimer !== null) return;
    runtimeTimer = window.setInterval(() => {
      if (document.hidden) return;
      refreshRuntime().catch(() => {});
    }, RUNTIME_POLL_MS);
  }

  function stopRuntimePolling() {
    if (runtimeTimer === null) return;
    window.clearInterval(runtimeTimer);
    runtimeTimer = null;
  }

  function syncRuntimePolling() {
    if (document.hidden) stopRuntimePolling();
    else startRuntimePolling();
  }

  function contextHasUsage(snapshot) {
    return (
      snapshot !== null &&
      typeof snapshot === "object" &&
      snapshot.state !== "unknown" &&
      Number.isFinite(snapshot.used)
    );
  }

  function contextHasModel(snapshot) {
    if (snapshot === null || typeof snapshot !== "object") return false;
    const model = snapshot.model;
    if (model === null || typeof model !== "object") return false;
    const provider = typeof model.providerID === "string" ? model.providerID.trim() : "";
    const id = typeof model.modelID === "string" ? model.modelID.trim() : "";
    return provider.length > 0 || id.length > 0;
  }

  function contextPercentValue(snapshot) {
    if (snapshot === null || typeof snapshot !== "object") return null;
    if (Number.isFinite(snapshot.percent)) return snapshot.percent;
    if (Number.isFinite(snapshot.used) && Number.isFinite(snapshot.limit) && snapshot.limit > 0) {
      return (snapshot.used / snapshot.limit) * 100;
    }
    return null;
  }

  function contextAriaValueText(snapshot) {
    const percent = contextPercentValue(snapshot);
    const detail = contextDetail(snapshot);
    if (percent !== null) {
      const rounded = Math.round(percent);
      return detail === "—" ? `${rounded}%` : `${rounded}%; ${detail}`;
    }
    return detail === "—" ? "Unknown" : detail;
  }

  function setContextMeter(meter, fill, snapshot, percent, state, visible) {
    if (meter !== null) {
      meter.hidden = !visible;
      meter.dataset.state = state;
      if (visible) {
        meter.setAttribute("aria-valuenow", String(percent));
        meter.setAttribute("aria-valuetext", contextAriaValueText(snapshot));
      } else {
        meter.setAttribute("aria-valuenow", "0");
        meter.setAttribute("aria-valuetext", "Unknown");
      }
    }
    if (fill !== null) {
      fill.dataset.state = state;
      fill.style.width = visible ? `${percent}%` : "0%";
    }
  }

  function contextScopeLabel(value) {
    if (value === "app") return "application";
    if (value === "project") return "project";
    if (value === "global") return "global";
    return "default";
  }

  function contextAutoTitle(snapshot) {
    const auto = snapshot.autoCompact;
    if (auto === null || typeof auto !== "object" || auto.enabled !== true) {
      return "Auto-compact is off.";
    }
    const source = contextScopeLabel(auto.source);
    const percentSource = contextScopeLabel(auto.percentSource);
    if (source !== percentSource) {
      return `Enabled by ${source}; threshold from ${percentSource}.`;
    }
    return `Enabled by ${source}.`;
  }

  function hideContextConfirm(returnFocus) {
    if (contextConfirm !== null) contextConfirm.hidden = true;
    if (
      returnFocus === true &&
      contextCompactButton instanceof HTMLElement &&
      !contextCompactButton.disabled
    ) {
      contextCompactButton.focus();
    }
  }

  function openContextConfirm() {
    if (contextConfirm === null) return;
    if (contextCompactButton !== null && contextCompactButton.disabled) return;
    contextConfirm.hidden = false;
    if (contextConfirmCompact instanceof HTMLElement) contextConfirmCompact.focus();
  }

  function setContextErrorText(text) {
    if (contextErrorEl === null) return;
    const message = typeof text === "string" ? text : "";
    contextErrorEl.textContent = message;
    contextErrorEl.hidden = message.length === 0;
  }

  function showContextError(message) {
    contextClientError = message;
    setContextErrorText(message);
  }

  function clearContextClientError() {
    contextClientError = null;
    setContextErrorText(null);
  }

  function contextCompactReasonFor(snapshot) {
    if (sessionId === null) return "Start a session to compact.";
    if (contextPosting) return "Compaction starting…";
    if (snapshot === null || typeof snapshot !== "object") return "Loading context…";
    if (snapshot.state === "compacting" || contextCompactingSession === sessionId) {
      return "Compaction in progress.";
    }
    if (snapshot.status === "busy") return "Wait for the agent to finish.";
    if (snapshot.status === "retry") return "Wait for the agent to retry.";
    if (!contextHasModel(snapshot)) return "No model is known for this session.";
    return null;
  }

  function renderContextCompact(snapshot) {
    const reason = contextCompactReasonFor(snapshot);
    if (contextCompactButton !== null) {
      contextCompactButton.disabled = reason !== null || contextPosting;
      contextCompactButton.dataset.state = reason === null ? "ready" : "disabled";
      if (contextPosting) contextCompactButton.setAttribute("aria-busy", "true");
      else contextCompactButton.removeAttribute("aria-busy");
    }
    if (contextCompactReason !== null) {
      const text = reason === null ? "" : reason;
      contextCompactReason.textContent = text;
      contextCompactReason.hidden = text.length === 0;
    }
    if (reason !== null) hideContextConfirm(false);
  }

  function renderContext(snapshot) {
    if (snapshot === null || typeof snapshot !== "object") return;
    if (sessionId === null) return;
    if (typeof snapshot.sessionID === "string" && snapshot.sessionID !== sessionId) return;
    const state = contextStateClass(snapshot);
    const percent = contextMeterPercent(snapshot);
    const hasUsage = contextHasUsage(snapshot);
    const detail = contextDetail(snapshot);
    if (contextChip !== null) {
      contextChip.hidden = false;
      contextChip.dataset.state = state;
      if (detail === "—") contextChip.removeAttribute("title");
      else contextChip.title = detail;
    }
    if (contextChipLabelEl !== null) contextChipLabelEl.textContent = contextChipLabel(snapshot);
    if (contextChipExactEl !== null) contextChipExactEl.textContent = detail;
    setContextMeter(contextChipMeter, contextChipFill, snapshot, percent, state, hasUsage);
    if (contextUsage !== null) {
      contextUsage.hidden = false;
      contextUsage.dataset.state = state;
    }
    if (contextSummaryEl !== null) contextSummaryEl.textContent = contextSummary(snapshot);
    if (contextDetailEl !== null) contextDetailEl.textContent = detail;
    if (contextAutoEl !== null) {
      contextAutoEl.textContent = autoCompactText(snapshot);
      contextAutoEl.title = contextAutoTitle(snapshot);
    }
    if (contextSettingsEl !== null) contextSettingsEl.title = "Configure context and auto-compaction";
    setContextMeter(contextMeter, contextMeterFill, snapshot, percent, state, hasUsage);
    renderContextCompact(snapshot);
    setContextErrorText(
      snapshot.lastError !== null && snapshot.lastError !== undefined
        ? contextErrorText(snapshot.lastError)
        : contextClientError,
    );
    syncContextPolling();
  }

  function resetContextUi(hideSection, detailText, reasonText) {
    if (contextChip !== null) {
      contextChip.hidden = true;
      contextChip.dataset.state = "unknown";
      contextChip.removeAttribute("title");
    }
    if (contextChipLabelEl !== null) contextChipLabelEl.textContent = "Context —";
    if (contextChipExactEl !== null) contextChipExactEl.textContent = "";
    setContextMeter(contextChipMeter, contextChipFill, null, 0, "unknown", false);
    if (contextUsage !== null) {
      contextUsage.hidden = hideSection === true;
      contextUsage.dataset.state = "unknown";
    }
    if (contextSummaryEl !== null) contextSummaryEl.textContent = "—";
    if (contextDetailEl !== null) contextDetailEl.textContent = detailText;
    if (contextAutoEl !== null) {
      contextAutoEl.textContent = "Auto-compact off";
      contextAutoEl.title = "";
    }
    if (contextSettingsEl !== null) contextSettingsEl.title = "Configure context and auto-compaction";
    setContextMeter(contextMeter, contextMeterFill, null, 0, "unknown", false);
    if (contextCompactButton !== null) {
      contextCompactButton.disabled = true;
      contextCompactButton.dataset.state = "disabled";
      contextCompactButton.removeAttribute("aria-busy");
    }
    if (contextCompactReason !== null) {
      contextCompactReason.textContent = reasonText;
      contextCompactReason.hidden = false;
    }
    hideContextConfirm(false);
    setContextErrorText(null);
  }

  function renderContextUnavailable(message) {
    resetContextUi(false, message, message);
  }

  function clearContextTimers() {
    if (contextPollTimer !== null) {
      window.clearInterval(contextPollTimer);
      contextPollTimer = null;
    }
    if (contextRetryTimer !== null) {
      window.clearTimeout(contextRetryTimer);
      contextRetryTimer = null;
    }
    contextPollSession = null;
    contextPollStartedAt = 0;
    contextPollGraceUntil = 0;
  }

  function contextLoginRedirect() {
    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?next=${encodeURIComponent(next)}`);
  }

  async function refreshContext(id, options) {
    const settings = options || {};
    const target = typeof id === "string" && id.length > 0 ? id : sessionId;
    if (target === null) {
      resetContextUi(true, "Waiting for a completed step.", "Start a session to compact.");
      return;
    }
    const epoch = contextEpoch;
    const sequence = (contextSeqBySession.get(target) || 0) + 1;
    contextSeqBySession.set(target, sequence);
    try {
      const snapshot = await api(contextUrl(target));
      if (target !== sessionId || epoch !== contextEpoch) return;
      if (contextSeqBySession.get(target) !== sequence) return;
      if (snapshot === null || typeof snapshot !== "object") {
        throw new Error("Context snapshot unavailable.");
      }
      contextBySession.set(target, snapshot);
      renderContext(snapshot);
    } catch (error) {
      if (target !== sessionId || epoch !== contextEpoch) return;
      if (contextSeqBySession.get(target) !== sequence) return;
      handleContextError(error, target, settings);
    }
  }

  function handleContextError(error, target, options) {
    const settings = options || {};
    const status =
      error !== null && typeof error === "object" && typeof error.status === "number"
        ? error.status
        : 0;
    const code =
      error !== null && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : "";
    if (status === 401) {
      contextLoginRedirect();
      return;
    }
    if (status === 404) {
      contextBySession.delete(target);
      contextSeqBySession.delete(target);
      clearContextTimers();
      if (target === sessionId) renderContextUnavailable("Session not found");
      return;
    }
    clearContextTimers();
    if (target !== sessionId) return;
    renderContextUnavailable("Context unavailable");
    if (status === 503 && code === "agent_not_running" && settings.retryNotRunning === true) {
      if (contextRetryTimer !== null) window.clearTimeout(contextRetryTimer);
      contextRetryTimer = window.setTimeout(() => {
        contextRetryTimer = null;
        if (sessionId === target) refreshContext(target).catch(() => {});
      }, 750);
    }
  }

  function startContextPolling(target, options) {
    if (typeof target !== "string" || target.length === 0) return;
    const settings = options || {};
    const awaiting = settings.awaitCompacting === true;
    if (contextPollTimer !== null && contextPollSession === target) {
      if (awaiting) contextPollGraceUntil = Date.now() + CONTEXT_COMPACT_GRACE_MS;
      return;
    }
    clearContextTimers();
    contextPollSession = target;
    contextPollStartedAt = Date.now();
    contextPollGraceUntil = awaiting ? Date.now() + CONTEXT_COMPACT_GRACE_MS : 0;
    contextPollTimer = window.setInterval(contextPollTick, CONTEXT_POLL_MS);
  }

  function contextPollTick() {
    const target = contextPollSession;
    if (target === null || target !== sessionId) {
      clearContextTimers();
      return;
    }
    if (Date.now() - contextPollStartedAt >= CONTEXT_POLL_MAX_MS) {
      clearContextTimers();
      return;
    }
    const snapshot = contextBySession.get(target);
    if (snapshot !== undefined) {
      if (snapshot.lastError !== null && snapshot.lastError !== undefined) {
        clearContextTimers();
        return;
      }
      if (snapshot.state !== "compacting" && Date.now() >= contextPollGraceUntil) {
        clearContextTimers();
        return;
      }
    }
    if (document.hidden) return;
    refreshContext(target, { polling: true }).catch(() => {});
  }

  function syncContextPolling() {
    const target = sessionId;
    if (target === null) {
      clearContextTimers();
      return;
    }
    const snapshot = contextBySession.get(target);
    if (snapshot !== undefined) {
      if (snapshot.lastError !== null && snapshot.lastError !== undefined) {
        clearContextTimers();
        return;
      }
      if (snapshot.state === "compacting") {
        startContextPolling(target);
        return;
      }
    }
    if (contextPollSession === target && Date.now() < contextPollGraceUntil) return;
    clearContextTimers();
  }

  function compactErrorMessage(error) {
    const status =
      error !== null && typeof error === "object" && typeof error.status === "number"
        ? error.status
        : 0;
    const code =
      error !== null && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : "";
    if (status === 401) return "Sign in again to compact this session.";
    if (status === 403) return "You do not have permission to compact this session.";
    if (status === 404) return "Session not found.";
    if (status === 409) {
      if (code === "session_busy") return "Wait for the agent to finish before compacting.";
      if (code === "compact_in_progress") return "Compaction is already in progress.";
      if (code === "model_unavailable") return "No model is available for this session.";
      return "Compaction is not available right now.";
    }
    if (status === 502) return "Compaction failed. Try again.";
    if (status === 503) return "Context is unavailable. Try again.";
    return "Compaction failed. Try again.";
  }

  async function compactContext() {
    const target = sessionId;
    if (target === null || contextPosting) return;
    contextPosting = true;
    clearContextClientError();
    hideContextConfirm(false);
    const before = contextBySession.get(target);
    if (before !== undefined) renderContext(before);
    let accepted = false;
    try {
      const result = await api(compactUrl(target), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (target !== sessionId) return;
      if (result === null || typeof result !== "object" || result.accepted !== true) {
        throw new Error("Compaction was not accepted.");
      }
      accepted = true;
      contextPosting = false;
      contextCompactingSession = target;
      const current = contextBySession.get(target);
      if (current !== undefined) {
        contextBySession.set(target, { ...current, state: "compacting", lastError: null });
      }
      startContextPolling(target, { awaitCompacting: true });
      const optimistic = contextBySession.get(target);
      if (optimistic !== undefined) renderContext(optimistic);
      announce("Compaction started.");
      showToast("Compaction started.", "success");
      await refreshContext(target, { force: true });
    } catch (error) {
      if (target !== sessionId) return;
      const message = compactErrorMessage(error);
      showContextError(message);
      showToast(message, "error");
    } finally {
      contextPosting = false;
      contextCompactingSession = null;
      if (target === sessionId) {
        const current = contextBySession.get(target);
        if (!accepted) {
          if (current !== undefined) renderContext(current);
          else renderContextUnavailable("Context unavailable");
        } else if (current !== undefined && current.state !== "compacting") {
          renderContext(current);
        }
      }
    }
  }

  function toolStatus(part) {
    const state = part.state && typeof part.state === "object" ? part.state : {};
    if (state.status === "error" || state.error) return "error";
    if (state.status === "running") return "running";
    if (state.status === "pending") return "pending";
    return "completed";
  }

  function partState(data) {
    return data.state && typeof data.state === "object" ? data.state : {};
  }

  function partInput(data) {
    const state = partState(data);
    return state.input && typeof state.input === "object" ? state.input : {};
  }

  function partMetadata(data) {
    const state = partState(data);
    return state.metadata && typeof state.metadata === "object" ? state.metadata : {};
  }

  function stringField(value) {
    return typeof value === "string" ? value : "";
  }

  function previewValue(value) {
    const raw = typeof value === "string" ? value : "";
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const firstLine = trimmed.split("\n")[0].replace(/\s+/g, " ").trim();
    if (firstLine.length === 0) return null;
    return { preview: firstLine.slice(0, 120), title: trimmed };
  }

  function todoListFor(data, status) {
    const input = partInput(data);
    const metadata = partMetadata(data);
    const primary = status === "completed" ? metadata.todos : input.todos;
    const fallback = status === "completed" ? input.todos : metadata.todos;
    if (Array.isArray(primary)) return primary;
    if (Array.isArray(fallback)) return fallback;
    return [];
  }

  function todoStatusEntry(status) {
    const map = {
      pending: { icon: "clock", label: "Pending" },
      in_progress: { icon: "activity", label: "Now" },
      completed: { icon: "check", label: "Done" },
      cancelled: { icon: "slash", label: "Dropped" },
    };
    return map[status] || { icon: "alert-circle", label: "Unknown" };
  }

  function todoPreview(todos) {
    const total = todos.length;
    if (total === 0) return previewValue("No tasks");
    let done = 0;
    let now = 0;
    for (const todo of todos) {
      const status = todo && typeof todo === "object" ? todo.status : undefined;
      if (status === "completed") done += 1;
      else if (status === "in_progress") now += 1;
    }
    return previewValue(`${done} of ${total} done${now > 0 ? ` · ${now} now` : ""}`);
  }

  function toolPreview(data, tool, status) {
    const state = partState(data);
    const input = partInput(data);
    const metadata = partMetadata(data);
    const filediff =
      metadata.filediff && typeof metadata.filediff === "object" ? metadata.filediff : {};
    const title = stringField(state.title) || stringField(data.title);
    let value = "";
    switch (tool) {
      case "bash":
        value = stringField(input.command) || title;
        break;
      case "read":
        value = stringField(input.filePath) || stringField(input.path);
        break;
      case "write":
      case "edit":
      case "hashline_edit":
        value =
          stringField(input.filePath) ||
          stringField(input.path) ||
          stringField(metadata.filepath) ||
          stringField(filediff.file) ||
          title;
        break;
      case "apply_patch": {
        const files = Array.isArray(metadata.files) ? metadata.files : [];
        const first = files.find((file) => file !== null && typeof file === "object");
        let path =
          first === undefined
            ? ""
            : stringField(first.relativePath) || stringField(first.filePath);
        if (path.length === 0) {
          const patchText = stringField(input.patchText);
          for (const line of patchText.split("\n")) {
            const match =
              /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ||
              /^\*\*\* Move to: (.+)$/.exec(line);
            if (match !== null) {
              path = match[1].trim();
              break;
            }
          }
        }
        if (path.length > 0) {
          value = files.length > 1 ? `${path} · ${files.length} files` : path;
        } else {
          value = title;
        }
        if (value.length === 0) value = tool;
        break;
      }
      case "grep": {
        const pattern = stringField(input.pattern);
        const searchPath = stringField(input.path) || stringField(input.filePath);
        value = pattern.length > 0 && searchPath.length > 0 ? `${pattern} in ${searchPath}` : pattern;
        if (value.length === 0) value = title;
        break;
      }
      case "glob":
        value = stringField(input.pattern) || title;
        break;
      case "webfetch":
        value = stringField(input.url) || title;
        break;
      case "websearch":
        value = stringField(input.query) || title;
        break;
      case "task":
        value =
          stringField(input.description) ||
          stringField(input.agent) ||
          stringField(input.subagent) ||
          title;
        break;
      case "todowrite":
        return todoPreview(todoListFor(data, status));
      case "question":
        if (status === "completed") {
          value = "Answered";
        } else {
          const questions = Array.isArray(input.questions) ? input.questions.length : 0;
          value = `Question · ${questions} waiting`;
        }
        break;
      default:
        value = title;
        if (value.length === 0) {
          for (const key of Object.keys(input)) {
            if (typeof input[key] === "string" && input[key].length > 0) {
              value = input[key];
              break;
            }
          }
        }
        if (value.length === 0) value = tool;
    }
    return previewValue(value);
  }

  function toolOutputText(data, tool, status) {
    const state = partState(data);
    const metadata = partMetadata(data);
    if (status === "running") {
      if (typeof metadata.output === "string" && metadata.output.length > 0) {
        return metadata.output;
      }
      if (tool === "bash") return "Waiting for output…";
    }
    if (status === "error" && typeof state.error === "string" && state.error.length > 0) {
      return state.error;
    }
    if (typeof state.output === "string" && state.output.length > 0) return state.output;
    if (typeof metadata.output === "string" && metadata.output.length > 0) {
      return metadata.output;
    }
    if (typeof state.error === "string" && state.error.length > 0) return state.error;
    if (typeof data.output === "string" && data.output.length > 0) return data.output;
    if (typeof data.text === "string" && data.text.length > 0) return data.text;
    return "No output";
  }

  function epochMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  function toolElapsedText(data, status) {
    if (status !== "running") return "";
    const start = epochMs(partState(data).time?.start);
    if (start === null) return "";
    return formatElapsed(Date.now() - start);
  }

  function toolGlyph(tool) {
    const map = {
      bash: "terminal",
      read: "code",
      write: "code",
      edit: "code",
      hashline_edit: "code",
      apply_patch: "code",
      grep: "search",
      glob: "search",
      webfetch: "search",
      websearch: "search",
      task: "activity",
      todowrite: "check",
      question: "message",
    };
    return map[tool] || "terminal";
  }

  function detailLabel(part) {
    if (part.type === "reasoning") return "Thinking";
    return part.type;
  }

  function detailPreview(kind, data) {
    if (kind === "patch") return previewValue(stringField(data.title));
    if (kind === "file") {
      return previewValue(
        stringField(data.filename) ||
          stringField(data.path) ||
          stringField(data.name) ||
          stringField(data.title),
      );
    }
    if (kind === "subtask") {
      return previewValue(
        stringField(data.description) ||
          stringField(data.agent) ||
          stringField(data.title) ||
          stringField(data.prompt),
      );
    }
    return null;
  }

  function detailBodyText(kind, data) {
    if (kind === "reasoning") return stringField(data.text) || "Reasoning";
    if (kind === "patch") {
      return stringField(data.patch) || stringField(data.text) || "Patch";
    }
    if (typeof data.output === "string" && data.output.length > 0) return data.output;
    if (typeof data.error === "string" && data.error.length > 0) return data.error;
    if (typeof data.text === "string" && data.text.length > 0) return data.text;
    if (typeof data.content === "string" && data.content.length > 0) return data.content;
    if (typeof data.patch === "string" && data.patch.length > 0) return data.patch;
    return "No output";
  }

  function partDataOf(part) {
    return part.data && typeof part.data === "object" ? part.data : part;
  }

  function partKeyFor(record, part) {
    return `${record.id}:${part.id}`;
  }

  function isQuestionToolPart(part) {
    if (part === undefined || part === null || part.type !== "tool") return false;
    const data = partDataOf(part);
    return data.tool === "question";
  }

  function isVisibleRecordPart(part) {
    if (part === undefined || part === null) return false;
    if (part.type === "text") {
      return !partIgnored(part) && partTextValue(part).trim().length > 0;
    }
    if (
      part.type === "tool" ||
      part.type === "reasoning" ||
      part.type === "patch" ||
      part.type === "file" ||
      part.type === "subtask"
    ) {
      return true;
    }
    if (!KNOWN_PART_TYPES.has(part.type)) return true;
    return false;
  }

  function recordHasVisiblePart(record) {
    for (const partID of record.partOrder) {
      if (isVisibleRecordPart(record.parts.get(partID))) return true;
    }
    return false;
  }

  function isSystemRecord(record) {
    return record.role === "user" && record.system !== undefined && record.system !== null;
  }

  function isPendingRecord(record) {
    return record.role === "user" && record.classificationPending === true;
  }

  function recordNeedsNode(record) {
    return recordHasVisiblePart(record) || isSystemRecord(record) || isPendingRecord(record);
  }

  function isOptimisticRecord(record) {
    return typeof record.optimistic === "string" && record.optimistic.length > 0;
  }

  function messageMode(record) {
    if (isSystemRecord(record)) return "system";
    if (isPendingRecord(record)) return "pending";
    return record.role;
  }

  function hasCompleteTextSnapshot(record) {
    for (const partID of record.partOrder) {
      const part = record.parts.get(partID);
      if (part === undefined || part.type !== "text") continue;
      if (part.provisional === true || part.partial === true) continue;
      const data = partDataOf(part);
      if (data.provisional === true || data.partial === true) continue;
      return true;
    }
    return false;
  }  function messageTime(info) {
    if (!info || typeof info !== "object") return "";
    const time = info.time;
    let value = null;
    if (time && typeof time === "object" && typeof time.created === "number") {
      value = time.created;
    } else if (typeof info.createdAt === "string" || typeof info.createdAt === "number") {
      value = info.createdAt;
    }
    if (value === null) return "";
    const date = new Date(typeof value === "number" && value < 1_000_000_000_000 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderMessageMeta(record, node) {
    const mode = messageMode(record);
    const system = isSystemRecord(record) ? record.system : null;
    const signature = `${mode}|${messageTime(record)}|${node.dataset.optimistic || ""}|${
      system === null ? "" : `${system.kind}|${system.title}`
    }`;
    if (node.dataset.metaSignature === signature) return;
    node.dataset.metaSignature = signature;
    const meta = node.querySelector(".message__meta");
    if (meta === null) return;
    const children = [];
    if (mode === "system") {
      children.push(iconNode("settings", "icon--sm"));
      children.push(element("span", "message__role", "OMO"));
      children.push(element("span", "message__kind", system.kind));
    } else if (mode === "pending") {
      children.push(iconNode("activity", "icon--sm"));
      children.push(element("span", "message__role", "Message"));
    } else {
      const avatar = element(
        "span",
        "avatar avatar--sm",
        record.role === "user" ? operatorInitials : appInitials,
      );
      avatar.setAttribute("aria-hidden", "true");
      children.push(avatar);
      children.push(element("span", "message__role", record.role === "user" ? "operator" : appKey));
    }
    const stamp = messageTime(record);
    if (stamp.length > 0) children.push(element("span", "message__time", stamp));
    meta.replaceChildren(...children);
  }

  function collapsePreview(value) {
    return value.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function omoBodyNeedsDetails(body) {
    if (body.length > OMO_DETAILS_CHAR_LIMIT) return true;
    if (body.split("\n").length > OMO_DETAILS_LINE_LIMIT) return true;
    return /\*\*(ID|Description):\*\*/.test(body);
  }

  function omoBodyPreview(body) {
    const patterns = [
      /\*\*ID:\*\*\s*([^\n]+)/,
      /\*\*Description:\*\*\s*([^\n]+)/,
      /\*\*Duration:\*\*\s*([^\n]+)/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(body);
      if (match !== null && match[1] !== undefined) return collapsePreview(match[1]);
    }
    const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? "";
    return collapsePreview(firstLine);
  }

  function renderOmoCard(record, node) {
    const system = record.system;
    if (system === undefined || system === null) return;
    const card = node.querySelector(".omo-card");
    if (card !== null && omoCardState.get(node) === system) return;
    const nextCard = card === null ? element("div", "omo-card") : card;
    nextCard.dataset.kind = system.kind;
    nextCard.dataset.tone = system.tone;
    const head = element("div", "omo-card__head");
    const title = element("div", "omo-card__title", system.title.length > 0 ? system.title : system.kind);
    head.append(title, element("span", "omo-card__kind", system.kind));
    nextCard.replaceChildren(head);
    if (typeof system.body === "string" && system.body.trim().length > 0) {
      const body = element("div", "omo-card__body message__body");
      if (omoBodyNeedsDetails(system.body)) {
        const details = element("details", "omo-card__details");
        details.append(
          element("summary", "omo-card__preview", omoBodyPreview(system.body)),
          body,
        );
        renderMarkdown(body, system.body);
        nextCard.append(details);
      } else {
        renderMarkdown(body, system.body);
        nextCard.append(body);
      }
    }
    if (card === null) node.append(nextCard);
    omoCardState.set(node, system);
  }

  function removeOmoCard(node) {
    const card = node.querySelector(".omo-card");
    if (card !== null) card.remove();
    omoCardState.delete(node);
  }

  function detachRecordPartNodes(record, node) {
    for (const partID of record.partOrder) {
      const partNode = partNodes.get(`${record.id}:${partID}`);
      if (partNode !== undefined && partNode.parentNode === node) partNode.remove();
    }
  }

  function optimisticLabel(state) {
    if (state === "sending") return "Sending…";
    if (state === "queued") return "Queued";
    if (state === "unknown") return "Delivery unknown; checking…";
    if (state === "failed") return "Failed";
    return "";
  }

  function syncMessageOptimistic(record, node) {
    let stateEl = node.querySelector(".message__state");
    const label = optimisticLabel(record.optimistic);
    if (label.length === 0) {
      if (stateEl !== null) stateEl.remove();
      return;
    }
    if (stateEl === null) {
      stateEl = element("div", "message__state");
      stateEl.setAttribute("aria-hidden", "true");
      node.append(stateEl);
    }
    if (stateEl.textContent !== label) stateEl.textContent = label;
  }

  function createMessageNode(record) {
    const mode = messageMode(record);
    const classes = ["message"];
    if (mode === "user") classes.push("message--user");
    else if (mode === "system") classes.push("message--system");
    else if (mode === "pending") classes.push("message--pending");
    const node = element("article", classes.join(" "));
    node.dataset.messageId = record.id;
    node.dataset.role = record.role;
    if (record.optimistic !== undefined) {
      node.classList.add("message--optimistic");
      node.dataset.state = record.optimistic;
      node.dataset.optimistic = record.optimistic;
    }
    node.append(element("div", "message__meta"));
    renderMessageMeta(record, node);
    syncMessageOptimistic(record, node);
    return node;
  }

  function attachOpenTracking(node, part, key) {
    node.addEventListener("toggle", () => {
      if (node.open) store.openParts.add(part.id);
      else store.openParts.delete(part.id);
      const state = partRenderState.get(key);
      if (state !== undefined) syncViewOpen(node, part, state);
    });
  }

  function createPartNode(record, part) {
    const key = partKeyFor(record, part);
    if (part.type === "tool") {
      if (isQuestionToolPart(part)) {
        const slot = element("div", "chat-question-slot");
        slot.dataset.messageId = record.id;
        slot.dataset.partId = part.id;
        slot.dataset.partType = part.type;
        slot.dataset.toolKey = key;
        return slot;
      }
      const details = element("details", "tool-call");
      details.dataset.messageId = record.id;
      details.dataset.partId = part.id;
      details.dataset.partType = part.type;
      details.dataset.toolKey = key;
      details.append(element("summary"));
      attachOpenTracking(details, part, key);
      return details;
    }
    if (
      part.type === "reasoning" ||
      part.type === "patch" ||
      part.type === "file" ||
      part.type === "subtask"
    ) {
      const details = element("details", "tool-call");
      details.dataset.messageId = record.id;
      details.dataset.partId = part.id;
      details.dataset.partType = part.type;
      details.dataset.toolKey = key;
      details.append(element("summary"));
      attachOpenTracking(details, part, key);
      return details;
    }
    const body = element("div", "message__body");
    body.dataset.messageId = record.id;
    body.dataset.partId = part.id;
    body.dataset.partType = part.type;
    return body;
  }

  function insertPartNode(record, node, partID) {
    const messageNode = messageNodes.get(record.id);
    if (messageNode === undefined) return;
    const index = record.partOrder.indexOf(partID);
    let anchor = null;
    for (let cursor = index + 1; cursor < record.partOrder.length; cursor += 1) {
      const candidate = partNodes.get(`${record.id}:${record.partOrder[cursor]}`);
      if (candidate !== undefined && candidate.parentNode === messageNode) {
        anchor = candidate;
        break;
      }
    }
    if (anchor === null) messageNode.append(node);
    else messageNode.insertBefore(node, anchor);
  }

  function syncPartOrder(record, messageNode) {
    if (messageNode === undefined) return;
    const desired = [];
    for (const partID of record.partOrder) {
      const node = partNodes.get(`${record.id}:${partID}`);
      if (node !== undefined && node.parentNode === messageNode) desired.push(node);
    }
    const current = Array.from(messageNode.children).filter((child) =>
      child.hasAttribute("data-part-id"),
    );
    if (
      current.length === desired.length &&
      current.every((node, index) => node === desired[index])
    ) {
      return;
    }
    for (const node of desired) messageNode.append(node);
  }

  function renderStateFor(key) {
    let state = partRenderState.get(key);
    if (state === undefined) {
      state = {
        rendered: false,
        text: "",
        output: "",
        path: "",
        status: "",
        tool: "",
        at: 0,
        bodyKind: "",
        viewKey: "",
        viewSignature: "",
        view: null,
        viewBody: null,
        viewOpen: false,
      };
      partRenderState.set(key, state);
    }
    return state;
  }

  function updateTextPart(node, part, key, force) {
    const state = renderStateFor(key);
    const text = partTextValue(part);
    if (state.rendered && state.text === text) return true;
    if (!force && part.sealed !== true && Date.now() - state.at < MARKDOWN_THROTTLE_MS) {
      return false;
    }
    node.replaceChildren();
    renderMarkdown(node, text);
    if (part.partial === true) node.dataset.partial = "true";
    else delete node.dataset.partial;
    state.rendered = true;
    state.text = text;
    state.at = Date.now();
    return true;
  }

  function directChildByClass(node, className) {
    for (const child of node.children) {
      if (child.classList.contains(className)) return child;
    }
    return null;
  }

  function directPre(node) {
    for (const child of node.children) {
      if (child.tagName === "PRE") return child;
    }
    return null;
  }

  function ensureToolBody(node, state, kind) {
    if (state.bodyKind !== kind) {
      for (const child of Array.from(node.children)) {
        if (child.tagName === "SUMMARY") continue;
        child.remove();
      }
      state.bodyKind = kind;
    }
    if (kind === "todo") {
      let list = directChildByClass(node, "tool-todo");
      if (list === null) {
        list = element("ul", "tool-todo");
        node.append(list);
      }
      return list;
    }
    if (kind === "bash") {
      let pre = directChildByClass(node, "tool-call__output");
      if (pre === null) {
        pre = element("pre", "tool-call__output");
        node.append(pre);
      }
      return pre;
    }
    if (kind === "pre") {
      let pre = directPre(node);
      if (pre === null) {
        pre = element("pre");
        node.append(pre);
      }
      return pre;
    }
    if (kind === "view") {
      let host = directChildByClass(node, "tool-call__view");
      if (host === null) {
        host = element("div", "tool-call__view");
        node.append(host);
      }
      return host;
    }
    if (kind === "none") {
      for (const child of Array.from(node.children)) {
        if (child.tagName !== "SUMMARY") child.remove();
      }
    }
    return null;
  }

  function syncTruncationNotice(node, text) {
    let note = directChildByClass(node, "tool-call__truncated");
    if (text.length === 0) {
      if (note !== null) note.remove();
      return;
    }
    if (note === null) {
      note = element("p", "tool-call__truncated");
      node.append(note);
    }
    if (note.textContent !== text) note.textContent = text;
    if (node.lastChild !== note) node.append(note);
  }

  function fnv1aLanes(value) {
    let first = 0x811c9dc5;
    let second = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x01000193);
    }
    return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
  }

  function viewKeyFor(part, status, view) {
    const descriptor = [];
    let source = "";
    for (const file of Array.isArray(view.files) ? view.files : []) {
      const hunks = Array.isArray(file.hunks)
        ? file.hunks.map((hunk) => (Array.isArray(hunk.lines) ? hunk.lines.length : 0)).join(",")
        : "";
      descriptor.push(
        [
          file.path ?? "",
          file.oldPath ?? "",
          file.newPath ?? "",
          file.type ?? "",
          file.additions ?? 0,
          file.deletions ?? 0,
          file.language ?? "",
          file.truncated === true ? 1 : 0,
          hunks,
        ].join("~"),
      );
      const body = typeof file.patch === "string" ? file.patch : file.content;
      if (typeof body === "string") {
        source += `${body.length}\u0000${body}\u0000`;
      }
    }
    descriptor.push(typeof view.diagnostics === "string" ? view.diagnostics : "");
    const display = view.display && typeof view.display === "object" ? view.display : {};
    descriptor.push(
      [display.write, display.perFile, display.total, display.lines, display.files]
        .map((flag) => (flag === true ? 1 : 0))
        .join(""),
    );
    descriptor.push(source);
    return `${part.id}:${view.kind}:${fnv1aLanes(descriptor.join("|"))}`;
  }

  function captureViewBody(host) {
    const scroller = host.querySelector(".tool-diff__scroll, .tool-code__scroll");
    return {
      hadFocus: scroller !== null && scroller.contains(document.activeElement),
      scrollTop: scroller === null ? 0 : scroller.scrollTop,
      scrollLeft: scroller === null ? 0 : scroller.scrollLeft,
    };
  }

  function restoreViewBody(host, saved) {
    const scroller = host.querySelector(".tool-diff__scroll, .tool-code__scroll");
    if (scroller === null) return;
    scroller.scrollTop = saved.scrollTop;
    scroller.scrollLeft = saved.scrollLeft;
    if (saved.hadFocus) scroller.focus();
  }

  function syncViewOpen(node, part, state) {
    if (state.bodyKind !== "view" || state.viewKey.length === 0) return;
    const open = node.open;
    if (state.viewOpen === open) return;
    setToolViewOpen(part.id, state.viewKey, state.view, state.viewBody, open);
    state.viewOpen = open;
  }

  function clearViewState(part, state) {
    if (state.viewKey.length > 0 || state.viewBody !== null) {
      resetHighlightController({ reason: "view-cleared", partID: part.id });
    }
    state.viewKey = "";
    state.viewSignature = "";
    state.view = null;
    state.viewBody = null;
    state.viewOpen = false;
  }

  function renderToolTodo(list, todos) {
    const rows = [];
    let currentMarked = false;
    for (const todo of todos) {
      const item = element("li", "tool-todo__item");
      const status = todo && typeof todo === "object" ? todo.status : undefined;
      const entry = todoStatusEntry(status);
      item.dataset.status = typeof status === "string" ? status : "unknown";
      if (status === "in_progress" && !currentMarked) {
        item.setAttribute("aria-current", "step");
        currentMarked = true;
      }
      const glyph = element("span", "tool-todo__status");
      glyph.append(iconNode(entry.icon, "icon--sm"), document.createTextNode(entry.label));
      const content = element(
        "span",
        "tool-todo__content",
        todo && typeof todo.content === "string" ? todo.content : "",
      );
      const priority =
        todo && typeof todo.priority === "string" ? todo.priority : "unknown";
      item.append(
        glyph,
        content,
        priorityMeter(priority),
        element("span", "sr-only", `Priority: ${priority}`),
      );
      rows.push(item);
    }
    list.replaceChildren(...rows);
  }

  function applyViewBody(node, part, state, allocated, viewKey) {
    const body = ensureToolBody(node, state, "view");
    if (body === null) return;
    if (state.viewKey === viewKey) return;
    const saved = captureViewBody(body);
    const mounted = mountToolView(allocated, { partID: part.id, viewKey });
    if (mounted === null) {
      body.replaceChildren();
      state.viewKey = "";
      state.viewSignature = "";
      state.view = null;
      state.viewBody = null;
      state.viewOpen = false;
      return;
    }
    body.replaceChildren(mounted);
    restoreViewBody(body, saved);
    state.viewKey = viewKey;
    state.viewSignature = viewKey;
    state.view = allocated;
    state.viewBody = mounted;
    state.viewOpen = false;
  }

  function updateToolPart(node, part, key, force) {
    const state = renderStateFor(key);
    const data = partDataOf(part);
    const tool = String(data.tool || "tool");
    const status = toolStatus(data);
    const preview = toolPreview(data, tool, status);
    const elapsed = toolElapsedText(data, status);
    const todos = tool === "todowrite" ? todoListFor(data, status) : null;
    const output = todos === null ? toolOutputText(data, tool, status) : "";
    const view = extractToolView(data, tool, status);
    const allocated = view === null ? null : allocateView(view);
    const hasViewBody =
      allocated !== null &&
      (allocated.kind === "diff" ||
        allocated.kind === "write" ||
        allocated.kind === "read" ||
        allocated.kind === "files");
    const bodyText =
      allocated !== null && allocated.kind === "plain" ? allocated.text : output;
    let bodyKind = "pre";
    if (part.omitted === true) bodyKind = "none";
    else if (hasViewBody) bodyKind = "view";
    else if (tool === "todowrite") bodyKind = "todo";
    else if (tool === "bash") bodyKind = "bash";
    const viewKey =
      bodyKind === "view" && allocated !== null ? viewKeyFor(part, status, allocated) : "";
    const notice = buildTruncationNotice(part, status, {
      serverFields: part.truncation?.fields,
      serverLimit: part.truncation?.limit,
      omitted: part.omitted,
      display: allocated?.display,
      sessionSnapshotTooLarge,
    });
    const signature = [
      tool,
      status,
      preview === null ? "" : `${preview.preview}\n${preview.title}`,
      elapsed,
      bodyKind === "view" || bodyKind === "none" ? "" : bodyText,
      todos === null ? "" : JSON.stringify(todos),
      notice,
      bodyKind,
      viewKey,
    ].join("|");
    if (state.rendered && state.signature === signature) return true;
    if (
      !force &&
      status === "running" &&
      state.rendered &&
      Date.now() - state.at < TOOL_OUTPUT_THROTTLE_MS
    ) {
      return false;
    }
    const summary = node.querySelector("summary");
    if (summary === null) return true;
    const hadFocus = summary.contains(document.activeElement);
    const summaryChildren = [
      iconNode(toolGlyph(tool)),
      element("span", "mono", tool),
    ];
    if (preview !== null) {
      const previewEl = element("span", "tool-call__path", preview.preview);
      previewEl.title = preview.title;
      summaryChildren.push(previewEl);
    }
    summaryChildren.push(toolStatusChip(status));
    if (elapsed.length > 0) {
      summaryChildren.push(element("span", "tool-call__elapsed mono", elapsed));
    }
    summary.replaceChildren(...summaryChildren);
    if (hadFocus) summary.focus();

    if (bodyKind === "none") {
      clearViewState(part, state);
      ensureToolBody(node, state, "none");
    } else if (bodyKind === "view" && allocated !== null) {
      applyViewBody(node, part, state, allocated, viewKey);
    } else {
      clearViewState(part, state);
      const body = ensureToolBody(node, state, bodyKind);
      if (body !== null) {
        if (bodyKind === "todo") {
          renderToolTodo(body, todos || []);
        } else {
          const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
          if (body.textContent !== bodyText) body.textContent = bodyText;
          if (follow) body.scrollTop = body.scrollHeight;
        }
      }
    }
    syncTruncationNotice(node, notice);

    if (status !== "error") state.errorOpened = false;
    if (!state.rendered) {
      if (status === "error") {
        node.open = true;
        store.openParts.add(part.id);
        state.errorOpened = true;
      } else {
        node.open = store.openParts.has(part.id);
      }
    } else if (status === "error" && state.errorOpened !== true) {
      node.open = true;
      store.openParts.add(part.id);
      state.errorOpened = true;
    }
    syncViewOpen(node, part, state);
    state.rendered = true;
    state.tool = tool;
    state.status = status;
    state.path = preview === null ? "" : preview.preview;
    state.output = output;
    state.signature = signature;
    state.at = Date.now();
    return true;
  }

  function updateDetailPart(node, part, key, force) {
    const state = renderStateFor(key);
    const data = partDataOf(part);
    const kind = part.type;
    const label = detailLabel(part);
    const preview = detailPreview(kind, data);
    const view = kind === "patch" ? patchPartView(data) : null;
    const allocated = view === null ? null : allocateView(view);
    const hasViewBody =
      allocated !== null && (allocated.kind === "diff" || allocated.kind === "files");
    const bodyKind = hasViewBody ? "view" : "pre";
    const text =
      allocated !== null && allocated.kind === "plain"
        ? allocated.text
        : detailBodyText(kind, data);
    const viewKey = bodyKind === "view" && allocated !== null ? viewKeyFor(part, "completed", allocated) : "";
    const notice = buildTruncationNotice(part, "completed", {
      serverFields: part.truncation?.fields,
      serverLimit: part.truncation?.limit,
      omitted: part.omitted,
      display: allocated?.display,
      sessionSnapshotTooLarge,
    });
    const signature = [
      label,
      preview === null ? "" : `${preview.preview}\n${preview.title}`,
      bodyKind === "view" ? "" : text,
      notice,
      bodyKind,
      viewKey,
    ].join("|");
    if (state.rendered && state.signature === signature) return true;
    if (!force && state.rendered && Date.now() - state.at < MARKDOWN_THROTTLE_MS) return false;
    const summary = node.querySelector("summary");
    if (summary === null) return true;
    const hadFocus = summary.contains(document.activeElement);
    const summaryChildren = [
      iconNode(kind === "patch" || kind === "file" ? "code" : "activity"),
      element("span", "mono", label),
    ];
    if (preview !== null) {
      const previewEl = element("span", "tool-call__path", preview.preview);
      previewEl.title = preview.title;
      summaryChildren.push(previewEl);
    }
    summary.replaceChildren(...summaryChildren);
    if (bodyKind === "view" && allocated !== null) {
      applyViewBody(node, part, state, allocated, viewKey);
    } else {
      clearViewState(part, state);
      const body = ensureToolBody(node, state, "pre");
      if (body !== null) {
        if (body.textContent !== text) body.textContent = text;
      }
    }
    syncTruncationNotice(node, notice);
    if (hadFocus) summary.focus();
    if (!state.rendered) node.open = store.openParts.has(part.id);
    syncViewOpen(node, part, state);
    state.rendered = true;
    state.text = text;
    state.signature = signature;
    state.at = Date.now();
    return true;
  }

  function updatePartNode(node, record, part, force) {
    const key = partKeyFor(record, part);
    if (part.type === "text") return updateTextPart(node, part, key, force);
    if (isQuestionToolPart(part)) return updateInlineQuestionPart(node, record, part);
    if (part.type === "tool") return updateToolPart(node, part, key, force);
    if (
      part.type === "reasoning" ||
      part.type === "patch" ||
      part.type === "file" ||
      part.type === "subtask"
    ) {
      return updateDetailPart(node, part, key, force);
    }
    const state = renderStateFor(key);
    if (!state.rendered) {
      node.replaceChildren(document.createTextNode(`Unsupported content: ${String(part.type)}`));
      node.dataset.partial = "true";
      state.rendered = true;
    }
    return true;
  }

  function ensurePartNode(record, part, force) {
    const key = partKeyFor(record, part);
    if (isSystemRecord(record) || isPendingRecord(record)) {
      const hiddenNode = partNodes.get(key);
      if (hiddenNode !== undefined && hiddenNode.parentNode !== null) hiddenNode.remove();
      return true;
    }
    let node = partNodes.get(key);
    if (!isVisibleRecordPart(part)) {
      if (node !== undefined) {
        resetHighlightController({ reason: "part-removed", partID: part.id });
        node.remove();
        partNodes.delete(key);
        partRenderState.delete(key);
      }
      return true;
    }
    if (node !== undefined && node.dataset.partType !== part.type) {
      resetHighlightController({ reason: "part-removed", partID: part.id });
      node.remove();
      partNodes.delete(key);
      partRenderState.delete(key);
      node = undefined;
    }
    if (node !== undefined) {
      const questionSlot = node.classList.contains("chat-question-slot");
      if (isQuestionToolPart(part) !== questionSlot && part.type === "tool") {
        resetHighlightController({ reason: "part-removed", partID: part.id });
        node.remove();
        partNodes.delete(key);
        partRenderState.delete(key);
        node = undefined;
      }
    }
    if (node === undefined) {
      node = createPartNode(record, part);
      partNodes.set(key, node);
      partOwner.set(part.id, record.id);
      insertPartNode(record, node, part.id);
    } else if (node.parentNode === null) {
      insertPartNode(record, node, part.id);
    }
    node.dataset.partType = part.type;
    return updatePartNode(node, record, part, force);
  }

  function ensureMessageNode(record) {
    let node = messageNodes.get(record.id);
    if (!recordNeedsNode(record)) {
      if (node !== undefined) {
        node.remove();
        messageNodes.delete(record.id);
      }
      for (const partID of record.partOrder) {
        const key = `${record.id}:${partID}`;
        const partNode = partNodes.get(key);
        if (partNode !== undefined) {
          resetHighlightController({ reason: "part-removed", partID });
          partNode.remove();
          partNodes.delete(key);
          partRenderState.delete(key);
        }
      }
      return null;
    }
    if (node === undefined) {
      node = createMessageNode(record);
      messageNodes.set(record.id, node);
      messagesEl.append(node);
    }
    const mode = messageMode(record);
    node.dataset.role = record.role;
    node.classList.toggle("message--user", mode === "user");
    node.classList.toggle("message--system", mode === "system");
    node.classList.toggle("message--pending", mode === "pending");
    if (record.optimistic !== undefined) {
      node.classList.add("message--optimistic");
      node.dataset.state = record.optimistic;
      node.dataset.optimistic = record.optimistic;
    } else {
      node.classList.remove("message--optimistic");
      delete node.dataset.state;
      delete node.dataset.optimistic;
    }
    if (mode === "system") {
      detachRecordPartNodes(record, node);
      renderOmoCard(record, node);
    } else {
      removeOmoCard(node);
      if (mode === "pending") detachRecordPartNodes(record, node);
    }
    renderMessageMeta(record, node);
    syncMessageOptimistic(record, node);
    return node;
  }

  function removeStoredMessage(id) {
    clearOmoClassifyTimer(id);
    const record = store.messages.get(id);
    if (record !== undefined) {
      for (const partID of record.partOrder) {
        resetHighlightController({ reason: "part-removed", partID });
        if (partOwner.get(partID) === id) partOwner.delete(partID);
      }
    }
    store.messages.delete(id);
    store.order = store.order.filter((item) => item !== id);
    const node = messageNodes.get(id);
    if (node !== undefined) {
      node.remove();
      messageNodes.delete(id);
    }
    recomputeQueue();
  }

  function localID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `local_${crypto.randomUUID()}`;
    }
    return `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function insertOptimisticMessage(id, text) {
    const partID = `${id}:part:text`;
    const part = {
      id: partID,
      type: "text",
      data: { id: partID, type: "text", text, provisional: true, placeholder: true },
      provisional: true,
      partial: false,
      sealed: false,
      version: 1,
    };
    const record = {
      id,
      role: "user",
      optimistic: "sending",
      partOrder: [partID],
      parts: new Map([[partID, part]]),
      version: 1,
    };
    store.messages.set(id, record);
    store.order.push(id);
    partOwner.set(partID, id);
    markOptimisticOperator(record);
    orderDirty = true;
    dirtyMessages.add(id);
    recomputeQueue();
    scheduleFlush();
  }

  function userPlaceholderPartID(record) {
    for (const partID of record.partOrder) {
      const part = record.parts.get(partID);
      if (part === undefined || part.type !== "text") continue;
      const data = partDataOf(part);
      if (part.provisional === true || data.provisional === true || data.placeholder === true) {
        return partID;
      }
    }
    return null;
  }

  function renamePartEntry(
    oldKey,
    newKey,
    oldPartID,
    newPartID,
    oldMessageID,
    newMessageID,
  ) {
    const node = partNodes.get(oldKey);
    if (node !== undefined) {
      partNodes.delete(oldKey);
      partNodes.set(newKey, node);
      node.dataset.messageId = newMessageID;
      node.dataset.partId = newPartID;
    }
    const state = partRenderState.get(oldKey);
    if (state !== undefined) {
      partRenderState.delete(oldKey);
      partRenderState.set(newKey, state);
    }
    if (partOwner.get(oldPartID) === oldMessageID) partOwner.delete(oldPartID);
    partOwner.set(newPartID, newMessageID);
  }

  function renamePartKey(messageID, oldPartID, newPartID) {
    renamePartEntry(
      `${messageID}:${oldPartID}`,
      `${messageID}:${newPartID}`,
      oldPartID,
      newPartID,
      messageID,
      messageID,
    );
  }

  function renamePartMessage(oldMessageID, newMessageID, oldPartID, newPartID) {
    renamePartEntry(
      `${oldMessageID}:${oldPartID}`,
      `${newMessageID}:${newPartID}`,
      oldPartID,
      newPartID,
      oldMessageID,
      newMessageID,
    );
  }

  function removePartKey(messageID, partID) {
    const key = `${messageID}:${partID}`;
    const node = partNodes.get(key);
    if (node !== undefined) node.remove();
    partNodes.delete(key);
    partRenderState.delete(key);
    if (partOwner.get(partID) === messageID) partOwner.delete(partID);
  }

  function rekeyMessageDom(tempID, serverID, oldPartIDs, newRecord) {
    const node = messageNodes.get(tempID);
    if (node !== undefined) {
      messageNodes.delete(tempID);
      messageNodes.set(serverID, node);
      node.dataset.messageId = serverID;
    }
    const newPartIDs = newRecord === undefined ? [] : [...newRecord.partOrder];
    const newSet = new Set(newPartIDs);
    const oldSet = new Set(oldPartIDs);
    const replacementID = newPartIDs.find((partID) => !oldSet.has(partID)) || null;
    let placeholderUsed = false;
    for (const oldPartID of oldPartIDs) {
      if (newSet.has(oldPartID)) {
        renamePartMessage(tempID, serverID, oldPartID, oldPartID);
        continue;
      }
      if (!placeholderUsed && replacementID !== null) {
        placeholderUsed = true;
        renamePartMessage(tempID, serverID, oldPartID, replacementID);
        continue;
      }
      removePartKey(tempID, oldPartID);
    }
    for (const partID of newPartIDs) {
      partOwner.set(partID, serverID);
    }
  }

  function applyBufferedLeftovers(events, serverID) {
    if (!Array.isArray(events) || events.length === 0) return;
    const leftovers = events.filter(
      (event) => event === null || typeof event !== "object" || event.messageID !== serverID,
    );
    if (leftovers.length === 0) return;
    for (const event of leftovers) {
      const replay = { ...event };
      delete replay.seq;
      delete replay.streamID;
      handleStreamEvent(replay);
    }
  }

  function statusTypeOf(status) {
    if (status === null || typeof status !== "object") return undefined;
    if (typeof status.type === "string") return status.type;
    if (status.status && typeof status.status.type === "string") return status.status.type;
    return undefined;
  }

  function savedStoreFor(id) {
    const saved = sessionRuntime.get(id);
    if (saved === undefined) return null;
    return {
      sessionID: id,
      generation: 0,
      turnGeneration: saved.turnGeneration ?? 0,
      order: [...saved.order],
      messages: saved.messages,
      activePromptID: saved.activePromptID ?? null,
      queue: Array.isArray(saved.queue) ? [...saved.queue] : [],
      openParts: new Set(saved.openParts),
      lastSeqByStream: new Map(saved.lastSeqByStream),
      currentStreamID: saved.currentStreamID ?? null,
      pendingDeltas: new Map(),
      agentStatus: saved.agentStatus ?? null,
    };
  }

  function commitSavedStore(id, next) {
    const saved = sessionRuntime.get(id);
    if (saved === undefined) return;
    saved.order = next.order;
    saved.messages = next.messages;
    saved.activePromptID = next.activePromptID;
    saved.queue = next.queue;
    saved.agentStatus = next.agentStatus;
    saved.turnGeneration = next.turnGeneration;
    saved.lastSeqByStream = next.lastSeqByStream;
    saved.currentStreamID = next.currentStreamID;
  }

  function rekeyAcceptanceRow(state, serverID, keepUnknown) {
    const tempID = state.tempID;
    if (tempID === null) return false;
    const targetID = state.sessionID;
    const active = targetID !== null && targetID === sessionId;
    const baseStore = active ? store : targetID === null ? null : savedStoreFor(targetID);
    if (baseStore === null) return false;
    const oldRecord = baseStore.messages.get(tempID);
    if (oldRecord === undefined) return false;
    const oldPartIDs = [...oldRecord.partOrder];
    const buffered = state.bufferedEvents;
    const result = rekeyOptimistic(baseStore, {
      tempID,
      serverID,
      bufferedEvents: buffered,
      sessionStatusType: active ? sessionStatusType() : statusTypeOf(baseStore.agentStatus),
    });
    const record = result.store.messages.get(serverID);
    if (record === undefined) return false;
    if (keepUnknown) record.optimistic = "unknown";
    if (record.role === "user") markOptimisticOperator(record);
    const activatedAt = promptActivation.get(tempID);
    if (activatedAt !== undefined) {
      promptActivation.delete(tempID);
      promptActivation.set(serverID, activatedAt);
    }
    if (active) {
      store = result.store;
      rekeyMessageDom(tempID, serverID, oldPartIDs, record);
      dirtyMessages.add(serverID);
      orderDirty = true;
      for (const partID of record.partOrder) {
        partOwner.set(partID, serverID);
        dirtyParts.add(partID);
      }
      recomputeQueue();
      applyBufferedLeftovers(buffered, serverID);
      scheduleFlush();
    } else if (targetID !== null) {
      commitSavedStore(targetID, result.store);
    }
    state.tempID = null;
    state.serverID = serverID;
    state.bufferedEvents = [];
    return true;
  }

  function stateTargetsActiveSession(state) {
    return state.sessionID === sessionId;
  }

  function activeRowFor(state, id) {
    if (stateTargetsActiveSession(state)) return store.messages.get(id);
    if (state.sessionID === null) return null;
    const saved = sessionRuntime.get(state.sessionID);
    return saved === undefined ? undefined : saved.messages.get(id);
  }

  function removeAcceptanceRow(state, id) {
    if (stateTargetsActiveSession(state)) {
      removeStoredMessage(id);
      return;
    }
    const saved = state.sessionID === null ? undefined : sessionRuntime.get(state.sessionID);
    if (saved === undefined) return;
    saved.messages.delete(id);
    saved.order = saved.order.filter((item) => item !== id);
    saved.queue = saved.queue.filter((item) => item !== id);
    if (saved.activePromptID === id) saved.activePromptID = null;
  }

  function moveAcceptance(fromKey, toKey) {
    if (fromKey === toKey) return;
    const state = acceptanceBySession.get(fromKey);
    if (state === undefined) return;
    acceptanceBySession.delete(fromKey);
    acceptanceBySession.set(toKey, state);
  }

  function markAllDirty() {
    dirtyMessages = new Set(store.order);
    dirtyParts = new Set();
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined) continue;
      for (const partID of record.partOrder) {
        dirtyParts.add(partID);
        partOwner.set(partID, id);
      }
    }
    orderDirty = true;
  }

  function applyPendingDeltas() {
    if (store.pendingDeltas.size === 0) return;
    for (const [partID, delta] of store.pendingDeltas) {
      const messageID = partOwner.get(partID);
      if (messageID === undefined) continue;
      const record = store.messages.get(messageID);
      const part = record === undefined ? undefined : record.parts.get(partID);
      if (part === undefined || part.sealed === true) continue;
      const data = partDataOf(part);
      data.text = (typeof data.text === "string" ? data.text : "") + delta;
      part.version += 1;
      dirtyParts.add(partID);
    }
    store.pendingDeltas.clear();
  }

  function syncMessageOrder() {
    if (messagesEl === null) return;
    const desired = [];
    for (const id of store.order) {
      const node = messageNodes.get(id);
      if (node !== undefined && node.parentNode === messagesEl) desired.push(node);
    }
    const current = Array.from(messagesEl.children).filter((child) =>
      child.classList.contains("message"),
    );
    if (
      current.length === desired.length &&
      current.every((node, index) => node === desired[index])
    ) {
      return;
    }
    for (const child of Array.from(messagesEl.children)) {
      if (!child.classList.contains("message")) child.remove();
    }
    for (const node of desired) messagesEl.append(node);
  }

  function renderDirty(full, force) {
    const throttled = new Set();
    if (full) {
      const wanted = new Set(store.order);
      for (const [id, node] of messageNodes) {
        if (!wanted.has(id)) {
          node.remove();
          messageNodes.delete(id);
        }
      }
      for (const [key, node] of partNodes) {
        const separator = key.indexOf(":");
        const messageID = separator < 0 ? "" : key.slice(0, separator);
        if (wanted.has(messageID)) continue;
        const partID = separator < 0 ? key : key.slice(separator + 1);
        resetHighlightController({ reason: "part-removed", partID });
        node.remove();
        partNodes.delete(key);
        partRenderState.delete(key);
      }
      for (const id of store.order) {
        const record = store.messages.get(id);
        if (record === undefined) continue;
        const validParts = new Set(record.partOrder);
        for (const [key, node] of partNodes) {
          if (!key.startsWith(`${id}:`)) continue;
          const partID = key.slice(id.length + 1);
          if (validParts.has(partID)) continue;
          resetHighlightController({ reason: "part-removed", partID });
          node.remove();
          partNodes.delete(key);
          partRenderState.delete(key);
          partOwner.delete(partID);
        }
        const node = ensureMessageNode(record);
        if (node === null) continue;
        for (const partID of record.partOrder) {
          const part = record.parts.get(partID);
          if (part === undefined) continue;
          if (!ensurePartNode(record, part, force)) throttled.add(partID);
        }
        syncPartOrder(record, node);
      }
    } else {
      const rendered = new Set();
      for (const id of dirtyMessages) {
        const record = store.messages.get(id);
        if (record === undefined) continue;
        const node = ensureMessageNode(record);
        if (node === null) continue;
        for (const partID of record.partOrder) {
          const part = record.parts.get(partID);
          if (part === undefined) continue;
          if (!ensurePartNode(record, part, force)) throttled.add(partID);
          rendered.add(partID);
        }
        syncPartOrder(record, node);
      }
      for (const partID of dirtyParts) {
        if (rendered.has(partID)) continue;
        const messageID = partOwner.get(partID);
        if (messageID === undefined) continue;
        const record = store.messages.get(messageID);
        if (record === undefined) continue;
        const part = record.parts.get(partID);
        if (part === undefined) continue;
        const node = ensureMessageNode(record);
        if (node === null) continue;
        if (!ensurePartNode(record, part, force)) throttled.add(partID);
        syncPartOrder(record, node);
      }
    }
    if (full || orderDirty) syncMessageOrder();
    if (messagesEl !== null) {
      const messages = messagesEl.querySelectorAll(".message");
      if (messages.length === 0 && store.order.length === 0) {
        messagesEl.replaceChildren(emptyThread());
      } else if (messages.length > 0) {
        for (const child of Array.from(messagesEl.children)) {
          if (!child.classList.contains("message")) child.remove();
        }
      }
    }
    return throttled;
  }

  function isAtBottom() {
    if (scrollEl === null) return true;
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  }

  function captureScrollAnchor(force = false) {
    if (scrollEl === null) return null;
    if (!force && isAtBottom()) return null;
    const top = scrollEl.getBoundingClientRect().top;
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined) continue;
      for (const partID of record.partOrder) {
        const node = partNodes.get(`${id}:${partID}`);
        if (node === undefined) continue;
        const rect = node.getBoundingClientRect();
        if (rect.bottom > top + 1) return { messageID: id, partID, offset: rect.top - top };
      }
      const messageNode = messageNodes.get(id);
      if (messageNode === undefined) continue;
      const rect = messageNode.getBoundingClientRect();
      if (rect.bottom > top + 1) return { messageID: id, partID: null, offset: rect.top - top };
    }
    return null;
  }

  function restoreScrollAnchor(anchor) {
    if (anchor === null || scrollEl === null) return;
    const node =
      anchor.partID === null
        ? messageNodes.get(anchor.messageID)
        : partNodes.get(`${anchor.messageID}:${anchor.partID}`);
    if (node === undefined) return;
    const top = node.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
    scrollEl.scrollTop += top - anchor.offset;
  }

  function scheduleFlush() {
    if (document.hidden) {
      flushPending = true;
      return;
    }
    if (flushHandle !== null) return;
    flushHandle = window.requestAnimationFrame(() => {
      flushHandle = null;
      flushFrame({});
    });
  }

  function scheduleFlushAt(delay) {
    if (flushTimer !== null) return;
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      scheduleFlush();
    }, delay);
  }

  function flushFrame(options) {
    if (messagesEl === null) return;
    const settings = options || {};
    const prepend = settings.prepend === true;
    if (document.hidden) {
      flushPending = true;
      if (prepend) prependPending = true;
      return;
    }
    const force = forceFinalRender;
    forceFinalRender = false;
    applyPendingDeltas();
    updateWorkingStatus();
    const atBottom = prepend ? false : isAtBottom();
    const anchor = prepend
      ? captureScrollAnchor(true)
      : atBottom
        ? null
        : captureScrollAnchor();
    const previousCount = lastRenderedCount;
    const full = settings.full === true;
    if (full) markAllDirty();
    const throttled = renderDirty(full, force);
    messagesEl.removeAttribute("aria-busy");
    const count = store.order.length;
    if (countEl !== null) {
      const label = messageCountLabel(count);
      if (countEl.textContent !== label) countEl.textContent = label;
    }
    if (!prepend && (settings.forceBottom === true || atBottom)) {
      if (scrollEl !== null) scrollEl.scrollTop = scrollEl.scrollHeight;
      if (newMessages !== null) newMessages.hidden = true;
    } else {
      restoreScrollAnchor(anchor);
      if (!prepend && count > previousCount && newMessages !== null) newMessages.hidden = false;
    }
    lastRenderedCount = count;
    dirtyMessages = new Set();
    if (throttled.size > 0) {
      dirtyParts = throttled;
      scheduleFlushAt(MARKDOWN_THROTTLE_MS);
    } else {
      dirtyParts = new Set();
    }
    orderDirty = false;
  }

  function closeStream() {
    if (eventSource !== null) {
      eventSource.close();
      eventSource = null;
    }
    if (reconcileTimer !== null) {
      window.clearTimeout(reconcileTimer);
      reconcileTimer = null;
    }
    if (idleReconcileTimer !== null) {
      window.clearTimeout(idleReconcileTimer);
      idleReconcileTimer = null;
    }
  }

  function subscribe() {
    closeStream();
    failures = 0;
    if (!("EventSource" in window)) {
      setConnection("Paused", "paused");
      return;
    }
    eventSource = new EventSource(eventsUrl());
    eventSource.onopen = () => {
      failures = 0;
      setConnection("Live", "live");
    };
    eventSource.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        void error;
        return;
      }
      handleStreamEvent(payload);
    };
    eventSource.onerror = () => {
      failures += 1;
      if (failures >= 3) {
        closeStream();
        setConnection("Paused", "paused");
        renderPlan();
      } else {
        setConnection("Reconnecting", "reconnecting");
      }
    };
  }

  function scheduleReconcile(delay) {
    if (reconcileTimer !== null) return;
    reconcileTimer = window.setTimeout(() => {
      reconcileTimer = null;
      hydrateMessages({ reason: "reconcile", silent: true }).catch(() => {});
    }, delay === undefined ? RECONCILE_MS : delay);
  }

  function scheduleIdleReconcile() {
    if (idleReconcileTimer !== null) window.clearTimeout(idleReconcileTimer);
    idleReconcileTimer = window.setTimeout(() => {
      idleReconcileTimer = null;
      hydrateMessages({ reason: "idle", silent: true }).catch(() => {});
    }, IDLE_RECONCILE_MS);
  }

  function requestFollowUpHydration() {
    followUpHydration = true;
    if (currentStatusType() !== "busy" && currentStatusType() !== "retry") {
      followUpHydration = false;
      scheduleReconcile(200);
    }
  }

  function sealAllParts() {
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined) continue;
      for (const partID of record.partOrder) {
        const part = record.parts.get(partID);
        if (part === undefined) continue;
        part.sealed = true;
        dirtyParts.add(partID);
        dirtyMessages.add(id);
      }
    }
    forceFinalRender = true;
    scheduleFlush();
  }

  function ensureLiveMessage(id, role) {
    let record = store.messages.get(id);
    let created = false;
    if (record === undefined) {
      record = {
        id,
        role,
        partOrder: [],
        parts: new Map(),
        version: 1,
      };
      store.messages.set(id, record);
      store.order.push(id);
      created = true;
      orderDirty = true;
    } else if (record.role !== role) {
      record.role = role;
      record.version += 1;
    }
    dirtyMessages.add(id);
    return { record, created };
  }

  function ensurePartMessage(id) {
    let record = store.messages.get(id);
    if (record === undefined) {
      record = ensureLiveMessage(id, "assistant").record;
    } else {
      dirtyMessages.add(id);
    }
    return record;
  }

  function sameOmoMeta(left, right) {
    if (left === right) return true;
    if (left === undefined || right === undefined || left === null || right === null) return false;
    if (
      left.kind !== right.kind ||
      left.tone !== right.tone ||
      left.title !== right.title ||
      left.body !== right.body
    ) {
      return false;
    }
    const leftHeaders = Array.isArray(left.headers) ? left.headers : [];
    const rightHeaders = Array.isArray(right.headers) ? right.headers : [];
    return (
      leftHeaders.length === rightHeaders.length &&
      leftHeaders.every((header, index) => header === rightHeaders[index])
    );
  }

  function clearOmoClassifyTimer(id) {
    const timer = omoClassifyTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      omoClassifyTimers.delete(id);
    }
  }

  function clearAllOmoClassifyTimers() {
    for (const timer of omoClassifyTimers.values()) window.clearTimeout(timer);
    omoClassifyTimers.clear();
  }

  function markOptimisticOperator(record) {
    clearOmoClassifyTimer(record.id);
    delete record.classificationPending;
    delete record.system;
  }

  function classifyLiveUserMessage(record) {
    if (record === undefined || record.role !== "user") return;
    clearOmoClassifyTimer(record.id);
    if (isOptimisticRecord(record)) {
      markOptimisticOperator(record);
      return;
    }
    const parts = [];
    for (const partID of record.partOrder) {
      const part = record.parts.get(partID);
      if (part === undefined) continue;
      const data = partDataOf(part);
      parts.push({ ...data, id: part.id, type: part.type });
    }
    const system = classifyOmo({ info: { id: record.id, role: "user" }, parts });
    let changed = false;
    if (system === null) {
      if (record.system !== undefined) {
        delete record.system;
        changed = true;
      }
    } else if (!sameOmoMeta(record.system, system)) {
      record.system = system;
      changed = true;
    }
    if (record.classificationPending === true) {
      delete record.classificationPending;
      changed = true;
    }
    if (changed) {
      record.version += 1;
      dirtyMessages.add(record.id);
    }
    recomputeQueue();
    scheduleFlush();
  }

  function scheduleUserClassification(record) {
    if (record === undefined || record.role !== "user") return;
    if (isOptimisticRecord(record)) {
      markOptimisticOperator(record);
      return;
    }
    clearOmoClassifyTimer(record.id);
    if (!hasCompleteTextSnapshot(record)) return;
    const id = record.id;
    const timer = window.setTimeout(() => {
      omoClassifyTimers.delete(id);
      classifyLiveUserMessage(store.messages.get(id));
    }, OMO_CLASSIFY_QUIET_MS);
    omoClassifyTimers.set(id, timer);
  }

  function flushPendingUserClassifications() {
    clearAllOmoClassifyTimers();
    for (const id of [...store.order]) {
      const record = store.messages.get(id);
      if (record === undefined || record.role !== "user") continue;
      if (record.classificationPending !== true) continue;
      classifyLiveUserMessage(record);
    }
  }

  function applyAgentStatus(payload) {
    if (typeof payload.sessionID !== "string") return;
    if (payload.sessionID !== sessionId) {
      let runtime = sessionRuntime.get(payload.sessionID);
      if (runtime === undefined) {
        runtime = {};
        sessionRuntime.set(payload.sessionID, runtime);
      }
      runtime.agentStatus = payload.status;
      if (runtime.historyCursor === undefined) runtime.historyCursor = null;
      if (runtime.historyLoaded === undefined) runtime.historyLoaded = false;
      return;
    }
    const previous = currentStatusType();
    const next = payload.status && typeof payload.status === "object" ? payload.status : null;
    const nextType = next !== null && typeof next.type === "string" ? next.type : undefined;
    if (nextType !== previous && (nextType === "busy" || nextType === "idle")) {
      store.turnGeneration += 1;
    }
    if (nextType === "busy" || nextType === "retry") notePromptActivation();
    store.agentStatus = next;
    if (nextType === "idle") {
      flushPendingUserClassifications();
      sealAllParts();
      recomputeQueue();
      if (followUpHydration) {
        followUpHydration = false;
      }
      scheduleIdleReconcile();
    } else {
      recomputeQueue();
      updateWorkingStatus();
    }
    scheduleFlush();
  }

  function bufferHydrationEvent(payload) {
    if (!hydrating || hydrationBuffer === null) return false;
    const type = payload.type;
    if (
      type !== "message.updated" &&
      type !== "message.part.updated" &&
      type !== "message.part.delta" &&
      type !== "message.part.omitted" &&
      type !== "session.status"
    ) {
      return false;
    }
    if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) return false;
    let size = 0;
    try {
      size = JSON.stringify(payload).length * 2;
    } catch (error) {
      void error;
    }
    if (
      hydrationBuffer.events.length >= HYDRATION_BUFFER_EVENTS ||
      hydrationBuffer.bytes + size > HYDRATION_BUFFER_BYTES
    ) {
      hydrationBuffer.overflow = true;
      hydrationBuffer.contentDiscarded = true;
      return true;
    }
    hydrationBuffer.events.push(payload);
    hydrationBuffer.bytes += size;
    if (type !== "session.status") hydrationBuffer.contentDiscarded = true;
    return true;
  }

  function handleStreamReady(payload) {
    const streamID = typeof payload.streamID === "string" ? payload.streamID : null;
    const changed = streamID !== null && streamID !== store.currentStreamID;
    if (streamID !== null) {
      store.currentStreamID = streamID;
      store.lastSeqByStream = new Map([[streamID, 0]]);
    }
    if (hasStreamReady) announce("Reconnected.");
    hasStreamReady = true;
    setConnection("Live", "live");
    refreshRuntime().catch(() => {});
    refreshCommands({ force: true, quiet: true }).catch(() => {});
    refreshContext(sessionId, { retryNotRunning: true }).catch(() => {});
    hydrate({ reconnect: true }).catch(() => {});
    hydrateMessages({ reason: changed ? "reconnect" : "ready", silent: true }).catch(() => {});
  }

  function envelopeAccepted(payload) {
    const streamID = typeof payload.streamID === "string" ? payload.streamID : null;
    const seq = typeof payload.seq === "number" ? payload.seq : null;
    if (streamID !== null) {
      if (store.currentStreamID !== streamID) {
        store.currentStreamID = streamID;
        store.lastSeqByStream = new Map([[streamID, 0]]);
        scheduleReconcile(RECONCILE_MS);
      }
      if (seq !== null) {
        const last = store.lastSeqByStream.get(streamID) || 0;
        if (seq <= last) return false;
        if (last > 0 && seq > last + 1) scheduleReconcile(RECONCILE_MS);
        store.lastSeqByStream.set(streamID, seq);
      }
    }
    return true;
  }

  function handleStreamEvent(payload) {
    if (payload === null || typeof payload !== "object") return;
    const type = payload.type;
    if (type === "stream.ready") {
      handleStreamReady(payload);
      return;
    }
    if (!envelopeAccepted(payload)) return;

    if (type === "stream.warning") {
      announce("Live updates were interrupted; refreshing.");
      scheduleReconcile(RECONCILE_MS);
      return;
    }

    if (type === "message.updated") {
      if (bufferHydrationEvent(payload)) return;
      if (typeof payload.messageID !== "string") return;
      if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) return;
      if (payload.role === "user" && bufferPre202(payload)) return;
      const role = payload.role === "user" ? "user" : "assistant";
      const existing = store.messages.get(payload.messageID);
      const wasUser = existing !== undefined && existing.role === "user";
      const { record } = ensureLiveMessage(payload.messageID, role);
      record.role = role;
      if (role === "user") {
        if (isOptimisticRecord(record)) markOptimisticOperator(record);
        else if (existing === undefined || !wasUser) {
          record.classificationPending = true;
          scheduleUserClassification(record);
        }
      }
      if (typeof payload.parentID === "string") record.parentID = payload.parentID;
      if (typeof payload.finish === "string") record.finish = payload.finish;
      if (payload.time && typeof payload.time === "object") record.time = payload.time;
      record.version += 1;
      recomputeQueue();
      scheduleFlush();
      return;
    }

    if (type === "message.part.updated") {
      if (bufferHydrationEvent(payload)) return;
      if (typeof payload.messageID !== "string" || typeof payload.partID !== "string") return;
      if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) return;
      if (bufferPre202(payload)) return;
      const partType =
        typeof payload.partType === "string"
          ? payload.partType
          : payload.part && typeof payload.part.type === "string"
            ? payload.part.type
            : "text";
      const record = ensurePartMessage(payload.messageID);
      if (record.role === "user" && partType === "text") {
        const placeholder = userPlaceholderPartID(record);
        if (placeholder !== null && placeholder !== payload.partID) {
          const replacement = record.parts.get(placeholder);
          if (replacement !== undefined) {
            record.parts.delete(placeholder);
            record.parts.set(payload.partID, replacement);
            record.partOrder = record.partOrder.map((partID) =>
              partID === placeholder ? payload.partID : partID,
            );
            renamePartKey(record.id, placeholder, payload.partID);
          }
        }
      }
      const data =
        payload.part && typeof payload.part === "object" ? { ...payload.part } : { id: payload.partID };
      data.id = payload.partID;
      data.type = partType;
      let part = record.parts.get(payload.partID);
      if (part === undefined) {
        part = {
          id: payload.partID,
          type: partType,
          data,
          provisional: false,
          partial: payload.truncated !== undefined,
          sealed: false,
          version: 1,
        };
        record.parts.set(payload.partID, part);
        record.partOrder.push(payload.partID);
        partOwner.set(payload.partID, record.id);
        orderDirty = true;
      } else {
        part.id = payload.partID;
        part.type = partType;
        part.data = data;
        part.version += 1;
        part.provisional = false;
      }
      if (payload.truncated !== undefined) part.partial = true;
      if (payload.truncated !== undefined) part.truncation = payload.truncated;
      else delete part.truncation;
      part.omitted = false;
      store.pendingDeltas.delete(payload.partID);
      if (!KNOWN_PART_TYPES.has(partType)) {
        record.needsReconcile = true;
        scheduleReconcile(RECONCILE_MS);
      }
      if (record.role === "user") scheduleUserClassification(record);
      dirtyMessages.add(record.id);
      dirtyParts.add(payload.partID);
      recomputeQueue();
      scheduleFlush();
      return;
    }

    if (type === "message.part.delta") {
      if (bufferHydrationEvent(payload)) return;
      if (
        typeof payload.messageID !== "string" ||
        typeof payload.partID !== "string" ||
        typeof payload.delta !== "string" ||
        payload.delta.length === 0
      ) {
        return;
      }
      if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) return;
      if (bufferPre202(payload)) return;
      const record = ensurePartMessage(payload.messageID);
      if (record.role === "user" && userPlaceholderPartID(record) !== null) return;
      let part = record.parts.get(payload.partID);
      if (part === undefined) {
        part = {
          id: payload.partID,
          type: "text",
          data: { id: payload.partID, type: "text", text: "", provisional: true },
          provisional: true,
          partial: false,
          sealed: false,
          version: 1,
        };
        record.parts.set(payload.partID, part);
        record.partOrder.push(payload.partID);
        partOwner.set(payload.partID, record.id);
        orderDirty = true;
      }
      if (part.sealed === true) return;
      if (record.role === "user" && part.provisional === true) return;
      const queued = store.pendingDeltas.get(payload.partID) || "";
      store.pendingDeltas.set(payload.partID, queued + payload.delta);
      dirtyMessages.add(record.id);
      dirtyParts.add(payload.partID);
      scheduleFlush();
      return;
    }

    if (type === "message.part.omitted") {
      if (bufferHydrationEvent(payload)) return;
      if (typeof payload.messageID !== "string" || typeof payload.partID !== "string") return;
      if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) return;
      if (bufferPre202(payload)) return;
      const record = ensurePartMessage(payload.messageID);
      let part = record.parts.get(payload.partID);
      if (part === undefined) {
        const partType = typeof payload.partType === "string" ? payload.partType : "text";
        part = {
          id: payload.partID,
          type: partType,
          data: {
            id: payload.partID,
            type: partType,
            text: "",
            provisional: partType === "text",
          },
          provisional: partType === "text",
          partial: true,
          sealed: false,
          version: 1,
        };
        record.parts.set(payload.partID, part);
        record.partOrder.push(payload.partID);
        partOwner.set(payload.partID, record.id);
        orderDirty = true;
      }
      part.partial = true;
      part.omitted = true;
      omittedPartIDs.add(payload.partID);
      for (const entry of prompts.values()) {
        if (!isCorrelatedQuestion(entry)) continue;
        if (entry.request.tool.callID === payload.partID) {
          inlineUnavailable.add(questionCorrelationKey(entry.request));
        }
      }
      record.needsReconcile = true;
      dirtyMessages.add(record.id);
      dirtyParts.add(payload.partID);
      scheduleReconcile(RECONCILE_MS);
      scheduleFlush();
      if (payload.sessionID === sessionId) refreshInlineQuestions();
      return;
    }

    if (type === "session.error") {
      if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) return;
      const rawMessage = typeof payload.message === "string" ? payload.message.trim() : "";
      const message =
        rawMessage.length > 0 ? rawMessage : "The agent failed without an error message.";

      const acceptance = activeAcceptance();
      const failedIDs = new Set();
      if (typeof store.activePromptID === "string") failedIDs.add(store.activePromptID);
      for (const id of store.queue) failedIDs.add(id);
      if (typeof acceptance.serverID === "string") failedIDs.add(acceptance.serverID);
      if (typeof acceptance.tempID === "string") failedIDs.add(acceptance.tempID);
      for (const id of failedIDs) {
        const record = store.messages.get(id);
        if (record === undefined || record.role !== "user") continue;
        record.optimistic = "failed";
        record.version += 1;
        dirtyMessages.add(id);
      }
      if (acceptance.state === "sending" || acceptance.state === "unknown") {
        acceptance.state = "idle";
        acceptance.inFlight = false;
        acceptance.posting = false;
        acceptance.tempID = null;
        acceptance.serverID = null;
        clearAcceptanceGrace(acceptance);
      }
      recomputeQueue();
      syncComposer();

      const streamID = typeof payload.streamID === "string" ? payload.streamID : "";
      const seq = typeof payload.seq === "number" ? payload.seq : undefined;
      const errorID = `local_error_${streamID || "stream"}_${seq ?? Date.now()}`;
      if (!store.messages.has(errorID)) {
        const partID = `${errorID}:part:text`;
        const part = {
          id: partID,
          type: "text",
          data: { id: partID, type: "text", text: `**Agent error:** ${message}` },
          provisional: false,
          partial: false,
          sealed: true,
          version: 1,
        };
        const record = {
          id: errorID,
          role: "assistant",
          provisional: false,
          partial: false,
          sealed: true,
          time: { created: Date.now() },
          partOrder: [partID],
          parts: new Map([[partID, part]]),
          version: 1,
        };
        store.messages.set(errorID, record);
        store.order.push(errorID);
        partOwner.set(partID, errorID);
        orderDirty = true;
        dirtyMessages.add(errorID);
      }

      if (currentStatusType() !== "idle") {
        applyAgentStatus({ sessionID: payload.sessionID, status: { type: "idle" } });
      } else {
        recomputeQueue();
        scheduleFlush();
      }

      announce("The agent failed; details are in the chat.");
      const toastMessage = message.length > 180 ? `${message.slice(0, 179)}…` : message;
      showToast(`Agent error: ${toastMessage}`, "error");
      refreshContext(sessionId).catch(() => {});
      return;
    }

    if (type === "session.compacted") {
      if (typeof payload.sessionID !== "string" || payload.sessionID !== sessionId) return;
      clearContextTimers();
      announce("Session compacted.");
      showToast("Session compacted.", "success");
      refreshContext(sessionId).catch(() => {});
      return;
    }

    if (type === "session.status") {
      if (bufferHydrationEvent(payload)) return;
      applyAgentStatus(payload);
      if (payload.sessionID === sessionId) refreshContext(sessionId).catch(() => {});
      return;
    }

    if (type === "session.activity") {
      if (typeof payload.sessionID === "string" && payload.sessionID !== sessionId) return;
      const cause = payload.cause;
      if (cause === "message" || cause === "status") return;
      scheduleReconcile(RECONCILE_MS);
      return;
    }

    if (type === "question.asked" || type === "permission.asked") {
      promptEventSeq += 1;
      promptEventLog.push({ seq: promptEventSeq, event: payload });
      if (promptEventLog.length > 100) promptEventLog.shift();
      const request = payload.request;
      if (!request || typeof request !== "object" || typeof request.id !== "string") return;
      const key = requestKey(request);
      tombstones.delete(key);
      const kind = type === "question.asked" ? "question" : "permission";
      if (kind === "question") {
        promptOutcomes.delete(key);
        if (validToolRef(request)) {
          const correlationKey = questionCorrelationKey(request);
          if (omittedPartIDs.has(request.tool.callID)) {
            inlineUnavailable.add(correlationKey);
          } else {
            inlineUnavailable.delete(correlationKey);
          }
          correlationQuestionKeys.set(correlationKey, key);
        }
      }
      if (!prompts.has(key)) promptSeen.set(key, Date.now());
      prompts.set(key, { key, kind, request });
      if (request.sessionID === sessionId) {
        renderPromptDock();
        refreshInlineQuestions();
        announce(kind === "question" ? "The agent has a question." : "The agent needs permission.");
      }
      syncComposer();
      renderQueue();
      return;
    }

    if (type === "question.replied" || type === "question.rejected") {
      promptEventSeq += 1;
      promptEventLog.push({ seq: promptEventSeq, event: payload });
      if (promptEventLog.length > 100) promptEventLog.shift();
      const key = `${payload.source}:${payload.requestID}`;
      if (promptBusy.has(key)) return;
      const existingOutcome = promptOutcomes.get(key);
      if (existingOutcome !== undefined && existingOutcome.local === true) return;
      const wasOpen = prompts.has(key);
      const closedEntry = prompts.get(key);
      if (type === "question.rejected") {
        recordQuestionOutcome(key, {
          kind: "dismissed",
          answers: null,
          questions: closedEntry === undefined ? undefined : closedEntry.request.questions,
        });
      } else {
        recordQuestionOutcome(key, {
          kind: "answered",
          elsewhere: true,
          answers: null,
          questions: closedEntry === undefined ? undefined : closedEntry.request.questions,
        });
      }
      recordTombstone(key);
      prompts.delete(key);
      if (wasOpen) {
        const message = type === "question.rejected" ? "Question dismissed." : "Answered elsewhere.";
        announce(message);
        showToast(message, "success");
      }
      if (payload.sessionID === sessionId) {
        renderPromptDock();
        refreshInlineQuestions();
      }
      syncComposer();
      renderQueue();
      return;
    }

    if (type === "permission.replied") {
      promptEventSeq += 1;
      promptEventLog.push({ seq: promptEventSeq, event: payload });
      if (promptEventLog.length > 100) promptEventLog.shift();
      const key = `${payload.source}:${payload.requestID}`;
      const wasOpen = prompts.has(key) && !promptBusy.has(key);
      recordTombstone(key);
      prompts.delete(key);
      if (wasOpen) {
        announce("Answered elsewhere.");
        showToast("Answered elsewhere.", "success");
      }
      if (payload.sessionID === sessionId) renderPromptDock();
      syncComposer();
      renderQueue();
      return;
    }

    if (type === "todo.updated" && typeof payload.sessionID === "string") {
      const previous = todoEventSeq.get(payload.sessionID) || 0;
      todoEventSeq.set(payload.sessionID, previous + 1);
      todoCache.set(payload.sessionID, {
        todos: Array.isArray(payload.todos) ? payload.todos : [],
        truncated: payload.truncated === true,
      });
      if (payload.sessionID === sessionId) {
        todoState = "ready";
        renderPlan();
      }
      return;
    }
  }

  function replayPromptEvents(startSeq) {
    const oldest = promptEventLog.length > 0 ? promptEventLog[0].seq : promptEventSeq + 1;
    if (oldest > startSeq + 1) return false;
    for (const entry of promptEventLog) {
      if (entry.seq <= startSeq) continue;
      const payload = entry.event;
      if (payload.type === "question.asked" || payload.type === "permission.asked") {
        const request = payload.request;
        if (!request || typeof request.id !== "string") continue;
        const key = requestKey(request);
        tombstones.delete(key);
        prompts.set(key, {
          key,
          kind: payload.type === "question.asked" ? "question" : "permission",
          request,
        });
      } else if (
        payload.type === "question.replied" ||
        payload.type === "question.rejected" ||
        payload.type === "permission.replied"
      ) {
        const key = `${payload.source}:${payload.requestID}`;
        const existingOutcome = promptOutcomes.get(key);
        const closedEntry = prompts.get(key);
        if (existingOutcome === undefined || existingOutcome.local !== true) {
          if (payload.type === "question.rejected") {
            recordQuestionOutcome(key, {
              kind: "dismissed",
              answers: null,
              questions: closedEntry === undefined ? undefined : closedEntry.request.questions,
            });
          } else if (payload.type === "question.replied") {
            recordQuestionOutcome(key, {
              kind: "answered",
              elsewhere: true,
              answers: null,
              questions: closedEntry === undefined ? undefined : closedEntry.request.questions,
            });
          }
        }
        recordTombstone(key);
        prompts.delete(key);
      }
    }
    return true;
  }

  async function hydrate(options) {
    const settings = options || {};
    const sequence = ++promptHydrationSeq;
    const startSeq = promptEventSeq;
    const [promptResult, savedResult] = await Promise.allSettled([
      api(promptsUrl()),
      api(savedPermissionsUrl()),
    ]);
    if (sequence !== promptHydrationSeq) return;
    pruneTombstones();

    if (promptResult.status === "fulfilled") {
      const data = promptResult.value || {};
      const next = new Map();
      const questions = Array.isArray(data.questions) ? data.questions : [];
      const permissions = Array.isArray(data.permissions) ? data.permissions : [];
      for (const request of questions) {
        if (!request || typeof request.id !== "string") continue;
        const key = requestKey(request);
        if (tombstones.has(key)) continue;
        if (!promptSeen.has(key)) promptSeen.set(key, Date.now());
        next.set(key, { key, kind: "question", request });
      }
      for (const request of permissions) {
        if (!request || typeof request.id !== "string") continue;
        const key = requestKey(request);
        if (tombstones.has(key)) continue;
        if (!promptSeen.has(key)) promptSeen.set(key, Date.now());
        next.set(key, { key, kind: "permission", request });
      }
      if (!replayPromptEvents(startSeq) && !promptHydrationRetried) {
        promptHydrationRetried = true;
        window.setTimeout(() => {
          hydrate(settings).catch(() => {});
        }, 0);
        return;
      }
      promptHydrationRetried = false;
      promptStale = false;
      const previousCorrelated = new Map();
      for (const entry of prompts.values()) {
        if (isCorrelatedQuestion(entry)) {
          previousCorrelated.set(entry.key, {
            correlationKey: questionCorrelationKey(entry.request),
            questions: entry.request.questions,
          });
        }
      }
      prompts.clear();
      for (const [key, value] of next) prompts.set(key, value);
      for (const [key, previous] of previousCorrelated) {
        if (next.has(key) || tombstones.has(key) || promptOutcomes.has(key)) continue;
        const partInfo = findQuestionPartByCorrelation(previous.correlationKey);
        if (partInfo !== null && isTerminalQuestionPart(partInfo.part)) continue;
        recordQuestionOutcome(key, {
          kind: "expired",
          reason: "Request no longer pending",
          questions: previous.questions,
        });
      }
      for (const entry of next.values()) {
        if (!isCorrelatedQuestion(entry)) continue;
        const correlationKey = questionCorrelationKey(entry.request);
        correlationQuestionKeys.set(correlationKey, entry.key);
        if (entry.request.sessionID !== sessionId) continue;
        const partInfo = findQuestionPartForEntry(entry);
        if (partInfo !== null) {
          inlineUnavailable.delete(correlationKey);
        } else if (messagesHydratedSession === sessionId && !hydrating) {
          inlineUnavailable.add(correlationKey);
        } else {
          deferredUnavailable.add(correlationKey);
        }
      }
      applyPolicyWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      renderPromptDock();
      refreshInlineQuestions();
      renderQueue();
      syncComposer();
    } else {
      promptStale = true;
      applyPolicyWarnings(policyWarnings);
      if (promptDock !== null && activePromptEntries().length > 0) {
        promptDock.hidden = false;
        renderPromptDock();
      }
      refreshInlineQuestions();
    }

    if (savedResult.status === "fulfilled") {
      applySavedPermissions(savedResult.value);
    }

    if (sessionId !== null) {
      await loadTodo(sessionId).catch(() => {});
    }
  }

  function questionDraft(entry) {
    let draft = promptDrafts.get(entry.key);
    if (draft === undefined) {
      draft = {
        index: 0,
        answers: entry.request.questions.map(() => []),
        custom: entry.request.questions.map(() => ""),
        confirm: null,
        composing: false,
      };
      promptDrafts.set(entry.key, draft);
    }
    return draft;
  }

  function permissionDraft(entry) {
    let draft = promptDrafts.get(entry.key);
    if (draft === undefined) {
      draft = { confirm: null, feedback: "" };
      promptDrafts.set(entry.key, draft);
    }
    return draft;
  }

  function answersForQuestion(draft, index) {
    const selected = Array.isArray(draft.answers[index]) ? draft.answers[index].slice() : [];
    const custom = String(draft.custom[index] || "").trim();
    if (custom.length === 0) return selected;
    if (selected.includes(custom)) return selected;
    return [...selected, custom];
  }

  function questionAnswered(draft, index) {
    return answersForQuestion(draft, index).length > 0;
  }

  function questionNeedsReview(request) {
    return (
      request.questions.length > 1 ||
      (request.questions[0] !== undefined && request.questions[0].multiple === true)
    );
  }

  function unresolvedQuestions(entry, draft) {
    return entry.request.questions.filter((_, index) => !questionAnswered(draft, index)).length;
  }

  function primaryActionLabel(entry, draft) {
    if (promptBusy.has(entry.key)) return "Sending answer…";
    const steps = entry.request.questions.length;
    const needsReview = questionNeedsReview(entry.request);
    const isReview = needsReview && draft.index === steps;
    const error = promptErrors.has(entry.key);
    if (isReview) {
      return unresolvedQuestions(entry, draft) > 0
        ? "Send without answering"
        : error
          ? "Try again"
          : "Send answer";
    }
    if (needsReview) {
      if (draft.index < steps - 1) return "Next";
      const left = unresolvedQuestions(entry, draft);
      return left > 0 ? `Review · ${left} left` : "Review";
    }
    const empty = answersForQuestion(draft, draft.index).length === 0;
    return empty ? "Send without answering" : error ? "Try again" : "Send answer";
  }

  function questionPanelId(controller) {
    return controller.prefix.length > 0 ? `${controller.prefix}panel` : "chat-prompt-panel";
  }

  function questionHeadingId(controller) {
    return controller.prefix.length > 0 ? `${controller.prefix}title` : "chat-prompt-title";
  }

  function questionOptionName(controller, index) {
    return controller.prefix.length > 0
      ? `${controller.prefix}option-${index}`
      : `prompt-option-${index}`;
  }

  function questionCustomId(controller, index) {
    return controller.prefix.length > 0
      ? `${controller.prefix}custom-${index}`
      : `prompt-custom-${index}`;
  }

  function questionController(entry, options) {
    return {
      entry,
      scope: options.scope,
      prefix: options.prefix || "",
      inline: options.inline === true,
      correlationKey: options.correlationKey,
      rerender: options.rerender,
    };
  }

  function promptsAreStale() {
    return promptStale || (liveEl !== null && liveEl.dataset.state === "paused");
  }

  function syncQuestionChrome(controller, draft) {
    const scope = controller.scope;
    if (!(scope instanceof HTMLElement)) return;
    const primary = scope.querySelector("[data-prompt-primary]");
    if (primary !== null && !promptBusy.has(controller.entry.key)) {
      primary.textContent = primaryActionLabel(controller.entry, draft);
    }
    const reviewTab = scope.querySelector("[data-prompt-review-tab]");
    if (reviewTab !== null) {
      const left = unresolvedQuestions(controller.entry, draft);
      reviewTab.replaceChildren(
        document.createTextNode(left > 0 ? `Review · ${left} left` : "Review"),
      );
    }
    controller.entry.request.questions.forEach((_, index) => {
      const tab = scope.querySelector(`[data-prompt-tab="${index}"]`);
      if (tab === null) return;
      const answered = questionAnswered(draft, index);
      const check = tab.querySelector(".icon");
      if (answered && check === null) tab.append(iconNode("check", "icon--sm"));
      else if (!answered && check !== null) check.remove();
    });
  }

  function focusOption(controller, index, label) {
    const scope = controller.scope;
    if (!(scope instanceof HTMLElement)) return;
    for (const input of scope.querySelectorAll(`input[data-prompt-option-index="${index}"]`)) {
      if (input instanceof HTMLInputElement && input.value === label) {
        input.focus();
        return;
      }
    }
  }

  function patchQuestionSelections(controller, draft, index) {
    const scope = controller.scope;
    if (!(scope instanceof HTMLElement)) return;
    for (const input of scope.querySelectorAll(`input[data-prompt-option-index="${index}"]`)) {
      if (input instanceof HTMLInputElement) {
        input.checked = draft.answers[index].includes(input.value);
      }
    }
    const custom = scope.querySelector(`input[data-prompt-custom="${index}"]`);
    if (custom instanceof HTMLInputElement && custom.value !== draft.custom[index]) {
      custom.value = draft.custom[index] || "";
    }
    syncQuestionChrome(controller, draft);
  }

  function focusQuestionHeading(controller) {
    const scope = controller.scope;
    if (!(scope instanceof HTMLElement)) return;
    const heading = scope.querySelector("[data-question-heading]");
    if (heading instanceof HTMLElement) heading.focus();
  }

  function focusQuestionStep(controller, index, isReview) {
    const scope = controller.scope;
    if (!(scope instanceof HTMLElement)) return;
    if (isReview) {
      const primary = scope.querySelector("[data-prompt-primary]");
      if (primary instanceof HTMLElement) {
        primary.focus();
        return;
      }
      const reviewTab = scope.querySelector("[data-prompt-review-tab]");
      if (reviewTab instanceof HTMLElement) {
        reviewTab.focus();
        return;
      }
      focusQuestionHeading(controller);
      return;
    }
    const field = scope.querySelector(`[data-prompt-field="${index}"]`);
    const target =
      field instanceof HTMLElement
        ? field.querySelector("input, textarea")
        : scope.querySelector(`[data-prompt-tab="${index}"]`);
    if (target instanceof HTMLElement) target.focus();
    else focusQuestionHeading(controller);
  }

  function captureQuestionFocus(card) {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !card.contains(active)) return null;
    if (active.dataset.promptTab !== undefined) {
      return { kind: "tab", index: active.dataset.promptTab };
    }
    if (active.dataset.promptReviewTab !== undefined) return { kind: "review" };
    if (active.dataset.promptCustom !== undefined) {
      return { kind: "custom", index: active.dataset.promptCustom };
    }
    if (active.dataset.promptOptionIndex !== undefined) {
      return {
        kind: "option",
        index: active.dataset.promptOptionIndex,
        value: active.value,
      };
    }
    if (active.dataset.promptPrimary !== undefined) return { kind: "primary" };
    return { kind: "any" };
  }

  function restoreQuestionFocus(card, saved) {
    let target = null;
    if (saved.kind === "tab") {
      target = card.querySelector(`[data-prompt-tab="${saved.index}"]`);
    } else if (saved.kind === "review") {
      target = card.querySelector("[data-prompt-review-tab]");
    } else if (saved.kind === "custom") {
      target = card.querySelector(`[data-prompt-custom="${saved.index}"]`);
    } else if (saved.kind === "option") {
      for (const input of card.querySelectorAll(
        `input[data-prompt-option-index="${saved.index}"]`,
      )) {
        if (input instanceof HTMLInputElement && input.value === saved.value) {
          target = input;
          break;
        }
      }
    } else if (saved.kind === "primary") {
      target = card.querySelector("[data-prompt-primary]");
    }
    if (target instanceof HTMLElement) target.focus();
  }

  function focusComposer() {
    if (promptEl instanceof HTMLTextAreaElement) promptEl.focus();
  }

  function focusDock() {
    if (promptDock === null || promptDock.hidden) {
      focusComposer();
      return;
    }
    const target = promptDock.querySelector("h2, h3, button, input, textarea");
    if (target instanceof HTMLElement) target.focus();
    else focusComposer();
  }

  function focusQuestionEntry(entry) {
    if (!isCorrelatedQuestion(entry)) {
      focusDock();
      return;
    }
    const card = cardForQuestionEntry(entry);
    if (!(card instanceof HTMLElement)) {
      focusRequestFallback();
      return;
    }
    card.scrollIntoView({ block: "nearest" });
    const target = card.querySelector("[data-question-heading], input, textarea, button");
    if (target instanceof HTMLElement) target.focus();
    else focusComposer();
  }

  function focusRequestFallback() {
    if (activeDockEntries().length > 0) focusDock();
    else focusComposer();
  }

  function focusRequest() {
    const entries = activePromptEntries();
    const inline = entries.find((entry) => isCorrelatedQuestion(entry));
    if (inline !== undefined) {
      focusQuestionEntry(inline);
      return;
    }
    focusRequestFallback();
  }

  function draftForPromptEntry(entry) {
    return entry.kind === "question" ? questionDraft(entry) : permissionDraft(entry);
  }

  function cancelPromptStep() {
    const entries = activePromptEntries();
    if (entries.length === 0) return false;
    const focused = entries.find((entry) => {
      const card = cardForQuestionEntry(entry);
      return card instanceof HTMLElement && card.contains(document.activeElement);
    });
    const ordered = focused === undefined ? entries : [focused, ...entries.filter((entry) => entry !== focused)];
    for (const entry of ordered) {
      const draft = draftForPromptEntry(entry);
      if (draft.confirm !== null) {
        draft.confirm = null;
        renderPromptEntry(entry);
        if (entry.kind === "question") focusQuestionEntry(entry);
        else focusDock();
        return true;
      }
    }
    for (const entry of ordered) {
      if (entry.kind !== "question") continue;
      const draft = questionDraft(entry);
      const steps = entry.request.questions.length;
      const needsReview =
        steps > 1 || (entry.request.questions[0] !== undefined && entry.request.questions[0].multiple === true);
      if (needsReview && draft.index === steps) {
        draft.index = Math.max(0, steps - 1);
        renderPromptEntry(entry);
        focusQuestionEntry(entry);
        return true;
      }
    }
    return false;
  }

  function buildPromptHead(entry, label, metaText) {
    const head = element("div", "prompt-dock__head");
    const identity = element("div", "prompt-dock__identity");
    identity.append(element("p", "overline", label));
    if (metaText.length > 0) identity.append(element("span", "prompt-dock__count", metaText));
    const queueSize = Math.max(0, pendingForSession(entry.request.sessionID).length - 1);
    if (queueSize > 0) {
      identity.append(
        element(
          "span",
          "prompt-dock__queue-count",
          `${queueSize} more waiting`,
          ),
      );
    }
    if (promptStale || (liveEl !== null && liveEl.dataset.state === "paused")) {
      identity.append(element("span", "prompt-dock__queue-count", "Not updating"));
    }
    const collapse = element("button", "btn btn-ghost btn-icon btn-sm");
    collapse.type = "button";
    collapse.setAttribute("aria-expanded", dockCollapsed ? "false" : "true");
    collapse.setAttribute("aria-label", dockCollapsed ? "Expand request" : "Collapse request");
    collapse.title = dockCollapsed ? "Expand request" : "Collapse request";
    collapse.append(iconNode(dockCollapsed ? "chevron-right" : "chevron-down"));
    collapse.addEventListener("click", () => {
      dockCollapsed = !dockCollapsed;
      renderPromptDock();
      if (!composerHasDraft()) focusDock();
    });
    head.append(identity, collapse);
    return head;
  }

  function renderTabs(entry, draft, tabs, controller) {
    const tabsEl = element("div", "prompt-dock__tabs");
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Questions");
    const questions = entry.request.questions;
    const panelId = questionPanelId(controller);
    questions.forEach((question, index) => {
      const answered = questionAnswered(draft, index);
      const tab = element("button", "prompt-dock__tab");
      tab.type = "button";
      tab.dataset.promptTab = String(index);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", draft.index === index ? "true" : "false");
      tab.tabIndex = draft.index === index ? 0 : -1;
      tab.setAttribute("aria-controls", panelId);
      const label = question.header.trim().length > 0 ? question.header : `Question ${index + 1}`;
      tab.append(document.createTextNode(label));
      if (answered) tab.append(iconNode("check", "icon--sm"));
      tab.addEventListener("click", () => {
        draft.index = index;
        controller.rerender();
        focusTab(controller, index);
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const next = (index + delta + tabs) % tabs;
        draft.index = next;
        controller.rerender();
        focusTab(controller, next);
      });
      tabsEl.append(tab);
    });
    if (tabs > questions.length) {
      const left = questions.filter((_, index) => !questionAnswered(draft, index)).length;
      const review = element("button", "prompt-dock__tab prompt-dock__tab--review");
      review.type = "button";
      review.dataset.promptReviewTab = "true";
      review.setAttribute("role", "tab");
      review.setAttribute("aria-selected", draft.index === questions.length ? "true" : "false");
      review.setAttribute("aria-controls", panelId);
      review.tabIndex = draft.index === questions.length ? 0 : -1;
      review.append(
        document.createTextNode(left > 0 ? `Review · ${left} left` : "Review"),
      );
      review.addEventListener("click", () => {
        draft.index = questions.length;
        controller.rerender();
        focusTab(controller, questions.length);
      });
      tabsEl.append(review);
    }
    return tabsEl;
  }

  function focusTab(controller, index) {
    const scope = controller.scope;
    if (!(scope instanceof HTMLElement)) return;
    const tabs = Array.from(scope.querySelectorAll("[data-prompt-tab]"));
    const target = tabs.find((tab) => tab.dataset.promptTab === String(index));
    if (target instanceof HTMLElement) {
      target.focus();
      return;
    }
    if (index === controller.entry.request.questions.length) {
      const review = scope.querySelector("[data-prompt-review-tab]");
      if (review instanceof HTMLElement) {
        review.focus();
        return;
      }
    }
    const selected = scope.querySelector('[role="tab"][aria-selected="true"]');
    if (selected instanceof HTMLElement) selected.focus();
    else focusQuestionHeading(controller);
  }

  function buildQuestionField(entry, draft, index, controller) {
    const question = entry.request.questions[index];
    const fieldset = element("fieldset", "prompt-question");
    fieldset.id = questionPanelId(controller);
    fieldset.dataset.promptField = String(index);
    const legend = element("legend", "prompt-question__header");
    legend.tabIndex = -1;
    legend.dataset.questionHeading = "true";
    legend.textContent = question.header.trim().length > 0 ? question.header : `Question ${index + 1}`;
    fieldset.append(legend);
    fieldset.append(element("p", "prompt-question__text", question.question));
    const group = element("div", "prompt-options");
    const inputType = question.multiple ? "checkbox" : "radio";
    question.options.forEach((option) => {
      const label = element("label", "prompt-option");
      const input = element("input", question.multiple ? "checkbox" : "radio");
      input.type = inputType;
      input.name = questionOptionName(controller, index);
      input.value = option.label;
      input.checked = draft.answers[index].includes(option.label);
      input.dataset.promptOptionIndex = String(index);
      input.dataset.promptOptionValue = option.label;
      if (!question.multiple) input.dataset.single = "true";
      input.addEventListener("change", () => {
        if (question.multiple) {
          const current = draft.answers[index].filter((item) => item !== option.label);
          if (input.checked) current.push(option.label);
          draft.answers[index] = current;
        } else {
          draft.answers[index] = [option.label];
          draft.custom[index] = "";
        }
        const steps = entry.request.questions.length;
        const autoAdvance =
          question.multiple !== true &&
          steps > 1 &&
          draft.confirm === null &&
          draft.composing !== true;
        if (autoAdvance) {
          advanceQuestionStep(entry, controller, index + 1 >= steps ? steps : index + 1);
          return;
        }
        patchQuestionSelections(controller, draft, index);
        focusOption(controller, index, option.label);
      });
      const body = element("span", "prompt-option__body");
      body.append(element("span", "prompt-option__label", option.label));
      if (option.description.trim().length > 0) {
        body.append(element("span", "prompt-option__desc", option.description));
      }
      label.append(input, body);
      group.append(label);
    });
    fieldset.append(group);
    if (question.custom) {
      const custom = element("div", "prompt-custom");
      const customLabel = element("label", "label", "Other");
      customLabel.htmlFor = questionCustomId(controller, index);
      const customInput = element("input", "input");
      customInput.type = "text";
      customInput.id = questionCustomId(controller, index);
      customInput.dataset.promptCustom = String(index);
      customInput.value = draft.custom[index];
      customInput.placeholder = "Type a custom answer";
      customInput.addEventListener("compositionstart", () => {
        draft.composing = true;
      });
      customInput.addEventListener("compositionend", () => {
        draft.composing = false;
      });
      customInput.addEventListener("input", () => {
        draft.custom[index] = customInput.value;
        if (!question.multiple && customInput.value.trim().length > 0) {
          draft.answers[index] = [];
          for (const input of controller.scope.querySelectorAll(
            `input[data-prompt-option-index="${index}"]`,
          )) {
            if (input instanceof HTMLInputElement) input.checked = false;
          }
        }
        syncQuestionChrome(controller, draft);
      });
      customInput.addEventListener("keydown", (event) => {
        if (
          event.key !== "Enter" ||
          event.shiftKey ||
          event.isComposing ||
          event.metaKey ||
          event.ctrlKey
        ) {
          return;
        }
        event.preventDefault();
        if (draft.confirm !== null) return;
        runQuestionPrimaryAction(entry, controller);
      });
      custom.append(customLabel, customInput);
      fieldset.append(custom);
    }
    return fieldset;
  }

  function buildReview(entry, draft, controller) {
    const wrap = element("div", "prompt-dock__review");
    wrap.id = questionPanelId(controller);
    wrap.append(element("p", "overline", "Review answers"));
    const list = element("ol", "prompt-review-list");
    entry.request.questions.forEach((question, index) => {
      const item = element("li", "prompt-review");
      const body = element("div", "prompt-review__body");
      const header = question.header.trim().length > 0 ? question.header : `Question ${index + 1}`;
      body.append(element("span", "prompt-review__header", header));
      const answers = answersForQuestion(draft, index);
      body.append(
        element(
          "span",
          answers.length > 0 ? "prompt-review__answer" : "prompt-review__answer is-empty",
          answers.length > 0 ? answers.join(", ") : "No answer",
        ),
      );
      const jump = element("button", "btn btn-ghost btn-sm", "Edit");
      jump.type = "button";
      jump.addEventListener("click", () => {
        draft.index = index;
        controller.rerender();
        focusQuestionStep(controller, index, false);
      });
      item.append(body, jump);
      list.append(item);
    });
    wrap.append(list);
    return wrap;
  }

  function advanceQuestionStep(entry, controller, target) {
    const draft = questionDraft(entry);
    const steps = entry.request.questions.length;
    const next = Math.max(0, Math.min(target, steps));
    draft.index = next;
    controller.rerender();
    if (next >= steps) announce("Review");
    else announce(`Question ${next + 1} of ${steps}`);
    focusQuestionStep(controller, next, next >= steps);
  }

  function runQuestionPrimaryAction(entry, controller) {
    if (promptBusy.has(entry.key)) return;
    if (entry.request.tooLarge === true) return;
    const draft = questionDraft(entry);
    if (draft.confirm !== null || draft.composing === true) return;
    const steps = entry.request.questions.length;
    const needsReview = questionNeedsReview(entry.request);
    const isReview = needsReview && draft.index === steps;
    if (isReview) {
      submitQuestion(entry);
      return;
    }
    if (draft.index < steps - 1) {
      advanceQuestionStep(entry, controller, draft.index + 1);
      return;
    }
    if (needsReview) {
      advanceQuestionStep(entry, controller, steps);
      return;
    }
    submitQuestion(entry);
  }

  function buildQuestionActions(entry, draft, isReview, controller) {
    const footer = element("div", "prompt-dock__foot");
    const left = element("div", "cluster");
    const dismiss = element("button", "btn btn-ghost btn-sm", "Dismiss");
    dismiss.type = "button";
    dismiss.disabled = promptBusy.has(entry.key);
    dismiss.addEventListener("click", () => {
      draft.confirm = draft.confirm === "dismiss" ? null : "dismiss";
      controller.rerender();
    });
    left.append(dismiss);

    const right = element("div", "cluster");
    const steps = entry.request.questions.length;
    const busy = promptBusy.has(entry.key);
    const tooLarge = entry.request.tooLarge === true;

    if (!tooLarge) {
      if (isReview) {
        if (draft.index > 0) {
          const back = element("button", "btn btn-ghost btn-sm", "Back");
          back.type = "button";
          back.disabled = busy;
          back.addEventListener("click", () => {
            advanceQuestionStep(entry, controller, Math.max(0, steps - 1));
          });
          right.append(back);
        }
        const submit = element(
          "button",
          "btn btn-primary btn-sm",
          primaryActionLabel(entry, draft),
        );
        submit.type = "button";
        submit.dataset.promptPrimary = "true";
        submit.disabled = busy;
        submit.addEventListener("click", () => submitQuestion(entry));
        right.append(submit);
      } else if (draft.index < steps - 1) {
        const next = element("button", "btn btn-primary btn-sm prompt-dock__nav", "Next");
        next.type = "button";
        next.disabled = busy;
        next.addEventListener("click", () => {
          advanceQuestionStep(entry, controller, draft.index + 1);
        });
        right.append(next);
      } else {
        const needsReview = steps > 1 || entry.request.questions[0].multiple === true;
        if (needsReview) {
          const review = element(
            "button",
            steps > 1 ? "btn btn-primary btn-sm prompt-dock__nav" : "btn btn-primary btn-sm",
            primaryActionLabel(entry, draft),
          );
          review.type = "button";
          review.dataset.promptPrimary = "true";
          review.disabled = busy;
          review.addEventListener("click", () => {
            advanceQuestionStep(entry, controller, steps);
          });
          right.append(review);
        } else {
          const submit = element(
            "button",
            "btn btn-primary btn-sm",
            primaryActionLabel(entry, draft),
          );
          submit.type = "button";
          submit.dataset.promptPrimary = "true";
          submit.disabled = busy;
          submit.addEventListener("click", () => submitQuestion(entry));
          right.append(submit);
        }
      }
    }
    footer.append(left, right);
    return footer;
  }

  function buildConfirm(entry, draft, kind, controller) {
    const box = element("div", "prompt-confirm");
    box.setAttribute("role", "group");
    const text = element("p", "prompt-confirm__text");
    const actions = element("div", "cluster");
    if (kind === "dismiss") {
      text.textContent = "Dismiss this request? The agent continues without an answer.";
      const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        draft.confirm = null;
        controller.rerender();
        focusQuestionHeading(controller);
      });
      const confirm = element("button", "btn btn-danger btn-sm", "Dismiss request");
      confirm.type = "button";
      confirm.addEventListener("click", () => dismissQuestion(entry));
      actions.append(cancel, confirm);
    } else {
      text.textContent = "Send without answering?";
      const body = element(
        "p",
        "prompt-confirm__body",
        "The agent receives an empty answer for the unanswered questions.",
      );
      box.append(body);
      const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        draft.confirm = null;
        controller.rerender();
        focusQuestionHeading(controller);
      });
      const confirm = element("button", "btn btn-primary btn-sm", "Send without answering");
      confirm.type = "button";
      confirm.addEventListener("click", () => submitQuestion(entry));
      actions.append(cancel, confirm);
    }
    box.prepend(text);
    box.append(actions);
    return box;
  }

  function buildInlineQuestionHead(entry, controller, metaText, view) {
    const head = element("div", "prompt-dock__head");
    const identity = element("div", "prompt-dock__identity");
    const overline = element("p", "overline", "Question");
    overline.id = questionHeadingId(controller);
    overline.tabIndex = -1;
    overline.dataset.questionHeading = "true";
    identity.append(overline);
    if (metaText.length > 0) identity.append(element("span", "prompt-dock__count", metaText));
    if (entry !== null && entry !== undefined) {
      const queueSize = Math.max(0, pendingForSession(entry.request.sessionID).length - 1);
      if (queueSize > 0) {
        identity.append(
          element("span", "prompt-dock__queue-count", `${queueSize} more waiting`),
        );
      }
    }
    if (view.stateLabel) {
      const chip = element("span", "chat-question__state", view.stateLabel);
      chip.dataset.state = view.state;
      identity.append(chip);
    }
    if (view.stale) identity.append(element("span", "prompt-dock__queue-count", "Not updating"));
    head.append(identity);
    return head;
  }

  function buildQuestionCardInto(card, entry, controller, view) {
    const request = entry.request;
    const draft = questionDraft(entry);
    const steps = request.questions.length;
    const needsReview = steps > 1 || (request.questions[0] && request.questions[0].multiple === true);
    const tabs = needsReview ? steps + 1 : steps;
    if (tabs === 0) draft.index = 0;
    else if (draft.index >= tabs) draft.index = tabs - 1;
    const isReview = needsReview && draft.index === steps;
    const meta = isReview
      ? "Review"
      : steps > 0
        ? `Question ${Math.min(draft.index + 1, steps)} of ${steps}`
        : "Question";
    if (view.inline) {
      card.classList.add("chat-question");
      card.dataset.questionKey = entry.key;
      card.dataset.correlationKey = controller.correlationKey || "";
      card.dataset.state = view.state;
      if (view.stale) card.dataset.stale = "true";
      else delete card.dataset.stale;
    } else {
      card.dataset.kind = "question";
    }
    card.setAttribute("aria-labelledby", questionHeadingId(controller));
    const head = view.inline
      ? buildInlineQuestionHead(entry, controller, meta, view)
      : buildPromptHead(entry, "Question", meta);
    if (!view.inline) {
      const heading = head.querySelector(".prompt-dock__identity .overline");
      if (heading !== null) {
        heading.id = questionHeadingId(controller);
        heading.tabIndex = -1;
        heading.dataset.questionHeading = "true";
      }
    }
    card.append(head);
    if (!view.inline && dockCollapsed) return card;
    const body = element("div", "prompt-dock__body");
    if (view.note) body.append(element("p", "prompt-dock__copy", view.note));
    if (request.tooLarge === true) {
      body.append(element("p", "prompt-dock__title", "This question is too large to answer."));
      if (typeof request.summary === "string" && request.summary.length > 0) {
        body.append(element("p", "prompt-dock__copy", request.summary));
      }
      body.append(
        element(
          "p",
          "prompt-dock__copy",
          request.tooLargeReason || "Its answers cannot be aligned safely.",
        ),
      );
    } else {
      if (tabs > 1) body.append(renderTabs(entry, draft, tabs, controller));
      if (steps > 1 && !isReview) {
        const stepper = element("div", "prompt-dock__stepper");
        const prev = element("button", "btn btn-ghost btn-sm", "Back");
        prev.type = "button";
        prev.disabled = draft.index === 0;
        prev.addEventListener("click", () => {
          advanceQuestionStep(entry, controller, Math.max(0, draft.index - 1));
        });
        const label = element(
          "span",
          "prompt-dock__step-label",
          isReview ? "Review" : `Question ${draft.index + 1} of ${steps}`,
        );
        const next = element(
          "button",
          "btn btn-ghost btn-sm",
          isReview ? "Back" : draft.index === steps - 1 ? "Review" : "Next",
        );
        next.type = "button";
        next.disabled = isReview ? false : draft.index >= tabs - 1;
        next.addEventListener("click", () => {
          advanceQuestionStep(
            entry,
            controller,
            isReview ? Math.max(0, steps - 1) : Math.min(tabs - 1, draft.index + 1),
          );
        });
        stepper.append(prev, label, next);
        body.append(stepper);
      }
      if (isReview) {
        body.append(buildReview(entry, draft, controller));
      } else if (steps > 0) {
        body.append(buildQuestionField(entry, draft, draft.index, controller));
      }
    }
    if (draft.confirm === "dismiss") {
      body.append(buildConfirm(entry, draft, "dismiss", controller));
    } else if (draft.confirm === "empty") {
      body.append(buildConfirm(entry, draft, "empty", controller));
    }
    const error = promptErrors.get(entry.key);
    if (error !== undefined) {
      const errorEl = element("p", "field-error prompt-dock__error", error);
      errorEl.setAttribute("role", "alert");
      body.append(errorEl);
    }
    card.append(body);
    if (draft.confirm !== "dismiss" && draft.confirm !== "empty") {
      card.append(buildQuestionActions(entry, draft, isReview, controller));
    }
    return card;
  }

  function buildQuestionCard(entry, controller, view) {
    const card = element("article", view.inline ? "chat-question" : "prompt-dock__card");
    if (view.inline) card.tabIndex = -1;
    return buildQuestionCardInto(card, entry, controller, view);
  }

  function buildQuestionDock(entry) {
    const controller = questionController(entry, {
      scope: promptDock,
      prefix: "",
      inline: false,
      rerender: renderPromptDock,
    });
    return buildQuestionCard(entry, controller, {
      inline: false,
      state: entry.request.tooLarge === true ? "tooLarge" : "pending",
      stateLabel: "",
      note: "",
      stale: promptsAreStale(),
    });
  }

  function questionPartState(part) {
    const data = partDataOf(part);
    return data.state && typeof data.state === "object" ? data.state : {};
  }

  function isTerminalQuestionPart(part) {
    const status = questionPartState(part).status;
    return typeof status === "string" && status !== "running" && status !== "pending";
  }

  function questionPartQuestions(part) {
    const input = questionPartState(part).input;
    return input && Array.isArray(input.questions) ? input.questions : [];
  }

  function questionPartAnswers(part) {
    const metadata = questionPartState(part).metadata;
    return metadata && Array.isArray(metadata.answers) ? metadata.answers : undefined;
  }

  function questionPartOutput(part) {
    const state = questionPartState(part);
    if (typeof state.output === "string") return state.output;
    if (state.output !== undefined && state.output !== null) {
      try {
        return JSON.stringify(state.output, null, 2);
      } catch (error) {
        void error;
      }
    }
    const data = partDataOf(part);
    if (typeof data.output === "string") return data.output;
    return undefined;
  }

  function questionLabelFor(question, index) {
    if (question && typeof question.question === "string" && question.question.trim().length > 0) {
      return question.question;
    }
    if (question && typeof question.header === "string" && question.header.trim().length > 0) {
      return question.header;
    }
    return `Question ${index + 1}`;
  }

  function answerText(raw) {
    if (Array.isArray(raw)) {
      const values = raw.map((value) => String(value)).filter((value) => value.length > 0);
      return values.length > 0 ? values.join(", ") : "No answer";
    }
    if (typeof raw === "string") return raw.length > 0 ? raw : "No answer";
    if (raw === undefined || raw === null) return "No answer";
    return String(raw);
  }

  function questionAnswerData(view) {
    const part = view.part;
    const outcomeQuestions =
      view.outcome && Array.isArray(view.outcome.questions) ? view.outcome.questions : [];
    const questions =
      part !== null && part !== undefined
        ? questionPartQuestions(part)
        : view.entry !== undefined
          ? view.entry.request.questions
          : outcomeQuestions;
    const partAnswers = part ? questionPartAnswers(part) : undefined;
    const output = part ? questionPartOutput(part) : undefined;
    let answers = partAnswers;
    if (!Array.isArray(answers) && view.outcome && Array.isArray(view.outcome.answers)) {
      answers = view.outcome.answers;
    }
    if (Array.isArray(answers)) {
      if (answers.length === questions.length && !(answers.length === 0 && typeof output === "string")) {
        return { kind: "rows", questions, answers };
      }
      if (typeof output === "string" && output.length > 0) {
        return { kind: "output", output, note: "Answer detail unavailable" };
      }
      return { kind: "note", note: "Answer detail unavailable" };
    }
    if (typeof output === "string" && output.length > 0) {
      return { kind: "output", output };
    }
    if (view.outcome && view.outcome.elsewhere === true) {
      return { kind: "note", note: "Answers will appear when the question finishes." };
    }
    return { kind: "note", note: "Answer detail unavailable" };
  }

  function questionPartSignature(part) {
    const state = questionPartState(part);
    let answers = "";
    try {
      answers = JSON.stringify(state.metadata && state.metadata.answers);
    } catch (error) {
      void error;
    }
    const output = questionPartOutput(part) || "";
    return `${state.status || ""}|${answers}|${output.length}|${output.slice(0, 120)}`;
  }

  function questionPartIdentity(part, record) {
    const data = partDataOf(part);
    const messageID =
      typeof data.messageID === "string" && data.messageID.length > 0
        ? data.messageID
        : record.id;
    const callID =
      typeof data.callID === "string" && data.callID.length > 0
        ? data.callID
        : typeof part.id === "string"
          ? part.id
          : "";
    return `${messageID}:${callID}`;
  }

  function partCorrelationKey(part, record) {
    const data = partDataOf(part);
    const source = typeof data.source === "string" && data.source.length > 0 ? data.source : "history";
    const session =
      typeof data.sessionID === "string" && data.sessionID.length > 0
        ? data.sessionID
        : store.sessionID || "";
    const messageID =
      typeof data.messageID === "string" && data.messageID.length > 0
        ? data.messageID
        : record.id;
    const callID =
      typeof data.callID === "string" && data.callID.length > 0
        ? data.callID
        : typeof part.id === "string"
          ? part.id
          : "";
    return `${source}:${session}:${messageID}:${callID}`;
  }

  function findEntryForQuestionPart(part) {
    const data = partDataOf(part);
    if (typeof data.messageID !== "string" || typeof data.callID !== "string") return undefined;
    for (const entry of prompts.values()) {
      if (!isCorrelatedQuestion(entry)) continue;
      const tool = entry.request.tool;
      if (tool.messageID === data.messageID && tool.callID === data.callID) return entry;
    }
    return undefined;
  }

  function findQuestionPartForEntry(entry) {
    if (!isCorrelatedQuestion(entry)) return null;
    const tool = entry.request.tool;
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined) continue;
      for (const partID of record.partOrder) {
        const part = record.parts.get(partID);
        if (!isQuestionToolPart(part)) continue;
        const data = partDataOf(part);
        if (data.messageID === tool.messageID && data.callID === tool.callID) {
          return { record, part };
        }
      }
    }
    return null;
  }

  function findQuestionPartByCorrelation(correlationKey) {
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined) continue;
      for (const partID of record.partOrder) {
        const part = record.parts.get(partID);
        if (!isQuestionToolPart(part)) continue;
        if (partCorrelationKey(part, record) === correlationKey) return { record, part };
      }
    }
    return null;
  }

  function findEntryByCorrelation(correlationKey) {
    for (const entry of prompts.values()) {
      if (isCorrelatedQuestion(entry) && questionCorrelationKey(entry.request) === correlationKey) {
        return entry;
      }
    }
    return undefined;
  }

  function resolveInlineQuestionView(entry, partInfo, correlationKey, questionKeyHint) {
    const part = partInfo ? partInfo.part : undefined;
    const status = part ? questionPartState(part).status : undefined;
    const terminal = part !== undefined && isTerminalQuestionPart(part);
    const answers = part ? questionPartAnswers(part) : undefined;
    const output = part ? questionPartOutput(part) : undefined;
    const hasDetail = answers !== undefined || output !== undefined;
    const knownKey =
      entry !== undefined
        ? entry.key
        : questionKeyHint !== undefined && questionKeyHint.length > 0
          ? questionKeyHint
          : questionKeyForCorrelation(correlationKey);
    const outcome =
      entry !== undefined
        ? questionOutcomeFor(entry)
        : knownKey === undefined
          ? undefined
          : promptOutcomes.get(knownKey);
    const base = { entry, part, partInfo, outcome, stale: promptsAreStale() };
    const authoritative = terminal && (hasDetail || (status === "completed" && outcome === undefined));
    if (authoritative) {
      return { ...base, state: "answered", stateLabel: "Answered" };
    }
    if (outcome && outcome.kind === "dismissed") {
      return { ...base, state: "dismissed", stateLabel: "Dismissed" };
    }
    if (outcome && outcome.kind === "expired") {
      return {
        ...base,
        state: "expired",
        stateLabel: outcome.reason || "Request no longer pending",
      };
    }
    if (outcome && outcome.kind === "answered") {
      return {
        ...base,
        state: "answered",
        stateLabel: outcome.elsewhere === true ? "Answered elsewhere" : "Answered",
        elsewhere: outcome.elsewhere === true,
      };
    }
    if (terminal) return { ...base, state: "answered", stateLabel: "Answered" };
    if (entry !== undefined && entry.request.tooLarge === true) {
      return { ...base, state: "tooLarge", stateLabel: "Too large" };
    }
    if (entry !== undefined) {
      const omitted =
        omittedPartIDs.has(entry.request.tool.callID) || inlineUnavailable.has(correlationKey);
      if (part === undefined && omitted) {
        return { ...base, state: "part-unavailable", stateLabel: "Part unavailable" };
      }
      if (part === undefined) {
        return { ...base, state: "preparing", stateLabel: "Preparing request…" };
      }
      return { ...base, state: "pending", stateLabel: "" };
    }
    if (part === undefined && inlineUnavailable.has(correlationKey)) {
      return { ...base, state: "part-unavailable", stateLabel: "Part unavailable" };
    }
    if (knownKey !== undefined && outcome === undefined) {
      return {
        ...base,
        state: "expired",
        stateLabel: "Request no longer pending",
      };
    }
    return { ...base, state: "preparing", stateLabel: "Preparing request…", readOnlyPart: true };
  }

  function buildReadOnlyInlineCard(card, view, controller) {
    card.replaceChildren();
    card.className = "chat-question";
    card.tabIndex = -1;
    card.dataset.state = view.state;
    if (view.stale) card.dataset.stale = "true";
    else delete card.dataset.stale;
    card.setAttribute("aria-labelledby", questionHeadingId(controller));
    card.append(buildInlineQuestionHead(view.entry, controller, "", view));
    const body = element("div", "prompt-dock__body");
    const questions =
      view.part !== undefined
        ? questionPartQuestions(view.part)
        : view.entry !== undefined
          ? view.entry.request.questions
          : view.outcome && Array.isArray(view.outcome.questions)
            ? view.outcome.questions
            : [];
    if (view.state === "answered") {
      const data = questionAnswerData(view);
      if (data.kind === "rows") {
        const answers = element("div", "chat-question__answers");
        data.questions.forEach((question, index) => {
          const item = element("div", "chat-question__answer");
          item.append(
            element("span", "chat-question__answer-label", questionLabelFor(question, index)),
            element(
              "span",
              "chat-question__answer-value",
              answerText(data.answers[index]),
            ),
          );
          answers.append(item);
        });
        body.append(answers);
      } else if (data.kind === "output") {
        const output = element("pre", "chat-question__answer-value");
        output.textContent = data.output;
        body.append(output);
        if (data.note) body.append(element("p", "prompt-dock__copy", data.note));
      } else {
        body.append(element("p", "prompt-dock__copy", data.note));
      }
    } else {
      const copy =
        view.state === "dismissed"
          ? "Dismissed"
          : view.state === "expired"
            ? (view.outcome && view.outcome.reason) || "Request no longer pending"
            : view.state === "part-unavailable"
              ? "Question part unavailable"
              : "Preparing request…";
      body.append(element("p", "prompt-dock__copy", copy));
      if (questions.length > 0) {
        const list = element("div", "chat-question__answers");
        questions.forEach((question, index) => {
          list.append(
            element("span", "chat-question__answer-label", questionLabelFor(question, index)),
          );
        });
        body.append(list);
      }
    }
    card.append(body);
    return card;
  }

  function shortQuestionKey(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function inlineIdPrefix(correlationKey) {
    return `chat-question-${shortQuestionKey(correlationKey)}-`;
  }

  function ensureInlineCard(correlationKey) {
    let card = inlineCards.get(correlationKey);
    if (card === undefined) {
      card = element("article", "chat-question");
      card.tabIndex = -1;
      inlineCards.set(correlationKey, card);
    }
    return card;
  }

  function inlineCardForUpdate(correlationKey, partInfo) {
    let card = inlineCards.get(correlationKey);
    if (card !== undefined) return card;
    if (partInfo !== null && partInfo !== undefined) {
      const existing = inlineCardByPart.get(
        questionPartIdentity(partInfo.part, partInfo.record),
      );
      if (existing !== undefined) {
        inlineCards.set(correlationKey, existing);
        return existing;
      }
    }
    return ensureInlineCard(correlationKey);
  }

  function placeInlineCard(card, partInfo) {
    const active = document.activeElement;
    const hadFocus = active instanceof HTMLElement && card.contains(active);
    let moved = false;
    if (partInfo !== null && partInfo !== undefined) {
      const slot = partNodes.get(`${partInfo.record.id}:${partInfo.part.id}`);
      if (slot instanceof HTMLElement && slot.classList.contains("chat-question-slot")) {
        if (card.parentNode !== slot) {
          slot.append(card);
          moved = true;
        }
      } else if (questionPlaceholderEl !== null && card.parentNode !== questionPlaceholderEl) {
        questionPlaceholderEl.append(card);
        moved = true;
      }
    } else if (questionPlaceholderEl !== null && card.parentNode !== questionPlaceholderEl) {
      questionPlaceholderEl.append(card);
      moved = true;
    }
    if (moved && hadFocus && document.activeElement !== active) active.focus();
  }

  function updateInlineCard(entry, partInfo, correlationKey, force) {
    if (entry !== undefined && entry !== null) {
      correlationQuestionKeys.set(correlationKey, entry.key);
    }
    const partIdentity = partInfo
      ? questionPartIdentity(partInfo.part, partInfo.record)
      : undefined;
    const existingByPart =
      partIdentity === undefined ? undefined : inlineCardByPart.get(partIdentity);
    const questionKeyHint =
      entry === undefined || entry === null
        ? existingByPart === undefined
          ? undefined
          : existingByPart.dataset.questionKey
        : undefined;
    const view = resolveInlineQuestionView(
      entry || undefined,
      partInfo,
      correlationKey,
      questionKeyHint,
    );
    const card = inlineCardForUpdate(correlationKey, partInfo);
    const draft = entry !== undefined && entry !== null ? questionDraft(entry) : null;
    const signature = [
      view.state,
      view.stateLabel,
      view.stale ? "1" : "0",
      partInfo ? questionPartSignature(partInfo.part) : "no-part",
      entry ? entry.key : "",
      questionKeyHint || "",
      draft ? draft.index : "",
      draft ? draft.confirm || "" : "",
      view.outcome
        ? `${view.outcome.kind}:${view.outcome.elsewhere ? 1 : 0}:${
            Array.isArray(view.outcome.answers) ? view.outcome.answers.length : 0
          }`
        : "",
    ].join("|");
    if (force || card.dataset.inlineSignature !== signature) {
      const saved = card.contains(document.activeElement)
        ? captureQuestionFocus(card)
        : null;
      card.replaceChildren();
      card.className = "chat-question";
      card.tabIndex = -1;
      const controller = questionController(entry || null, {
        scope: card,
        prefix: inlineIdPrefix(correlationKey),
        inline: true,
        correlationKey,
        rerender: () => refreshInlineQuestion(correlationKey, true),
      });
      if (
        entry !== undefined &&
        entry !== null &&
        (view.state === "pending" ||
          view.state === "preparing" ||
          view.state === "part-unavailable" ||
          view.state === "tooLarge")
      ) {
        const note =
          view.state === "part-unavailable" ? "Question part unavailable" : "";
        buildQuestionCardInto(card, entry, controller, {
          inline: true,
          state: view.state,
          stateLabel: view.stateLabel,
          note,
          stale: view.stale,
        });
        card.dataset.state = view.state;
      } else {
        buildReadOnlyInlineCard(card, view, controller);
      }
      card.dataset.inlineSignature = signature;
      if (saved !== null) {
        if (view.state === "answered" || view.state === "dismissed" || view.state === "expired") {
          if (!composerHasDraft()) focusComposer();
        } else {
          restoreQuestionFocus(card, saved);
        }
      }
    }
    card.dataset.questionKey = entry
      ? entry.key
      : questionKeyHint !== undefined && questionKeyHint.length > 0
        ? questionKeyHint
        : questionKeyForCorrelation(correlationKey) || "";
    card.dataset.correlationKey = correlationKey;
    card.dataset.state = view.state;
    if (view.stale) card.dataset.stale = "true";
    else delete card.dataset.stale;
    if (partInfo) {
      inlineCardByPart.set(questionPartIdentity(partInfo.part, partInfo.record), card);
    }
    placeInlineCard(card, partInfo);
    return card;
  }

  function updateInlineQuestionPart(node, record, part) {
    const entry = findEntryForQuestionPart(part);
    const correlationKey = entry
      ? questionCorrelationKey(entry.request)
      : partCorrelationKey(part, record);
    inlineUnavailable.delete(correlationKey);
    const card = updateInlineCard(entry || null, { record, part }, correlationKey, false);
    if (node.firstChild !== card) node.append(card);
    return true;
  }

  function refreshInlineQuestion(correlationKey, force) {
    const entry = findEntryByCorrelation(correlationKey);
    let partInfo = entry ? findQuestionPartForEntry(entry) : null;
    if (partInfo === null) partInfo = findQuestionPartByCorrelation(correlationKey);
    updateInlineCard(entry || null, partInfo, correlationKey, force === true);
  }

  function refreshInlineQuestions() {
    if (messagesEl === null) return;
    const seen = new Set();
    for (const entry of activePromptEntries()) {
      if (!isCorrelatedQuestion(entry)) continue;
      const correlationKey = questionCorrelationKey(entry.request);
      correlationQuestionKeys.set(correlationKey, entry.key);
      updateInlineCard(entry, findQuestionPartForEntry(entry), correlationKey, false);
      seen.add(correlationKey);
    }
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record === undefined) continue;
      for (const partID of record.partOrder) {
        const part = record.parts.get(partID);
        if (!isQuestionToolPart(part)) continue;
        const entry = findEntryForQuestionPart(part);
        if (entry !== undefined && isCorrelatedQuestion(entry)) {
          const correlationKey = questionCorrelationKey(entry.request);
          if (seen.has(correlationKey)) continue;
        }
        const correlationKey =
          entry !== undefined && isCorrelatedQuestion(entry)
            ? questionCorrelationKey(entry.request)
            : partCorrelationKey(part, record);
        if (seen.has(correlationKey)) continue;
        updateInlineCard(entry || null, { record, part }, correlationKey, false);
        seen.add(correlationKey);
      }
    }
    const partCards = new Set(inlineCardByPart.values());
    for (const [correlationKey, card] of inlineCards) {
      if (seen.has(correlationKey) || partCards.has(card)) continue;
      updateInlineCard(null, null, correlationKey, false);
    }
  }

  function cardForQuestionEntry(entry) {
    if (!isCorrelatedQuestion(entry)) return promptDock;
    return inlineCards.get(questionCorrelationKey(entry.request)) || null;
  }

  function permissionRisk(request) {
    if (
      ["external_directory", "bash", "edit", "write", "apply_patch", "task", "doom_loop"].includes(
        request.permission,
      )
    ) {
      return "high";
    }
    if (["webfetch", "websearch", "read", "glob", "grep", "list"].includes(request.permission)) {
      return "medium";
    }
    return "medium";
  }

  function riskChip(risk) {
    const labels = { high: "High risk", medium: "Medium risk", low: "Low risk" };
    const ticks = { high: 3, medium: 2, low: 1 };
    const chip = element("span", "risk-chip");
    chip.dataset.risk = risk;
    chip.append(iconNode(risk === "high" ? "alert-triangle" : "alert-circle", "icon--sm"));
    chip.append(document.createTextNode(labels[risk]));
    const meter = element("span", "risk-chip__meter");
    meter.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      const tick = element("span", "risk-chip__tick");
      if (index < ticks[risk]) tick.dataset.on = "true";
      meter.append(tick);
    }
    chip.append(meter);
    return chip;
  }

  function permissionTitle(permission) {
    const titles = {
      bash: "Allow the agent to run this command?",
      edit: "Allow the agent to edit this file?",
      write: "Allow the agent to write this file?",
      apply_patch: "Allow the agent to apply this patch?",
      read: "Allow the agent to read this file?",
      glob: "Allow the agent to search these files?",
      grep: "Allow the agent to search file contents?",
      external_directory: "Allow the agent to reach outside the app?",
      webfetch: "Allow the agent to fetch this URL?",
      websearch: "Allow the agent to search the web?",
      doom_loop: "Allow the agent to repeat this tool call?",
    };
    return titles[permission] || `Allow the agent to use ${permission}?`;
  }

  function patternList(patterns) {
    const list = element("ul", "prompt-scope__list");
    for (const pattern of patterns) list.append(element("li", "mono", pattern));
    return list;
  }

  function metadataText(metadata, key) {
    const value = metadata[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
  }

  function evidencePre(text, className) {
    const pre = element("pre", className === undefined ? "prompt-evidence__pre" : className);
    pre.textContent = text;
    return pre;
  }

  function buildPermissionEvidence(request) {
    const wrap = element("div", "prompt-evidence");
    const metadata = request.metadata || {};
    const permission = request.permission;
    const rows = [];
    if (permission === "bash") {
      const command = metadataText(metadata, "command");
      if (command !== undefined) rows.push(["Command", evidencePre(command)]);
    } else if (permission === "edit" || permission === "write" || permission === "apply_patch") {
      const filepath = metadataText(metadata, "filepath");
      if (filepath !== undefined) rows.push(["File", element("span", "mono", filepath)]);
      const diff = metadataText(metadata, "diff");
      if (diff !== undefined) {
        rows.push(["Change", evidencePre(diff, "prompt-evidence__pre prompt-evidence__diff")]);
      }
    } else if (permission === "read" || permission === "glob" || permission === "grep") {
      if (request.patterns.length > 0) rows.push(["Path", patternList(request.patterns)]);
    } else if (permission === "webfetch") {
      const url = metadataText(metadata, "url");
      if (url !== undefined) rows.push(["URL", element("span", "mono", url)]);
      const format = metadataText(metadata, "format");
      if (format !== undefined) rows.push(["Format", element("span", "", format)]);
      const timeout = metadataText(metadata, "timeout");
      if (timeout !== undefined) rows.push(["Timeout", element("span", "", timeout)]);
    } else if (permission === "external_directory") {
      const filepath = metadataText(metadata, "filepath");
      if (filepath !== undefined) rows.push(["Path", element("span", "mono", filepath)]);
      const parentDir = metadataText(metadata, "parentDir");
      if (parentDir !== undefined) rows.push(["Parent", element("span", "mono", parentDir)]);
    } else if (permission === "doom_loop") {
      const tool = metadataText(metadata, "tool");
      if (tool !== undefined) rows.push(["Tool", element("span", "mono", tool)]);
      const input = metadata["input"];
      if (input !== undefined) {
        rows.push(["Input", evidencePre(JSON.stringify(input, null, 2))]);
      }
    } else {
      const entries = Object.entries(metadata);
      if (entries.length > 0) {
        const details = element("details", "prompt-evidence__details");
        details.append(element("summary", "", "Arguments"));
        details.append(evidencePre(JSON.stringify(metadata, null, 2)));
        rows.push([`${permission} arguments`, details]);
      }
    }
    if (rows.length === 0) return null;
    const dl = element("dl", "prompt-evidence__grid");
    for (const [label, value] of rows) {
      dl.append(element("dt", "prompt-evidence__label", label), element("dd", "prompt-evidence__value"));
      const dd = dl.lastElementChild;
      if (dd !== null) dd.append(value);
    }
    wrap.append(dl);
    return wrap;
  }

  function buildPermissionConfirm(entry, draft, kind) {
    const request = entry.request;
    const box = element("div", "prompt-confirm");
    box.setAttribute("role", "group");
    const text = element("p", "prompt-confirm__text");
    const actions = element("div", "cluster");
    const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      draft.confirm = null;
      renderPromptDock();
      focusDock();
    });
    if (kind === "always") {
      text.textContent =
        request.source === "v2"
          ? "Always allow is saved for this project until revoked."
          : "Always allow applies to this app instance until it restarts.";
      const body = element("div", "prompt-confirm__body");
      body.append(element("p", "caption", "This grants:"));
      body.append(patternList(request.always));
      if (request.source === "v2") {
        body.append(
          element(
            "p",
            "caption",
            "It may also resolve matching pending requests in other sessions of this app.",
          ),
        );
      }
      box.append(body);
      const confirm = element("button", "btn btn-primary btn-sm", "Always allow");
      confirm.type = "button";
      confirm.addEventListener("click", () => replyPermission(entry, "always"));
      actions.append(cancel, confirm);
    } else {
      text.textContent = "Deny this request?";
      const body = element("div", "prompt-confirm__body");
      body.append(
        element(
          "p",
          "caption",
          "Denying also rejects other pending permission requests in this session.",
        ),
      );
      const label = element("label", "label", "Feedback (optional)");
      label.htmlFor = "prompt-permission-feedback";
      const feedback = element("textarea", "textarea prompt-feedback");
      feedback.id = "prompt-permission-feedback";
      feedback.rows = 2;
      feedback.maxLength = 4000;
      feedback.value = draft.feedback;
      feedback.addEventListener("input", () => {
        draft.feedback = feedback.value;
      });
      body.append(label, feedback);
      box.append(body);
      const confirm = element("button", "btn btn-danger btn-sm", "Deny request");
      confirm.type = "button";
      confirm.addEventListener("click", () =>
        replyPermission(entry, "reject", draft.feedback.trim()),
      );
      actions.append(cancel, confirm);
    }
    box.prepend(text);
    box.append(actions);
    return box;
  }

  function buildPermissionDock(entry) {
    const request = entry.request;
    const draft = permissionDraft(entry);
    const risk = permissionRisk(request);
    const card = element("article", "prompt-dock__card");
    card.dataset.kind = "permission";
    const headingId = "chat-prompt-title";
    card.setAttribute("aria-labelledby", headingId);
    const head = buildPromptHead(entry, "Permission", "");
    const identity = head.querySelector(".prompt-dock__identity");
    const heading = identity === null ? null : identity.querySelector(".overline");
    if (heading !== null) heading.id = headingId;
    if (identity !== null) identity.append(riskChip(risk));
    card.append(head);
    if (!dockCollapsed) {
      const body = element("div", "prompt-dock__body");
      body.append(element("h3", "prompt-dock__title", permissionTitle(request.permission)));
      const scope = element("div", "prompt-scope");
      const thisRequest = element("div", "prompt-scope__row");
      thisRequest.append(element("span", "prompt-scope__label", "This request:"));
      if (request.patterns.length > 0) thisRequest.append(patternList(request.patterns));
      else thisRequest.append(element("span", "caption", "This request only."));
      scope.append(thisRequest);
      if (request.always.length > 0) {
        const always = element("div", "prompt-scope__row");
        always.append(element("span", "prompt-scope__label", "Always grants:"));
        always.append(patternList(request.always));
        scope.append(always);
      }
      const scopeNote = element(
        "p",
        "prompt-scope__note",
        request.source === "v2"
          ? "Saved for this project until revoked."
          : "For this app instance until restart.",
      );
      scope.append(scopeNote);
      if (request.source === "v2") {
        const openSaved = element(
          "button",
          "btn btn-secondary btn-sm prompt-scope__action",
          "Saved permissions",
        );
        openSaved.type = "button";
        openSaved.addEventListener("click", openSavedSection);
        scope.append(openSaved);
      }
      if (request.always.length === 0) {
        scope.append(
          element("p", "caption", "This request does not offer an always grant."),
        );
      }
      body.append(scope);
      const allPatterns = [...request.patterns, ...request.always];
      if (allPatterns.includes("*")) {
        const starCopy =
          request.permission === "external_directory"
            ? "The * pattern covers every outside path for this app/project. This is a high-risk grant."
            : request.permission === "bash"
              ? "The * pattern covers every parsed command. External-directory checks still apply where opencode performs them."
              : "The * pattern covers every request for this tool. It does not grant access outside the app.";
        body.append(element("p", "prompt-caveat", starCopy));
      }
      if (["edit", "write", "apply_patch", "read", "glob", "grep"].includes(request.permission)) {
        body.append(
          element(
            "p",
            "prompt-caveat",
            "Paths outside the app are still checked by the external-directory policy.",
          ),
        );
      }
      if (request.permission === "bash" && request.always.length > 0) {
        body.append(
          element(
            "p",
            "prompt-caveat",
            "Always grants the parsed command patterns shown above, not paths or URLs.",
          ),
        );
      }
      if (request.permission === "external_directory") {
        body.append(
          element(
            "p",
            "prompt-caveat",
            "The external-directory policy normally denies this. Approving overrides it for this request.",
          ),
        );
      }
      const evidence = buildPermissionEvidence(request);
      if (evidence !== null) body.append(evidence);
      if (draft.confirm === "always") {
        body.append(buildPermissionConfirm(entry, draft, "always"));
      } else if (draft.confirm === "deny") {
        body.append(buildPermissionConfirm(entry, draft, "deny"));
      }
      const error = promptErrors.get(entry.key);
      if (error !== undefined) {
        const errorEl = element("p", "field-error prompt-dock__error", error);
        errorEl.setAttribute("role", "alert");
        body.append(errorEl);
      }
      card.append(body);
      const footer = element("div", "prompt-dock__foot");
      const left = element("div", "cluster");
      const deny = element("button", "btn btn-danger btn-sm", "Deny");
      deny.type = "button";
      deny.disabled = promptBusy.has(entry.key);
      deny.addEventListener("click", () => {
        draft.confirm = draft.confirm === "deny" ? null : "deny";
        renderPromptDock();
      });
      left.append(deny);
      const right = element("div", "cluster");
      const busy = promptBusy.has(entry.key);
      if (request.always.length > 0) {
        const always = element("button", "btn btn-secondary btn-sm", "Always allow");
        always.type = "button";
        always.disabled = busy;
        always.addEventListener("click", () => {
          draft.confirm = draft.confirm === "always" ? null : "always";
          renderPromptDock();
        });
        right.append(always);
      }
      const once = element(
        "button",
        "btn btn-primary btn-sm",
        busy ? "Sending reply…" : promptErrors.has(entry.key) ? "Try again" : "Allow once",
      );
      once.type = "button";
      once.disabled = busy;
      once.addEventListener("click", () => replyPermission(entry, "once"));
      right.append(once);
      if (draft.confirm === null) {
        footer.append(left, right);
        card.append(footer);
      }
    }
    return card;
  }

  function renderPromptDock() {
    if (promptDock === null) return;
    const entries = activeDockEntries();
    const wasHidden = promptDock.hidden;
    if (entries.length === 0) {
      promptDock.hidden = true;
      promptDock.replaceChildren();
      dockRequestKey = null;
      return;
    }
    const entry = entries[0];
    const changed = entry.key !== dockRequestKey;
    dockRequestKey = entry.key;
    promptDock.hidden = false;
    promptDock.replaceChildren(
      entry.kind === "question" ? buildQuestionDock(entry) : buildPermissionDock(entry),
    );
    if ((wasHidden || changed) && !composerHasDraft()) {
      focusDock();
    }
  }

  function renderPromptEntry(entry) {
    if (isCorrelatedQuestion(entry)) {
      refreshInlineQuestion(questionCorrelationKey(entry.request), true);
    }
    renderPromptDock();
  }

  async function submitQuestion(entry) {
    if (promptBusy.has(entry.key)) return;
    const draft = questionDraft(entry);
    const answers = entry.request.questions.map((_, index) => answersForQuestion(draft, index));
    if (answers.some((answer) => answer.length === 0) && draft.confirm !== "empty") {
      draft.confirm = "empty";
      renderPromptEntry(entry);
      return;
    }
    const focusWasInside =
      cardForQuestionEntry(entry) instanceof HTMLElement &&
      cardForQuestionEntry(entry).contains(document.activeElement);
    draft.confirm = null;
    promptBusy.add(entry.key);
    promptErrors.delete(entry.key);
    renderPromptEntry(entry);
    try {
      await api(questionReplyUrl(entry.request.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: entry.request.source, answers }),
      });
      recordQuestionOutcome(entry.key, {
        kind: "answered",
        local: true,
        elsewhere: false,
        answers,
        questions: entry.request.questions,
      });
      recordTombstone(entry.key);
      prompts.delete(entry.key);
      announce("Answer sent.");
      if (focusWasInside && !composerHasDraft()) focusComposer();
    } catch (error) {
      if (error.status === 404) {
        recordQuestionOutcome(entry.key, {
          kind: "expired",
          reason: "Already answered or expired",
          questions: entry.request.questions,
        });
        recordTombstone(entry.key);
        prompts.delete(entry.key);
        announce("Already answered or expired.");
        showToast("Already answered or expired.", "error");
        if (focusWasInside && !composerHasDraft()) focusComposer();
      } else {
        promptErrors.set(entry.key, error.message || String(error));
      }
    } finally {
      promptBusy.delete(entry.key);
      renderPromptDock();
      refreshInlineQuestions();
      renderQueue();
      syncComposer();
    }
  }

  async function dismissQuestion(entry) {
    if (promptBusy.has(entry.key)) return;
    const draft = questionDraft(entry);
    const focusWasInside =
      cardForQuestionEntry(entry) instanceof HTMLElement &&
      cardForQuestionEntry(entry).contains(document.activeElement);
    draft.confirm = null;
    promptBusy.add(entry.key);
    promptErrors.delete(entry.key);
    renderPromptEntry(entry);
    try {
      await api(questionRejectUrl(entry.request.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: entry.request.source }),
      });
      recordQuestionOutcome(entry.key, {
        kind: "dismissed",
        local: true,
        answers: null,
        questions: entry.request.questions,
      });
      recordTombstone(entry.key);
      prompts.delete(entry.key);
      announce("Question dismissed.");
      if (focusWasInside && !composerHasDraft()) focusComposer();
    } catch (error) {
      if (error.status === 404) {
        recordQuestionOutcome(entry.key, {
          kind: "expired",
          reason: "Already answered or expired",
          questions: entry.request.questions,
        });
        recordTombstone(entry.key);
        prompts.delete(entry.key);
        announce("Already answered or expired.");
        showToast("Already answered or expired.", "error");
        if (focusWasInside && !composerHasDraft()) focusComposer();
      } else {
        promptErrors.set(entry.key, error.message || String(error));
      }
    } finally {
      promptBusy.delete(entry.key);
      renderPromptDock();
      refreshInlineQuestions();
      renderQueue();
      syncComposer();
    }
  }

  async function replyPermission(entry, reply, message) {
    if (promptBusy.has(entry.key)) return;
    const draft = permissionDraft(entry);
    draft.confirm = null;
    promptBusy.add(entry.key);
    promptErrors.delete(entry.key);
    renderPromptDock();
    try {
      const body = { source: entry.request.source, reply };
      if (typeof message === "string" && message.length > 0) body.message = message;
      await api(permissionReplyUrl(entry.request.id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      recordTombstone(entry.key);
      prompts.delete(entry.key);
      announce(
        reply === "reject"
          ? "Permission denied."
          : reply === "always"
            ? "Permission always allowed."
            : "Permission allowed once.",
      );
      if (reply === "always" && entry.request.source === "v2") {
        loadSavedPermissions().catch(() => {});
      }
      focusComposer();
    } catch (error) {
      if (error.status === 404) {
        recordTombstone(entry.key);
        prompts.delete(entry.key);
        announce("Already answered or expired.");
        showToast("Already answered or expired.", "error");
        focusComposer();
      } else {
        promptErrors.set(entry.key, error.message || String(error));
      }
    } finally {
      promptBusy.delete(entry.key);
      renderPromptDock();
      renderQueue();
      syncComposer();
    }
  }

  function updateInputNeeded() {
    const count = otherSessionPromptCount();
    if (inputNeeded !== null) {
      inputNeeded.hidden = count === 0;
      inputNeeded.setAttribute(
        "aria-label",
        count === 0
          ? "No requests need input"
          : `${count} ${count === 1 ? "request needs" : "requests need"} input`,
      );
    }
    if (inputNeededCount !== null) inputNeededCount.textContent = String(count);
    if (count === 0 && queueEl !== null && !queueEl.hidden) closeQueue(false);
    renderQueue();
  }

  function closeQueue(returnFocus) {
    if (queueEl === null) return;
    queueEl.hidden = true;
    if (inputNeeded !== null) inputNeeded.setAttribute("aria-expanded", "false");
    if (returnFocus === true && inputNeeded instanceof HTMLElement) inputNeeded.focus();
  }

  function openQueue() {
    if (queueEl === null) return;
    renderQueue();
    queueEl.hidden = false;
    if (inputNeeded !== null) inputNeeded.setAttribute("aria-expanded", "true");
    const first = queueEl.querySelector("button");
    if (first instanceof HTMLElement) first.focus();
  }

  function renderQueue() {
    if (queueList === null) return;
    const entries = [...prompts.values()].filter(
      (entry) => entry.request.sessionID !== sessionId,
    );
    if (entries.length === 0) {
      queueList.replaceChildren(
        element("p", "chat-queue__empty", "No other requests need input."),
      );
      return;
    }
    const list = document.createDocumentFragment();
    for (const entry of entries) {
      const session = sessions.find((candidate) => String(candidate.id) === entry.request.sessionID);
      const row = element("button", "chat-queue__row");
      row.type = "button";
      row.append(
        element("span", "chat-queue__kind", entry.kind === "question" ? "Question" : "Permission"),
        element(
          "span",
          "chat-queue__title",
          entry.kind === "question"
            ? entry.request.questions[0]?.header || "Agent question"
            : permissionTitle(entry.request.permission),
        ),
        element(
          "span",
          "chat-queue__session",
          session === undefined ? `Session ${entry.request.sessionID.slice(0, 8)}` : sessionLabel(session),
        ),
      );
      row.addEventListener("click", () => {
        closeQueue(false);
        selectSession(entry.request.sessionID, { focus: false, focusDock: true });
      });
      list.append(row);
    }
    queueList.replaceChildren(list);
  }

  async function loadSavedPermissions() {
    try {
      const data = await api(savedPermissionsUrl());
      applySavedPermissions(data);
    } catch (error) {
      void error;
    }
  }

  function applySavedPermissions(data) {
    const list = data && Array.isArray(data.permissions) ? data.permissions : [];
    const added = savedHydrated
      ? list.filter(
          (permission) =>
            !savedPermissions.some((existing) => existing.id === permission.id),
        )
      : [];
    savedPermissions = list.filter((permission) => permission && typeof permission.id === "string");
    savedHydrated = true;
    renderSavedPermissions();
    if (added.length > 0) {
      showSavedBadge();
      const first = added[0];
      announce(`New saved permission: ${first.action} ${first.resource}.`);
    }
  }

  function showSavedBadge() {
    if (savedBadge === null) return;
    savedBadge.hidden = false;
    window.clearTimeout(savedBadgeTimer);
    savedBadgeTimer = window.setTimeout(() => {
      if (savedBadge !== null) savedBadge.hidden = true;
    }, 8000);
  }

  function renderSavedPermissions() {
    if (savedSection === null || savedList === null) return;
    if (savedPermissions.length === 0) {
      savedSection.hidden = true;
      savedList.replaceChildren();
      return;
    }
    savedSection.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const permission of savedPermissions) {
      const row = element("div", "chat-saved__row");
      const meta = element("div", "chat-saved__meta");
      meta.append(
        element("span", "chat-saved__action mono", permission.action || "permission"),
        element("span", "chat-saved__resource mono", permission.resource || "*"),
        element(
          "span",
          "chat-saved__project mono",
          permission.projectID.length > 0 ? `project ${permission.projectID}` : "project unknown",
        ),
      );
      const actions = element("div", "chat-saved__actions");
      const revoke = element("button", "btn btn-ghost btn-sm", "Revoke");
      revoke.type = "button";
      revoke.setAttribute("aria-label", `Revoke ${permission.action || "saved permission"}`);
      revoke.addEventListener("click", () => {
        actions.replaceChildren();
        const question = element("span", "caption", "Revoke?");
        const cancel = element("button", "btn btn-ghost btn-sm", "Cancel");
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          actions.replaceChildren(revoke);
          revoke.focus();
        });
        const confirm = element("button", "btn btn-danger btn-sm", "Revoke");
        confirm.type = "button";
        confirm.addEventListener("click", () => revokeSavedPermission(permission, row));
        actions.append(question, cancel, confirm);
        confirm.focus();
      });
      actions.append(revoke);
      row.append(meta, actions);
      fragment.append(row);
    }
    savedList.replaceChildren(fragment);
  }

  async function revokeSavedPermission(permission, row) {
    row.setAttribute("aria-busy", "true");
    try {
      await api(savedPermissionUrl(permission.id), { method: "DELETE" });
      savedPermissions = savedPermissions.filter((item) => item.id !== permission.id);
      renderSavedPermissions();
      announce("Saved permission revoked.");
    } catch (error) {
      row.removeAttribute("aria-busy");
      announce(`Saved permission was not revoked: ${error.message || String(error)}`);
      renderSavedPermissions();
    }
  }

  function openSavedSection() {
    setContext(true, false);
    if (savedSection === null) return;
    savedSection.scrollIntoView({ block: "start" });
    const heading = savedSection.querySelector("h2");
    if (heading instanceof HTMLElement) heading.focus();
  }

  function applyPolicyWarnings(warnings) {
    const next = warnings
      .filter((warning) => typeof warning === "string")
      .map((warning) => warning.trim())
      .filter((warning) => warning.length > 0);
    for (const warning of [...dismissedWarnings]) {
      if (!next.includes(warning)) dismissedWarnings.delete(warning);
    }
    policyWarnings = next;
    renderPolicyWarnings();
  }

  function renderPolicyWarnings() {
    const visible = policyWarnings.filter((warning) => !dismissedWarnings.has(warning));
    if (policyWarning !== null) {
      policyWarning.hidden = visible.length === 0;
      if (visible.length > 0) {
        const content = document.createDocumentFragment();
        const lead = element("div", "policy-warning__lead");
        const mark = element("span", "policy-warning__mark");
        mark.append(iconNode("alert-triangle", "icon--sm"));
        lead.append(mark, element("span", "policy-warning__label", "Policy warning"));
        const list = element("ul", "policy-warning__list");
        for (const warning of visible) list.append(element("li", "", warning));
        content.append(lead, list);
        const dismiss = element("button", "btn btn-ghost btn-sm policy-warning__dismiss", "Dismiss");
        dismiss.type = "button";
        dismiss.addEventListener("click", () => {
          for (const warning of visible) dismissedWarnings.add(warning);
          renderPolicyWarnings();
          if (policyChip instanceof HTMLElement) policyChip.focus();
        });
        content.append(dismiss);
        policyWarning.replaceChildren(content);
      } else {
        policyWarning.replaceChildren();
      }
    }
    if (policyChip !== null) {
      const dismissed = policyWarnings.filter((warning) => dismissedWarnings.has(warning));
      policyChip.hidden = dismissed.length === 0;
      policyChip.setAttribute("aria-expanded", visible.length > 0 ? "true" : "false");
      if (policyChipLabel !== null) {
        policyChipLabel.textContent =
          dismissed.length === 1 ? "Policy warning" : `${dismissed.length} policy warnings`;
      }
    }
  }

  function updatePlanChip() {
    if (planChip === null) return;
    planChip.hidden = sessionId === null;
    if (planChipLabel !== null && planProgress !== null) {
      planChipLabel.textContent = `Plan ${planProgress.completed}/${planProgress.total}`;
    }
  }

  async function loadTodo(id) {
    if (id === null) {
      todoState = "idle";
      renderPlan();
      return;
    }
    const fetchSeq = ++todoFetchSeq;
    const eventSeq = todoEventSeq.get(id) || 0;
    todoState = todoCache.has(id) ? "ready" : "loading";
    renderPlan();
    try {
      const data = await api(todoUrl(id));
      if (fetchSeq !== todoFetchSeq || sessionId !== id) return;
      if ((todoEventSeq.get(id) || 0) !== eventSeq) return;
      todoCache.set(id, {
        todos: data && Array.isArray(data.todos) ? data.todos : [],
        truncated: data && data.truncated === true,
      });
      todoState = "ready";
      renderPlan();
    } catch (error) {
      if (fetchSeq !== todoFetchSeq || sessionId !== id) return;
      if ((todoEventSeq.get(id) || 0) !== eventSeq) return;
      void error;
      todoState = "error";
      renderPlan();
    }
  }

  function planStatus(status) {
    const map = {
      pending: { icon: "clock", label: "Pending" },
      in_progress: { icon: "activity", label: "Now" },
      completed: { icon: "check", label: "Done" },
      cancelled: { icon: "slash", label: "Dropped" },
      unknown: { icon: "alert-circle", label: "Unknown" },
    };
    return map[status] || map.unknown;
  }

  function priorityMeter(priority) {
    const ticks = { high: 3, medium: 2, low: 1, unknown: 0 };
    const meter = element("span", "chat-plan__priority");
    meter.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      const tick = element("span", "chat-plan__tick");
      if (index < (ticks[priority] || 0)) tick.dataset.on = "true";
      meter.append(tick);
    }
    return meter;
  }

  function renderPlan() {
    if (planList === null || planEmpty === null || planSummary === null) return;
    if (sessionId === null) {
      planEmpty.hidden = false;
      planEmpty.textContent = "Send a message to start a session.";
      planList.hidden = true;
      planList.replaceChildren();
      planSummary.textContent = "No plan yet";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    const cached = todoCache.get(sessionId);
    const paused = liveEl !== null && liveEl.dataset.state === "paused";
    if (todoState === "loading" && cached === undefined) {
      planEmpty.hidden = false;
      planEmpty.textContent = "Loading plan…";
      planList.hidden = true;
      planSummary.textContent = "Loading";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    if (todoState === "error" && cached === undefined) {
      planEmpty.hidden = false;
      planEmpty.textContent = "Not updating";
      planList.hidden = true;
      planSummary.textContent = "Not updating";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    const todos = cached === undefined ? [] : cached.todos;
    if (todos.length === 0) {
      planEmpty.hidden = false;
      planEmpty.textContent = "No plan yet";
      planList.hidden = true;
      planList.replaceChildren();
      planSummary.textContent = "No plan yet";
      planProgress = { completed: 0, total: 0 };
      updatePlanChip();
      return;
    }
    let pending = 0;
    let inProgress = 0;
    let completed = 0;
    let cancelled = 0;
    for (const todo of todos) {
      if (todo.status === "pending") pending += 1;
      else if (todo.status === "in_progress") inProgress += 1;
      else if (todo.status === "completed") completed += 1;
      else if (todo.status === "cancelled") cancelled += 1;
    }
    const total = pending + inProgress + completed;
    planProgress = { completed, total };
    planEmpty.hidden = true;
    planList.hidden = false;
    const fragment = document.createDocumentFragment();
    let currentMarked = false;
    for (const todo of todos) {
      const item = element("li", "chat-plan__item");
      item.dataset.status = todo.status;
      const status = planStatus(todo.status);
      if (todo.status === "in_progress" && !currentMarked) {
        item.setAttribute("aria-current", "step");
        currentMarked = true;
      }
      const glyph = element("span", "chat-plan__status");
      glyph.append(iconNode(status.icon, "icon--sm"), document.createTextNode(status.label));
      const body = element("div", "chat-plan__body");
      body.append(element("span", "chat-plan__content", todo.content));
      const priority = element(
        "span",
        "chat-plan__priority-label",
        `Priority: ${todo.priority}`,
      );
      priority.classList.add("sr-only");
      body.append(priority);
      item.append(glyph, body, priorityMeter(todo.priority));
      fragment.append(item);
    }
    planList.replaceChildren(fragment);
    let summary;
    if (total === 0) summary = "No active steps";
    else if (completed === total) summary = "All steps complete";
    else summary = `${completed} of ${total} complete`;
    if (cancelled > 0) summary += ` · ${cancelled} cancelled`;
    if (cached !== undefined && cached.truncated === true) summary += " · List truncated";
    if (paused) summary = "Not updating";
    else if (todoState === "error") summary = "Not updating";
    planSummary.textContent = summary;
    if (summary !== lastPlanSummary) {
      lastPlanSummary = summary;
      if (todoState === "ready") announce(`Plan: ${summary}.`);
    }
    updatePlanChip();
  }

  function currentLastSeq() {
    if (store.currentStreamID === null) return 0;
    return store.lastSeqByStream.get(store.currentStreamID) || 0;
  }

  function replayBufferedStatuses(buffer, startSeq) {
    if (buffer === null || buffer.events.length === 0) return;
    const last = new Map();
    for (const event of buffer.events) {
      if (event.type !== "session.status") continue;
      if (typeof event.seq !== "number" || event.seq <= startSeq) continue;
      last.set(event.sessionID, event);
    }
    for (const event of last.values()) applyAgentStatus(event);
  }

  function saveCurrentRuntime() {
    if (sessionId === null) return;
    if (!sessions.some((session) => String(session.id) === sessionId)) return;
    sessionRuntime.set(sessionId, {
      order: [...store.order],
      messages: store.messages,
      openParts: new Set(store.openParts),
      agentStatus: store.agentStatus,
      turnGeneration: store.turnGeneration,
      activePromptID: store.activePromptID,
      queue: [...store.queue],
      lastSeqByStream: new Map(store.lastSeqByStream),
      currentStreamID: store.currentStreamID,
      historyCursor,
      historyLoaded,
    });
  }

  function adoptRuntime(id) {
    const saved = sessionRuntime.get(id);
    const next = createThreadStore(id);
    historyCursor = saved === undefined ? null : saved.historyCursor ?? null;
    historyLoaded = saved === undefined ? false : saved.historyLoaded ?? false;
    if (saved === undefined) return next;
    next.order = Array.isArray(saved.order) ? [...saved.order] : [];
    next.messages = saved.messages instanceof Map ? saved.messages : new Map();
    next.openParts = saved.openParts instanceof Set ? new Set(saved.openParts) : new Set();
    next.agentStatus = saved.agentStatus ?? null;
    next.turnGeneration = saved.turnGeneration ?? 0;
    next.activePromptID = saved.activePromptID ?? null;
    next.queue = Array.isArray(saved.queue) ? [...saved.queue] : [];
    next.lastSeqByStream =
      saved.lastSeqByStream instanceof Map ? new Map(saved.lastSeqByStream) : new Map();
    next.currentStreamID = saved.currentStreamID ?? null;
    return next;
  }

  async function hydrateMessages(options) {
    const settings = options || {};
    const target = typeof settings.session === "string" ? settings.session : sessionId;
    if (target === null || target !== sessionId) return;
    const sequence = ++hydrationSeq;
    const startSeq = currentLastSeq();
    const turnGeneration = store.turnGeneration;
    const initial = settings.initial === true;
    hydrating = true;
    hydrationBuffer = {
      events: [],
      bytes: 0,
      overflow: false,
      contentDiscarded: false,
    };
    if (initial) showMessagesLoading();
    try {
      const data = await api(messagesUrl(target, { limit: MESSAGES_PAGE_SIZE }));
      if (sequence !== hydrationSeq || sessionId !== target) return;
      const snapshotMessages = Array.isArray(data.messages) ? data.messages : [];
      const snapshotIDs = new Set();
      for (const entry of snapshotMessages) {
        if (entry === null || typeof entry !== "object") continue;
        const info = entry.info && typeof entry.info === "object" ? entry.info : entry;
        if (typeof info.id === "string") snapshotIDs.add(info.id);
      }
      let hasServerWindow = false;
      for (const id of store.order) {
        if (typeof id !== "string" || id.startsWith("local_")) continue;
        if (store.messages.has(id)) {
          hasServerWindow = true;
          break;
        }
      }
      let overlap = false;
      for (const id of snapshotIDs) {
        if (typeof id !== "string" || id.startsWith("local_")) continue;
        if (store.messages.has(id)) {
          overlap = true;
          break;
        }
      }
      let position = "tail";
      let resetWindow = false;
      if (hasServerWindow && snapshotMessages.length > 0 && !overlap) {
        position = "replace";
        resetWindow = true;
      }
      let prefixPreserved = false;
      if (position === "tail") {
        let anchorIndex = -1;
        for (let index = 0; index < store.order.length; index += 1) {
          if (snapshotIDs.has(store.order[index])) {
            anchorIndex = index;
            break;
          }
        }
        if (anchorIndex === -1) {
          prefixPreserved = hasServerWindow;
        } else {
          for (let index = 0; index < anchorIndex; index += 1) {
            const id = store.order[index];
            if (typeof id !== "string" || id.startsWith("local_")) continue;
            if (store.messages.has(id) && !snapshotIDs.has(id)) {
              prefixPreserved = true;
              break;
            }
          }
        }
      }
      const result = applySnapshot(store, snapshotMessages, {
        position,
        ...(resetWindow ? { keepOptimistic: "transient" } : {}),
        capturedTurnGeneration: turnGeneration,
        sessionStatusType: currentStatusType(),
        sessionID: target,
      });
      store = result.store;
      const nextCursor = data.nextCursor ?? null;
      if (resetWindow) {
        historyLoaded = false;
        historyCursor = nextCursor;
        historyRequestSeq += 1;
        historyRequest = null;
        prependPending = false;
        hideHistoryRow();
      } else if (!historyLoaded && !prefixPreserved) {
        historyCursor = nextCursor;
      }
      clearAllOmoClassifyTimers();
      sessionSnapshotTooLarge = false;
      setSessionNotice(false);
      const buffer = hydrationBuffer;
      const contentDiscarded =
        result.contentDiscarded === true ||
        (buffer !== null && buffer.contentDiscarded === true);
      replayBufferedStatuses(buffer, startSeq);
      resolveUnknownFromSnapshot(snapshotIDs);
      recomputeQueue();
      const turnChanged =
        result.turnChanged === true || store.turnGeneration !== turnGeneration;
      forceFinalRender = true;
      flushFrame({
        full: true,
        forceBottom: initial || settings.forceBottom === true || resetWindow,
      });
      messagesHydratedSession = target;
      for (const correlationKey of Array.from(deferredUnavailable)) {
        const entry = findEntryByCorrelation(correlationKey);
        if (entry === undefined) {
          deferredUnavailable.delete(correlationKey);
          continue;
        }
        if (entry.request.sessionID !== sessionId) continue;
        if (findQuestionPartForEntry(entry) === null) {
          inlineUnavailable.add(correlationKey);
        } else {
          inlineUnavailable.delete(correlationKey);
        }
        deferredUnavailable.delete(correlationKey);
      }
      refreshInlineQuestions();
      if (turnChanged) requestFollowUpHydration();
      if (settings.reason === "idle" || settings.reason === "reconnect") {
        refreshSessions().catch(() => {});
      }
      if (contentDiscarded) scheduleReconcile(RECONCILE_MS);
      if (buffer !== null && buffer.overflow && settings.retried !== true) {
        hydrating = false;
        hydrationBuffer = null;
        await hydrateMessages({ ...settings, retried: true });
        return;
      }
    } catch (error) {
      if (sequence !== hydrationSeq || sessionId !== target) return;
      if (error !== null && typeof error === "object" && error.code === "messages_too_large") {
        if (store.order.length === 0) {
          showThreadError(error, () => hydrateMessages({ initial: true }));
        } else {
          sessionSnapshotTooLarge = true;
          setSessionNotice(true);
          forceFinalRender = true;
          flushFrame({ full: true });
          announce("Session too large to refresh; showing the last loaded state.");
        }
      } else if (
        settings.silent !== true ||
        messagesEl === null ||
        messagesEl.hasAttribute("aria-busy")
      ) {
        showThreadError(error, () => hydrateMessages({ initial: true }));
      }
    } finally {
      if (sequence === hydrationSeq) {
        hydrating = false;
        hydrationBuffer = null;
      }
    }
  }

  function showHistoryLoading() {
    if (historyEl === null) return;
    historyEl.hidden = false;
    historyEl.dataset.state = "loading";
    if (historyLabelEl !== null) historyLabelEl.textContent = "Loading earlier messages...";
  }

  function showHistoryError(message) {
    if (historyEl === null) return;
    historyEl.hidden = false;
    historyEl.dataset.state = "error";
    if (historyLabelEl !== null) historyLabelEl.textContent = message;
  }

  function hideHistoryRow() {
    if (historyEl === null) return;
    historyEl.hidden = true;
    historyEl.dataset.state = "idle";
  }

  function handleHistoryError(error) {
    const code = error !== null && typeof error === "object" ? error.code : undefined;
    const status = error !== null && typeof error === "object" ? error.status : undefined;
    if (code === "invalid_cursor") {
      historyCursor = null;
      showHistoryError("Earlier messages unavailable.");
      return;
    }
    if (code === "session_not_found" || status === 404) {
      historyCursor = null;
      showHistoryError("Session no longer exists.");
      refreshSessions().catch(() => {});
      return;
    }
    if (code === "messages_too_large") {
      historyCursor = null;
      showHistoryError("Earlier messages are too large to load.");
      return;
    }
    showHistoryError("Earlier messages unavailable - scroll to retry.");
  }

  async function loadOlderMessages() {
    if (sessionId === null || historyCursor === null || historyRequest !== null) return;
    const target = sessionId;
    const token = {
      session: target,
      seq: ++historyRequestSeq,
      generation: store.generation,
      cursor: historyCursor,
    };
    historyRequest = token;
    showHistoryLoading();
    let loaded = false;
    let errorShown = false;
    let pageCount = 0;
    try {
      while (true) {
        const data = await api(
          messagesUrl(target, { limit: MESSAGES_PAGE_SIZE, before: token.cursor }),
        );
        if (
          sessionId !== target ||
          historyRequest !== token ||
          store.generation !== token.generation ||
          historyCursor !== token.cursor
        ) {
          return;
        }
        const pageMessages = Array.isArray(data.messages) ? data.messages : [];
        const pageIDs = new Set();
        for (const entry of pageMessages) {
          if (entry === null || typeof entry !== "object") continue;
          const info = entry.info && typeof entry.info === "object" ? entry.info : entry;
          if (typeof info.id === "string") pageIDs.add(info.id);
        }
        let newIDs = 0;
        for (const id of pageIDs) {
          if (!store.messages.has(id)) newIDs += 1;
        }
        const result = applySnapshot(store, pageMessages, {
          position: "older",
          sessionStatusType: currentStatusType(),
          sessionID: target,
        });
        store = result.store;
        historyLoaded = true;
        historyCursor = data.nextCursor ?? null;
        const acceptance = acceptanceBySession.get(target);
        if (acceptance !== undefined && acceptance.knownUserIDs instanceof Set) {
          for (const id of pageIDs) {
            const record = store.messages.get(id);
            if (record !== undefined && record.role === "user") {
              acceptance.knownUserIDs.add(id);
            }
          }
        }
        loaded = true;
        pageCount += 1;
        token.cursor = historyCursor;
        token.generation = store.generation;
        if (historyCursor === null) break;
        if (newIDs > 0) break;
        if (pageCount >= HISTORY_MAX_CONTINUE_PAGES) break;
      }
      forceFinalRender = true;
      hideHistoryRow();
      flushFrame({ full: true, prepend: true });
    } catch (error) {
      errorShown = true;
      if (loaded) {
        forceFinalRender = true;
        flushFrame({ full: true, prepend: true });
      }
      handleHistoryError(error);
    } finally {
      if (historyRequest === token) {
        historyRequest = null;
        if (!errorShown) hideHistoryRow();
      }
    }
  }

  async function loadMessages(options) {
    await hydrateMessages(options);
  }

  async function refreshSessions() {
    try {
      const data = await api(sessionsUrl());
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      sessionsFailed = false;
      sessionsLoaded = true;
      if (sessions.length === 0) {
        if (sessionId !== null) startDraft({ focus: false });
        else showSessionsEmpty();
        return;
      }
      if (sessionId === null) {
        sessionId = String(sessions[0].id);
      } else if (!sessions.some((session) => session.id === sessionId)) {
        await selectSession(String(sessions[0].id), { focus: false });
        return;
      }
      renderSessions();
      const current = sessions.find((session) => session.id === sessionId);
      if (current !== undefined && sessionTitleEl !== null) {
        sessionTitleEl.textContent = sessionLabel(current);
      }
    } catch (error) {
      showSessionsError(error, () => refreshSessions());
    }
  }

  function updateUrl() {
    const params = new URLSearchParams();
    params.set("app", appKey);
    if (projectId.length > 0) params.set("project", projectId);
    if (sessionId !== null) params.set("session", sessionId);
    window.history.replaceState(null, "", `/chat?${params.toString()}`);
  }

  function resetFeedDom() {
    resetHighlightController({ reason: "feed-reset" });
    clearAllOmoClassifyTimers();
    historyRequest = null;
    messageNodes = new Map();
    partNodes = new Map();
    partOwner.clear();
    partRenderState.clear();
    inlineCards = new Map();
    inlineCardByPart = new Map();
    messagesHydratedSession = null;
    dirtyMessages = new Set();
    dirtyParts = new Set();
    orderDirty = false;
    lastRenderedCount = 0;
    historyRequest = null;
    if (newMessages !== null) newMessages.hidden = true;
    if (historyEl !== null) {
      historyEl.hidden = true;
      historyEl.dataset.state = "idle";
    }
    if (generatingEl !== null) generatingEl.hidden = true;
    if (messagesEl !== null) messagesEl.replaceChildren();
    if (questionPlaceholderEl !== null) questionPlaceholderEl.replaceChildren();
    queueStripSignature = "";
    if (queueStrip !== null) queueStrip.hidden = true;
    if (queueStripCount !== null) queueStripCount.textContent = "";
    if (queueStripList !== null) queueStripList.replaceChildren();
  }

  async function selectSession(id, options) {
    const settings = options || {};
    const previous = sessionId;
    if (previous !== null && previous !== id) saveCurrentRuntime();
    hydrationSeq += 1;
    historyRequestSeq += 1;
    historyRequest = null;
    prependPending = false;
    hydrating = false;
    hydrationBuffer = null;
    sessionId = id;
    contextEpoch += 1;
    clearContextTimers();
    contextCompactingSession = null;
    contextClientError = null;
    hideContextConfirm(false);
    const cachedContext = contextBySession.get(id);
    if (cachedContext !== undefined) renderContext(cachedContext);
    else resetContextUi(false, "Waiting for a completed step.", "Loading context…");
    refreshContext(id).catch(() => {});
    if (previous !== id) {
      store = adoptRuntime(id);
      const runtime = sessionRuntime.get(id);
      historyCursor = runtime === undefined ? null : runtime.historyCursor ?? null;
      historyLoaded = runtime === undefined ? false : runtime.historyLoaded ?? false;
    }
    store.sessionID = id;
    resetFeedDom();
    resetHighlightController({ reason: "session-switch" });
    resetElapsed();
    if (previous !== id) promptActivation.clear();
    sessionSnapshotTooLarge = false;
    setSessionNotice(false);
    recomputeQueue();
    renderSendRecovery();
    const session = sessions.find((candidate) => candidate.id === id);
    if (sessionTitleEl !== null) {
      sessionTitleEl.textContent = session === undefined ? `Session ${id.slice(0, 8)}` : sessionLabel(session);
    }
    if (sessionIdEl !== null) {
      sessionIdEl.textContent = id.slice(0, 8);
      sessionIdEl.title = id;
    }
    updateUrl();
    renderSessions();
    renderPromptDock();
    loadTodo(id).catch(() => {});
    syncComposer();
    closeSessions(false);
    closeContext(false);
    await loadMessages({ initial: true, forceBottom: true });
    if (settings.focusDock === true) {
      refreshInlineQuestions();
      focusRequest();
    } else if (settings.focus === true) {
      if (activePromptEntries().length > 0) focusRequest();
      else if (promptEl instanceof HTMLTextAreaElement) promptEl.focus();
    }
  }

  function startDraft(options) {
    const settings = options || {};
    saveCurrentRuntime();
    hydrationSeq += 1;
    historyRequestSeq += 1;
    historyRequest = null;
    historyCursor = null;
    historyLoaded = false;
    prependPending = false;
    hydrating = false;
    hydrationBuffer = null;
    sessionId = null;
    contextEpoch += 1;
    clearContextTimers();
    contextCompactingSession = null;
    contextClientError = null;
    hideContextConfirm(false);
    resetContextUi(true, "Waiting for a completed step.", "Start a session to compact.");
    store = createThreadStore(null);
    resetFeedDom();
    sessionSnapshotTooLarge = false;
    setSessionNotice(false);
    recomputeQueue();
    renderSendRecovery();
    showSessionError(null);
    if (sessionTitleEl !== null) sessionTitleEl.textContent = "New session";
    if (sessionIdEl !== null) {
      sessionIdEl.textContent = "-";
      sessionIdEl.removeAttribute("title");
    }
    updateUrl();
    renderSessions();
    if (messagesEl !== null) {
      messagesEl.removeAttribute("aria-busy");
      messagesEl.replaceChildren(emptyThread());
    }
    if (countEl !== null) countEl.textContent = plural(0, "message");
    resetElapsed();
    promptActivation.clear();
    renderPromptDock();
    loadTodo(null).catch(() => {});
    syncComposer();
    closeSessions(false);
    closeContext(false);
    if (settings.focus === true && promptEl instanceof HTMLTextAreaElement) {
      promptEl.focus();
    }
  }

  async function ensureSession() {
    if (sessionId !== null) return sessionId;
    if (creatingSession) throw new Error("A session is already starting.");
    creatingSession = true;
    setNewSessionBusy(true);
    try {
      const created = await api(sessionsUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!created || created.id === undefined) {
        throw new Error("Session could not be created.");
      }
      const id = String(created.id);
      sessions = [created, ...sessions.filter((session) => String(session.id) !== id)];
      if (sessionSearch !== null) sessionSearch.value = "";
      sessionId = id;
      contextEpoch += 1;
      clearContextTimers();
      contextCompactingSession = null;
      contextClientError = null;
      hideContextConfirm(false);
      resetContextUi(false, "Waiting for a completed step.", "Loading context…");
      refreshContext(id).catch(() => {});
      if (sessionTitleEl !== null) sessionTitleEl.textContent = sessionLabel(created);
      if (sessionIdEl !== null) {
        sessionIdEl.textContent = id.slice(0, 8);
        sessionIdEl.title = id;
      }
      updateUrl();
      renderSessions();
      closeSessions(false);
      showSessionError(null);
      return id;
    } finally {
      creatingSession = false;
      setNewSessionBusy(creatingSession);
    }
  }

  async function removeSession(id) {
    if (deletingSessions.has(id)) return;
    const session = sessions.find((candidate) => String(candidate.id) === id);
    const label = session === undefined ? `Session ${id.slice(0, 8)}` : sessionLabel(session);
    if (!window.confirm(`Delete session "${label}"? This cannot be undone.`)) {
      return;
    }
    deletingSessions.add(id);
    showSessionError(null);
    renderSessions();
    try {
      await api(sessionUrl(id), { method: "DELETE" });
      const wasActive = sessionId === id;
      sessions = sessions.filter((candidate) => String(candidate.id) !== id);
      deletingSessions.delete(id);
      sessionRuntime.delete(id);
      acceptanceBySession.delete(id);
      contextBySession.delete(id);
      contextSeqBySession.delete(id);
      if (contextPollSession === id) clearContextTimers();
      if (contextCompactingSession === id) contextCompactingSession = null;
      if (wasActive) {
        if (sessions.length > 0) {
          await selectSession(String(sessions[0].id), { focus: false });
        } else {
          startDraft({ focus: false });
        }
      } else {
        renderSessions();
      }
    } catch (error) {
      deletingSessions.delete(id);
      showSessionError(error.message || String(error));
      renderSessions();
    }
  }

  async function bootSessions() {
    setConnection("Starting agent...", "starting");
    showSessionsLoading();
    showMessagesLoading();
    showSessionError(null);
    try {
      const data = await api(sessionsUrl());
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      sessionsFailed = false;
      sessionsLoaded = true;
      renderSessions();
      if (sessions.length === 0) {
        startDraft({ focus: false });
        return;
      }
      const requested = new URLSearchParams(window.location.search).get("session");
      const wanted =
        requested !== null && sessions.some((session) => session.id === requested)
          ? requested
          : sessionId !== null && sessions.some((session) => session.id === sessionId)
            ? sessionId
            : String(sessions[0].id);
      await selectSession(wanted, { focus: false });
    } catch (error) {
      showSessionsError(error, bootSessions);
      showThreadError(error, bootSessions);
    }
  }

  function resizePrompt() {
    if (!(promptEl instanceof HTMLTextAreaElement)) return;
    promptEl.style.height = "auto";
    promptEl.style.height = `${promptEl.scrollHeight}px`;
  }

  function showSendError(message) {
    if (sendError === null) return;
    sendError.hidden = message === null;
    sendError.textContent = message === null ? "" : message;
    if (promptEl instanceof HTMLTextAreaElement) {
      if (message === null) {
        promptEl.removeAttribute("aria-invalid");
        promptEl.setAttribute("aria-describedby", "chat-composer-hint");
      } else {
        promptEl.setAttribute("aria-invalid", "true");
        promptEl.setAttribute(
          "aria-describedby",
          "chat-composer-hint chat-send-error",
        );
      }
    }
  }

  function commandsUrl() {
    return withProject(`${apiBase()}/commands`);
  }

  function serverCommandUrl(id) {
    return withProject(`${apiBase()}/sessions/${encodeURIComponent(id)}/commands`);
  }

  function commandsAreStale() {
    return commandsStatus !== "ready" || Date.now() - commandsFetchedAt > COMMANDS_CACHE_MS;
  }

  async function refreshCommands(options) {
    const settings = options || {};
    if (!settings.force && !commandsAreStale()) return commands;
    if (commandsRequest !== null) return commandsRequest;
    commandsStatus = "loading";
    commandsRequest = (async () => {
      try {
        const data = await api(commandsUrl());
        commands = Array.isArray(data?.commands) ? data.commands : [];
        commandsSources =
          data?.sources !== null && typeof data?.sources === "object"
            ? data.sources
            : { hanse: "ok", opencode: "unavailable" };
        commandsWarnings = Array.isArray(data?.warnings) ? data.warnings : [];
        commandsShadowed = commandsWarnings
          .filter(
            (warning) =>
              warning !== null &&
              typeof warning === "object" &&
              warning.code === "command_shadowed" &&
              typeof warning.command === "string",
          )
          .map((warning) => warning.command);
        commandsStatus = "ready";
        commandsFetchedAt = Date.now();
        return commands;
      } catch {
        commandsStatus = commands.length > 0 ? "ready" : "error";
        if (commands.length === 0) {
          commandsSources = { hanse: "ok", opencode: "unavailable" };
          commandsWarnings = [];
          commandsShadowed = [];
        }
        return commands;
      } finally {
        commandsRequest = null;
        if (paletteOpen) renderCommandPalette();
      }
    })();
    return commandsRequest;
  }

  function effectiveCommandList() {
    if (commands.length > 0) return commands;
    return hanseFallbackEntries(isMaster);
  }

  function paletteSourceNotice() {
    if (commandsStatus === "error") {
      return "Application commands are unavailable; Hanse commands still work";
    }
    const status = commandsSources.opencode;
    if (status === "stopped") return "Application commands load when the agent starts";
    if (status === "unconfigured") {
      return "No agent runtime is configured; Hanse commands still work";
    }
    if (status === "unavailable") {
      return "Application commands are unavailable; Hanse commands still work";
    }
    return null;
  }

  function commandBadge(label, tone) {
    const badge = element("span", "command-palette__badge", label);
    if (tone !== undefined) badge.dataset.tone = tone;
    return badge;
  }

  function renderCommandRow(entry, index) {
    const disabled = entry.available === false;
    const row = element("div", "command-palette__row");
    row.id = `chat-command-option-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.dataset.commandIndex = String(index);
    row.dataset.disabled = disabled ? "true" : "false";
    if (disabled) {
      row.classList.add("command-palette__row--disabled");
      row.setAttribute("aria-disabled", "true");
    }
    const main = element("div", "command-palette__main");
    main.append(element("span", "command-palette__name", `/${entry.name}`));
    if (typeof entry.description === "string" && entry.description.length > 0) {
      main.append(element("span", "command-palette__desc", entry.description));
    }
    if (Array.isArray(entry.hints) && entry.hints.length > 0) {
      main.append(element("span", "command-palette__hints", entry.hints.join(" · ")));
    }
    const badges = element("span", "command-palette__badges");
    if (entry.source === "hanse") {
      badges.append(commandBadge("Hanse", "hanse"));
    } else if (entry.origin === "mcp") {
      badges.append(commandBadge("MCP", "mcp"));
    } else if (entry.origin === "skill") {
      badges.append(commandBadge("Skill", "skill"));
    }
    if (entry.shell === "present" || entry.shell === "unknown") {
      const label = entry.shell === "present" ? "Shell" : "Shell unknown";
      const badge = commandBadge(label, "shell");
      badge.title = "Runs shell commands outside the agent permission flow.";
      badges.append(badge);
      row.append(main, badges);
      row.append(element("span", "command-palette__shell-note", "Confirmation required."));
    } else {
      row.append(main, badges);
    }
    if (disabled && typeof entry.unavailableReason === "string") {
      row.append(element("span", "command-palette__reason", entry.unavailableReason));
    }
    return row;
  }

  function applyPaletteSelection() {
    for (const row of paletteRows) {
      const selected = row.index === paletteActive && !row.disabled;
      row.node.setAttribute("aria-selected", selected ? "true" : "false");
      row.node.classList.toggle("command-palette__row--active", selected);
    }
    const active = paletteRows[paletteActive];
    if (active === undefined || active.disabled) {
      if (promptEl instanceof HTMLTextAreaElement) promptEl.removeAttribute("aria-activedescendant");
      return;
    }
    if (promptEl instanceof HTMLTextAreaElement) {
      promptEl.setAttribute("aria-activedescendant", active.node.id);
    }
    active.node.scrollIntoView({ block: "nearest" });
  }

  function renderCommandPalette(preserveName) {
    if (!paletteOpen || commandListbox === null) return;
    const previous =
      preserveName ??
      (paletteRows[paletteActive] === undefined ? null : paletteRows[paletteActive].entry.name);
    const filtered = filterCommands(effectiveCommandList(), paletteFilter);
    const total = filtered.length;
    const capped = filtered.slice(0, PALETTE_RENDER_LIMIT);
    const groups = groupCommands(capped);
    const children = [];
    paletteRows = [];
    let optionIndex = 0;
    for (const group of groups) {
      const section = element("div", "command-palette__group");
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.label);
      section.append(element("p", "command-palette__group-label", group.label));
      if (group.entries.length === 0) {
        if (
          group.label === "Application commands" &&
          paletteFilter.trim().length === 0 &&
          commandsStatus === "ready" &&
          paletteSourceNotice() === null
        ) {
          section.append(element("p", "command-palette__empty", "No application commands"));
        }
      }
      for (const entry of group.entries) {
        const index = optionIndex;
        optionIndex += 1;
        const node = renderCommandRow(entry, index);
        paletteRows.push({ entry, index, disabled: entry.available === false, node });
        section.append(node);
      }
      children.push(section);
    }
    commandListbox.replaceChildren(...children);

    let activeIndex = -1;
    if (previous !== null) {
      activeIndex = paletteRows.findIndex(
        (row) => !row.disabled && row.entry.name === previous,
      );
    }
    if (activeIndex === -1) activeIndex = paletteRows.findIndex((row) => !row.disabled);
    paletteActive = activeIndex;
    applyPaletteSelection();

    const notice = paletteSourceNotice();
    let status = "";
    if (total === 0) {
      status = "No matching commands";
    } else if (total > PALETTE_RENDER_LIMIT) {
      status = `Showing ${PALETTE_RENDER_LIMIT} of ${total}. Refine your search.`;
    } else {
      status = plural(total, "command");
    }
    if (notice !== null && paletteFilter.trim().length === 0) {
      status = `${status} · ${notice}`;
    }
    if (commandStatusEl !== null) commandStatusEl.textContent = status;
    if (commandShadowEl !== null) {
      if (commandsStatus === "ready" && commandsShadowed.length > 0) {
        commandShadowEl.hidden = false;
        commandShadowEl.textContent = `Provided by the application: ${commandsShadowed
          .map((name) => `/${name}`)
          .join(", ")}`;
      } else {
        commandShadowEl.hidden = true;
        commandShadowEl.textContent = "";
      }
    }
    announce(total === 0 ? "No matching commands" : plural(total, "command"));
  }

  function openCommandPalette(filter, options) {
    const settings = options || {};
    paletteOpen = true;
    paletteFilter = typeof filter === "string" ? filter : "";
    if (commandPalette !== null) commandPalette.hidden = false;
    if (promptEl instanceof HTMLTextAreaElement) {
      promptEl.setAttribute("aria-expanded", "true");
    }
    if (commandsButton !== null) commandsButton.setAttribute("aria-expanded", "true");
    renderCommandPalette();
    if (settings.focus === true && promptEl instanceof HTMLTextAreaElement) promptEl.focus();
    if (commandsAreStale()) refreshCommands({ quiet: true }).catch(() => {});
  }

  function closeCommandPalette(options) {
    const settings = options || {};
    paletteOpen = false;
    paletteFilter = "";
    paletteActive = 0;
    paletteRows = [];
    if (commandPalette !== null) commandPalette.hidden = true;
    if (commandListbox !== null) commandListbox.replaceChildren();
    if (promptEl instanceof HTMLTextAreaElement) {
      promptEl.setAttribute("aria-expanded", "false");
      promptEl.removeAttribute("aria-activedescendant");
    }
    if (commandsButton !== null) commandsButton.setAttribute("aria-expanded", "false");
    if (settings.focus === true && promptEl instanceof HTMLTextAreaElement) promptEl.focus();
  }

  function syncPaletteFromDraft() {
    if (!(promptEl instanceof HTMLTextAreaElement)) return;
    const value = promptEl.value;
    const tokenDraft = /^\/(?!\/)\S*$/.test(value) ? value.slice(1) : null;
    if (paletteOpen) {
      if (tokenDraft === null) {
        closeCommandPalette({});
        return;
      }
      paletteFilter = tokenDraft;
      renderCommandPalette();
      return;
    }
    if (tokenDraft !== null) openCommandPalette(tokenDraft, {});
  }

  function movePaletteActive(target) {
    const enabled = paletteRows.filter((row) => !row.disabled);
    if (enabled.length === 0) return;
    if (target === "home") {
      paletteActive = enabled[0].index;
    } else if (target === "end") {
      paletteActive = enabled[enabled.length - 1].index;
    } else {
      const position = enabled.findIndex((row) => row.index === paletteActive);
      const offset = target === "down" ? 1 : -1;
      const next =
        position === -1
          ? offset > 0
            ? 0
            : enabled.length - 1
          : (position + offset + enabled.length) % enabled.length;
      paletteActive = enabled[next].index;
    }
    applyPaletteSelection();
  }

  function insertCommandRow(index) {
    const row = paletteRows[index];
    if (row === undefined || row.disabled) {
      announce("Choose an available command.");
      return false;
    }
    if (!(promptEl instanceof HTMLTextAreaElement)) return false;
    const line = commandLine(row.entry.name);
    promptEl.value = line;
    promptEl.setSelectionRange(line.length, line.length);
    resizePrompt();
    closeCommandPalette({ focus: true });
    showSendError(null);
    announce(`Inserted /${row.entry.name}`);
    return true;
  }

  function insertActiveCommand() {
    return insertCommandRow(paletteActive);
  }

  function openCommandConfirm(options) {
    const settings = options || {};
    if (commandConfirm === null || typeof commandConfirm.showModal !== "function") {
      return Promise.resolve(
        window.confirm(
          settings.body === undefined ? settings.title : `${settings.title}\n\n${settings.body}`,
        ),
      );
    }
    if (commandConfirmTitle !== null) {
      commandConfirmTitle.textContent = settings.title || "Confirm command";
    }
    if (commandConfirmBody !== null) commandConfirmBody.textContent = settings.body || "";
    if (commandConfirmAccept !== null) {
      commandConfirmAccept.textContent = settings.confirmLabel || "Confirm";
    }
    if (commandConfirmCancel !== null) {
      commandConfirmCancel.textContent = settings.cancelLabel || "Cancel";
    }
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        commandConfirm.removeEventListener("close", onClose);
        if (commandConfirmAccept !== null) {
          commandConfirmAccept.removeEventListener("click", onAccept);
        }
        if (commandConfirmCancel !== null) {
          commandConfirmCancel.removeEventListener("click", onCancel);
        }
        if (commandConfirm.open) commandConfirm.close();
        if (restore !== null && restore.isConnected) restore.focus();
        else if (promptEl instanceof HTMLTextAreaElement) promptEl.focus();
        resolve(value);
      };
      const onClose = () => finish(false);
      const onAccept = () => finish(true);
      const onCancel = () => finish(false);
      commandConfirm.addEventListener("close", onClose);
      if (commandConfirmAccept !== null) commandConfirmAccept.addEventListener("click", onAccept);
      if (commandConfirmCancel !== null) commandConfirmCancel.addEventListener("click", onCancel);
      try {
        commandConfirm.showModal();
      } catch {
        finish(false);
        return;
      }
      if (commandConfirmAccept !== null) commandConfirmAccept.focus();
    });
  }

  function shellConfirmation(entry) {
    return openCommandConfirm({
      title: `Run /${entry.name}?`,
      body: SHELL_CONFIRM_BODY,
      confirmLabel: "Run command",
      cancelLabel: "Cancel",
    });
  }

  function openNewTab(url) {
    if (typeof url !== "string" || url.length === 0) {
      showToast("No link is available.", "error");
      return;
    }
    let opened = null;
    try {
      opened = window.open(url, "_blank");
    } catch {
      opened = null;
    }
    if (opened === null) {
      const notice = "Opened in this tab because the popup was blocked.";
      showToast(notice, "success");
      announce(notice);
      window.location.assign(url);
      return;
    }
    try {
      opened.opener = null;
    } catch {
      // Cross-origin handle; the tab is already open.
    }
  }

  function runCompactCommand() {
    const snapshot = sessionId === null ? null : contextBySession.get(sessionId) ?? null;
    const reason = contextCompactReasonFor(snapshot);
    if (reason !== null) {
      showToast(reason, "error");
      announce(reason);
      return "skipped";
    }
    setContext(true, false);
    openContextConfirm();
    const recheck = contextCompactReasonFor(
      sessionId === null ? null : contextBySession.get(sessionId) ?? null,
    );
    if (recheck !== null) {
      showToast(recheck, "error");
      announce(recheck);
      return "skipped";
    }
    if (
      contextConfirm === null ||
      contextConfirm.hidden ||
      (contextCompactButton !== null && contextCompactButton.disabled)
    ) {
      showToast("Compaction is unavailable.", "error");
      announce("Compaction is unavailable.");
      return "skipped";
    }
    if (contextConfirmCompact instanceof HTMLElement) contextConfirmCompact.focus();
    announce("Compaction confirmation opened.");
    return "ran";
  }

  async function restartApplication() {
    const confirmed = await openCommandConfirm({
      title: `Restart ${appKey}?`,
      body: "An active turn will be interrupted.",
      confirmLabel: "Restart agent",
      cancelLabel: "Cancel",
    });
    if (!confirmed) {
      announce("Restart cancelled.");
      return "skipped";
    }
    announce("Restarting…");
    showToast("Restarting…", "success");
    const query = new URLSearchParams();
    if (projectId.length > 0) query.set("project", projectId);
    query.set("async", "1");
    try {
      await api(`/api/apps/${encodeURIComponent(appKey)}/restart?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      refreshRuntime().catch(() => {});
    } catch (error) {
      if (error !== null && typeof error === "object" && error.status === 409) {
        showToast("A restart is already in progress.", "error");
      } else {
        showToast(error instanceof Error ? error.message : "Restart failed.", "error");
      }
    }
    return "ran";
  }

  async function runHanseAction(resolved, args) {
    const entry = resolved.entry;
    if (resolved.action === "new") {
      startDraft({ focus: true });
      announce("Started a new session.");
      return "ran";
    }
    if (resolved.action === "help") {
      const trimmed = args.trim();
      const filter = trimmed.length === 0 ? "" : trimmed.split(/\s+/)[0];
      closeCommandPalette({});
      openCommandPalette(filter, { focus: true });
      announce(filter.length === 0 ? "Commands" : `Commands filtered by ${filter}`);
      return "palette";
    }
    if (resolved.action === "editor") {
      openNewTab(ideUrl);
      return "ran";
    }
    if (resolved.action === "diff") {
      openNewTab(appPageUrl.length === 0 ? "" : `${appPageUrl}#changes-title`);
      return "ran";
    }
    if (resolved.action === "compact") return runCompactCommand();
    if (resolved.action === "restart") return restartApplication();
    showSendError(`/${entry.name} is not available in this build.`);
    return "skipped";
  }

  function clearComposerValue() {
    if (!(promptEl instanceof HTMLTextAreaElement)) return;
    promptEl.value = "";
    resizePrompt();
    syncComposer();
  }

  async function dispatchComposerDraft() {
    if (!(promptEl instanceof HTMLTextAreaElement)) return "fallthrough";
    if (acceptanceInFlight() || acceptanceUnknown()) return "handled";
    const parsed = parseComposerCommand(promptEl.value);
    if (parsed.kind !== "command") return "fallthrough";
    if (commandsDispatching) return "handled";
    commandsDispatching = true;
    try {
      if (commandsAreStale()) await refreshCommands({ quiet: true });
      if (acceptanceInFlight() || acceptanceUnknown()) return "handled";
      const resolved = resolveComposerCommand(
        commandsStatus === "ready" ? commands : [],
        parsed.token,
        { listAvailable: commandsStatus === "ready", master: isMaster },
      );
      if (resolved.kind === "unknown") {
        showToast("Unknown command; sent as a message.", "error");
        announce("Unknown command; sent as a message.");
        return "fallthrough";
      }
      if (resolved.kind === "disabled") {
        showSendError(resolved.reason);
        announce(resolved.reason);
        return "handled";
      }
      const pending = activePromptEntries().length > 0;
      if (commandBlockedByPending(resolved.entry, pending)) {
        focusRequest();
        showSendError("Answer the pending request first.");
        announce("Answer the pending request first.");
        return "handled";
      }
      if (resolved.kind === "opencode") {
        if (resolved.shadowed) {
          showToast(`/${parsed.token} is provided by the application.`, "error");
          announce(`/${parsed.token} is provided by the application.`);
        }
        await sendServerCommand(resolved.entry, parsed.args);
        return "handled";
      }
      if (resolved.action !== "help" && parsed.args.trim().length > 0) {
        showSendError(`/${resolved.entry.name} does not take arguments.`);
        announce(`/${resolved.entry.name} does not take arguments.`);
        return "handled";
      }
      const draft = promptEl.value;
      clearComposerValue();
      const outcome = await runHanseAction(resolved, parsed.args);
      if (outcome === "skipped") {
        if (promptEl.value.length === 0) {
          promptEl.value = draft;
          resizePrompt();
        }
        return "handled";
      }
      if (outcome !== "palette") closeCommandPalette({ focus: true });
      return "handled";
    } finally {
      commandsDispatching = false;
    }
  }

  async function sendServerCommand(entry, args) {
    if (!(promptEl instanceof HTMLTextAreaElement)) return;
    const draft = promptEl.value;
    const initialSession = sessionId;
    const acceptanceKey = initialSession === null ? "draft" : initialSession;
    const state = acceptanceFor(acceptanceKey);
    if (state.inFlight || state.state === "unknown") return;

    let confirmShell = false;
    if (shellRequiresConfirmation(entry.shell)) {
      const confirmed = await shellConfirmation(entry);
      if (!confirmed) {
        announce("Command cancelled.");
        return;
      }
      confirmShell = true;
    }
    if (acceptanceInFlight() || acceptanceUnknown()) return;
    if (activePromptEntries().length > 0) {
      focusRequest();
      showSendError("Answer the pending request first.");
      return;
    }

    const lineText = commandLine(entry.name, args).trim();
    const tempID = localID();
    const knownUserIDs = new Set();
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record !== undefined && record.role === "user") knownUserIDs.add(id);
    }
    state.inFlight = true;
    state.posting = false;
    state.state = "sending";
    state.sessionID = initialSession;
    state.tempID = tempID;
    state.serverID = null;
    state.text = lineText;
    state.knownUserIDs = knownUserIDs;
    state.bufferedEvents = [];
    clearAcceptanceGrace(state);
    insertOptimisticMessage(tempID, lineText);
    showSendError(null);
    showSessionError(null);
    setSessionNotice(false);
    promptEl.value = "";
    resizePrompt();
    closeCommandPalette({});
    syncComposer();
    renderSendRecovery();

    const run = async () => {
      let id = initialSession;
      let posted = false;
      let retriedConfirmation = false;
      try {
        if (id === null) {
          id = await ensureSession();
          moveAcceptance("draft", id);
          state.sessionID = id;
          store.sessionID = id;
        }
        for (;;) {
          state.posting = true;
          updateWorkingStatus();
          posted = true;
          let accepted;
          try {
            accepted = await api(serverCommandUrl(id), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: entry.name,
                arguments: args,
                confirmShell,
              }),
            });
          } catch (error) {
            state.posting = false;
            if (
              !retriedConfirmation &&
              error !== null &&
              typeof error === "object" &&
              error.status === 400 &&
              error.code === "shell_confirmation_required"
            ) {
              const confirmed = await shellConfirmation(entry);
              if (!confirmed) {
                removeAcceptanceRow(state, tempID);
                state.inFlight = false;
                state.posting = false;
                state.state = "idle";
                state.commandAccepted = false;
                state.tempID = null;
                state.serverID = null;
                state.text = "";
                state.knownUserIDs = new Set();
                state.bufferedEvents = [];
                clearAcceptanceGrace(state);
                if (promptEl.value.length === 0) {
                  promptEl.value = draft;
                  resizePrompt();
                }
                syncComposer();
                renderSendRecovery();
                scheduleFlush();
                announce("Command cancelled.");
                return;
              }
              retriedConfirmation = true;
              confirmShell = true;
              continue;
            }
            throw error;
          }
          state.posting = false;
          const serverID =
            accepted !== null &&
            typeof accepted === "object" &&
            typeof accepted.messageID === "string"
              ? accepted.messageID
              : null;
          if (serverID === null) {
            const failure = new Error("Delivery unknown; checking…");
            failure.outcome = "unknown";
            throw failure;
          }
          rekeyAcceptanceRow(state, serverID, false);
          state.state = "accepted";
          state.commandAccepted = true;
          state.inFlight = false;
          state.tempID = null;
          state.serverID = serverID;
          clearAcceptanceGrace(state);
          recomputeQueue();
          syncComposer();
          renderSendRecovery();
          refreshRuntime().catch(() => {});
          refreshSessions().catch(() => {});
          if (sessionId === id && promptEl instanceof HTMLTextAreaElement) promptEl.focus();
          return;
        }
      } catch (error) {
        state.posting = false;
        const outcome =
          error !== null && typeof error === "object" ? error.outcome : undefined;
        const code = error !== null && typeof error === "object" ? error.code : undefined;
        const status = error !== null && typeof error === "object" ? error.status : undefined;
        const unknown =
          outcome === "unknown" ||
          code === "command_failed" ||
          (posted && status === undefined);
        if (unknown) {
          const returnedID =
            error !== null && typeof error === "object" && typeof error.messageID === "string"
              ? error.messageID
              : null;
          if (returnedID !== null) {
            if (!rekeyAcceptanceRow(state, returnedID, true)) {
              state.serverID = returnedID;
              state.tempID = null;
            }
            state.state = "unknown";
            state.commandAccepted = false;
            state.inFlight = false;
            clearAcceptanceGrace(state);
            recomputeQueue();
          } else {
            const record = activeRowFor(state, tempID);
            if (record !== undefined && record !== null) {
              record.optimistic = "unknown";
              record.version += 1;
              if (state.sessionID === sessionId) dirtyMessages.add(tempID);
            }
            state.state = "unknown";
            state.commandAccepted = false;
            state.inFlight = false;
            if (state.sessionID === sessionId) {
              recomputeQueue();
              scheduleFlush();
            }
          }
          syncComposer();
          renderSendRecovery();
          showToast(error instanceof Error ? error.message : "Delivery unknown; checking…", "error");
          if (sessionId !== null) {
            hydrateMessages({ reason: "unknown", silent: true }).catch(() => {});
          }
          refreshRuntime().catch(() => {});
          return;
        }
        removeAcceptanceRow(state, tempID);
        state.inFlight = false;
        state.posting = false;
        state.state = "idle";
        state.commandAccepted = false;
        state.tempID = null;
        state.serverID = null;
        state.text = "";
        state.knownUserIDs = new Set();
        state.bufferedEvents = [];
        clearAcceptanceGrace(state);
        if (promptEl.value.length === 0) {
          promptEl.value = draft;
          resizePrompt();
        }
        showSendError(error instanceof Error ? error.message : String(error));
        if (status === 404 && code === "command_not_found") {
          refreshCommands({ force: true, quiet: true }).catch(() => {});
        }
        syncComposer();
        renderSendRecovery();
        scheduleFlush();
        refreshRuntime().catch(() => {});
      }
    };
    state.chain = state.chain.then(run, run);
  }

  async function sendPrompt() {
    if (!(promptEl instanceof HTMLTextAreaElement)) return;
    if (acceptanceInFlight() || acceptanceUnknown()) return;
    const dispatched = await dispatchComposerDraft();
    if (dispatched === "handled") return;
    if (activePromptEntries().length > 0) {
      focusRequest();
      return;
    }
    const text = promptEl.value.trim();
    if (text.length === 0) {
      promptEl.focus();
      return;
    }
    const draft = promptEl.value;
    const initialSession = sessionId;
    const acceptanceKey = initialSession === null ? "draft" : initialSession;
    const state = acceptanceFor(acceptanceKey);
    if (state.inFlight || state.state === "unknown") return;
    const tempID = localID();
    const knownUserIDs = new Set();
    for (const id of store.order) {
      const record = store.messages.get(id);
      if (record !== undefined && record.role === "user") knownUserIDs.add(id);
    }
    state.inFlight = true;
    state.posting = false;
    state.state = "sending";
    state.sessionID = initialSession;
    state.tempID = tempID;
    state.serverID = null;
    state.text = text;
    state.knownUserIDs = knownUserIDs;
    state.bufferedEvents = [];
    clearAcceptanceGrace(state);
    insertOptimisticMessage(tempID, text);
    showSendError(null);
    showSessionError(null);
    setSessionNotice(false);
    promptEl.value = "";
    resizePrompt();
    syncComposer();
    renderSendRecovery();

    const run = async () => {
      let id = initialSession;
      let posted = false;
      try {
        if (id === null) {
          id = await ensureSession();
          moveAcceptance("draft", id);
          state.sessionID = id;
          store.sessionID = id;
        }
        state.posting = true;
        updateWorkingStatus();
        posted = true;
        const accepted = await api(asyncMessagesUrl(id), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        state.posting = false;
        const serverID =
          accepted !== null && typeof accepted === "object" && typeof accepted.messageID === "string"
            ? accepted.messageID
            : null;
        if (serverID === null) {
          const failure = new Error("Delivery unknown; checking…");
          failure.outcome = "unknown";
          throw failure;
        }
        rekeyAcceptanceRow(state, serverID, false);
        state.state = "accepted";
        state.inFlight = false;
        state.tempID = null;
        state.serverID = serverID;
        clearAcceptanceGrace(state);
        recomputeQueue();
        syncComposer();
        refreshRuntime().catch(() => {});
        if (sessionId === id && promptEl instanceof HTMLTextAreaElement) promptEl.focus();
        refreshSessions().catch(() => {});
      } catch (error) {
        state.posting = false;
        const outcome =
          error !== null && typeof error === "object" ? error.outcome : undefined;
        const unknown =
          outcome === "unknown" ||
          (posted &&
            (error === null || typeof error !== "object" || error.status === undefined));
        if (unknown) {
          const returnedID =
            error !== null && typeof error === "object" && typeof error.messageID === "string"
              ? error.messageID
              : null;
          if (returnedID !== null) {
            if (!rekeyAcceptanceRow(state, returnedID, true)) {
              state.serverID = returnedID;
              state.tempID = null;
            }
            state.state = "unknown";
            state.inFlight = false;
            clearAcceptanceGrace(state);
            recomputeQueue();
          } else {
            const record = activeRowFor(state, tempID);
            if (record !== undefined && record !== null) {
              record.optimistic = "unknown";
              record.version += 1;
              if (state.sessionID === sessionId) dirtyMessages.add(tempID);
            }
            state.state = "unknown";
            state.inFlight = false;
            if (state.sessionID === sessionId) {
              recomputeQueue();
              scheduleFlush();
            }
          }
          syncComposer();
          renderSendRecovery();
          if (sessionId !== null) {
            hydrateMessages({ reason: "unknown", silent: true }).catch(() => {});
          }
        } else {
          removeAcceptanceRow(state, tempID);
          state.inFlight = false;
          state.posting = false;
          state.state = "idle";
          state.tempID = null;
          state.serverID = null;
          state.text = "";
          state.knownUserIDs = new Set();
          state.bufferedEvents = [];
          clearAcceptanceGrace(state);
          if (promptEl instanceof HTMLTextAreaElement && promptEl.value.length === 0) {
            promptEl.value = draft;
            resizePrompt();
          }
          showSendError(error.message || String(error));
          syncComposer();
          renderSendRecovery();
          scheduleFlush();
        }
        refreshRuntime().catch(() => {});
      }
    };
    state.chain = state.chain.then(run, run);
  }

  function contextOpen() {
    return shell.dataset.chatContext === "open";
  }

  function sessionsOpen() {
    return shell.dataset.chatSessions === "open";
  }

  function setToggleExpanded(toggles, expanded) {
    for (const toggle of toggles) toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function closeGlobalNav() {
    const appShell = document.getElementById("shell");
    const toggle = document.querySelector("[data-nav-toggle]");
    if (appShell !== null && appShell.dataset.nav === "open") {
      appShell.dataset.nav = "closed";
      if (toggle !== null) {
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open navigation");
      }
    }
  }

  function setContext(open, returnFocus) {
    shell.dataset.chatContext = open ? "open" : "closed";
    setToggleExpanded(contextToggles, open);
    if (open) {
      closeSessions(false);
      closeGlobalNav();
      if (contextClose instanceof HTMLElement) contextClose.focus();
    } else if (returnFocus === true) {
      const toggle = contextToggles[0];
      if (toggle instanceof HTMLElement) toggle.focus();
    }
  }

  function setSessions(open, returnFocus) {
    shell.dataset.chatSessions = open ? "open" : "closed";
    setToggleExpanded(sessionsToggles, open);
    if (open) {
      closeContext(false);
      closeGlobalNav();
      if (sessionsClose instanceof HTMLElement) sessionsClose.focus();
    } else if (returnFocus === true) {
      const toggle = sessionsToggles[0];
      if (toggle instanceof HTMLElement) toggle.focus();
    }
  }

  function closeContext(returnFocus) {
    setContext(false, returnFocus);
  }

  function closeSessions(returnFocus) {
    setSessions(false, returnFocus);
  }

  for (const toggle of contextToggles) {
    toggle.addEventListener("click", () => setContext(!contextOpen(), false));
  }
  for (const toggle of sessionsToggles) {
    toggle.addEventListener("click", () => setSessions(!sessionsOpen(), false));
  }
  if (contextClose instanceof HTMLElement) {
    contextClose.addEventListener("click", () => closeContext(true));
  }
  if (sessionsClose instanceof HTMLElement) {
    sessionsClose.addEventListener("click", () => closeSessions(true));
  }
  if (scrim instanceof HTMLElement) {
    scrim.addEventListener("click", () => {
      if (contextOpen()) closeContext(true);
      else if (sessionsOpen()) closeSessions(true);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (paletteOpen) {
      event.preventDefault();
      closeCommandPalette({ focus: true });
      return;
    }
    if (cancelPromptStep()) {
      event.preventDefault();
      return;
    }
    if (queueEl !== null && !queueEl.hidden) {
      event.preventDefault();
      closeQueue(true);
      return;
    }
    if (contextConfirm !== null && !contextConfirm.hidden) {
      event.preventDefault();
      hideContextConfirm(true);
      return;
    }
    if (contextOpen()) {
      event.preventDefault();
      closeContext(true);
    } else if (sessionsOpen()) {
      event.preventDefault();
      closeSessions(true);
    }
  });
  const navToggle = document.querySelector("[data-nav-toggle]");
  if (navToggle !== null) {
    navToggle.addEventListener("click", () => {
      closeContext(false);
      closeSessions(false);
    });
  }
  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 1360px)").matches && contextOpen()) closeContext(false);
    if (window.matchMedia("(min-width: 768px)").matches && sessionsOpen()) closeSessions(false);
  });

  if (sessionSearch !== null) {
    sessionSearch.addEventListener("input", renderSessions);
  }
  for (const button of newSessionButtons()) {
    button.addEventListener("click", () => {
      if (!creatingSession) startDraft({ focus: true });
    });
  }
  if (appSelect instanceof HTMLSelectElement) {
    appSelect.addEventListener("change", () => {
      const option = appSelect.selectedOptions[0];
      const project = option === undefined ? "" : option.dataset.project || "";
      const app = option === undefined ? "" : option.dataset.app || "";
      if (project.length > 0 && app.length > 0) {
        window.location.href = `/chat?app=${encodeURIComponent(app)}&project=${encodeURIComponent(project)}`;
      }
    });
  }
  if (sendCheck instanceof HTMLButtonElement) {
    sendCheck.addEventListener("click", () => {
      const key = sessionId === null ? "draft" : sessionId;
      checkUnknownAcceptance(key).catch(() => {});
    });
  }
  if (sendRemove instanceof HTMLButtonElement) {
    sendRemove.addEventListener("click", () => {
      const key = sessionId === null ? "draft" : sessionId;
      removeUnknownAcceptance(key);
    });
  }
  if (promptEl instanceof HTMLTextAreaElement) {
    promptEl.addEventListener("input", () => {
      resizePrompt();
      syncPaletteFromDraft();
    });
    promptEl.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (paletteOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeCommandPalette({ focus: true });
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          movePaletteActive(event.key === "ArrowDown" ? "down" : "up");
          return;
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          movePaletteActive(event.key === "Home" ? "home" : "end");
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          if (insertActiveCommand()) return;
          if (event.key === "Enter" && paletteRows.length === 0) {
            closeCommandPalette({ focus: true });
            sendPrompt();
          }
          return;
        }
        return;
      }
      if (event.key !== "Enter") return;
      if (event.metaKey || event.ctrlKey || !event.shiftKey) {
        event.preventDefault();
        sendPrompt();
      }
    });
    resizePrompt();
  }
  if (composer !== null) {
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (paletteOpen && insertActiveCommand()) return;
      sendPrompt();
    });
  }
  if (commandsButton !== null) {
    commandsButton.addEventListener("click", () => {
      if (paletteOpen) {
        closeCommandPalette({ focus: true });
        return;
      }
      openCommandPalette("", { focus: true });
    });
  }
  if (commandListbox !== null) {
    commandListbox.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    commandListbox.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-command-index]") : null;
      if (!(target instanceof HTMLElement)) return;
      const index = Number(target.dataset.commandIndex);
      if (!Number.isInteger(index)) return;
      insertCommandRow(index);
    });
  }
  if (scrollEl !== null) {
    scrollEl.addEventListener("scroll", () => {
      if (isAtBottom() && newMessages !== null) newMessages.hidden = true;
      if (scrollEl.scrollTop > HISTORY_SCROLL_THRESHOLD_PX) return;
      if (historyScrollFrame !== null) return;
      historyScrollFrame = window.requestAnimationFrame(() => {
        historyScrollFrame = null;
        if (scrollEl.scrollTop <= HISTORY_SCROLL_THRESHOLD_PX) {
          loadOlderMessages().catch(() => {});
        }
      });
    });
  }
  if (newMessages !== null) {
    newMessages.addEventListener("click", () => {
      if (scrollEl !== null) scrollEl.scrollTop = scrollEl.scrollHeight;
      newMessages.hidden = true;
      if (promptEl instanceof HTMLTextAreaElement) promptEl.focus();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopRuntimePolling();
      return;
    }
    if (flushPending) {
      flushPending = false;
      const prepend = prependPending;
      prependPending = false;
      flushFrame({ full: true, prepend });
    }
    refreshRuntime().catch(() => {});
    startRuntimePolling();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    const target =
      event.target instanceof Element
        ? event.target.closest("#chat-prompt-dock, .chat-question")
        : null;
    if (!(target instanceof HTMLElement)) return;
    let entry;
    if (target.classList.contains("chat-question")) {
      if (
        target.dataset.state !== "pending" &&
        target.dataset.state !== "preparing" &&
        target.dataset.state !== "part-unavailable"
      ) {
        return;
      }
      const key = target.dataset.questionKey;
      entry = Array.from(prompts.values()).find((candidate) => candidate.key === key);
    } else {
      entry = activeDockEntries()[0];
    }
    if (entry === undefined || entry.kind !== "question") return;
    event.preventDefault();
    const controller = isCorrelatedQuestion(entry)
      ? questionController(entry, {
          scope: target,
          prefix: inlineIdPrefix(questionCorrelationKey(entry.request)),
          inline: true,
          correlationKey: questionCorrelationKey(entry.request),
          rerender: () => refreshInlineQuestion(questionCorrelationKey(entry.request), true),
        })
      : questionController(entry, {
          scope: promptDock,
          prefix: "",
          inline: false,
          rerender: renderPromptDock,
        });
    runQuestionPrimaryAction(entry, controller);
  });
  if (inputNeeded !== null) {
    inputNeeded.addEventListener("click", () => {
      if (queueEl !== null && !queueEl.hidden) closeQueue(true);
      else openQueue();
    });
  }
  if (queueClose instanceof HTMLElement) {
    queueClose.addEventListener("click", () => closeQueue(true));
  }
  if (policyChip !== null) {
    policyChip.addEventListener("click", () => {
      dismissedWarnings.clear();
      renderPolicyWarnings();
      if (policyWarning !== null && !policyWarning.hidden) {
        policyWarning.scrollIntoView({ block: "nearest" });
        const dismiss = policyWarning.querySelector("button");
        if (dismiss instanceof HTMLElement) dismiss.focus();
      }
    });
  }
  if (planChip !== null) {
    planChip.addEventListener("click", () => {
      setContext(true, false);
      window.setTimeout(() => {
        if (planSection !== null) planSection.scrollIntoView({ block: "start" });
        if (planHeading instanceof HTMLElement) planHeading.focus();
      }, 220);
    });
  }
  if (contextChip !== null) {
    contextChip.addEventListener("click", () => {
      setContext(true, false);
      window.setTimeout(() => {
        if (contextUsage !== null) contextUsage.scrollIntoView({ block: "start" });
        const heading = document.getElementById("context-usage-title");
        if (heading instanceof HTMLElement) heading.focus();
      }, 220);
    });
  }
  if (contextCompactButton !== null) {
    contextCompactButton.addEventListener("click", openContextConfirm);
  }
  if (contextConfirmCompact !== null) {
    contextConfirmCompact.addEventListener("click", () => compactContext());
  }
  if (contextConfirmCancel !== null) {
    contextConfirmCancel.addEventListener("click", () => hideContextConfirm(true));
  }
  if (streamRetry !== null) {
    streamRetry.addEventListener("click", () => {
      streamRetry.hidden = true;
      setConnection("Connecting", "reconnecting");
      subscribe();
      hydrate().catch(() => {});
      loadMessages({ silent: true }).catch(() => {});
    });
  }
  window.addEventListener("beforeunload", closeStream);
  window.addEventListener("beforeunload", clearContextTimers);

  const sshApprovalSlot = document.getElementById("chat-ssh-approvals");
  if (sshApprovalSlot instanceof HTMLElement) {
    let sshTimer = 0;
    const refreshSshApprovals = async () => {
      try {
        const response = await fetch(withProject(`${apiBase()}/ssh/approvals`), {
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;
        const data = await response.json();
        const approvals = Array.isArray(data.approvals) ? data.approvals : [];
        sshApprovalSlot.replaceChildren();
        if (approvals.length === 0) {
          sshApprovalSlot.hidden = true;
          return;
        }
        sshApprovalSlot.hidden = false;
        for (const approval of approvals) {
          const card = element("section", "card ssh-approval-card");
          card.dataset.approvalId = String(approval.id);
          const body = element("div", "card__body stack--tight");
          body.append(element("p", "overline", "SSH approval required"));
          body.append(
            element("h2", "card__title", `${approval.hostName} · ${approval.action}`),
          );
          body.append(element("pre", "ssh-command", String(approval.commandPreview ?? "")));
          body.append(
            element(
              "p",
              "small",
              `Requested ${approval.requestedAt}; expires ${approval.expiresAt}. Approving grants this application arbitrary command execution on this host while the grant is active.`,
            ),
          );
          const actions = element("div", "cluster");
          const buttons = [
            ["Approve", "approve", "btn btn-primary btn-sm"],
            ["Reject", "reject", "btn btn-ghost btn-sm"],
          ];
          for (const [label, decision, className] of buttons) {
            const button = element("button", className, label);
            button.type = "button";
            button.addEventListener("click", async () => {
              button.disabled = true;
              try {
                await fetch(
                  withProject(
                    `${apiBase()}/ssh/approvals/${encodeURIComponent(approval.id)}/decision`,
                  ),
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ decision }),
                  },
                );
                await refreshSshApprovals();
              } finally {
                button.disabled = false;
              }
            });
            actions.append(button);
          }
          body.append(actions);
          card.append(body);
          sshApprovalSlot.append(card);
        }
      } catch {
        // keep the last rendered approval state
      }
    };
    void refreshSshApprovals();
    sshTimer = window.setInterval(() => {
      if (!document.hidden) void refreshSshApprovals();
    }, 5000);
    window.addEventListener("beforeunload", () => window.clearInterval(sshTimer));
  }

  bootSessions();
  subscribe();
  hydrate().catch(() => {});
  refreshRuntime().catch(() => {});
  syncRuntimePolling();
}

main();
