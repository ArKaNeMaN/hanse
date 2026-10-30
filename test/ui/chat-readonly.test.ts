import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, FIXTURE_MESSAGES, mountChat } from "./chat-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("read-only chat lifecycle", () => {
  it("opens one EventSource per mount and closes it on unmount across enter/leave cycles", async () => {
    const total = 20;
    for (let index = 0; index < total; index += 1) {
      const { wrapper } = await mountChat();
      expect(FakeEventSource.instances).toHaveLength(1);
      wrapper.unmount();
      expect(FakeEventSource.instances.every((source) => source.closed)).toBe(true);
    }
  });

  it("reconnects exactly once after a bfcache pagehide/pageshow", async () => {
    const { wrapper } = await mountChat();
    const first = FakeEventSource.instances[0];
    if (first === undefined) throw new Error("missing source");

    window.dispatchEvent(new Event("pagehide"));
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    window.dispatchEvent(new Event("pageshow"));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.closed).toBe(false);

    window.dispatchEvent(new Event("pageshow"));
    expect(FakeEventSource.instances).toHaveLength(2);
    wrapper.unmount();
  });

  it("selects sessions through the router without direct history writes", async () => {
    const { wrapper, router } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sessions: [
        { id: "s1", title: "Session one" },
        { id: "s2", title: "Session two" },
      ],
    });
    const replace = vi.spyOn(router, "replace");
    const historyReplace = vi.spyOn(window.history, "replaceState");
    const historyPush = vi.spyOn(window.history, "pushState");

    await wrapper.find('.session-item[data-session-id="s2"]').trigger("click");
    await flushPromises();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.query.session).toBe("s2");
    expect(historyReplace).not.toHaveBeenCalled();
    expect(historyPush).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("loads a 30-message tail and pages older messages without duplicates", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      nextCursor: "cursor-1",
      olderMessages: [
        {
          info: {
            id: "msg_older",
            sessionID: "s1",
            role: "user",
            time: { created: 1_760_000_000_000 },
          },
          parts: [
            {
              id: "prt_older",
              sessionID: "s1",
              messageID: "msg_older",
              type: "text",
              text: "Older fixture message.",
            },
          ],
        },
        FIXTURE_MESSAGES[0],
      ],
    });
    expect(
      fetchState.requests.some(
        (request) => request.url.includes("/messages?") && request.url.includes("limit=30"),
      ),
    ).toBe(true);
    expect(fetchState.requests.some((request) => request.url.includes("before="))).toBe(false);

    await wrapper.find("[data-chat-load-earlier]").trigger("click");
    await flushPromises();
    expect(fetchState.requests.some((request) => request.url.includes("before=cursor-1"))).toBe(
      true,
    );
    expect(wrapper.text()).toContain("Older fixture message.");
    const ids = wrapper
      .findAll("#chat-scroll [data-message-id]")
      .map((node) => node.attributes("data-message-id"));
    expect(new Set(ids).size).toBe(ids.length);
    wrapper.unmount();
  });

  it("canonicalizes one invalid deep-link session to the first root", async () => {
    const { wrapper, router } = await mountChat("/chat?app=alpha&project=p&session=missing", {
      sessions: [{ id: "root", title: "Root" }],
    });
    expect(router.currentRoute.value.query.session).toBe("root");
    wrapper.unmount();
  });

  it("issues only GET reads and offers no mutation surface", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      sessions: [
        { id: "s1", title: "Session one" },
        { id: "s2", title: "Session two" },
      ],
    });
    await wrapper.find('.session-item[data-session-id="s2"]').trigger("click");
    await flushPromises();

    expect(fetchState.requests.length).toBeGreaterThan(0);
    expect(fetchState.requests.every((request) => request.method === "GET")).toBe(true);
    const buttons = wrapper.findAll("button:not([disabled])");
    const labels = buttons.map((button) => button.text().trim());
    expect(labels.some((label) => /send|stop|abort|delete|new session/i.test(label))).toBe(false);
    expect(wrapper.find("[data-chat-composer-input]").attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
