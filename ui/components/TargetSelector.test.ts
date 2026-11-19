import { type DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Target, TargetSelectorConfig, TargetsProps } from "../target-types.js";
import TargetSelector from "./TargetSelector.vue";

function catalog(): TargetsProps {
  return {
    master: {
      projectId: "p-master",
      projectName: "Hanse",
      appKey: "master",
      kind: "master",
      master: true,
    },
    projects: [
      {
        id: "p1",
        name: "Alpha",
        apps: [
          {
            projectId: "p1",
            projectName: "Alpha",
            appKey: "web",
            kind: "default",
            master: false,
          },
          {
            projectId: "p1",
            projectName: "Alpha",
            appKey: "api",
            kind: "default",
            master: false,
          },
        ],
      },
      {
        id: "p2",
        name: "Beta",
        apps: [
          {
            projectId: "p2",
            projectName: "Beta",
            appKey: "web",
            kind: "default",
            master: false,
          },
        ],
      },
      { id: "p3", name: "Empty", apps: [] },
    ],
  };
}

interface MountOptions {
  config?: TargetSelectorConfig;
  current?: Target;
  currentLabel?: string;
  catalog?: TargetsProps | null | undefined;
  loading?: boolean;
  error?: string | null;
}

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly changes: Target[];
  readonly retries: number[];
}

function mountSelector(options: MountOptions = {}): Mounted {
  const changes: Target[] = [];
  const retries: number[] = [];
  const wrapper = mount(TargetSelector, {
    props: {
      config: options.config ?? { mode: "scope", root: "global" },
      current: options.current ?? { kind: "global" },
      currentLabel: options.currentLabel ?? "Global",
      catalog: "catalog" in options ? options.catalog : catalog(),
      loading: options.loading ?? false,
      error: options.error ?? null,
    },
    attrs: {
      onChange: (target: Target) => changes.push(target),
      onRetry: () => {
        retries.push(1);
      },
    },
    attachTo: document.body,
  });
  return { wrapper, changes, retries };
}

async function openMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.get(".target-trigger").trigger("click");
  await flushPromises();
}

function optionByLabel(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const found = wrapper
    .findAll('[role="option"]')
    .find((option) => option.find(".target-option__label").text() === label);
  if (found === undefined) {
    throw new Error(`Missing option: ${label}`);
  }
  return found;
}

function optionLabels(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[role="option"]')
    .map((option) => option.find(".target-option__label").text());
}

