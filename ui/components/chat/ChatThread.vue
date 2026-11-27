<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from "vue";
import type { AttachmentView } from "../../../assets/chat-core.js";
import {
  contextChipLabel,
  contextDetail,
  contextMeterPercent,
  contextStateClass,
} from "../../../assets/chat-core.js";
import type { ContextSnapshot } from "../../../src/opencode/context.js";
import type { NormalizedTodo } from "../../../src/opencode/prompts.js";
import { threadItemKey } from "../../chat/notice-groups.js";
import {
  type ChatScrollMemory,
  readScrollMemory,
  scrollMemoryKey,
  writeScrollMemory,
} from "../../chat/scroll-memory.js";
import type { ChatStreamStatusKind } from "../../chat/stream.js";
import {
  createTranscriptMemory,
  TRANSCRIPT_DETAIL_SCOPE,
  type TranscriptDetailScope,
  type TranscriptMemory,
} from "../../chat/transcript-memory.js";
import { computeTranscriptWindow, type TranscriptWindow } from "../../chat/transcript-window.js";
import type { ChatMessagePartView, ChatThreadItem, InlineQuestionView } from "../../chat/types.js";
import { absoluteTime, timeAgo } from "../../format.js";
import type { ProcessError, ProcessPhase, ProcessState } from "../../process/types.js";
import { processPill, runtimePill } from "../../status.js";
import AppIcon from "../AppIcon.vue";
import ChatGeneratingRow from "./ChatGeneratingRow.vue";
import ChatMessage from "./ChatMessage.vue";
import ChatNoticeGroupRow from "./ChatNoticeGroupRow.vue";
import ChatNoticeRow from "./ChatNoticeRow.vue";
import ChatWorkGroup from "./ChatWorkGroup.vue";

const DEFAULT_FALLBACK_HEIGHT = 160;
const MIN_FALLBACK_HEIGHT = 80;
const MAX_FALLBACK_HEIGHT = 480;
const DEFAULT_GAP = 20;
const ACTIVATION_COUNT = 60;
const ACTIVATION_VIEWPORTS = 8;
const OVERSCAN_VIEWPORTS = 2;

const props = defineProps<{
  items: readonly ChatThreadItem[];
  appKey?: string;
  sessionId: string | null;
  workspaceKey: string;
  revision: number;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  empty: boolean;
  stopped: boolean;
  loadEarlierEnabled: boolean;
  /** Number of loaded messages (`feed.thread.order.length`), not items or rendered rows. */
  loadedMessageCount?: number;
  messageCount?: string;
  generatingLabel?: string | null;
  queuedCount?: number;
  queuedTruncated?: boolean;
  startingAgent?: boolean;
  sessionTitle?: string;
  streamStatus?: ChatStreamStatusKind;
  processState?: ProcessState | null;
  processPhase?: ProcessPhase | null;
  processElapsed?: string;
  processError?: ProcessError | null;
  processHistoryHref?: string;
  processBusy?: boolean;
  waiting?: boolean;
  todos?: readonly NormalizedTodo[];
  contextSnapshot?: ContextSnapshot | null;
  approvalCount?: number;
  questionViewForPart?: (part: ChatMessagePartView, messageID: string) => InlineQuestionView | null;
}>();

const emit = defineEmits<{
  "load-earlier": [];
  "question-submit": [view: InlineQuestionView, answers: string[][]];
  "question-reject": [view: InlineQuestionView];
  "open-image": [attachment: AttachmentView];
  "open-context": [section: "context" | "plan"];
  "open-queue": [];
  start: [];
}>();

const sessionTitleText = computed(() => {
  const title = props.sessionTitle?.trim();
  if (title !== undefined && title.length > 0) return title;
  return props.sessionId === null ? "Session" : `Session ${props.sessionId.slice(0, 8)}`;
});
const sessionShortId = computed(() =>
  props.sessionId === null ? "" : props.sessionId.slice(0, 8),
);
const turnStatus = computed(() => {
  const full = props.generatingLabel?.trim() ?? "";
  if (full.length === 0 || props.stopped) return null;
  const count =
    typeof props.queuedCount === "number" && Number.isFinite(props.queuedCount)
      ? Math.max(0, Math.floor(props.queuedCount))
      : 0;
  const truncated = props.queuedTruncated === true && count > 0;
  const suffix = count > 0 ? ` · ${count}${truncated ? "+" : ""} queued` : "";
  const label = suffix.length > 0 && full.endsWith(suffix) ? full.slice(0, -suffix.length) : full;
  return { label, count, truncated };
});
const queueButtonLabel = computed(() => {
  const status = turnStatus.value;
  if (status === null || status.count === 0) return "Queued messages";
  const count = `${status.count}${status.truncated ? "+" : ""}`;
  return `Show ${count} queued ${status.count === 1 ? "message" : "messages"}`;
});
const queueButtonText = computed(() => {
  const status = turnStatus.value;
  if (status === null || status.count === 0) return "";
  return `· ${status.count}${status.truncated ? "+" : ""} queued`;
});
const liveState = computed(() => {
  if (props.streamStatus === "live") return "live";
  if (props.streamStatus === "paused") return "paused";
  return "starting";
});
const liveLabel = computed(() => {
  if (props.streamStatus === "live") return "Live";
  if (props.streamStatus === "paused") return "Paused";
  return "Connecting";
});
const hasProcess = computed(() => props.processState !== undefined && props.processState !== null);
const processStarting = computed(
  () => hasProcess.value && props.processState === "starting" && props.processPhase !== "stopping",
);
const processStopping = computed(() => hasProcess.value && props.processPhase === "stopping");
const processFailed = computed(() => hasProcess.value && props.processState === "error");
const stoppedPanel = computed(() =>
  hasProcess.value ? props.processState === "stopped" : props.stopped,
);
const processPillSpec = computed(() => {
  const state = props.processState;
  const errorCode = props.processError?.code ?? null;
  if (state === "error") return processPill("error", props.processPhase ?? null, errorCode, null);
  if (state === "running")
    return processPill("running", props.processPhase ?? null, errorCode, null);
  if (state === "stopped") return runtimePill("stopped");
  return processPill("starting", props.processPhase ?? null, errorCode, null);
});
const processErrorTitle = computed(() =>
  props.processError?.code === "oom_killed" ? "Agent ran out of memory" : "Agent failed to start",
);
const processErrorText = computed(() => {
  const message = props.processError?.message?.trim();
  return message !== undefined && message.length > 0
    ? message
    : "The agent failed to start. No error details were recorded.";
});
const processErrorAt = computed(() => props.processError?.at ?? null);
const processRetryDisabled = computed(
  () => props.startingAgent === true || props.processBusy === true,
);
const processElapsedText = computed(() => props.processElapsed?.trim() ?? "");
const planCounts = computed(() => {
  const counts = { completed: 0, total: 0 };
  for (const todo of props.todos ?? []) {
    if (todo.status === "cancelled") continue;
    counts.total += 1;
    if (todo.status === "completed") counts.completed += 1;
  }
  return counts;
});
const planLabel = computed(() => `Plan ${planCounts.value.completed}/${planCounts.value.total}`);
const hasPlan = computed(() => (props.todos ?? []).length > 0);
const contextPercent = computed(() => contextMeterPercent(props.contextSnapshot ?? null));
const contextState = computed(() => contextStateClass(props.contextSnapshot ?? null));
const contextLabel = computed(() => contextChipLabel(props.contextSnapshot ?? null));
const contextDetailText = computed(() => contextDetail(props.contextSnapshot ?? null));
const contextTitle = computed(() =>
  props.contextSnapshot === null || props.contextSnapshot === undefined
    ? undefined
    : contextDetailText.value === "—"
      ? undefined
      : contextDetailText.value,
);
const transcriptMemoryKey = computed(() => scrollMemoryKey(props.workspaceKey, props.sessionId));
const transcriptMemory = shallowRef<TranscriptMemory>(
  createTranscriptMemory(transcriptMemoryKey.value),
);
const detailScope: TranscriptDetailScope = {
  isOpen: (id) => transcriptMemory.value.isOpen(id),
  setOpen: (id, open) => {
    transcriptMemory.value.setOpen(id, open);
  },
};
provide(TRANSCRIPT_DETAIL_SCOPE, detailScope);

