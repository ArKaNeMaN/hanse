/**
 * Keyed chat feed state: messages, parts, order, stream identity/sequence, notices, and dirty flags.
 *
 * Large maps stay `shallowRef` + `markRaw`; all mutation flows through these actions. The store has
 * no URL/router/storage writer and no network call.
 */

import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import {
  applyOmittedPart,
  applySnapshot as applySnapshotCore,
  classifyOmo,
  deriveQueue,
  type FeedOrderItem,
  mergeFeedOrder,
  normalizeAttachments,
  normalizeHandoffMeta,
  type OmoSystemMeta,
  provisionalPartType,
  rekeyOptimistic as rekeyOptimisticCore,
  type SnapshotOptions,
  type SnapshotResult,
} from "../../assets/chat-core.js";
import type {
  FeedMessageRecord,
  FeedPartRecord,
  ThreadStore,
} from "../../assets/chat-feed-store.js";
import type { HanseSessionStatus } from "../../src/opencode/events.js";
import type {
  MessageUpsertAction,
  PartDeltaAction,
  PartOmitAction,
  PartUpsertAction,
  SessionErrorAction,
} from "../chat/event-reducer.js";
import { createThreadStore, isOptimisticMessage } from "../chat/feed-store.js";

export interface NoticeView {
  id: string;
  sessionId?: string;
  parentSessionId?: string;
  kind?: string;
  reason?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
  [key: string]: unknown;
}

export interface RecomputeResult {
  activeID: string | null;
  queuedIDs: string[];
  turnContinues: boolean;
  nextActivePromptID: string | null;
}

function noticeSessionMatches(notice: NoticeView, sessionID: string | null): boolean {
  return typeof notice.sessionId !== "string" || notice.sessionId === sessionID;
}

function noticeSignature(notice: NoticeView): string {
  return JSON.stringify([
    notice.id,
    notice.sessionId ?? null,
    notice.kind ?? null,
    notice.reason ?? null,
    notice.createdAt ?? null,
    notice.payload ?? null,
  ]);
}

