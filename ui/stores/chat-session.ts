/**
 * Chat session selection, list, tree, and generation.
 *
 * This store never writes the URL. `route.query` remains the sole source for the active selection;
 * this is a read-only mirror plus the derived tree/expanded state.
 */

import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import {
  ancestorIds,
  buildSessionTree,
  firstRootId,
  type SessionTree,
} from "../../assets/chat-core.js";
import type { HanseSessionStatus } from "../../src/opencode/events.js";

export interface ChatSessionSummary {
  id: string;
  title?: string;
  parentID?: string;
  time?: { created?: number; updated?: number };
  [key: string]: unknown;
}

export const useChatSessionStore = defineStore("chat-session", () => {
  const sessions = shallowRef<readonly ChatSessionSummary[]>(markRaw([]));
  const tree = shallowRef<SessionTree | null>(null);
  const activeSessionID = ref<string | null>(null);
  const selectionGeneration = ref(0);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const expanded = shallowRef<ReadonlySet<string>>(markRaw(new Set<string>()));
  const statusBySession = shallowRef<ReadonlyMap<string, HanseSessionStatus>>(
    markRaw(new Map<string, HanseSessionStatus>()),
  );

  function setSessions(list: readonly ChatSessionSummary[]): void {
    const normalized = list.filter(
      (session): session is ChatSessionSummary =>
        session !== null &&
        typeof session === "object" &&
        typeof session.id === "string" &&
        session.id.length > 0,
    );
    sessions.value = markRaw([...normalized]);
    tree.value = markRaw(buildSessionTree(normalized));
  }

  function setTree(next: SessionTree | null): void {
    tree.value = next === null ? null : markRaw(next);
  }

  function setActive(sessionID: string | null): void {
    if (sessionID !== activeSessionID.value) {
      activeSessionID.value = sessionID;
      selectionGeneration.value += 1;
    }
  }

  function bumpSelection(): number {
    selectionGeneration.value += 1;
    return selectionGeneration.value;
  }

  function setLoading(value: boolean): void {
    loading.value = value;
  }

  function setError(value: string | null): void {
    error.value = value;
  }

  function setExpanded(ids: Iterable<string>): void {
    expanded.value = markRaw(new Set(ids));
  }

  function toggleExpanded(id: string): void {
    const next = new Set(expanded.value);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    expanded.value = markRaw(next);
  }

  function setAgentStatus(sessionID: string, status: HanseSessionStatus): void {
    const next = new Map(statusBySession.value);
    next.set(sessionID, status);
    statusBySession.value = markRaw(next);
  }

  function agentStatusFor(sessionID: string | null): HanseSessionStatus | null {
    if (sessionID === null) {
      return null;
    }
    return statusBySession.value.get(sessionID) ?? null;
  }

  function firstRoot(): string | null {
    return firstRootId(tree.value);
  }

  function ancestorsOf(id: string): string[] {
    return ancestorIds(tree.value, id);
  }

  function clear(): void {
    sessions.value = markRaw([]);
    tree.value = null;
    activeSessionID.value = null;
    selectionGeneration.value = 0;
    loading.value = false;
    error.value = null;
    expanded.value = markRaw(new Set<string>());
    statusBySession.value = markRaw(new Map<string, HanseSessionStatus>());
  }

  return {
    sessions,
    tree,
    activeSessionID,
    selectionGeneration,
    loading,
    error,
    expanded,
    statusBySession,
    setSessions,
    setTree,
    setActive,
    bumpSelection,
    setLoading,
    setError,
    setExpanded,
    toggleExpanded,
    setAgentStatus,
    agentStatusFor,
    firstRoot,
    ancestorsOf,
    clear,
  };
});
