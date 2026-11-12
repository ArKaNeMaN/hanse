import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import SkillSourceTokenDialog from "./SkillSourceTokenDialog.vue";

function mountDialog(mode: "replace" | "clear"): {
  wrapper: ReturnType<typeof mount>;
  submitted: string[];
} {
  const submitted: string[] = [];
  const Parent = defineComponent({
    setup() {
      return () =>
        h(SkillSourceTokenDialog, {
          open: true,
          mode,
          sourceName: "Team hub",
          onSubmit: (token: string) => submitted.push(token),
          onCancel: () => undefined,
        });
    },
  });
  return { wrapper: mount(Parent), submitted };
}

describe("SkillSourceTokenDialog", () => {
  it("requires a non-empty replacement token and clears the field after submit", async () => {
    const { wrapper, submitted } = mountDialog("replace");
    await wrapper.find(".skill-source-token-dialog form").trigger("submit");
    expect(submitted).toHaveLength(0);
    expect(wrapper.text()).toContain("Enter the new token.");

    const input = wrapper.get("#skill-source-new-token");
    await input.setValue("sentinel-token");
    await wrapper.find(".skill-source-token-dialog form").trigger("submit");
    await flushPromises();

    expect(submitted).toEqual(["sentinel-token"]);
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(wrapper.html()).not.toContain("sentinel-token");
  });

  it("confirms clearing without a token input", async () => {
    const { wrapper, submitted } = mountDialog("clear");

    expect(wrapper.find("#skill-source-new-token").exists()).toBe(false);
    expect(wrapper.text()).toContain("Background sync will fail until a new token is set.");
    await wrapper.find(".skill-source-token-dialog form").trigger("submit");
    expect(submitted).toEqual([""]);
  });
});
