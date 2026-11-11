import { QueryClient } from "@tanstack/vue-query";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../../ui/stores/toasts.js";
import {
  chatEventSource,
  FakeEventSource,
  FIXTURE_MESSAGES,
  mountChat,
  processEventSource,
  props,
} from "./chat-support.js";

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

function keydown(node: Element, init: KeyboardEventInit): void {
  node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

function questionFixture(): Record<string, unknown> {
  return {
    key: "v1:q1",
    id: "q1",
    sessionID: "s1",
    source: "v1",
    tooLarge: false,
    questions: [
      {
        header: "Fixture question",
        question: "Continue with the fixture?",
        options: [{ label: "Yes", description: "" }],
        multiple: false,
        custom: true,
      },
    ],
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

  it("opens one chat stream plus one process stream and renders the boot sessions and messages", async () => {
    const { wrapper } = await mountChat();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(chatEventSource()?.url).toBe("/api/apps/alpha/events?project=p");
    expect(processEventSource()?.url).toBe("/api/apps/alpha/process/events?project=p");
    expect(wrapper.find('[data-session-id="s1"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Hello from the fixture.");
    expect(wrapper.text()).toContain("Synthetic assistant reply.");
    wrapper.unmount();
  });

  it("applies a live delta, tool part, and session status through the reducer", async () => {
    const { wrapper } = await mountChat();
    const source = chatEventSource();
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
    const source = chatEventSource();
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
    const source = chatEventSource();
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

  it("selects a cached session when the chat remounts without ?session", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["chat-sessions", "p", "alpha"], {
      sessions: [{ id: "s1", title: "Session one" }],
    });
    const { wrapper, router, fetchState } = await mountChat(
      "/chat?app=alpha&project=p",
      {},
      { queryClient },
    );
    await flushPromises();

    expect(router.currentRoute.value.query.session).toBe("s1");
    expect(
      fetchState.requests.some(
        (request) => request.method === "GET" && request.url.includes("/sessions/s1/messages"),
      ),
    ).toBe(true);
    expect(wrapper.text()).toContain("Hello from the fixture.");
    wrapper.unmount();
  });

  it("shows a spinner and mutes the thread while the next session loads", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sessions: [{ id: "s1" }, { id: "s2" }],
    });
    const original = fetchState.mock.getMockImplementation();
    if (original === undefined) throw new Error("missing fetch implementation");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchState.mock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/sessions\/s2\/messages\?/.test(url)) {
        await gate;
      }
      return original(input, init);
    });

    await wrapper.find('.session-item[data-session-id="s2"]').trigger("click");
    await flushPromises();

    const viewport = wrapper.get(".chat-thread__viewport");
    expect(viewport.attributes("aria-busy")).toBe("true");
    expect(viewport.attributes("data-loading")).toBe("true");
    expect(wrapper.get(".chat-thread__inner").classes()).toContain("is-muted");
    const indicator = wrapper.get("[data-chat-loading]");
    expect(indicator.attributes("role")).toBe("status");
    expect(indicator.find(".spinner").exists()).toBe(true);
    expect(indicator.text()).toContain("Loading conversation");

    release();
    await flushPromises();

    expect(wrapper.find("[data-chat-loading]").exists()).toBe(false);
    expect(viewport.attributes("aria-busy")).toBeUndefined();
    expect(wrapper.find(".chat-thread__inner").classes()).not.toContain("is-muted");
    wrapper.unmount();
  });

  it("keeps the open thread visible while a live refresh is in flight", async () => {
    const { wrapper, fetchState } = await mountChat();
    const original = fetchState.mock.getMockImplementation();
    if (original === undefined) throw new Error("missing fetch implementation");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    fetchState.mock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/sessions\/s1\/messages\?/.test(url)) {
        gated = true;
        await gate;
      }
      return original(input, init);
    });
    const source = chatEventSource();
    if (source === undefined) throw new Error("missing source");

    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-1" });
    await flushPromises();

    expect(gated).toBe(true);
    const viewport = wrapper.get(".chat-thread__viewport");
    expect(viewport.attributes("aria-busy")).toBeUndefined();
    expect(viewport.attributes("data-loading")).toBeUndefined();
    expect(wrapper.get(".chat-thread__inner").classes()).not.toContain("is-muted");
    expect(wrapper.find("[data-chat-loading]").exists()).toBe(false);
    expect(wrapper.text()).toContain("Hello from the fixture.");

    release();
    await flushPromises();

    expect(wrapper.text()).toContain("Synthetic assistant reply.");
    expect(wrapper.find("[data-chat-loading]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the loading state while the first session list is still pending", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { wrapper, router } = await mountChat("/chat?app=alpha&project=p", {
      sessions: [{ id: "s1", title: "Session one" }],
      sessionsGate: gate,
    });

    expect(wrapper.find("[data-chat-loading]").exists()).toBe(true);
    release();
    await flushPromises();

    expect(wrapper.find("[data-chat-loading]").exists()).toBe(false);
    expect(router.currentRoute.value.query.session).toBe("s1");
    wrapper.unmount();
  });

  it("shows the stopped shell and preserves the requested session", async () => {
    const { wrapper, router, fetchState } = await mountChat(
      "/chat?app=alpha&project=p&session=keep",
      {
        sessionsStatus: 503,
        sessionsCode: "agent_stopped",
        process: {
          state: "stopped",
          phase: "stopped",
          attemptId: null,
          startedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
          error: null,
          lastEventId: 0,
        },
      },
    );
    expect(wrapper.find("[data-chat-stopped]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-start-agent]").exists()).toBe(true);
    expect(router.currentRoute.value.query.session).toBe("keep");
    expect(fetchState.requests.some((request) => request.url.includes("/messages"))).toBe(true);
    await wrapper.find("[data-chat-start-agent]").trigger("click");
    await flushPromises();
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/start"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("keeps a running process usable through a transient sessions 503", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 503,
      sessionsCode: "agent_unavailable",
      process: {
        state: "running",
        phase: "ready",
        attemptId: "attempt-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        error: null,
        lastEventId: 4,
      },
    });
    expect(wrapper.find("[data-chat-stopped]").exists()).toBe(false);
    expect(wrapper.find("[data-chat-process-error]").exists()).toBe(false);
    expect(wrapper.find("[data-chat-composer-input]").attributes("disabled")).toBeUndefined();
    expect(wrapper.text()).not.toContain("Agent is not running");
    wrapper.unmount();
  });

  it("shows the stopped panel only for agent_stopped with a stopped process", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 503,
      sessionsCode: "agent_stopped",
      process: {
        state: "stopped",
        phase: "stopped",
        attemptId: null,
        startedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        error: null,
        lastEventId: 0,
      },
    });
    expect(wrapper.find("[data-chat-stopped]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-start-agent]").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders a starting panel with the phase, elapsed time, and no Start button", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 503,
      process: {
        state: "starting",
        phase: "waiting_ready",
        attemptId: "attempt-2",
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        lastEventId: 2,
      },
    });
    const panel = wrapper.find("[data-chat-starting]");
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain("Starting agent");
    expect(panel.text()).toContain("Waiting for readiness");
    expect(panel.find("[data-chat-process-elapsed]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-start-agent]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders a stopping panel that is never labelled Starting", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 503,
      process: {
        state: "starting",
        phase: "stopping",
        attemptId: "attempt-2",
        startedAt: new Date(Date.now() - 3_000).toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        lastEventId: 3,
      },
    });
    const panel = wrapper.find("[data-chat-stopping]");
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain("Stopping agent");
    expect(panel.text()).not.toContain("Starting agent");
    expect(wrapper.find("[data-chat-start-agent]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders a failed process with the sanitized message, Retry, and history", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      process: {
        state: "error",
        phase: "failed",
        attemptId: "attempt-2",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:30.000Z",
        error: {
          code: "readiness_timeout",
          message: "The readiness probe timed out after 30s.",
          at: "2026-01-01T00:00:30.000Z",
        },
        lastEventId: 6,
      },
    });
    const panel = wrapper.find("[data-chat-process-error]");
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain("Agent failed to start");
    expect(panel.text()).toContain("The readiness probe timed out after 30s.");
    expect(panel.find("[data-chat-retry-agent]").exists()).toBe(true);
    expect(panel.find("[data-chat-process-history]").attributes("href")).toBe(
      "/projects/p/apps/alpha#process-history",
    );
    expect(wrapper.find("[data-chat-stopped]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the generic fallback for a legacy error without a message", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      process: {
        state: "error",
        phase: "failed",
        attemptId: "attempt-2",
        startedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        error: { code: "readiness_timeout", message: null, at: null },
        lastEventId: 1,
      },
    });
    expect(wrapper.find("[data-chat-process-error]").text()).toContain(
      "The agent failed to start. No error details were recorded.",
    );
    wrapper.unmount();
  });

  it("maps legacy session codes to their own panels instead of the stopped shell", async () => {
    const starting = await mountChat("/chat?app=alpha&project=p&session=keep", {
      processMissing: true,
      sessionsStatus: 503,
      sessionsCode: "agent_starting",
    });
    expect(starting.wrapper.find("[data-chat-starting]").exists()).toBe(true);
    expect(starting.wrapper.find("[data-chat-stopped]").exists()).toBe(false);
    starting.wrapper.unmount();

    const unavailable = await mountChat("/chat?app=alpha&project=p&session=keep", {
      processMissing: true,
      sessionsStatus: 503,
      sessionsCode: "agent_unavailable",
    });
    expect(unavailable.wrapper.find("[data-chat-process-error]").text()).toContain(
      "agent is unavailable",
    );
    unavailable.wrapper.unmount();

    const image = await mountChat("/chat?app=alpha&project=p&session=keep", {
      processMissing: true,
      sessionsStatus: 503,
      sessionsCode: "default_image_unavailable",
    });
    expect(image.wrapper.find("[data-chat-process-error]").text()).toContain(
      "default agent image is unavailable",
    );
    image.wrapper.unmount();
  });

  it("keeps the starting panel and Start disabled after a remount during a slow start", async () => {
    const starting = {
      state: "starting" as const,
      phase: "preparing" as const,
      attemptId: "attempt-3",
      startedAt: new Date(Date.now() - 4_000).toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      lastEventId: 7,
    };
    const first = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 503,
      process: starting,
    });
    expect(first.wrapper.find("[data-chat-start-agent]").exists()).toBe(false);
    first.wrapper.unmount();

    const second = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 503,
      process: starting,
    });
    expect(second.wrapper.find("[data-chat-starting]").exists()).toBe(true);
    expect(second.wrapper.find("[data-chat-start-agent]").exists()).toBe(false);
    second.wrapper.unmount();
  });

  it("refetches the process view after a failed start and shows the persisted error", async () => {
    const stopped = {
      state: "stopped" as const,
      phase: "stopped" as const,
      attemptId: null,
      startedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      error: null,
      lastEventId: 1,
    };
    const failed = {
      state: "error" as const,
      phase: "failed" as const,
      attemptId: "attempt-4",
      startedAt: "2026-01-01T00:00:10.000Z",
      updatedAt: "2026-01-01T00:00:40.000Z",
      error: {
        code: "readiness_timeout",
        message: "Readiness timed out after 30s.",
        at: "2026-01-01T00:00:40.000Z",
      },
      lastEventId: 2,
    };
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      process: stopped,
      processAfterStart: failed,
      startStatus: 503,
    });
    await wrapper.find("[data-chat-start-agent]").trigger("click");
    for (let index = 0; index < 4; index += 1) {
      await flushPromises();
    }
    expect(wrapper.find("[data-chat-process-error]").text()).toContain(
      "Readiness timed out after 30s.",
    );
    expect(
      fetchState.requests.some(
        (request) => request.method === "GET" && request.url.includes("/process?"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("does not announce starting when the awaited start already returned running", async () => {
    const stopped = {
      state: "stopped" as const,
      phase: "stopped" as const,
      attemptId: null,
      startedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      error: null,
      lastEventId: 1,
    };
    const running = {
      state: "running" as const,
      phase: "ready" as const,
      attemptId: "attempt-5",
      startedAt: "2026-01-01T00:00:10.000Z",
      updatedAt: "2026-01-01T00:00:20.000Z",
      error: null,
      lastEventId: 2,
    };
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      process: stopped,
      processAfterStart: running,
    });
    expect(wrapper.find("[data-chat-start-agent]").exists()).toBe(true);
    await wrapper.find("[data-chat-start-agent]").trigger("click");
    for (let index = 0; index < 4; index += 1) {
      await flushPromises();
    }
    expect(wrapper.find("[data-chat-stopped]").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Agent starting.");
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
    const source = chatEventSource();
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

  it("focuses the composer when typing on a non-editable chat target", async () => {
    const { wrapper } = await mountChat();
    keydown(wrapper.find(".chat-thread").element, { key: "a" });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.find("[data-chat-composer-input]").element);
    wrapper.unmount();
  });

  it("focuses the composer when the page shell has focus", async () => {
    const { wrapper } = await mountChat();
    const main = document.getElementById("main");
    if (main === null) throw new Error("missing main");
    main.focus();
    keydown(main, { key: "a" });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.find("[data-chat-composer-input]").element);
    wrapper.unmount();
  });

  it("keeps focus in the session search field", async () => {
    const { wrapper } = await mountChat();
    const search = wrapper.find("[data-chat-session-search]").element as HTMLInputElement;
    search.focus();
    keydown(search, { key: "a" });
    await flushPromises();
    expect(document.activeElement).toBe(search);
    wrapper.unmount();
  });

  it("keeps focus in a custom answer field", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      questions: [questionFixture()],
    });
    await flushPromises();
    const custom = wrapper.find("[data-question-custom]").element as HTMLInputElement;
    custom.focus();
    keydown(custom, { key: "a" });
    await flushPromises();
    expect(document.activeElement).toBe(custom);
    wrapper.unmount();
  });

  it("does not redirect shortcuts with a modifier", async () => {
    const { wrapper } = await mountChat();
    const composer = wrapper.find("[data-chat-composer-input]").element;
    const thread = wrapper.find(".chat-thread").element;
    keydown(thread, { key: "a", ctrlKey: true });
    keydown(thread, { key: "a", metaKey: true });
    keydown(thread, { key: "a", altKey: true });
    await flushPromises();
    expect(document.activeElement).not.toBe(composer);
    wrapper.unmount();
  });

  it("does not redirect while the composer is disabled", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      deletingPending: true,
    });
    keydown(wrapper.find(".chat-thread").element, { key: "a" });
    await flushPromises();
    expect(document.activeElement).not.toBe(wrapper.find("[data-chat-composer-input]").element);
    wrapper.unmount();
  });

  it("does not redirect space on a focused chat button", async () => {
    const { wrapper } = await mountChat();
    const button = wrapper.find("[data-chat-new-session-head]").element as HTMLButtonElement;
    button.focus();
    keydown(button, { key: " " });
    await flushPromises();
    expect(document.activeElement).toBe(button);
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

  it("refreshes the Last handoff block from the page payload", async () => {
    vi.useFakeTimers();
    let handoffs = [
      {
        id: "handoff_old",
        shortId: "handoff_",
        state: "delivered",
        replyState: "none",
        summary: "Old handoff",
        updatedAt: "2026-10-29T00:00:00.000Z",
        href: "/handoffs?q=handoff_old",
      },
    ];
    let wrapper: Awaited<ReturnType<typeof mountChat>>["wrapper"] | undefined;
    try {
      ({ wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
        custom: ({ method, url }) =>
          method === "GET" && url.startsWith("/api/ui/chat")
            ? { status: 200, body: { ...props(), handoffs } }
            : undefined,
      }));
      expect(wrapper.find("[data-chat-handoffs]").text()).toContain("Old handoff");

      handoffs = [
        {
          id: "handoff_new",
          shortId: "handoff_",
          state: "in_progress",
          replyState: "none",
          summary: "New handoff",
          updatedAt: "2026-10-30T00:00:00.000Z",
          href: "/handoffs?q=handoff_new",
        },
      ];
      await vi.advanceTimersByTimeAsync(5_000);
      await flushPromises();
      expect(wrapper.find("[data-chat-handoffs]").text()).toContain("New handoff");
      expect(wrapper.find("[data-chat-handoffs]").text()).not.toContain("Old handoff");
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it("passes thread handoff fields through and extracts a live body without a note", async () => {
    const threadText = [
      "[Hanse handoff thread message]",
      "Thread ID: handoff_thread_1",
      "",
      "UNTRUSTED CONTENT BEGIN nonce",
      "The March totals still disagree by 0.02.",
      "UNTRUSTED CONTENT END nonce",
      "",
      "Operator note (trusted):",
      "This text must not become a note.",
    ].join("\n");
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: [
        {
          info: {
            id: "msg_thread_live",
            sessionID: "s1",
            role: "user",
            hanse: {
              handoff: {
                id: "handoff_thread_1",
                direction: "request",
                agent: "alpha",
                from: "alpha",
                to: "beta",
                summary: "Reconcile invoice totals",
                state: "in_progress",
                outcome: null,
                replyState: "none",
                origin: "agent",
                mode: "thread",
                kind: "message",
                authorSide: "source",
                messageId: 17,
                seq: 5,
                operatorNote: "Thread metadata never carries a note.",
              },
            },
          },
          parts: [
            {
              id: "prt_thread_live",
              sessionID: "s1",
              messageID: "msg_thread_live",
              type: "text",
              text: threadText,
            },
          ],
        },
      ],
    });
    const card = wrapper.get("[data-handoff-card]");
    expect(card.attributes("data-mode")).toBe("thread");
    expect(card.attributes("data-kind")).toBe("message");
    expect(card.attributes("data-seq")).toBe("5");
    expect(wrapper.get("[data-thread-author]").text()).toBe("alpha");
    expect(wrapper.get("[data-thread-kind]").text()).toBe("Message");
    expect(wrapper.get("[data-thread-seq]").text()).toBe("#5");
    expect(wrapper.get(".handoff-card__body").text()).toContain(
      "The March totals still disagree by 0.02.",
    );
    expect(wrapper.find(".handoff-card__note").exists()).toBe(false);
    wrapper.unmount();
  });

  it("prefers a projected thread body over the envelope text", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: [
        {
          info: {
            id: "msg_thread_history",
            sessionID: "s1",
            role: "user",
            hanse: {
              handoff: {
                id: "handoff_thread_2",
                direction: "request",
                agent: "alpha",
                from: "alpha",
                to: "beta",
                summary: "Reconcile invoice totals",
                state: "in_progress",
                outcome: null,
                replyState: "none",
                origin: "agent",
                mode: "thread",
                kind: "request",
                authorSide: "source",
                messageId: 18,
                seq: 1,
                body: "Projected history body.",
              },
            },
          },
          parts: [
            {
              id: "prt_thread_history",
              sessionID: "s1",
              messageID: "msg_thread_history",
              type: "text",
              text: "[Hanse handoff thread start]\nEnvelope body.",
            },
          ],
        },
      ],
    });
    expect(wrapper.get(".handoff-card__body").text()).toContain("Projected history body.");
    expect(wrapper.get(".handoff-card__body").text()).not.toContain("Envelope body.");
    wrapper.unmount();
  });

  it("refreshes the turn on both session.error paths, stream limit, and visibility", async () => {
    const { wrapper, fetchState } = await mountChat();
    const source = chatEventSource();
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-turn" });
    await flushPromises();
    const turnReads = () =>
      fetchState.requests.filter(
        (request) => request.method === "GET" && request.url.includes("/turn"),
      ).length;

    const beforeError = turnReads();
    source.emit({
      type: "session.error",
      seq: 1,
      streamID: "stream-turn",
      sessionID: "s1",
      name: "Error",
      message: "boom",
    });
    await flushPromises();
    expect(turnReads()).toBeGreaterThan(beforeError);

    const beforeAbortError = turnReads();
    source.emit({
      type: "session.error",
      seq: 2,
      streamID: "stream-turn",
      sessionID: "s1",
      name: "MessageAbortedError",
      message: "aborted by user",
    });
    await flushPromises();
    expect(turnReads()).toBeGreaterThan(beforeAbortError);

    const beforeLimit = turnReads();
    source.emit({
      type: "stream.warning",
      seq: 3,
      streamID: "stream-turn",
      code: "stream_limit",
      message: "paused",
    });
    await flushPromises();
    expect(turnReads()).toBeGreaterThan(beforeLimit);

    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    try {
      const beforeVisibility = turnReads();
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
      expect(turnReads()).toBeGreaterThan(beforeVisibility);
    } finally {
      if (original !== undefined) {
        Object.defineProperty(document, "visibilityState", original);
      }
    }
    wrapper.unmount();
  });

  it("rebuild-only polls the image view without restarting or starting the agent", async () => {
    let built = false;
    let builtGets = 0;
    const imageView = () => {
      if (!built) {
        return {
          buildConfigured: true,
          state: "rebuild_required",
          running: true,
          usableImageRef: "image:old",
          targetImageId: "sha256:new",
          error: null,
        };
      }
      builtGets += 1;
      if (builtGets === 1) {
        return {
          buildConfigured: true,
          state: "building",
          running: true,
          usableImageRef: "image:old",
          targetImageId: "sha256:new",
          error: null,
        };
      }
      return {
        buildConfigured: true,
        state: "restart_required",
        running: true,
        usableImageRef: "image:new",
        targetImageId: "sha256:new",
        error: null,
      };
    };
    let wrapper: Awaited<ReturnType<typeof mountChat>>["wrapper"] | undefined;
    try {
      const mounted = await mountChat("/chat?app=alpha&project=p&session=s1", {
        custom: ({ method, url }) => {
          if (method === "GET" && /^\/api\/apps\/alpha\/image(?:\?|$)/.test(url)) {
            return { status: 200, body: imageView() };
          }
          if (method === "POST" && /^\/api\/apps\/alpha\/build(?:\?|$)/.test(url)) {
            built = true;
            builtGets = 0;
            return { status: 202, body: { accepted: true, buildId: "build-1" } };
          }
          return undefined;
        },
      });
      wrapper = mounted.wrapper;
      const rebuild = wrapper.find('[data-chat-image-action="rebuild"]');
      expect(rebuild.exists()).toBe(true);
      expect(rebuild.text()).toBe("Rebuild only");

      vi.useFakeTimers();
      await rebuild.trigger("click");
      await flushPromises();
      expect(
        mounted.fetchState.requests.filter(
          (request) => request.method === "POST" && request.url.includes("/api/apps/alpha/build"),
        ),
      ).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await flushPromises();

      const posts = (path: string) =>
        mounted.fetchState.requests.filter(
          (request) => request.method === "POST" && request.url.includes(path),
        );
      expect(posts("/api/apps/alpha/restart")).toHaveLength(0);
      expect(posts("/api/apps/alpha/start")).toHaveLength(0);
      expect(
        useToastStore(mounted.pinia).toasts.some(
          (toast) => toast.tone === "success" && toast.message.includes("Image built"),
        ),
      ).toBe(true);
      expect(wrapper.find("[data-chat-image-warning]").text()).toContain("Image updated");
      expect(wrapper.find('[data-chat-image-action="rebuild"]').exists()).toBe(false);
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });

  it("does not restart onto the old image when a rebuild-only build fails", async () => {
    let built = false;
    const imageView = () =>
      built
        ? {
            buildConfigured: true,
            state: "build_error",
            running: true,
            usableImageRef: "image:old",
            targetImageId: "sha256:new",
            error: "build failed",
          }
        : {
            buildConfigured: true,
            state: "rebuild_required",
            running: true,
            usableImageRef: "image:old",
            targetImageId: "sha256:new",
            error: null,
          };
    let wrapper: Awaited<ReturnType<typeof mountChat>>["wrapper"] | undefined;
    try {
      const mounted = await mountChat("/chat?app=alpha&project=p&session=s1", {
        custom: ({ method, url }) => {
          if (method === "GET" && /^\/api\/apps\/alpha\/image(?:\?|$)/.test(url)) {
            return { status: 200, body: imageView() };
          }
          if (method === "POST" && /^\/api\/apps\/alpha\/build(?:\?|$)/.test(url)) {
            built = true;
            return { status: 202, body: { accepted: true, buildId: "build-1" } };
          }
          return undefined;
        },
      });
      wrapper = mounted.wrapper;

      vi.useFakeTimers();
      await wrapper.find('[data-chat-image-action="rebuild"]').trigger("click");
      await flushPromises();
      await flushPromises();

      const posts = (path: string) =>
        mounted.fetchState.requests.filter(
          (request) => request.method === "POST" && request.url.includes(path),
        );
      expect(posts("/api/apps/alpha/build")).toHaveLength(1);
      expect(posts("/api/apps/alpha/restart")).toHaveLength(0);
      expect(posts("/api/apps/alpha/start")).toHaveLength(0);
      expect(wrapper.find("[data-chat-image-warning]").text()).toContain("Image build failed");
    } finally {
      wrapper?.unmount();
      vi.useRealTimers();
    }
  });
});

