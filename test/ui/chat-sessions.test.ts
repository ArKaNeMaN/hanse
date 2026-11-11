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

  it("omits the session short id from rail rows", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=child", {
      sessions: TREE,
    });
    const sessions = useChatSessionStore(pinia);
    sessions.trackPromptPending("root", "question:root");
    await wrapper.vm.$nextTick();

    const row = wrapper.find('.session-item[data-session-id="root"]');
    const meta = row.find(".session-item__meta");
    expect(meta.exists()).toBe(true);
    expect(meta.find(".mono").exists()).toBe(false);
    expect(meta.text()).toContain("1 waiting");
    expect(row.text()).toContain("Root session");
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

  it("renders Working and Retrying for busy and retry rows and nothing for idle or absent", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=root", {
      sessions: [
        { id: "root", title: "Root session" },
        { id: "busy", title: "Busy session", status: { type: "busy" } },
        { id: "retry", title: "Retry session", status: { type: "retry" } },
        { id: "idle", title: "Idle session", status: { type: "idle" } },
        { id: "absent", title: "Absent session" },
      ],
    });

    expect(wrapper.find('.session-item[data-session-id="busy"] .session-item__status').text()).toBe(
      "Working",
    );
    expect(
      wrapper.find('.session-item[data-session-id="retry"] .session-item__status').text(),
    ).toBe("Retrying");
    expect(
      wrapper.find('.session-item[data-session-id="idle"] .session-item__status').exists(),
    ).toBe(false);
    expect(
      wrapper.find('.session-item[data-session-id="absent"] .session-item__status').exists(),
    ).toBe(false);
    expect(
      wrapper.find('.session-item[data-session-id="root"] .session-item__status').exists(),
    ).toBe(false);
    wrapper.unmount();
  });

  it("keeps the waiting badge above a busy status", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=root", {
      sessions: [
        { id: "root", title: "Root session" },
        { id: "busy", title: "Busy session", status: { type: "busy" } },
      ],
    });
    const sessions = useChatSessionStore(pinia);
    sessions.trackPromptPending("busy", "question:busy");
    await wrapper.vm.$nextTick();

    const row = wrapper.find('.session-item[data-session-id="busy"]');
    expect(row.find(".session-item__flag").text()).toContain("1 waiting");
    expect(row.find(".session-item__status").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the waiting badge instead of a status for the active session with a waiting descendant", async () => {
    const { wrapper, pinia } = await mountChat("/chat?app=alpha&project=p&session=child", {
      sessions: TREE,
      turn: { status: { type: "busy" } },
    });
    const sessions = useChatSessionStore(pinia);
    sessions.trackPromptPending("grand", "question:grand");
    await wrapper.vm.$nextTick();

    const row = wrapper.find('.session-item[data-session-id="child"]');
    expect(row.find(".session-item__flag").text()).toContain("1 waiting");
    expect(row.find(".session-item__status").exists()).toBe(false);
    wrapper.unmount();
  });

  it("adds no live region and no extra focusable element for the status indicator", async () => {
    const { wrapper } = await mountChat("/chat?app=alpha&project=p&session=root", {
      sessions: [
        { id: "root", title: "Root session" },
        { id: "busy", title: "Busy session", status: { type: "busy" } },
      ],
    });

    const status = wrapper.find('.session-item[data-session-id="busy"] .session-item__status');
    expect(status.exists()).toBe(true);
    expect(status.attributes("role")).toBeUndefined();
    expect(status.find('[role="status"]').exists()).toBe(false);
    expect(status.find(".session-item__status-dot").attributes("aria-hidden")).toBe("true");
    expect(
      status.findAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).toHaveLength(0);
    wrapper.unmount();
  });
});
