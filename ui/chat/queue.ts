/**
 * Queue projection for the Stage 4 strip and dialog.
 *
 * Rows come from the authoritative server `queuedPromptIDs`; the client never derives the queue.
 */

import { isHiddenSyntheticTextPart } from "../../assets/chat-core.js";
import type { FeedMessageRecord, ThreadStore } from "../../assets/chat-feed-store.js";

export interface QueueRow {
  readonly id: string;
  readonly preview: string;
  readonly state: string;
}

function previewOf(record: FeedMessageRecord | undefined): string {
  if (record === undefined) {
    return "Queued message";
  }
  for (const partID of record.partOrder) {
    const part = record.parts.get(partID);
    if (part === undefined || part.type !== "text") {
      continue;
    }
    if (isHiddenSyntheticTextPart(part)) {
      continue;
    }
    const text = typeof part.data.text === "string" ? part.data.text : "";
    const firstLine = text.split("\n")[0]?.trim() ?? "";
    if (firstLine.length > 0) {
      return firstLine.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return "Queued message";
}

function stateOf(record: FeedMessageRecord | undefined, running: boolean): string {
  if (running) {
    return "Running";
  }
  if (record?.optimistic === "sending") {
    return "Sending…";
  }
  if (record?.optimistic === "unknown") {
    return "Delivery unknown";
  }
  return "Queued";
}

export function queueRowsFromIDs(
  thread: ThreadStore,
  queuedPromptIDs: readonly string[],
  runningPromptID: string | null = null,
): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const id of queuedPromptIDs) {
    const record = thread.messages.get(id);
    rows.push({
      id,
      preview: previewOf(record),
      state: stateOf(record, id === runningPromptID),
    });
  }
  return rows;
}
