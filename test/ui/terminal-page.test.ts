import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { BootPayload } from "../../ui/boot.js";
import TerminalStoppedState from "../../ui/components/TerminalStoppedState.vue";
import TerminalToolbar from "../../ui/components/TerminalToolbar.vue";
import TerminalPage from "../../ui/pages/TerminalPage.vue";
import type { TerminalPageProps, TerminalResponse } from "../../ui/terminal/types.js";

const PROPS: TerminalPageProps = {
  app: {
    id: "p:alpha",
    projectId: "p",
    projectName: "Project",
    appKey: "alpha",
    href: "/projects/p/apps/alpha",
    folder: "/workspace/p/apps/alpha",
  },
  links: {
    app: "/projects/p/apps/alpha",
    chat: "/chat?app=alpha&project=p",
    ide: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Falpha",
  },
  runtime: {
    state: "running",
    wsPath: "/api/apps/alpha/terminal?project=p",
    runtimeUrl: "/api/apps/alpha/runtime?project=p",
  },
  deleting: false,
  breadcrumb: [
    { label: "Projects", href: "/projects" },
    { label: "Project", href: "/projects/p" },
    { label: "alpha", href: "/projects/p/apps/alpha" },
    { label: "Terminal" },
  ],
  title: "alpha terminal",
  topbar: { ideHref: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Falpha" },
};

function boot(): BootPayload {
  return {
    route: { id: "terminal", params: {} },
    props: PROPS,
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "alpha terminal",
      active: "project",
      pendingCount: 0,
      sshPendingCount: 0,
    },
    spaRoutes: ["terminal"],
    topbar: PROPS.topbar,
  };
}

beforeEach(() => {
  document.body.innerHTML =
    '<meta name="viewport" content="width=device-width, initial-scale=1" /><main id="main" class="page" tabindex="-1"></main>';
  const response: TerminalResponse = {
    ...PROPS,
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "alpha terminal",
      active: "project",
      pendingCount: 0,
      sshPendingCount: 0,
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(response),
      json: async () => response,
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function page() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/terminal",
        name: "terminal",
        component: TerminalPage,
        meta: { workspace: "terminal", legacyRetired: false },
      },
    ],
  });
  await router.push("/terminal?app=alpha&project=p");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(TerminalPage, {
    props: { boot: boot() },
    attachTo: document.getElementById("main") ?? document.body,
    global: {
      plugins: [createPinia(), [VueQueryPlugin, { queryClient }], router],
    },
  });
}

describe("TerminalPage", () => {
  it("renders the runtime terminal body without a page header", async () => {
    const wrapper = await page();
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".page__body--terminal").exists()).toBe(true);
    expect(wrapper.findAll(".page__body")).toHaveLength(1);
    expect(wrapper.find(".page-header").exists()).toBe(false);
    expect(wrapper.find("#terminal").exists()).toBe(true);
    expect(wrapper.find("#terminal-title").text()).toBe("alpha / Operator terminal");
    expect(wrapper.find(".terminal-toolbar__status").text()).toContain("Connecting");
    expect(wrapper.find("#terminal-banner").attributes("hidden")).toBeDefined();
    expect(wrapper.find("#terminal-copy").attributes("disabled")).toBeDefined();
    expect(wrapper.find("#terminal-reconnect").exists()).toBe(true);
    expect(wrapper.find("#terminal-close").exists()).toBe(true);
    expect(wrapper.find("#terminal-host").exists()).toBe(true);
    expect(wrapper.find("#terminal-announcer").attributes("aria-live")).toBe("polite");
    expect(document.getElementById("main")?.classList.contains("page--terminal")).toBe(true);
    wrapper.unmount();
    expect(document.getElementById("main")?.classList.contains("page--terminal")).toBe(false);
  });

  it("renders the stopped state with a chat link and reconnect action", async () => {
    const wrapper = mount(TerminalStoppedState, {
      props: { chatHref: "/chat?app=alpha&project=p" },
    });
    expect(wrapper.find(".empty-state__title").text()).toBe("Agent is not running");
    expect(wrapper.find("[data-terminal-chat]").attributes("href")).toBe(
      "/chat?app=alpha&project=p",
    );
    await wrapper.find("[data-terminal-retry]").trigger("click");
    expect(wrapper.emitted("reconnect")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows the runtime pill and terminal status vocabulary in the toolbar", async () => {
    const wrapper = mount(TerminalToolbar, {
      props: {
        title: "alpha / Operator terminal",
        runtime: "running",
        status: "reconnecting",
        detail: "in 4s",
        copyEnabled: false,
      },
    });
    expect(wrapper.find(".terminal-toolbar__meta").text()).toContain("Running");
    expect(wrapper.find(".terminal-toolbar__status").text()).toContain("Reconnecting");
    expect(wrapper.find(".terminal-toolbar__status").text()).toContain("in 4s");
    expect(wrapper.find("#terminal-copy").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
