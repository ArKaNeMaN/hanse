import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { ApiError } from "../api.js";
import type { BootPayload } from "../boot.js";
import { boot, inventory, scope, workspace } from "../skills-fixtures.js";
import { useToastStore } from "../stores/toasts.js";
import SkillsPage from "./SkillsPage.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

const SECRET = "sentinel-provider-secret";

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/skills", name: "skills-global", component: { template: "<div />" } },
      { path: "/skills/new", name: "skills-new", component: { template: "<div />" } },
      { path: "/skills/:id", name: "skills-detail", component: { template: "<div />" } },
      {
        path: "/projects/:id/apps/:app/skills",
        name: "skills-app",
        component: { template: "<div />" },
      },
      { path: "/projects/:id/skills", name: "skills-project", component: { template: "<div />" } },
      { path: "/projects/:id", name: "project", component: { template: "<div />" } },
      { path: "/", name: "overview", component: { template: "<div />" } },
    ],
  });
}

async function mountPage(
  payload: BootPayload,
  path = "/skills",
  router = testRouter(),
): Promise<VueWrapper> {
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return mount(SkillsPage, {
    props: { boot: payload },
    global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] },
  });
}

function toasts() {
  return useToastStore().toasts;
}

function createBoot(): BootPayload {
  const currentScope = scope({});
  return boot(
    workspace({
      create: true,
      id: 0,
      name: "",
      title: "New skill",
      overline: "GLOBAL SKILL",
      scope: currentScope,
      contextPage: "/skills",
      projectId: null,
      values: {
        name: "",
        description: "",
        content: "",
        enabled: true,
        bundle: {
          license: null,
          compatibility: null,
          metadata: {},
          metadataRaw: null,
          references: [],
        },
      },
      state: {
        name: "editable",
        label: "Enabled here",
        note: "Defined at this scope.",
        editable: true,
        contextScope: "global",
        contextTarget: {},
        effectiveHere: true,
      },
      stateBadge: { name: "draft", label: "Draft", tone: "info" },
      header: {
        overline: "GLOBAL SKILL",
        title: "New skill",
        description: "Create a reusable procedure for agents to load at start.",
        meta: ["0 references"],
        backHref: "/skills",
      },
      form: {
        action: "/api/skills",
        method: "post",
        mode: "create",
        name: "",
        returnTo: "/skills",
        target: { scope: "global", projectId: null, appKey: null, returnTo: "/skills" },
        bundleSnapshot: "{}",
        saveLabel: "Create skill",
        discardLabel: "Discard",
        nameField: {
          value: "",
          required: true,
          maxlength: 64,
          pattern: "[a-z0-9]+(?:-[a-z0-9]+)*",
          hint: "Lowercase letters, digits, and single hyphens.",
          error: null,
        },
        description: { value: "", hintId: "skill-description-hint", error: null },
        enabled: { checked: true, hint: "Uncheck to hide this skill.", error: null },
      },
      danger: null,
      meta: ["0 references"],
      breadcrumb: currentScope.breadcrumb,
    }),
    "skills-new",
  );
}

beforeEach(() => {
  mocks.apiQuery.mockReset();
  mocks.apiMutation.mockReset();
  mocks.apiQuery.mockResolvedValue(inventory());
});