const scroll = ref<HTMLElement | null>(null);
const pinned = ref(true);
const unseen = ref(0);
const topRequested = ref(false);

// Reactive scroll inputs. Computeds read these refs only; DOM reads happen in event/layout code.
const scrollTopValue = ref(0);
const viewportHeightValue = ref(0);
const runTopValue = ref(0);

// Windowing state. Off until the initial restore settles and the transcript is genuinely large.
const windowEnabled = ref(false);
const measurementReady = ref(false);
const initialRestorePending = ref(true);
const revealIndex = ref<number | null>(null);
const focusedIndex = ref<number | null>(null);
const transcriptGap = ref(DEFAULT_GAP);

const renderedHeights = shallowRef<number[]>([]);
const rowElements = new Map<string, HTMLElement>();
const rowSetters = new Map<string, (value: unknown) => void>();
const rowKeys = new WeakMap<Element, string>();
const heightsByKey = new Map<string, number>();
const indexByKey = new Map<string, number>();
const pendingMeasurements = new Map<string, number>();

let lastFallbackHeight = DEFAULT_FALLBACK_HEIGHT;
let lastCount = props.items.length;
let lastItemKeys: string[] = props.items.map(threadItemKey);
let restorePending: ChatScrollMemory | null = null;
let lastAnchor: ScrollAnchor | null = null;
let bottomFrame: number | null = null;
let measureFrame: number | null = null;
let viewportObserver: ResizeObserver | null = null;
let rowObserver: ResizeObserver | null = null;
let lastClientHeight: number | null = null;
let lastClientWidth: number | null = null;
let lastViewportBox: { width: number; height: number } | null = null;
let suppressLoadEarlier = false;
let activating = false;
let sessionSwitching = false;
// Keys created by an item regrouping/re-key since they were last measured. Their first measurement
// is already part of the frame the structural anchor was captured from, so it must not be folded
// into the measurement delta correction.
let pendingStructuralKeys: Set<string> = new Set();

interface ScrollAnchor extends ChatScrollMemory {
  readonly messageID?: string;
  readonly messageOffset?: number;
}

function element(): HTMLElement | null {
  return scroll.value;
}

function memoryKey(sessionID: string | null = props.sessionId): string | null {
  return scrollMemoryKey(props.workspaceKey, sessionID);
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(() => callback());
  }
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
  } else {
    clearTimeout(handle);
  }
}

