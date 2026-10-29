import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { ApiError } from "../api.js";
import type {
  AppGitSummaryProps,
  AppImageProps,
  AppImageState,
  AppProps,
  AppSshProps,
} from "../app-types.js";
import type { BootPayload } from "../boot.js";
import type { GitFile, GitOperation, GitStatus } from "../git-types.js";
import { useToastStore } from "../stores/toasts.js";
import AppPage from "./AppPage.vue";

const mocks = vi.hoisted(() => ({
  apiQuery: vi.fn(),
  apiMutation: vi.fn(),
}));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, apiQuery: mocks.apiQuery, apiMutation: mocks.apiMutation };
});

const CHROME = {
  sidebarNav: "",
  breadcrumb: "",
  title: "alpha",
  active: "project" as const,
  pendingCount: 1,
  sshPendingCount: 1,
};

const IMAGE: AppImageProps = {
  configured: false,
  status: "default",
  state: "cancelled",
  label: "Default image",
  glyph: "layers",
  action: "",
  hint: "This application uses the shared default agent image.",
  ref: null,
  hash: null,
  builtAt: null,
  base: { kind: null, kindLabel: "Unknown", ref: null, digest: null },
  drift: false,
  blocked: false,
  usable: false,
  rollback: {
    available: false,
    ref: null,
    builtAt: null,
    action: "Roll back image",
    restart: false,
  },
  error: null,
  building: false,
  buildDisabled: false,
  rollbackDisabled: false,
  projectId: "p",
  appKey: "alpha",
  hrefs: {
    app: "/projects/p/apps/alpha",
    build: "/api/apps/alpha/build?project=p",
    rollback: "/api/apps/alpha/image/rollback?project=p",
    check: "/api/apps/alpha/image/check?project=p",
    image: "/api/apps/alpha/image?project=p",
    logs: "/api/apps/alpha/image/logs?project=p",
    runtime: "/api/apps/alpha/runtime?project=p",
  },
};

const GIT: AppGitSummaryProps = {
  loaded: true,
  state: "ok",
  message: null,
  branch: { name: "main", detached: false, head: "abcdef1234567890" },
  detached: false,
  dirty: false,
  clean: true,
  conflicted: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  lastCommit: {
    hash: "abcdef1234567890",
    shortHash: "abcdef1",
    subject: "fixture commit",
    author: "E2E Fixture",
    committedAt: "2026-10-20T10:00:00.000Z",
  },
};

function fullStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    state: "ok",
    root: "/workspace/p/apps/alpha",
    branch: { name: "main", detached: false, head: "abcdef1234567890" },
    upstream: null,
    clean: true,
    files: [],
    branches: ["main", "feature"],
    remotes: [],
    lastCommit: GIT.lastCommit,
    operation: null,
    conflicted: false,
    identity: { configured: true },
    ...overrides,
  };
}

function statusForSummary(summary: AppGitSummaryProps): GitStatus {
  const files: GitFile[] = [];
  for (const group of ["staged", "unstaged", "untracked", "conflicted"] as const) {
    for (let index = 0; index < summary.counts[group]; index += 1) {
      files.push({ path: `${group}-${index}.txt`, code: "M", group });
    }
  }
  const branch = summary.branch ?? { name: null, detached: summary.detached, head: null };
  const operation: GitOperation | null =
    summary.operation === null ? null : (summary.operation as GitOperation);
  return {
    state: "ok",
    root: "/workspace/p/apps/alpha",
    branch,
    upstream: summary.upstream,
    clean: summary.clean,
    files,
    branches: summary.detached ? ["main"] : [branch.name ?? "main", "feature"],
    remotes:
      summary.upstream === null
        ? []
        : [{ name: "origin", url: "file:///workspace/p/apps/alpha/.git/e2e-remote.git" }],
    lastCommit: summary.lastCommit,
    operation,
    conflicted: summary.conflicted,
    identity: { configured: true },
  };
}

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

