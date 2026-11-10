import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import type { ProjectGrantsProps } from "../project-types.js";
import { useToastStore } from "../stores/toasts.js";
import ProjectGrantsCard from "./ProjectGrantsCard.vue";

const mocks = vi.hoisted(() => ({
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiMutation: mocks.apiMutation };
});

const GRANTS: ProjectGrantsProps = {
  outbound: [
    {
      id: 1,
      sourceProjectId: "project-one",
      sourceProjectName: "Project One",
      fromAppKey: "alpha",
      targetProjectId: "project-two",
      targetProjectName: "Project Two",
      toAppKey: "gamma",
      dispatchMode: "auto",
      replyMode: "approve",
    },
  ],
  inbound: [
    {
      id: 2,
      sourceProjectId: "project-three",
      sourceProjectName: "Project Three",
      fromAppKey: "epsilon",
      targetProjectId: "project-one",
      targetProjectName: "Project One",
      toAppKey: "alpha",
      dispatchMode: "approve",
      replyMode: "auto",
    },
  ],
  fromOptions: ["alpha", "beta", "*"],
  targetProjects: [
    { id: "project-two", name: "Project Two", appKeys: ["gamma", "delta"] },
    { id: "project-three", name: "Project Three", appKeys: ["epsilon"] },
  ],
  wildcard: "*",
  dispatchModes: ["auto", "approve"],
  replyModes: ["auto", "approve"],
};

const changed = vi.fn();

function mountCard(overrides: Partial<ProjectGrantsProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(ProjectGrantsCard, {
    props: {
      projectId: "project-one",
      grants: { ...GRANTS, ...overrides },
      returnTo: "/projects/project-one",
    },
    attrs: { onChanged: changed },
    global: { plugins: [pinia] },
  });
}

function toasts() {
  return useToastStore().toasts;
}

describe("ProjectGrantsCard", () => {
  beforeEach(() => {
    mocks.apiMutation.mockReset();
    changed.mockReset();
  });

  it("renders outbound and inbound lists", () => {
    const wrapper = mountCard();

    expect(wrapper.get("#handoff-grants-title").text()).toBe("Cross-project grants");
    expect(wrapper.get("#handoff-grants-title").element.parentElement?.textContent).toContain(
      "1 grants",
    );

    const tables = wrapper.findAll("table");
    expect(tables).toHaveLength(2);
    expect(tables[0]?.findAll("tbody tr")).toHaveLength(1);
    expect(tables[1]?.findAll("tbody tr")).toHaveLength(1);
    expect(tables[0]?.text()).toContain("Project Two");
    expect(tables[0]?.text()).toContain("gamma");
    expect(tables[1]?.text()).toContain("Project Three");
    expect(tables[1]?.text()).toContain("epsilon");

    expect(wrapper.find("style").exists()).toBe(false);
  });

  it("creates a grant with auto/auto defaults", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountCard();

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/project-one/handoff-grants", {
      form: {
        from: "*",
        target_project: "project-two",
        to: "*",
        dispatch_mode: "auto",
        reply_mode: "auto",
        return_to: "/projects/project-one",
      },
    });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(toasts().at(-1)).toMatchObject({
      message: "Cross-project grant saved.",
      tone: "success",
    });
  });

  it("switches the target app options with the selected target project", async () => {
    const wrapper = mountCard();
    const optionValues = (): (string | undefined)[] =>
      wrapper
        .get("#handoff-grant-to")
        .findAll("option")
        .map((option) => option.attributes("value"));

    expect(optionValues()).toEqual(["*", "gamma", "delta"]);

    await wrapper.get("#handoff-grant-target-project").setValue("project-three");
    await flushPromises();

    expect(optionValues()).toEqual(["*", "epsilon"]);
  });

  it("revokes a grant through the delete route", async () => {
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountCard();

    await wrapper.get("table tbody .btn-ghost").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/projects/project-one/handoff-grants/delete",
      {
        form: {
          from: "alpha",
          target_project: "project-two",
          to: "gamma",
          return_to: "/projects/project-one",
        },
      },
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(toasts().at(-1)).toMatchObject({
      message: "Cross-project grant revoked.",
      tone: "success",
    });
  });

  it("surfaces a validation error as a toast", async () => {
    mocks.apiMutation.mockRejectedValue(new ApiError("Target project is required.", 400));
    const wrapper = mountCard();

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(changed).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toMatchObject({
      message: "Target project is required.",
      tone: "error",
    });
  });

  it("disables actions while pending", async () => {
    let resolveMutation: ((value: unknown) => void) | undefined;
    mocks.apiMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const wrapper = mountCard();

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.get("form button[type='submit']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#handoff-grant-from").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#handoff-grant-target-project").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#handoff-grant-to").attributes("disabled")).toBeDefined();
    expect(wrapper.get("table tbody .btn-ghost").attributes("disabled")).toBeDefined();

    resolveMutation?.({ ok: true });
    await flushPromises();

    expect(wrapper.get("form button[type='submit']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("table tbody .btn-ghost").attributes("disabled")).toBeUndefined();
  });

  it("renders the inbound section read-only", () => {
    const wrapper = mountCard();

    const inbound = wrapper.findAll("table")[1];
    expect(inbound?.text()).toContain("Project Three");
    expect(inbound?.find("button").exists()).toBe(false);
    expect(wrapper.text()).toContain("visibility, not consent");
  });
});
