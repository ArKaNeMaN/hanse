/**
 * Shared view-scope key for the in-memory chat caches.
 *
 * Scroll memory and transcript detail/height memory are keyed by the same workspace + session
 * tuple. This module stays dependency-free so both caches can import it without forming a cycle.
 */

export function scrollMemoryKey(workspaceKey: string, sessionID: string | null): string | null {
  if (sessionID === null || sessionID.length === 0) {
    return null;
  }
  return `${workspaceKey}::${sessionID}`;
}