function props(overrides: Partial<AppProps> = {}): AppProps {
  return {
    identity: {
      id: "p:alpha",
      projectId: "p",
      projectName: "Project One",
      rootPath: "/workspace/p",
      appKey: "alpha",
      kind: "service",
      path: "apps/alpha",
      folder: "/workspace/p/apps/alpha",
      href: "/projects/p/apps/alpha",
      master: false,
    },
    header: {
      overline: "Application",
      title: "alpha",
      description: "Repository state and lightweight git actions for this application.",
      meta: ["Project One", "service", "apps/alpha"],
      showChatTerminal: true,
    },
    runtime: {
      state: "running",
      label: "Running",
      glyph: "activity",
      tone: "in_progress",
      configured: true,
      pendingRestart: false,
      pendingRestartReasons: [],
      canRestart: true,
    },
    settings: {
      state: "applied",
      pending: false,
      appliedStateUnknown: false,
      runtimeConfigured: true,
      label: "Applied",
      glyph: "check",
      tone: "delivered",
      copy: "Settings match the running agent.",
      href: "/projects/p/apps/alpha/settings",
      actionLabel: "Review settings",
    },
    image: IMAGE,
    git: {
      apiBase: "/api/projects/p/apps/alpha/git",
      statusHref: "/api/projects/p/apps/alpha/git/status",
      refreshLabel: "Refresh repository status",
      summary: GIT,
    },
    ssh: SSH,
    links: {
      chat: "/chat?app=alpha&project=p",
      terminal: "/terminal?app=alpha&project=p",
      ide: "/ide/?folder=alpha",
      settings: "/projects/p/apps/alpha/settings",
      skills: "/projects/p/apps/alpha/skills",
      ssh: "/ssh?project=p&app=alpha",
    },
    restart: {
      available: true,
      action: "/api/apps/alpha/restart?project=p",
      returnTo: "/projects/p/apps/alpha",
      label: "Restart agent",
      dialogTitle: "Restart alpha?",
      dialogBody: "An active turn will be interrupted. Sessions are kept.",
    },
    delete: {
      deleting: false,
      projectDeleting: false,
      pending: false,
      action: "/api/projects/p/apps/alpha/delete",
      returnTo: "/projects/p/apps/alpha",
      confirmName: "alpha",
      dialog: "application",
      retrying: false,
      title: "Delete application?",
      description: "This removes the application.",
      actionLabel: "Delete application",
      statusLabel: null,
      banner: null,
    },
    master: false,
    profileWarnings: [],
    ...overrides,
  };
}

function imageProps(status: AppImageState, overrides: Partial<AppImageProps> = {}): AppImageProps {
  if (status === "default") {
    return { ...IMAGE, ...overrides };
  }
  const meta: Record<Exclude<AppImageState, "default">, Partial<AppImageProps>> = {
    missing: {
      label: "Not built",
      state: "queued",
      glyph: "clock",
      action: "Build image",
      hint: "No app image has been built. Build it before starting the agent.",
      ref: null,
      usable: false,
    },
    building: {
      label: "Building",
      state: "in_progress",
      glyph: "loader",
      action: "Building…",
      hint: "The runner is building this image. The previous image remains in use.",
      ref: "hanse-alpha:latest",
      building: true,
      buildDisabled: true,
      usable: true,
    },
    ready: {
      label: "Built",
      state: "delivered",
      glyph: "check",
      action: "Rebuild image",
      hint: "The image matches the current Dockerfile and default base.",
      ref: "hanse-alpha:latest",
      usable: true,
    },
    stale: {
      label: "Out of date",
      state: "expired",
      glyph: "hourglass",
      action: "Rebuild image",
      hint: "The Dockerfile or default base changed.",
      ref: "hanse-alpha:latest",
      drift: true,
      usable: true,
    },
    error: {
      label: "Build failed",
      state: "failed",
      glyph: "alert-triangle",
      action: "Retry build",
      hint: "The last build failed. The previous image is kept.",
      ref: "hanse-alpha:latest",
      error: "docker build failed",
      usable: true,
    },
  };
  return {
    ...IMAGE,
    configured: true,
    hash: "sha256:abcdef",
    builtAt: "2026-10-20T10:00:00.000Z",
    base: {
      kind: "default",
      kindLabel: "Default",
      ref: "hanse-agent-default:latest",
      digest: "sha256:base",
    },
    rollback: {
      available: true,
      ref: "hanse-alpha:previous",
      builtAt: "2026-10-19T10:00:00.000Z",
      action: "Roll back image",
      restart: false,
    },
    ...meta[status],
    ...overrides,
  };
}

