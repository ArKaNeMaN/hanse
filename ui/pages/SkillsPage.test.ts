import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { ApiError } from "../api.js";
import type { BootPayload } from "../boot.js";
import type { SkillSourceView, SnapshotSkill } from "../skill-sources-types.js";
import { boot, externalRow, inventory, scope, targets, workspace } from "../skills-fixtures.js";
import type { SkillsInventoryProps, SkillWorkspaceProps } from "../skills-types.js";
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

function buttonByText(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll("button").find((button) => button.text().includes(text));
  if (found === undefined) {
    throw new Error(`Missing button: ${text}`);
  }
  return found;
}

function optionByLabel(wrapper: VueWrapper, label: string) {
  const found = wrapper
    .findAll('[role="option"]')
    .find((option) => option.find(".target-option__label").text() === label);
  if (found === undefined) {
    throw new Error(`Missing target option: ${label}`);
  }
  return found;
}

function externalSource(): SkillSourceView {
  return {
    id: "source-1",
    slug: "team-hub",
    name: "Team hub",
    kind: "skills-hub",
    endpoint: "https://hub.example.test",
    config: { buckets: ["default"], allowInsecureHttp: false },
    priority: 100,
    enabled: true,
    mode: "track",
    syncIntervalSec: 900,
    staleAfterSec: 86400,
    requestTimeoutMs: 15000,
    activeSnapshotId: "snap-1",
    pinnedSnapshotId: null,
    disabledAt: null,
    lastAttemptAt: "2026-11-01T09:30:00.000Z",
    lastSuccessAt: "2026-11-01T09:30:00.000Z",
    lastCheckedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    etag: null,
    revision: "abcdef1234567890",
    state: "ready",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:30:00.000Z",
    updatedBy: "operator",
    tokenSet: true,
    tokenUpdatedAt: "2026-10-01T09:00:00.000Z",
    skillCount: 1,
    totalBytes: 2048,
    stale: false,
  };
}

function externalSkills(): { source: SkillSourceView; skills: SnapshotSkill[] } {
  return {
    source: externalSource(),
    skills: [
      {
        bucket: "default",
        name: "release-checklist",
        description: "Published by the team skills hub.",
        version: "1.0.0",
        contentHash: "hash",
        skillMdSha256: "sha",
        files: [{ path: "SKILL.md", sha256: "a".repeat(64), size: 128 }],
        state: "ok",
        errorCode: null,
        errorMessage: null,
      },
    ],
  };
}

let inventoryData: SkillsInventoryProps;
let detailData: SkillWorkspaceProps;
let inventoryError: Error | null;

function installApi(): void {
  mocks.apiQuery.mockImplementation((path: string) => {
    if (path === "/api/ui/targets") {
      return Promise.resolve(targets());
    }
    if (path.startsWith("/api/skill-sources/")) {
      return Promise.resolve(externalSkills());
    }
    if (path.startsWith("/api/ui/skills/")) {
      return Promise.resolve(detailData);
    }
    if (inventoryError !== null) {
      return Promise.reject(inventoryError);
    }
    return Promise.resolve(inventoryData);
  });
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
  window.localStorage.clear();
  inventoryData = inventory();
  detailData = workspace();
  inventoryError = null;
  installApi();
});

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

