import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postPrompt } from "../../ui/chat/send.js";
import { useChatComposerStore } from "../../ui/stores/chat-composer.js";
import { FakeEventSource, FIXTURE_MESSAGES, mountChat } from "./chat-support.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

async function sendText(wrapper: Awaited<ReturnType<typeof mountChat>>["wrapper"], text: string) {
  const input = wrapper.find("[data-chat-composer-input]");
  await input.setValue(text);
  await wrapper.find("[data-chat-send]").trigger("click");
  await flushPromises();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function composerValue(wrapper: Awaited<ReturnType<typeof mountChat>>["wrapper"]): string {
  return (wrapper.find("[data-chat-composer-input]").element as HTMLTextAreaElement).value;
}

describe("chat send and delivery", () => {
  it("rekeys the optimistic row to the accepted server id", async () => {
    const { wrapper, fetchState, pinia } = await mountChat();
    await sendText(wrapper, "Optimistic hello");

    expect(wrapper.find('[data-message-id="msg_sent_1"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-message-id^="local_"]')).toHaveLength(0);
    expect(useChatComposerStore(pinia).delivery).toBe("accepted");
    expect(composerValue(wrapper)).toBe("");
    expect(
      fetchState.requests.filter(
        (request) => request.method === "POST" && request.url.includes("/messages"),
      ),
    ).toHaveLength(1);
    wrapper.unmount();
  });

  it("falls back to the blocking endpoint when async delivery is unavailable", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      custom: ({ method, url }) =>
        method === "POST" && url.includes("/messages") && url.includes("async=1")
          ? {
              status: 502,
              body: {
                error: "async prompt route unavailable",
                code: "async_unavailable",
                outcome: "not_sent",
              },
            }
          : undefined,
    });
    await sendText(wrapper, "Blocking fallback");

    const messageWrites = fetchState.requests.filter(
      (request) => request.method === "POST" && request.url.includes("/messages"),
    );
    expect(messageWrites.some((request) => request.url.includes("async=1"))).toBe(true);
    expect(messageWrites.some((request) => request.url.includes("async=0"))).toBe(true);
    expect(wrapper.find('[data-message-id="msg_sent_1"]').text()).toContain("Blocking fallback");
    wrapper.unmount();
  });

  it("marks delivery unknown, then exposes Check again and Remove", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      custom: ({ method, url }) =>
        method === "POST" && url.includes("/messages")
          ? {
              status: 502,
              body: {
                error: "upstream unavailable",
                code: "agent_unavailable",
                outcome: "unknown",
                messageID: "msg_unknown",
              },
            }
          : undefined,
    });
    vi.useFakeTimers();
    await sendText(wrapper, "Unknown delivery");
    expect(wrapper.find('[data-message-id="msg_unknown"]').text()).toContain("Unknown delivery");
    expect(composerValue(wrapper)).toBe("Unknown delivery");
    expect(wrapper.find("[data-chat-send-recovery]").exists()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(wrapper.find("[data-chat-send-recovery]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-send-check]").exists()).toBe(true);
    expect(wrapper.find("[data-chat-send-remove]").exists()).toBe(true);

    await wrapper.find("[data-chat-send-check]").trigger("click");
    await flushPromises();
    expect(
      fetchState.requests.some(
        (request) => request.method === "GET" && request.url.includes("/messages?"),
      ),
    ).toBe(true);
    expect(wrapper.find("[data-chat-send-recovery]").exists()).toBe(true);

    await wrapper.find("[data-chat-send-remove]").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-message-id="msg_unknown"]').exists()).toBe(false);
    expect(wrapper.find("[data-chat-send-recovery]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows and retries a pending send restored from the draft endpoint", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      pendingSends: [
        {
          id: "pending_1",
          messageID: "msg_pending",
          text: "Deliver me again",
          state: "failed",
          updatedAt: null,
        },
      ],
    });
    const row = wrapper.find('[data-pending-id="pending_1"]');
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("Failed to send");

    await row.find("[data-pending-retry]").trigger("click");
    await flushPromises();
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/pending/pending_1/retry"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("does not send twice while the first send is still in flight", async () => {
    const { wrapper, fetchState } = await mountChat();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("Only once");
    const send = wrapper.find("[data-chat-send]");
    await send.trigger("click");
    await send.trigger("click");
    await flushPromises();
    expect(
      fetchState.requests.filter(
        (request) => request.method === "POST" && request.url.includes("/messages"),
      ),
    ).toHaveLength(1);
    wrapper.unmount();
  });

  it("never settles an in-flight send from an idle status", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sendGate: gate.promise,
    });
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-send" });
    await flushPromises();

    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("Still sending");
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();
    expect(useChatComposerStore(pinia).delivery).toBe("sending");

    source.emit({
      type: "session.status",
      seq: 1,
      streamID: "stream-send",
      sessionID: "s1",
      status: { type: "idle" },
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(useChatComposerStore(pinia).delivery).toBe("sending");
    expect(wrapper.find('[data-message-id^="local_"]').attributes("data-optimistic")).toBe(
      "sending",
    );

    gate.resolve();
    await flushPromises();
    expect(wrapper.find('[data-message-id="msg_sent_1"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("times out a hung send into Delivery unknown and accepts a late 202", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sendGate: gate.promise,
    });
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("Hung delivery");
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();

    expect(useChatComposerStore(pinia).delivery).toBe("sending");
    expect(wrapper.find('[data-message-id^="local_"]').attributes("data-optimistic")).toBe(
      "sending",
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(useChatComposerStore(pinia).delivery).toBe("unknown");
    expect(wrapper.find('[data-message-id^="local_"]').attributes("data-optimistic")).toBe(
      "unknown",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(wrapper.find("[data-chat-send-recovery]").exists()).toBe(true);

    gate.resolve();
    await flushPromises();
    expect(wrapper.find('[data-message-id="msg_sent_1"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-message-id^="local_"]')).toHaveLength(0);
    expect(useChatComposerStore(pinia).delivery).toBe("accepted");
    expect(wrapper.find("[data-chat-send-recovery]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("restores the draft and shows an error when delivery is rejected", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      custom: ({ method, url }) =>
        method === "POST" && url.includes("/messages")
          ? {
              status: 409,
              body: { error: "application is pending deletion", code: "deletion_pending" },
            }
          : undefined,
    });
    await sendText(wrapper, "Rejected draft");

    expect(wrapper.find("[data-chat-send-error]").text()).toContain("pending deletion");
    expect(wrapper.find('[data-message-id^="local_"]').exists()).toBe(false);
    expect(composerValue(wrapper)).toBe("Rejected draft");
    wrapper.unmount();
  });

  it("keeps a newer draft typed while the send is in flight", async () => {
    const gate = deferred();
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sendGate: gate.promise,
    });
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("First draft");
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();

    expect(composerValue(wrapper)).toBe("First draft");
    await input.setValue("Second draft");
    gate.resolve();
    await flushPromises();

    expect(composerValue(wrapper)).toBe("Second draft");
    wrapper.unmount();
  });

  it("keeps the composer text while a send is in flight", async () => {
    const gate = deferred();
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sendGate: gate.promise,
    });
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("In flight");
    await wrapper.find("[data-chat-send]").trigger("click");
    await flushPromises();

    expect(composerValue(wrapper)).toBe("In flight");
    gate.resolve();
    await flushPromises();
    expect(composerValue(wrapper)).toBe("");
    wrapper.unmount();
  });

  it("redirects with next when auth expires mid-send", async () => {
    window.history.replaceState(null, "", "/chat?app=alpha&project=p");
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "sign in required" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();

    await expect(
      postPrompt("/api/apps/alpha/sessions/s1/messages?async=1", "hello", {
        onUnauthorized,
      }),
    ).rejects.toThrow("sign in required");

    expect(onUnauthorized).toHaveBeenCalledWith("/chat?app=alpha&project=p");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.credentials).toBe("same-origin");
    expect(((init?.headers ?? {}) as Record<string, string>)["x-hanse-client"]).toBe("spa");
  });

  it("keeps an accepted feed row distinct from the fixture tail", async () => {
    const { wrapper } = await mountChat();
    await sendText(wrapper, "No duplicate message");
    const ids = wrapper
      .findAll("#chat-scroll [data-message-id]")
      .map((node) => node.attributes("data-message-id"));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("msg_sent_1");
    expect(FIXTURE_MESSAGES.length).toBe(2);
    wrapper.unmount();
  });
});