function boot(
  payload: AppProps | null,
  options: { routeId?: string; id?: string; app?: string } = {},
): BootPayload {
  const routeId = options.routeId ?? "app";
  const id = options.id ?? "p";
  const app = options.app ?? "alpha";
  return {
    route: {
      id: routeId as BootPayload["route"]["id"],
      params: routeId === "app" ? { id, app } : { id },
    },
    props: payload,
    chrome: CHROME,
  };
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/projects", component: { template: "<div />" } },
      { path: "/projects/:id", component: { template: "<div />" } },
      { path: "/projects/:id/apps/:app", component: { template: "<div />" } },
      { path: "/projects/:id/apps/:app/settings", component: { template: "<div />" } },
      { path: "/projects/:id/apps/:app/skills", component: { template: "<div />" } },
    ],
  });
}

function installQueries(
  appProps: AppProps,
  live: { image?: unknown; runtime?: unknown; git?: GitStatus | null; gitError?: unknown } = {},
) {
  mocks.apiQuery.mockImplementation((path: string) => {
    if (path.startsWith("/api/ui/apps/")) {
      return Promise.resolve({ ...appProps, chrome: CHROME });
    }
    if (path.endsWith("/git/status")) {
      if (live.gitError !== undefined) {
        return Promise.reject(live.gitError);
      }
      return Promise.resolve({
        status: live.git === undefined ? statusForSummary(appProps.git.summary) : live.git,
      });
    }
    if (path.includes("/image")) {
      return Promise.resolve(
        live.image ?? {
          status: appProps.image.configured ? appProps.image.status : "ready",
          state: appProps.image.configured ? "current" : "current",
          imageRef: appProps.image.ref,
          hash: appProps.image.hash,
          baseKind: appProps.image.base.kind,
          baseRef: appProps.image.base.ref,
          baseDigest: appProps.image.base.digest,
          builtAt: appProps.image.builtAt,
          previousImageRef: appProps.image.rollback.ref,
          previousImageBuiltAt: appProps.image.rollback.builtAt,
          error: appProps.image.error,
          baseDrift: appProps.image.drift,
          hashDrift: appProps.image.drift,
          blocked: appProps.image.blocked,
          usableImageRef: appProps.image.usable ? appProps.image.ref : null,
        },
      );
    }
    if (path.includes("/runtime")) {
      return Promise.resolve(live.runtime ?? { state: appProps.runtime.state });
    }
    return Promise.resolve({});
  });
}

async function mountPage(payload: BootPayload): Promise<VueWrapper> {
  const router = testRouter();
  const id = payload.route.params.id ?? "p";
  const app = payload.route.params.app ?? "alpha";
  await router.push(`/projects/${id}/apps/${app}`);
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const wrapper = mount(AppPage, {
    props: { boot: payload },
    global: {
      plugins: [pinia, router, [VueQueryPlugin, { queryClient }]],
    },
  });
  await flushPromises();
  return wrapper;
}

function toasts() {
  return useToastStore().toasts;
}

