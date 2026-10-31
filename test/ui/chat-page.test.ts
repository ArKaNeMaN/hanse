import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, mountChat } from "./chat-support.js";

function permission(): Record<string, unknown> {
  return {
    key: "v1:waiting",
    id: "waiting",
    sessionID: "s1",
    permission: "bash",
    patterns: ["echo fixture"],
    always: ["echo fixture"],
    metadata: { command: "echo fixture" },
    source: "v1",
  };
}

function approval(id: string): Record<string, unknown> {
  return {
    id,
    hostName: "fixture-host",
    action: "exec",
    commandPreview: `echo ${id}`,
    requestedAt: "2026-10-30T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

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

  it("keeps the thread as the single owner of the viewport, queue, dock, and composer", async () => {
    const { wrapper } = await mountChat();
    const main = wrapper.find(".chat-main").element;
    const thread = wrapper.find(".chat-thread").element;
    expect(main.querySelector(":scope > .chat-pane-head")).not.toBeNull();
    expect(main.querySelector(":scope > .chat-thread")).not.toBeNull();
    expect(main.querySelector(":scope > .composer")).toBeNull();
    expect(thread.querySelector(":scope > .chat-thread__meta")).not.toBeNull();
    expect(thread.querySelector(":scope > .chat-thread__viewport")).not.toBeNull();
    expect(thread.querySelector(":scope > .composer")).not.toBeNull();
    expect(thread.querySelector(":scope > .chat-queue-strip")).toBeNull();
    expect(wrapper.find(".composer__row > [data-chat-attach]").exists()).toBe(true);
    expect(wrapper.find(".composer__row > [data-chat-composer-input]").exists()).toBe(true);
    expect(wrapper.find(".chat-attachments > [data-chat-attach]").exists()).toBe(false);
    expect(wrapper.findAll("[data-chat-attach]")).toHaveLength(1);
    wrapper.unmount();
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

  it("enables the composer while exposing session navigation controls", async () => {
    const { wrapper, fetchState } = await mountChat();
    const textarea = wrapper.find("[data-chat-composer-input]");
    const send = wrapper.find("[data-chat-send]");
    expect(textarea.attributes("disabled")).toBeUndefined();
    expect(textarea.attributes("readonly")).toBeUndefined();
    expect(send.attributes("disabled")).toBeDefined();
    expect(fetchState.requests.every((request) => request.method === "GET")).toBe(true);
    expect(wrapper.find("[data-chat-session-search]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-new-session]").exists()).toBe(true);
    expect(wrapper.find("[data-session-delete]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-abort]").exists()).toBe(false);
    expect(wrapper.find("[data-chat-queue-strip]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("refreshes context when the active session becomes idle", async () => {
    const { wrapper, fetchState } = await mountChat();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-idle" });
    await flushPromises();
    const before = fetchState.requests.filter((request) => request.url.includes("/context")).length;

    source.emit({
      type: "session.status",
      seq: 1,
      streamID: "stream-idle",
      sessionID: "s1",
      status: { type: "idle" },
    });
    await flushPromises();

    const after = fetchState.requests.filter((request) => request.url.includes("/context")).length;
    expect(after).toBeGreaterThan(before);
    wrapper.unmount();
  });

  it("keeps the last selection when a stale message read resolves late", async () => {
    const { wrapper, router, fetchState } = await mountChat(
      "/chat?app=alpha&project=p&session=s1",
      {
        sessions: [
          { id: "s1", title: "Session one" },
          { id: "s2", title: "Session two" },
          { id: "s3", title: "Session three" },
        ],
      },
    );
    const original = fetchState.mock.getMockImplementation();
    if (original === undefined) throw new Error("missing fetch implementation");
    const message = (id: string) => ({
      info: { id: `msg_${id}`, sessionID: id, role: "user", time: { created: 1 } },
      parts: [
        {
          id: `prt_${id}`,
          sessionID: id,
          messageID: `msg_${id}`,
          type: "text",
          text: `Message ${id}`,
        },
      ],
    });
    fetchState.mock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const delayed = /\/sessions\/(s2|s3)\/messages\?/.exec(url);
      if (delayed !== null) {
        const sessionID = delayed[1] ?? "";
        const delay = sessionID === "s2" ? 40 : 0;
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(
              new Response(JSON.stringify({ messages: [message(sessionID)], nextCursor: null }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }, delay);
        });
      }
      return original(input, init);
    });

    await wrapper.find('.session-item[data-session-id="s2"]').trigger("click");
    await flushPromises();
    await wrapper.find('.session-item[data-session-id="s3"]').trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 70));
    await flushPromises();

    expect(router.currentRoute.value.query.session).toBe("s3");
    expect(wrapper.text()).toContain("Message s3");
    expect(wrapper.text()).not.toContain("Message s2");
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

  it("restores the session meta strip with title, id, live state, count, waiting, plan, and context", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sessions: [{ id: "s1", title: "Session one" }],
      permissions: [permission()],
      todos: [
        { content: "Fixture plan step", status: "in_progress", priority: "high" },
        { content: "Finished fixture step", status: "completed", priority: "low" },
      ],
    });
    await flushPromises();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-meta" });
    await flushPromises();

    const meta = wrapper.find(".chat-thread > .chat-thread__meta");
    expect(meta.find("[data-chat-session-title]").text()).toBe("Session one");
    expect(meta.find("[data-chat-session-id]").text()).toBe("s1");
    expect(meta.find("[data-chat-session-id]").attributes("title")).toBe("s1");
    expect(meta.find("[data-chat-live]").text()).toBe("Live");
    expect(meta.find("[data-chat-live]").attributes("data-state")).toBe("live");
    expect(meta.find("[data-chat-message-count]").text()).toBe("2 messages");
    expect(meta.find("[data-chat-waiting]").text()).toContain("Waiting for you");
    expect(meta.find("[data-chat-plan-chip]").text()).toContain("Plan 1/2");
    expect(meta.find("[data-chat-context-chip]").text()).toContain("Context 10%");
    expect(
      meta.find("[data-chat-context-chip] .chat-context-chip__meter").attributes("aria-valuenow"),
    ).toBe("10");
    wrapper.unmount();
  });

  it("opens the context rail from the context and plan chips", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      todos: [{ content: "Fixture plan step", status: "in_progress", priority: "high" }],
    });
    await flushPromises();
    const shell = wrapper.find("#chat-shell");
    expect(shell.attributes("data-chat-context")).toBe("closed");

    await wrapper.find("[data-chat-context-chip]").trigger("click");
    await flushPromises();
    expect(shell.attributes("data-chat-context")).toBe("open");

    await wrapper.find("[data-chat-context-close]").trigger("click");
    await flushPromises();
    expect(shell.attributes("data-chat-context")).toBe("closed");

    await wrapper.find("[data-chat-plan-chip]").trigger("click");
    await flushPromises();
    expect(shell.attributes("data-chat-context")).toBe("open");
    wrapper.unmount();
  });

  it("renders one inline SSH approvals owner in the thread and none in the rail", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sshApprovals: [approval("inline-1")],
    });
    await flushPromises();

    expect(wrapper.findAll("[data-chat-ssh-approvals]")).toHaveLength(1);
    expect(wrapper.find(".chat-thread [data-chat-ssh-approvals]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-context-rail] [data-chat-ssh-approvals]").exists()).toBe(false);
    expect(wrapper.findAll(".ssh-approval-card")).toHaveLength(1);
    expect(
      fetchState.requests.filter(
        (request) => request.method === "GET" && request.url.includes("/ssh/approvals"),
      ),
    ).toHaveLength(1);
    wrapper.unmount();
  });
});
