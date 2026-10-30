import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { BootPayload } from "../boot.js";
import { useToastStore } from "../stores/toasts.js";
import ProjectsPage from "./ProjectsPage.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

vi.mock("../navigation.js", () => ({ fullDocumentNavigate: mocks.navigate }));

interface Row {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly appCount: number;
  readonly waitingCount: number;
  readonly updatedAt: string;
  readonly deleting: boolean;
}

const ROW_ONE: Row = {
  id: "project-one",
  name: "Project One",
  rootPath: "/workspace/project-one",
  appCount: 2,
  waitingCount: 0,
  updatedAt: "2026-10-28T00:00:00.000Z",
  deleting: false,
};

const ROW_TWO: Row = {
  id: "project-two",
  name: "Project Two",
  rootPath: "/workspace/project-two",
  appCount: 1,
  waitingCount: 3,
  updatedAt: "2026-10-27T00:00:00.000Z",
  deleting: true,
};

function boot(
  overrides: Partial<{
    query: string;
    rows: readonly Row[];
    projectCount: number;
    appCount: number;
    matchedCount: number;
  }> = {},
): BootPayload {
  return {
    route: { id: "projects", params: {} },
    props: {
      query: "",
      rows: [ROW_ONE, ROW_TWO],
      projectCount: 2,
      appCount: 3,
      matchedCount: 2,
      ...overrides,
    },
    spaRoutes: ["projects"],
    topbar: { ideHref: "/ide/" },
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "Projects",
      active: "projects",
      pendingCount: 0,
      sshPendingCount: 0,
    },
  };
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/projects", component: { template: "<div />" } },
      { path: "/projects/:id", component: { template: "<div />" } },
    ],
  });
}

async function mountPage(payload: BootPayload, router = testRouter()): Promise<VueWrapper> {
  const query = payload.props as { query?: string };
  const q = typeof query.query === "string" && query.query.length > 0 ? { q: query.query } : {};
  await router.push({ path: "/projects", query: q });
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return mount(ProjectsPage, {
    props: { boot: payload },
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
    mocks.navigate.mockReset();
  });

  it("renders the legacy header, counts, six-column ledger, and boot rows immediately", async () => {
    const wrapper = await mountPage(boot());

    expect(wrapper.get("h1").text()).toBe("Projects");
    expect(wrapper.text()).toContain("Workbench");
    expect(wrapper.text()).toContain("2 projects");
    expect(wrapper.text()).toContain("3 applications");
    expect(wrapper.findAll("thead th")).toHaveLength(6);
    expect(wrapper.text()).toContain("Project One");
    expect(wrapper.text()).toContain("/workspace/project-one");
    expect(wrapper.get("a.table__primary").attributes("href")).toBe("/projects/project-one");
    expect(wrapper.text()).toContain("Deletion incomplete");
    expect(wrapper.find("time").attributes("datetime")).toBe(ROW_ONE.updatedAt);
    expect(wrapper.find("style").exists()).toBe(false);
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("shows the ledger without a search toolbar when there are no matches", async () => {
    const wrapper = await mountPage(boot({ query: "zzz", rows: [], matchedCount: 0 }));

    expect(wrapper.text()).toContain("No matching projects");
    expect(wrapper.text()).toContain("Nothing matches “zzz”");
    expect(wrapper.find("#project-search").exists()).toBe(false);
    expect(wrapper.get("a.btn-secondary").attributes("href")).toBe("/projects");
  });

  it("renders the no-projects empty state and keeps the new-project action out of the header", async () => {
    const wrapper = await mountPage(
      boot({ rows: [], projectCount: 0, appCount: 0, matchedCount: 0 }),
    );

    expect(wrapper.text()).toContain("No projects yet");
    expect(wrapper.find(".page-header__actions").exists()).toBe(false);
    expect(wrapper.find("#projects-table-title").exists()).toBe(false);
    expect(wrapper.find("#new-project").exists()).toBe(true);
  });

  it("pushes the query on search and refetches for the new key", async () => {
    mocks.apiQuery.mockResolvedValue({
      query: "Two",
      rows: [ROW_TWO],
      projectCount: 2,
      appCount: 3,
      matchedCount: 1,
    });
    const router = testRouter();
    const wrapper = await mountPage(boot(), router);

    await wrapper.get("#project-search").setValue("Two");
    await wrapper.get("form.toolbar").trigger("submit");
    await flushPromises();
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe("/projects?q=Two");
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/projects?q=Two");
    expect(wrapper.text()).toContain("Project Two");
    expect(wrapper.text()).not.toContain("Project One");
  });

  it("shows a non-blocking loading indicator during a refetch", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mocks.apiQuery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = await mountPage(boot());

    await wrapper.get("#project-search").setValue("Two");
    await wrapper.get("form.toolbar").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("Updating projects…");

    resolve?.({
      query: "Two",
      rows: [ROW_TWO],
      projectCount: 2,
      appCount: 3,
      matchedCount: 1,
    });
    await flushPromises();
    await flushPromises();
    expect(wrapper.text()).not.toContain("Updating projects…");
  });

  it("renders an inline error state with retry and a legacy link on fetch failure", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiQuery.mockRejectedValue(new ApiError("Projects are unavailable.", 500));
    const wrapper = await mountPage(boot());

    await wrapper.get("#project-search").setValue("Two");
    await wrapper.get("form.toolbar").trigger("submit");
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Projects could not be loaded");
    expect(wrapper.text()).toContain("Projects are unavailable.");
    expect(wrapper.text()).toContain("Retry");
    expect(wrapper.get('a[href="?legacy=1"]').text()).toBe("Use the classic interface");
  });

  it("opens the native dialog, creates a project, and full-loads the legacy detail", async () => {
    mocks.apiMutation.mockResolvedValue({
      ok: true,
      project: { id: "new-project", name: "Northbank" },
    });
    const wrapper = await mountPage(boot());

    await wrapper.get(".page-header__actions button").trigger("click");
    expect(wrapper.get("#new-project").attributes("open")).toBeDefined();

    await wrapper.get("#new-project-name").setValue("Northbank");
    await wrapper.get("#new-project form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects", {
      form: { name: "Northbank" },
    });
    expect(mocks.navigate).toHaveBeenCalledWith(
      "/projects/new-project?notice=Project+created.&tone=success",
    );
    expect(wrapper.get("#new-project").attributes("open")).toBeDefined();
  });

  it("keeps the dialog open and raises an error toast when create fails", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiMutation.mockRejectedValue(
      new ApiError("Project already exists.", 409, "project_exists"),
    );
    const wrapper = await mountPage(boot());

    await wrapper.get(".page-header__actions button").trigger("click");
    await wrapper.get("#new-project-name").setValue("Northbank");
    await wrapper.get("#new-project form").trigger("submit");
    await flushPromises();

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(wrapper.get("#new-project").attributes("open")).toBeDefined();
    expect(useToastStore().toasts.at(-1)).toMatchObject({
      message: "Project already exists.",
      tone: "error",
    });
  });

  it("keeps project-detail links as legacy anchors (boundary)", async () => {
    const wrapper = await mountPage(boot());
    const link = wrapper.get("a.table__primary");

    expect(link.attributes("href")).toBe("/projects/project-one");
    expect(link.attributes("aria-current")).toBeUndefined();
  });
});
