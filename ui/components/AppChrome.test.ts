import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { BootPayload, ChromeData } from "../boot.js";
import { useChromeStore } from "../stores/chrome.js";
import AppSidebar from "./AppSidebar.vue";
import BreadcrumbBar from "./BreadcrumbBar.vue";

const CHROME: ChromeData = {
  title: "Alpha",
  active: "project",
  activeProjectId: "p/one",
  breadcrumb: [
    { label: "Projects", href: "/projects" },
    { label: "Alpha", href: "/projects/p%2Fone" },
    { label: "Application" },
    { label: "Settings" },
  ],
  projects: [
    { id: "p/one", name: "Alpha", appCount: 2 },
    { id: "p-two", name: "Beta", appCount: 1 },
  ],
  masterHref: "/chat?app=master&project=hanse-master",
  pendingCount: 3,
  sshPendingCount: 1,
  settingsHref: "/projects/p%2Fone/settings",
  skillsHref: "/projects/p%2Fone/skills",
};

function boot(): BootPayload {
  return {
    route: { id: "project", params: { id: "p/one" } },
    props: {},
    chrome: CHROME,
    routeKey: JSON.stringify(["project", [["id", "p/one"]], []]),
    operator: { name: "alice", initials: "AL" },
    spaRoutes: ["project"],
    topbar: { ideHref: "/ide/" },
  };
}

function router() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/projects", component: { template: "<div />" } },
      { path: "/projects/:id", component: { template: "<div />" } },
      { path: "/settings", component: { template: "<div />" } },
      { path: "/skills", component: { template: "<div />" } },
      { path: "/ssh", component: { template: "<div />" } },
      { path: "/handoffs", component: { template: "<div />" } },
      { path: "/chat", component: { template: "<div />" } },
    ],
  });
}

function setupPinia(): ReturnType<typeof createPinia> {
  const pinia = createPinia();
  setActivePinia(pinia);
  useChromeStore(pinia).initialize(boot());
  return pinia;
}

beforeEach(() => {
  document.documentElement.dataset.theme = "dark";
  document.body.innerHTML =
    '<aside id="sidebar"></aside><nav id="breadcrumb-host" data-nav-id="none"></nav>';
});

afterEach(() => {
  document.body.innerHTML = "";
  delete document.documentElement.dataset.theme;
});

describe("AppSidebar", () => {
  it("renders navigation, counters, scoped hrefs, and the active project from ChromeData", async () => {
    const pinia = setupPinia();
    const wrapper = mount(AppSidebar, {
      global: { plugins: [pinia, router()] },
    });
    await wrapper.vm.$nextTick();

    const nav = document.getElementById("sidebar-nav");
    expect(nav?.dataset.navId).toBe("project");
    expect(nav?.dataset.projectId).toBe("p/one");
    expect(nav?.querySelector("[data-nav-id='handoffs'] .nav-item__count")?.textContent).toBe("3");
    expect(nav?.querySelector("[data-nav-id='ssh'] .nav-item__count")?.textContent).toBe("1");
    expect(nav?.querySelector("[data-nav-id='settings']")?.getAttribute("href")).toBe(
      "/projects/p%2Fone/settings",
    );
    expect(nav?.querySelector("[data-nav-id='skills']")?.getAttribute("href")).toBe(
      "/projects/p%2Fone/skills",
    );

    const projectLink = nav?.querySelector("[data-project-id='p/one']");
    expect(projectLink?.getAttribute("href")).toBe("/projects/p%2Fone");
    expect(projectLink?.getAttribute("aria-current")).toBe("page");
    expect(projectLink?.classList.contains("is-active")).toBe(true);
    expect(nav?.querySelector("[data-project-id='p-two']")?.getAttribute("href")).toBe(
      "/projects/p-two",
    );

    expect(document.querySelector("#sidebar .sidebar__operator")?.textContent).toBe("alice");
    expect(document.querySelector("#sidebar .avatar")?.textContent).toBe("AL");
    expect(document.querySelector("#sidebar form[action='/logout']")).not.toBeNull();
    expect(document.querySelector("#sidebar .theme-toggle")?.getAttribute("aria-label")).toBe(
      "Switch to light theme",
    );
    wrapper.unmount();
  });

  it("falls back to global settings and skills hrefs and marks no project active", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useChromeStore(pinia).initialize({
      ...boot(),
      chrome: {
        ...CHROME,
        active: "settings",
        activeProjectId: undefined,
        settingsHref: undefined,
        skillsHref: undefined,
      },
    });
    const wrapper = mount(AppSidebar, { global: { plugins: [pinia, router()] } });
    await wrapper.vm.$nextTick();

    const nav = document.getElementById("sidebar-nav");
    expect(nav?.querySelector("[data-nav-id='settings']")?.getAttribute("href")).toBe("/settings");
    expect(nav?.querySelector("[data-nav-id='skills']")?.getAttribute("href")).toBe("/skills");
    expect(nav?.querySelector("[data-nav-id='settings']")?.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(nav?.querySelector("[data-project-id][aria-current='page']")).toBeNull();
    wrapper.unmount();
  });
});

describe("BreadcrumbBar", () => {
  it("teleports crumbs, links internal hrefs, and updates only the breadcrumb nav id", async () => {
    const pinia = setupPinia();
    const wrapper = mount(BreadcrumbBar, { global: { plugins: [pinia, router()] } });
    await wrapper.vm.$nextTick();

    const host = document.getElementById("breadcrumb-host");
    expect(host?.dataset.navId).toBe("project");
    expect(host?.querySelector("a[href='/projects']")?.textContent).toBe("Projects");
    expect(host?.querySelector("a[href='/projects/p%2Fone']")?.textContent).toBe("Alpha");
    expect(host?.querySelector("[aria-current='page']")?.textContent).toBe("Settings");
    expect(host?.querySelectorAll("svg").length).toBe(2);
    expect(document.getElementById("shell")).toBeNull();
    wrapper.unmount();
  });
});
