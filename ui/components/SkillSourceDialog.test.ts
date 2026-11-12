import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import type { SkillSourceDialogPayload, SkillSourceView } from "../skill-sources-types.js";
import SkillSourceDialog from "./SkillSourceDialog.vue";

function editSource(): SkillSourceView {
  return {
    id: "source-1",
    slug: "team-hub",
    name: "Team hub",
    kind: "skills-hub",
    endpoint: "https://hub.example.test",
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
    skillCount: 1,
    totalBytes: 12,
    stale: false,
  };
}

function mountDialog(options: { mode: "create" | "edit"; source?: SkillSourceView | null }): {
  wrapper: ReturnType<typeof mount>;
  submitted: SkillSourceDialogPayload[];
} {
  const submitted: SkillSourceDialogPayload[] = [];
  const Parent = defineComponent({
    setup() {
      return () =>
        h(SkillSourceDialog, {
          open: true,
          mode: options.mode,
          source: options.source ?? null,
          onSubmit: (payload: SkillSourceDialogPayload) => submitted.push(payload),
          onCancel: () => undefined,
        });
    },
  });
  return { wrapper: mount(Parent), submitted };
}

describe("SkillSourceDialog", () => {
  it("derives the slug from the name and emits a complete create payload", async () => {
    const { wrapper, submitted } = mountDialog({ mode: "create" });
    await wrapper.get("#skill-source-name").setValue("Team hub");
    await flushPromises();
    expect((wrapper.get("#skill-source-slug").element as HTMLInputElement).value).toBe("team-hub");

    await wrapper.get("#skill-source-endpoint").setValue("https://hub.example.test");
    await wrapper.find(".skill-source-dialog form").trigger("submit");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      name: "Team hub",
      slug: "team-hub",
      endpoint: "https://hub.example.test",
      buckets: [],
      allowInsecureHttp: false,
      token: null,
      priority: 100,
      syncIntervalSec: 900,
      staleAfterSec: 86400,
      requestTimeoutMs: 15000,
    });
  });

  it("does not submit when a non-ASCII name leaves the slug empty", async () => {
    const { wrapper, submitted } = mountDialog({ mode: "create" });
    await wrapper.get("#skill-source-name").setValue("团队技能");
    await flushPromises();
    expect((wrapper.get("#skill-source-slug").element as HTMLInputElement).value).toBe("");

    await wrapper.get("#skill-source-endpoint").setValue("https://hub.example.test");
    await wrapper.find(".skill-source-dialog form").trigger("submit");

    expect(submitted).toHaveLength(0);
    expect(wrapper.text()).toContain("Slug must use lowercase letters");
  });

  it("requires the insecure-HTTP acknowledgement for an http endpoint", async () => {
    const { wrapper, submitted } = mountDialog({ mode: "create" });
    await wrapper.get("#skill-source-name").setValue("LAN hub");
    await wrapper.get("#skill-source-endpoint").setValue("http://hub.lan.test");
    await wrapper.find(".skill-source-dialog form").trigger("submit");
    expect(submitted).toHaveLength(0);
    expect(wrapper.text()).toContain("Enable insecure HTTP");

    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.find(".skill-source-dialog form").trigger("submit");
    expect(submitted[0]).toMatchObject({ allowInsecureHttp: true });
  });

  it("edits without slug or token fields and keeps the slug", async () => {
    const { wrapper, submitted } = mountDialog({ mode: "edit", source: editSource() });
    await flushPromises();

    expect(wrapper.find("#skill-source-slug").exists()).toBe(false);
    expect(wrapper.find("#skill-source-token").exists()).toBe(false);
    expect((wrapper.get("#skill-source-name").element as HTMLInputElement).value).toBe("Team hub");

    await wrapper.find(".skill-source-dialog form").trigger("submit");
    expect(submitted[0]).toMatchObject({
      slug: "team-hub",
      buckets: ["default"],
      token: null,
    });
  });
});
