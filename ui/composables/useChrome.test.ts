import { flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { fetchChrome, focusMain, installChrome } from "./useChrome.js";

const CHROME = {
  sidebarNav: '<p class="nav-label">Projects</p>',
  breadcrumb: '<span class="crumb">Projects</span>',
  title: "Projects",
  active: "projects",
  pendingCount: 0,
  sshPendingCount: 0,
};

function shell(): void {
  document.body.innerHTML = `
    <div id="shell" data-nav="open">
      <button data-nav-toggle aria-expanded="true" aria-label="Close navigation"></button>
      <nav id="sidebar-nav"></nav>
      <nav id="breadcrumb-host"></nav>
    </div>
    <div id="route-announcer"></div>
    <main id="main" tabindex="-1"><div class="page"></div></main>
  `;
}

function jsonChrome(): Response {
  return new Response(JSON.stringify(CHROME), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("installChrome", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    shell();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonChrome());
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

  it("swaps the nav and breadcrumb, sets the title, focuses main, resets scroll, announces, and closes the drawer", async () => {
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/ui/chrome?path=%2Fhandoffs");
    expect(document.getElementById("sidebar-nav")?.innerHTML).toBe(CHROME.sidebarNav);
    expect(document.getElementById("breadcrumb-host")?.innerHTML).toBe(CHROME.breadcrumb);
    expect(document.getElementById("sidebar-nav")?.dataset.navId).toBe("projects");
    expect(document.title).toBe("Projects - hanse");
    expect(document.activeElement?.id).toBe("main");
    expect(page?.scrollTop).toBe(0);
    expect(document.getElementById("route-announcer")?.textContent).toBe("Projects");
    expect(document.getElementById("shell")?.dataset.nav).toBe("closed");
    expect(document.querySelector("[data-nav-toggle]")?.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("refreshes chrome when the tab becomes visible", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/projects", component: { template: "<div />" } }],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    await flushPromises();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/ui/chrome?path=%2Fprojects");
  });

  it("keeps the current chrome when the fetch fails", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/projects", component: { template: "<div />" } },
        { path: "/handoffs", component: { template: "<div />" } },
      ],
    });
    cleanup = installChrome(router);
    await router.push("/projects");
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));

    await router.push("/handoffs");
    await flushPromises();

    expect(document.getElementById("sidebar-nav")?.innerHTML).toBe("");
    expect(document.getElementById("shell")?.dataset.nav).toBe("closed");
  });

  it("forwards workspace project/app hints to the chrome endpoint", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/projects", component: { template: "<div />" } },
        {
          path: "/chat",
          component: { template: "<div />" },
          meta: { workspace: "chat" },
        },
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/ui/chrome?path=%2Fchat&project=p&app=web");
    expect(document.activeElement?.id).toBe("main");
    expect(page?.scrollTop).toBe(240);
  });

  it("forwards hints directly and keeps normal routes resetting .page", async () => {
    await fetchChrome("/terminal", "/terminal?app=web&project=p", {
      projectId: "p",
      appKey: "web",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/ui/chrome?path=%2Fterminal&project=p&app=web",
    );

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
