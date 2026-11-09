import type { Router } from "vue-router";
import { matchPage, routeById, routeKey } from "../../src/shared/routes.js";
import { useChromeStore } from "../stores/chrome.js";
import { useShellStore } from "../stores/shell.js";

export { announce } from "../announce.js";

interface FocusDestination {
  readonly path?: string;
  readonly meta?: { readonly workspace?: unknown };
}

function isWorkspaceDestination(destination: FocusDestination | undefined): boolean {
  if (destination === undefined) {
    return false;
  }
  if (destination.meta?.workspace === "chat" || destination.meta?.workspace === "terminal") {
    return true;
  }
  if (destination.path === undefined) {
    return false;
  }
  const match = matchPage(destination.path);
  return match?.id === "chat" || match?.id === "terminal";
}

/**
 * Move keyboard focus to the client-owned main landmark. Normal routes reset `.page`; workspace
 * routes own their scroll container and keep it untouched.
 */
export function focusMain(destination?: FocusDestination): void {
  const main = document.getElementById("main");
  if (main !== null) {
    main.focus({ preventScroll: true });
  }
  if (isWorkspaceDestination(destination)) {
    return;
  }
  const scrollContainer = document.querySelector<HTMLElement>(".page");
  if (scrollContainer !== null) {
    scrollContainer.scrollTop = 0;
  }
}

function queryForRouteKey(query: Record<string, unknown>): Record<string, string | null> {
  const normalized: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      const last = value[value.length - 1];
      normalized[key] = typeof last === "string" ? last : null;
    } else if (typeof value === "string" || value === null) {
      normalized[key] = value;
    }
  }
  return normalized;
}

/**
 * Install route title/identity updates, focus, drawer behavior, and the visibility refresh.
 *
 * Chrome data itself is owned by pages through `usePageChrome`; this hook only advances the route
 * identity and the provisional title so a same-title navigation can still be announced when the
 * page response lands.
 */
export function installChrome(router: Router): () => void {
  const chromeStore = useChromeStore();
  const shellStore = useShellStore();
  let initial = true;

  router.afterEach((to) => {
    if (initial) {
      initial = false;
      return;
    }
    const match = matchPage(to.path);
    if (match !== undefined) {
      const definition = routeById(match.id);
      if (definition !== undefined) {
        chromeStore.setProvisionalTitle(definition.label);
      }
      chromeStore.setRouteKey(
        routeKey(match.id, match.params, queryForRouteKey(to.query as Record<string, unknown>)),
      );
    }
    shellStore.close(false);
    focusMain(to);
  });

  const cleanupShell = shellStore.install();

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      return;
    }
    const entry = chromeStore.primaryRefresh;
    if (entry === undefined || entry.isFetching() || chromeStore.visibilityRefreshing) {
      return;
    }
    chromeStore.visibilityRefreshing = true;
    void entry
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        chromeStore.visibilityRefreshing = false;
      });
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  return () => {
    cleanupShell();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