describe("TargetSelector", () => {
  it("renders a dialog trigger and the scope tree with global, projects, and apps", async () => {
    const { wrapper } = mountSelector();
    const trigger = wrapper.get(".target-trigger");
    expect(trigger.attributes("aria-haspopup")).toBe("dialog");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get(".target-trigger__label").text()).toBe("Global");

    await openMenu(wrapper);
    const dialog = wrapper.get("dialog");
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(dialog.attributes("open")).toBe("");
    expect(dialog.element.tagName).toBe("DIALOG");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-label")).toBe("Choose target");

    const labels = optionLabels(wrapper);
    expect(labels).toContain("Global");
    expect(labels).toContain("Alpha");
    expect(labels).toContain("api");
    expect(labels).toContain("Beta");
    expect(labels).toContain("Empty");
    expect(labels.filter((label) => label === "web")).toHaveLength(2);

    const heading = wrapper.get(".target-group");
    expect(heading.attributes("aria-hidden")).toBe("true");
  });

  it("emits project and app targets on selection and closes without navigating", async () => {
    const { wrapper, changes } = mountSelector();
    await openMenu(wrapper);

    await optionByLabel(wrapper, "Alpha").trigger("click");
    expect(changes).toEqual([{ kind: "project", projectId: "p1" }]);
    expect(wrapper.get("dialog").attributes("open")).toBeUndefined();

    await openMenu(wrapper);
    await optionByLabel(wrapper, "api").trigger("click");
    expect(changes[1]).toEqual({ kind: "app", projectId: "p1", appKey: "api" });
    expect(wrapper.findAll("a")).toHaveLength(0);
  });

  it("marks the current option selected and checks it", async () => {
    const { wrapper } = mountSelector({
      current: { kind: "project", projectId: "p2" },
      currentLabel: "Beta",
    });
    expect(wrapper.get(".target-trigger__label").text()).toBe("Beta");
    await openMenu(wrapper);

    const selected = optionByLabel(wrapper, "Beta");
    expect(selected.attributes("aria-selected")).toBe("true");
    expect(selected.find(".target-option__check").exists()).toBe(true);
    expect(optionByLabel(wrapper, "Alpha").attributes("aria-selected")).toBe("false");
  });

  it("renders the current label before the catalog resolves and after an error", () => {
    const variants: MountOptions[] = [
      { catalog: undefined, loading: true, currentLabel: "Beta" },
      { catalog: null, error: "Could not load targets", currentLabel: "Beta" },
      { catalog: undefined, currentLabel: "Beta" },
    ];
    for (const variant of variants) {
      const { wrapper } = mountSelector(variant);
      expect(wrapper.get(".target-trigger__label").text()).toBe("Beta");
    }
  });

  it("filters options and selects the active option with ArrowDown and Enter", async () => {
    const { wrapper, changes } = mountSelector();
    await openMenu(wrapper);

    const input = wrapper.get('[role="combobox"]');
    expect(input.attributes("aria-expanded")).toBe("true");
    expect(input.attributes("aria-autocomplete")).toBe("list");
    expect(input.attributes("aria-controls")).toBe(
      wrapper.get('[role="listbox"]').attributes("id"),
    );

    await input.setValue("api");
    expect(optionLabels(wrapper)).toEqual(["api"]);
    expect(input.attributes("aria-activedescendant")).toBe("target-option-0");

    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Enter" });
    expect(changes).toEqual([{ kind: "app", projectId: "p1", appKey: "api" }]);
  });

  it("filters by project name and project / app text", async () => {
    const { wrapper } = mountSelector();
    await openMenu(wrapper);
    const input = wrapper.get('[role="combobox"]');

    await input.setValue("beta");
    expect(optionLabels(wrapper)).toEqual(["Beta", "web"]);
    expect(wrapper.text()).not.toContain("Alpha");

    await input.setValue("beta / web");
    expect(optionLabels(wrapper)).toEqual(["web"]);
  });

  it("moves to the last and first options with End and Home", async () => {
    const { wrapper, changes } = mountSelector();
    await openMenu(wrapper);
    let input = wrapper.get('[role="combobox"]');

    await input.trigger("keydown", { key: "End" });
    await input.trigger("keydown", { key: "Enter" });
    expect(changes[0]).toEqual({ kind: "project", projectId: "p3" });

    await openMenu(wrapper);
    input = wrapper.get('[role="combobox"]');
    await input.trigger("keydown", { key: "Home" });
    await input.trigger("keydown", { key: "Enter" });
    expect(changes[1]).toEqual({ kind: "global" });
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { wrapper } = mountSelector();
    await openMenu(wrapper);
    const input = wrapper.get('[role="combobox"]').element as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    await wrapper.get('[role="combobox"]').trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(wrapper.get("dialog").attributes("open")).toBeUndefined();
    expect(document.activeElement).toBe(wrapper.get(".target-trigger").element);
  });

  it("closes when the dialog scrim is clicked", async () => {
    const { wrapper } = mountSelector();
    await openMenu(wrapper);

    await wrapper.get("dialog").trigger("click");
    await flushPromises();
    expect(wrapper.get("dialog").attributes("open")).toBeUndefined();
  });

  it("shows a loading state and keeps the trigger label", async () => {
    const { wrapper } = mountSelector({ catalog: null, loading: true });
    await openMenu(wrapper);
    expect(wrapper.text()).toContain("Loading targets…");
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    expect(wrapper.get(".target-trigger__label").text()).toBe("Global");
  });

  it("shows an error with Retry and emits retry", async () => {
    const { wrapper, retries } = mountSelector({ catalog: null, error: "Could not load targets" });
    await openMenu(wrapper);
    expect(wrapper.text()).toContain("Could not load targets");

    const retry = wrapper.findAll("button").find((button) => button.text().includes("Retry"));
    if (retry === undefined) {
      throw new Error("Missing Retry button");
    }
    await retry.trigger("click");
    expect(retries).toHaveLength(1);
  });

  it("keeps the current label and hints when the current target is absent", async () => {
    const { wrapper } = mountSelector({
      current: { kind: "project", projectId: "gone" },
      currentLabel: "Ghost project",
    });
    await openMenu(wrapper);

    expect(wrapper.get(".target-trigger__label").text()).toBe("Ghost project");
    expect(wrapper.text()).toContain("Current target is not in the catalog");
    expect(wrapper.find("[data-target-current-missing]").exists()).toBe(true);
    expect(
      wrapper
        .findAll('[role="option"]')
        .every((option) => option.attributes("aria-selected") === "false"),
    ).toBe(true);
  });

  it("shows an empty state when no catalog is available", async () => {
    const { wrapper } = mountSelector({ catalog: null });
    await openMenu(wrapper);
    expect(wrapper.find("[data-target-empty]").text()).toContain("No targets available");
  });

  it("renders options as buttons with no nested interactive controls", async () => {
    const { wrapper } = mountSelector();
    await openMenu(wrapper);
    const options = wrapper.findAll('[role="option"]');
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(option.element.tagName).toBe("BUTTON");
      expect(option.attributes("type")).toBe("button");
      expect(option.element.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);
    }
  });

  describe("apps mode", () => {
    it("offers the master root and flat apps grouped by project", async () => {
      const { wrapper, changes } = mountSelector({
        config: { mode: "apps", root: "master" },
        current: { kind: "app", projectId: "p-master", appKey: "master", master: true },
        currentLabel: "Master",
      });
      await openMenu(wrapper);

      const labels = optionLabels(wrapper);
      expect(labels[0]).toBe("Master");
      expect(labels).toContain("api");
      expect(labels.filter((label) => label === "web")).toHaveLength(2);
      expect(wrapper.findAll(".target-group").map((group) => group.text())).toEqual([
        "Alpha",
        "Beta",
      ]);

      const repeated = wrapper
        .findAll('[role="option"]')
        .filter((option) => option.find(".target-option__label").text() === "web");
      expect(repeated.map((option) => option.find(".target-option__subtitle").text())).toEqual([
        "Alpha",
        "Beta",
      ]);

      await optionByLabel(wrapper, "Master").trigger("click");
      expect(changes).toEqual([
        { kind: "app", projectId: "p-master", appKey: "master", master: true },
      ]);
    });

    it("offers the all-applications root", async () => {
      const { wrapper, changes } = mountSelector({ config: { mode: "apps", root: "all" } });
      await openMenu(wrapper);

      await optionByLabel(wrapper, "All applications").trigger("click");
      expect(changes).toEqual([{ kind: "all" }]);
    });

    it("shows only the fixed project's apps without a root or project heading", async () => {
      const { wrapper, changes } = mountSelector({
        config: { mode: "apps", root: "all", fixedProjectId: "p2" },
      });
      await openMenu(wrapper);

      expect(optionLabels(wrapper)).toEqual(["web"]);
      expect(wrapper.findAll(".target-group")).toHaveLength(0);
      expect(wrapper.text()).not.toContain("All applications");

      await optionByLabel(wrapper, "web").trigger("click");
      expect(changes).toEqual([{ kind: "app", projectId: "p2", appKey: "web" }]);
    });

    it("has no root option when root is null", async () => {
      const { wrapper } = mountSelector({ config: { mode: "apps", root: null } });
      await openMenu(wrapper);

      const labels = optionLabels(wrapper);
      expect(labels).not.toContain("Master");
      expect(labels).not.toContain("All applications");
      expect(labels).toContain("api");
    });
  });

  describe("projects mode", () => {
    it("offers all projects plus project rows only", async () => {
      const { wrapper, changes } = mountSelector({ config: { mode: "projects" } });
      await openMenu(wrapper);

      expect(optionLabels(wrapper)).toEqual(["All projects", "Alpha", "Beta", "Empty"]);

      await optionByLabel(wrapper, "All projects").trigger("click");
      expect(changes[0]).toEqual({ kind: "all" });

      await openMenu(wrapper);
      await optionByLabel(wrapper, "Alpha").trigger("click");
      expect(changes[1]).toEqual({ kind: "project", projectId: "p1" });
    });
  });
});