function noticeTime(notice: NoticeView | undefined): number {
  const raw = notice?.createdAt;
  if (typeof raw !== "string" || raw.length === 0) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function hasPlaceholderPart(record: FeedMessageRecord): string | null {
  for (const partID of record.partOrder) {
    const part = record.parts.get(partID);
    if (part === undefined || part.type !== "text") {
      continue;
    }
    if (
      part.provisional === true ||
      part.data.provisional === true ||
      part.data.placeholder === true
    ) {
      return partID;
    }
  }
  return null;
}

export const useChatFeedStore = defineStore("chat-feed", () => {
  const thread = shallowRef<ThreadStore>(markRaw(createThreadStore(null)));
  const notices = shallowRef<readonly NoticeView[]>(markRaw([]));
  const dirtyMessages = shallowRef<ReadonlySet<string>>(markRaw(new Set<string>()));
  const dirtyParts = shallowRef<ReadonlySet<string>>(markRaw(new Set<string>()));
  const streamWarning = ref<string | null>(null);
  const streamPaused = ref(false);
  const revision = ref(0);

  function touch(): void {
    revision.value += 1;
  }

  function markMessageDirty(id: string): void {
    const next = new Set(dirtyMessages.value);
    next.add(id);
    dirtyMessages.value = markRaw(next);
  }

  function markPartDirty(id: string): void {
    const next = new Set(dirtyParts.value);
    next.add(id);
    dirtyParts.value = markRaw(next);
  }

  function clearDirty(): void {
    dirtyMessages.value = markRaw(new Set<string>());
    dirtyParts.value = markRaw(new Set<string>());
  }

  function reset(sessionID: string | null): void {
    thread.value = markRaw(createThreadStore(sessionID));
    notices.value = markRaw([]);
    clearDirty();
    streamWarning.value = null;
    streamPaused.value = false;
    touch();
  }

  function replaceThread(next: ThreadStore): void {
    thread.value = markRaw(next);
    touch();
  }

  function message(id: string): FeedMessageRecord | undefined {
    return thread.value.messages.get(id);
  }

  function part(messageID: string, partID: string): FeedPartRecord | undefined {
    return thread.value.messages.get(messageID)?.parts.get(partID);
  }

  function ensureLiveMessage(
    id: string,
    role: "user" | "assistant",
  ): { record: FeedMessageRecord; created: boolean } {
    let record = thread.value.messages.get(id);
    let created = false;
    if (record === undefined) {
      record = {
        id,
        role,
        partOrder: [],
        parts: new Map<string, FeedPartRecord>(),
        version: 1,
      };
      thread.value.messages.set(id, record);
      thread.value.order.push(id);
      created = true;
      touch();
    } else if (record.role !== role) {
      record.role = role;
      record.version += 1;
    }
    markMessageDirty(id);
    return { record, created };
  }

  function ensurePartMessage(id: string): FeedMessageRecord {
    const existing = thread.value.messages.get(id);
    if (existing !== undefined) {
      markMessageDirty(id);
      return existing;
    }
    return ensureLiveMessage(id, "assistant").record;
  }

  function markOptimisticOperator(record: FeedMessageRecord): void {
    delete record.classificationPending;
    delete record.system;
  }

  function recomputeQueue(): RecomputeResult {
    const current = thread.value;
    const derived = deriveQueue(current, {
      sessionStatusType: current.agentStatus?.type,
    });
    current.queue = [...derived.queuedIDs];
    current.activePromptID = derived.nextActivePromptID;
    for (const id of current.order) {
      const record = current.messages.get(id);
      if (record === undefined || record.optimistic === undefined) {
        continue;
      }
      if (record.optimistic === "sending" || record.optimistic === "unknown") {
        continue;
      }
      if (record.optimistic === "failed") {
        continue;
      }
      if (id === derived.activeID) {
        record.optimistic = "accepted";
      } else if (derived.queuedIDs.includes(id)) {
        record.optimistic = "queued";
      } else {
        record.optimistic = "accepted";
      }
    }
    touch();
    return derived;
  }

  function upsertMessage(action: MessageUpsertAction): FeedMessageRecord {
    const existing = thread.value.messages.get(action.messageID);
    const wasUser = existing?.role === "user";
    const { record } = ensureLiveMessage(action.messageID, action.role);
    record.role = action.role;

    if (action.handoff !== undefined && action.handoff !== null) {
      const normalized = normalizeHandoffMeta(action.handoff);
      const handoff = (normalized ?? { ...action.handoff }) as Record<string, unknown>;
      const previous = record.handoff;
      if (
        previous !== undefined &&
        previous !== null &&
        previous.id === handoff.id &&
        handoff.body === undefined &&
        previous.body !== undefined
      ) {
        handoff.body = previous.body;
      }
      if (
        previous !== undefined &&
        previous !== null &&
        previous.id === handoff.id &&
        handoff.operatorNote === undefined &&
        previous.operatorNote !== undefined
      ) {
        handoff.operatorNote = previous.operatorNote;
      }
      record.handoff = handoff;
      delete record.system;
    }

    if (action.role === "user") {
      if (isOptimisticMessage(record)) {
        markOptimisticOperator(record);
      } else if (
        (record.handoff === undefined || record.handoff === null) &&
        (existing === undefined || !wasUser)
      ) {
        record.classificationPending = true;
      }
    }

    if (typeof action.parentID === "string") {
      record.parentID = action.parentID;
    }
    if (typeof action.finish === "string") {
      record.finish = action.finish;
    }
    if (action.time !== undefined && action.time !== null) {
      record.time = action.time;
    }
    if (Array.isArray(action.attachments) && action.attachments.length > 0) {
      record.attachments = markRaw(
        normalizeAttachments(action.attachments),
      ) as FeedMessageRecord["attachments"];
    }
    if (action.usage !== undefined) {
      record.usage = action.usage;
    }
    if (action.model !== undefined) {
      record.model = action.model;
    }
    if (action.summary !== undefined) {
      record.summary = action.summary;
    }

    record.version += 1;
    recomputeQueue();
    markMessageDirty(record.id);
    return record;
  }

  function upsertPart(action: PartUpsertAction): {
    record: FeedMessageRecord;
    part: FeedPartRecord;
    created: boolean;
  } {
    const record = ensurePartMessage(action.messageID);
    if (record.role === "user" && action.partType === "text") {
      const placeholder = hasPlaceholderPart(record);
      if (placeholder !== null && placeholder !== action.partID) {
        const replacement = record.parts.get(placeholder);
        if (replacement !== undefined) {
          record.parts.delete(placeholder);
          record.parts.set(action.partID, replacement);
          record.partOrder = record.partOrder.map((partID) =>
            partID === placeholder ? action.partID : partID,
          );
        }
      }
    }

    const data: Record<string, unknown> = { ...action.part };
    data.id = action.partID;
    data.type = action.partType;

    let part = record.parts.get(action.partID);
    let created = false;
    if (part === undefined) {
      part = {
        id: action.partID,
        type: action.partType,
        data,
        provisional: false,
        partial: action.truncated !== undefined,
        sealed: false,
        version: 1,
      };
      record.parts.set(action.partID, part);
      record.partOrder.push(action.partID);
      created = true;
      touch();
    } else {
      part.id = action.partID;
      part.type = action.partType;
      part.data = data;
      part.version += 1;
      part.provisional = false;
    }
    if (action.truncated !== undefined) {
      part.partial = true;
      part.truncation = action.truncated;
    } else {
      delete part.truncation;
    }
    part.omitted = false;
    thread.value.pendingDeltas.delete(action.partID);
    if (!action.known) {
      record.needsReconcile = true;
    }
    if (record.role === "user" && record.handoff === undefined && !isOptimisticMessage(record)) {
      record.classificationPending = true;
    }
    markMessageDirty(record.id);
    markPartDirty(action.partID);
    recomputeQueue();
    return { record, part, created };
  }

  function appendDelta(action: PartDeltaAction): boolean {
    const record = ensurePartMessage(action.messageID);
    if (record.role === "user" && hasPlaceholderPart(record) !== null) {
      return false;
    }
    let part = record.parts.get(action.partID);
    if (part === undefined) {
      const type = provisionalPartType(action.partType);
      if (type === null) {
        return false;
      }
      part = {
        id: action.partID,
        type,
        data: { id: action.partID, type, text: "", provisional: true },
        provisional: true,
        partial: false,
        sealed: false,
        version: 1,
      };
      record.parts.set(action.partID, part);
      record.partOrder.push(action.partID);
      touch();
    }
    if (part.sealed === true) {
      return false;
    }
    if (record.role === "user" && part.provisional === true) {
      return false;
    }
    const queued = thread.value.pendingDeltas.get(action.partID) ?? "";
    thread.value.pendingDeltas.set(action.partID, queued + action.delta);
    markMessageDirty(record.id);
    markPartDirty(action.partID);
    touch();
    return true;
  }

  function markPartOmitted(action: PartOmitAction): { created: boolean } | null {
    const record = ensurePartMessage(action.messageID);
    const applied = applyOmittedPart(record, action);
    if (applied === null) {
      return null;
    }
    record.needsReconcile = true;
    markMessageDirty(record.id);
    markPartDirty(action.partID);
    touch();
    return { created: applied.created };
  }

  function applySnapshot(snapshotMessages: unknown, options: SnapshotOptions = {}): SnapshotResult {
    const result = applySnapshotCore(thread.value, snapshotMessages, options);
    thread.value = markRaw(result.store);
    for (const id of thread.value.order) {
      markMessageDirty(id);
    }
    touch();
    return result;
  }

  function rekeyOptimistic(options: {
    tempID?: string;
    serverID?: string;
    sessionStatusType?: string;
    allowPromotion?: boolean;
    bufferedEvents?: readonly unknown[];
  }): { consumed: boolean } {
    const result = rekeyOptimisticCore(thread.value, options);
    thread.value = markRaw(result.store);
    for (const id of thread.value.order) {
      markMessageDirty(id);
    }
    touch();
    return { consumed: result.consumed };
  }

  function setAgentStatus(status: HanseSessionStatus | null): void {
    const current = thread.value;
    const previous =
      current.agentStatus !== null && typeof current.agentStatus.type === "string"
        ? current.agentStatus.type
        : undefined;
    const next = status !== null && typeof status.type === "string" ? status.type : undefined;
    if (next !== previous && (next === "busy" || next === "idle")) {
      current.turnGeneration += 1;
    }
    current.agentStatus = status;
    if (next === "idle") {
      settleIdle();
    } else {
      recomputeQueue();
    }
    touch();
  }

  function settleIdle(): void {
    const current = thread.value;
    for (const id of current.order) {
      const record = current.messages.get(id);
      if (record === undefined) {
        continue;
      }
      for (const partID of record.partOrder) {
        const part = record.parts.get(partID);
        if (part === undefined) {
          continue;
        }
        part.sealed = true;
        markPartDirty(partID);
        markMessageDirty(id);
      }
    }
    recomputeQueue();
    touch();
  }

  function failPendingOptimistic(): string[] {
    const failed: string[] = [];
    for (const id of thread.value.order) {
      const record = thread.value.messages.get(id);
      if (record === undefined || record.role !== "user") {
        continue;
      }
      if (record.optimistic === "sending" || record.optimistic === "unknown") {
        record.optimistic = "failed";
        record.version += 1;
        markMessageDirty(id);
        failed.push(id);
      }
    }
    return failed;
  }

  function appendErrorRow(action: SessionErrorAction): string {
    const errorID = action.errorID;
    if (!thread.value.messages.has(errorID)) {
      const partID = `${errorID}:part:text`;
      const part: FeedPartRecord = {
        id: partID,
        type: "text",
        data: {
          id: partID,
          type: "text",
          text: `**Agent error:** ${action.message}`,
        },
        provisional: false,
        partial: false,
        sealed: true,
        version: 1,
      };
      const record: FeedMessageRecord = {
        id: errorID,
        role: "assistant",
        time: { created: Date.now() },
        partOrder: [partID],
        parts: new Map([[partID, part]]),
        version: 1,
      };
      thread.value.messages.set(errorID, record);
      thread.value.order.push(errorID);
      markMessageDirty(errorID);
      touch();
    }
    setAgentStatus({ type: "idle" });
    return errorID;
  }

  function upsertNotice(notice: NoticeView): boolean {
    if (!noticeSessionMatches(notice, thread.value.sessionID)) {
      return false;
    }
    const existing = notices.value.find((candidate) => candidate.id === notice.id);
    if (existing !== undefined && noticeSignature(existing) === noticeSignature(notice)) {
      return false;
    }
    const next = notices.value.filter((candidate) => candidate.id !== notice.id);
    next.push(notice);
    next.sort((left, right) => {
      const diff = noticeTime(left) - noticeTime(right);
      if (diff !== 0) {
        return diff;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    notices.value = markRaw(next);
    touch();
    return true;
  }

  function setStreamReady(streamID: string | null, reset: boolean): void {
    if (streamID !== null) {
      thread.value.currentStreamID = streamID;
      if (reset) {
        thread.value.lastSeqByStream = new Map([[streamID, 0]]);
      }
    }
    streamWarning.value = null;
    streamPaused.value = false;
    touch();
  }

  function applyStreamSeq(streamID: string, seq: number, reset: boolean): void {
    if (reset) {
      thread.value.currentStreamID = streamID;
      thread.value.lastSeqByStream = new Map([[streamID, 0]]);
    } else if (thread.value.currentStreamID !== streamID) {
      thread.value.currentStreamID = streamID;
    }
    thread.value.lastSeqByStream.set(streamID, seq);
    touch();
  }

  function setStreamWarning(message: string | null): void {
    streamWarning.value = message;
  }

  function setStreamPaused(paused: boolean): void {
    streamPaused.value = paused;
  }

  function classifyUserMessage(messageID: string): OmoSystemMeta | null {
    const record = thread.value.messages.get(messageID);
    if (record === undefined || record.role !== "user") {
      return null;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const partID of record.partOrder) {
      const part = record.parts.get(partID);
      if (part !== undefined) {
        parts.push({ ...part.data, id: part.id, type: part.type });
      }
    }
    const system = classifyOmo({ info: { id: record.id, role: "user" }, parts });
    if (system === null) {
      delete record.system;
    } else {
      record.system = system as unknown as Record<string, unknown>;
    }
    delete record.classificationPending;
    record.version += 1;
    markMessageDirty(record.id);
    recomputeQueue();
    return system;
  }

  const feedOrder = computed<readonly FeedOrderItem[]>(() => {
    revision.value;
    return mergeFeedOrder(
      thread.value.order,
      thread.value.messages,
      notices.value as unknown as readonly Record<string, unknown>[],
    );
  });

  return {
    thread,
    notices,
    dirtyMessages,
    dirtyParts,
    streamWarning,
    streamPaused,
    revision,
    feedOrder,
    reset,
    replaceThread,
    message,
    part,
    ensureLiveMessage,
    ensurePartMessage,
    upsertMessage,
    upsertPart,
    appendDelta,
    markPartOmitted,
    applySnapshot,
    rekeyOptimistic,
    recomputeQueue,
    setAgentStatus,
    settleIdle,
    failPendingOptimistic,
    appendErrorRow,
    upsertNotice,
    setStreamReady,
    applyStreamSeq,
    setStreamWarning,
    setStreamPaused,
    classifyUserMessage,
    markMessageDirty,
    markPartDirty,
    clearDirty,
  };
});
