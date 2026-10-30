import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountChat } from "./chat-support.js";

function permission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "v1:p1",
    id: "p1",
    sessionID: "s1",
    permission: "bash",
    patterns: ["echo fixture"],
    always: ["echo fixture"],
    metadata: { command: "echo fixture" },
    source: "v1",
    ...overrides,
  };
}

function replyBody(
  fetchState: Awaited<ReturnType<typeof mountChat>>["fetchState"],
  suffix: string,
): unknown {
  const request = fetchState.requests.find(
    (entry) => entry.method === "POST" && entry.url.includes(suffix),
  );
  return request?.body === undefined ? undefined : JSON.parse(request.body);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("chat permissions", () => {
  it("renders risk and scope chips, then allows once", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      permissions: [permission()],
    });
    await flushPromises();
    const dock = wrapper.find("[data-chat-prompt-dock]");
    expect(dock.attributes("data-prompt-kind")).toBe("permission");
    expect(dock.text()).toContain("Allow the agent to run this command?");
    expect(dock.find("[data-permission-risk]").attributes("data-risk")).toBe("high");
    expect(dock.text()).toContain("echo fixture");

    await dock.find("[data-permission-once]").trigger("click");
    await flushPromises();

    expect(replyBody(fetchState, "/permissions/p1/reply")).toEqual({
      source: "v1",
      reply: "once",
    });
    expect(wrapper.find("[data-chat-prompt-dock]").exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find("[data-chat-composer-input]").element);
    wrapper.unmount();
  });

  it("requires a confirmation before always-allow and refreshes saved permissions", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      permissions: [permission()],
      savedPermissions: [
        { id: "saved1", projectID: "p", action: "bash", resource: "echo fixture" },
      ],
    });
    await flushPromises();
    await wrapper.find("[data-permission-always]").trigger("click");
    expect(wrapper.find("[data-permission-confirm-always]").exists()).toBe(true);
    await wrapper.find("[data-permission-confirm-always]").trigger("click");
    await flushPromises();

    expect(replyBody(fetchState, "/permissions/p1/reply")).toEqual({
      source: "v1",
      reply: "always",
    });
    const savedLoads = fetchState.requests.filter(
      (entry) => entry.method === "GET" && entry.url.includes("/permissions/saved"),
    );
    expect(savedLoads.length).toBeGreaterThanOrEqual(2);
    expect(wrapper.find("[data-chat-saved-section]").exists()).toBe(true);
    wrapper.unmount();
  });

  it("sends an optional deny message only after confirmation", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      permissions: [permission()],
    });
    await flushPromises();
    await wrapper.find("[data-permission-deny]").trigger("click");
    expect(wrapper.find("[data-permission-confirm-deny]").exists()).toBe(true);
    await wrapper.find(".chat-question, [data-prompt-kind] textarea").setValue("not needed");
    await wrapper.find("[data-permission-confirm-deny]").trigger("click");
    await flushPromises();

    expect(replyBody(fetchState, "/permissions/p1/reply")).toEqual({
      source: "v1",
      reply: "reject",
      message: "not needed",
    });
    wrapper.unmount();
  });

  it("revokes a saved permission from the context rail", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      savedPermissions: [
        { id: "saved1", projectID: "p", action: "bash", resource: "echo fixture" },
      ],
    });
    await flushPromises();
    expect(wrapper.find("[data-chat-saved-section]").exists()).toBe(true);
    await wrapper.find("[data-saved-revoke]").trigger("click");
    expect(wrapper.find("[data-saved-revoke]").text()).toBe("Confirm revoke");
    await wrapper.find("[data-saved-revoke]").trigger("click");
    await flushPromises();

    const deleted = fetchState.requests.find(
      (entry) => entry.method === "DELETE" && entry.url.includes("/permissions/saved/saved1"),
    );
    expect(deleted).toBeDefined();
    expect(wrapper.find("[data-chat-saved-section]").exists()).toBe(false);
    wrapper.unmount();
  });

  it("tombstones an expired permission reply", async () => {
    const { wrapper, fetchState } = await mountChat("/chat?app=alpha&project=p&session=s1", {
      permissions: [permission()],
      permissionReplyStatus: 404,
    });
    await flushPromises();
    await wrapper.find("[data-permission-once]").trigger("click");
    await flushPromises();
    expect(replyBody(fetchState, "/permissions/p1/reply")).toBeDefined();
    expect(wrapper.find("[data-chat-prompt-dock]").exists()).toBe(false);
    wrapper.unmount();
  });
});
