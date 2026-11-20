/**
 * In-memory scroll restoration for the chat thread.
 *
 * It survives route unmount/remount within one SPA session (back/forward) but intentionally does
 * not use URL, sessionStorage, or localStorage: the scroll anchor is view state owned by the
 * component, not workspace identity.
 */

import { clearTranscriptMemory } from "./transcript-memory.js";

export { scrollMemoryKey } from "./view-scope.js";

export interface ChatScrollMemory {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly key?: string;
  readonly visualOffset?: number;
}

const positions = new Map<string, ChatScrollMemory>();

export function readScrollMemory(key: string | null): ChatScrollMemory | null {
  if (key === null) {
    return null;
  }
  const value = positions.get(key);
  return value === undefined ? null : { ...value };
}

export function writeScrollMemory(key: string | null, value: ChatScrollMemory): void {
  if (key === null) {
    return;
  }
  const next: {
    scrollTop: number;
    scrollHeight: number;
    key?: string;
    visualOffset?: number;
  } = {
    scrollTop: Math.max(0, value.scrollTop),
    scrollHeight: Math.max(0, value.scrollHeight),
  };
  if (typeof value.key === "string" && value.key.length > 0) {
    next.key = value.key;
  }
  if (typeof value.visualOffset === "number" && Number.isFinite(value.visualOffset)) {
    next.visualOffset = value.visualOffset;
  }
  positions.set(key, next);
}

export function clearScrollMemory(key?: string): void {
  if (key === undefined) {
    positions.clear();
    clearTranscriptMemory();
    return;
  }
  positions.delete(key);
  clearTranscriptMemory(key);
}
