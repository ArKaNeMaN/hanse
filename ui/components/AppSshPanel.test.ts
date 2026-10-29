import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import type { AppSshProps } from "../app-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppSshPanel from "./AppSshPanel.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

const SSH: AppSshProps = {
  href: "/ssh?project=p&app=alpha",
  available: true,
  hosts: 1,
  pendingApprovals: 1,
  grants: [
    {
      id: "grant-1",
      hostId: "host-1",
      hostName: "test-host",
      approvalId: "approval-1",
      grantedBy: "operator",
      grantedAt: "2026-10-28T10:00:00.000Z",
      lastUsedAt: "2026-10-28T10:01:00.000Z",
      idleExpiresAt: "2099-10-28T10:31:00.000Z",
      absoluteExpiresAt: "2099-10-28T18:00:00.000Z",
      revokedAt: null,
      state: "active",
    },
  ],
  approvals: [
    {
      id: "approval-2",
      hostId: "host-1",
      hostName: "test-host",
      action: "exec",
      commandPreview: "echo e2e",
      status: "pending",
      requestedAt: "2026-10-28T10:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      decidedAt: null,
      grantId: null,
    },
  ],
  audit: [
    {
      id: 1,
      hostId: "host-1",
      hostName: "test-host",
      action: "exec",
      commandPreview: "uptime",
      startedAt: "2026-10-28T10:00:00.000Z",
      finishedAt: "2026-10-28T10:00:01.000Z",
      exitCode: 0,
      errorCode: null,
      outcome: "ok",
    },
  ],
};

const HOSTS = {
  hosts: [
    {
      id: "host-1",
      name: "test-host",
      address: "203.0.113.10",
      port: 22,
      username: "tester",
      requireApproval: true,
      allowed: true,
      grant: { id: "grant-1" },
      pendingApprovals: 1,
    },
    {
      id: "host-2",
      name: "second-host",
      address: "203.0.113.11",
      port: 22,
      username: "tester",
      requireApproval: false,
      allowed: false,
      grant: null,
      pendingApprovals: 0,
    },
  ],
  grants: [],
};

function toasts() {
  return useToastStore().toasts;
}

function mountPanel(
  overrides: Partial<AppSshProps> = {},
  disabled = false,
  listeners: Record<string, unknown> = {},
) {
  return mount(AppSshPanel, {
    props: { ssh: { ...SSH, ...overrides }, projectId: "p", appKey: "alpha", disabled },
    attrs: listeners,
    global: { plugins: [createPinia()] },
  });
}

async function openManage(wrapper: ReturnType<typeof mountPanel>): Promise<void> {
  const manage = wrapper.get("#ssh-access-manage");
  (manage.element as HTMLDetailsElement).open = true;
  await manage.trigger("toggle");
  await flushPromises();
}

describe("AppSshPanel", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
  });

  it("renders grants, approvals, audit, and the manage link", () => {
    const wrapper = mountPanel();
    expect(wrapper.get("#ssh-panel").text()).toContain("1 allowed host");
    expect(wrapper.get("#ssh-panel").text()).toContain("1 pending approval");
    expect(wrapper.get("#ssh-grants").text()).toContain("test-host");
    expect(wrapper.get("#ssh-grants").text()).toContain("Revoke");
    expect(wrapper.get("#ssh-approvals").text()).toContain("echo e2e");
    expect(wrapper.get("#ssh-approvals").text()).toContain("Approve");
    expect(wrapper.get("#ssh-approvals").text()).toContain("Reject");
    expect(wrapper.get("#ssh-audit").text()).toContain("uptime");
    expect(wrapper.find("#ssh-manage").attributes("href")).toBe("/ssh?project=p&app=alpha");
    expect(wrapper.find("style").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("PRIVATE KEY");
  });

  it("loads the allowlist, saves checked hosts, and refreshes", async () => {
    mocks.apiQuery.mockResolvedValue(HOSTS);
    mocks.apiMutation.mockResolvedValue(HOSTS);
    const onChanged = vi.fn();
    const wrapper = mountPanel({}, false, { onChanged });

    await openManage(wrapper);
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/projects/p/apps/alpha/ssh");
    expect(wrapper.get("#ssh-allowlist").text()).toContain("test-host");
    expect(wrapper.get("#ssh-allowlist").text()).toContain("second-host");

    const checkboxes = wrapper.findAll("#ssh-allowlist input[type='checkbox']");
    await checkboxes[1]?.setValue(true);
    await wrapper.get("#ssh-allowlist-save").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/p/apps/alpha/ssh", {
      json: { hostIds: ["host-1", "host-2"] },
    });
    expect(toasts().map((toast) => toast.message)).toContain("Allowlist saved");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("revokes a grant through the app-scoped handler", async () => {
    mocks.apiMutation.mockResolvedValue({ revoked: true });
    const onChanged = vi.fn();
    const wrapper = mountPanel({}, false, { onChanged });

    await wrapper
      .get("#ssh-grants")
      .findAll("button")
      .find((button) => button.text() === "Revoke")
      ?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/projects/p/apps/alpha/ssh/grants/grant-1/revoke",
      { json: {} },
    );
    expect(toasts().map((toast) => toast.message)).toContain("Grant revoked");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("approves and rejects pending approvals", async () => {
    mocks.apiMutation.mockResolvedValue({ approved: true });
    const wrapper = mountPanel();

    const approve = wrapper
      .get("#ssh-approvals")
      .findAll("button")
      .find((button) => button.text() === "Approve");
    await approve?.trigger("click");
    await flushPromises();
    const reject = wrapper
      .get("#ssh-approvals")
      .findAll("button")
      .find((button) => button.text() === "Reject");
    await reject?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenNthCalledWith(
      1,
      "/api/apps/alpha/ssh/approvals/approval-2/decision?project=p",
      { json: { decision: "approve" } },
    );
    expect(mocks.apiMutation).toHaveBeenNthCalledWith(
      2,
      "/api/apps/alpha/ssh/approvals/approval-2/decision?project=p",
      { json: { decision: "reject" } },
    );
    expect(toasts().map((toast) => toast.message)).toContain("Approval recorded");
  });

  it("refreshes the audit read", async () => {
    mocks.apiQuery.mockResolvedValue({
      audit: [
        {
          ...SSH.audit[0],
          id: 2,
          commandPreview: "audit-after-refresh",
        },
      ],
    });
    const wrapper = mountPanel();

    await wrapper.get("#ssh-audit-refresh").trigger("click");
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/apps/alpha/ssh/audit?project=p&limit=30");
    expect(wrapper.get("#ssh-audit").text()).toContain("audit-after-refresh");
  });

  it("disables destructive actions and maps failures to toasts", async () => {
    mocks.apiMutation.mockRejectedValue(new ApiError("grant is gone", 404));
    const wrapper = mountPanel({}, true);

    expect(wrapper.get("#ssh-grants").findAll("button")[0]?.attributes("disabled")).toBeDefined();
    expect(
      wrapper.get("#ssh-approvals").findAll("button")[0]?.attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.get("#ssh-audit-refresh").attributes("disabled")).toBeUndefined();
  });

  it("surfaces an action failure as an error toast", async () => {
    mocks.apiMutation.mockRejectedValue(new ApiError("grant is gone", 404));
    const wrapper = mountPanel();

    const revoke = wrapper
      .get("#ssh-grants")
      .findAll("button")
      .find((button) => button.text() === "Revoke");
    await revoke?.trigger("click");
    await flushPromises();

    expect(toasts().map((toast) => toast.message)).toContain("grant is gone");
  });
});