function nearBottom(): boolean {
  const node = element();
  if (node === null) {
    return true;
  }
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function setScrollTop(value: number): void {
  const node = element();
  if (node === null) {
    return;
  }
  node.scrollTop = Math.max(0, value);
  scrollTopValue.value = node.scrollTop;
}

function syncViewport(node: HTMLElement): void {
  viewportHeightValue.value = node.clientHeight;
  lastClientHeight = node.clientHeight;
  lastClientWidth = node.clientWidth;
  lastViewportBox = { width: node.offsetWidth, height: node.offsetHeight };
}

function averageFallback(heights: readonly number[]): number {
  let total = 0;
  let measured = 0;
  for (const height of heights) {
    if (height > 0) {
      total += height;
      measured += 1;
    }
  }
  if (measured === 0) return DEFAULT_FALLBACK_HEIGHT;
  return Math.min(MAX_FALLBACK_HEIGHT, Math.max(MIN_FALLBACK_HEIGHT, total / measured));
}

const fallbackHeight = computed(() => averageFallback(renderedHeights.value));

function effectiveHeight(height: number | undefined): number {
  return height !== undefined && height > 0 ? height : fallbackHeight.value;
}

function itemTop(index: number): number {
  const heights = renderedHeights.value;
  const limit = Math.max(0, Math.min(index, heights.length));
  let total = 0;
  for (let position = 0; position < limit; position += 1) {
    total += effectiveHeight(heights[position]);
  }
  return total + transcriptGap.value * index;
}

function itemIndexByKey(key: string): number {
  const cached = indexByKey.get(key);
  if (cached !== undefined) return cached;
  return props.items.findIndex((item) => threadItemKey(item) === key);
}

const focusWindow = computed<TranscriptWindow>(() => {
  const viewport = viewportHeightValue.value;
  return computeTranscriptWindow({
    heights: renderedHeights.value,
    fallbackHeight: fallbackHeight.value,
    gap: transcriptGap.value,
    localScrollTop: Math.max(0, scrollTopValue.value - runTopValue.value),
    viewportHeight: viewport,
    // One extra overscan on each side beyond the base window bounds the focus keep-alive.
    overscan: viewport * (OVERSCAN_VIEWPORTS * 2),
    pinned: pinned.value,
    keepAlive: [],
    revealIndex: revealIndex.value ?? undefined,
    enabled: windowEnabled.value,
  });
});

const keepAliveIndices = computed<readonly number[]>(() => {
  const index = focusedIndex.value;
  if (index === null || !windowEnabled.value) return [];
  const bounds = focusWindow.value;
  return index >= bounds.start && index < bounds.end ? [index] : [];
});

const windowRange = computed<TranscriptWindow>(() => {
  const viewport = viewportHeightValue.value;
  return computeTranscriptWindow({
    heights: renderedHeights.value,
    fallbackHeight: fallbackHeight.value,
    gap: transcriptGap.value,
    localScrollTop: Math.max(0, scrollTopValue.value - runTopValue.value),
    viewportHeight: viewport,
    overscan: viewport * OVERSCAN_VIEWPORTS,
    pinned: pinned.value,
    keepAlive: keepAliveIndices.value,
    revealIndex: revealIndex.value ?? undefined,
    enabled: windowEnabled.value,
  });
});

const renderedItems = computed<readonly ChatThreadItem[]>(() => {
  if (!windowEnabled.value) return props.items;
  const range = windowRange.value;
  return props.items.slice(range.start, range.end);
});

const topPad = computed(() => (windowEnabled.value ? windowRange.value.topPad : 0));
const bottomPad = computed(() => (windowEnabled.value ? windowRange.value.bottomPad : 0));
const loadedCount = computed(() => {
  const provided = props.loadedMessageCount;
  if (typeof provided === "number" && Number.isFinite(provided)) {
    return Math.max(0, Math.floor(provided));
  }
  return props.items.length;
});

function rebuildRenderedHeights(): void {
  const next = new Array<number>(props.items.length);
  indexByKey.clear();
  let measuredTotal = 0;
  let measuredCount = 0;
  for (let index = 0; index < props.items.length; index += 1) {
    const item = props.items[index];
    if (item === undefined) {
      next[index] = 0;
      continue;
    }
    const key = threadItemKey(item);
    indexByKey.set(key, index);
    const height = heightsByKey.get(key) ?? 0;
    next[index] = height;
    if (height > 0) {
      measuredTotal += height;
      measuredCount += 1;
    }
  }
  renderedHeights.value = next;
  lastFallbackHeight =
    measuredCount === 0
      ? DEFAULT_FALLBACK_HEIGHT
      : Math.min(MAX_FALLBACK_HEIGHT, Math.max(MIN_FALLBACK_HEIGHT, measuredTotal / measuredCount));
}

function seedHeightsFromMemory(): void {
  const memory = transcriptMemory.value;
  for (const item of props.items) {
    const key = threadItemKey(item);
    const height = memory.readHeight(key);
    if (height !== undefined && height > 0) {
      heightsByKey.set(key, height);
    }
  }
  rebuildRenderedHeights();
}

function normalizeRowElement(value: unknown): HTMLElement | null {
  if (value instanceof HTMLElement) return value;
  if (value !== null && typeof value === "object" && "$el" in value) {
    const node = (value as { $el?: unknown }).$el;
    if (node instanceof HTMLElement) return node;
  }
  return null;
}

function registerRow(key: string, node: HTMLElement): void {
  const existing = rowElements.get(key);
  if (existing === node) return;
  if (existing !== undefined) {
    rowObserver?.unobserve(existing);
    rowKeys.delete(existing);
  }
  rowElements.set(key, node);
  rowKeys.set(node, key);
  rowObserver?.observe(node);
}

function unregisterRow(key: string, node?: HTMLElement): void {
  const existing = rowElements.get(key);
  if (existing === undefined) return;
  if (node !== undefined && existing !== node) return;
  rowObserver?.unobserve(existing);
  rowKeys.delete(existing);
  rowElements.delete(key);
}

function rowSetter(key: string): (value: unknown) => void {
  const cached = rowSetters.get(key);
  if (cached !== undefined) return cached;
  const setter = (value: unknown): void => {
    const node = normalizeRowElement(value);
    if (node === null) {
      unregisterRow(key);
    } else {
      registerRow(key, node);
    }
  };
  rowSetters.set(key, setter);
  return setter;
}

function readBorderBoxHeight(entry: ResizeObserverEntry): number {
  const raw = entry.borderBoxSize as unknown;
  const box = Array.isArray(raw)
    ? (raw[0] as ResizeObserverSize | undefined)
    : (raw as ResizeObserverSize | undefined);
  if (box !== undefined && typeof box.blockSize === "number" && Number.isFinite(box.blockSize)) {
    return box.blockSize;
  }
  return (entry.target as HTMLElement).offsetHeight;
}

function onRowsResized(entries: readonly ResizeObserverEntry[]): void {
  measurementReady.value = true;
  for (const entry of entries) {
    const key = rowKeys.get(entry.target);
    if (key === undefined) continue;
    const height = readBorderBoxHeight(entry);
    if (!Number.isFinite(height) || height < 0.5) continue;
    const cached = heightsByKey.get(key);
    if (cached !== undefined && Math.abs(cached - height) < 0.5) continue;
    pendingMeasurements.set(key, height);
  }
  scheduleMeasurementFrame();
  maybeActivate();
}

function cancelMeasurementFrame(): void {
  if (measureFrame === null) return;
  cancelFrame(measureFrame);
  measureFrame = null;
}

function scheduleMeasurementFrame(): void {
  if (pendingMeasurements.size === 0 || measureFrame !== null) return;
  measureFrame = requestFrame(() => {
    measureFrame = null;
    flushMeasurements();
  });
}

function flushMeasurements(): void {
  if (pendingMeasurements.size === 0) return;
  const node = element();
  const scrollRect = node?.getBoundingClientRect() ?? null;
  let correction = 0;
  let changed = false;
  for (const [key, height] of pendingMeasurements) {
    const cached = heightsByKey.get(key);
    const baseline = cached ?? lastFallbackHeight;
    const structural = cached === undefined && pendingStructuralKeys.has(key);
    heightsByKey.set(key, height);
    transcriptMemory.value.writeHeight(key, height);
    if (cached === undefined) pendingStructuralKeys.delete(key);
    changed = true;
    if (!structural && node !== null && scrollRect !== null && !pinned.value) {
      const row = rowElements.get(key);
      if (row !== undefined) {
        const rect = row.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom <= scrollRect.top) {
          correction += height - baseline;
        }
      }
    }
  }
  pendingMeasurements.clear();
  if (!changed) {
    maybeActivate();
    return;
  }
  // The new heights rebuild the whole model: the fallback average rescales the pads of every
  // still-unmeasured hidden row at once, not just the rows we just measured. That shift is not
  // covered by `correction` (which only sums mounted rows fully above the viewport), so the whole
  // rendered run can move while scrollTop stays put and the reader is thrown up. Keep the first
  // visible row's viewport offset as the invariant instead: the DOM already absorbed the measured
  // rows' own deltas, so subtract them from the captured offset, then settle from post-render rects.
  const anchored = windowEnabled.value && !pinned.value && node !== null;
  const anchor = anchored ? captureAnchor() : null;
  rebuildRenderedHeights();
  if (pinned.value) {
    scrollToBottom();
    maybeActivate();
    return;
  }
  if (
    anchored &&
    anchor !== null &&
    anchor.key !== undefined &&
    anchor.key.length > 0 &&
    anchor.visualOffset !== undefined
  ) {
    const target: ScrollAnchor = { ...anchor, visualOffset: anchor.visualOffset - correction };
    void restoreLayoutAnchor(target).finally(() => {
      maybeActivate();
    });
    return;
  }
  if (correction !== 0) {
    suppressLoadEarlier = true;
    setScrollTop(scrollTopValue.value + correction);
    lastAnchor = captureAnchor() ?? lastAnchor;
    guardFocus();
    measureRunTop();
    persist();
    requestFrame(() => {
      suppressLoadEarlier = false;
    });
  }
  maybeActivate();
}

