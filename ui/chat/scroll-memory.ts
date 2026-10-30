/**
 * In-memory scroll restoration for the chat thread.
 *
 * It survives route unmount/remount within one SPA session (back/forward) but intentionally does
 * not use URL, sessionStorage, or localStorage: the scroll anchor is view state owned by the
 * component, not workspace identity.
 */

export interface ChatScrollMemory {
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

const positions = new Map<string, ChatScrollMemory>();

export function scrollMemoryKey(workspaceKey: string, sessionID: string | null): string | null {
  if (sessionID === null || sessionID.length === 0) {
    return null;
  }
  return `${workspaceKey}::${sessionID}`;
}

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
  positions.set(key, {
    scrollTop: Math.max(0, value.scrollTop),
    scrollHeight: Math.max(0, value.scrollHeight),
  });
}

export function clearScrollMemory(key?: string): void {
  if (key === undefined) {
    positions.clear();
    return;
  }
  positions.delete(key);
}