describe("SkillsPage inventory", () => {
  it("renders the boot inventory with rows, counts, filters, and SPA links", async () => {
    const data = inventory();
    const wrapper = await mountPage(boot(data));

    expect(mocks.apiQuery).not.toHaveBeenCalled();
    expect(wrapper.get("h1").text()).toBe("Skills");
    expect(wrapper.findAll("[data-skill-inventory] tbody tr")).toHaveLength(4);
    expect(wrapper.text()).toContain("4 of 4 skills at this scope");
    expect(wrapper.text()).toContain("1 enabled · 1 inherited");
    expect(wrapper.get("a[data-skill-create]").attributes("href")).toBe("/skills/new?scope=global");
    expect(wrapper.get('[data-skill-name="alpha-skill"]').text()).toContain("Enabled here");
    expect(wrapper.get('[data-skill-name="alpha-skill"] a.mono').attributes("href")).toBe(
      "/skills/7?from=%2Fskills",
    );
    expect(wrapper.html()).not.toContain("<style");
    expect(wrapper.html()).not.toContain(SECRET);
  });

  it("renders a scoped project inventory and scoped create link", async () => {
    const data = inventory({ scope: scope({ scope: "project", projectId: "p" }) });
    const wrapper = await mountPage(
      boot(data, "skills-project", { id: "p" }),
      "/projects/p/skills",
    );

    expect(wrapper.text()).toContain("Alpha");
    expect(wrapper.get("a[data-skill-create]").attributes("href")).toBe(
      "/skills/new?scope=project&project=p",
    );
    expect(wrapper.findAll(".settings-nav__link")[1]?.attributes("aria-current")).toBe("page");
  });

  it("fetches the current scope when the boot payload belongs to another route", async () => {
    const data = inventory({ scope: scope({ scope: "project", projectId: "p" }) });
    mocks.apiQuery.mockResolvedValue(data);
    const wrapper = await mountPage(boot(inventory(), "skills-global"), "/projects/p/skills");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/skills?scope=project&project=p");
    expect(wrapper.text()).toContain("4 of 4 skills at this scope");
  });

  it("navigates filters and search through the router", async () => {
    const data = inventory();
    const router = testRouter();
    const wrapper = await mountPage(boot(data), "/skills", router);

    await wrapper.get('a[href="/skills?filter=inherited"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/skills?filter=inherited");

    await wrapper.get("#skill-search").setValue("alpha");
    await wrapper.get("form[aria-label='Search skills']").trigger("submit");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/skills?filter=inherited&q=alpha");
  });

  it("shows a fetch error with retry and a 404 state", async () => {
    mocks.apiQuery.mockRejectedValueOnce(new ApiError("Skills are unavailable.", 503));
    const wrapper = await mountPage(boot(inventory(), "overview"));
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Skills could not be loaded");
    expect(wrapper.text()).toContain("Skills are unavailable.");

    mocks.apiQuery.mockResolvedValue(inventory());
    await wrapper.get("button").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(wrapper.text()).toContain("4 of 4 skills at this scope");

    mocks.apiQuery.mockRejectedValueOnce(new ApiError("not found", 404));
    const missing = await mountPage(boot(inventory(), "overview"));
    await flushPromises();
    await flushPromises();
    expect(missing.text()).toContain("Skills scope not found");
    expect(missing.text()).not.toContain("Retry");
  });

  it("renders the empty state with its create action", async () => {
    const empty = {
      kind: "none" as const,
      iconName: "code" as const,
      title: "No skills here yet",
      body: "Create the first skill at this scope.",
      actionLabel: "Create the first skill",
      actionHref: "/skills/new?scope=global",
      actionStyle: "primary" as const,
      actionIcon: "plus" as const,
    };
    const data = inventory({ rows: [], allCount: 0, matchedCount: 0, empty });
    const wrapper = await mountPage(boot(data));

    expect(wrapper.text()).toContain("No skills here yet");
    expect(wrapper.get(".empty-state a").attributes("href")).toBe("/skills/new?scope=global");
    expect(wrapper.find("[data-skill-inventory]").exists()).toBe(false);
  });
});

describe("SkillsPage create", () => {
  it("creates a skill with the existing handler and navigates to it", async () => {
    mocks.apiMutation.mockResolvedValue({ skill: { id: 9 } });
    const router = testRouter();
    const wrapper = await mountPage(createBoot(), "/skills/new?scope=global", router);

    await wrapper.get("#skill-name").setValue("release-checklist");
    await wrapper.get("#skill-description").setValue("Review a release before it ships.");
    await wrapper.get("#skill-content").setValue("## Steps\n\nRun the checks.");
    await wrapper.get("form[data-skill-form]").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skills", {
      json: expect.objectContaining({
        action: "create",
        scope: "global",
        return_to: "/skills",
        name: "release-checklist",
        description: "Review a release before it ships.",
        content: "## Steps\n\nRun the checks.",
        enabled: true,
        license: null,
        compatibility: null,
        metadata: {},
        references: [],
      }),
    });
    expect(router.currentRoute.value.fullPath).toBe("/skills/9");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Skill created.", tone: "success" }),
    );
  });

  it("keeps the form open and shows a name error on a duplicate", async () => {
    mocks.apiMutation.mockRejectedValue(
      new ApiError("A skill with this name already exists at this scope.", 409, "conflict"),
    );
    const wrapper = await mountPage(createBoot(), "/skills/new?scope=global");

    await wrapper.get("#skill-name").setValue("alpha-skill");
    await wrapper.get("#skill-description").setValue("Duplicate.");
    await wrapper.get("#skill-content").setValue("body");
    await wrapper.get("form[data-skill-form]").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("A skill with this name already exists at this scope.");
    expect(toasts()).toContainEqual(
      expect.objectContaining({
        message: "A skill with this name already exists at this scope.",
        tone: "error",
      }),
    );
  });

  it("validates the name locally before calling the server", async () => {
    const wrapper = await mountPage(createBoot(), "/skills/new?scope=global");
    await wrapper.get("#skill-name").setValue("Not A Slug");
    await wrapper.get("form[data-skill-form]").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Use lowercase letters, digits, and single hyphens.");
  });

  it("fetches the scope when create is reached from a client navigation", async () => {
    const data = inventory({ scope: scope({ scope: "project", projectId: "p" }) });
    mocks.apiQuery.mockResolvedValue(data);
    const wrapper = await mountPage(
      boot(inventory(), "skills-global"),
      "/skills/new?scope=project&project=p",
    );
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/skills?scope=project&project=p");
    expect(wrapper.find("#skill-name").exists()).toBe(true);
    expect(wrapper.text()).toContain("Back to skills");
  });
});
