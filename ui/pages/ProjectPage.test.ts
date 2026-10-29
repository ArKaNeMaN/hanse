import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { BootPayload } from "../boot.js";
import type {
  ProjectApp,
  ProjectHandoff,
  ProjectProps,
  ProjectWaitingHandoff,
} from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import ProjectPage from "./ProjectPage.vue";

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

const APP_ONE: ProjectApp = {
  id: "project-one:alpha",
  appKey: "alpha",
  path: "apps/alpha",
  kind: "service",
  runtime: "running",
  pendingRestart: true,
  deleting: false,
  href: "/projects/project-one/apps/alpha",
  chatHref: "/chat?app=alpha&project=project-one",
  settingsHref: "/projects/project-one/apps/alpha/settings",
  skillsHref: "/projects/project-one/apps/alpha/skills",
  restartHref: "/projects/project-one/apps/alpha/settings",
  ideHref: "/ide/?folder=alpha",
};

const APP_TWO: ProjectApp = {
  ...APP_ONE,
  id: "project-one:beta",
  appKey: "beta",
  path: "apps/beta",
  runtime: "stopped",
  pendingRestart: false,
  deleting: true,
  href: "/projects/project-one/apps/beta",
  chatHref: null,
};

const HANDOFF: ProjectHandoff = {
  id: "handoff-1234567890",
  fromAppId: "project-one:alpha",
  toAppId: "project-one:beta",
  fromAppKey: "alpha",
  toAppKey: "beta",
  summary: "Ship the handoff",
  state: "queued",
  replyState: "none",
  displayState: "queued",
  updatedAt: "2026-10-28T01:00:00.000Z",
  reviewHref: "/handoffs?q=handoff",
  spec: "Do the work.",
  attempts: 0,
  error: null,
  result: null,
  outcome: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  approvalKind: null,
  policyDispatchMode: "auto",
  policyReplyMode: "auto",
  origin: "operator",
  sourceSessionId: null,
  sourceSessionHref: null,
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
  returnTo: "/projects/project-one",
};

const WAITING: ProjectWaitingHandoff = {
  id: HANDOFF.id,
  fromAppId: HANDOFF.fromAppId,
  toAppId: HANDOFF.toAppId,
  fromAppKey: HANDOFF.fromAppKey,
  toAppKey: HANDOFF.toAppKey,
  state: "awaiting_approval",
  replyState: "none",
  displayState: "awaiting_approval",
  summary: "Approve me",
  updatedAt: "2026-10-28T02:00:00.000Z",
  reviewHref: "/handoffs?filter=waiting",
};

const PROPS: ProjectProps = {
  project: {
    id: "project-one",
    name: "Project One",
    rootPath: "/workspace/project-one",
    baseBranch: "main",
    deleting: false,
  },
  hrefs: {
    self: "/projects/project-one",
    settings: "/projects/project-one/settings",
    skills: "/projects/project-one/skills",
    ide: "/ide/?folder=project-one",
  },
  counts: { applications: 2, running: 1, waiting: 1, handoffs: 1 },
  lastActivity: "2026-10-28T02:00:00.000Z",
  apps: [APP_ONE, APP_TWO],
  handoffs: [HANDOFF],
  waitingHandoffs: [WAITING],
  policy: {
    rules: [
      {
        id: 1,
        fromAppKey: "alpha",
        toAppKey: "beta",
        dispatchMode: "approve",
        replyMode: "auto",
      },
    ],
    appOptions: ["alpha", "beta"],
    wildcard: "*",
    dispatchModes: ["auto", "approve", "deny"],
    replyModes: ["auto", "approve"],
  },
  deletion: {
    deleting: false,
    projectName: "Project One",
    appCount: 2,
    action: "/api/projects/project-one/delete",
    returnTo: "/projects/project-one",
    confirmName: "Project One",
  },
  dialogs: {
    addApp: {
      action: "/api/projects/project-one/apps",
      projectId: "project-one",
      projectName: "Project One",
      rootPath: "/workspace/project-one",
      returnTo: "/projects/project-one",
    },
    newHandoff: {
      action: "/api/handoffs",
      projectId: "project-one",
      projectName: "Project One",
      appOptions: ["alpha", "beta"],
      fromKey: "alpha",
      toKey: "beta",
      disabled: false,
      returnTo: "/projects/project-one",
    },
    delete: {
      deleting: false,
      projectName: "Project One",
      appCount: 2,
      action: "/api/projects/project-one/delete",
      returnTo: "/projects/project-one",
      confirmName: "Project One",
    },
  },
  master: false,
  masterSummary: null,
};

