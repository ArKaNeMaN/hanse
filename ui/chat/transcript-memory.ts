/**
 * In-memory transcript view state: measured row heights and remembered detail open state.
 *
 * The cache is scoped by `scrollMemoryKey(workspaceKey, sessionId)` and survives route
 * unmount/remount within one SPA session. It intentionally uses no storage, network, Vue, or DOM
 * dependency; a hard reload starts empty.
 */

/** Injected by `ChatThread` so leaf detail components share one session's remembered state. */
export interface TranscriptDetailScope {
  isOpen(id: string): boolean | undefined;
  setOpen(id: string, open: boolean): void;
}

export interface TranscriptMemory extends TranscriptDetailScope {
  readHeight(key: string): number | undefined;
  writeHeight(key: string, height: number): void;
  pruneHeights(liveKeys: ReadonlySet<string>): void;
  pruneDetails(liveIds: ReadonlySet<string>): void;
}

export const TRANSCRIPT_DETAIL_SCOPE: symbol = Symbol("hanse.transcript-detail-scope");

/** Safety nets for removed keys only; live keys are refreshed and pruned by the caller. */
const HEIGHT_LIMIT = 5000;
const DETAIL_LIMIT = 2000;

interface ScopeState {
  readonly heights: Map<string, number>;
  readonly details: Map<string, boolean>;
}

const scopes = new Map<string, ScopeState>();

function stateFor(scopeKey: string): ScopeState {
  let state = scopes.get(scopeKey);
  if (state === undefined) {
    state = { heights: new Map<string, number>(), details: new Map<string, boolean>() };
    scopes.set(scopeKey, state);
  }
  return state;
}

/** Maps keep insertion order; delete-then-set moves a hot key to the newest position. */
function touch<Value>(map: Map<string, Value>, key: string, value: Value): void {
  map.delete(key);
  map.set(key, value);
}

function trimOldest<Value>(map: Map<string, Value>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done === true) {
      return;
    }
    map.delete(oldest.value);
  }
}

function validScope(scopeKey: string | null): scopeKey is string {
  return scopeKey !== null && scopeKey.length > 0;
}

function transientMemory(): TranscriptMemory {
  return {
    isOpen: () => undefined,
    setOpen: () => undefined,
    readHeight: () => undefined,
    writeHeight: () => undefined,
    pruneHeights: () => undefined,
    pruneDetails: () => undefined,
  };
}

const TRANSIENT_MEMORY = transientMemory();

export function createTranscriptMemory(scopeKey: string | null): TranscriptMemory {
  if (!validScope(scopeKey)) {
    return TRANSIENT_MEMORY;
  }
  const key = scopeKey;

  return {
    isOpen(id: string): boolean | undefined {
      const state = scopes.get(key);
      if (state === undefined) {
        return undefined;
      }
      const value = state.details.get(id);
      if (value === undefined) {
        return undefined;
      }
      touch(state.details, id, value);
      return value;
    },

    setOpen(id: string, open: boolean): void {
      const state = stateFor(key);
      touch(state.details, id, open);
      trimOldest(state.details, DETAIL_LIMIT);
    },

    readHeight(rowKey: string): number | undefined {
      const state = scopes.get(key);
      if (state === undefined) {
        return undefined;
      }
      const value = state.heights.get(rowKey);
      if (value === undefined) {
        return undefined;
      }
      touch(state.heights, rowKey, value);
      return value;
    },

    writeHeight(rowKey: string, height: number): void {
      const state = stateFor(key);
      touch(state.heights, rowKey, height);
      trimOldest(state.heights, HEIGHT_LIMIT);
    },

    pruneHeights(liveKeys: ReadonlySet<string>): void {
      const state = scopes.get(key);
      if (state === undefined) {
        return;
      }
      for (const rowKey of Array.from(state.heights.keys())) {
        if (!liveKeys.has(rowKey)) {
          state.heights.delete(rowKey);
        }
      }
    },

    pruneDetails(liveIds: ReadonlySet<string>): void {
      const state = scopes.get(key);
      if (state === undefined) {
        return;
      }
      for (const id of Array.from(state.details.keys())) {
        if (!liveIds.has(id)) {
          state.details.delete(id);
        }
      }
    },
  };
}

/** Clear one scope, or every scope when no key is given. */
export function clearTranscriptMemory(scopeKey?: string): void {
  if (scopeKey === undefined) {
    scopes.clear();
    return;
  }
  scopes.delete(scopeKey);
}
