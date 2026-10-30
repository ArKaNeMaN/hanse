import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import {
  applyWorkspaceShell,
  DEFAULT_VIEWPORT,
  restoreWorkspaceShell,
  useWorkspaceShell,
} from "../../ui/composables/useWorkspaceShell.js";

function shell(): void {
  document.body.innerHTML =
    '<meta name="viewport" content="width=device-width, initial-scale=1" /><main id="main" class="page" tabindex="-1"></main>';
}

function main(): HTMLElement {
  return document.getElementById("main") as HTMLElement;
}

function viewport(): string | null {
  return document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null;
}

beforeEach(shell);
afterEach(() => {
  document.body.innerHTML = "";
});

describe("useWorkspaceShell", () => {
  it("applies and restores the workspace page class and viewport", () => {
    applyWorkspaceShell(
      "page--chat",
      "width=device-width, initial-scale=1, interactive-widget=resizes-content",
    );
    expect(main().classList.contains("page--chat")).toBe(true);
    expect(main().classList.contains("page")).toBe(true);
    expect(viewport()).toContain("interactive-widget=resizes-content");

    restoreWorkspaceShell(
      "page--chat",
      "width=device-width, initial-scale=1, interactive-widget=resizes-content",
    );
    expect(main().classList.contains("page--chat")).toBe(false);
    expect(main().classList.contains("page")).toBe(true);
    expect(viewport()).toBe(DEFAULT_VIEWPORT);
  });

  it("applies on mount and restores on unmount", () => {
    const Probe = defineComponent({
      setup() {
        useWorkspaceShell("page--terminal", "width=device-width, initial-scale=1");
        return () => h("div");
      },
    });
    const wrapper = mount(Probe, { attachTo: document.body });
    expect(main().classList.contains("page--terminal")).toBe(true);
    wrapper.unmount();
    expect(main().classList.contains("page--terminal")).toBe(false);
  });
});
