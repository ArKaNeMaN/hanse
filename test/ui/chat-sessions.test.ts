import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "../../ui/stores/chat-session.js";
import { mountChat } from "./chat-support.js";

const TREE = [
  { id: "root", title: "Root session" },
  { id: "child", title: "Child session", parentID: "root" },
  { id: "grand", title: "Grandchild session", parentID: "child" },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("chat sessions rail", () => {
  it("nests sessions, auto-expands active ancestors, and toggles deeper levels", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=child", {
      sessions: TREE,
    });

    expect(wrapper.find('.session-node[data-session-id="root"]').exists()).toBe(true);
    expect(wrapper.find('.session-node[data-session-id="child"]').exists()).toBe(true);
    expect(
      wrapper.find('[data-session-id="child"] .session-children').attributes("hidden"),
    ).toBeDefined();
    expect(
      wrapper.find('[data-session-id="root"] .session-chevron').attributes("aria-expanded"),
    ).toBe("true");
    expect(
      wrapper.find('[data-session-id="child"] .session-chevron').attributes("aria-expanded"),
    ).toBe("false");
    expect(wrapper.find('button.session-item[data-session-id="child"]').classes()).toContain(
      "is-active",
    );

    await wrapper.find('[data-session-id="child"] .session-chevron').trigger("click");
    expect(
      wrapper.find('[data-session-id="child"] .session-children').attributes("hidden"),
    ).toBeUndefined();
    expect(wrapper.find('.session-node[data-session-id="grand"]').attributes("data-depth")).toBe(
      "2",
    );

    await wrapper.find('[data-session-id="child"] .session-chevron').trigger("click");
    expect(
      wrapper.find('[data-session-id="child"] .session-children').attributes("hidden"),
    ).toBeDefined();
    wrapper.unmount();
  });

  it("filters by title and id while keeping matching ancestors visible", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=child", {
      sessions: TREE,
    });

    await wrapper.find("[data-chat-session-search]").setValue("grandchild");
    expect(wrapper.find('.session-node[data-session-id="root"]').exists()).toBe(true);
    expect(wrapper.find('.session-node[data-session-id="child"]').exists()).toBe(true);
    expect(wrapper.find('.session-node[data-session-id="grand"]').exists()).toBe(true);
    expect(
      wrapper.find('[data-session-id="root"] .session-chevron').attributes("aria-disabled"),
    ).toBe("true");

    await wrapper.find("[data-chat-session-search]").setValue("no-such-session");
    expect(wrapper.text()).toContain("No sessions match this filter.");
    wrapper.unmount();
  });

  it("creates a session through the existing API and selects it", async () => {
    const { wrapper, router, fetchState } = await mountChat(
      "/chat?app=alpha&project=p&session=s1",
      { sessions: [{ id: "s1", title: "Session one" }], createSessionID: "s_created" },
    );

    await wrapper.find("[data-chat-new-session]").trigger("click");
    await flushPromises();

    expect(
      fetchState.requests.some(
        (request) =>
          request.method === "POST" && request.url.startsWith("/api/apps/alpha/sessions"),
      ),
    ).toBe(true);
    expect(router.currentRoute.value.query.session).toBe("s_created");
    expect(wrapper.find('button.session-item[data-session-id="s_created"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("confirms and deletes a whole subtree through the existing DELETE endpoint", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { wrapper, router, fetchState } = await mountChat(
      "/chat?app=alpha&project=p&session=child",
      { sessions: TREE },
    );

    await wrapper.find('[data-session-delete="root"]').trigger("click");
    await flushPromises();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toContain("2 subagent session(s)");
    const deletes = fetchState.requests.filter((request) => request.method === "DELETE");
    expect(deletes.map((request) => request.url)).toEqual([
      "/api/apps/alpha/sessions/root?project=p",
    ]);
    expect(wrapper.find(".session-node").exists()).toBe(false);
    expect(router.currentRoute.value.query.session).toBeUndefined();
    wrapper.unmount();
  });

  it("does not delete when confirmation is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=child", {
      sessions: TREE,
    });

    await wrapper.find('[data-session-delete="root"]').trigger("click");
    await flushPromises();

    expect(fetchState.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(wrapper.find('.session-node[data-session-id="root"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("aggregates child prompt waits onto ancestors and excludes the active session", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=child", {
      sessions: TREE,
    });
    const sessions = useChatSessionStore(pinia);
    sessions.trackPromptPending("child", "question:active");
    sessions.trackPromptPending("grand", "question:grand");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-session-id="root"] .session-item__flag').text()).toContain(
      "1 waiting",
    );
    expect(wrapper.find('[data-session-id="child"] .session-item__flag').text()).toContain(
      "1 waiting",
    );
    sessions.resolvePromptPending("grand", "question:grand");
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-session-id="root"] .session-item__flag').exists()).toBe(false);
    wrapper.unmount();
  });
});
