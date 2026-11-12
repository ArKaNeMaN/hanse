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
    expect(wrapper.find(".chat-text").classes()).toContain("message__body");
    expect(wrapper.find(".chat-text strong").text()).toBe("Bold");
    expect(wrapper.find(".chat-reasoning summary").text()).toContain("Thinking");
    expect(wrapper.find(".chat-reasoning summary .icon").exists()).toBe(true);
    expect(wrapper.find(".chat-reasoning__text").text()).toContain("I should inspect the output.");
    expect(wrapper.findAll('[data-part-id="p1"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it("renders long unbroken tokens inside the shared message body wrapper", async () => {
    const token = `https://example.invalid/${"a".repeat(240)}`;
    const wrapper = render([
      part({ id: "long", type: "text", text: token, data: { text: token } }),
    ]);
    await nextTick();
    const body = wrapper.find('[data-part-id="long"]');
    expect(body.classes()).toContain("message__body");
    expect(body.text()).toContain("a".repeat(240));
    wrapper.unmount();
  });

  it("shows the sender label and time on normal messages", async () => {
    const wrapper = mount(ChatMessage, {
      props: {
        appKey: "alpha",
        record: message({
          id: "m-meta",
          role: "assistant",
          time: { created: 1_760_000_002_000 },
          parts: [part({ id: "meta", type: "text", text: "Reply", data: { text: "Reply" } })],
        }),
      },
    });
    await nextTick();
    expect(wrapper.find("[data-message-role]").text()).toBe("alpha");
    expect(wrapper.find("[data-message-time]").text()).toMatch(/\d{1,2}:\d{2}/);
    expect(wrapper.find(".avatar").text()).toBe("AL");
    wrapper.unmount();
  });

  it("labels operator messages and omits a missing time", async () => {
    const wrapper = render(
      [part({ id: "user", type: "text", text: "Hello", data: { text: "Hello" } })],
      { role: "user" },
    );
    await nextTick();
    expect(wrapper.find("[data-message-role]").text()).toBe("operator");
    expect(wrapper.find("[data-message-time]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("marks user messages with the legacy bubble class", async () => {
    const wrapper = render(
      [part({ id: "user", type: "text", text: "Hello", data: { text: "Hello" } })],
      { role: "user" },
    );
    await nextTick();
    expect(wrapper.classes()).toContain("message--user");
    expect(wrapper.find(".message__body").classes()).toContain("message__body");
    wrapper.unmount();
  });

  it("renders a thread handoff without the operator bubble, meta row, or parts", async () => {
    const wrapper = render(
      [
        part({
          id: "thread",
          type: "text",
          text: "Envelope text",
          data: { text: "Envelope text" },
        }),
      ],
      {
        role: "user",
        handoff: {
          id: "handoff_thread",
          direction: "request",
          agent: "alpha",
          from: "alpha",
          to: "beta",
          summary: "Reconcile invoice totals",
          body: "The March totals still disagree by 0.02.",
          note: "",
          outcome: null,
          replyState: "none",
          mode: "thread",
          kind: "message",
          authorSide: "source",
          messageId: 17,
          seq: 5,
        },
      },
    );
    await nextTick();
    expect(wrapper.classes()).toContain("message--handoff");
    expect(wrapper.classes()).not.toContain("message--user");
    expect(wrapper.find("[data-message-meta]").exists()).toBe(false);
    expect(wrapper.find("[data-part-id]").exists()).toBe(false);
    expect(wrapper.find("[data-handoff-card][data-mode='thread']").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Envelope text");
    wrapper.unmount();
  });

  it("renders tool, file, and subtask views while hiding patch parts", async () => {
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
    const patch = wrapper.find('[data-part-type="patch"]');
    expect(patch.exists()).toBe(true);
    expect(patch.isVisible()).toBe(false);
    expect(patch.text()).toBe("");
    expect(wrapper.find('[data-part-type="file"]').text()).toContain("src/file.ts");
    expect(wrapper.find('[data-part-type="subtask"]').text()).toContain("Review the change");
    wrapper.unmount();
  });

  it("labels a truncated file part as unavailable inline content", async () => {
    const wrapper = render([
      part({
        id: "file-truncated",
        type: "file",
        data: { filename: "shot.png", truncated: true },
      }),
    ]);
    await nextTick();
    const detail = wrapper.find('[data-part-type="file"]');
    expect(detail.find("pre").text()).toBe("Inline content is not available.");
    expect(detail.text()).not.toContain("No output");
    wrapper.unmount();
  });

  it("labels a non-truncated file part as no preview", async () => {
    const wrapper = render([
      part({
        id: "file-preview",
        type: "file",
        data: { filename: "notes.txt" },
      }),
    ]);
    await nextTick();
    expect(wrapper.find('[data-part-type="file"] pre').text()).toBe("No preview");
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

  it("hides synthetic attachment-manifest and read-tool text parts", async () => {
    const wrapper = render([
      part({ id: "visible", type: "text", text: "Visible reply", data: { text: "Visible reply" } }),
      part({
        id: "manifest",
        type: "text",
        text: "Attached files (use these paths...):\n- /tmp/a.txt",
        data: {
          text: "Attached files (use these paths...):\n- /tmp/a.txt",
          synthetic: true,
          metadata: { hanse: "attachment-manifest" },
        },
      }),
      part({
        id: "read-synthetic",
        type: "text",
        text: "Called the Read tool with the following input: {}",
        data: {
          text: "Called the Read tool with the following input: {}",
          synthetic: true,
        },
      }),
    ]);
    await nextTick();
    expect(wrapper.findAll(".chat-text")).toHaveLength(1);
    expect(wrapper.text()).toContain("Visible reply");
    expect(wrapper.text()).not.toContain("Attached files (use these paths...)");
    expect(wrapper.text()).not.toContain("Called the Read tool");
    wrapper.unmount();
  });
});
