import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_MESSAGES, mountChat } from "./chat-support.js";

function draftWrites(
  requests: readonly { method: string; url: string; body?: string }[],
): { method: string; url: string; body?: string }[] {
  return requests.filter((request) => request.method === "PUT" && request.url.includes("/draft"));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  sessionStorage.clear();
});

describe("chat drafts", () => {
  it("restores a saved draft on mount", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      draftText: "Saved draft",
    });
    expect((wrapper.find("[data-chat-composer-input]").element as HTMLTextAreaElement).value).toBe(
      "Saved draft",
    );
    wrapper.unmount();
  });

  it("saves a draft after the 500 ms debounce", async () => {
    const { wrapper, fetchState } = await mountChat();
    vi.useFakeTimers();
    await wrapper.find("[data-chat-composer-input]").setValue("Debounced draft");
    expect(draftWrites(fetchState.requests)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    const writes = draftWrites(fetchState.requests);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.url).toContain("/sessions/s1/draft");
    expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual({ text: "Debounced draft" });
    wrapper.unmount();
  });

  it("flushes the previous draft and restores the target draft on session switch", async () => {
    const { wrapper, fetchState, router } = await mountChat(
      "/chat?app=alpha&project=p&session=s1",
      {
        sessions: [
          { id: "s1", title: "One" },
          { id: "s2", title: "Two" },
        ],
        drafts: { s1: "one", s2: "two" },
      },
    );
    vi.useFakeTimers();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("edited one");

    await wrapper.find('.session-item[data-session-id="s2"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const writes = draftWrites(fetchState.requests);
    expect(writes.some((write) => write.url.includes("/sessions/s1/draft"))).toBe(true);
    expect(
      JSON.parse(writes.find((write) => write.url.includes("/sessions/s1/draft"))?.body ?? "{}"),
    ).toEqual({ text: "edited one" });
    expect(router.currentRoute.value.query.session).toBe("s2");
    expect((wrapper.find("[data-chat-composer-input]").element as HTMLTextAreaElement).value).toBe(
      "two",
    );

    await wrapper.find('.session-item[data-session-id="s1"]').trigger("click");
    await flushPromises();
    await flushPromises();
    expect((wrapper.find("[data-chat-composer-input]").element as HTMLTextAreaElement).value).toBe(
      "edited one",
    );
    wrapper.unmount();
  });

  it("flushes with keepalive on pagehide", async () => {
    const { wrapper, fetchState } = await mountChat();
    vi.useFakeTimers();
    await wrapper.find("[data-chat-composer-input]").setValue("Hidden draft");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await flushPromises();

    const write = draftWrites(fetchState.requests).find((request) =>
      request.url.includes("/sessions/s1/draft"),
    );
    expect(write).toBeDefined();
    expect(JSON.parse(write?.body ?? "{}")).toEqual({ text: "Hidden draft" });
    const record = fetchState.requests.find(
      (request) =>
        request.method === "PUT" && request.url === write?.url && request.keepalive === true,
    );
    expect(record).toBeDefined();
    expect(record?.headers["x-hanse-client"]).toBe("spa");
    expect(record?.headers["x-hanse-ui-version"]).toBe("2");
    wrapper.unmount();
  });

  it("does not mark a rejected keepalive draft as saved", async () => {
    const { wrapper, fetchState } = await mountChat(undefined, { draftSaveStatus: 500 });
    vi.useFakeTimers();
    await wrapper.find("[data-chat-composer-input]").setValue("Rejected draft");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await flushPromises();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await flushPromises();

    const writes = draftWrites(fetchState.requests).filter((write) =>
      write.url.includes("/sessions/s1/draft"),
    );
    expect(writes).toHaveLength(2);
    wrapper.unmount();
  });

  it("does not mark an old-client draft 409 as saved", async () => {
    sessionStorage.setItem("hanse-ui-preload-reloaded", "1");
    const { wrapper, fetchState } = await mountChat(undefined, {
      draftSaveStatus: 409,
      draftSaveBody: { error: "UI reload required", code: "ui_reload_required" },
    });
    vi.useFakeTimers();
    await wrapper.find("[data-chat-composer-input]").setValue("Old client draft");
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await flushPromises();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await flushPromises();

    const writes = draftWrites(fetchState.requests).filter((write) =>
      write.url.includes("/sessions/s1/draft"),
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]?.headers["x-hanse-ui-version"]).toBe("2");
    wrapper.unmount();
  });

  it("sends the UI version on a keepalive delete-if-empty", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s2", {
      sessions: [
        { id: "s1", title: "One" },
        { id: "s2", title: "Two" },
      ],
      messagesBySession: { s1: FIXTURE_MESSAGES, s2: [] },
      drafts: { s1: "", s2: "" },
    });
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    await flushPromises();

    const record = fetchState.requests.find(
      (request) => request.method === "POST" && request.url.includes("/delete-if-empty"),
    );
    expect(record).toBeDefined();
    expect(record?.headers["x-hanse-client"]).toBe("spa");
    expect(record?.headers["x-hanse-ui-version"]).toBe("2");
    wrapper.unmount();
  });

  it("flushes the draft on unmount", async () => {
    const { wrapper, fetchState } = await mountChat();
    vi.useFakeTimers();
    await wrapper.find("[data-chat-composer-input]").setValue("Unmount draft");
    wrapper.unmount();
    await flushPromises();

    const write = draftWrites(fetchState.requests).find((request) =>
      request.url.includes("/sessions/s1/draft"),
    );
    expect(write).toBeDefined();
    expect(JSON.parse(write?.body ?? "{}")).toEqual({ text: "Unmount draft" });
  });

  it("deletes an empty session only after an empty draft is saved", async () => {
    const { wrapper, fetchState, router } = await mountChat(
      "/chat?app=alpha&project=p&session=s2",
      {
        sessions: [
          { id: "s1", title: "One" },
          { id: "s2", title: "Two" },
        ],
        messagesBySession: { s1: FIXTURE_MESSAGES, s2: [] },
        drafts: { s1: "", s2: "" },
        deleteIfEmptyBody: { deleted: true },
      },
    );
    vi.useFakeTimers();
    const input = wrapper.find("[data-chat-composer-input]");
    await input.setValue("temporary");
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    await input.setValue("");
    await vi.advanceTimersByTimeAsync(600);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_100);
    await flushPromises();
    await flushPromises();

    const emptyWrites = draftWrites(fetchState.requests).filter((write) =>
      write.url.includes("/sessions/s2/draft"),
    );
    expect(emptyWrites.some((write) => JSON.parse(write.body ?? "{}").text === "")).toBe(true);
    expect(
      fetchState.requests.some(
        (request) =>
          request.method === "POST" && request.url.includes("/sessions/s2/delete-if-empty"),
      ),
    ).toBe(true);
    expect(router.currentRoute.value.query.session).toBe("s1");
    wrapper.unmount();
  });
});
