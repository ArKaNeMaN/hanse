import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextSnapshot } from "../../src/opencode/context.js";
import ChatContextRail from "../../ui/components/chat/ChatContextRail.vue";
import { CHAT_PROPS, mountChat } from "./chat-support.js";

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    sessionID: "s1",
    state: "ready",
    used: 124_000,
    limit: 200_000,
    percent: 62,
    model: { providerID: "fixture", modelID: "fixture-model" } as never,
    status: "idle",
    topLevel: true,
    activeChildren: false,
    pendingTask: false,
    updatedAt: "2026-10-30T00:00:00.000Z",
    lastCompactedAt: null,
    lastError: null,
    autoCompact: { enabled: false, percent: 80, source: "default", percentSource: "default" },
    ...overrides,
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ approvals: [] }),
    })),
  );
}

function mountRail(overrides: Record<string, unknown> = {}) {
  const handlers = {
    compact: vi.fn(),
    restart: vi.fn(),
    closePreview: vi.fn(),
    revokeSaved: vi.fn(),
    dismissPolicy: vi.fn(),
    close: vi.fn(),
  };
  const wrapper = mount(ChatContextRail, {
    props: {
      view: CHAT_PROPS,
      sessionId: "s1",
      snapshot: snapshot(),
      todos: [],
      todosTruncated: false,
      previews: [],
      savedPermissions: [],
      policyWarnings: [],
      compactBusy: false,
      compactError: null,
      deletionPending: false,
      ...overrides,
    },
    attrs: {
      onCompact: handlers.compact,
      onRestart: handlers.restart,
      onClosePreview: handlers.closePreview,
      onRevokeSaved: handlers.revokeSaved,
      onDismissPolicy: handlers.dismissPolicy,
      onClose: handlers.close,
    },
    attachTo: document.body,
  });
  return { wrapper, handlers };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ChatContextRail", () => {
  it("renders the context meter, detailed usage, and compact confirmation", async () => {
    stubFetch();
    const { wrapper, handlers } = mountRail();
    await flushPromises();
    expect(wrapper.find("[data-chat-context-summary]").text()).toBe("62% of 200k");
    expect(wrapper.find(".chat-context-usage__meter").attributes("aria-valuenow")).toBe("62");
    expect(wrapper.find("[data-chat-context-detail]").text()).toContain("124,000 / 200,000 tokens");
    expect(wrapper.find("[data-chat-compact]").attributes("disabled")).toBeUndefined();

    await wrapper.find("[data-chat-compact]").trigger("click");
    expect(wrapper.find("[data-chat-compact-confirm]").exists()).toBe(true);
    await wrapper.find("[data-chat-compact-apply]").trigger("click");
    expect(handlers.compact).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("disables compaction with a reason while busy, child tasks, or deletion pending", async () => {
    stubFetch();
    const { wrapper: busy } = mountRail({ snapshot: snapshot({ status: "busy" }) });
    await flushPromises();
    expect(busy.find("[data-chat-compact]").attributes("disabled")).toBeDefined();
    expect(busy.find("[data-chat-compact-reason]").text()).toContain("Wait for the agent");
    busy.unmount();

    const { wrapper: deleting } = mountRail({ deletionPending: true });
    await flushPromises();
    expect(deleting.find("[data-chat-compact]").attributes("disabled")).toBeDefined();
    expect(deleting.find("[data-chat-restart]").exists()).toBe(false);
    deleting.unmount();
  });

  it("renders the plan/todo panel with status and progress", async () => {
    stubFetch();
    const { wrapper } = mountRail({
      todos: [
        { content: "Write the port", status: "completed", priority: "high" },
        { content: "Run the gates", status: "in_progress", priority: "medium" },
        { content: "Record evidence", status: "pending", priority: "low" },
      ],
    });
    await flushPromises();
    const plan = wrapper.find("[data-chat-plan-section]");
    expect(plan.exists()).toBe(true);
    expect(plan.text()).toContain("1/3 done");
    expect(plan.findAll(".chat-plan__item")).toHaveLength(3);
    expect(plan.find('[data-status="in_progress"]').text()).toContain("Run the gates");
    wrapper.unmount();
  });

  it("renders handoffs, previews, restart pending, and policy warnings", async () => {
    stubFetch();
    const view = {
      ...CHAT_PROPS,
      pendingRestart: true,
      handoffs: [
        {
          id: "handoff_1",
          shortId: "handoff_",
          state: "waiting",
          replyState: "none",
          summary: "Fixture handoff",
          updatedAt: "2026-10-30T00:00:00.000Z",
          href: "/handoffs?q=handoff_1",
        },
      ],
    };
    const { wrapper, handlers } = mountRail({
      view,
      previews: [{ key: "demo", name: "Demo", url: "/preview/demo/" }],
      policyWarnings: ["Fixture policy warning."],
    });
    await flushPromises();
    expect(wrapper.find("[data-chat-handoffs]").text()).toContain("Fixture handoff");
    expect(wrapper.find('[data-preview-key="demo"]').text()).toContain("Demo");
    await wrapper.find("[data-preview-key='demo'] .chat-preview__close").trigger("click");
    expect(handlers.closePreview).toHaveBeenCalledWith("demo");

    expect(wrapper.find("[data-chat-restart-pending]").exists()).toBe(true);
    await wrapper.find("[data-chat-restart]").trigger("click");
    expect(handlers.restart).toHaveBeenCalledTimes(1);

    expect(wrapper.find("[data-chat-policy-warning]").text()).toContain("Fixture policy warning.");
    await wrapper.find("[data-policy-dismiss]").trigger("click");
    expect(handlers.dismissPolicy).toHaveBeenCalledWith("Fixture policy warning.");
    wrapper.unmount();
  });

  it("does not own SSH approval polling or cards", async () => {
    stubFetch();
    const { wrapper } = mountRail();
    await flushPromises();
    expect(wrapper.find("[data-chat-ssh-approvals]").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("SSH approvals");
    wrapper.unmount();
  });

  it("posts a 202 compact request from the chat page and refreshes context", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      contextSnapshot: snapshot(),
    });
    await flushPromises();
    await wrapper.find("[data-chat-compact]").trigger("click");
    await wrapper.find("[data-chat-compact-apply]").trigger("click");
    await flushPromises();

    const compact = fetchState.requests.find(
      (entry) => entry.method === "POST" && entry.url.includes("/sessions/s1/compact"),
    );
    expect(compact).toBeDefined();
    const contextReads = fetchState.requests.filter(
      (entry) => entry.method === "GET" && entry.url.includes("/sessions/s1/context"),
    );
    expect(contextReads.length).toBeGreaterThanOrEqual(2);
    wrapper.unmount();
  });
});
