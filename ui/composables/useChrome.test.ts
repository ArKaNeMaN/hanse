import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { routeKey } from "../../src/shared/routes.js";
import type { ChromeData } from "../boot.js";
import { useChromeStore } from "../stores/chrome.js";
import { useShellStore } from "../stores/shell.js";
import { focusMain, installChrome } from "./useChrome.js";

const CHROME: ChromeData = {
  title: "Projects",
  active: "projects",
  breadcrumb: [{ label: "Projects" }],
  projects: [],
  masterHref: "/chat?app=master&project=hanse-master",
  pendingCount: 0,
  sshPendingCount: 0,
};

function shell(): void {
  document.body.innerHTML = `
    <div id="shell" data-nav="open" data-nav-id="none">
      <button data-nav-toggle aria-expanded="true" aria-label="Close navigation"></button>
      <aside id="sidebar"><a class="nav-item" href="/projects">Projects</a></aside>
      <div data-nav-close></div>
    </div>
    <div id="route-announcer"></div>
    <main id="main" tabindex="-1"><div class="page"></div></main>
  `;
}

describe("installChrome", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    shell();
    setActivePinia(createPinia());
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("does not fetch chrome for the initial route resolution", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/projects", component: { template: "<div />" } },
        { path: "/handoffs", component: { template: "<div />" } },
      ],
    });
    cleanup = installChrome(router);

    await router.push("/projects");
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("advances the route key, sets a provisional title, focuses main, resets scroll, and closes the drawer", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/projects", component: { template: "<div />" } },
        { path: "/handoffs", component: { template: "<div />" } },
      ],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    await flushPromises();

    const page = document.querySelector<HTMLElement>(".page");
    if (page !== null) {
      page.scrollTop = 240;
    }

    await router.push("/handoffs");
    await flushPromises();

    const store = useChromeStore();
    expect(store.currentRouteKey).toBe(routeKey("handoffs", {}, {}));
    expect(document.title).toBe("Handoffs - hanse");
    expect(document.activeElement?.id).toBe("main");
    expect(page?.scrollTop).toBe(0);
    expect(document.getElementById("shell")?.dataset.nav).toBe("closed");
    expect(document.querySelector("[data-nav-toggle]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes the route key with the shared canonical form", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/chat", component: { template: "<div />" } },
        { path: "/projects", component: { template: "<div />" } },
      ],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    await flushPromises();

    await router.push("/chat?session=s1&legacy=1&app=a&project=p");
    await flushPromises();

    expect(useChromeStore().currentRouteKey).toBe(
      routeKey("chat", {}, { app: "a", project: "p", legacy: "1" }),
    );
  });

  it("does not reset .page scroll for a workspace route", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/projects", component: { template: "<div />" } },
        { path: "/chat", component: { template: "<div />" }, meta: { workspace: "chat" } },
      ],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    await flushPromises();

    const page = document.querySelector<HTMLElement>(".page");
    if (page !== null) {
      page.scrollTop = 240;
    }

    await router.push("/chat?app=web&project=p");
    await flushPromises();

    expect(page?.scrollTop).toBe(240);
    expect(document.activeElement?.id).toBe("main");
  });

  it("closes the drawer through the shell controls and Escape", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/projects", component: { template: "<div />" } }],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    await flushPromises();
    const shellStore = useShellStore();

    document.querySelector<HTMLElement>("[data-nav-toggle]")?.click();
    expect(shellStore.open).toBe(true);
    expect(document.getElementById("shell")?.dataset.nav).toBe("open");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(shellStore.open).toBe(false);
    expect(document.getElementById("shell")?.dataset.nav).toBe("closed");
  });

  it("refreshes the registered primary query on visibility and skips while fetching", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/projects", component: { template: "<div />" } }],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    await flushPromises();

    const store = useChromeStore();
    let fetching = false;
    let resolveRefresh: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    store.registerPrimaryRefresh({
      token: Symbol("primary"),
      isFetching: () => fetching,
      refresh,
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.visibilityRefreshing).toBe(true);

    fetching = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(refresh).toHaveBeenCalledTimes(1);

    fetching = false;
    resolveRefresh?.();
    await flushPromises();
    expect(store.visibilityRefreshing).toBe(false);
  });

  it("does not refresh on a window focus event", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/projects", component: { template: "<div />" } }],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    await flushPromises();

    const refresh = vi.fn(async () => undefined);
    useChromeStore().registerPrimaryRefresh({
      token: Symbol("primary"),
      isFetching: () => false,
      refresh,
    });

    window.dispatchEvent(new Event("focus"));
    await flushPromises();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("announces a same-title navigation through setChrome", () => {
    const store = useChromeStore();
    store.initialize({
      route: { id: "projects", params: {} },
      props: {},
      chrome: CHROME,
      routeKey: routeKey("projects", {}, {}),
      topbar: { ideHref: "/ide/" },
    });

    const nextKey = routeKey("projects", {}, { q: "next" });
    store.setRouteKey(nextKey);
    store.setChrome(CHROME, nextKey);

    expect(document.title).toBe("Projects - hanse");
    expect(document.getElementById("route-announcer")?.textContent).toBe("Projects");
  });

  it("does not re-announce the same route and title", () => {
    const store = useChromeStore();
    const key = routeKey("projects", {}, {});
    store.initialize({
      route: { id: "projects", params: {} },
      props: {},
      chrome: CHROME,
      routeKey: key,
      topbar: { ideHref: "/ide/" },
    });
    const announcer = document.getElementById("route-announcer");
    if (announcer !== null) {
      announcer.textContent = "";
    }

    store.setChrome(CHROME, key);

    expect(announcer?.textContent).toBe("");
  });

  it("keeps normal routes resetting .page and workspace routes untouched", () => {
    const page = document.querySelector<HTMLElement>(".page");
    if (page !== null) {
      page.scrollTop = 120;
    }
    focusMain({ path: "/projects" });
    expect(page?.scrollTop).toBe(0);
    if (page !== null) {
      page.scrollTop = 120;
    }
    focusMain({ path: "/chat" });
    expect(page?.scrollTop).toBe(120);
  });
});
