import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { ApiError } from "../api.js";
import type { BootPayload } from "../boot.js";
import { boot, issue, pending, scope, warning, workspace } from "../skills-fixtures.js";
import { useToastStore } from "../stores/toasts.js";
import SkillDetailPage from "./SkillDetailPage.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

const SECRET = "sentinel-https-token";

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/skills", name: "skills-global", component: { template: "<div />" } },
      { path: "/skills/new", name: "skills-new", component: { template: "<div />" } },
      { path: "/skills/:id", name: "skills-detail", component: { template: "<div />" } },
      { path: "/projects/:id/skills", name: "skills-project", component: { template: "<div />" } },
      { path: "/projects/:id", name: "project", component: { template: "<div />" } },
      { path: "/", name: "overview", component: { template: "<div />" } },
    ],
  });
}

async function mountPage(
  payload: BootPayload,
  path = "/skills/7",
  router = testRouter(),
): Promise<VueWrapper> {
  await router.push(path);
  await router.isReady();
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return mount(SkillDetailPage, {
    props: { boot: payload },
    global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] },
  });
}

function toasts() {
  return useToastStore().toasts;
}

function detailBoot(data = workspace()): BootPayload {
  return boot(data, "skills-detail", { id: String(data.id) });
}

function inherited(): ReturnType<typeof workspace> {
  return workspace({
    state: {
      name: "inherited",
      label: "Inherited",
      note: "Inherited from Global. Override here to edit a copy at this context.",
      editable: false,
      contextScope: "project",
      contextTarget: { projectId: "p" },
      effectiveHere: true,
    },
    scope: scope({ scope: "project", projectId: "p" }),
    projectId: "p",
    contextPage: "/projects/p/skills",
    row: {
      ...workspace().row,
      scope: "global",
    },
    form: null,
    danger: null,
    stateBadge: { name: "inherited", label: "Inherited", tone: "success" },
    actions: {
      target: { scope: "project", projectId: "p", appKey: null, returnTo: "/projects/p/skills" },
      override: {
        action: "/api/skills",
        returnTo: "/projects/p/skills",
        fromId: 7,
        enabled: "1",
        confirm: "Create an editable copy of this skill at this context?",
        label: "Override here",
        style: "primary",
      },
      disable: {
        action: "/api/skills",
        returnTo: "/projects/p/skills",
        fromId: 7,
        enabled: "0",
        confirm: "Disable this skill at this context?",
        label: "Disable here",
        style: "secondary",
      },
      revert: null,
      editAtSource: { href: "/skills/7", label: "Edit at source", style: "ghost" },
      openEffective: null,
      openTombstone: null,
      openRepair: null,
      openSource: null,
    },
  });
}

function hidden(): ReturnType<typeof workspace> {
  return workspace({
    id: 9,
    name: "alpha-skill",
    state: {
      name: "hidden",
      label: "Hidden at this context",
      note: "A tombstone at this context hides this wider skill.",
      editable: false,
      contextScope: "project",
      contextTarget: { projectId: "p" },
      effectiveHere: false,
    },
    scope: scope({ scope: "project", projectId: "p" }),
    projectId: "p",
    contextPage: "/projects/p/skills",
    form: null,
    danger: null,
    stateBadge: { name: "hidden", label: "Hidden at this context", tone: "warning" },
    actions: {
      target: { scope: "project", projectId: "p", appKey: null, returnTo: "/projects/p/skills" },
      override: null,
      disable: null,
      revert: {
        action: "/api/skills/9/delete",
        returnTo: "/projects/p/skills",
        fromId: null,
        enabled: null,
        confirm: "Revert this tombstone? The wider skill becomes effective here.",
        label: "Revert to inherited",
        style: "secondary",
      },
      editAtSource: null,
      openEffective: null,
      openTombstone: null,
      openRepair: null,
      openSource: null,
    },
  });
}

