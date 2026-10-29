import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { ApiError } from "../api.js";
import type { BootPayload } from "../boot.js";
import type { HandoffFilter, HandoffRow, HandoffsProps } from "../handoff-types.js";
import type { ProjectHandoff } from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import HandoffsPage from "./HandoffsPage.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

function dialog(overrides: Partial<ProjectHandoff> = {}): ProjectHandoff {
  return {
    id: "handoff-1234567890",
    fromAppId: "project-one:alpha",
    toAppId: "project-one:beta",
    fromAppKey: "alpha",
    toAppKey: "beta",
    summary: "Ship the handoff",
    state: "awaiting_approval",
    replyState: "none",
    displayState: "awaiting_approval",
    updatedAt: "2026-10-28T01:00:00.000Z",
    reviewHref: "/handoffs?filter=waiting",
    spec: "# Spec\n\nA **bold** requirement.",
    attempts: 1,
    error: null,
    result: null,
    outcome: null,
    createdAt: "2026-10-28T00:00:00.000Z",
    approvalKind: "dispatch",
    policyDispatchMode: "approve",
    policyReplyMode: "auto",
    origin: "agent",
    sourceSessionId: "ses_source",
    sourceSessionHref: "/chat?app=alpha&project=project-one&session=ses_source",
    sourceSessionDeleted: false,
    targetSessionId: null,
    targetSessionHref: null,
    replyError: null,
    replyDeliveredSessionId: null,
    replyDeliveredAt: null,
    replyDeliveredHref: null,
    deliveredVia: null,
    operatorNote: null,
    canCancel: true,
    canRelaunch: false,
    canRetryReply: false,
    canCancelReply: false,
    returnTo: "/handoffs",
    ...overrides,
  };
}

function row(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    id: "handoff-1234567890",
    shortId: "handoff-",
    fromAppId: "project-one:alpha",
    toAppId: "project-one:beta",
    fromAppKey: "alpha",
    toAppKey: "beta",
    summary: "Ship the handoff",
    state: "awaiting_approval",
    replyState: "none",
    displayState: "awaiting_approval",
    updatedAt: "2026-10-28T01:00:00.000Z",
    inlineDecision: {
      action: "/api/handoffs/handoff-1234567890/decision",
      approvalKind: "dispatch",
      returnTo: "/handoffs",
    },
    dialog: dialog(),
    ...overrides,
  };
}

const AWAITING = row();
const QUEUED = row({
  id: "handoff-queued",
  shortId: "handoff-",
  summary: "Queued handoff",
  state: "queued",
  displayState: "queued",
  inlineDecision: null,
  dialog: dialog({
    id: "handoff-queued",
    summary: "Queued handoff",
    state: "queued",
    displayState: "queued",
    approvalKind: null,
    spec: "Queued specification.",
  }),
});
const REPLY = row({
  id: "handoff-reply",
  shortId: "handoff-",
  summary: "Reply waiting",
  state: "delivered",
  replyState: "waiting_operator",
  displayState: "delivered",
  inlineDecision: null,
  dialog: dialog({
    id: "handoff-reply",
    summary: "Reply waiting",
    state: "delivered",
    replyState: "waiting_operator",
    displayState: "delivered",
    approvalKind: null,
    result: "**Reply** result.",
    canRelaunch: true,
    canRetryReply: true,
    canCancelReply: true,
  }),
});

const FILTER_LABELS: ReadonlyArray<{ value: HandoffFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting" },
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
  { value: "replies", label: "Replies" },
];

function propsFor(
  filter: HandoffFilter = "all",
  query = "",
  rows: readonly HandoffRow[] = [AWAITING, QUEUED, REPLY],
  emptyState: HandoffsProps["emptyState"] = null,
): HandoffsProps {
  return {
    counts: { all: 3, waiting: 1, active: 1, closed: 1, replies: 1 },
    filter,
    query,
    filters: FILTER_LABELS.map(({ value, label }) => ({
      value,
      label,
      href:
        value === "all"
          ? `/handoffs${query.length > 0 ? `?q=${encodeURIComponent(query)}` : ""}`
          : `/handoffs?filter=${value}${query.length > 0 ? `&q=${encodeURIComponent(query)}` : ""}`,
      count: value === "all" ? 3 : 1,
      current: value === filter,
    })),
    search: {
      action: "/handoffs",
      filter,
      query,
      hiddenFilter: filter === "all" ? null : filter,
      placeholder: "Id, summary, application",
      clearHref:
        query.length > 0 ? (filter === "all" ? "/handoffs" : `/handoffs?filter=${filter}`) : null,
    },
    returnTo: filter === "all" ? "/handoffs" : `/handoffs?filter=${filter}`,
    tableTitle: filter === "waiting" ? "Waiting for approval" : "All handoffs",
    rows,
    emptyState,
  };
}

