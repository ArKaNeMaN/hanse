import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatContextStore } from "../../ui/stores/chat-context.js";
import { useChatFeedStore } from "../../ui/stores/chat-feed.js";
import { useChatSessionStore } from "../../ui/stores/chat-session.js";

/**
 * The stores are read-only mirrors of `route.query`. Render-free actions must never navigate or
 * rewrite the document URL.
 */
describe("chat stores never write the URL", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("feeds, sessions, and context stay URL-free under normal mutations", () => {
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");

    const feed = useChatFeedStore();
    const session = useChatSessionStore();
    const context = useChatContextStore();

    feed.reset("ses_url");
    session.setActive("ses_url");
    session.setSessions([{ id: "ses_url" }, { id: "ses_child", parentID: "ses_url" }]);
    session.setAgentStatus("ses_url", { type: "busy" });
    feed.upsertMessage({
      type: "message/upsert",
      sessionID: "ses_url",
      messageID: "msg_url",
      role: "user",
    });
    feed.upsertPart({
      type: "part/upsert",
      sessionID: "ses_url",
      messageID: "msg_url",
      partID: "prt_url",
      partType: "text",
      part: { id: "prt_url", type: "text", text: "hi" },
      known: true,
    });
    feed.upsertNotice({ id: "ntc_url", sessionId: "ses_url" });
    context.setTodos("ses_url", [], false, true);
    feed.setStreamReady("stream_url", true);

    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });
});
