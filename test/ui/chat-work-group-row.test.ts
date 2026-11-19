import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import type { ChatWorkGroupView } from "../../ui/chat/types.js";
import ChatWorkGroup from "../../ui/components/chat/ChatWorkGroup.vue";
import { part } from "./chat-render-support.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function buildGroup(): ChatWorkGroupView {
  return {
    id: "work-group:r1",
    parts: [
      part({
        id: "r1",
        type: "reasoning",
        text: "Consider the options.",
        data: { text: "Consider the options." },
      }),
      part({
        id: "t1",
        type: "tool",
        status: "completed",
        data: { tool: "bash", state: { status: "completed", output: "ok" } },
      }),
      part({
        id: "t2",
        type: "tool",
        status: "completed",
        data: { tool: "read", state: { status: "completed", output: "done" } },
      }),
    ],
    toolCount: 2,
    reasoningCount: 1,
    hasError: false,
    metricsText: "2 tool calls · 1 thought",
  };
}

describe("ChatWorkGroup", () => {
  it("renders a collapsed summary with counters and reveals contained rows", async () => {
    const group = buildGroup();
    const wrapper = mount(ChatWorkGroup, { props: { group } });
    await nextTick();

    const details = wrapper.find("details.chat-work-group");
    expect(details.exists()).toBe(true);
    expect(details.attributes("data-work-group-id")).toBe(group.id);
    expect((details.element as HTMLDetailsElement).open).toBe(false);

    const summary = wrapper.find("summary").text();
    expect(summary).toContain("Working");
    expect(summary).toContain("2 tool calls");
    expect(summary).toContain("1 thought");

    const body = wrapper.find(".chat-work-group__body");
    expect(body.findAll('[data-part-type="reasoning"]')).toHaveLength(1);
    expect(body.findAll('[data-part-type="tool"]')).toHaveLength(2);

    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle");
    expect((details.element as HTMLDetailsElement).open).toBe(true);
    expect(body.findAll(".chat-reasoning")).toHaveLength(1);

    wrapper.unmount();
  });
});
