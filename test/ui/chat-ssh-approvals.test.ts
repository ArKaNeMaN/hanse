import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatSshApprovals from "../../ui/components/chat/ChatSshApprovals.vue";

interface Approval {
  id: string;
  hostName: string;
  action: string;
  commandPreview: string;
  requestedAt: string;
  expiresAt: string;
}

function approval(id: string): Approval {
  return {
    id,
    hostName: "fixture-host",
    action: "exec",
    commandPreview: `echo ${id}`,
    requestedAt: "2026-10-30T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
}

function installFetch(initial: readonly Approval[]): {
  requests: Array<{ method: string; url: string; body?: string }>;
  approvals: Approval[];
} {
  const state = { requests: [] as Array<{ method: string; url: string; body?: string }> };
  const approvals = initial.map((entry) => ({ ...entry }));
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    state.requests.push({
      method,
      url,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (method === "POST") {
      const id = /approvals\/([^/?]+)\/decision/.exec(url)?.[1] ?? "";
      const index = approvals.findIndex((entry) => entry.id === decodeURIComponent(id));
      if (index >= 0) approvals.splice(index, 1);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ approval: {} }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ approvals }),
    } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return { ...state, approvals };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  document.body.innerHTML = "";
});

describe("ChatSshApprovals", () => {
  it("polls once, renders approval cards, and stops when idle", async () => {
    vi.useFakeTimers();
    const state = installFetch([approval("a1"), approval("a2")]);
    const wrapper = mount(ChatSshApprovals, {
      props: { appKey: "alpha", project: "p", intervalMs: 5_000 },
    });
    await flushPromises();
    expect(wrapper.findAll(".ssh-approval-card")).toHaveLength(2);
    expect(wrapper.text()).toContain("fixture-host");
    expect(state.requests.filter((entry) => entry.method === "GET")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(state.requests.filter((entry) => entry.method === "GET")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(state.requests.filter((entry) => entry.method === "GET")).toHaveLength(3);

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(state.requests.filter((entry) => entry.method === "GET")).toHaveLength(3);
  });

  it("skips polling while the document is hidden and refreshes on visibility", async () => {
    vi.useFakeTimers();
    const state = installFetch([approval("a1")]);
    const wrapper = mount(ChatSshApprovals, {
      props: { appKey: "alpha", project: "p", intervalMs: 5_000 },
    });
    await flushPromises();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.requests.filter((entry) => entry.method === "GET")).toHaveLength(1);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(state.requests.filter((entry) => entry.method === "GET")).toHaveLength(2);
    wrapper.unmount();
  });

  it("approves and rejects through the existing app-scoped decision route", async () => {
    const state = installFetch([approval("a1"), approval("a2")]);
    const wrapper = mount(ChatSshApprovals, {
      props: { appKey: "alpha", project: "p", intervalMs: 60_000 },
    });
    await flushPromises();
    await wrapper.find('[data-approval-id="a1"] [data-ssh-approve]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-approval-id="a2"] [data-ssh-reject]').trigger("click");
    await flushPromises();

    const decisions = state.requests.filter((entry) => entry.method === "POST");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.url).toBe("/api/apps/alpha/ssh/approvals/a1/decision?project=p");
    expect(JSON.parse(decisions[0]?.body ?? "{}")).toEqual({ decision: "approve" });
    expect(JSON.parse(decisions[1]?.body ?? "{}")).toEqual({ decision: "reject" });
    expect(wrapper.findAll(".ssh-approval-card")).toHaveLength(0);
    wrapper.unmount();
  });

  it("uses one interval per mount (no duplicate timer on card updates)", async () => {
    vi.useFakeTimers();
    const state = installFetch([approval("a1")]);
    const wrapper = mount(ChatSshApprovals, {
      props: { appKey: "alpha", project: "p", intervalMs: 1_000 },
    });
    await flushPromises();
    await wrapper.find('[data-approval-id="a1"] [data-ssh-approve]').trigger("click");
    await flushPromises();
    const posts = state.requests.filter((entry) => entry.method === "POST").length;
    expect(posts).toBe(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromises();
    expect(state.requests.filter((entry) => entry.method === "POST")).toHaveLength(posts);
    wrapper.unmount();
  });
});
