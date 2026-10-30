/**
 * Typed SPA wrapper over the copy-first `assets/chat-feed-store.js`.
 *
 * The JavaScript module is the runtime oracle copy; this file only adds TypeScript types and
 * convenience re-exports. It must never import `assets/chat.js` or any server module.
 */

import type {
  FeedMessageRecord,
  FeedPartRecord,
  ThreadStore,
} from "../../assets/chat-feed-store.js";
import { createThreadStore } from "../../assets/chat-feed-store.js";
import type { PartType } from "../../src/opencode/events.js";

export type { FeedMessageRecord, FeedPartRecord, PartType, ThreadStore };
export { createThreadStore };

/** True when the record carries a provisional optimistic presentation state. */
export function isOptimisticMessage(record: FeedMessageRecord | undefined): boolean {
  return typeof record?.optimistic === "string" && record.optimistic.length > 0;
}

/** True when a part type is one the legacy client renders explicitly. */
export const KNOWN_PART_TYPES: ReadonlySet<string> = new Set<PartType>([
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

export function isKnownPartType(value: string): value is PartType {
  return KNOWN_PART_TYPES.has(value);
}
