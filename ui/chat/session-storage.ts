/**
 * The sole owner of the chat image-intent `sessionStorage` key.
 *
 * Everything is namespaced by app/project so one workspace cannot resume another's image action.
 * All access is defensive: private-mode storage failures degrade to the in-memory default.
 */

export interface ChatStorageScope {
  readonly app: string;
  readonly project: string;
}

export interface ImageIntent {
  readonly action: "build_start" | "rebuild_restart";
  readonly startedAt: number;
}

const IMAGE_INTENT_PREFIX = "hanse.chat.imageIntent";

function scopeID(scope: ChatStorageScope): string | null {
  const app = scope.app.trim();
  const project = scope.project.trim();
  if (app.length === 0) {
    return null;
  }
  return `${project}:${app}`;
}

export function imageIntentStorageKey(scope: ChatStorageScope): string | null {
  const id = scopeID(scope);
  return id === null ? null : `${IMAGE_INTENT_PREFIX}:${id}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readImageIntent(scope: ChatStorageScope): ImageIntent | null {
  const key = imageIntentStorageKey(scope);
  if (key === null) {
    return null;
  }
  try {
    const raw = storage()?.getItem(key);
    if (raw === null || raw === undefined || raw.length === 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const action = (parsed as { action?: unknown }).action;
    if (action !== "build_start" && action !== "rebuild_restart") {
      return null;
    }
    const startedAt = (parsed as { startedAt?: unknown }).startedAt;
    return {
      action,
      startedAt:
        typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeImageIntent(scope: ChatStorageScope, intent: ImageIntent): void {
  const key = imageIntentStorageKey(scope);
  const target = storage();
  if (key === null || target === null) {
    return;
  }
  try {
    target.setItem(key, JSON.stringify(intent));
  } catch {
    // Intent is advisory; a failed write only loses resume-on-return.
  }
}

export function clearImageIntent(scope: ChatStorageScope): void {
  const key = imageIntentStorageKey(scope);
  const target = storage();
  if (key === null || target === null) {
    return;
  }
  try {
    target.removeItem(key);
  } catch {
    // no-op
  }
}

/** Clear the workspace image intent together with any per-session chat state. */
export function clearChatSessionState(scope: ChatStorageScope, _sessionID: string): void {
  clearImageIntent(scope);
}

/** Clear every chat key for one app/project workspace. */
export function clearChatWorkspaceState(scope: ChatStorageScope): void {
  clearImageIntent(scope);
}
