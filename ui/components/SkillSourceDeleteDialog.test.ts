import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import type { SkillSourceView } from "../skill-sources-types.js";
import SkillSourceDeleteDialog from "./SkillSourceDeleteDialog.vue";

function source(): SkillSourceView {
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
    lastSuccessAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    etag: null,
    revision: "abcdef1",
    state: "ready",
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    updatedBy: "operator",
    tokenSet: true,
    tokenUpdatedAt: null,
    skillCount: 7,
    totalBytes: 12,
    stale: false,
  };
}

function mountDialog(): { wrapper: ReturnType<typeof mount>; target: { confirmed: number } } {
  const target = { confirmed: 0 };
  const Parent = defineComponent({
    setup() {
      return () =>
        h(SkillSourceDeleteDialog, {
          open: true,
          source: source(),
          busy: false,
          onConfirm: () => {
            target.confirmed += 1;
          },
          onCancel: () => undefined,
        });
    },
  });
  return { wrapper: mount(Parent), target };
}

describe("SkillSourceDeleteDialog", () => {
  it("disables the danger action until the slug matches", async () => {
    const { wrapper, target } = mountDialog();
    await flushPromises();

    const danger = wrapper.get(".skill-source-delete-dialog button.btn-danger");
    expect(danger.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("7 skills from this source");
    expect(wrapper.text()).toContain("Local skills are not deleted.");

    await wrapper.get("#skill-source-delete-slug").setValue("team-hub");
    expect(danger.attributes("disabled")).toBeUndefined();
    await wrapper.find(".skill-source-delete-dialog form").trigger("submit");
    expect(target.confirmed).toBe(1);
  });
});
