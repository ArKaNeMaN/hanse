import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { ApiError } from "../api.js";
import type { BootPayload } from "../boot.js";
import type { SshApproval, SshGrant, SshHost, SshProps } from "../ssh-types.js";
import { useToastStore } from "../stores/toasts.js";
import SshPage from "./SshPage.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

const HOST_ID = "host-1";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEUyRUZpeHR1cmU e2e@example.test";

function grant(overrides: Partial<SshGrant> = {}): SshGrant {
  return {
    id: "grant-1",
    appId: "p:a",
    appKey: "a",
    projectId: "p",
    hostId: HOST_ID,
    hostName: "deploy-host",
    approvalId: "approval-1",
    grantedBy: "operator",
    grantedAt: "2026-10-28T10:00:00.000Z",
    lastUsedAt: "2026-10-28T10:01:00.000Z",
    idleExpiresAt: "2099-10-28T10:31:00.000Z",
    absoluteExpiresAt: "2099-10-28T18:00:00.000Z",
    revokedAt: null,
    state: "active",
    canRevoke: true,
    actions: {
      api: { revoke: "/api/projects/p/apps/a/ssh/grants/grant-1/revoke" },
      form: { revoke: "/ssh/grants/grant-1/revoke" },
    },
    ...overrides,
  };
}

function host(overrides: Partial<SshHost> = {}): SshHost {
  return {
    id: HOST_ID,
    name: "deploy-host",
    address: "203.0.113.10",
    username: "deploy",
    port: 22,
    remoteRoot: "/srv/app",
    requireApproval: true,
    approvalIdleSec: 1800,
    hostKeyFingerprint: null,
    hostKeyPinnedAt: null,
    hostKeyMismatchAt: null,
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    credential: {
      publicKey: PUBLIC_KEY,
      fingerprint: "SHA256:fixture-client",
      keyType: "ssh-ed25519",
      bits: 256,
      validatedAt: "2026-10-28T10:00:00.000Z",
      updatedAt: "2026-10-28T10:00:00.000Z",
    },
    allowed: true,
    grant: grant(),
    pendingApprovals: 1,
    pinState: "unpinned",
    status: "unpinned",
    anchor: `ssh-host-${HOST_ID}`,
    returnTo: `/ssh?target=p%3Aa#ssh-host-${HOST_ID}`,
    actions: {
      api: {
        host: `/api/ssh/hosts/${HOST_ID}`,
        test: `/api/ssh/hosts/${HOST_ID}/test`,
        update: `/api/ssh/hosts/${HOST_ID}`,
        delete: `/api/ssh/hosts/${HOST_ID}`,
        rePin: `/api/ssh/hosts/${HOST_ID}/re-pin`,
      },
      form: {
        test: `/ssh/hosts/${HOST_ID}/test`,
        rePin: `/ssh/hosts/${HOST_ID}/re-pin`,
        update: `/ssh/hosts/${HOST_ID}/update`,
        delete: `/ssh/hosts/${HOST_ID}/delete`,
      },
    },
    ...overrides,
  };
}

function approval(overrides: Partial<SshApproval> = {}): SshApproval {
  return {
    id: "approval-1",
    appId: "p:a",
    appKey: "a",
    projectId: "p",
    hostId: HOST_ID,
    hostName: "deploy-host",
    address: "203.0.113.10",
    username: "deploy",
    action: "exec",
    commandHash: "hash-1",
    commandPreview: "uptime",
    commandBytes: 6,
    status: "pending",
    requestedAt: "2026-10-28T10:00:00.000Z",
    expiresAt: "2099-10-28T10:05:00.000Z",
    decidedAt: null,
    decidedBy: null,
    grantId: null,
    actions: {
      api: {
        approve: "/api/apps/a/ssh/approvals/approval-1/decision?project=p",
        reject: "/api/apps/a/ssh/approvals/approval-1/decision?project=p",
      },
      form: {
        approve: "/ssh/approvals/approval-1/decision",
        reject: "/ssh/approvals/approval-1/decision",
      },
      returnTo: "/ssh?target=p%3Aa#ssh-approvals",
    },
    ...overrides,
  };
}

