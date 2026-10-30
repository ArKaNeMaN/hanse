import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import ChatMessage from "../../ui/components/chat/ChatMessage.vue";
import { message, part } from "./chat-render-support.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function render(parts: ReturnType<typeof part>[], extra: Record<string, unknown> = {}) {
  return mount(ChatMessage, {
    props: { record: message({ id: "m1", role: "assistant", parts, ...extra }) },
    attachTo: document.body,
  });
}

describe("ChatMessage part surfaces", () => {
  it("renders text and reasoning without duplicating part content", async () => {
    const wrapper = render([
      part({ id: "p1", type: "text", text: "**Bold** reply", data: { text: "**Bold** reply" } }),
      part({
        id: "p2",
        type: "reasoning",
        text: "I should inspect the output.",
        data: { text: "I should inspect the output." },
      }),
    ]);
    await nextTick();
    expect(wrapper.find(".chat-text strong").text()).toBe("Bold");
    expect(wrapper.find(".chat-reasoning summary").text()).toContain("Thinking");
    expect(wrapper.find(".chat-reasoning__text").text()).toContain("I should inspect the output.");
    expect(wrapper.findAll('[data-part-id="p1"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it("renders tool, patch, file, and subtask views", async () => {
    const wrapper = render([
      part({
        id: "tool",
        type: "tool",
        status: "completed",
        data: {
          tool: "bash",
          state: { status: "completed", output: "tests passed" },
        },
      }),
      part({
        id: "patch",
        type: "patch",
        data: {
          patch: ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new"].join("\n"),
        },
      }),
      part({
        id: "file",
        type: "file",
        data: { filename: "src/file.ts", content: "export const value = 1;" },
      }),
      part({
        id: "subtask",
        type: "subtask",
        data: { description: "Review the change", prompt: "Please review" },
      }),
    ]);
    await nextTick();
    expect(wrapper.find('[data-part-type="tool"]').text()).toContain("bash");
    expect(wrapper.find('[data-part-type="tool"]').text()).toContain("tests passed");
    expect(wrapper.find('[data-part-type="patch"]').exists()).toBe(true);
    expect(wrapper.find('[data-part-type="file"]').text()).toContain("src/file.ts");
    expect(wrapper.find('[data-part-type="subtask"]').text()).toContain("Review the change");
    wrapper.unmount();
  });

  it("keeps step/retry/compaction/snapshot/agent parts hidden and shows unknown types as text", async () => {
    const wrapper = render([
      part({ id: "step", type: "step-start" }),
      part({ id: "retry", type: "retry" }),
      part({ id: "compact", type: "compaction" }),
      part({ id: "snapshot", type: "snapshot" }),
      part({ id: "agent", type: "agent" }),
      part({ id: "unknown", type: "mystery", text: "<script>x</script>" }),
    ]);
    await nextTick();
    for (const type of ["step-start", "retry", "compaction", "snapshot", "agent"]) {
      const node = wrapper.find(`[data-part-type="${type}"]`);
      if (node.exists()) {
        expect(node.isVisible()).toBe(false);
      }
    }
    expect(wrapper.text()).toContain("Unsupported content: mystery");
    expect(wrapper.findAll("script")).toHaveLength(0);
    wrapper.unmount();
  });

  it("keeps adversarial markup inside text parts as text", async () => {
    const text = '<img src=x onerror="alert(1)"> <system-reminder>private</system-reminder>';
    const wrapper = render([part({ id: "p1", type: "text", text, data: { text } })]);
    await nextTick();
    expect(wrapper.findAll("img")).toHaveLength(0);
    expect(wrapper.text()).toContain("<img src=x");
    expect(wrapper.text()).toContain("<system-reminder>");
    wrapper.unmount();
  });
});
