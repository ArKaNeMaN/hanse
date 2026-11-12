import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { SkillSourceView, SnapshotSkill } from "../skill-sources-types.js";
import { externalRow } from "../skills-fixtures.js";
import ExternalSkillDrawer from "./ExternalSkillDrawer.vue";

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
    lastAttemptAt: null,
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
    tokenSet: false,
    tokenUpdatedAt: null,
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
    description: "Published by the team skills hub.",
    version: "1.0.0",
    contentHash: "hash",
    skillMdSha256: "sha",
    files: [{ path: "SKILL.md", sha256: "a".repeat(64), size: 128 }],
    state: "ok",
    errorCode: null,
    errorMessage: null,
  };
}

function mountDrawer(): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/settings", name: "settings-global", component: { template: "<div />" } }],
  });
  return mount(ExternalSkillDrawer, {
    props: { open: false, row: externalRow() },
    global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] },
  });
}

beforeEach(() => {
  mocks.apiQuery.mockReset();
});

describe("ExternalSkillDrawer", () => {
  it("renders a read-only banner and previews a text file", async () => {
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

    expect(wrapper.text()).toContain("This skill is provided by Team hub");
    expect(wrapper.text()).toContain("Manage source");
    expect(wrapper.find("button").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Fork");
    expect(wrapper.text()).not.toContain("Disable");

    const file = wrapper
      .findAll(".skill-source-file-list button")
      .find((entry) => entry.text().includes("SKILL.md"));
    await file?.trigger("click");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith(expect.stringContaining("snapshotId=snap-1"));
    expect(wrapper.get("pre.skill-source-preview__text").text()).toContain("# Release checklist");
  });

  it("shows binary metadata only", async () => {
    mocks.apiQuery.mockImplementation((path: string) =>
      path.endsWith("/skills")
        ? Promise.resolve({ source: source(), skills: [skill()] })
        : Promise.resolve({
            path: "SKILL.md",
            size: 128,
            sha256: "d".repeat(64),
            encoding: "binary",
          }),
    );
    const wrapper = mountDrawer();
    await wrapper.setProps({ open: true });
    await flushPromises();

    const file = wrapper
      .findAll(".skill-source-file-list button")
      .find((entry) => entry.text().includes("SKILL.md"));
    await file?.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Binary file");
    expect(wrapper.text()).toContain("dddddddddddd");
    expect(wrapper.find("pre.skill-source-preview__text").exists()).toBe(false);
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
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/settings", name: "settings-global", component: { template: "<div />" } }],
    });
    const wrapper = mount(ExternalSkillDrawer, {
      props: { open: false, row: externalRow() },
      global: { plugins: [pinia, router, [VueQueryPlugin, { queryClient }]] },
    });
    await wrapper.setProps({ open: true });
    await flushPromises();

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

  it("shows the gone state when the skill is no longer in the snapshot", async () => {
    mocks.apiQuery.mockResolvedValue({ source: source(), skills: [] });
    const wrapper = mountDrawer();
    await wrapper.setProps({ open: true });
    await flushPromises();

    expect(wrapper.text()).toContain("This skill is no longer in the active snapshot");
    expect(wrapper.text()).toContain("Manage source");
  });
});
