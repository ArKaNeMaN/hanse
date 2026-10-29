import type { Router } from "vue-router";
import type { BootChrome } from "../boot.js";

export type ChromeFragment = BootChrome;

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

/** Move keyboard focus to the client-owned main landmark and reset its scroll container. */
export function focusMain(): void {
  const main = document.getElementById("main");
  if (main !== null) {
    main.focus({ preventScroll: true });
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
 * Fetch the server-rendered chrome fragment. `path` is a page path without a query string; the
 * chrome response does not depend on it. `nextPath` keeps the query for the login redirect.
 * Returns undefined on a non-auth failure.
 */
export async function fetchChrome(
  path: string,
  nextPath: string = path,
): Promise<ChromeFragment | undefined> {
  try {
    const response = await fetch(`/api/ui/chrome?path=${encodeURIComponent(path)}`, {
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
export function installChrome(router: Router): () => void {
  let initial = true;
  let currentPath = router.currentRoute.value.fullPath;
  let currentRoutePath = router.currentRoute.value.path;

  router.afterEach(async (to) => {
    currentPath = to.fullPath;
    currentRoutePath = to.path;
    if (initial) {
      initial = false;
      return;
    }

    const chrome = await fetchChrome(to.path, to.fullPath);
    if (chrome !== undefined) {
      applyChrome(chrome);
    }
    closeDrawer();
    focusMain();
    announce(chrome?.title ?? document.title);
  });

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      return;
    }
    void fetchChrome(currentRoutePath, currentPath).then((chrome) => {
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
