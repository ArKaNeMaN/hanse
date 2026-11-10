import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { BootPayload } from "../boot.js";
import OverviewPage from "./OverviewPage.vue";

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

const PROJECT_ONE = {
  id: "project-one",
  name: "Project One",
  rootPath: "/workspace/project-one",
  appCount: 2,
  waitingCount: 1,
  lastActivity: "2026-10-28T00:00:00.000Z",
  deleting: false,
};

const PROJECT_TWO = {
  id: "project-two",
  name: "Project Two",
  rootPath: "/workspace/project-two",
  appCount: 1,
  waitingCount: 0,
  lastActivity: "2026-10-27T00:00:00.000Z",
  deleting: true,
};

const HANDOFF = {
  id: "handoff-1234567890",
  fromAppId: "project-one:alpha",
  toAppId: "project-one:beta",
  fromAppKey: "alpha",
  toAppKey: "beta",
  summary: "Ship the handoff",
  state: "awaiting_approval" as const,
  replyState: "none" as const,
  updatedAt: "2026-10-28T01:00:00.000Z",
  reviewHref: "/handoffs?filter=waiting",
};

const COUNTS = {
  projects: 2,
  applications: 3,
  running: 1,
  starting: 0,
  stopped: 2,
  error: 0,
  handoffsWaiting: 1,
  handoffsTotal: 1,
};

function processRow(
  appKey: string,
  state: "starting" | "stopping" | "error",
  phase: string,
  updatedAt: string,
) {
  return {
    appId: `${PROJECT_ONE.id}:${appKey}`,
    appKey,
    projectId: PROJECT_ONE.id,
    projectName: "Project One",
    state,
    phase,
    updatedAt,
    chatHref: `/chat?app=${appKey}&project=${PROJECT_ONE.id}`,
    appHref: `/projects/${PROJECT_ONE.id}/apps/${appKey}`,
  };
}

const PROCESSES: {
  starting: number;
  stopping: number;
  error: number;
  apps: readonly ReturnType<typeof processRow>[];
} = {
  starting: 0,
  stopping: 0,
  error: 0,
  apps: [],
};

const PROPS = {
  counts: COUNTS,
  processes: PROCESSES,
  projects: [PROJECT_ONE, PROJECT_TWO],
  recentHandoffs: [HANDOFF],
  waitingHandoffs: [{ ...HANDOFF, displayState: "awaiting_approval" as const }],
};

function boot(overrides: Partial<typeof PROPS> = {}, routeId = "overview"): BootPayload {
  return {
    route: { id: routeId as BootPayload["route"]["id"], params: {} },
    props: { ...PROPS, ...overrides },
    topbar: { ideHref: "/ide/" },
    chrome: {
      title: "Fleet overview",
      active: "overview",
      breadcrumb: [],
      projects: [],
      masterHref: "/chat?app=master&project=hanse-master",
      pendingCount: 1,
      sshPendingCount: 0,
    },
    routeKey: JSON.stringify(["overview", [], []]),
  };
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/projects", component: { template: "<div />" } },
      { path: "/projects/:id", component: { template: "<div />" } },
      { path: "/handoffs", component: { template: "<div />" } },
    ],
  });
}

