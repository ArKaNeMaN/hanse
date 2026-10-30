/**
 * Chat context, todo/plan, previews, handoffs, and runtime view.
 *
 * Session-keyed maps stay `shallowRef` + `markRaw`; the active session mirrors only. No URL writes.
 */

import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef } from "vue";
import type { Handoff } from "../../src/coordinator/handoff.js";
import type { RuntimeState } from "../../src/http/ui.js";
import type { ContextSnapshot } from "../../src/opencode/context.js";
import type { NormalizedTodo } from "../../src/opencode/prompts.js";
import type { PreviewView } from "../../src/preview/types.js";

export interface TodoCache {
  todos: readonly NormalizedTodo[];
  truncated: boolean;
}

export const useChatContextStore = defineStore("chat-context", () => {
  const contextBySession = shallowRef<ReadonlyMap<string, ContextSnapshot>>(
    markRaw(new Map<string, ContextSnapshot>()),
  );
  const snapshot = shallowRef<ContextSnapshot | null>(null);
  const todosBySession = shallowRef<ReadonlyMap<string, TodoCache>>(
    markRaw(new Map<string, TodoCache>()),
  );
  const todos = shallowRef<readonly NormalizedTodo[]>(markRaw([]));
  const todosTruncated = ref(false);
  const compactedAt = ref<string | null>(null);
  const previews = shallowRef<readonly PreviewView[]>(markRaw([]));
  const handoffs = shallowRef<readonly Handoff[]>(markRaw([]));
  const runtime = shallowRef<RuntimeState | null>(null);

  const plan = computed<readonly NormalizedTodo[]>(() => todos.value);
  const todoCounts = computed(() => {
    const counts = { total: 0, completed: 0, active: 0, pending: 0 };
    for (const todo of todos.value) {
      counts.total += 1;
      if (todo.status === "completed") {
        counts.completed += 1;
      } else if (todo.status === "in_progress") {
        counts.active += 1;
      } else {
        counts.pending += 1;
      }
    }
    return counts;
  });

  function setSnapshot(sessionID: string, next: ContextSnapshot, active: boolean): void {
    const contexts = new Map(contextBySession.value);
    contexts.set(sessionID, next);
    contextBySession.value = markRaw(contexts);
    if (active) {
      snapshot.value = markRaw(next);
    }
  }

  function snapshotFor(sessionID: string | null): ContextSnapshot | null {
    if (sessionID === null) {
      return null;
    }
    return contextBySession.value.get(sessionID) ?? null;
  }

  function setTodos(
    sessionID: string,
    next: readonly NormalizedTodo[],
    truncated: boolean,
    active: boolean,
  ): void {
    const cache: TodoCache = { todos: [...next], truncated };
    const all = new Map(todosBySession.value);
    all.set(sessionID, cache);
    todosBySession.value = markRaw(all);
    if (active) {
      todos.value = markRaw(cache.todos);
      todosTruncated.value = truncated;
    }
  }

  function todosFor(sessionID: string | null): TodoCache | null {
    if (sessionID === null) {
      return null;
    }
    return todosBySession.value.get(sessionID) ?? null;
  }

  function markCompacted(active: boolean): void {
    if (active) {
      compactedAt.value = new Date().toISOString();
    }
  }

  function setPreviews(next: readonly PreviewView[]): void {
    previews.value = markRaw([...next]);
  }

  function setHandoffs(next: readonly Handoff[]): void {
    handoffs.value = markRaw([...next]);
  }

  function setRuntime(next: RuntimeState | null): void {
    runtime.value = next;
  }

  function clearActive(): void {
    snapshot.value = null;
    todos.value = markRaw([]);
    todosTruncated.value = false;
    compactedAt.value = null;
  }

  function clear(): void {
    contextBySession.value = markRaw(new Map<string, ContextSnapshot>());
    todosBySession.value = markRaw(new Map<string, TodoCache>());
    snapshot.value = null;
    todos.value = markRaw([]);
    todosTruncated.value = false;
    compactedAt.value = null;
    previews.value = markRaw([]);
    handoffs.value = markRaw([]);
    runtime.value = null;
  }

  return {
    contextBySession,
    snapshot,
    todosBySession,
    todos,
    todosTruncated,
    compactedAt,
    previews,
    handoffs,
    runtime,
    plan,
    todoCounts,
    setSnapshot,
    snapshotFor,
    setTodos,
    todosFor,
    markCompacted,
    setPreviews,
    setHandoffs,
    setRuntime,
    clearActive,
    clear,
  };
});