beforeEach(() => {
  mocks.apiQuery.mockReset();
  mocks.apiMutation.mockReset();
  mocks.apiQuery.mockResolvedValue(workspace());
  mocks.apiMutation.mockResolvedValue({});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("SkillDetailPage", () => {
  it("renders the boot bundle, issues, references, metadata, and safe Markdown once", async () => {
    const data = workspace({
      issues: [issue()],
      collisions: [warning()],
      values: {
        ...workspace().values,
        description: "Alpha skill used by the fixture.",
      },
    });
    const wrapper = await mountPage(detailBoot(data));

    expect(mocks.apiQuery).not.toHaveBeenCalled();
    expect(wrapper.get("h1").text()).toBe("alpha-skill");
    expect(wrapper.find("#skill-details").exists()).toBe(true);
    expect(wrapper.findAll(".skill-prose h4")).toHaveLength(1);
    expect(wrapper.text()).toContain("references/notes.md");

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("references/notes.md"))
      ?.trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "Preview")
      ?.trigger("click");
    await flushPromises();
    expect(wrapper.find(".skill-prose").text()).toContain("Reference body");
    expect(wrapper.findAll(".skill-prose h3")).toHaveLength(1);
    expect(wrapper.get("[data-skill-issues]").text()).toContain(
      "stored metadata is not valid JSON",
    );
    expect(wrapper.get("[data-skill-issues] a").attributes("href")).toBe("#skill-metadata-raw");
    expect(wrapper.get("[data-skill-collisions]").text()).toContain("also exists at");
    expect((wrapper.get("#skill-metadata-domain").element as HTMLInputElement).value).toBe(
      "engineering",
    );
    expect(wrapper.html()).not.toContain("<style");
    expect(wrapper.html()).not.toContain(SECRET);
  });

  it("renders inherited visibility and overrides at the current context", async () => {
    const data = inherited();
    const router = testRouter();
    const wrapper = await mountPage(
      detailBoot(data),
      "/skills/7?from=%2Fprojects%2Fp%2Fskills",
      router,
    );

    expect(wrapper.text()).toContain("Inherited");
    expect(wrapper.text()).toContain("Override here");
    expect(wrapper.text()).toContain("Disable here");

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Override here"))
      ?.trigger("click");
    await flushPromises();

    expect(window.confirm).toHaveBeenCalled();
    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skills", {
      json: expect.objectContaining({
        action: "override",
        from_id: 7,
        enabled: "1",
        scope: "project",
        project: "p",
        return_to: "/projects/p/skills",
      }),
    });
    expect(router.currentRoute.value.fullPath).toBe("/projects/p/skills");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Skill overridden here.", tone: "success" }),
    );
  });

  it("disables at the current context with the existing handler", async () => {
    const router = testRouter();
    const wrapper = await mountPage(detailBoot(inherited()), "/skills/7", router);

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Disable here"))
      ?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skills", {
      json: expect.objectContaining({ action: "override", enabled: "0", from_id: 7 }),
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Skill disabled here.", tone: "success" }),
    );
  });

  it("reverts a tombstone", async () => {
    const router = testRouter();
    const wrapper = await mountPage(detailBoot(hidden()), "/skills/9", router);

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Revert to inherited"))
      ?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skills/9/delete", {
      json: { return_to: "/projects/p/skills" },
    });
    expect(router.currentRoute.value.fullPath).toBe("/projects/p/skills");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Skill reverted to inherited.", tone: "success" }),
    );
  });

  it("saves the bundle with the existing handler", async () => {
    const wrapper = await mountPage(detailBoot());

    await wrapper.get("#skill-description").setValue("Updated description.");
    await wrapper.get("#skill-content").setValue("## Updated\n\nBody.");
    await wrapper.get("form[data-skill-form]").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skills/7", {
      json: expect.objectContaining({
        action: "update",
        return_to: "/skills/7",
        description: "Updated description.",
        content: "## Updated\n\nBody.",
        enabled: true,
        license: "MIT",
        metadata: { domain: "engineering" },
      }),
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Skill saved.", tone: "success" }),
    );
  });

  it("deletes only after the exact name is confirmed", async () => {
    const router = testRouter();
    const wrapper = await mountPage(detailBoot(), "/skills/7", router);

    await wrapper.get("[data-skill-delete]").trigger("click");
    await flushPromises();
    expect(mocks.apiMutation).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("The confirmation name does not match this skill.");

    await wrapper.get("#skill-confirm-name").setValue("alpha-skill");
    await wrapper.get("[data-skill-delete]").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skills/7/delete", {
      json: { return_to: "/skills", confirm_name: "alpha-skill" },
    });
    expect(router.currentRoute.value.fullPath).toBe("/skills");
  });

  it("restarts a pending agent from the restart banner", async () => {
    const data = workspace({
      restart: {
        kind: "required",
        hint: "The effective skill set changed.",
        entries: [pending()],
      },
    });
    const wrapper = await mountPage(detailBoot(data));

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Restart agent"))
      ?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/apps/a/restart?project=p&return_to=%2Fskills%2F7",
      { json: {} },
    );
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Agent restarted.", tone: "success" }),
    );
  });

  it("fetches the detail when the boot payload belongs to another route", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mocks.apiQuery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = await mountPage(boot(workspace(), "skills-global"), "/skills/7");
    await flushPromises();

    expect(wrapper.text()).toContain("Loading skill…");
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/skills/7");

    resolve?.(workspace());
    await flushPromises();
    await flushPromises();
    expect(wrapper.get("h1").text()).toBe("alpha-skill");
  });

  it("shows 404, generic error, retry, and the legacy escape hatch", async () => {
    mocks.apiQuery.mockRejectedValueOnce(new ApiError("not found", 404));
    const missing = await mountPage(boot(workspace(), "overview"), "/skills/7");
    await flushPromises();
    await flushPromises();
    expect(missing.text()).toContain("Skill not found");
    expect(missing.find("button").exists()).toBe(false);
    expect(missing.get("a[href='?legacy=1']").text()).toBe("Use the classic interface");

    mocks.apiQuery.mockRejectedValueOnce(new ApiError("Skill store unavailable.", 503));
    const failed = await mountPage(boot(workspace(), "overview"), "/skills/7");
    await flushPromises();
    await flushPromises();
    expect(failed.text()).toContain("Skill could not be loaded");
    expect(failed.text()).toContain("Skill store unavailable.");

    mocks.apiQuery.mockResolvedValue(workspace());
    await failed.get("button").trigger("click");
    await flushPromises();
    await flushPromises();
    expect(failed.get("h1").text()).toBe("alpha-skill");
  });
});
