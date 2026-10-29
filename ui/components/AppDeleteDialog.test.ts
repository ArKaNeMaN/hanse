import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ApiError } from "../api.js";
import type { AppDeleteProps } from "../app-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppDeleteDialog from "./AppDeleteDialog.vue";

const mocks = vi.hoisted(() => ({
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiMutation: mocks.apiMutation };
});

const DELETION: AppDeleteProps = {
  deleting: false,
  projectDeleting: false,
  pending: false,
  action: "/api/projects/p/apps/alpha/delete",
  returnTo: "/projects/p/apps/alpha",
  confirmName: "alpha",
  dialog: "application",
  retrying: false,
  title: "Delete application?",
  description: "This removes the application.",
  actionLabel: "Delete application",
  statusLabel: null,
  banner: null,
};

function mountDialog(
  deletion: Partial<AppDeleteProps> = {},
  listeners: Record<string, unknown> = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(AppDeleteDialog, {
    props: { deletion: { ...DELETION, ...deletion } },
    attrs: listeners,
    global: { plugins: [pinia] },
  });
  (wrapper.vm as unknown as { open: () => void }).open();
  return wrapper;
}

function toasts() {
  return useToastStore().toasts;
}

describe("AppDeleteDialog", () => {
  beforeEach(() => {
    mocks.apiMutation.mockReset();
  });

  it("requires the exact application key before enabling deletion", async () => {
    const wrapper = mountDialog();
    const submit = wrapper.get("button[type='submit']");
    expect(submit.attributes("disabled")).toBeDefined();

    await wrapper.get("#application-delete-confirm").setValue("alph");
    expect(submit.attributes("disabled")).toBeDefined();

    await wrapper.get("#application-delete-confirm").setValue("alpha");
    expect(submit.attributes("disabled")).toBeUndefined();
  });

  it("sends the confirmation, delete-files flag, and return_to", async () => {
    mocks.apiMutation.mockResolvedValue({
      deleted: true,
      kind: "app",
      projectId: "p",
      warnings: [],
    });
    const onDeleted = vi.fn();
    const wrapper = mountDialog({}, { onDeleted });

    await wrapper.get("#application-delete-confirm").setValue("alpha");
    await wrapper.get("input[name='deleteFiles']").setValue(true);
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/p/apps/alpha/delete", {
      form: {
        confirm: "alpha",
        deleteFiles: "true",
        return_to: "/projects/p/apps/alpha",
      },
    });
    expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ kind: "app" }));
    expect(wrapper.get("dialog").attributes("open")).toBeUndefined();
  });

  it("does not call the server for a mismatched name", async () => {
    const wrapper = mountDialog();
    await wrapper.get("#application-delete-confirm").setValue("beta");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and raises an error toast on failure", async () => {
    mocks.apiMutation.mockRejectedValue(
      new ApiError("The application name must match exactly.", 400, "confirm_mismatch"),
    );
    const wrapper = mountDialog();

    await wrapper.get("#application-delete-confirm").setValue("alpha");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(toasts().map((toast) => toast.message)).toContain(
      "The application name must match exactly.",
    );
    expect(wrapper.get("dialog").attributes("open")).toBeDefined();
  });

  it("shows a busy state while deletion is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.apiMutation.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const wrapper = mountDialog();

    await wrapper.get("#application-delete-confirm").setValue("alpha");
    await wrapper.get("form").trigger("submit");
    await nextTick();

    expect(wrapper.get("button[type='submit']").text()).toContain("Deleting…");
    expect(wrapper.get("button[type='submit']").attributes("disabled")).toBeDefined();

    finish({ deleted: true, kind: "app", projectId: "p", warnings: [] });
    await flushPromises();
    expect(wrapper.get("button[type='submit']").text()).toContain("Delete application");
  });

  it("uses the project retry contract for a pending project deletion", () => {
    const wrapper = mountDialog({
      projectDeleting: true,
      pending: true,
      action: "/api/projects/p/delete",
      confirmName: "E2E Project One",
      dialog: "project",
      title: "Retry project deletion?",
      description: "This removes every application in the project.",
      actionLabel: "Retry deletion",
      statusLabel: "Project deletion incomplete",
    });

    expect(wrapper.get("#application-delete-title").text()).toBe("Retry project deletion?");
    expect(wrapper.text()).toContain("Type E2E Project One to confirm");
    expect(wrapper.text()).toContain("The project name must match exactly.");
    expect(wrapper.get("button[type='submit']").text()).toContain("Retry deletion");
    expect(wrapper.find("style").exists()).toBe(false);
  });
});
