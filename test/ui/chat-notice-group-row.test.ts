import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { buildNoticeTimeline } from "../../ui/chat/notice-groups.js";
import type { ChatNoticeGroupView, ChatThreadItem } from "../../ui/chat/types.js";
import ChatNoticeGroupRow from "../../ui/components/chat/ChatNoticeGroupRow.vue";
import type { NoticeView } from "../../ui/stores/chat-feed.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function notice(overrides: NoticeView): NoticeView {
  return overrides;
}

function buildGroup(): ChatNoticeGroupView {
  const first = notice({
    id: "n1",
    sessionId: "s1",
    kind: "agent_stopped",
    reason: "process_exit",
    createdAt: "2026-11-09T13:41:00.000Z",
    payload: { runtimeEpoch: "epoch-1", childSessionID: "child-1" },
  });
  const second = notice({
    id: "n2",
    sessionId: "s1",
    kind: "subagent_interrupted",
    reason: "process_exit",
    createdAt: "2026-11-09T14:02:00.000Z",
    payload: { runtimeEpoch: "epoch-1", childSessionID: "child-2" },
  });
  const third = notice({
    id: "n3",
    sessionId: "s1",
    kind: "subagent_interrupted",
    reason: "process_exit",
    createdAt: "2026-11-09T14:02:00.000Z",
    payload: { runtimeEpoch: "epoch-1", childSessionID: "child-2" },
  });
  const items: ChatThreadItem[] = [
    { type: "notice", notice: first },
    { type: "notice", notice: second },
    { type: "notice", notice: third },
  ];
  const [item] = buildNoticeTimeline(items, { historyComplete: true });
  if (item === undefined || item.type !== "notice-group") throw new Error("missing notice group");
  return item.group;
}

describe("ChatNoticeGroupRow", () => {
  it("renders the collapsed summary, controls its region, and expands on click", async () => {
    const group = buildGroup();
    const wrapper = mount(ChatNoticeGroupRow, { props: { group } });
    await nextTick();

    const toggle = wrapper.find("button.chat-notice-group__toggle");
    expect(toggle.exists()).toBe(true);
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(toggle.attributes("title")).toBe(group.timeTitle);

    const summary = toggle.text();
    expect(summary).toContain(group.reasonLabel);
    expect(summary).toContain(group.metricsText);
    expect(summary).toContain(group.breakdownText);
    expect(summary).toContain(group.timeText);

    const region = wrapper.find(`[id="${group.id}-body"]`);
    expect(region.exists()).toBe(true);
    expect(toggle.attributes("aria-controls")).toBe(region.attributes("id"));
    expect((region.element as HTMLElement).style.display).toBe("none");

    expect(wrapper.attributes("role")).toBeUndefined();

    await toggle.trigger("click");
    await nextTick();

    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect((region.element as HTMLElement).style.display).not.toBe("none");
    expect(region.findAll(".chat-notice")).toHaveLength(group.notices.length);
    expect(region.findAll('[role="note"]')).toHaveLength(group.notices.length);
    expect(wrapper.attributes("role")).toBeUndefined();

    wrapper.unmount();
  });
});
