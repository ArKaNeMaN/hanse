/**
 * Focused types for the shared pure `assets/chat-core.js` helpers consumed by the SPA chat data
 * layer. The implementation is shared with the frozen legacy client and is not changed here.
 */

import type { FeedMessageRecord, FeedPartRecord, ThreadStore } from "./chat-feed-store.js";
import type { PartType } from "../src/opencode/events.js";

export interface SnapshotOptions {
  capturedTurnGeneration?: number;
  turnGeneration?: number;
  sessionStatusType?: string;
  contentDiscarded?: boolean;
  discardedContent?: boolean;
  sessionID?: string;
  position?: "replace" | "tail" | "older";
  keepOptimistic?: "all" | "transient";
  allowPromotion?: boolean;
}

export interface SnapshotResult {
  store: ThreadStore;
  contentDiscarded: boolean;
  turnChanged: boolean;
}

export interface QueueDerivation {
  activeID: string | null;
  queuedIDs: string[];
  turnContinues: boolean;
  nextActivePromptID: string | null;
}

export interface RekeyOptions {
  tempID?: string;
  serverID?: string;
  sessionStatusType?: string;
  allowPromotion?: boolean;
  bufferedEvents?: readonly unknown[];
}

export interface RekeyResult {
  store: ThreadStore;
  consumed: boolean;
}

export interface FeedOrderItem {
  type: "message" | "notice";
  id: string;
  createdAt: number;
}

export interface SessionTree {
  nodes: Map<string, Record<string, unknown>>;
  childrenByParent: Map<string, string[]>;
  roots: string[];
}

export interface OmoSystemMeta {
  kind: string;
  tone: string;
  headers: string[];
  title: string;
  body: string;
}

export function applySnapshot(
  currentStore: ThreadStore,
  snapshotMessages: unknown,
  options?: SnapshotOptions,
): SnapshotResult;

export function deriveQueue(store: ThreadStore, status?: {
  sessionStatusType?: string;
  allowPromotion?: boolean;
}): QueueDerivation;

export function rekeyOptimistic(store: ThreadStore, options?: RekeyOptions): RekeyResult;

export function mergeFeedOrder(
  messageOrder: readonly string[],
  messages: Map<string, FeedMessageRecord>,
  notices: Map<string, Record<string, unknown>> | readonly Record<string, unknown>[],
): FeedOrderItem[];

export function buildSessionTree(sessions: readonly unknown[]): SessionTree;
export function firstRootId(tree: SessionTree | null | undefined): string | null;
export function ancestorIds(tree: SessionTree | null | undefined, id: unknown): string[];
export function collectSubtreeIds(tree: SessionTree | null | undefined, id: unknown): string[];
export function classifyOmo(message: unknown): OmoSystemMeta | null;

export function applyOmittedPart(
  record: FeedMessageRecord,
  value: unknown,
): { part: FeedPartRecord; created: boolean } | null;

export interface ComposerActionInput {
  turnActive?: boolean;
  hasDraft?: boolean;
  hasAttachments?: boolean;
  attachmentCount?: number;
  sessionId?: string | null;
  acceptanceBusy?: boolean;
  promptsWaiting?: boolean;
  abortPending?: boolean;
}

export function composerAction(input?: ComposerActionInput): {
  mode: "stop" | "send";
  disabled: boolean;
};

export function isSlashCommandOnly(text: unknown): boolean;
export function draftTextForSave(text: unknown): string;
export function draftIsEmpty(input?: { text?: unknown; attachmentCount?: unknown }): boolean;
export function canSendDraft(input?: { text?: unknown; attachmentCount?: unknown }): boolean;

export interface PendingSendView {
  id: string;
  messageID: string | null;
  text: string;
  attachments: readonly Record<string, unknown>[];
  attachmentIDs: string[];
  state: "sending" | "failed" | "unknown";
  updatedAt: unknown;
}

export interface PendingSendActions {
  readOnly: boolean;
  canRetry: boolean;
  canRestore: boolean;
  retryLabel: string;
  force: boolean;
}

export function normalizePendingSends(value: unknown): PendingSendView[];
export function pendingSendActions(state: unknown): PendingSendActions;
export function pendingSendLabel(entry: unknown): string;
export function draftAutoDeleteEligible(input?: {
  text?: unknown;
  attachmentCount?: unknown;
  hasPending?: unknown;
  acceptanceBusy?: unknown;
  draftLoaded?: unknown;
  hasHistory?: unknown;
}): boolean;

export function normalizeAttachments(value: unknown): readonly Record<string, unknown>[];
export function normalizeHandoffMeta(value: unknown): Record<string, unknown> | null;
export function normalizeStreamWarning(value: unknown): {
  code: string;
  message: string;
  limit: boolean;
  sessionID?: string;
} | null;
export function provisionalPartType(value: unknown): PartType | null;

export interface ImageGateView {
  blocked: boolean;
  state: string;
  action: "build_start" | "none" | string;
}

export interface ImageCardView {
  title: string;
  body: string;
  action: string;
  actionLabel: string;
}

export interface ImageWarningView {
  tone: "info" | "warning" | "error" | string;
  title: string;
  body: string;
  action: string;
}

export function imageGateFromView(view: unknown): ImageGateView;
export function imageCardFromView(view: unknown): ImageCardView | null;
export function imageWarningFromView(view: unknown): ImageWarningView | null;
export function imageActionLabel(action: unknown): string;
export function imagePollDelay(elapsedMs: unknown): number;

export function noticeLabel(notice: unknown): { label: string; reason: string };
export function messageCountLabel(count: number, historyComplete: boolean): string;

export function toolDisplayName(tool: string): string;
export function normalizeToolName(tool: string): string;
export function isHanseTool(tool: string): boolean;
export function parseToolJsonOutput(output: unknown): Record<string, unknown> | unknown[] | null;
export function toolFailure(value: unknown): { code: string; message: string } | null;
export function toolStatusChip(status: string): { state: string; icon: string; label: string };
export function toolSummaryText(
  tool: string,
  input: Record<string, unknown>,
  output: unknown,
): string | null;
export function formatByteCount(value: unknown): string;
export function shortIdentifier(value: unknown, length?: number): string;

export function handoffBodyFromText(text: string, direction: "request" | "reply"): string;
export function handoffNoteFromText(text: string): string;
export function agentInitials(name: string): string;
export function reasoningElapsedMs(start: unknown, end: unknown, now?: number): number | null;

export function resolveActiveStatusLabel(input?: {
  waiting?: boolean;
  sending?: boolean;
  paused?: boolean;
  statusType?: string;
  runningTool?: string | null;
  unsealedReasoning?: boolean;
  unsealedText?: boolean;
  queueLength?: number;
  activePromptID?: string | null;
  queueBlocked?: boolean;
}): string;
