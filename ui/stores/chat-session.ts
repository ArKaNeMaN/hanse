/**
 * Chat session selection, list, tree, and generation.
 *
 * This store never writes the URL. `route.query` remains the sole source for the active selection;
 * this is a read-only mirror plus the derived tree/expanded state, prompt wait counts, and subtree
 * removal used by the sessions rail.
 */

import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import {
  ancestorIds,
  buildSessionTree,
  collectSubtreeIds,
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

export function chatSessionLabel(session: ChatSessionSummary | undefined): string {
  if (session === undefined) {
    return "Session";
  }
  if (typeof session.title === "string" && session.title.trim().length > 0) {
    return session.title.trim();
  }
  return session.id.slice(0, 8);
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
  const waitingCountBySession = shallowRef<ReadonlyMap<string, number>>(
    markRaw(new Map<string, number>()),
  );
  const promptKeysBySession = new Map<string, Set<string>>();
  const workspace = ref<string | null>(null);

  function ancestorSet(id: string | null): string[] {
    if (id === null) {
      return [];
    }
    return ancestorIds(tree.value, id);
  }

  function expandAncestors(id: string | null): void {
    const ancestors = ancestorSet(id);
    if (ancestors.length === 0) {
      return;
    }
    const next = new Set(expanded.value);
    let changed = false;
    for (const ancestor of ancestors) {
      if (!next.has(ancestor)) {
        next.add(ancestor);
        changed = true;
      }
    }
    if (changed) {
      expanded.value = markRaw(next);
    }
  }

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
    expandAncestors(activeSessionID.value);
  }

  function setTree(next: SessionTree | null): void {
    tree.value = next === null ? null : markRaw(next);
    expandAncestors(activeSessionID.value);
  }

  function setActive(sessionID: string | null): void {
    if (sessionID !== activeSessionID.value) {
      activeSessionID.value = sessionID;
      selectionGeneration.value += 1;
    }
    expandAncestors(sessionID);
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

  function publishWaiting(): void {
    const counts = new Map<string, number>();
    for (const [sessionID, keys] of promptKeysBySession) {
      if (keys.size > 0) {
        counts.set(sessionID, keys.size);
      }
    }
    waitingCountBySession.value = markRaw(counts);
  }

  /** Track one pending prompt under its stable `${source}:${id}` key. */
  function trackPromptPending(sessionID: string, key: string): void {
    const id = sessionID.trim();
    const promptKey = key.trim();
    if (id.length === 0 || promptKey.length === 0) {
      return;
    }
    let keys = promptKeysBySession.get(id);
    if (keys === undefined) {
      keys = new Set<string>();
      promptKeysBySession.set(id, keys);
    }
    if (keys.has(promptKey)) {
      return;
    }
    keys.add(promptKey);
    publishWaiting();
  }

  function resolvePromptPending(sessionID: string | undefined, key: string): void {
    const id = sessionID?.trim() ?? "";
    const promptKey = key.trim();
    if (id.length === 0 || promptKey.length === 0) {
      return;
    }
    const keys = promptKeysBySession.get(id);
    if (keys === undefined || !keys.delete(promptKey)) {
      return;
    }
    if (keys.size === 0) {
      promptKeysBySession.delete(id);
    }
    publishWaiting();
  }

  function waitingCountFor(sessionID: string): number {
    return waitingCountBySession.value.get(sessionID) ?? 0;
  }

  /** Sessions + descendants, in tree order, exactly as the bulk delete targets them. */
  function subtreeIDs(id: string): string[] {
    return collectSubtreeIds(tree.value, id);
  }

  function removeSessions(ids: readonly string[]): void {
    const removed = new Set(ids);
    if (removed.size === 0) {
      return;
    }
    const nextSessions = sessions.value.filter((session) => !removed.has(session.id));
    sessions.value = markRaw(nextSessions);
    tree.value = markRaw(buildSessionTree(nextSessions));
    const nextExpanded = new Set([...expanded.value].filter((id) => !removed.has(id)));
    expanded.value = markRaw(nextExpanded);
    const nextStatus = new Map<string, HanseSessionStatus>();
    for (const [id, status] of statusBySession.value) {
      if (!removed.has(id)) {
        nextStatus.set(id, status);
      }
    }
    statusBySession.value = markRaw(nextStatus);
    for (const id of removed) {
      promptKeysBySession.delete(id);
    }
    publishWaiting();
    if (activeSessionID.value !== null && removed.has(activeSessionID.value)) {
      activeSessionID.value = null;
    }
  }

  /**
   * Bind the store to one app/project workspace. A different workspace clears the previous tree,
   * wait counts, and selection so a keyed `ChatPage` remount never paints the old workspace.
   */
  function bindWorkspace(key: string): boolean {
    if (workspace.value === key) {
      return false;
    }
    const changed = workspace.value !== null;
    if (changed) {
      clear();
    }
    workspace.value = key;
    return changed;
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
    promptKeysBySession.clear();
    waitingCountBySession.value = markRaw(new Map<string, number>());
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
    waitingCountBySession,
    workspace,
    bindWorkspace,
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
    trackPromptPending,
    resolvePromptPending,
    waitingCountFor,
    subtreeIDs,
    removeSessions,
    expandAncestors,
    firstRoot,
    ancestorsOf,
    clear,
  };
});
