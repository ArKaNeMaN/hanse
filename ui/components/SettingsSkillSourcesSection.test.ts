import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSourceView, SyncResult } from "../skill-sources-types.js";
import { useToastStore } from "../stores/toasts.js";
import SettingsSkillSourcesSection from "./SettingsSkillSourcesSection.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

function source(overrides: Partial<SkillSourceView> = {}): SkillSourceView {
  return {
    id: "source-1",
    slug: "team-hub",
    name: "Team hub",
    kind: "skills-hub",
    endpoint: "https://hub.example.test/api",
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
    skillCount: 4,
    totalBytes: 2048,
    stale: false,
    ...overrides,
  };
}

function syncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    changed: false,
    snapshotId: "snap-1",
    revision: "abcdef1234567890",
    skillCount: 4,
    totalBytes: 2048,
    state: "ready",
    ...overrides,
  };
}

function mountSection(): VueWrapper {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return mount(SettingsSkillSourcesSection, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }]] },
  });
}

function toasts() {
  return useToastStore().toasts;
}

function buttonText(wrapper: VueWrapper, label: string) {
  return wrapper.findAll("button").find((entry) => entry.text().includes(label));
}

beforeEach(() => {
  mocks.apiQuery.mockReset();
  mocks.apiMutation.mockReset();
  mocks.apiQuery.mockResolvedValue({ sources: [] });
});

describe("SettingsSkillSourcesSection", () => {
  it("shows the empty state after loading", async () => {
    const wrapper = mountSection();
    await flushPromises();

    expect(wrapper.text()).toContain("No skill sources");
    expect(buttonText(wrapper, "Add source")).toBeDefined();
    expect(wrapper.html()).not.toContain("<style");
  });

  it("renders status, stale/pinned badges, revision, counts, and error", async () => {
    mocks.apiQuery.mockResolvedValue({
      sources: [
        source({
          mode: "pinned",
          stale: true,
          skillCount: 4,
          totalBytes: 2048,
          lastErrorCode: "deletion_guard",
          lastErrorMessage: "Cleanup pending.",
        }),
      ],
    });
    const wrapper = mountSection();
    await flushPromises();

    const row = wrapper.get('[data-skill-source="team-hub"]');
    expect(row.text()).toContain("Ready");
    expect(row.text()).toContain("Stale");
    expect(row.text()).toContain("Pinned");
    expect(row.text()).toContain("abcdef1");
    expect(row.text()).toContain("4 · 2.0 KB");
    expect(row.text()).toContain("Cleanup pending.");
    expect(row.text()).toContain("hub.example.test");
    expect(row.text()).toContain("Force sync");
  });

  it("runs the primary sync and keeps a check result inline", async () => {
    mocks.apiQuery.mockResolvedValue({ sources: [source()] });
    mocks.apiMutation.mockResolvedValue({ result: syncResult() });
    const wrapper = mountSection();
    await flushPromises();

    await buttonText(wrapper, "Sync now")?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skill-sources/source-1/sync", {
      json: {},
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Already up to date", tone: "success" }),
    );

    mocks.apiMutation.mockResolvedValue({
      result: {
        changed: true,
        currentSnapshotId: "snap-1",
        nextSnapshotId: "snap-2",
        revision: "next1234567890",
      },
    });
    await buttonText(wrapper, "Check for updates")?.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Update available");
    expect(wrapper.text()).toContain("next123");
  });

  it("creates a source then runs the first sync", async () => {
    mocks.apiMutation
      .mockResolvedValueOnce({ source: source() })
      .mockResolvedValueOnce({ result: syncResult({ changed: true, skillCount: 3 }) });
    const wrapper = mountSection();
    await flushPromises();

    await buttonText(wrapper, "Add source")?.trigger("click");
    await flushPromises();
    await wrapper.get("#skill-source-name").setValue("Team hub");
    await wrapper.get("#skill-source-endpoint").setValue("https://hub.example.test");
    await wrapper.get(".skill-source-dialog form").trigger("submit");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenNthCalledWith(1, "/api/skill-sources", {
      json: expect.objectContaining({
        action: "create",
        name: "Team hub",
        slug: "team-hub",
        endpoint: "https://hub.example.test",
        config: { buckets: [], allowInsecureHttp: false },
      }),
    });
    expect(mocks.apiMutation).toHaveBeenNthCalledWith(2, "/api/skill-sources/source-1/sync", {
      json: {},
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Synced 3 skills · 2.0 KB", tone: "success" }),
    );
  });

  it("deletes a source after typing its slug and sends hard", async () => {
    mocks.apiQuery.mockResolvedValue({ sources: [source()] });
    mocks.apiMutation.mockResolvedValue({ ok: true });
    const wrapper = mountSection();
    await flushPromises();

    await buttonText(wrapper, "Delete")?.trigger("click");
    await flushPromises();
    const dialog = wrapper.get(".skill-source-delete-dialog");
    expect(dialog.attributes("open")).toBeDefined();
    await wrapper.get("#skill-source-delete-slug").setValue("team-hub");
    await wrapper.get(".skill-source-delete-dialog form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/skill-sources/source-1/delete", {
      json: { hard: true },
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Source deleted.", tone: "success" }),
    );
  });

  it("opens the drawer from the row title", async () => {
    mocks.apiQuery.mockImplementation((path: string) =>
      path.endsWith("/skills")
        ? Promise.resolve({ source: source(), skills: [] })
        : Promise.resolve({ sources: [source()] }),
    );
    const wrapper = mountSection();
    await flushPromises();

    await wrapper.get(".skill-source-name").trigger("click");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/skill-sources/source-1/skills");
    expect(wrapper.get(".source-drawer").text()).toContain("Summary");
    expect(wrapper.get(".source-drawer").text()).toContain("No skills in the active snapshot");
  });
});
