import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, mountChat } from "./chat-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ChatPage read-only shell", () => {
  it("renders one chat body, the workspace shell, and no page header", async () => {
    const { wrapper } = await mountChat();
    expect(wrapper.find(".page__body--chat").exists()).toBe(true);
    expect(wrapper.findAll(".page__body")).toHaveLength(1);
    expect(wrapper.find(".page-header").exists()).toBe(false);
    expect(wrapper.find("#chat-shell").exists()).toBe(true);
    expect(wrapper.find("#chat-scroll").exists()).toBe(true);
    expect(wrapper.find("[data-chat-sessions-rail]").exists()).toBe(true);
    expect(document.getElementById("main")?.classList.contains("page--chat")).toBe(true);
    expect(
      document.querySelectorAll('meta[name="viewport"]')[0]?.getAttribute("content"),
    ).toContain("interactive-widget=resizes-content");
    wrapper.unmount();
    expect(document.getElementById("main")?.classList.contains("page--chat")).toBe(false);
  });

  it("has exactly one EventSource and renders the boot sessions and messages", async () => {
    const { wrapper } = await mountChat();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/apps/alpha/events?project=p");
    expect(wrapper.find('[data-session-id="s1"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Hello from the fixture.");
    expect(wrapper.text()).toContain("Synthetic assistant reply.");
    wrapper.unmount();
  });

  it("applies a live delta, tool part, and session status through the reducer", async () => {
    const { wrapper } = await mountChat();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-1" });
    await flushPromises();
    source.emit({
      type: "message.part.delta",
      seq: 1,
      streamID: "stream-1",
      sessionID: "s1",
      messageID: "msg_assistant",
      partID: "prt_live",
      partType: "text",
      field: "text",
      delta: "Live fixture delta.",
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Live fixture delta.");

    source.emit({
      type: "message.part.updated",
      seq: 2,
      streamID: "stream-1",
      sessionID: "s1",
      messageID: "msg_assistant",
      partID: "prt_tool",
      partType: "tool",
      part: { id: "prt_tool", type: "tool", tool: "bash", state: { status: "running" } },
    });
    await flushPromises();
    expect(wrapper.find('[data-tool="bash"]').exists()).toBe(true);

    source.emit({
      type: "session.status",
      seq: 3,
      streamID: "stream-1",
      sessionID: "s1",
      status: { type: "busy" },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".chat-runtime").text()).toBe("Live");
    wrapper.unmount();
  });

  it("renders a stream warning notice and requests a resync", async () => {
    const { wrapper } = await mountChat();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-1" });
    await flushPromises();
    source.emit({
      type: "stream.warning",
      seq: 1,
      streamID: "stream-1",
      sessionID: "s1",
      code: "stream_budget",
      message: "Synthetic warning notice.",
    });
    await flushPromises();
    expect(wrapper.find(".chat-notice").text()).toContain("Synthetic warning notice.");
    wrapper.unmount();
  });

  it("renders a read-only composer with no enabled mutation control", async () => {
    const { wrapper, fetchState } = await mountChat();
    const textarea = wrapper.find("[data-chat-composer-input]");
    const send = wrapper.find("[data-chat-send]");
    expect(textarea.attributes("disabled")).toBeDefined();
    expect(textarea.attributes("readonly")).toBeDefined();
    expect(send.attributes("disabled")).toBeDefined();
    expect(fetchState.requests.every((request) => request.method === "GET")).toBe(true);
    expect(wrapper.find('button[aria-label*="Delete"]').exists()).toBe(false);
    expect(wrapper.find('input[type="search"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the stopped shell and preserves the requested session", async () => {
    const { wrapper, router, fetchState } = await mountChat(
      "/chat?app=alpha&project=p&session=keep",
      { sessionsStatus: 503, sessionsCode: "agent_stopped" },
    );
    expect(wrapper.find("[data-chat-stopped]").exists()).toBe(true);
    expect(router.currentRoute.value.query.session).toBe("keep");
    expect(fetchState.requests.some((request) => request.url.includes("/messages"))).toBe(true);
    wrapper.unmount();
  });

  it("shows the empty state when the session list is empty and preserves the query", async () => {
    const { wrapper, router } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessions: [],
      messages: [],
    });
    expect(wrapper.find("[data-chat-empty]").exists()).toBe(true);
    expect(router.currentRoute.value.query.session).toBe("keep");
    wrapper.unmount();
  });

  it("shows a session error without rewriting the URL", async () => {
    const { wrapper, router } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 500,
      sessionsCode: "sessions_unavailable",
    });
    expect(wrapper.text()).toContain("agent is stopped");
    expect(router.currentRoute.value.query.session).toBe("keep");
    wrapper.unmount();
  });

  it("shows the deletion-pending banner", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      deletingPending: true,
    });
    expect(wrapper.find("[data-chat-deletion-pending]").exists()).toBe(true);
    wrapper.unmount();
  });
});
