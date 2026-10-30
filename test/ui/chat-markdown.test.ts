import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import MarkdownBlock from "../../ui/components/chat/MarkdownBlock.vue";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("MarkdownBlock", () => {
  it("renders GFM tables through the shared capped parser", async () => {
    const wrapper = mount(MarkdownBlock, {
      props: { text: "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 2 |" },
      attachTo: document.body,
    });
    await nextTick();
    expect(wrapper.findAll("table")).toHaveLength(1);
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
    expect(wrapper.find("th").attributes("scope")).toBe("col");
    wrapper.unmount();
  });

  it("clears the previous nodes before rendering new text", async () => {
    const wrapper = mount(MarkdownBlock, { props: { text: "First paragraph", sealed: true } });
    await nextTick();
    expect(wrapper.text()).toContain("First paragraph");
    await wrapper.setProps({ text: "Second paragraph", sealed: true });
    await nextTick();
    expect(wrapper.text()).toBe("Second paragraph");
    expect(wrapper.findAll("p")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("First paragraph");
    wrapper.unmount();
  });

  it("throttles streaming renders to 50 ms and renders once on seal", async () => {
    vi.useFakeTimers();
    const wrapper = mount(MarkdownBlock, { props: { text: "a", sealed: false } });
    await nextTick();
    expect(wrapper.text()).toBe("a");

    await wrapper.setProps({ text: "ab", sealed: false });
    await nextTick();
    expect(wrapper.text()).toBe("a");
    vi.advanceTimersByTime(49);
    await nextTick();
    expect(wrapper.text()).toBe("a");
    vi.advanceTimersByTime(1);
    await nextTick();
    expect(wrapper.text()).toBe("ab");

    await wrapper.setProps({ text: "abc", sealed: false });
    await nextTick();
    await wrapper.setProps({ text: "abcd", sealed: true });
    await nextTick();
    expect(wrapper.text()).toBe("abcd");
    wrapper.unmount();
  });

  it("keeps adversarial HTML/XML as text and never creates script/image nodes", async () => {
    const text =
      '<script>alert("x")</script>\n\n<img src=x onerror="alert(1)">\n\n<system-reminder>secret</system-reminder>';
    const wrapper = mount(MarkdownBlock, { props: { text } });
    await nextTick();
    expect(wrapper.findAll("script")).toHaveLength(0);
    expect(wrapper.findAll("img")).toHaveLength(0);
    expect(wrapper.text()).toContain("<script>");
    expect(wrapper.text()).toContain("<system-reminder>");
    wrapper.unmount();
  });

  it("caps tables at 16 columns and 200 body rows", async () => {
    const tooWide = `|${Array.from({ length: 17 }, (_, index) => `c${index}`).join("|")}|\n|${Array.from(
      { length: 17 },
      () => "---",
    ).join("|")}|`;
    const wide = mount(MarkdownBlock, { props: { text: tooWide } });
    await nextTick();
    expect(wide.findAll("table")).toHaveLength(0);
    wide.unmount();

    const rows = Array.from({ length: 205 }, (_, index) => `| row ${index} |`).join("\n");
    const tall = mount(MarkdownBlock, { props: { text: `| Value |\n| --- |\n${rows}` } });
    await nextTick();
    expect(tall.findAll("tbody tr")).toHaveLength(200);
    expect(tall.text()).toContain("Table truncated to 200 rows.");
    tall.unmount();
  });
});