describe("chat notice grouping", () => {
  function notice(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      sessionId: "s1",
      kind: "agent_stopped",
      reason: "process_exit",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {},
      ...overrides,
    };
  }

  it("hides a leading notice while an older message chunk exists and reveals it once history ends", async () => {
    const leading = notice("notice-lead", { createdAt: "2020-01-01T00:00:00.000Z" });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      nextCursor: "cursor-old",
      notices: [leading],
    });

    expect(wrapper.find('[data-notice-id="notice-lead"]').exists()).toBe(false);

    await wrapper.find("[data-chat-load-earlier]").trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-notice-id="notice-lead"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps a leading notice when the loaded history is complete", async () => {
    const leading = notice("notice-lead", { createdAt: "2020-01-01T00:00:00.000Z" });
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      nextCursor: null,
      notices: [leading],
    });

    expect(wrapper.find('[data-notice-id="notice-lead"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps a notice in a notice-only complete session", async () => {
    const only = notice("notice-only");
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: [],
      nextCursor: null,
      notices: [only],
    });

    expect(wrapper.find('[data-notice-id="notice-only"]').exists()).toBe(true);
    expect(wrapper.find(".chat-notice").exists()).toBe(true);
    wrapper.unmount();
  });

  it("groups contiguous notices with the same cause and expands to the member rows", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: [FIXTURE_MESSAGES[0]],
      nextCursor: null,
      notices: [
        notice("notice-a", {
          kind: "subagent_interrupted",
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: { childSessionID: "child-a", runtimeEpoch: "epoch-1" },
        }),
        notice("notice-b", {
          kind: "subagent_interrupted",
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: { childSessionID: "child-b", runtimeEpoch: "epoch-2" },
        }),
        notice("notice-c", {
          kind: "agent_stopped",
          createdAt: "2026-01-01T00:00:03.000Z",
          payload: { childSessionID: "child-a", runtimeEpoch: "epoch-1" },
        }),
      ],
    });

    const groups = wrapper.findAll(".chat-notice-group");
    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (group === undefined) throw new Error("missing notice group");
    expect(group.text()).toContain("3 notices");
    expect(group.text()).toContain("2 subagents");

    const toggle = group.find(".chat-notice-group__toggle");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await toggle.trigger("click");

    expect(toggle.attributes("aria-expanded")).toBe("true");
    const body = group.find(".chat-notice-group__body");
    expect(body.findAll(".chat-notice")).toHaveLength(3);
    wrapper.unmount();
  });

  it("renders a single notice without a group wrapper", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      messages: [FIXTURE_MESSAGES[0]],
      nextCursor: null,
      notices: [notice("notice-single")],
    });

    expect(wrapper.find(".chat-notice-group").exists()).toBe(false);
    expect(wrapper.find('[data-notice-id="notice-single"]').exists()).toBe(true);
    expect(wrapper.find(".chat-notice").exists()).toBe(true);
    wrapper.unmount();
  });
});