function renderedRowNodes(): HTMLElement[] {
  const node = element();
  if (node === null) return [];
  return Array.from(node.querySelectorAll<HTMLElement>("[data-thread-key]"));
}

function messageNodes(): HTMLElement[] {
  const node = element();
  if (node === null) return [];
  return Array.from(node.querySelectorAll<HTMLElement>("[data-message-id]"));
}

function measureRunTop(): void {
  const node = element();
  if (node === null) return;
  const first = renderedRowNodes()[0];
  if (first === undefined) {
    runTopValue.value = 0;
    return;
  }
  const key = first.dataset.threadKey;
  const start = key === undefined ? 0 : Math.max(0, itemIndexByKey(key));
  const scrollRect = node.getBoundingClientRect();
  const rect = first.getBoundingClientRect();
  runTopValue.value = rect.top - scrollRect.top + scrollTopValue.value - itemTop(start);
}

function captureAnchor(): ScrollAnchor | null {
  const node = element();
  if (node === null) return null;
  const anchor: ScrollAnchor = {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
  };
  const scrollRect = node.getBoundingClientRect();
  for (const row of renderedRowNodes()) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > scrollRect.top) {
      const key = row.dataset.threadKey;
      if (key !== undefined && key.length > 0) {
        return { ...anchor, key, visualOffset: rect.top - scrollRect.top };
      }
    }
  }
  for (const message of messageNodes()) {
    if (message.offsetHeight > 0 && message.offsetTop + message.offsetHeight > node.scrollTop) {
      return {
        ...anchor,
        messageID: message.dataset.messageId,
        messageOffset: message.offsetTop - node.scrollTop,
      };
    }
  }
  return anchor;
}

async function restoreAnchor(anchor: ScrollAnchor | ChatScrollMemory | null): Promise<void> {
  const node = element();
  if (node === null || anchor === null) return;
  const key = anchor.key;
  const visualOffset = anchor.visualOffset;
  if (key !== undefined && key.length > 0 && visualOffset !== undefined) {
    const mounted = rowElements.get(key);
    if (mounted !== undefined) {
      const scrollRect = node.getBoundingClientRect();
      const rect = mounted.getBoundingClientRect();
      setScrollTop(node.scrollTop + (rect.top - scrollRect.top) - visualOffset);
    } else {
      const index = itemIndexByKey(key);
      if (index >= 0) {
        revealIndex.value = index;
        setScrollTop(runTopValue.value + itemTop(index) - visualOffset);
        await nextTick();
        const settled = rowElements.get(key);
        if (settled !== undefined) {
          const scrollRect = node.getBoundingClientRect();
          const rect = settled.getBoundingClientRect();
          setScrollTop(node.scrollTop + (rect.top - scrollRect.top) - visualOffset);
        }
        revealIndex.value = null;
      } else {
        setScrollTop(node.scrollHeight - anchor.scrollHeight + anchor.scrollTop);
      }
    }
  } else if ("messageID" in anchor && anchor.messageID !== undefined) {
    const target = messageNodes().find((message) => message.dataset.messageId === anchor.messageID);
    if (target !== undefined && "messageOffset" in anchor) {
      setScrollTop(target.offsetTop - (anchor.messageOffset ?? 0));
    } else {
      setScrollTop(node.scrollHeight - anchor.scrollHeight + anchor.scrollTop);
    }
  } else {
    setScrollTop(node.scrollHeight - anchor.scrollHeight + anchor.scrollTop);
  }
  pinned.value = nearBottom();
  unseen.value = 0;
  topRequested.value = node.scrollTop > 32;
  syncViewport(node);
  lastAnchor = captureAnchor() ?? lastAnchor;
  guardFocus();
  measureRunTop();
  persist();
}

/**
 * Restore a captured reader position after a model or slice rebuild. This is a layout correction,
 * not navigation, so the unseen counter and the load-earlier latch keep their values.
 */
async function restoreLayoutAnchor(anchor: ScrollAnchor): Promise<void> {
  const unseenBefore = unseen.value;
  const topRequestedBefore = topRequested.value;
  suppressLoadEarlier = true;
  try {
    await nextTick();
    await restoreAnchor(anchor);
    unseen.value = unseenBefore;
    topRequested.value = topRequestedBefore;
  } finally {
    requestFrame(() => {
      suppressLoadEarlier = false;
    });
  }
}

