/**
 * Queue projection for the Stage 4 strip and dialog.
 *
 * `deriveQueue` remains the single queue derivation; this module only maps the derived ids to the
 * short row labels the composer surface renders.
 */

import { deriveQueue } from "../../assets/chat-core.js";
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
    const text = typeof part.data.text === "string" ? part.data.text : "";
    const firstLine = text.split("\n")[0]?.trim() ?? "";
    if (firstLine.length > 0) {
      return firstLine.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return "Queued message";
}

function stateOf(record: FeedMessageRecord | undefined): string {
  if (record?.optimistic === "sending") {
    return "Sending…";
  }
  if (record?.optimistic === "unknown") {
    return "Delivery unknown";
  }
  return "Queued";
}

export function deriveQueueRows(thread: ThreadStore, allowPromotion: boolean): QueueRow[] {
  const derived = deriveQueue(thread, {
    sessionStatusType: thread.agentStatus?.type,
    allowPromotion,
  });
  const rows: QueueRow[] = [];
  for (const id of derived.queuedIDs) {
    const record = thread.messages.get(id);
    if (record === undefined) {
      continue;
    }
    rows.push({ id, preview: previewOf(record), state: stateOf(record) });
  }
  return rows;
}
