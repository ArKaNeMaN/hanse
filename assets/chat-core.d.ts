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

export function normalizeAttachments(value: unknown): readonly Record<string, unknown>[];
export function normalizeHandoffMeta(value: unknown): Record<string, unknown> | null;
export function normalizeStreamWarning(value: unknown): {
  code: string;
  message: string;
  limit: boolean;
  sessionID?: string;
} | null;
export function provisionalPartType(value: unknown): PartType | null;
