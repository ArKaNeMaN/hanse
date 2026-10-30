/**
 * The sole owner of chat `sessionStorage`: queue-promotion suppression and image intent.
 *
 * Keys match the legacy client so an allowlisted SPA visit and a legacy visit share the same
 * workspace state across the rollback. Everything is namespaced by app/project (and the queue
 * suppression list by session id) so one workspace cannot suppress or resume another. All access
 * is defensive: private-mode storage failures degrade to the in-memory default.
 */

export interface ChatStorageScope {
  readonly app: string;
  readonly project: string;
}

export interface ImageIntent {
  readonly action: "build_start" | "rebuild_restart";
  readonly startedAt: number;
}

const QUEUE_BLOCKED_PREFIX = "hanse-chat-queue-blocked";
const IMAGE_INTENT_PREFIX = "hanse.chat.imageIntent";

function scopeID(scope: ChatStorageScope): string | null {
  const app = scope.app.trim();
  const project = scope.project.trim();
  if (app.length === 0) {
    return null;
  }
  return `${project}:${app}`;
}

export function queueBlockedStorageKey(scope: ChatStorageScope): string | null {
  const id = scopeID(scope);
  return id === null ? null : `${QUEUE_BLOCKED_PREFIX}:${id}`;
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

function readQueued(scope: ChatStorageScope): Set<string> {
  const key = queueBlockedStorageKey(scope);
  if (key === null) {
    return new Set<string>();
  }
  try {
    const raw = storage()?.getItem(key);
    if (raw === null || raw === undefined || raw.length === 0) {
      return new Set<string>();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(
      parsed.filter((value): value is string => typeof value === "string" && value.length > 0),
    );
  } catch {
    return new Set<string>();
  }
}

function writeQueued(scope: ChatStorageScope, blocked: ReadonlySet<string>): void {
  const key = queueBlockedStorageKey(scope);
  const target = storage();
  if (key === null || target === null) {
    return;
  }
  try {
    if (blocked.size === 0) {
      target.removeItem(key);
    } else {
      target.setItem(key, JSON.stringify([...blocked].sort()));
    }
  } catch {
    // Storage can be unavailable or full; suppression is advisory only.
  }
}

/** Session ids whose queue promotion stays suppressed for this workspace. */
export function readQueuePromotionBlocks(scope: ChatStorageScope): ReadonlySet<string> {
  return readQueued(scope);
}

export function blockQueuePromotion(scope: ChatStorageScope, sessionID: string): void {
  const id = sessionID.trim();
  if (id.length === 0) {
    return;
  }
  const blocked = readQueued(scope);
  if (blocked.has(id)) {
    return;
  }
  blocked.add(id);
  writeQueued(scope, blocked);
}

export function unblockQueuePromotion(scope: ChatStorageScope, sessionID: string): void {
  const id = sessionID.trim();
  if (id.length === 0) {
    return;
  }
  const blocked = readQueued(scope);
  if (!blocked.delete(id)) {
    return;
  }
  writeQueued(scope, blocked);
}

/** Legacy rule: suppression applies only while the session is not idle/unknown. */
export function queuePromotionAllowed(
  scope: ChatStorageScope,
  sessionID: string,
  statusType: string | undefined,
): boolean {
  if (!readQueued(scope).has(sessionID)) {
    return true;
  }
  return !(statusType === undefined || statusType === "idle" || statusType === "unknown");
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

/** Clear the per-session queue suppression together with workspace image intent. */
export function clearChatSessionState(scope: ChatStorageScope, sessionID: string): void {
  unblockQueuePromotion(scope, sessionID);
  clearImageIntent(scope);
}

/** Clear every chat key for one app/project workspace. */
export function clearChatWorkspaceState(scope: ChatStorageScope): void {
  const queueKey = queueBlockedStorageKey(scope);
  const target = storage();
  if (target === null) {
    return;
  }
  try {
    if (queueKey !== null) {
      target.removeItem(queueKey);
    }
    const imageKey = imageIntentStorageKey(scope);
    if (imageKey !== null) {
      target.removeItem(imageKey);
    }
  } catch {
    // no-op
  }
}
