import { type DOMWrapper, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { createTranscriptMemory } from "../../ui/chat/transcript-memory.js";
import type { ChatThreadItem, ChatWorkGroupView } from "../../ui/chat/types.js";
import ChatThread from "../../ui/components/chat/ChatThread.vue";
import ChatWorkGroup from "../../ui/components/chat/ChatWorkGroup.vue";
import { detailProvide } from "./chat-detail-scope.js";
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

function buildSessionGroup(suffix: string): ChatWorkGroupView {
  const group = buildGroup();
  return {
    ...group,
    id: `work-group:${suffix}`,
    parts: group.parts.map((entry) => ({ ...entry, id: `${suffix}-${entry.id}` })),
  };
}

function groupItems(group: ChatWorkGroupView): ChatThreadItem[] {
  return [{ type: "work-group", group }];
}

async function setDetailsOpen(details: DOMWrapper<Element>, open: boolean) {
  const element = details.element as HTMLDetailsElement;
  element.open = open;
  await details.trigger("toggle");
  await nextTick();
}

describe("ChatWorkGroup", () => {
  it("keeps the body out of the DOM until the group is opened", async () => {
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
    expect(wrapper.find(".chat-work-group__body").exists()).toBe(false);
    expect(wrapper.findAll('[data-part-type="reasoning"]')).toHaveLength(0);
    expect(wrapper.findAll('[data-part-type="tool"]')).toHaveLength(0);

    await setDetailsOpen(details, true);
    expect((details.element as HTMLDetailsElement).open).toBe(true);
    const body = wrapper.find(".chat-work-group__body");
    expect(body.exists()).toBe(true);
    expect(body.findAll('[data-part-type="reasoning"]')).toHaveLength(1);
    expect(body.findAll('[data-part-type="tool"]')).toHaveLength(2);

    await setDetailsOpen(details, false);
    expect(wrapper.find(".chat-work-group__body").exists()).toBe(false);

    wrapper.unmount();
  });

  it("remembers an open group across a remount", async () => {
    const group = buildGroup();
    const memory = createTranscriptMemory("scope");
    const options = {
      props: { group },
      global: { provide: detailProvide(memory) },
    } as const;

    const wrapper = mount(ChatWorkGroup, options);
    await nextTick();
    await setDetailsOpen(wrapper.find("details.chat-work-group"), true);
    expect(wrapper.find(".chat-work-group__body").exists()).toBe(true);
    wrapper.unmount();

    const remounted = mount(ChatWorkGroup, options);
    await nextTick();
    expect((remounted.find("details").element as HTMLDetailsElement).open).toBe(true);
    expect(remounted.find(".chat-work-group__body").exists()).toBe(true);

    await setDetailsOpen(remounted.find("details.chat-work-group"), false);
    remounted.unmount();

    const closedAgain = mount(ChatWorkGroup, options);
    await nextTick();
    expect((closedAgain.find("details").element as HTMLDetailsElement).open).toBe(false);
    expect(closedAgain.find(".chat-work-group__body").exists()).toBe(false);
    closedAgain.unmount();
  });

  it("opens an error group even when the memory says closed", async () => {
    const group = { ...buildGroup(), hasError: true };
    const memory = createTranscriptMemory("scope");
    memory.setOpen(group.id, false);

    const wrapper = mount(ChatWorkGroup, {
      props: { group },
      global: { provide: detailProvide(memory) },
    });
    await nextTick();

    expect((wrapper.find("details").element as HTMLDetailsElement).open).toBe(true);
    expect(wrapper.find(".chat-work-group__body").exists()).toBe(true);
    wrapper.unmount();
  });

  it("forces a closed group open when an error arrives later", async () => {
    const group = buildGroup();
    const memory = createTranscriptMemory("scope");
    memory.setOpen(group.id, false);

    const wrapper = mount(ChatWorkGroup, {
      props: { group },
      global: { provide: detailProvide(memory) },
    });
    await nextTick();
    expect((wrapper.find("details").element as HTMLDetailsElement).open).toBe(false);

    await wrapper.setProps({ group: { ...group, hasError: true } });
    await nextTick();
    expect((wrapper.find("details").element as HTMLDetailsElement).open).toBe(true);
    expect(wrapper.find(".chat-work-group__body").exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps a nested tool body closed inside an open group", async () => {
    const group = buildGroup();
    const memory = createTranscriptMemory("scope");
    const wrapper = mount(ChatWorkGroup, {
      props: { group },
      global: { provide: detailProvide(memory) },
    });
    await nextTick();
    await setDetailsOpen(wrapper.find("details.chat-work-group"), true);

    const tools = wrapper.findAll('details[data-part-type="tool"]');
    expect(tools.length).toBeGreaterThan(0);
    expect(wrapper.find("[data-tool-output]").exists()).toBe(false);

    const firstTool = tools[0];
    if (firstTool === undefined) {
      throw new Error("missing nested tool details");
    }
    await setDetailsOpen(firstTool, true);
    expect(wrapper.find("[data-tool-output]").text()).toContain("ok");
    wrapper.unmount();
  });

  it("restores each session's detail state through the stable provided scope", async () => {
    const firstGroup = buildSessionGroup("first");
    const secondGroup = buildSessionGroup("second");
    const baseProps = {
      workspaceKey: "p:alpha",
      revision: 1,
      loading: false,
      loadingEarlier: false,
      error: null,
      empty: false,
      stopped: false,
      loadEarlierEnabled: false,
    };
    const wrapper = mount(ChatThread, {
      props: {
        ...baseProps,
        sessionId: "ses_1",
        items: groupItems(firstGroup),
      },
    });
    await nextTick();
    await setDetailsOpen(wrapper.find("details.chat-work-group"), true);
    expect(wrapper.find(".chat-work-group__body").exists()).toBe(true);

    await wrapper.setProps({ sessionId: "ses_2", items: groupItems(secondGroup) });
    await nextTick();
    expect((wrapper.find("details").element as HTMLDetailsElement).open).toBe(false);

    await setDetailsOpen(wrapper.find("details.chat-work-group"), true);
    await wrapper.setProps({ sessionId: "ses_1", items: groupItems(firstGroup) });
    await nextTick();
    expect((wrapper.find("details").element as HTMLDetailsElement).open).toBe(true);
    expect(wrapper.find(".chat-work-group__body").exists()).toBe(true);
    wrapper.unmount();
  });
});
