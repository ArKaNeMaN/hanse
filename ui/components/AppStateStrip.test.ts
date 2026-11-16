import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { AppSettingsProps } from "../app-types.js";
import type { ProcessEvent } from "../process/types.js";
import AppStateStrip from "./AppStateStrip.vue";

const SETTINGS: AppSettingsProps = {
  state: "applied",
  pending: false,
  appliedStateUnknown: false,
  runtimeConfigured: true,
  label: "Applied",
  glyph: "check",
  tone: "in_progress",
  copy: "The launch settings match the running agent.",
  href: "/projects/p/apps/alpha/settings",
  actionLabel: null,
};

function historyEvent(overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    id: 1,
    attemptId: "a1",
    seq: 1,
    state: "error",
    phase: "failed",
    source: "runtime",
    reason: "oom_killed",
    errorCode: "runtime_unavailable",
    message: null,
    createdAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

describe("AppStateStrip", () => {
  it("shows Out of memory for an error-state OOM snapshot and names the failure", () => {
    const wrapper = mount(AppStateStrip, {
      props: {
        runtimeState: "error",
        settings: SETTINGS,
        canRestart: true,
        runtimeError: null,
        processPhase: "failed",
        processError: {
          code: "oom_killed",
          message: "The agent was killed after exceeding its memory limit.",
          at: "2026-11-07T10:00:00.000Z",
        },
      },
    });

    expect(wrapper.get("#runtime-state .status").text()).toBe("Out of memory");
    const error = wrapper.get("#process-error");
    expect(error.text()).toContain("Agent ran out of memory");
    expect(error.text()).toContain("The agent was killed after exceeding its memory limit.");
  });

  it("labels an old history row by its OOM reason", () => {
    const wrapper = mount(AppStateStrip, {
      props: {
        runtimeState: "running",
        settings: SETTINGS,
        canRestart: false,
        runtimeError: null,
        processPhase: "ready",
        historyEvents: [historyEvent()],
      },
    });

    const row = wrapper.get("[data-process-event]");
    expect(row.text()).toContain("Out of memory");
  });

  it("keeps the non-OOM error title absent", () => {
    const wrapper = mount(AppStateStrip, {
      props: {
        runtimeState: "error",
        settings: SETTINGS,
        canRestart: false,
        runtimeError: null,
        processPhase: "failed",
        processError: {
          code: "runtime_unavailable",
          message: "The agent runtime is unavailable.",
          at: "2026-11-07T10:00:00.000Z",
        },
      },
    });

    expect(wrapper.get("#runtime-state .status").text()).toBe("Failed");
    expect(wrapper.get("#process-error").text()).not.toContain("Agent ran out of memory");
  });
});
