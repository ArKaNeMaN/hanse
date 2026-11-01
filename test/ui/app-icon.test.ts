import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AppIcon from "../../ui/components/AppIcon.vue";

describe("AppIcon", () => {
  it("gives local paths the same 24-unit viewBox as the sprite", () => {
    const wrapper = mount(AppIcon, { props: { name: "stop" } });
    expect(wrapper.find("svg").attributes("viewBox")).toBe("0 0 24 24");
    expect(wrapper.find("path").attributes("d")).toContain("M7 5h10");
    wrapper.unmount();
  });

  it("keeps the viewBox on sprite references", () => {
    const wrapper = mount(AppIcon, { props: { name: "send" } });
    expect(wrapper.find("svg").attributes("viewBox")).toBe("0 0 24 24");
    expect(wrapper.find("use").exists()).toBe(true);
    wrapper.unmount();
  });
});