async function mountPage(payload: BootPayload, router = testRouter()): Promise<VueWrapper> {
  await router.push("/");
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return mount(OverviewPage, {
    props: { boot: payload },
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
}

describe("OverviewPage", () => {
  beforeEach(() => {
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
    mocks.navigate.mockReset();
  });

  it("renders the header, watch strip, ledger, handoffs, waiting cards, and runtime from boot", async () => {
    const wrapper = await mountPage(boot());

    expect(wrapper.get("h1").text()).toBe("Fleet overview");
    expect(wrapper.text()).toContain("Workbench");
    expect(wrapper.text()).toContain("2 projects");
    expect(wrapper.text()).toContain("3 applications");

    const values = wrapper.findAll(".watch__value").map((entry) => entry.text());
    expect(values).toEqual(["2", "3", "1", "1"]);
    expect(wrapper.findAll(".watch__label").map((entry) => entry.text())).toEqual([
      "Projects",
      "Applications",
      "Agents running",
      "Handoffs waiting",
    ]);

    expect(wrapper.get("#project-ledger-title").text()).toBe("Project ledger");
    expect(wrapper.text()).toContain("/workspace/project-one");
    expect(wrapper.text()).toContain("Deletion incomplete");
    expect(wrapper.findAll("tbody tr")).toHaveLength(3);

    expect(wrapper.get("#recent-handoffs-title").text()).toBe("Recent handoffs");
    expect(wrapper.text()).toContain("Ship the handoff");
    expect(wrapper.findAll(".table__route")).toHaveLength(1);

    expect(wrapper.get("#waiting-title").text()).toBe("Waiting for approval");
    expect(wrapper.findAll(".route-card")).toHaveLength(1);
    expect(wrapper.get(".route-card").attributes("data-state")).toBe("awaiting_approval");

    expect(wrapper.get("#runtime-title").text()).toBe("Runtime");
    const runtime = wrapper.findAll(".summary-row").map((row) => ({
      label: row.get(".small").text(),
      count: row.get(".mono").text(),
    }));
    expect(runtime).toEqual([
      { label: "Starting", count: "0" },
      { label: "Running", count: "1" },
      { label: "Stopped", count: "2" },
      { label: "Error", count: "0" },
    ]);

    expect(wrapper.find("style").exists()).toBe(false);
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("hides the agent processes block when no application is affected", async () => {
    const wrapper = await mountPage(boot());

    expect(wrapper.find("#agent-processes").exists()).toBe(false);
    expect(wrapper.find("#agent-process-list").exists()).toBe(false);
  });

  it("renders process counts and affected apps newest first, capped at five, master excluded", async () => {
    const master = {
      ...processRow("master", "error", "failed", "2026-10-28T06:00:00.000Z"),
      appId: "hanse-master:master",
      projectId: "hanse-master",
      projectName: "Hanse master",
      chatHref: "/chat?app=master&project=hanse-master",
      appHref: "/projects/hanse-master/apps/master",
    };
    const apps = [
      master,
      processRow("alpha", "error", "failed", "2026-10-28T05:00:00.000Z"),
      processRow("beta", "starting", "waiting_ready", "2026-10-28T04:00:00.000Z"),
      processRow("gamma", "stopping", "stopping", "2026-10-28T03:00:00.000Z"),
      processRow("delta", "error", "failed", "2026-10-28T02:00:00.000Z"),
      processRow("epsilon", "starting", "requested", "2026-10-28T01:00:00.000Z"),
      processRow("zeta", "error", "failed", "2026-10-28T00:00:00.000Z"),
    ];
    const wrapper = await mountPage(
      boot({
        processes: {
          starting: 2,
          stopping: 1,
          error: 3,
          apps,
        },
      }),
    );

    const block = wrapper.get("#agent-processes");
    expect(block.get("#agent-processes-title").text()).toBe("Agent processes");
    expect(block.get("#process-count-starting").text()).toBe("2");
    expect(block.get("#process-count-stopping").text()).toBe("1");
    expect(block.get("#process-count-error").text()).toBe("3");

    const rows = wrapper.findAll("[data-process-app]");
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.text())).toEqual([
      expect.stringContaining("alpha"),
      expect.stringContaining("beta"),
      expect.stringContaining("gamma"),
      expect.stringContaining("delta"),
      expect.stringContaining("epsilon"),
    ]);
    expect(block.text()).not.toContain("zeta");
    expect(block.text()).not.toContain("master");
    expect(rows.at(1)?.text()).toContain("Waiting for readiness");
    expect(rows.at(2)?.text()).toContain("Stopping");

    const firstRow = rows.at(0);
    const firstChat = firstRow?.findAll("a").find((link) => link.text() === "Chat");
    const firstApp = firstRow?.findAll("a").find((link) => link.text() === "Application");
    expect(firstChat?.attributes("href")).toBe(`/chat?app=alpha&project=${PROJECT_ONE.id}`);
    expect(firstApp?.attributes("href")).toBe(`/projects/${PROJECT_ONE.id}/apps/alpha`);
  });

  it("renders the empty state with a dialog and no header action", async () => {
    const wrapper = await mountPage(
      boot({
        counts: {
          ...COUNTS,
          projects: 0,
          applications: 0,
          running: 0,
          stopped: 0,
          handoffsWaiting: 0,
        },
        processes: PROCESSES,
        projects: [],
        recentHandoffs: [],
        waitingHandoffs: [],
      }),
    );

    expect(wrapper.text()).toContain("No projects yet");
    expect(wrapper.text()).toContain("The manifest is the source of truth");
    expect(wrapper.find(".watch-strip").exists()).toBe(false);
    expect(wrapper.find(".page-header__actions").exists()).toBe(false);
    expect(wrapper.find("#new-project").exists()).toBe(true);
  });

  it("creates a project from the shared dialog and full-loads the legacy detail", async () => {
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
  });

  it("fetches current props when the document boot belongs to another route", async () => {
    mocks.apiQuery.mockResolvedValue(PROPS);
    const wrapper = await mountPage(boot({}, "projects"));

    expect(wrapper.text()).toContain("Loading overview…");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/overview");
    expect(wrapper.get("h1").text()).toBe("Fleet overview");
    expect(wrapper.findAll(".watch__value").map((entry) => entry.text())).toEqual([
      "2",
      "3",
      "1",
      "1",
    ]);
  });

  it("keeps project-detail links as legacy anchors (boundary)", async () => {
    const wrapper = await mountPage(boot());
    const link = wrapper.get("a.table__primary");

    expect(link.attributes("href")).toBe("/projects/project-one");
  });
});