const MASTER_PROPS: ProjectProps = {
  ...PROPS,
  master: true,
  masterSummary: {
    runtime: "running",
    kind: "master",
    path: "/workspace/master",
    chatHref: "/chat?app=master&project=master",
    settingsHref: "/projects/master/apps/master/settings",
    skillsHref: "/projects/master/apps/master/skills",
  },
};

function boot(payload: ProjectProps | null, routeId = "project", id = "project-one"): BootPayload {
  return {
    route: {
      id: routeId as BootPayload["route"]["id"],
      params: routeId === "project" ? { id } : {},
    },
    props: payload,
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "Project One",
      active: "project",
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

async function mountPage(payload: BootPayload, router = testRouter()): Promise<VueWrapper> {
  await router.push(`/projects/${String(payload.route.params.id ?? "project-one")}`);
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return mount(ProjectPage, {
    props: { boot: payload },
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
}

function dialogOpen(wrapper: VueWrapper, selector: string): boolean {
  return wrapper.find(selector).attributes("open") !== undefined;
}

function toasts() {
  return useToastStore().toasts;
}

describe("ProjectPage", () => {
  beforeEach(() => {
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
    mocks.navigate.mockReset();
  });

  it("renders the normal project header, watch strip, apps, handoffs, waiting, policy, manifest, and danger zone", async () => {
    const wrapper = await mountPage(boot(PROPS));

    expect(wrapper.get("h1").text()).toBe("Project One");
    expect(wrapper.text()).toContain("Project");
    expect(wrapper.text()).toContain("/workspace/project-one");
    expect(wrapper.text()).toContain("base main");

    const values = wrapper.findAll(".watch__value").map((entry) => entry.text());
    expect(values[0]).toBe("2");
    expect(values[1]).toBe("1");
    expect(values[2]).toBe("1");
    expect(values[3] ?? "").not.toBe("");

    expect(wrapper.get("#apps-title").text()).toBe("Applications");
    expect(wrapper.text()).toContain("alpha");
    expect(wrapper.text()).toContain("beta");
    expect(wrapper.text()).toContain("Deletion incomplete");
    expect(wrapper.text()).toContain("Restart required");

    expect(wrapper.get("#project-handoffs-title").text()).toBe("Handoffs");
    expect(wrapper.text()).toContain("Ship the handoff");
    expect(wrapper.text()).toContain("Queued");

    expect(wrapper.get("#project-waiting-title").text()).toBe("Waiting for approval");
    expect(wrapper.findAll(".route-card")).toHaveLength(1);

    expect(wrapper.get("#handoff-policy-title").text()).toBe("Handoff policy");
    expect(wrapper.text()).toContain("1 rules");

    expect(wrapper.get("#manifest-title").text()).toBe("Manifest");
    expect(wrapper.text()).toContain(".hanse/project.yaml");

    expect(wrapper.get("#danger-zone-title").text()).toBe("Danger zone");
    expect(wrapper.text()).toContain("Destructive");

    expect(wrapper.find("style").exists()).toBe(false);
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("renders empty applications and handoffs with their actions", async () => {
    const wrapper = await mountPage(
      boot({
        ...PROPS,
        apps: [],
        handoffs: [],
        waitingHandoffs: [],
        counts: { ...PROPS.counts, applications: 0, running: 0, waiting: 0, handoffs: 0 },
      }),
    );

    expect(wrapper.text()).toContain("No applications");
    expect(wrapper.text()).toContain("No handoffs yet");
    expect(wrapper.text()).toContain("Nothing waiting");
    expect(wrapper.find("#add-app").exists()).toBe(true);
    expect(wrapper.find("#new-handoff").exists()).toBe(true);
  });

  it("renders the master variant read-only with links and no mutating controls", async () => {
    const wrapper = await mountPage(boot(MASTER_PROPS));

    expect(wrapper.get("h1").text()).toBe("Hanse master");
    expect(wrapper.text()).toContain("Master agent");
    expect(wrapper.text()).toContain("/workspace/master");
    expect(wrapper.text()).toContain("Running");

    const links = wrapper.findAll("a").map((link) => link.attributes("href"));
    expect(links).toContain("/chat?app=master&project=master");
    expect(links).toContain("/projects/master/apps/master/settings");
    expect(links).toContain("/projects/master/apps/master/skills");

    expect(wrapper.find("#danger-zone").exists()).toBe(false);
    expect(wrapper.find("#add-app").exists()).toBe(false);
    expect(wrapper.find("#new-handoff").exists()).toBe(false);
    expect(wrapper.find("#project-delete-dialog").exists()).toBe(false);
    expect(wrapper.find("#apps-title").exists()).toBe(false);
    const mutationButtons = wrapper
      .findAll("button")
      .filter((button) => /delete|handoff/i.test(button.text()));
    expect(mutationButtons).toHaveLength(0);
  });

  it("shows loading and fetches when boot props belong to another route", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mocks.apiQuery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = await mountPage(boot(PROPS, "overview"));

    expect(wrapper.text()).toContain("Loading project…");
    expect(wrapper.text()).not.toContain("Ship the handoff");

    resolve?.({ ...PROPS });
    await flushPromises();
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/projects/project-one");
    expect(wrapper.get("h1").text()).toBe("Project One");
  });

  it("renders a 404 error with retry and the legacy escape hatch", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiQuery.mockRejectedValue(new ApiError("not found", 404));
    const wrapper = await mountPage(boot(null));

    expect(wrapper.text()).toContain("Loading project…");
    await flushPromises();
    await flushPromises();

    expect(wrapper.get("h1").text()).toBe("Project");
    expect(wrapper.text()).toContain("Project not found");
    expect(wrapper.text()).toContain("This project no longer exists.");
    expect(wrapper.get('a[href="?legacy=1"]').text()).toBe("Use the classic interface");

    await wrapper.get("section .cluster button").trigger("click");
    await flushPromises();
    expect(mocks.apiQuery).toHaveBeenCalledTimes(2);
  });

  it("renders a generic load error", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiQuery.mockRejectedValue(new ApiError("Project is unavailable.", 500));
    const wrapper = await mountPage(boot(PROPS, "projects"));

    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Project could not be loaded");
    expect(wrapper.text()).toContain("Project is unavailable.");
  });

  it("keeps application links as full-document legacy boundaries", async () => {
    const wrapper = await mountPage(boot(PROPS));
    const link = wrapper.get('a[aria-label="Open alpha application"]');

    expect(link.attributes("href")).toBe("/projects/project-one/apps/alpha");
    expect(link.attributes("aria-current")).toBeUndefined();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    let preventedByApp = false;
    link.element.addEventListener("click", (clickEvent) => {
      preventedByApp = clickEvent.defaultPrevented;
      clickEvent.preventDefault();
    });
    link.element.dispatchEvent(event);
    expect(preventedByApp).toBe(false);
  });

  it("adds an application by path, refreshes, and raises a success toast", async () => {
    mocks.apiQuery.mockResolvedValue({ ...PROPS });
    mocks.apiMutation.mockResolvedValue({ ok: true, app: { id: "new", appKey: "new" } });
    const wrapper = await mountPage(boot(PROPS));

    await wrapper.get('section[aria-labelledby="apps-title"] .card__head button').trigger("click");
    expect(dialogOpen(wrapper, "#add-app")).toBe(true);

    await wrapper.get("#add-app-name").setValue("worker");
    await wrapper.get("#add-app-path").setValue("apps/worker");
    await wrapper.get("#add-app form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/project-one/apps", {
      form: { name: "worker", path: "apps/worker", return_to: "/projects/project-one" },
    });
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/projects/project-one");
    expect(toasts().at(-1)).toMatchObject({ message: "Application added.", tone: "success" });
    expect(dialogOpen(wrapper, "#add-app")).toBe(false);
  });

  it("keeps the add-app dialog open and toasts on failure", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiMutation.mockRejectedValue(new ApiError("Application already exists.", 409));
    const wrapper = await mountPage(boot(PROPS));

    await wrapper.get('section[aria-labelledby="apps-title"] .card__head button').trigger("click");
    await wrapper.get("#add-app-name").setValue("worker");
    await wrapper.get("#add-app form").trigger("submit");
    await flushPromises();

    expect(dialogOpen(wrapper, "#add-app")).toBe(true);
    expect(toasts().at(-1)).toMatchObject({
      message: "Application already exists.",
      tone: "error",
    });
  });

  it("creates an awaiting-approval handoff and refreshes", async () => {
    mocks.apiQuery.mockResolvedValue({ ...PROPS });
    mocks.apiMutation.mockResolvedValue({
      ok: true,
      handoffId: "h-new",
      status: "awaiting_approval",
      state: "awaiting_approval",
    });
    const wrapper = await mountPage(boot(PROPS));

    await wrapper.get(".page-header__actions button").trigger("click");
    expect(dialogOpen(wrapper, "#new-handoff")).toBe(true);

    await wrapper.get("#handoff-summary").setValue("New work");
    await wrapper.get("#handoff-spec").setValue("Do it.");
    await wrapper.get("#new-handoff form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/handoffs", {
      form: {
        summary: "New work",
        from: "alpha",
        to: "beta",
        spec: "Do it.",
        requires_approval: "1",
        project: "project-one",
        return_to: "/projects/project-one",
      },
    });
    expect(toasts().at(-1)).toMatchObject({
      message: "Handoff created; awaiting operator approval.",
      tone: "success",
    });
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/projects/project-one");
    expect(dialogOpen(wrapper, "#new-handoff")).toBe(false);
  });

  it("keeps the new-handoff dialog open on a summary error", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiMutation.mockRejectedValue(
      new ApiError("Summary is required.", 400, "summary_required"),
    );
    const wrapper = await mountPage(boot(PROPS));

    await wrapper.get(".page-header__actions button").trigger("click");
    await wrapper.get("#handoff-summary").setValue("x");
    await wrapper.get("#new-handoff form").trigger("submit");
    await flushPromises();

    expect(dialogOpen(wrapper, "#new-handoff")).toBe(true);
    expect(toasts().at(-1)).toMatchObject({ message: "Summary is required.", tone: "error" });
  });

  it("opens a waiting handoff and approves it", async () => {
    mocks.apiQuery.mockResolvedValue({ ...PROPS });
    mocks.apiMutation.mockResolvedValue({ ok: true, decision: "approved" });
    const wrapper = await mountPage(
      boot({
        ...PROPS,
        handoffs: [
          {
            ...HANDOFF,
            state: "awaiting_approval",
            displayState: "awaiting_approval",
            approvalKind: "dispatch",
          },
        ],
        waitingHandoffs: [{ ...WAITING }],
      }),
    );

    await wrapper.get(".route-card__foot button").trigger("click");
    await flushPromises();
    expect(dialogOpen(wrapper, `#h-${HANDOFF.id}`)).toBe(true);

    await wrapper.get(`#h-${HANDOFF.id} .dialog__foot .btn-primary`).trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(`/api/handoffs/${HANDOFF.id}/decision`, {
      form: {
        decision: "approved",
        approval_kind: "dispatch",
        reason: "",
        return_to: "/projects/project-one",
      },
    });
    expect(toasts().at(-1)).toMatchObject({ message: "Handoff approved.", tone: "success" });
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/projects/project-one");
  });

  it("keeps the decision dialog open when the server rejects the decision", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiMutation.mockRejectedValue(new ApiError("No pending approval for this handoff.", 409));
    const wrapper = await mountPage(
      boot({
        ...PROPS,
        handoffs: [
          {
            ...HANDOFF,
            state: "awaiting_approval",
            displayState: "awaiting_approval",
            approvalKind: "dispatch",
          },
        ],
        waitingHandoffs: [{ ...WAITING }],
      }),
    );

    await wrapper.get(".route-card__foot button").trigger("click");
    await flushPromises();
    await wrapper.get(`#h-${HANDOFF.id} .dialog__foot .btn-primary`).trigger("click");
    await flushPromises();

    expect(dialogOpen(wrapper, `#h-${HANDOFF.id}`)).toBe(true);
    expect(toasts().at(-1)).toMatchObject({
      message: "No pending approval for this handoff.",
      tone: "error",
    });
  });

  it("runs relaunch, retry, and cancel reply actions from the detail dialog", async () => {
    mocks.apiQuery.mockResolvedValue({ ...PROPS });
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = await mountPage(
      boot({
        ...PROPS,
        handoffs: [
          {
            ...HANDOFF,
            state: "delivered",
            displayState: "delivered",
            result: "done",
            outcome: "completed",
            replyState: "waiting_operator",
            canCancel: false,
            canRelaunch: true,
            canRetryReply: true,
            canCancelReply: true,
          },
        ],
      }),
    );

    await wrapper
      .get('section[aria-labelledby="project-handoffs-title"] tbody .btn-ghost')
      .trigger("click");
    await flushPromises();
    expect(dialogOpen(wrapper, `#h-${HANDOFF.id}`)).toBe(true);

    await wrapper.get(`#h-${HANDOFF.id}-note`).setValue("please retry");
    await wrapper.get(`#h-${HANDOFF.id} .btn-primary`).trigger("click");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenCalledWith(`/api/handoffs/${HANDOFF.id}/reply/relaunch`, {
      form: { return_to: "/projects/project-one", note: "please retry" },
    });
    expect(toasts().at(-1)).toMatchObject({ message: "Reply started in a new session." });
  });

  it("saves and deletes handoff policy rules, and toasts an error", async () => {
    mocks.apiQuery.mockResolvedValue({ ...PROPS });
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = await mountPage(boot(PROPS));

    await wrapper.get("#handoff-policy-from").setValue("alpha");
    await wrapper.get("#handoff-policy-to").setValue("beta");
    await wrapper.get("#handoff-policy-dispatch").setValue("deny");
    await wrapper.get("#handoff-policy-reply").setValue("approve");
    await wrapper.get("section[aria-labelledby='handoff-policy-title'] form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/project-one/handoff-policy", {
      form: {
        from: "alpha",
        to: "beta",
        dispatch_mode: "deny",
        reply_mode: "approve",
        return_to: "/projects/project-one",
      },
    });
    expect(toasts().at(-1)).toMatchObject({ message: "Handoff policy saved." });

    await wrapper
      .get('section[aria-labelledby="handoff-policy-title"] tbody .btn-ghost')
      .trigger("click");
    await flushPromises();
    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/projects/project-one/handoff-policy/delete",
      { form: { from: "alpha", to: "beta", return_to: "/projects/project-one" } },
    );
    expect(toasts().at(-1)).toMatchObject({ message: "Handoff policy rule deleted." });

    const { ApiError } = await import("../api.js");
    mocks.apiMutation.mockRejectedValueOnce(new ApiError("Bad rule.", 400));
    await wrapper.get("section[aria-labelledby='handoff-policy-title'] form").trigger("submit");
    await flushPromises();
    expect(toasts().at(-1)).toMatchObject({ message: "Bad rule.", tone: "error" });
  });

  it("deletes a project only for an exact name and navigates with a notice", async () => {
    mocks.apiQuery.mockResolvedValue({ ...PROPS });
    mocks.apiMutation.mockResolvedValue({
      deleted: true,
      kind: "project",
      projectId: "project-one",
      warnings: [],
    });
    const wrapper = await mountPage(boot(PROPS));

    await wrapper.get("#danger-zone .card__foot button").trigger("click");
    expect(dialogOpen(wrapper, "#project-delete-dialog")).toBe(true);

    await wrapper.get("#project-delete-confirm").setValue("Project");
    expect(wrapper.get("#project-delete-dialog .btn-danger").attributes("disabled")).toBeDefined();
    await wrapper.get("#project-delete-confirm").setValue("Project One");
    expect(
      wrapper.get("#project-delete-dialog .btn-danger").attributes("disabled"),
    ).toBeUndefined();

    await wrapper.get("#project-delete-dialog form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/project-one/delete", {
      form: { confirm: "Project One", return_to: "/projects/project-one" },
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/projects?notice=Project+deleted.&tone=success");
  });

  it("keeps the delete dialog open and toasts when deletion fails", async () => {
    const { ApiError } = await import("../api.js");
    mocks.apiMutation.mockRejectedValue(new ApiError("The project name must match exactly.", 400));
    const wrapper = await mountPage(boot(PROPS));

    await wrapper.get("#danger-zone .card__foot button").trigger("click");
    await wrapper.get("#project-delete-confirm").setValue("Project One");
    await wrapper.get("#project-delete-dialog form").trigger("submit");
    await flushPromises();

    expect(dialogOpen(wrapper, "#project-delete-dialog")).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toMatchObject({
      message: "The project name must match exactly.",
      tone: "error",
    });
  });
});
