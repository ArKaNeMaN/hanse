import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SafeMarkdown from "./SafeMarkdown.vue";

describe("SafeMarkdown", () => {
  it("renders Markdown into the container without HTML injection", () => {
    const wrapper = mount(SafeMarkdown, {
      props: { text: "# Heading\n\nA **bold** value and `code`.", class: "prose handoff-md" },
    });

    expect(wrapper.element.tagName).toBe("DIV");
    expect(wrapper.classes()).toEqual(["prose", "handoff-md"]);
    expect(wrapper.find("h3").text()).toBe("Heading");
    expect(wrapper.find("strong").text()).toBe("bold");
    expect(wrapper.find("code").text()).toBe("code");
  });

  it("replaces nodes when the text changes", async () => {
    const wrapper = mount(SafeMarkdown, { props: { text: "First **paragraph**." } });

    expect(wrapper.findAll("p")).toHaveLength(1);
    expect(wrapper.find("strong").text()).toBe("paragraph");

    await wrapper.setProps({ text: "Second `value`." });

    expect(wrapper.findAll("p")).toHaveLength(1);
    expect(wrapper.text()).toBe("Second value.");
    expect(wrapper.find("strong").exists()).toBe(false);
    expect(wrapper.find("code").text()).toBe("value");
  });

  it("does not duplicate nodes when the same text is rendered again", async () => {
    const wrapper = mount(SafeMarkdown, { props: { text: "# Stable\n\nOne paragraph." } });

    const initial = wrapper.element.childNodes.length;
    expect(initial).toBe(2);

    await wrapper.setProps({ text: "# Stable\n\nOne paragraph." });

    expect(wrapper.element.childNodes.length).toBe(initial);
    expect(wrapper.findAll("h3")).toHaveLength(1);
    expect(wrapper.findAll("p")).toHaveLength(1);
  });
});