describe("AppPage", () => {
  beforeEach(() => {
    mocks.apiQuery.mockReset();
    mocks.apiMutation.mockReset();
  });

  it("renders the header, runtime strip, settings state, links, and restart control", async () => {
    const appProps = props({
      settings: {
        ...props().settings,
        state: "restart_required",
        pending: true,
        label: "Restart required",
        glyph: "stamp",
        tone: "awaiting_approval",
        copy: "The agent is running with older settings.",
        actionLabel: null,
      },
    });
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("h1").text()).toBe("alpha");
    expect(wrapper.text()).toContain("Project One");
    expect(wrapper.get("#runtime-state").text()).toContain("Running");
    expect(wrapper.get("#settings-state").text()).toContain("Restart required");
    expect(wrapper.find("#app-restart").exists()).toBe(true);

    const links = wrapper.findAll("a").map((link) => link.attributes("href"));
    expect(links).toContain("/chat?app=alpha&project=p");
    expect(links).toContain("/terminal?app=alpha&project=p");
    expect(links).toContain("/projects/p/apps/alpha/settings");
    expect(links).toContain("/projects/p/apps/alpha/skills");
    expect(links).toContain("/ide/?folder=alpha");

    expect(wrapper.find("style").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("git.js");
    expect(wrapper.html()).not.toContain("images.js");
  });

  it.each([
    ["starting", "Starting"],
    ["running", "Running"],
    ["stopped", "Stopped"],
    ["error", "Error"],
  ] as const)("renders runtime state %s", async (state, label) => {
    const appProps = props({
      runtime: {
        ...props().runtime,
        state,
        canRestart: state === "running" || state === "starting",
      },
    });
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("#runtime-state").text()).toContain(label);
    expect(wrapper.find("#app-restart").exists()).toBe(state === "running" || state === "starting");
  });

  it.each([
    ["unavailable", "Unavailable"],
    ["saved", "Saved"],
    ["applied", "Applied"],
  ] as const)("renders settings state %s", async (state, label) => {
    const appProps = props({
      settings: { ...props().settings, state, label },
    });
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("#settings-state").text()).toContain(label);
  });

  it("renders the default image rail without actions", async () => {
    const appProps = props();
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("#image-panel").attributes("data-status")).toBe("default");
    expect(wrapper.get("#image-ref").text()).toBe("Default agent image");
    expect(wrapper.text()).toContain("current default image");
    expect(wrapper.find("#image-build").exists()).toBe(false);
    expect(wrapper.find("#image-rollback").exists()).toBe(false);
    expect(wrapper.find("#image-check").exists()).toBe(false);
  });

  it.each([
    ["missing", "Not built"],
    ["building", "Building"],
    ["ready", "Built"],
    ["stale", "Out of date"],
    ["error", "Build failed"],
  ] as const)("renders configured image state %s", async (status, label) => {
    const appProps = props({ image: imageProps(status) });
    installQueries(appProps, {
      image: {
        status,
        state: status,
        imageRef: "hanse-alpha:latest",
        hash: "sha256:abcdef",
        baseKind: "default",
        baseRef: "hanse-agent-default:latest",
        baseDigest: status === "stale" ? "sha256:new-base" : "sha256:base",
        currentBaseDigest: status === "stale" ? "sha256:new-base" : "sha256:base",
        builtAt: "2026-10-20T10:00:00.000Z",
        previousImageRef: "hanse-alpha:previous",
        previousImageBuiltAt: "2026-10-19T10:00:00.000Z",
        error: status === "error" ? "docker build failed" : null,
        baseDrift: status === "stale",
        hashDrift: status === "stale",
        blocked: false,
        usableImageRef: status === "missing" ? null : "hanse-alpha:latest",
      },
    });
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("#image-panel").attributes("data-status")).toBe(status);
    expect(wrapper.get("#image-panel").text()).toContain(label);
    expect(wrapper.get("#image-ref").text()).toBe("hanse-alpha:latest");
    expect(wrapper.find("#image-details").exists()).toBe(true);
    expect(wrapper.find("#image-build").exists()).toBe(false);
    expect(wrapper.find("#image-rollback").exists()).toBe(false);
    if (status === "stale") {
      expect(wrapper.text()).toContain("Drift");
    }
    if (status === "error") {
      expect(wrapper.text()).toContain("docker build failed");
    }
  });

  it("renders image metadata when blocked and unusable", async () => {
    const appProps = props({
      image: imageProps("ready", {
        blocked: true,
        usable: false,
        buildDisabled: true,
        rollbackDisabled: true,
        rollback: { ...imageProps("ready").rollback, available: false, ref: null },
      }),
    });
    installQueries(appProps, {
      image: {
        status: "ready",
        state: "current",
        imageRef: "hanse-alpha:latest",
        hash: "sha256:abcdef",
        baseKind: "default",
        baseRef: "hanse-agent-default:latest",
        baseDigest: "sha256:base",
        builtAt: "2026-10-20T10:00:00.000Z",
        previousImageRef: null,
        error: null,
        blocked: true,
        baseDrift: false,
        hashDrift: false,
      },
    });
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.text()).toContain("Blocked");
    expect(wrapper.text()).toContain("No usable image");
    expect(wrapper.text()).toContain("No rollback");
    expect(wrapper.text()).toContain("Build disabled");
  });

  it("renders a clean repository, changes, upstream, and last commit", async () => {
    const appProps = props({
      git: {
        ...props().git,
        summary: {
          ...GIT,
          upstream: { name: "origin/main", ahead: 2, behind: 1 },
          ahead: 2,
          behind: 1,
        },
      },
    });
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("#repository-title").text()).toBe("Repository");
    expect(wrapper.get("#git-branch").text()).toContain("main");
    expect(wrapper.get("#git-upstream").text()).toContain("origin/main");
    expect(wrapper.get("#git-upstream").text()).toContain("2 ahead");
    expect(wrapper.get("#git-upstream").text()).toContain("1 behind");
    expect(wrapper.get("#git-head").text()).toBe("abcdef123456");
    expect(wrapper.get("#repository-card").text()).toContain("Clean");
    expect(wrapper.get("#changes-card").text()).toContain("Working tree clean");
    expect(wrapper.get("#last-commit-card").text()).toContain("fixture commit");
    expect(wrapper.get("#git-refreshed").text()).toContain("Refreshed");
  });

  it("renders dirty and conflicted git state matrices", async () => {
    const dirtyProps = props({
      git: {
        ...props().git,
        summary: {
          ...GIT,
          clean: false,
          dirty: true,
          counts: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
        },
      },
    });
    installQueries(dirtyProps);
    const dirty = await mountPage(boot(dirtyProps));
    expect(dirty.get("#repository-card").text()).toContain("Changes");
    expect(dirty.get("#changes-card").text()).toContain("Staged 1");
    expect(dirty.get("#changes-card").text()).toContain("Unstaged 2");
    expect(dirty.get("#changes-card").text()).toContain("Untracked 3");
    expect(dirty.get("#git-commit").attributes("disabled")).toBeUndefined();
    expect(dirty.get("#git-fetch").attributes("disabled")).toBeDefined();
    expect(dirty.get("#git-push").attributes("disabled")).toBeDefined();

    const conflictedProps = props({
      git: {
        ...props().git,
        summary: {
          ...GIT,
          clean: false,
          dirty: true,
          conflicted: true,
          counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 1 },
        },
      },
    });
    mocks.apiQuery.mockReset();
    installQueries(conflictedProps);
    const conflicted = await mountPage(boot(conflictedProps));
    expect(conflicted.get("#repository-card").text()).toContain("Conflicts");
    expect(conflicted.get("#changes-card").text()).toContain("Conflicted 1");
    expect(conflicted.get("#git-commit").attributes("disabled")).toBeDefined();
    expect(conflicted.get("#git-switch").attributes("disabled")).toBeDefined();
    expect(conflicted.get("#git-commit-hint").text()).toContain("Resolve conflicts");
  });

  it("renders detached git state and an unavailable summary", async () => {
    const detachedProps = props({
      git: {
        ...props().git,
        summary: {
          ...GIT,
          branch: { name: null, detached: true, head: "deadbeef" },
          detached: true,
          clean: false,
          dirty: true,
        },
      },
    });
    installQueries(detachedProps);
    const detached = await mountPage(boot(detachedProps));
    expect(detached.get("#git-branch").text()).toContain("Detached HEAD");
    expect(detached.get("#repository-card").text()).toContain("Detached");
    expect(detached.get("#git-update").attributes("disabled")).toBeDefined();
    expect(detached.get("#git-push").attributes("disabled")).toBeDefined();
    expect(detached.find("#git-commit").exists()).toBe(false);

    const unavailable = props({
      git: {
        ...props().git,
        summary: {
          ...GIT,
          loaded: false,
          state: "unavailable",
          message: "Repository status is unavailable.",
          branch: null,
          upstream: null,
          clean: false,
          lastCommit: null,
        },
      },
    });
    mocks.apiQuery.mockReset();
    installQueries(unavailable, {
      gitError: new ApiError("Repository status is unavailable.", 500),
    });
    const wrapper = await mountPage(boot(unavailable));
    expect(wrapper.get("#repository-card").text()).toContain("Repository status is unavailable.");
    expect(wrapper.get("#git-refreshed").text()).toBe("Status unavailable");
    expect(wrapper.get("#last-commit-card").text()).toContain("Commit history is unavailable");
  });

  it("renders SSH grants, approvals, and audit read panels", async () => {
    const appProps = props();
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("#ssh-panel-title").text()).toBe("SSH access");
    expect(wrapper.get("#ssh-panel").text()).toContain("1 allowed host");
    expect(wrapper.get("#ssh-panel").text()).toContain("1 pending approval");
    expect(wrapper.get("#ssh-grants").text()).toContain("test-host");
    expect(wrapper.get("#ssh-grants").text()).toContain("Active");
    expect(wrapper.get("#ssh-approvals").text()).toContain("echo e2e");
    expect(wrapper.get("#ssh-audit").text()).toContain("uptime");
    expect(wrapper.find("#ssh-manage").attributes("href")).toBe("/ssh?project=p&app=alpha");
    expect(wrapper.find("#ssh-panel").text()).not.toContain("Revoke");
    expect(wrapper.find("#ssh-panel").text()).not.toContain("Approve");
  });

  it("renders the SSH unavailable and empty states", async () => {
    const appProps = props({
      ssh: {
        ...SSH,
        available: false,
        hosts: 0,
        pendingApprovals: 0,
        grants: [],
        approvals: [],
        audit: [],
      },
    });
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.text()).toContain("0 allowed hosts");
    expect(wrapper.text()).toContain("SSH access is unavailable");
    expect(wrapper.find("#ssh-grants").exists()).toBe(false);
    expect(wrapper.find("#ssh-approvals").exists()).toBe(false);
    expect(wrapper.find("#ssh-audit").exists()).toBe(false);
  });

  it("fetches app props on mount even when boot props match, to load the git summary", async () => {
    const bootData = props({
      git: { ...props().git, summary: { ...GIT, loaded: false, state: "unavailable" } },
    });
    const fetched = props();
    installQueries(fetched);
    const wrapper = await mountPage(boot(bootData));

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/apps/alpha?project=p");
    expect(wrapper.get("#repository-card").text()).toContain("Clean");
    expect(wrapper.get("#last-commit-card").text()).toContain("fixture commit");
  });

  it("ignores boot props from another route and fetches the app endpoint", async () => {
    const appProps = props();
    installQueries(appProps);
    const wrapper = await mountPage(boot(props(), { routeId: "project", id: "p" }));

    expect(mocks.apiQuery).toHaveBeenCalledWith("/api/ui/apps/alpha?project=p");
    expect(wrapper.get("h1").text()).toBe("alpha");
    expect(wrapper.get("#repository-card").text()).toContain("Clean");
  });

  it("renders the master variant without git, image, or SSH panels", async () => {
    const masterProps = props({
      master: true,
      header: {
        overline: "Application",
        title: "master",
        description: "Built-in Hanse assistant.",
        meta: ["Hanse master", "master", "/workspace/master"],
        showChatTerminal: true,
      },
      identity: { ...props().identity, appKey: "master", master: true },
    });
    installQueries(masterProps);
    const wrapper = await mountPage(boot(masterProps));

    expect(wrapper.get("h1").text()).toBe("master");
    expect(wrapper.get("#master-panel").text()).toContain("Master workspace");
    expect(wrapper.find("#git-panel").exists()).toBe(false);
    expect(wrapper.find("#image-panel").exists()).toBe(false);
    expect(wrapper.find("#ssh-panel").exists()).toBe(false);
    expect(wrapper.get("#runtime-state").text()).toContain("Running");
    expect(wrapper.text()).toContain("Application settings");
  });

  it("restarts the agent, closes the dialog, refreshes props, and shows a success toast", async () => {
    const appProps = props();
    installQueries(appProps);
    mocks.apiMutation.mockResolvedValue({ restarted: true });
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#app-restart").trigger("click");
    expect(wrapper.get("#app-restart-dialog").attributes("open")).toBeDefined();
    await wrapper.get("#app-restart-dialog .btn-primary").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/apps/alpha/restart?project=p", {
      json: {},
    });
    expect(wrapper.get("#app-restart-dialog").attributes("open")).toBeUndefined();
    expect(toasts().map((toast) => toast.message)).toContain("Agent restarted.");
    expect(
      mocks.apiQuery.mock.calls.filter(([path]) => path.startsWith("/api/ui/apps/")),
    ).toHaveLength(2);
  });

  it("keeps the page intact and raises an error toast when the restart fails", async () => {
    const appProps = props();
    installQueries(appProps);
    mocks.apiMutation.mockRejectedValue(new ApiError("restart unavailable", 503));
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#app-restart").trigger("click");
    await wrapper.get("#app-restart-dialog .btn-primary").trigger("click");
    await flushPromises();

    expect(toasts().map((toast) => toast.message)).toContain("restart unavailable");
    expect(wrapper.get("h1").text()).toBe("alpha");
  });

  it("shows a 404 state with retry and the legacy link", async () => {
    mocks.apiQuery.mockRejectedValue(new ApiError("not found", 404, "not_found"));
    const wrapper = await mountPage(boot(null));

    expect(wrapper.text()).toContain("Application not found");
    expect(wrapper.text()).toContain("Use the classic interface");
    expect(wrapper.find("a[href='?legacy=1']").exists()).toBe(true);
    expect(wrapper.get("button").text()).toContain("Retry");
  });

  it("shows a loading state before the app fetch resolves", async () => {
    mocks.apiQuery.mockImplementation(() => new Promise(() => {}));
    const wrapper = await mountPage(boot(null));

    expect(wrapper.text()).toContain("Loading application");
  });

  it("retries after a generic load failure", async () => {
    const appProps = props();
    mocks.apiQuery
      .mockRejectedValueOnce(new Error("coordinator unavailable"))
      .mockImplementation((path: string) => {
        if (path.startsWith("/api/ui/apps/")) {
          return Promise.resolve({ ...appProps, chrome: CHROME });
        }
        if (path.includes("/image")) {
          return Promise.resolve({ status: "ready", state: "current" });
        }
        if (path.includes("/runtime")) {
          return Promise.resolve({ state: "running" });
        }
        return Promise.resolve({});
      });
    const wrapper = await mountPage(boot(null));

    expect(wrapper.text()).toContain("coordinator unavailable");
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.get("h1").text()).toBe("alpha");
  });

  it("shows the deletion banner but no delete action in 7A", async () => {
    const appProps = props({
      delete: {
        ...props().delete,
        deleting: true,
        pending: true,
        statusLabel: "Deletion incomplete",
        banner: {
          title: "Deletion incomplete",
          body: "This application is marked for deletion.",
        },
      },
      header: { ...props().header, showChatTerminal: false },
    });
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    expect(wrapper.get("#deletion-banner").text()).toContain("Deletion incomplete");
    expect(wrapper.find("#danger-zone").exists()).toBe(false);
    expect(wrapper.find("button.btn-danger").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Delete application");
    expect(wrapper.find("#app-restart").exists()).toBe(false);
  });

  it("commits every change group, clears the draft, and refreshes the page props", async () => {
    const dirtySummary: AppGitSummaryProps = {
      ...GIT,
      clean: false,
      dirty: true,
      counts: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
    };
    const appProps = props({ git: { ...props().git, summary: dirtySummary } });
    installQueries(appProps, { git: statusForSummary(dirtySummary) });
    mocks.apiMutation.mockResolvedValue({
      status: fullStatus(),
      message: "Committed as abc1234.",
    });
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#git-commit-message").setValue("  E2E commit  ");
    await wrapper.get("#git-commit-form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith("/api/projects/p/apps/alpha/git/commit", {
      json: { message: "E2E commit" },
    });
    expect(toasts().map((toast) => toast.message)).toContain("Committed as abc1234.");
    expect(wrapper.get("#repository-card").text()).toContain("Clean");
    expect(wrapper.find("#git-commit-message").exists()).toBe(false);
    expect(wrapper.get("#last-commit-card").text()).toContain("fixture commit");
  });

  it("runs fetch, update, and push through the existing git endpoints", async () => {
    const appProps = props();
    installQueries(appProps, {
      git: fullStatus({
        upstream: { name: "origin/main", ahead: 1, behind: 1 },
        remotes: [{ name: "origin", url: "file:///workspace/p/apps/alpha/.git/e2e-remote.git" }],
      }),
    });
    const connected = fullStatus({
      upstream: { name: "origin/main", ahead: 1, behind: 1 },
      remotes: [{ name: "origin", url: "file:///workspace/p/apps/alpha/.git/e2e-remote.git" }],
    });
    mocks.apiMutation
      .mockResolvedValueOnce({ status: connected, message: "Fetched all remotes." })
      .mockResolvedValueOnce({
        status: { ...connected, branch: { name: "main", detached: false, head: "1234567890ab" } },
        message: "Branch updated to 1234567.",
      })
      .mockResolvedValueOnce({ status: connected, message: "Pushed to origin/main." });
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#git-fetch").trigger("click");
    await flushPromises();
    await wrapper.get("#git-update").trigger("click");
    await flushPromises();
    await wrapper.get("#git-push").trigger("click");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenNthCalledWith(1, "/api/projects/p/apps/alpha/git/fetch", {
      json: {},
    });
    expect(mocks.apiMutation).toHaveBeenNthCalledWith(2, "/api/projects/p/apps/alpha/git/update", {
      json: {},
    });
    expect(mocks.apiMutation).toHaveBeenNthCalledWith(3, "/api/projects/p/apps/alpha/git/push", {
      json: {},
    });
    expect(toasts().map((toast) => toast.message)).toEqual(
      expect.arrayContaining([
        "Fetched all remotes.",
        "Branch updated to 1234567.",
        "Pushed to origin/main.",
      ]),
    );
  });

  it("switches branches and warns before switching to the current branch", async () => {
    const appProps = props();
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#git-branch-select").setValue("main");
    await wrapper.get("#git-switch-form").trigger("submit");
    await flushPromises();
    expect(mocks.apiMutation).not.toHaveBeenCalled();
    expect(wrapper.get("#git-notice").text()).toContain("You are already on main.");

    mocks.apiMutation.mockResolvedValue({
      status: fullStatus({
        branch: { name: "feature", detached: false, head: "abcdef1234567890" },
      }),
      message: "Switched to feature.",
    });
    await wrapper.get("#git-branch-select").setValue("feature");
    await wrapper.get("#git-switch-form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).toHaveBeenCalledWith(
      "/api/projects/p/apps/alpha/git/branches/switch",
      { json: { branch: "feature" } },
    );
    expect(toasts().map((toast) => toast.message)).toContain("Switched to feature.");
    expect(wrapper.get("#git-branch").text()).toContain("feature");
  });

  it("maps push errors to the legacy title and message", async () => {
    const appProps = props();
    installQueries(appProps, {
      git: fullStatus({
        upstream: { name: "origin/main", ahead: 1, behind: 0 },
        remotes: [{ name: "origin", url: "file:///workspace/p/apps/alpha/.git/e2e-remote.git" }],
      }),
    });
    mocks.apiMutation.mockRejectedValue(new ApiError("server said no", 409, "push_rejected"));
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#git-push").trigger("click");
    await flushPromises();

    expect(wrapper.get("#git-notice").text()).toContain("Push rejected");
    expect(wrapper.get("#git-notice").text()).toContain(
      "The remote has commits you do not have. Fetch and update the branch, then try again.",
    );
    expect(toasts().map((toast) => toast.message)).toContain(
      "The remote has commits you do not have. Fetch and update the branch, then try again.",
    );
  });

  it("validates the commit message without calling the server", async () => {
    const dirtySummary: AppGitSummaryProps = {
      ...GIT,
      clean: false,
      dirty: true,
      counts: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    };
    const appProps = props({ git: { ...props().git, summary: dirtySummary } });
    installQueries(appProps, { git: statusForSummary(dirtySummary) });
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#git-commit-form").trigger("submit");
    await flushPromises();

    expect(mocks.apiMutation).not.toHaveBeenCalled();
    expect(wrapper.get("#git-commit-error").text()).toContain("A message is required");
  });

  it("disables the workbench while an action is in flight", async () => {
    const dirtySummary: AppGitSummaryProps = {
      ...GIT,
      clean: false,
      dirty: true,
      counts: { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 },
    };
    const appProps = props({ git: { ...props().git, summary: dirtySummary } });
    installQueries(appProps, { git: statusForSummary(dirtySummary) });
    let finish: (value: unknown) => void = () => {};
    mocks.apiMutation.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const wrapper = await mountPage(boot(appProps));

    await wrapper.get("#git-commit-message").setValue("Busy commit");
    await wrapper.get("#git-commit-form").trigger("submit");
    await nextTick();

    expect(wrapper.get("#git-commit").text()).toContain("Committing");
    expect(wrapper.get("#git-commit").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#git-fetch").attributes("disabled")).toBeDefined();
    expect(wrapper.get("#git-refresh").attributes("disabled")).toBeDefined();

    finish({ status: fullStatus(), message: "Committed as abc1234." });
    await flushPromises();
    expect(toasts().map((toast) => toast.message)).toContain("Committed as abc1234.");
  });

  it("shows a status load error with retry and recovers on refresh", async () => {
    const appProps = props();
    installQueries(appProps);
    const wrapper = await mountPage(boot(appProps));

    mocks.apiQuery.mockRejectedValueOnce(new ApiError("coordinator unavailable", 503));
    await wrapper.get("#git-refresh").trigger("click");
    await flushPromises();
    expect(wrapper.get("#repository-card").text()).toContain("Repository status unavailable");
    expect(wrapper.get("#repository-card").text()).toContain("coordinator unavailable");

    const retry = wrapper
      .findAll("#repository-card button")
      .find((button) => button.text() === "Retry");
    expect(retry).toBeDefined();
    await retry?.trigger("click");
    await flushPromises();
    expect(wrapper.get("#repository-card").text()).toContain("Clean");
    expect(wrapper.get("#git-refreshed").text()).toContain("Refreshed");
  });
});