async function applyRestore(): Promise<void> {
  const memory = restorePending;
  if (memory === null) return;
  restorePending = null;
  await restoreAnchor(memory);
}

function persist(sessionID: string | null = props.sessionId): void {
  const node = element();
  if (node === null) return;
  const value: { scrollTop: number; scrollHeight: number; key?: string; visualOffset?: number } = {
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
  };
  const anchor = lastAnchor;
  if (windowEnabled.value && anchor !== null) {
    if (anchor.key !== undefined && anchor.key.length > 0) value.key = anchor.key;
    if (anchor.visualOffset !== undefined) value.visualOffset = anchor.visualOffset;
  }
  writeScrollMemory(memoryKey(sessionID), value);
}

function cancelScheduledBottom(): void {
  if (bottomFrame === null) return;
  cancelFrame(bottomFrame);
  bottomFrame = null;
}

function scheduleBottomScroll(): void {
  if (bottomFrame !== null) return;
  bottomFrame = requestFrame(() => {
    bottomFrame = null;
    if (pinned.value) {
      scrollToBottom();
    }
  });
}

function scrollToBottom(): void {
  const node = element();
  if (node === null) return;
  node.scrollTop = node.scrollHeight;
  scrollTopValue.value = node.scrollTop;
  pinned.value = true;
  unseen.value = 0;
  topRequested.value = false;
  syncViewport(node);
  lastAnchor = captureAnchor();
  persist();
}

function guardFocus(): void {
  const index = focusedIndex.value;
  if (index === null || !windowEnabled.value) return;
  const bounds = focusWindow.value;
  if (index >= bounds.start && index < bounds.end) return;
  focusedIndex.value = null;
  const node = element();
  node?.focus({ preventScroll: true });
}

function keyFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest("[data-thread-key]");
  return row instanceof HTMLElement ? (row.dataset.threadKey ?? null) : null;
}

function onFocusIn(event: FocusEvent): void {
  const key = keyFromEventTarget(event.target);
  if (key === null) {
    focusedIndex.value = null;
    return;
  }
  const index = itemIndexByKey(key);
  focusedIndex.value = index >= 0 ? index : null;
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  const node = element();
  if (next instanceof Node && node !== null && node.contains(next)) {
    return;
  }
  focusedIndex.value = null;
}

/**
 * The composer, prompt dock, and banners below the thread can change height while the feed is
 * pinned. Shrinking the scroll viewport raises the bottom edge and would hide the newest rows, so
 * follow the bottom again whenever the viewport itself is resized. A scrolled-up reader keeps the
 * position they chose; a resize must not yank them back.
 */
function onViewportResize(): void {
  const node = element();
  if (node === null) return;
  // A classic scrollbar appearing or disappearing changes the client box but not the border box.
  // That is a scrollbar toggle, not a layout resize: restoring the last anchor here can throw the
  // reader up on desktop, and repeated toggles near the end of a long chat make the end
  // unreachable. Keep the position; only the window needs the new client height.
  const boxChanged =
    lastViewportBox === null ||
    node.offsetWidth !== lastViewportBox.width ||
    node.offsetHeight !== lastViewportBox.height;
  // A vertical scrollbar changes the client width and reflows the rows, so it still needs the
  // anchor restore. A horizontal scrollbar changes only the client height; the content above the
  // reader does not move, and restoring is what lets a classic-scrollbar toggle throw them up.
  const widthChanged = lastClientWidth !== null && node.clientWidth !== lastClientWidth;
  syncViewport(node);
  if (restorePending !== null) return;
  if (!boxChanged && !widthChanged) {
    if (pinned.value) scrollToBottom();
    return;
  }
  if (!pinned.value) {
    if (windowEnabled.value && lastAnchor !== null) {
      void restoreAnchor(lastAnchor);
    } else {
      measureRunTop();
    }
    return;
  }
  measureRunTop();
  scrollToBottom();
}

function onScroll(): void {
  const node = element();
  if (node === null) return;
  const heightChanged = lastClientHeight !== null && node.clientHeight !== lastClientHeight;
  scrollTopValue.value = node.scrollTop;
  viewportHeightValue.value = node.clientHeight;
  if (heightChanged) {
    // The scroll box was resized (a taller composer, a window change). The scroll event this
    // produces moves scrollTop only because the scroll range changed, so it is not user intent:
    // keep the pinned state and, while following, re-anchor the bottom to the new height.
    lastClientHeight = node.clientHeight;
    if (pinned.value) {
      scrollToBottom();
    } else {
      persist();
    }
    return;
  }
  lastClientHeight = node.clientHeight;
  pinned.value = nearBottom();
  if (pinned.value) {
    unseen.value = 0;
  }
  lastAnchor = captureAnchor();
  if (windowEnabled.value) measureRunTop();
  guardFocus();
  if (!suppressLoadEarlier) {
    if (node.scrollTop <= 32) {
      if (props.loadEarlierEnabled && !props.loadingEarlier && !topRequested.value) {
        topRequested.value = true;
        emit("load-earlier");
      }
    } else if (node.scrollTop > 64) {
      topRequested.value = false;
    }
  } else if (node.scrollTop > 64) {
    topRequested.value = false;
  }
  persist();
}

function onNewMessages(): void {
  scrollToBottom();
}

function parseTranscriptGap(node: HTMLElement): void {
  if (typeof getComputedStyle !== "function") return;
  const inner = node.querySelector<HTMLElement>("#chat-messages") ?? node;
  const style = getComputedStyle(inner);
  const raw = style.rowGap.length > 0 ? style.rowGap : style.gap;
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    transcriptGap.value = parsed;
  }
}

function resetWindowState(): void {
  windowEnabled.value = false;
  measurementReady.value = false;
  initialRestorePending.value = true;
  revealIndex.value = null;
  focusedIndex.value = null;
  suppressLoadEarlier = false;
  cancelMeasurementFrame();
  pendingMeasurements.clear();
  pendingStructuralKeys.clear();
  heightsByKey.clear();
  runTopValue.value = 0;
  lastAnchor = null;
  rebuildRenderedHeights();
}