const LABELS: SshProps["labels"] = {
  title: "SSH hosts",
  description:
    "Coordinator-held keys, host-key pinning, per-application grants, approvals, and audit.",
  nav: {
    ariaLabel: "SSH console",
    sectionsLabel: "SSH sections",
    hosts: "Hosts",
    access: "Access",
    approvals: "Approvals",
    audit: "Audit",
    scope: "Application scope",
    apply: "Apply",
    allApplications: "All applications",
  },
  actions: {
    addHost: "Add host",
    editHost: "Edit host",
    test: "Test connection",
    prepareRePin: "Prepare re-pin",
    rePin: "Re-pin host key",
    refresh: "Refresh",
    saveAllowlist: "Save allowlist",
    revoke: "Revoke",
    approve: "Approve",
    reject: "Reject",
    saveHost: "Save host",
    deleteHost: "Delete host",
    cancel: "Cancel",
  },
  empty: {
    hosts: {
      iconName: "terminal",
      title: "No SSH hosts yet",
      body: "Add a host to hold its key in the coordinator, pin its host key, and grant access per application.",
      actionLabel: "Add host",
    },
    grants: "No grants yet. Approving a pending request creates an idle grant.",
    chooseApplication: {
      iconName: "lock",
      title: "Choose an application",
      body: "Access is scoped to one application. Use the Application scope picker above to view its allowlist, grants, approvals, and audit.",
      actionLabel: null,
    },
    approvals: {
      iconName: "inbox",
      title: "No pending approvals",
      body: "Requests appear here and in chat. Each request expires after 5 minutes.",
      actionLabel: null,
    },
    audit: {
      iconName: "activity",
      title: "No SSH activity yet",
      body: "Tests, commands, uploads, and downloads are recorded here with their result.",
      actionLabel: null,
    },
  },
};

function props(overrides: Partial<SshProps> = {}): SshProps {
  const hosts = overrides.hosts ?? [host()];
  const grants = overrides.grants ?? [grant()];
  const approvals = overrides.approvals ?? [approval()];
  const audit = overrides.audit ?? [
    {
      id: 1,
      appId: "p:a",
      projectId: "p",
      appKey: "a",
      hostId: HOST_ID,
      hostName: "deploy-host",
      address: "203.0.113.10",
      username: "deploy",
      action: "exec",
      commandPreview: "uptime",
      startedAt: "2026-10-28T10:00:00.000Z",
      finishedAt: "2026-10-28T10:00:01.000Z",
      exitCode: 0,
      errorCode: null,
      outcome: "ok" as const,
    },
  ];
  return {
    scope: {
      projectId: "p",
      appKey: "a",
      appId: "p:a",
      projectName: "Alpha",
      scoped: true,
      href: "/ssh?target=p%3Aa",
      hostsHref: "/ssh?target=p%3Aa#ssh-hosts",
      accessHref: "/ssh?target=p%3Aa#ssh-access",
      approvalsHref: "/ssh?target=p%3Aa#ssh-approvals",
      auditHref: "/ssh?target=p%3Aa#ssh-audit",
      settingsHref: "/projects/p/apps/a/settings",
      options: [
        {
          label: "Alpha",
          options: [
            { value: "p:a", label: "Alpha / a", selected: true },
            { value: "p:b", label: "Alpha / b", selected: false },
          ],
        },
      ],
    },
    hosts,
    grants,
    approvals,
    audit,
    counts: {
      hosts: hosts.length,
      pinned: hosts.filter((entry) => entry.pinState === "pinned").length,
      unpinned: hosts.filter((entry) => entry.pinState === "unpinned").length,
      mismatch: hosts.filter((entry) => entry.pinState === "mismatch").length,
      pendingApprovals: approvals.length,
      activeGrants: grants.filter((entry) => entry.state === "active").length,
      grants: grants.length,
      allowedHosts: hosts.filter((entry) => entry.allowed).length,
      auditRows: audit.length,
    },
    policy: {
      idleOptions: [300, 900, 1800, 3600, 7200],
      idleDefaultSec: 1800,
      idleMinSec: 300,
      idleMaxSec: 7200,
      absoluteGrantSec: 28800,
      pendingApprovalSec: 300,
      auditLimit: 30,
    },
    actions: {
      createHost: "/api/ssh/hosts",
      refresh: "/ssh?target=p%3Aa",
      saveGrants: "/api/projects/p/apps/a/ssh",
      audit: "/api/apps/a/ssh/audit?project=p",
      form: { createHost: "/ssh/hosts", saveGrants: "/ssh/grants" },
      api: {
        hosts: "/api/ssh/hosts",
        approvalsCount: "/api/ssh/approvals/count",
        appApprovals: "/api/apps/a/ssh/approvals?project=p",
        audit: "/api/apps/a/ssh/audit?project=p",
        grants: "/api/projects/p/apps/a/ssh",
      },
    },
    labels: LABELS,
    test: null,
    error: null,
    dialogs: {
      add: {
        open: false,
        values: {},
        error: null,
        action: "/ssh/hosts",
        returnTo: "/ssh?target=p%3Aa#ssh-hosts",
      },
      edits: [],
    },
    ...overrides,
  };
}

