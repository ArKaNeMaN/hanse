/**
 * `route.query` is the single source of truth for the chat workspace identity.
 *
 * The composable has exactly one watcher. It applies normalized `app`/`project`/`session` values to
 * the session store; every user action goes through the router (`replace` for a session,
 * `push` for an app switch). Nothing here (or in a store/component) writes `history` directly.
 */

import { type ComputedRef, computed, type Ref, ref, watch } from "vue";
import type { RouteLocationNormalizedLoaded, Router } from "vue-router";
import { buildSessionTree, firstRootId } from "../../assets/chat-core.js";
import { type ChatSessionSummary, useChatSessionStore } from "../stores/chat-session.js";

export interface NormalizedChatQuery {
  readonly app: string;
  readonly project: string;
  readonly session: string | null;
}

export interface ChatRouteStateOptions {
  /** Background draft flush hook; Stage 4A owns the composer. */
  readonly onBeforeSessionChange?: (previous: string | null, next: string) => void;
  readonly onBeforeAppSwitch?: () => void;
}

export interface ChatRouteState {
  readonly app: Ref<string>;
  readonly project: Ref<string>;
  readonly session: Ref<string | null>;
  readonly generation: Ref<number>;
  readonly pendingSession: Ref<string | null>;
  readonly workspaceKey: ComputedRef<string>;
  selectSession(sessionID: string): void;
  switchApp(appKey: string, projectId: string): void;
  canonicalize(
    sessions: readonly ChatSessionSummary[],
    options?: { readonly unavailable?: boolean; readonly stopped?: boolean },
  ): string | null;
}

/** String-only normalization: arrays, blanks, and unknown keys are dropped. */
export function normalizeChatQuery(query: Record<string, unknown>): NormalizedChatQuery {
  const value = (key: string): string => {
    const raw = query[key];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const session = value("session");
  return {
    app: value("app"),
    project: value("project"),
    session: session.length > 0 ? session : null,
  };
}

export function useChatRouteState(
  router: Router,
  route: RouteLocationNormalizedLoaded,
  options: ChatRouteStateOptions = {},
): ChatRouteState {
  const sessions = useChatSessionStore();
  const initial = normalizeChatQuery(route.query as Record<string, unknown>);
  const app = ref(initial.app);
  const project = ref(initial.project);
  const session = ref<string | null>(initial.session);
  const generation = ref(0);
  const pendingSession = ref<string | null>(null);
  const workspaceKey = computed(() => `${app.value}:${project.value}`);

  // The one watcher: query -> refs + store mirror. No guard flags suppress re-application.
  watch(
    () => [route.query.app, route.query.project, route.query.session] as const,
    () => {
      const next = normalizeChatQuery(route.query as Record<string, unknown>);
      app.value = next.app;
      project.value = next.project;
      session.value = next.session;
      generation.value += 1;
      sessions.setActive(next.session);
      if (pendingSession.value === next.session) {
        pendingSession.value = null;
      }
    },
    { immediate: true, flush: "sync" },
  );

  function selectSession(sessionID: string): void {
    const next = sessionID.trim();
    if (next.length === 0) {
      return;
    }
    if (next === session.value && pendingSession.value === null) {
      return;
    }
    generation.value += 1;
    sessions.bumpSelection();
    pendingSession.value = next;
    sessions.setActive(next);
    options.onBeforeSessionChange?.(session.value, next);
    void router.replace({ query: { ...route.query, session: next } });
  }

  function switchApp(appKey: string, projectId: string): void {
    const nextApp = appKey.trim();
    if (nextApp.length === 0) {
      return;
    }
    generation.value += 1;
    pendingSession.value = null;
    sessions.clear();
    options.onBeforeAppSwitch?.();
    const nextProject = projectId.trim();
    void router.push({
      name: "chat",
      query: nextProject.length === 0 ? { app: nextApp } : { app: nextApp, project: nextProject },
    });
  }

  function canonicalize(
    list: readonly ChatSessionSummary[],
    canonicalOptions: { readonly unavailable?: boolean; readonly stopped?: boolean } = {},
  ): string | null {
    // Preserve the requested deep link when sessions are unreadable, the agent is stopped/error,
    // or the list is empty; do not invent a session.
    if (canonicalOptions.unavailable === true || canonicalOptions.stopped === true) {
      return null;
    }
    if (list.length === 0) {
      return null;
    }
    const requested = session.value;
    if (requested !== null && list.some((entry) => entry.id === requested)) {
      return null;
    }
    const tree = buildSessionTree(list);
    const target = firstRootId(tree) ?? list[0]?.id ?? null;
    if (target === null || target === requested) {
      return null;
    }
    void router.replace({ query: { ...route.query, session: target } });
    return target;
  }

  return {
    app,
    project,
    session,
    generation,
    pendingSession,
    workspaceKey,
    selectSession,
    switchApp,
    canonicalize,
  };
}
