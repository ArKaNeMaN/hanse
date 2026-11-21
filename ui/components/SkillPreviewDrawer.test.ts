import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { ApiError } from "../api.js";
import { detail, legacyDetail, row } from "../skills-fixtures.js";
import type { SkillsInventoryRowProps } from "../skills-types.js";
import SkillPreviewDrawer from "./SkillPreviewDrawer.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery };
});

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly closes: number[];
}

function mountDrawer(
  options: { open?: boolean; row?: SkillsInventoryRowProps | null; from?: string } = {},
): Mounted {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/skills", name: "skills-global", component: { template: "<div />" } },
      { path: "/skills/:id", name: "skills-detail", component: { template: "<div />" } },
    ],
  });
  const closes: number[] = [];
  const wrapper = mount(SkillPreviewDrawer, {
    props: {
      open: options.open ?? false,
      row: options.row ?? row(),
      from: options.from ?? "/skills",
    },
    attrs: {
      onClose: () => {
        closes.push(1);
      },
    },
    global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] },
    attachTo: document.body,
  });
  return { wrapper, closes };
}

const ENDPOINT = `/api/ui/skills/7?from=${encodeURIComponent("/skills")}`;

beforeEach(() => {
  mocks.apiQuery.mockReset();
  document.body.innerHTML = "";
});

describe("SkillPreviewDrawer", () => {
  it("fetches the detail with the row primary id and the decoded scope path", async () => {
    mocks.apiQuery.mockResolvedValue(detail());
    const { wrapper } = mountDrawer({ open: false });

    expect(mocks.apiQuery).not.toHaveBeenCalled();

    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith(ENDPOINT);
    expect(wrapper.text()).toContain("alpha-skill");
  });

  it("renders content, metadata, and file sizes from the detail response", async () => {
    mocks.apiQuery.mockResolvedValue(
      detail({
        values: {
          name: "alpha-skill",
          description: "Alpha skill used by the fixture.",
          content: "## Body\n\nSynthetic content only.",
          enabled: true,
          bundle: {
            license: "MIT",
            compatibility: ">=1.0",
            metadata: { domain: "engineering", version: "1.2.3" },
            metadataRaw: null,
            references: [],
          },
        },
        files: [{ path: "references/notes.md", size: 22 }],
      }),
    );
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();

    expect(wrapper.get(".skill-preview-drawer__content").text()).toContain(
      "Synthetic content only.",
    );
    expect(wrapper.text()).toContain("MIT");
    expect(wrapper.text()).toContain(">=1.0");
    expect(wrapper.text()).toContain("engineering");
    expect(wrapper.text()).toContain("1.2.3");
    expect(wrapper.text()).toContain("references/notes.md");
    expect(wrapper.text()).toContain("22 B");
    expect(wrapper.text()).toContain("owner");
  });

  it("treats files as authoritative and appends only missing references once", async () => {
    mocks.apiQuery.mockResolvedValue(
      detail({
        files: [{ path: "references/notes.md", size: 22 }],
        values: {
          ...detail().values,
          bundle: {
            ...detail().values.bundle,
            references: [
              { path: "references/notes.md", content: "dup", size: 22 },
              { path: "references/legacy.md", content: "legacy", size: 11 },
            ],
          },
        },
      }),
    );
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();

    const paths = wrapper
      .findAll(".skill-source-file-list li .mono")
      .map((entry) => entry.text())
      .filter((text) => text.startsWith("references/"));
    expect(paths.filter((path) => path === "references/notes.md")).toHaveLength(1);
    expect(paths.filter((path) => path === "references/legacy.md")).toHaveLength(1);
  });

  it("falls back to references when a pre-v24 row has no files", async () => {
    mocks.apiQuery.mockResolvedValue(legacyDetail());
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();

    expect(wrapper.text()).toContain("references/notes.md");
    expect(wrapper.findAll(".skill-source-file-list li")).toHaveLength(1);
  });

  it("keeps invalid identity and exposes the effective source link", async () => {
    const invalid = row({
      id: 10,
      primaryId: 10,
      name: "invalid-skill",
      state: "invalid",
      stateLabel: "Invalid here",
      effectiveHref: "/skills/5?from=%2Fskills",
      effectiveId: 5,
      effectiveScope: "global",
      issues: [
        {
          code: "invalid_skill_metadata",
          message: "Broken metadata",
          anchor: "#skill-metadata-raw",
        },
      ],
      href: "/skills/10?from=%2Fskills",
    });
    mocks.apiQuery.mockResolvedValue(
      detail({
        id: 10,
        name: "invalid-skill",
        values: {
          ...detail().values,
          name: "invalid-skill",
          description: "Broken row.",
        },
        state: {
          ...detail().state,
          name: "invalid-owned",
          label: "Invalid here",
          note: "Repair this row.",
        },
      }),
    );
    const { wrapper } = mountDrawer({ open: true, row: invalid });
    await flushPromises();

    expect(wrapper.text()).toContain("Invalid here");
    const effective = wrapper.get("[data-skill-effective-link]");
    expect(effective.attributes("href")).toBe("/skills/5?from=%2Fskills");
    expect(effective.text()).toContain("Open effective source");
  });

  it("hides the effective link when the row has no effective source", async () => {
    mocks.apiQuery.mockResolvedValue(detail());
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();

    expect(wrapper.find("[data-skill-effective-link]").exists()).toBe(false);
  });

  it("navigates Open full skill to the row href", async () => {
    mocks.apiQuery.mockResolvedValue(detail());
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();

    const full = wrapper.findAll("a").find((anchor) => anchor.text().includes("Open full skill"));
    expect(full?.attributes("href")).toBe("/skills/7?from=%2Fskills");
  });

  it("shows a loading state while the detail is pending", async () => {
    mocks.apiQuery.mockReturnValue(new Promise(() => undefined));
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();

    expect(wrapper.text()).toContain("Loading skill…");
  });

  it("shows an error with Retry and recovers", async () => {
    mocks.apiQuery.mockRejectedValue(new ApiError("Skill unavailable.", 503));
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Skill unavailable.");

    mocks.apiQuery.mockResolvedValue(detail());
    const retry = wrapper.findAll("button").find((button) => button.text().includes("Retry"));
    await retry?.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(wrapper.text()).toContain("Synthetic content only.");
  });

  it("closes on scrim click and on Escape", async () => {
    mocks.apiQuery.mockResolvedValue(detail());
    const { wrapper, closes } = mountDrawer({ open: true });
    await flushPromises();

    await wrapper.get("dialog").trigger("click");
    expect(closes).toHaveLength(1);

    await wrapper.get("dialog").trigger("cancel");
    expect(closes).toHaveLength(2);
  });

  it("returns focus to the previously focused element when closed", async () => {
    mocks.apiQuery.mockResolvedValue(detail());
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.append(trigger);
    trigger.focus();
    const { wrapper } = mountDrawer({ open: false });

    await wrapper.setProps({ open: true });
    await flushPromises();
    await wrapper.setProps({ open: false });
    await flushPromises();

    expect(document.activeElement).toBe(trigger);
  });

  it("contains no forms, inputs, or mutation controls", async () => {
    mocks.apiQuery.mockResolvedValue(detail());
    const { wrapper } = mountDrawer({ open: true });
    await flushPromises();

    expect(wrapper.findAll("form, input, textarea, select")).toHaveLength(0);
    const labels = wrapper.findAll("button").map((button) => button.text().toLowerCase());
    for (const label of labels) {
      expect(label).not.toContain("save");
      expect(label).not.toContain("delete");
      expect(label).not.toContain("disable");
      expect(label).not.toContain("override");
    }
  });
});
