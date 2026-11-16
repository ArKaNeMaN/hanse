import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ChatThread from "./ChatThread.vue";

const BASE = {
  items: [],
  sessionId: "ses_1",
  workspaceKey: "p:alpha",
  revision: 1,
  loading: false,
  loadingEarlier: false,
  error: null,
  empty: true,
  stopped: false,
  loadEarlierEnabled: false,
  processState: "error" as const,
  processPhase: "failed" as const,
};

describe("ChatThread process errors", () => {
  it("labels an OOM failure with the out-of-memory title and pill", () => {
    const wrapper = mount(ChatThread, {
      props: {
        ...BASE,
        processError: {
          code: "oom_killed",
          message: "The agent was killed after exceeding its memory limit.",
          at: "2026-11-07T10:00:00.000Z",
        },
      },
    });

    const panel = wrapper.get("[data-chat-process-error]");
    expect(panel.text()).toContain("Agent ran out of memory");
    expect(panel.text()).toContain("The agent was killed after exceeding its memory limit.");
  });

  it("passes the OOM code to the rendered process pill", () => {
    const wrapper = mount(ChatThread, {
      props: {
        ...BASE,
        processState: "starting",
        processPhase: "waiting_ready",
        processError: {
          code: "oom_killed",
          message: "The agent was killed after exceeding its memory limit.",
          at: "2026-11-07T10:00:00.000Z",
        },
      },
    });

    expect(wrapper.get("[data-chat-starting] .status").text()).toBe("Out of memory");
  });

  it("keeps the generic failed-to-start title for other errors", () => {
    const wrapper = mount(ChatThread, {
      props: {
        ...BASE,
        processError: {
          code: "runtime_unavailable",
          message: "The agent runtime is unavailable.",
          at: "2026-11-07T10:00:00.000Z",
        },
      },
    });

    const panel = wrapper.get("[data-chat-process-error]");
    expect(panel.text()).toContain("Agent failed to start");
    expect(panel.text()).not.toContain("Agent ran out of memory");
  });
});
