/**
 * Types for the copy-first chat feed store. The implementation stays a plain browser ESM module so
 * its shape matches the frozen legacy `createThreadStore` exactly.
 */

import type { PartType } from "../src/opencode/events.js";

export interface FeedPartRecord {
  id: string;
  type: PartType | string;
  data: Record<string, unknown>;
  provisional?: boolean;
  partial?: boolean;
  sealed?: boolean;
  omitted?: boolean;
  truncation?: unknown;
  version: number;
}

export interface FeedMessageRecord {
  id: string;
  role: "user" | "assistant";
  parentID?: string;
  finish?: string;
  optimistic?: "sending" | "queued" | "accepted" | "unknown" | "failed";
  time?: { created?: number; completed?: number };
  usage?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  model?: { providerID: string; modelID: string };
  summary?: boolean;
  attachments?: readonly Record<string, unknown>[];
  handoff?: Record<string, unknown>;
  system?: Record<string, unknown>;
  classificationPending?: boolean;
  needsReconcile?: boolean;
  partOrder: string[];
  parts: Map<string, FeedPartRecord>;
  version: number;
}

export interface ThreadStore {
  sessionID: string | null;
  generation: number;
  turnGeneration: number;
  order: string[];
  messages: Map<string, FeedMessageRecord>;
  activePromptID: string | null;
  queue: string[];
  openParts: Set<string>;
  lastSeqByStream: Map<string, number>;
  currentStreamID: string | null;
  pendingDeltas: Map<string, string>;
  agentStatus: { type?: string } | null;
}

export function createThreadStore(id: string | null): ThreadStore;