describe("SkillsPage inventory", () => {
  it("renders the boot inventory with grouped cards, counts, filters, and the target selector", async () => {
    const data = inventory();
    const wrapper = await mountPage(boot(data));

    expect(
      mocks.apiQuery.mock.calls.some(([path]) => String(path).startsWith("/api/ui/skills?")),
    ).toBe(false);
    expect(wrapper.get("h1").text()).toBe("Skills");
    expect(wrapper.get(".overline").text()).toBe("Skills · Global");
    expect(wrapper.get("[data-skill-meta]").text()).toBe("4 skills · 4 matched");
    expect(wrapper.text()).toContain("4 of 4 skills at this scope");
    expect(wrapper.findAll("[data-skill-row]")).toHaveLength(4);
    expect(wrapper.findAll(".skills-group__title").map((entry) => entry.text())).toEqual([
      "Global",
      "Project",
      "Application",
    ]);
    expect(wrapper.get("a[data-skill-create]").attributes("href")).toBe("/skills/new?scope=global");
    expect(wrapper.get(".target-trigger__label").text()).toBe("Global");

    const alpha = wrapper.get('[data-skill-name="alpha-skill"]');
    expect(alpha.element.tagName).toBe("BUTTON");
    expect(alpha.attributes("type")).toBe("button");
    expect(alpha.attributes("data-skill-row")).toBe("");
    expect(alpha.attributes("data-skill-state")).toBe("enabled");
    expect(alpha.attributes("data-skill-state-label")).toBe("Enabled here");
    expect(alpha.attributes("data-skill-mode")).toBe("managed");
    expect(alpha.text()).toContain("Enabled here");
    expect(wrapper.html()).not.toContain("<style");
    expect(wrapper.html()).not.toContain(SECRET);
  });

  it("renders a scoped project inventory and marks the current target", async () => {
    inventoryData = inventory({ scope: scope({ scope: "project", projectId: "p1" }) });
    const wrapper = await mountPage(
      boot(inventoryData, "skills-project", { id: "p1" }),
      "/projects/p1/skills",
    );

    expect(wrapper.get(".overline").text()).toBe("Skills · Project");
    expect(wrapper.get(".target-trigger__label").text()).toBe("Alpha");
    expect(wrapper.get("a[data-skill-create]").attributes("href")).toBe(
      "/skills/new?scope=project&project=p1",
    );

    await wrapper.get(".target-trigger").trigger("click");
    await flushPromises();
    expect(optionByLabel(wrapper, "Alpha").attributes("aria-selected")).toBe("true");
  });

  it("fetches the current scope when the boot payload belongs to another route", async () => {
    inventoryData = inventory({ scope: scope({ scope: "project", projectId: "p1" }) });
    const wrapper = await mountPage(boot(inventory(), "skills-global"), "/projects/p1/skills");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/skills?scope=project&project=p1");
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

  it("debounces live search with router.replace and clears on Escape", async () => {
    const data = inventory({ filter: "inherited" });
    const router = testRouter();
    const wrapper = await mountPage(boot(data), "/skills?filter=inherited", router);

    vi.useFakeTimers();
    await wrapper.get("#skill-search").setValue("alpha");
    await vi.advanceTimersByTimeAsync(249);
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/skills?filter=inherited");

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/skills?filter=inherited&q=alpha");

    await wrapper.get("#skill-search").trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect((wrapper.get("#skill-search").element as HTMLInputElement).value).toBe("");
  });

  it("shows a fetch error with retry and a 404 state", async () => {
    inventoryError = new ApiError("Skills are unavailable.", 503);
    const wrapper = await mountPage(boot(inventory(), "overview"));
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Skills could not be loaded");
    expect(wrapper.text()).toContain("Skills are unavailable.");

    inventoryError = null;
    await buttonByText(wrapper, "Retry").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(wrapper.text()).toContain("4 of 4 skills at this scope");

    inventoryError = new ApiError("not found", 404);
    const missing = await mountPage(boot(inventory(), "overview"));
    await flushPromises();
    await flushPromises();
    expect(missing.text()).toContain("Skills scope not found");
    expect(missing.text()).not.toContain("Retry");
  });

  it("renders external rows read-only and opens the external drawer from the row", async () => {
    const first = externalRow();
    const second = externalRow({
      name: "second-external",
      externalKey: "source-1:default:second-external",
    });
    inventoryData = inventory({
      rows: [first, second],
      allCount: 2,
      matchedCount: 2,
      counts: { enabled: 0, inherited: 0, disabled: 0, invalid: 0, external: 2 },
    });
    const wrapper = await mountPage(boot(inventoryData));

    expect(wrapper.findAll('[data-skill-mode="external"]')).toHaveLength(2);
    const release = wrapper.get('[data-skill-name="release-checklist"]');
    expect(release.text()).toContain("Source");
    expect(release.text()).toContain("Team hub");
    expect(release.text()).toContain("Read-only");
    expect(release.text()).toContain("3 files");
    expect(release.find("a").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("/skills/null");

    await release.trigger("click");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/skill-sources/source-1/skills");
    expect(wrapper.text()).toContain("This skill is provided by Team hub");
    expect(wrapper.text()).toContain("Manage source");
  });

  it("opens the preview drawer for a managed row and preserves the effective link rule", async () => {
    const data = inventory();
    const wrapper = await mountPage(boot(data));

    expect(wrapper.find("[data-skill-row] [data-skill-effective-link]").exists()).toBe(false);
    const alpha = wrapper.get('[data-skill-name="alpha-skill"]');
    await alpha.trigger("click");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/skills/7?from=%2Fskills");
    expect(wrapper.text()).toContain("Read-only preview");
    const full = wrapper.findAll("a").find((anchor) => anchor.text().includes("Open full skill"));
    expect(full?.attributes("href")).toBe("/skills/7?from=%2Fskills");
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
    inventoryData = inventory({ rows: [], allCount: 0, matchedCount: 0, empty });
    const wrapper = await mountPage(boot(inventoryData));

    expect(wrapper.text()).toContain("No skills here yet");
    expect(wrapper.get(".empty-state a").attributes("href")).toBe("/skills/new?scope=global");
    expect(wrapper.find("[data-skill-inventory]").exists()).toBe(false);
  });

  it("navigates to project and app targets and resets filter/search", async () => {
    const router = testRouter();
    const data = inventory({
      filter: "inherited",
      search: {
        action: "/skills",
        query: "alpha",
        hiddenFilter: "inherited",
        clearHref: "/skills",
      },
    });
    const wrapper = await mountPage(boot(data), "/skills?filter=inherited&q=alpha", router);

    await wrapper.get(".target-trigger").trigger("click");
    await flushPromises();
    await optionByLabel(wrapper, "Alpha").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/projects/p1/skills");

    inventoryData = inventory({ scope: scope({ scope: "project", projectId: "p1" }) });
    const appRouter = testRouter();
    const appWrapper = await mountPage(
      boot(inventoryData, "skills-project", { id: "p1" }),
      "/projects/p1/skills",
      appRouter,
    );
    await appWrapper.get(".target-trigger").trigger("click");
    await flushPromises();
    await optionByLabel(appWrapper, "api").trigger("click");
    await flushPromises();
    expect(appRouter.currentRoute.value.fullPath).toBe("/projects/p1/apps/api/skills");
  });

  it("shows the attention band, filters, active-zero, and preserves search", async () => {
    const data = inventory();
    const router = testRouter();
    const wrapper = await mountPage(boot(data), "/skills", router);

    expect(wrapper.get(".skills-attention").text()).toContain("Needs attention");
    expect(wrapper.get(".skills-attention").text()).toContain("invalid-skill");
    expect(wrapper.get(".skills-attention").text()).toContain(
      "The stored metadata is not valid JSON: bad",
    );
    expect(wrapper.get('a[href="/skills?filter=attention"]').text()).toContain("Show only");

    await wrapper.get('a[href="/skills?filter=attention"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe("/skills?filter=attention");

    const active = inventory({
      filter: "attention",
      attention: {
        ...inventory().attention,
        active: true,
        href: "/skills?filter=attention&q=alpha",
        clearHref: "/skills?q=alpha",
      },
    });
    inventoryData = active;
    const activeWrapper = await mountPage(boot(active), "/skills?filter=attention", router);
    expect(activeWrapper.text()).toContain("Showing only");
    expect(activeWrapper.get('a[href="/skills?q=alpha"]').text()).toContain("Clear");

    const zero = inventory({
      filter: "attention",
      rows: [],
      allCount: 0,
      matchedCount: 0,
      attention: {
        ...inventory().attention,
        count: 0,
        items: [],
        omitted: 0,
        active: true,
        clearHref: "/skills",
      },
    });
    inventoryData = zero;
    const zeroWrapper = await mountPage(boot(zero), "/skills?filter=attention", testRouter());
    expect(zeroWrapper.get(".skills-attention").text()).toContain("Needs attention");
    expect(zeroWrapper.get(".skills-attention .badge").text()).toBe("0");
    expect(zeroWrapper.get(".skills-attention").text()).toContain("Clear");
    expect(zeroWrapper.get(".skills-attention").text()).not.toContain("Show only");
  });

  it("switches cards and list density and persists the choice", async () => {
    const data = inventory();
    const wrapper = await mountPage(boot(data));

    expect(wrapper.find(".skills-cards").exists()).toBe(true);
    expect(wrapper.find(".skills-list").exists()).toBe(false);

    await buttonByText(wrapper, "List").trigger("click");
    await flushPromises();
    expect(wrapper.find(".skills-cards").exists()).toBe(false);
    expect(wrapper.find(".skills-list").exists()).toBe(true);
    expect(wrapper.get(".skills-list__head").text()).toContain("State");
    expect(wrapper.get(".skills-list__head").text()).toContain("Files/Refs");
    expect(window.localStorage.getItem("hanse.skills.density")).toBe("list");

    const remounted = await mountPage(boot(data));
    expect(remounted.find(".skills-list").exists()).toBe(true);

    window.localStorage.setItem("hanse.skills.density", "nonsense");
    const fallback = await mountPage(boot(data));
    expect(fallback.find(".skills-cards").exists()).toBe(true);
  });

  it("collapses and reopens the rail", async () => {
    const data = inventory();
    const wrapper = await mountPage(boot(data));

    const toggle = buttonByText(wrapper, "Hide");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(wrapper.text()).toContain("Summary");

    await toggle.trigger("click");
    await flushPromises();
    const reopened = buttonByText(wrapper, "Show");
    expect(reopened.attributes("aria-expanded")).toBe("false");
    expect(wrapper.text()).not.toContain("Summary");

    await reopened.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Summary");
  });

  it("keeps each card and list row a single interactive control", async () => {
    const data = inventory();
    const wrapper = await mountPage(boot(data));

    for (const row of wrapper.findAll("[data-skill-row]")) {
      expect(row.element.tagName).toBe("BUTTON");
      expect(row.element.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    }

    await buttonByText(wrapper, "List").trigger("click");
    await flushPromises();
    const rows = wrapper.findAll("[data-skill-row]");
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.element.tagName).toBe("BUTTON");
      expect(row.element.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    }
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
    inventoryData = inventory({ scope: scope({ scope: "project", projectId: "p" }) });
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