function unscopedProps(): SshProps {
  const base = props();
  return {
    ...base,
    scope: {
      projectId: "",
      appKey: "",
      appId: null,
      projectName: null,
      scoped: false,
      href: "/ssh",
      hostsHref: "/ssh#ssh-hosts",
      accessHref: "/ssh#ssh-access",
      approvalsHref: "/ssh#ssh-approvals",
      auditHref: "/ssh#ssh-audit",
      settingsHref: "/settings",
      options: [],
    },
    hosts: [host({ allowed: false, grant: null })],
    grants: [],
    counts: {
      ...base.counts,
      activeGrants: 0,
      allowedHosts: 0,
      grants: 0,
    },
    actions: { ...base.actions, saveGrants: null },
  };
}

function boot(payload: SshProps | null, routeId: BootPayload["route"]["id"] = "ssh"): BootPayload {
  return {
    route: { id: routeId, params: {} },
    props: payload,
    chrome: {
      sidebarNav: "",
      breadcrumb: "",
      title: "SSH",
      active: "ssh",
      pendingCount: 0,
      sshPendingCount: 1,
    },
  };
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/projects", component: { template: "<div />" } },
      { path: "/ssh", component: { template: "<div />" } },
    ],
  });
}

async function mountPage(
  payload: BootPayload,
  path = "/ssh?target=p:a",
  router = testRouter(),
): Promise<VueWrapper> {
  await router.push(path);
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return mount(SshPage, {
    props: { boot: payload },
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
}

function toasts() {
  return useToastStore().toasts;
}

function button(wrapper: VueWrapper, hostId: string, label: string) {
  return wrapper
    .get(`#ssh-host-${hostId}`)
    .findAll("button")
    .find((entry) => entry.text().includes(label));
}

describe("SshPage", () => {
  beforeEach(() => {
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
  });

  it("renders boot hosts, grants, approvals, audit, scope, and counts", async () => {
    const wrapper = await mountPage(boot(props()));

    expect(wrapper.get("h1").text()).toBe("SSH hosts");
    expect(wrapper.text()).toContain("Access");
    expect(wrapper.text()).toContain("1 host");
    expect(wrapper.text()).toContain("1 pending");
    expect(wrapper.text()).toContain("1 active grant");
    expect(wrapper.get("#ssh-scope").element).toHaveProperty("value", "p:a");
    expect(wrapper.get("#ssh-host-host-1").text()).toContain("deploy-host");
    expect(wrapper.get("#ssh-host-host-1").text()).toContain("Not pinned");
    expect(wrapper.get("#ssh-access").text()).toContain("Access for Alpha / a");
    expect(wrapper.get("#ssh-access").text()).toContain("deploy-host");
    expect(wrapper.get("#ssh-access").text()).toContain("Active");
    expect(wrapper.get("#ssh-approvals").text()).toContain("uptime");
    expect(wrapper.get("#ssh-audit").text()).toContain("ok");
    expect(wrapper.get("#ssh-audit").text()).toContain("uptime");
    expect(wrapper.findAll("time").length).toBeGreaterThan(0);
    expect(wrapper.find("style").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("PRIVATE KEY");
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("renders the unscoped console with the choose-application state", async () => {
    const wrapper = await mountPage(boot(unscopedProps()), "/ssh");

    expect(wrapper.text()).toContain("Choose an application");
    expect(wrapper.text()).toContain("All applications");
    expect(wrapper.get("#ssh-access").text()).not.toContain("Save allowlist");
    expect(wrapper.get("#ssh-audit").text()).toContain("Application");
    expect(mocks.apiQuery).not.toHaveBeenCalled();
  });

  it("navigates the scope selector through the router and refetches", async () => {
    const router = testRouter();
    const wrapper = await mountPage(boot(props()), "/ssh?target=p:a", router);
    mocks.apiQuery.mockResolvedValue({ ...props() });

    await wrapper.get("#ssh-scope").setValue("p:b");
    await wrapper.get(".ssh-nav__scope").trigger("submit");
    await flushPromises();

    expect(router.currentRoute.value.query.target).toBe("p:b");
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/ssh?target=p%3Ab");
  });

  it("fetches props when the boot payload belongs to another route", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    mocks.apiQuery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const wrapper = await mountPage(boot(props(), "overview"));

    expect(wrapper.text()).toContain("Loading SSH console…");
    expect(wrapper.text()).not.toContain("deploy-host");

    resolve?.({ ...props() });
    await flushPromises();
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/ssh?target=p%3Aa");
    expect(wrapper.text()).toContain("deploy-host");
  });

  it("shows a fetch error with retry and the legacy escape hatch", async () => {
    mocks.apiQuery.mockRejectedValueOnce(new ApiError("SSH is unavailable.", 503));
    const wrapper = await mountPage(boot(null, "overview"));
    await flushPromises();

    expect(wrapper.text()).toContain("SSH console could not be loaded");
    expect(wrapper.text()).toContain("SSH is unavailable.");
    expect(wrapper.get("a[href='?legacy=1']").text()).toBe("Use the classic interface");

    mocks.apiQuery.mockResolvedValue({ ...props() });
    await wrapper
      .get("section[aria-labelledby='ssh-error-title'] .card__body button")
      .trigger("click");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiQuery).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("deploy-host");
    expect(wrapper.find("#ssh-error-title").exists()).toBe(false);
  });

  it("renders every empty state", async () => {
    const empty = props({
      hosts: [],
      grants: [],
      approvals: [],
      audit: [],
    });
    const wrapper = await mountPage(
      boot({
        ...empty,
        counts: {
          ...empty.counts,
          hosts: 0,
          pinned: 0,
          unpinned: 0,
          mismatch: 0,
          pendingApprovals: 0,
          activeGrants: 0,
          grants: 0,
          allowedHosts: 0,
          auditRows: 0,
        },
      }),
    );

    expect(wrapper.text()).toContain("No SSH hosts yet");
    expect(wrapper.text()).toContain("No grants yet.");
    expect(wrapper.text()).toContain("No pending approvals");
    expect(wrapper.text()).toContain("No SSH activity yet");
  });

  it("adds a host with a write-only key and never leaves the key in the DOM", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation.mockResolvedValue({ host: { id: "host-2" } });
    mocks.apiQuery.mockResolvedValue({ ...props() });

    await wrapper.get(".page-header__actions .btn-primary").trigger("click");
    const dialog = wrapper.get("dialog#ssh-add-dialog");
    expect(dialog.attributes("open")).toBeDefined();

    await dialog.get("#ssh-add-dialog-name").setValue("new-host");
    await dialog.get("#ssh-add-dialog-address").setValue("203.0.113.20");
    await dialog.get("#ssh-add-dialog-username").setValue("deployer");
    await dialog.get("#ssh-add-dialog-private-key").setValue("PRIVATE KEY MATERIAL");
    await dialog.get("form").trigger("submit");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/ssh/hosts",
      {
        json: expect.objectContaining({
          name: "new-host",
          address: "203.0.113.20",
          username: "deployer",
          port: 22,
          requireApproval: true,
          approvalIdleSec: 1800,
          privateKey: "PRIVATE KEY MATERIAL",
        }),
      },
      { method: "POST" },
    );
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Host added.", tone: "success" }),
    );
    expect(wrapper.html()).not.toContain("PRIVATE KEY MATERIAL");
    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/ssh?target=p%3Aa");
  });

  it("keeps the add dialog open and reports an error when the mutation fails", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation.mockRejectedValue(new ApiError("A host with that name already exists.", 400));

    await wrapper.get(".page-header__actions .btn-primary").trigger("click");
    const dialog = wrapper.get("dialog#ssh-add-dialog");
    await dialog.get("#ssh-add-dialog-name").setValue("deploy-host");
    await dialog.get("#ssh-add-dialog-address").setValue("203.0.113.10");
    await dialog.get("#ssh-add-dialog-username").setValue("deploy");
    await dialog.get("#ssh-add-dialog-private-key").setValue("key");
    await dialog.get("form").trigger("submit");
    await flushPromises();

    expect(dialog.attributes("open")).toBeDefined();
    expect(dialog.text()).toContain("A host with that name already exists.");
    expect(toasts()).toContainEqual(
      expect.objectContaining({
        message: "A host with that name already exists.",
        tone: "error",
      }),
    );
  });

  it("edits a host with PATCH and deletes it after confirmation", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation.mockResolvedValue({ host: { id: HOST_ID } });
    mocks.apiQuery.mockResolvedValue({ ...props() });

    await button(wrapper, HOST_ID, "Edit host")?.trigger("click");
    const dialog = wrapper.get(`dialog#ssh-edit-${HOST_ID}`);
    expect((dialog.get(`#ssh-edit-${HOST_ID}-name`).element as HTMLInputElement).value).toBe(
      "deploy-host",
    );

    await dialog.get(`#ssh-edit-${HOST_ID}-name`).setValue("renamed-host");
    await dialog.get("form").trigger("submit");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      `/api/ssh/hosts/${HOST_ID}`,
      { json: expect.objectContaining({ name: "renamed-host" }) },
      { method: "PATCH" },
    );
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Host updated.", tone: "success" }),
    );

    await button(wrapper, HOST_ID, "Edit host")?.trigger("click");
    const reopened = wrapper.get(`dialog#ssh-edit-${HOST_ID}`);
    const deleteButton = reopened.get(".ssh-form__group--danger button.btn-danger");
    await deleteButton.trigger("click");
    await reopened.get(".ssh-form__group--danger button.btn-danger").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenLastCalledWith(
      `/api/ssh/hosts/${HOST_ID}`,
      { json: {} },
      { method: "DELETE" },
    );
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Host deleted.", tone: "success" }),
    );
  });

  it("tests a host successfully and refreshes props", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation.mockResolvedValue({
      result: {
        ok: true,
        authOk: true,
        fingerprint: "SHA256:presented",
        previousFingerprint: null,
        mismatch: false,
      },
    });
    mocks.apiQuery.mockResolvedValue({ ...props() });

    await button(wrapper, HOST_ID, "Test connection")?.trigger("click");
    await flushPromises();
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(`/api/ssh/hosts/${HOST_ID}/test`, {
      json: { ignorePin: false },
    });
    expect(wrapper.get(`#ssh-host-${HOST_ID}`).text()).toContain("Authenticated");
    expect(wrapper.get(`#ssh-host-${HOST_ID}`).text()).toContain("SHA256:presented");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Connection authenticated.", tone: "success" }),
    );
    expect(mocks.apiQuery).toHaveBeenCalled();
  });

  it("reports a failed test without dropping the host card", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation.mockResolvedValue({
      result: {
        ok: false,
        authOk: false,
        code: "ssh_connect_timeout",
        message: "Timed out while connecting.",
        previousFingerprint: null,
        mismatch: false,
      },
    });
    mocks.apiQuery.mockResolvedValue({ ...props() });

    await button(wrapper, HOST_ID, "Test connection")?.trigger("click");
    await flushPromises();

    const card = wrapper.get(`#ssh-host-${HOST_ID}`);
    expect(card.text()).toContain("Test failed");
    expect(card.text()).toContain("Timed out while connecting.");
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Timed out while connecting.", tone: "error" }),
    );
  });

  it("prepares a re-pin, fills the observed fingerprint, and submits it", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation
      .mockResolvedValueOnce({
        result: {
          ok: true,
          authOk: true,
          fingerprint: "SHA256:observed",
          previousFingerprint: null,
          mismatch: false,
        },
      })
      .mockResolvedValueOnce({ host: { id: HOST_ID } });
    mocks.apiQuery.mockResolvedValue({ ...props() });

    await button(wrapper, HOST_ID, "Prepare re-pin")?.trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenNthCalledWith(1, `/api/ssh/hosts/${HOST_ID}/test`, {
      json: { ignorePin: true },
    });
    const input = wrapper.get(`#ssh-repin-${HOST_ID}`);
    expect((input.element as HTMLInputElement).value).toBe("SHA256:observed");

    await wrapper.get(`#ssh-host-${HOST_ID} details form`).trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenNthCalledWith(2, `/api/ssh/hosts/${HOST_ID}/re-pin`, {
      json: { fingerprint: "SHA256:observed" },
    });
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Host key re-pinned.", tone: "success" }),
    );
  });

  it("saves the allowlist and revokes a grant through the existing APIs", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation.mockResolvedValue({});
    mocks.apiQuery.mockResolvedValue({ ...props() });

    await wrapper.get(".ssh-allowlist input[type='checkbox']").setValue(false);
    await wrapper.get("#ssh-access form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/p/apps/a/ssh", {
      json: { hostIds: [] },
    });

    await wrapper.get("#ssh-access tbody button.btn-danger").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/projects/p/apps/a/ssh/grants/grant-1/revoke",
      { json: {} },
    );
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Grant revoked.", tone: "success" }),
    );
  });

  it("approves and rejects pending approvals through the decision API", async () => {
    const wrapper = await mountPage(boot(props()));
    mocks.apiMutation.mockResolvedValue({});
    mocks.apiQuery.mockResolvedValue({ ...props() });

    const card = wrapper.get(".ssh-approval");
    await card.get("button.btn-primary").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/apps/a/ssh/approvals/approval-1/decision?project=p",
      { json: { decision: "approve" } },
    );
    expect(toasts()).toContainEqual(
      expect.objectContaining({ message: "Approval recorded.", tone: "success" }),
    );

    await wrapper.get(".ssh-approval").get("button.btn-danger").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenLastCalledWith(
      "/api/apps/a/ssh/approvals/approval-1/decision?project=p",
      { json: { decision: "reject" } },
    );
  });
});
