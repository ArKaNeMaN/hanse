import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import type { SkillSourceView, SnapshotSkill } from "../skill-sources-types.js";
import SkillSourceDrawer from "./SkillSourceDrawer.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery };
});

function source(overrides: Partial<SkillSourceView> = {}): SkillSourceView {
  return {
    id: "source-1",
    slug: "team-hub",
    name: "Team hub",
    kind: "skills-hub",
    endpoint: "https://hub.example.test",
    config: { buckets: [], allowInsecureHttp: false },
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
    totalBytes: 128,
    stale: false,
    ...overrides,
  };
}

function skill(): SnapshotSkill {
  return {
    bucket: "default",
    name: "release-checklist",
    description: "Review a release before it ships.",
    version: "1.0.0",
    contentHash: "hash",
    skillMdSha256: "sha",
    files: [{ path: "SKILL.md", sha256: "a".repeat(64), size: 128 }],
    state: "ok",
    errorCode: null,
    errorMessage: null,
  };
}

function mountDrawer(sourceId = "source-1"): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return mount(SkillSourceDrawer, {
    props: { open: false, sourceId, fallbackSource: source() },
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] },
  });
}

beforeEach(() => {
  mocks.apiQuery.mockReset();
});

describe("SkillSourceDrawer", () => {
  it("expands skills, previews a text file with the active snapshot", async () => {
    mocks.apiQuery.mockImplementation((path: string) =>
      path.endsWith("/skills")
        ? Promise.resolve({ source: source(), skills: [skill()] })
        : Promise.resolve({
            path: "SKILL.md",
            size: 128,
            sha256: "b".repeat(64),
            encoding: "text",
            text: "# Release checklist",
          }),
    );
    const wrapper = mountDrawer();
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(wrapper.get(".source-drawer").text()).toContain("Summary");
    expect(wrapper.get(".source-drawer").text()).toContain("release-checklist");

    await wrapper
      .get('[data-source-skill="release-checklist"] button.link-button')
      .trigger("click");
    const file = wrapper
      .findAll(".skill-source-file-list button")
      .find((entry) => entry.text().includes("SKILL.md"));
    await file?.trigger("click");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith(
      expect.stringContaining("/api/skill-sources/source-1/files?"),
    );
    expect(mocks.apiQuery).toHaveBeenCalledWith(expect.stringContaining("snapshotId=snap-1"));
    expect(wrapper.get("pre.skill-source-preview__text").text()).toContain("# Release checklist");
    expect(wrapper.html()).not.toContain("sentinel-token");
  });

  it("shows binary metadata only", async () => {
    mocks.apiQuery.mockImplementation((path: string) =>
      path.endsWith("/skills")
        ? Promise.resolve({ source: source(), skills: [skill()] })
        : Promise.resolve({
            path: "SKILL.md",
            size: 128,
            sha256: "c".repeat(64),
            encoding: "binary",
          }),
    );
    const wrapper = mountDrawer();
    await wrapper.setProps({ open: true });
    await flushPromises();

    await wrapper
      .get('[data-source-skill="release-checklist"] button.link-button')
      .trigger("click");
    const file = wrapper
      .findAll(".skill-source-file-list button")
      .find((entry) => entry.text().includes("SKILL.md"));
    await file?.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Binary file");
    expect(wrapper.text()).toContain("cccccccccccc");
    expect(wrapper.find("pre.skill-source-preview__text").exists()).toBe(false);
  });

  it("distinguishes disabled, never-synced, and empty snapshots", async () => {
    mocks.apiQuery.mockResolvedValue({
      source: source({
        state: "disabled",
        enabled: false,
        activeSnapshotId: null,
        lastSuccessAt: null,
      }),
      skills: [],
    });
    const disabled = mountDrawer();
    await disabled.setProps({ open: true });
    await flushPromises();
    expect(disabled.text()).toContain("Source disabled");
    expect(disabled.text()).not.toContain("Run a sync");

    mocks.apiQuery.mockResolvedValue({
      source: source({ state: "never_synced", activeSnapshotId: null, lastSuccessAt: null }),
      skills: [],
    });
    const never = mountDrawer();
    await never.setProps({ open: true });
    await flushPromises();
    expect(never.text()).toContain("No skills synced yet");

    mocks.apiQuery.mockResolvedValue({ source: source(), skills: [] });
    const empty = mountDrawer();
    await empty.setProps({ open: true });
    await flushPromises();
    expect(empty.text()).toContain("No skills in the active snapshot");
  });

  it("drops a cached preview when the active snapshot changes", async () => {
    let activeSnapshotId = "snap-1";
    mocks.apiQuery.mockImplementation((path: string) => {
      if (path.endsWith("/skills")) {
        return Promise.resolve({ source: source({ activeSnapshotId }), skills: [skill()] });
      }
      const snapshotId = new URL(path, "http://localhost").searchParams.get("snapshotId");
      return Promise.resolve({
        path: "SKILL.md",
        size: 128,
        sha256: "b".repeat(64),
        encoding: "text",
        text: `# ${snapshotId ?? ""}`,
      });
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = mount(SkillSourceDrawer, {
      props: { open: false, sourceId: "source-1", fallbackSource: source() },
      global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();

    await wrapper
      .get('[data-source-skill="release-checklist"] button.link-button')
      .trigger("click");
    const file = () =>
      wrapper
        .findAll(".skill-source-file-list button")
        .find((entry) => entry.text().includes("SKILL.md"));
    await file()?.trigger("click");
    await flushPromises();
    expect(wrapper.get("pre.skill-source-preview__text").text()).toContain("# snap-1");

    activeSnapshotId = "snap-2";
    await queryClient.invalidateQueries({ queryKey: ["skill-source-skills", "source-1"] });
    await flushPromises();
    expect(file()?.attributes("aria-expanded")).not.toBe("true");
    expect(wrapper.find("pre.skill-source-preview__text").exists()).toBe(false);

    await file()?.trigger("click");
    await flushPromises();
    expect(wrapper.get("pre.skill-source-preview__text").text()).toContain("# snap-2");
  });

  it("reports credential actions without rendering a token value", async () => {
    mocks.apiQuery.mockResolvedValue({ source: source(), skills: [] });
    const actions: string[] = [];
    const Parent = defineComponent({
      setup() {
        return () =>
          h(SkillSourceDrawer, {
            open: true,
            sourceId: "source-1",
            fallbackSource: source(),
            onAction: (action: string) => actions.push(action),
            onClose: () => undefined,
          });
      },
    });
    const wrapper = mount(Parent, {
      global: {
        plugins: [
          createPinia(),
          [
            VueQueryPlugin,
            { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          ],
        ],
      },
    });
    setActivePinia(createPinia());
    await flushPromises();

    const replace = wrapper.findAll("button").find((entry) => entry.text() === "Replace token");
    await replace?.trigger("click");
    expect(actions).toEqual(["replace-token"]);
    expect(wrapper.text()).toContain("Token:");
    expect(wrapper.text()).toContain("Set");
    expect(wrapper.html()).not.toContain("token-value");
  });
});
