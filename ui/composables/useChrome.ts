import type { Router } from "vue-router";
import { matchPage } from "../../src/shared/routes.js";
import type { BootChrome } from "../boot.js";

export type ChromeFragment = BootChrome;

export interface ChromeHints {
  readonly projectId?: string;
  readonly appKey?: string;
}

interface FocusDestination {
  readonly path?: string;
  readonly meta?: { readonly workspace?: unknown };
}

function isChrome(value: unknown): value is ChromeFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).sidebarNav === "string" &&
    typeof (value as Record<string, unknown>).breadcrumb === "string" &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).active === "string" &&
    typeof (value as Record<string, unknown>).pendingCount === "number" &&
    typeof (value as Record<string, unknown>).sshPendingCount === "number"
  );
}

/** Replace the server-rendered chrome fragments with the same fragments for the new route. */
export function applyChrome(chrome: ChromeFragment): void {
  const sidebar = document.getElementById("sidebar-nav");
  if (sidebar !== null) {
    sidebar.innerHTML = chrome.sidebarNav;
    sidebar.dataset.navId = chrome.active;
  }

  const breadcrumb = document.getElementById("breadcrumb-host");
  if (breadcrumb !== null) {
    breadcrumb.innerHTML = chrome.breadcrumb;
    breadcrumb.dataset.navId = chrome.active;
  }

  document.title = `${chrome.title} - hanse`;
}

/** Close the mobile drawer after a client-side navigation. */
export function closeDrawer(): void {
  const shell = document.getElementById("shell");
  if (shell === null) {
    return;
  }
  shell.dataset.nav = "closed";
  const toggle = document.querySelector("[data-nav-toggle]");
  if (toggle !== null) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open navigation");
  }
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

/** Announce the new page title through the shell's polite live region. */
export function announce(message: string): void {
  const announcer = document.getElementById("route-announcer");
  if (announcer !== null) {
    announcer.textContent = message;
  }
}

function redirectToLogin(path: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.location.assign(`/login?next=${encodeURIComponent(path)}`);
}

/**
 * Build the chrome query. `path` selects the route; `project`/`app` are workspace hints so a
 * chat/terminal refresh keeps the correct scoped sidebar and breadcrumb.
 */
function chromeQuery(path: string, hints: ChromeHints | undefined): string {
  const params = new URLSearchParams({ path });
  if (hints?.projectId !== undefined) {
    params.set("project", hints.projectId);
  }
  if (hints?.appKey !== undefined) {
    params.set("app", hints.appKey);
  }
  return params.toString();
}

/**
 * Fetch the server-rendered chrome fragment. `nextPath` keeps the query for the login redirect.
 * Returns undefined on a non-auth failure.
 */
export async function fetchChrome(
  path: string,
  nextPath: string = path,
  hints?: ChromeHints,
): Promise<ChromeFragment | undefined> {
  try {
    const response = await fetch(`/api/ui/chrome?${chromeQuery(path, hints)}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) {
      redirectToLogin(nextPath);
      return undefined;
    }
    if (!response.ok) {
      return undefined;
    }
    const payload: unknown = await response.json();
    return isChrome(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refresh the shell after a client-side navigation. The initial render already contains the boot
 * chrome, so no request is made for the first route resolution. Counters are also refreshed when
 * the tab becomes visible again.
 *
 * Returns a cleanup function for tests and teardown.
 */
function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === "string" && value[0].length > 0 ? value[0] : undefined;
  }
  return undefined;
}

function hintsFor(path: string, query: Record<string, unknown>): ChromeHints | undefined {
  const match = matchPage(path);
  if (match?.id !== "chat" && match?.id !== "terminal") {
    return undefined;
  }
  const projectId = firstQueryValue(query.project);
  const appKey = firstQueryValue(query.app);
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(appKey === undefined ? {} : { appKey }),
  };
}

export function installChrome(router: Router): () => void {
  let initial = true;
  let currentPath = router.currentRoute.value.fullPath;
  let currentRoutePath = router.currentRoute.value.path;
  let currentHints = hintsFor(
    router.currentRoute.value.path,
    router.currentRoute.value.query as Record<string, unknown>,
  );

  router.afterEach(async (to) => {
    currentPath = to.fullPath;
    currentRoutePath = to.path;
    currentHints = hintsFor(to.path, to.query as Record<string, unknown>);
    if (initial) {
      initial = false;
      return;
    }

    const chrome = await fetchChrome(to.path, to.fullPath, currentHints);
    if (chrome !== undefined) {
      applyChrome(chrome);
    }
    closeDrawer();
    focusMain(to);
    announce(chrome?.title ?? document.title);
  });

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      return;
    }
    void fetchChrome(currentRoutePath, currentPath, currentHints).then((chrome) => {
      if (chrome !== undefined) {
        applyChrome(chrome);
      }
    });
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