function onStructuralChange(): void {
  const liveKeys = new Set<string>();
  const liveDetails = new Set<string>();
  for (const item of props.items) {
    liveKeys.add(threadItemKey(item));
    if (item.type === "message") {
      for (const part of item.message.parts) liveDetails.add(part.id);
    } else if (item.type === "work-group") {
      liveDetails.add(item.group.id);
      for (const part of item.group.parts) liveDetails.add(part.id);
    } else if (item.type === "notice-group") {
      liveDetails.add(item.group.id);
    }
  }
  for (const key of Array.from(rowSetters.keys())) {
    if (!liveKeys.has(key)) rowSetters.delete(key);
  }
  for (const [key, row] of Array.from(rowElements.entries())) {
    if (!liveKeys.has(key)) {
      rowObserver?.unobserve(row);
      rowKeys.delete(row);
      rowElements.delete(key);
    }
  }
  for (const key of Array.from(heightsByKey.keys())) {
    if (!liveKeys.has(key)) heightsByKey.delete(key);
  }
  transcriptMemory.value.pruneHeights(liveKeys);
  transcriptMemory.value.pruneDetails(liveDetails);
  rebuildRenderedHeights();
}

function sameItemKeys(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function measuredContentHeight(): number {
  let total = 0;
  for (const item of props.items) {
    const height = heightsByKey.get(threadItemKey(item));
    if (height !== undefined && height > 0) total += height;
  }
  return total + transcriptGap.value * Math.max(0, props.items.length - 1);
}

function maybeActivate(options: { requireMeasurement?: boolean } = {}): void {
  if (windowEnabled.value || activating) return;
  // Without the row observer there is no measurement support, so keep the full render (D10).
  if (rowObserver === null) return;
  if (initialRestorePending.value) return;
  if (props.items.length === 0) return;
  const viewport = viewportHeightValue.value;
  if (viewport <= 0) return;
  const countLatch =
    props.items.length > ACTIVATION_COUNT &&
    (options.requireMeasurement !== true || measurementReady.value);
  const heightLatch =
    measurementReady.value &&
    heightsByKey.size > 0 &&
    measuredContentHeight() > ACTIVATION_VIEWPORTS * viewport;
  if (!countLatch && !heightLatch) return;
  activating = true;
  void latchWindow().finally(() => {
    activating = false;
  });
}

async function latchWindow(): Promise<void> {
  if (windowEnabled.value) return;
  const anchor = captureAnchor();
  lastAnchor = anchor;
  const index = anchor?.key === undefined ? -1 : itemIndexByKey(anchor.key);
  if (index >= 0) revealIndex.value = index;
  measureRunTop();
  windowEnabled.value = true;
  guardFocus();
  await nextTick();
  if (anchor !== null) await restoreAnchor(anchor);
  revealIndex.value = null;
  measureRunTop();
}

function finishInitialRestore(): void {
  if (!initialRestorePending.value) return;
  initialRestorePending.value = false;
  measureRunTop();
  maybeActivate();
}

onMounted(() => {
  const node = element();
  if (node === null) return;
  parseTranscriptGap(node);
  syncViewport(node);
  if (typeof ResizeObserver !== "function") return;
  viewportObserver = new ResizeObserver(onViewportResize);
  viewportObserver.observe(node);
  rowObserver = new ResizeObserver(onRowsResized);
  for (const row of rowElements.values()) {
    rowObserver.observe(row);
  }
});

onMounted(async () => {
  await nextTick();
  const memory = readScrollMemory(memoryKey());
  if (memory !== null) {
    restorePending = memory;
    if (props.items.length > 0) {
      await applyRestore();
      finishInitialRestore();
    }
    return;
  }
  if (props.items.length > 0) {
    scrollToBottom();
    finishInitialRestore();
  }
});

// The session scope changes before the new DOM commits: swap the memory and reset local geometry so
// the first render of the new session never uses the previous scope's heights or window state.
watch(
  transcriptMemoryKey,
  (next) => {
    transcriptMemory.value = createTranscriptMemory(next);
    sessionSwitching = true;
    resetWindowState();
    seedHeightsFromMemory();
  },
  { flush: "pre" },
);

watch(
  transcriptMemoryKey,
  async (next, previous) => {
    if (next === previous) return;
    pinned.value = false;
    unseen.value = 0;
    topRequested.value = false;
    scrollTopValue.value = 0;
    runTopValue.value = 0;
    lastCount = props.items.length;
    restorePending = readScrollMemory(next);
    await nextTick();
    onStructuralChange();
    lastItemKeys = props.items.map(threadItemKey);
    seedHeightsFromMemory();
    if (props.items.length === 0) {
      if (restorePending === null) pinned.value = true;
      sessionSwitching = false;
      return;
    }
    if (restorePending !== null) {
      await applyRestore();
    } else {
      pinned.value = true;
      scrollToBottom();
    }
    sessionSwitching = false;
    finishInitialRestore();
  },
  { flush: "post" },
);

// Content changes: follow the bottom only while pinned; a prepend keeps the captured anchor.
watch(
  () => [props.items.length, props.revision] as const,
  async ([count]) => {
    const previousCount = lastCount;
    lastCount = count;
    await nextTick();
    const nextKeys = props.items.map(threadItemKey);
    const structural = count !== previousCount || !sameItemKeys(nextKeys, lastItemKeys);
    const previousKeys = new Set(lastItemKeys);
    lastItemKeys = nextKeys;
    if (sessionSwitching) return;
    if (structural) {
      const liveKeys = new Set(nextKeys);
      pendingStructuralKeys = new Set(
        Array.from(pendingStructuralKeys).filter((key) => liveKeys.has(key)),
      );
      for (const key of nextKeys) {
        if (previousKeys.has(key)) continue;
        pendingStructuralKeys.add(key);
      }
      onStructuralChange();
      if (
        windowEnabled.value &&
        !pinned.value &&
        !props.loadingEarlier &&
        restorePending === null &&
        lastAnchor !== null &&
        lastAnchor.key !== undefined &&
        lastAnchor.visualOffset !== undefined
      ) {
        await restoreLayoutAnchor(lastAnchor);
      }
    }
    if (restorePending !== null) {
      await applyRestore();
      finishInitialRestore();
      return;
    }
    if (initialRestorePending.value) {
      if (count > 0 && !props.loadingEarlier) {
        pinned.value = true;
        scrollToBottom();
        finishInitialRestore();
      }
      return;
    }
    if (props.loadingEarlier) {
      return;
    }
    if (count > previousCount && previousCount > 0) {
      if (pinned.value) {
        scheduleBottomScroll();
      } else {
        unseen.value += count - previousCount;
        persist();
      }
      return;
    }
    if (pinned.value) {
      scheduleBottomScroll();
    }
  },
  { flush: "post" },
);

// A session that starts below the count threshold can grow past it. Require a measurement pass so
// layout-less environments keep the deterministic full render.
watch(
  () => props.items.length,
  async (next, previous) => {
    if (next === previous) return;
    await nextTick();
    maybeActivate({ requireMeasurement: true });
  },
);

watch(
  () => props.loadingEarlier,
  async (loading) => {
    if (loading) return;
    const anchor = lastAnchor;
    if (anchor !== null) {
      suppressLoadEarlier = true;
      await nextTick();
      await restoreAnchor(anchor);
      measureRunTop();
      suppressLoadEarlier = false;
    }
    const node = element();
    if (node !== null && node.scrollTop > 32) {
      topRequested.value = false;
    }
  },
);

watch(measurementReady, () => maybeActivate());
watch(initialRestorePending, () => maybeActivate());

watch(
  () => props.approvalCount ?? 0,
  (next, previous) => {
    if (next > (previous ?? 0) && pinned.value) {
      scheduleBottomScroll();
    }
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  viewportObserver?.disconnect();
  viewportObserver = null;
  rowObserver?.disconnect();
  rowObserver = null;
  cancelScheduledBottom();
  cancelMeasurementFrame();
  persist();
});

defineExpose({
  captureAnchor,
  restoreAnchor,
  scrollToBottom,
  onScroll,
  unseen,
  scrollTopValue,
  viewportHeightValue,
  runTopValue,
});
</script>

<template>
  <section
    class="chat-thread chat-thread--spa"
    aria-label="Conversation"
    data-chat-thread
    :data-chat-loaded-count="loadedCount"
    :data-chat-item-count="items.length"
  >
    <div class="chat-thread__meta">
      <div class="chat-thread__identity">
        <span class="chat-session-title" data-chat-session-title :title="sessionTitleText">
          {{ sessionTitleText }}
        </span>
        <span v-if="sessionId !== null" class="mono" data-chat-session-id :title="sessionId">{{
          sessionShortId
        }}</span>
        <span
          class="chat-live"
          :data-state="liveState"
          data-chat-live
          role="status"
          aria-live="polite"
        >
          {{ liveLabel }}
        </span>
        <span
          v-if="messageCount !== undefined && messageCount.length > 0"
          class="caption"
          data-chat-message-count
        >
          {{ messageCount }}
        </span>
      </div>
      <div class="chat-thread__chips">
        <span
          class="chat-turn-status"
          data-chat-turn-status
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <template v-if="turnStatus !== null">
            <span class="chat-turn-status__label" data-chat-turn-label>{{ turnStatus.label }}</span>
            <button
              v-if="turnStatus.count > 0"
              class="btn btn-ghost btn-sm chat-turn-status__queue"
              type="button"
              :aria-label="queueButtonLabel"
              aria-haspopup="dialog"
              aria-controls="chat-queue-dialog"
              data-chat-queue-open
              @click="emit('open-queue')"
            >
              {{ queueButtonText }}
            </button>
          </template>
        </span>
        <span
          class="chat-waiting"
          :class="{ 'chat-meta-placeholder': waiting !== true }"
          :aria-hidden="waiting !== true"
          data-chat-waiting
          role="status"
          aria-live="polite"
        >
          <AppIcon name="stamp" />Waiting for you
        </span>
        <button
          class="btn btn-ghost btn-sm chat-plan-chip"
          :class="{ 'chat-meta-placeholder': !hasPlan }"
          :aria-hidden="!hasPlan"
          type="button"
          data-chat-plan-chip
          aria-controls="chat-plan-section"
          title="Open the plan panel"
          @click="emit('open-context', 'plan')"
        >
          <AppIcon name="activity" /><span>{{ planLabel }}</span>
        </button>
        <button
          class="btn btn-ghost btn-sm chat-context-chip"
          :class="{
            'chat-meta-placeholder': contextSnapshot === null || contextSnapshot === undefined,
          }"
          :aria-hidden="contextSnapshot === null || contextSnapshot === undefined"
          type="button"
          data-chat-context-chip
          aria-controls="chat-context-usage"
          :data-state="contextState"
          :title="contextTitle"
          @click="emit('open-context', 'context')"
        >
          <AppIcon name="gauge" /><span>{{ contextLabel }}</span>
          <span class="sr-only">{{ contextDetailText }}</span>
          <!-- biome-ignore lint/a11y/useSemanticElements: keep the legacy meter markup and classes -->
          <span
            class="chat-context-chip__meter"
            role="meter"
            aria-label="Context usage"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="contextPercent"
            :aria-valuetext="contextLabel"
          >
            <span
              class="chat-context-chip__fill"
              :style="{ width: `${contextPercent}%` }"
              aria-hidden="true"
            />
          </span>
        </button>
      </div>
    </div>
    <slot name="policy-warning" />
    <slot name="image-gate" />
    <slot name="image-warning" />
    <div
      class="chat-thread__viewport"
      :data-loading="loading ? 'true' : undefined"
      :aria-busy="loading ? 'true' : undefined"
    >
      <div
        class="chat-thread__scroll"
        id="chat-scroll"
        ref="scroll"
        tabindex="-1"
        @scroll.passive="onScroll"
        @focusin="onFocusIn"
        @focusout="onFocusOut"
      >
        <div
          class="chat-thread__inner"
          :class="{ 'is-muted': loading }"
          id="chat-messages"
          role="log"
          aria-live="off"
          :data-chat-window-start="windowRange.start"
          :data-chat-window-end="windowRange.end"
        >
          <div v-if="loadEarlierEnabled || loadingEarlier" class="chat-history-row">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              data-chat-load-earlier
              :disabled="loadingEarlier"
              @click="emit('load-earlier')"
            >
              <span v-if="loadingEarlier" class="spinner" aria-hidden="true" />
              {{ loadingEarlier ? "Loading earlier messages…" : "Load earlier messages" }}
            </button>
          </div>
          <p v-else-if="items.length > 0" class="hint chat-history-start" data-chat-history-start>
            Start of conversation
          </p>

          <p v-if="error !== null" class="form-error" role="alert">{{ error }}</p>
          <div
            v-else-if="processStarting"
            class="chat-stopped"
            data-chat-starting
            role="status"
            aria-live="polite"
          >
            <span class="status" :data-state="processPillSpec.dataState">
              <AppIcon :name="processPillSpec.icon" />{{ processPillSpec.label }}
            </span>
            <h3 class="chat-stopped__title">Starting agent…</h3>
            <p class="chat-stopped__body">
              The agent is starting. This panel updates automatically and the conversation is
              preserved.
            </p>
            <p v-if="processElapsedText.length > 0" class="caption mono" data-chat-process-elapsed>
              {{ processElapsedText }} elapsed
            </p>
          </div>
          <div
            v-else-if="processStopping"
            class="chat-stopped"
            data-chat-stopping
            role="status"
            aria-live="polite"
          >
            <span class="status" :data-state="processPillSpec.dataState">
              <AppIcon :name="processPillSpec.icon" />{{ processPillSpec.label }}
            </span>
            <h3 class="chat-stopped__title">Stopping agent…</h3>
            <p class="chat-stopped__body">
              The agent is shutting down. The conversation stays preserved and will reopen when the
              process is available again.
            </p>
            <p v-if="processElapsedText.length > 0" class="caption mono" data-chat-process-elapsed>
              {{ processElapsedText }} elapsed
            </p>
          </div>
          <div
            v-else-if="processFailed"
            class="error-state chat-error"
            data-chat-process-error
            role="alert"
          >
            <span class="error-state__mark"><AppIcon name="alert-triangle" /></span>
            <div>
              <h3 class="error-state__title">{{ processErrorTitle }}</h3>
              <p class="error-state__body" data-chat-process-error-message>
                {{ processErrorText }}
              </p>
              <p v-if="processErrorAt !== null" class="mono">
                <time
                  :datetime="processErrorAt"
                  :title="absoluteTime(processErrorAt)"
                  data-chat-process-error-time
                >
                  {{ timeAgo(processErrorAt) }}
                </time>
              </p>
              <div class="chat-stopped__actions">
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  data-chat-retry-agent
                  :disabled="processRetryDisabled"
                  @click="emit('start')"
                >
                  <AppIcon name="refresh" />Retry
                </button>
                <a
                  v-if="processHistoryHref !== undefined"
                  class="btn btn-ghost btn-sm"
                  :href="processHistoryHref"
                  data-chat-process-history
                >
                  Process history
                </a>
              </div>
            </div>
          </div>
          <div v-else-if="stoppedPanel" class="empty-state" data-chat-stopped>
            <h3 class="empty-state__title">Agent is not running</h3>
            <p class="empty-state__body">
              The conversation is preserved. Start the agent to read live updates; nothing starts
              automatically.
            </p>
            <div class="chat-stopped__actions">
              <button
                class="btn btn-primary btn-sm"
                type="button"
                data-chat-start-agent
                :disabled="processRetryDisabled"
                @click="emit('start')"
              >
                <AppIcon name="refresh" />{{ startingAgent === true ? "Starting…" : "Start agent" }}
              </button>
            </div>
          </div>
          <p v-else-if="empty" class="chat-empty" data-chat-empty>
            Send the first message to start the agent. Its reply appears here, with tool calls in
            place.
          </p>

          <div
            v-if="topPad > 0"
            class="chat-thread__spacer"
            aria-hidden="true"
            :style="{ height: `${topPad}px`, marginBlockEnd: `-${transcriptGap}px` }"
          />
          <template v-for="item in renderedItems" :key="threadItemKey(item)">
            <ChatMessage
              v-if="item.type === 'message'"
              :ref="rowSetter(threadItemKey(item))"
              :record="item.message"
              :app-key="appKey"
              :question-view-for-part="questionViewForPart"
              :data-message-id="item.message.id"
              :data-thread-key="threadItemKey(item)"
              @question-submit="(view, answers) => emit('question-submit', view, answers)"
              @question-reject="(view) => emit('question-reject', view)"
              @open-image="(attachment) => emit('open-image', attachment)"
            />
            <ChatNoticeRow
              v-else-if="item.type === 'notice'"
              :ref="rowSetter(threadItemKey(item))"
              :notice="item.notice"
              :data-thread-key="threadItemKey(item)"
            />
            <ChatWorkGroup
              v-else-if="item.type === 'work-group'"
              :ref="rowSetter(threadItemKey(item))"
              :group="item.group"
              :data-thread-key="threadItemKey(item)"
            />
            <ChatNoticeGroupRow
              v-else-if="item.type === 'notice-group'"
              :ref="rowSetter(threadItemKey(item))"
              :group="item.group"
              :data-thread-key="threadItemKey(item)"
            />
          </template>
          <div
            v-if="bottomPad > 0"
            class="chat-thread__spacer"
            aria-hidden="true"
            :style="{ height: `${bottomPad}px` }"
          />
        </div>
        <div class="chat-thread__approvals">
          <slot name="approvals" />
        </div>
        <ChatGeneratingRow
          v-if="
            !stopped &&
            generatingLabel !== undefined &&
            generatingLabel !== null &&
            generatingLabel.length > 0
          "
          :label="generatingLabel"
        />
      </div>
      <button
        v-if="unseen > 0"
        class="btn btn-secondary btn-sm chat-new-messages"
        type="button"
        data-chat-new-messages
        @click="onNewMessages"
      >
        New messages ({{ unseen }})
      </button>
      <div v-if="loading" class="chat-loading" role="status" aria-live="polite" data-chat-loading>
        <span class="chat-loading__plate">
          <span class="spinner" aria-hidden="true" />
          <span>{{ items.length > 0 ? "Refreshing conversation…" : "Loading conversation…" }}</span>
        </span>
        <span
          v-if="items.length === 0"
          class="skeleton-stack chat-loading__skeleton"
          aria-hidden="true"
        >
          <span class="skeleton skeleton--line"></span>
          <span class="skeleton skeleton--line"></span>
          <span class="skeleton skeleton--line"></span>
        </span>
      </div>
    </div>
    <slot name="session-notice" />
    <slot name="prompt-dock" />
    <slot name="command-palette" />
    <slot name="composer" />
  </section>
</template>
