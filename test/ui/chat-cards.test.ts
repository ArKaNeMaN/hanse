import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import ChatGeneratingRow from "../../ui/components/chat/ChatGeneratingRow.vue";
import ChatImageGate from "../../ui/components/chat/ChatImageGate.vue";
import ChatImageWarning from "../../ui/components/chat/ChatImageWarning.vue";
import ChatNoticeRow from "../../ui/components/chat/ChatNoticeRow.vue";
import ChatThread from "../../ui/components/chat/ChatThread.vue";
import HandoffCard from "../../ui/components/chat/HandoffCard.vue";
import OmoCard from "../../ui/components/chat/OmoCard.vue";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("chat cards", () => {
  it("renders an OMO card with safe Markdown and a disclosure for long bodies", async () => {
    const body = `**ID:** omo-1\n\n${"Long detail line.\n".repeat(12)}<script>bad()</script>`;
    const wrapper = mount(OmoCard, {
      props: {
        omo: { kind: "continuation", tone: "warning", title: "Boulder continuation", body },
      },
    });
    await nextTick();
    expect(wrapper.find("[data-omo-card]").attributes("data-kind")).toBe("continuation");
    expect(wrapper.find(".omo-card__title").text()).toBe("Boulder continuation");
    expect(wrapper.find(".omo-card__details").exists()).toBe(true);
    expect(wrapper.findAll("script")).toHaveLength(0);
    expect(wrapper.text()).toContain("<script>bad()</script>");
    wrapper.unmount();
  });

  it("renders a handoff request/reply card with body, note, outcome, and inbox link", async () => {
    const wrapper = mount(HandoffCard, {
      props: {
        handoff: {
          id: "handoff_abcdef123456",
          direction: "reply",
          agent: "alpha",
          from: "beta",
          to: "alpha",
          state: "delivered",
          summary: "Reply ready",
          body: "# Result\n\nAll checks passed.",
          note: "Please review.",
          outcome: "completed",
          replyState: "delivered",
        },
      },
    });
    await nextTick();
    expect(wrapper.find("[data-handoff-card]").attributes("data-direction")).toBe("reply");
    expect(wrapper.find("[data-handoff-card]").attributes("data-mode")).toBeUndefined();
    expect(wrapper.find("[data-thread-chip]").exists()).toBe(false);
    expect(wrapper.find(".handoff-card__outcome").text()).toBe("completed");
    expect(wrapper.find(".handoff-card__body").text()).toContain("All checks passed.");
    expect(wrapper.find(".handoff-card__note").text()).toContain("Please review.");
    expect(wrapper.find(".handoff-card__link").attributes("href")).toBe(
      "/handoffs?q=handoff_abcdef123456",
    );
    wrapper.unmount();
  });

  it("renders a thread request card with its chip, author, kind, sequence, and route", async () => {
    const wrapper = mount(HandoffCard, {
      props: {
        handoff: {
          id: "handoff_abcdef123456",
          direction: "request",
          agent: "alpha",
          from: "alpha",
          to: "beta",
          state: "in_progress",
          summary: "Reconcile invoice totals",
          body: "## Goal\nDo **the thing**.",
          note: "",
          outcome: null,
          replyState: "none",
          mode: "thread",
          kind: "request",
          authorSide: "source",
          messageId: 17,
          seq: 1,
        },
      },
    });
    await nextTick();
    const card = wrapper.get("[data-handoff-card]");
    expect(card.attributes("data-mode")).toBe("thread");
    expect(card.attributes("data-direction")).toBe("request");
    expect(card.attributes("data-kind")).toBe("request");
    expect(card.attributes("data-seq")).toBe("1");
    expect(card.attributes("data-outcome")).toBeUndefined();
    expect(card.attributes("role")).toBe("group");
    expect(card.attributes("aria-label")).toBe("Message from agent alpha in thread handoff_");
    expect(wrapper.get("[data-thread-chip]").text()).toBe("Thread");
    expect(wrapper.get("[data-thread-author]").text()).toBe("alpha");
    expect(wrapper.get("[data-thread-kind]").text()).toBe("Request");
    expect(wrapper.get("[data-thread-seq]").text()).toBe("#1");
    expect(wrapper.get(".avatar").attributes("aria-hidden")).toBe("true");
    expect(wrapper.get(".handoff-card__route").text()).toContain("alpha");
    expect(wrapper.get(".handoff-card__route").text()).toContain("beta");
    expect(wrapper.get(".handoff-card__body").text()).toContain("Do the thing.");
    expect(wrapper.find(".handoff-card__outcome").exists()).toBe(false);
    expect(wrapper.find(".handoff-card__note").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders a thread message card with a long-body disclosure", async () => {
    const body = `# Update\n\n${"Long detail line.\n".repeat(16)}`;
    const wrapper = mount(HandoffCard, {
      props: {
        handoff: {
          id: "handoff_feedface0001",
          direction: "request",
          agent: "alpha",
          from: "alpha",
          to: "beta",
          state: "in_progress",
          summary: "Reconcile invoice totals",
          body,
          note: "",
          outcome: null,
          replyState: "none",
          mode: "thread",
          kind: "message",
          authorSide: "source",
          messageId: 18,
          seq: 5,
        },
      },
    });
    await nextTick();
    expect(wrapper.get("[data-handoff-card]").attributes("data-kind")).toBe("message");
    expect(wrapper.get("[data-thread-kind]").text()).toBe("Message");
    expect(wrapper.get("[data-thread-seq]").text()).toBe("#5");
    expect(wrapper.find(".handoff-card__details").exists()).toBe(true);
    expect(wrapper.get(".handoff-card__preview").text()).toContain("Update");
    expect(wrapper.get(".handoff-card__details .handoff-card__body").text()).toContain(
      "Long detail line.",
    );
    wrapper.unmount();
  });

  it("renders a thread reply outcome only and never an operator note", async () => {
    const wrapper = mount(HandoffCard, {
      props: {
        handoff: {
          id: "handoff_feedface0002",
          direction: "reply",
          agent: "beta",
          from: "alpha",
          to: "beta",
          state: "in_progress",
          summary: "Reconcile invoice totals",
          body: "Reconciled.",
          note: "Operator note that must not render.",
          outcome: "completed",
          replyState: "none",
          mode: "thread",
          kind: "reply",
          authorSide: "target",
          messageId: 19,
          seq: 6,
        },
      },
    });
    await nextTick();
    const card = wrapper.get("[data-handoff-card]");
    expect(card.attributes("data-direction")).toBe("reply");
    expect(card.attributes("data-kind")).toBe("reply");
    expect(card.attributes("data-outcome")).toBe("completed");
    expect(wrapper.get("[data-thread-kind]").text()).toBe("Reply");
    expect(wrapper.get(".handoff-card__outcome").text()).toBe("completed");
    expect(wrapper.find(".handoff-card__note").exists()).toBe(false);
    wrapper.unmount();
  });

  it("maps agent notices to their human label and reason", async () => {
    const wrapper = mount(ChatNoticeRow, {
      props: {
        notice: { id: "n1", kind: "agent_stopped", reason: "operator_restart" },
      },
    });
    await nextTick();
    expect(wrapper.text()).toContain("Agent was restarted here");
    expect(wrapper.text()).toContain("Operator restart");
    expect(wrapper.find("[data-notice-id]").attributes("data-notice-id")).toBe("n1");
    wrapper.unmount();
  });

  it("renders the decorative generation row and message count", async () => {
    const row = mount(ChatGeneratingRow, { props: { label: "Working" } });
    await nextTick();
    expect(row.find("[data-chat-generating-label]").text()).toBe("Working");
    row.unmount();

    const thread = mount(ChatThread, {
      props: {
        items: [],
        sessionId: "s1",
        workspaceKey: "alpha:p",
        revision: 0,
        loading: false,
        loadingEarlier: false,
        error: null,
        empty: false,
        stopped: false,
        loadEarlierEnabled: false,
        messageCount: "12 messages",
      },
    });
    await nextTick();
    expect(thread.find("[data-chat-message-count]").text()).toBe("12 messages");
    thread.unmount();
  });

  it("renders the cold-start image gate and emits its build action", async () => {
    const view = {
      state: "not_ready",
      buildConfigured: true,
      usableImageRef: null,
      running: false,
    };
    const action = vi.fn();
    const Parent = defineComponent({
      setup: () => () => h(ChatImageGate, { view, onAction: action }),
    });
    const wrapper = mount(Parent);
    await nextTick();
    expect(wrapper.find("[data-chat-image-gate]").text()).toContain("Image not built");
    await wrapper.find("[data-chat-image-action]").trigger("click");
    expect(action).toHaveBeenCalledWith("build_start");
    wrapper.unmount();
  });

  it("renders an app image warning for a running app and emits restart", async () => {
    const view = {
      state: "restart_required",
      buildConfigured: true,
      usableImageRef: "image:new",
      running: true,
    };
    const action = vi.fn();
    const Parent = defineComponent({
      setup: () => () => h(ChatImageWarning, { view, onAction: action }),
    });
    const wrapper = mount(Parent);
    await nextTick();
    expect(wrapper.find("[data-chat-image-warning]").text()).toContain("Image updated");
    await wrapper.find("[data-chat-image-action]").trigger("click");
    expect(action).toHaveBeenCalledWith("restart");
    wrapper.unmount();
  });
});
