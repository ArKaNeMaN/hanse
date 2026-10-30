import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, mountChat } from "./chat-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

function keydown(
  node: Element,
  init: KeyboardEventInit & { readonly composing?: boolean } = {},
): void {
  const { composing, ...rest } = init;
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...rest });
  if (composing === true) {
    Object.defineProperty(event, "isComposing", { value: true });
  }
  node.dispatchEvent(event);
}

function posts(requests: readonly { method: string }[]): number {
  return requests.filter((request) => request.method === "POST").length;
}

describe("ChatComposer", () => {
  it("renders an enabled textarea, hint, and disabled empty send", async () => {
    const { wrapper } = await mountChat();
    const input = wrapper.find("[data-chat-composer-input]");
    expect(input.attributes("disabled")).toBeUndefined();
    expect(input.attributes("placeholder")).toContain("alpha");
    expect(input.attributes("aria-describedby")).toBe("chat-composer-hint");
    expect(wrapper.find("#chat-composer-hint").text()).toContain("Shift+Enter");
    expect(wrapper.find("[data-chat-send]").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-chat-send-error]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("sends on Enter and rekeys the optimistic user row without a duplicate", async () => {
    const { wrapper, fetchState } = await mountChat();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("Enter sends this");
    expect(wrapper.find("[data-chat-send]").attributes("disabled")).toBeUndefined();

    keydown(input.element, { key: "Enter" });
    await flushPromises();

    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("async=1"),
      ),
    ).toBe(true);
    expect(wrapper.find('[data-message-id="msg_sent_1"]').text()).toContain("Enter sends this");
    expect(wrapper.findAll('[data-message-id^="local_"]')).toHaveLength(0);
    expect(wrapper.findAll('[data-message-id="msg_sent_1"]')).toHaveLength(1);
    await flushPromises();
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });

  it("keeps Shift+Enter for a newline", async () => {
    const { wrapper, fetchState } = await mountChat();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("line");
    keydown(input.element, { key: "Enter", shiftKey: true });
    await flushPromises();
    expect(posts(fetchState.requests)).toBe(0);
    wrapper.unmount();
  });

  it("sends with Cmd/Ctrl+Enter", async () => {
    const { wrapper, fetchState } = await mountChat();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("accelerated");
    keydown(input.element, { key: "Enter", ctrlKey: true });
    await flushPromises();
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("async=1"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("ignores Enter while an IME composition is active", async () => {
    const { wrapper, fetchState } = await mountChat();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("composing");
    keydown(input.element, { key: "Enter", composing: true });
    await flushPromises();
    expect(posts(fetchState.requests)).toBe(0);
    wrapper.unmount();
  });

  it("lets a coarse pointer use Enter for a newline", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const { wrapper, fetchState } = await mountChat();
      const input = wrapper.find("[data-chat-composer-input]");
      await input.setValue("touch");
      keydown(input.element, { key: "Enter" });
      await flushPromises();
      expect(posts(fetchState.requests)).toBe(0);
      wrapper.unmount();
    } finally {
      window.matchMedia = original;
    }
  });

  it("switches to Stop while the turn is active and an empty draft is present", async () => {
    const { wrapper, fetchState } = await mountChat();
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error("missing source");
    source.open();
    source.emit({ type: "stream.ready", seq: 0, streamID: "stream-composer" });
    source.emit({
      type: "session.status",
      seq: 1,
      streamID: "stream-composer",
      sessionID: "s1",
      status: { type: "busy" },
    });
    await flushPromises();

    const stop = wrapper.find("[data-chat-abort]");
    expect(stop.exists()).toBe(true);
    expect(wrapper.find("[data-chat-send]").exists()).toBe(false);
    await stop.trigger("click");
    await flushPromises();
    expect(
      fetchState.requests.some(
        (request) => request.method === "POST" && request.url.includes("/abort"),
      ),
    ).toBe(true);
    wrapper.unmount();
  });

  it("disables the composer when the agent is stopped", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=keep", {
      sessionsStatus: 503,
      sessionsCode: "agent_stopped",
    });
    expect(wrapper.find("[data-chat-composer-input]").attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-chat-send]").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("disables the composer while deletion is pending", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      deletingPending: true,
    });
    expect(wrapper.find("[data-chat-composer-input]").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
