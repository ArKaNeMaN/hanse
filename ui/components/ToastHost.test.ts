import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { useToastStore } from "../stores/toasts.js";
import ToastHost from "./ToastHost.vue";

function region(): HTMLElement {
  const element = document.getElementById("toast-region");
  if (element === null) {
    throw new Error("toast region missing");
  }
  return element;
}

describe("ToastHost", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast-region"></div>';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("teleports the boot notice into the shell toast region", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(ToastHost, {
      props: { notice: { message: "Project created.", tone: "success" } },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await nextTick();

    expect(region().textContent).toContain("Project created.");
    expect(region().querySelector('[role="status"]')).not.toBeNull();
    expect(region().querySelector('[data-autodismiss="6000"]')).not.toBeNull();

    wrapper.unmount();
  });

  it("renders an error toast and dismisses it from the close button", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(ToastHost, {
      global: { plugins: [pinia] },
      attachTo: document.body,
    });

    useToastStore().push("Could not save.", "error");
    await nextTick();

    const alert = region().querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.hasAttribute("data-autodismiss")).toBe(false);

    const button = alert?.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("dismiss button missing");
    }
    button.click();
    await nextTick();

    expect(region().textContent).not.toContain("Could not save.");
    wrapper.unmount();
  });

  it("autodismisses a success toast after six seconds", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(ToastHost, {
      global: { plugins: [pinia] },
      attachTo: document.body,
    });

    useToastStore().push("Saved.");
    await nextTick();
    expect(region().textContent).toContain("Saved.");

    vi.advanceTimersByTime(6000);
    await nextTick();

    expect(region().textContent).not.toContain("Saved.");
    wrapper.unmount();
  });
});