const EMPTY_STATE: HandoffsProps["emptyState"] = {
  iconName: "branch",
  title: "No handoffs yet",
  body: "Handoffs route work between applications. Open a project to create the first one.",
  actionLabel: "Open a project",
  actionHref: "/projects",
};

function boot(payload: HandoffsProps | null, routeId = "handoffs"): BootPayload {
  return {
    route: { id: routeId as BootPayload["route"]["id"], params: {} },
    props: payload,
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "Handoffs",
      active: "handoffs",
      pendingCount: 1,
      sshPendingCount: 0,
    },
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

async function mountPage(
  payload: BootPayload,
  path = "/handoffs",
  router = testRouter(),
): Promise<VueWrapper> {
  await router.push(path);
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return mount(HandoffsPage, {
    props: { boot: payload },
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
}

function toasts() {
  return useToastStore().toasts;
}

describe("HandoffsPage", () => {
  beforeEach(() => {
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
  });

  it("renders the boot header, counts, filters, table, states, and time tags", async () => {
    const wrapper = await mountPage(boot(propsFor()));

    expect(wrapper.get("h1").text()).toBe("Handoffs");
    expect(wrapper.text()).toContain("Workbench");
    expect(wrapper.text()).toContain("3 total");
    expect(wrapper.text()).toContain("1 waiting");
    expect(wrapper.text()).toContain("1 active");
    expect(wrapper.text()).toContain("1 replies waiting");

    const filters = wrapper.findAll(".segmented__item");
    expect(filters.map((entry) => entry.text())).toEqual([
      "All 3",
      "Waiting 1",
      "Active 1",
      "Closed 1",
      "Replies 1",
    ]);
    expect(filters[0]?.attributes("aria-current")).toBe("page");
    expect(filters[1]?.attributes("aria-current")).toBeUndefined();

    expect(wrapper.get("#handoffs-table-title").text()).toBe("All handoffs");
    expect(wrapper.findAll("tbody tr")).toHaveLength(3);
    expect(wrapper.text()).toContain("Ship the handoff");
    expect(wrapper.text()).toContain("Awaiting approval");
    expect(wrapper.text()).toContain("Queued handoff");
    expect(wrapper.text()).toContain("Reply waiting");
    expect(wrapper.text()).toContain("Reply waiting");
    expect(wrapper.findAll("time")).toHaveLength(3);
    expect(wrapper.find("style").exists()).toBe(false);
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("navigates filter links and fetches the new filter", async () => {
    const router = testRouter();
    const wrapper = await mountPage(boot(propsFor()), "/handoffs", router);
    mocks.apiQuery.mockResolvedValue({ ...propsFor("waiting", "", [AWAITING]) });

    await wrapper.findAll(".segmented__item")[1]?.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe("/handoffs?filter=waiting");
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/handoffs?filter=waiting&q=");
    await flushPromises();
    expect(wrapper.get("#handoffs-table-title").text()).toBe("Waiting for approval");
  });

  it("submits and clears the search with the active filter preserved", async () => {
    const router = testRouter();
    const wrapper = await mountPage(
      boot(propsFor("waiting", "", [AWAITING])),
      "/handoffs?filter=waiting",
      router,
    );
    expect(wrapper.get<HTMLInputElement>("#handoff-search").element.value).toBe("");
    expect(wrapper.find('input[name="filter"]').attributes("value")).toBe("waiting");

    mocks.apiQuery.mockResolvedValue({ ...propsFor("waiting", "ship") });
    await wrapper.get("#handoff-search").setValue("  ship  ");
    await wrapper.get("form[role='search']").trigger("submit");
    await flushPromises();

    expect(router.currentRoute.value.fullPath).toBe("/handoffs?filter=waiting&q=ship");
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/handoffs?filter=waiting&q=ship");
    expect(wrapper.get<HTMLInputElement>("#handoff-search").element.value).toBe("ship");
  });

  it("approves inline with the decision contract, disables actions while pending, and refreshes", async () => {
    const wrapper = await mountPage(boot(propsFor()));
    let resolveMutation: ((value: unknown) => void) | undefined;
    mocks.apiMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    mocks.apiQuery.mockResolvedValue({ ...propsFor() });

    const awaitingRow = wrapper.get("#handoff-handoff-1234567890");
    await awaitingRow.get("button.btn-primary").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/handoffs/handoff-1234567890/decision", {
      form: {
        decision: "approved",
        approval_kind: "dispatch",
        return_to: "/handoffs",
      },
    });
    expect(awaitingRow.get("button.btn-primary").attributes("disabled")).toBeDefined();
    expect(awaitingRow.get("button.btn-danger").attributes("disabled")).toBeDefined();

    resolveMutation?.({ ok: true, decision: "approved" });
    await flushPromises();
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/handoffs?filter=all&q=");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Handoff approved.", tone: "success" }),
    );
  });

  it("rejects inline and raises a typed error toast on failure", async () => {
    const wrapper = await mountPage(boot(propsFor()));
    mocks.apiMutation.mockRejectedValue(new ApiError("No pending approval for this handoff.", 409));

    const awaitingRow = wrapper.get("#handoff-handoff-1234567890");
    await awaitingRow.get("button.btn-danger").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/handoffs/handoff-1234567890/decision", {
      form: {
        decision: "rejected",
        approval_kind: "dispatch",
        return_to: "/handoffs",
      },
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "No pending approval for this handoff.", tone: "error" }),
    );
  });

  it("opens the shared review dialog with safe Markdown and records a decision", async () => {
    const wrapper = await mountPage(boot(propsFor()));
    mocks.apiMutation.mockResolvedValue({ ok: true, decision: "approved" });
    mocks.apiQuery.mockResolvedValue({ ...propsFor() });

    await wrapper.get("#handoff-handoff-1234567890").get("button.btn-ghost").trigger("click");
    await flushPromises();

    const dialogElement = wrapper.get("dialog.handoff-dialog");
    expect(dialogElement.attributes("open")).toBeDefined();
    expect(dialogElement.get(".prose.handoff-md").find("h3").text()).toBe("Spec");
    expect(dialogElement.get(".prose.handoff-md").find("strong").text()).toBe("bold");

    await dialogElement.get("button.btn-primary").trigger("click");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/handoffs/handoff-1234567890/decision", {
      form: {
        decision: "approved",
        approval_kind: "dispatch",
        reason: "",
        return_to: "/handoffs",
      },
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Handoff approved.", tone: "success" }),
    );
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/handoffs?filter=all&q=");
  });

  it("renders the empty state as a project SmartLink", async () => {
    const router = testRouter();
    const wrapper = await mountPage(
      boot(propsFor("all", "", [], EMPTY_STATE)),
      "/handoffs",
      router,
    );

    expect(wrapper.text()).toContain("No handoffs yet");
    const action = wrapper.get(".empty-state a");
    expect(action.text()).toBe("Open a project");
    expect(action.attributes("href")).toBe("/projects");

    await action.trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/projects");
  });

  it("shows loading when boot props belong to another route", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mocks.apiQuery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = await mountPage(boot(propsFor(), "overview"));

    expect(wrapper.text()).toContain("Loading handoffs…");
    expect(wrapper.text()).not.toContain("Ship the handoff");

    resolve?.({ ...propsFor() });
    await flushPromises();
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/handoffs?filter=all&q=");
    expect(wrapper.get("h1").text()).toBe("Handoffs");
    expect(wrapper.text()).toContain("Ship the handoff");
  });

  it("renders a 404 with retry and the legacy escape hatch", async () => {
    mocks.apiQuery.mockRejectedValue(new ApiError("not found", 404));
    const wrapper = await mountPage(boot(null, "overview"));

    await flushPromises();
    expect(wrapper.text()).toContain("Handoffs not found");
    expect(wrapper.text()).toContain("not found");
    expect(wrapper.get("a[href='?legacy=1']").text()).toBe("Use the classic interface");
    expect(wrapper.get("#handoffs-error-title").text()).toBe("Handoffs not found");
  });

  it("shows a generic error and recovers through Retry", async () => {
    mocks.apiQuery.mockRejectedValueOnce(new ApiError("Inbox is unavailable.", 500));
    const wrapper = await mountPage(boot(null, "overview"));
    await flushPromises();

    expect(wrapper.text()).toContain("Handoffs could not be loaded");
    expect(wrapper.text()).toContain("Inbox is unavailable.");

    mocks.apiQuery.mockResolvedValue({ ...propsFor() });
    await wrapper
      .get("section[aria-labelledby='handoffs-error-title'] .card__body button")
      .trigger("click");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("Ship the handoff");
    expect(wrapper.find("#handoffs-error-title").exists()).toBe(false);
  });
});
