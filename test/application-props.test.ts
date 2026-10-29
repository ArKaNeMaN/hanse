import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitStatus } from "../src/git/service.js";
import type { SiteModel } from "../src/http/dashboard.js";
import { appGitSummary, type BuildAppPropsInput, buildAppProps } from "../src/http/props/app.js";
import type { RegisteredApp } from "../src/registry/index.js";
import type { SshApprovalView, SshAuditEntry, SshGrant } from "../src/ssh/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-app-props-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
  return dir;
}

function makeApp(overrides: Partial<RegisteredApp> = {}): RegisteredApp {
  return {
    id: "p:web",
    projectId: "p",
    appKey: "web",
    path: "apps/web",
    kind: "app",
    contract: "AGENTS.md",
    deleting: false,
    imageStatus: "missing",
    imageRef: null,
    imageHash: null,
    imageBaseDigest: null,
    imageBuiltAt: null,
    imageError: null,
    imageBaseRef: null,
    imageBaseKind: null,
    imageHashVersion: 0,
    imageBuildId: null,
    imageBuildRef: null,
    imageBuildStartedAt: null,
    imageBuildRejectedRef: null,
    imageRollbackRef: null,
    imageRollbackBuiltAt: null,
    buildDockerfile: null,
    buildConfigured: false,
    buildArgs: {},
    buildSpecHash: null,
    ...overrides,
  };
}

function makeSite(
  app: RegisteredApp,
  options: {
    projectDeleting?: boolean;
    runtime?: SiteModel["runtime"];
    pendingRestart?: SiteModel["pendingRestart"];
    pendingRestartReasons?: SiteModel["pendingRestartReasons"];
    sshHosts?: number;
    sshPending?: number;
  } = {},
  rootPath = root(),
): SiteModel {
  const projectId = app.projectId;
  return {
    projects: [
      {
        id: projectId,
        name: "Alpha",
        rootPath,
        workspaceRoot: rootPath,
        baseBranch: "main",
        createdAt: "",
        deleting: options.projectDeleting === true,
        apps: [app],
        handoffs: [],
        handoffPolicies: [],
      },
    ],
    apps: new Map([
      [
        app.id,
        {
          id: app.id,
          appKey: app.appKey,
          path: app.path,
          kind: app.kind,
          projectId,
          projectName: "Alpha",
          projectRoot: "/workspace/p",
          deleting: app.deleting,
        },
      ],
    ]),
    runtime: options.runtime ?? new Map(),
    pendingRestart: options.pendingRestart ?? new Map(),
    pendingRestartReasons: options.pendingRestartReasons ?? new Map(),
    pendingCount: 0,
    sshPendingCount: options.sshPending ?? 0,
    sshPendingByApp:
      options.sshPending === undefined ? new Map() : new Map([[app.id, options.sshPending]]),
    sshHostsByApp:
      options.sshHosts === undefined ? new Map() : new Map([[app.id, options.sshHosts]]),
    startingCount: 0,
    runningCount: 0,
    errorCount: 0,
    stoppedCount: 1,
    appCount: 1,
    handoffCount: 0,
  };
}

function props(
  app: RegisteredApp,
  overrides: Partial<BuildAppPropsInput> = {},
  siteOptions: Parameters<typeof makeSite>[1] = {},
) {
  const dir = root();
  mkdirSync(path.join(dir, app.path), { recursive: true });
  const site = makeSite(app, siteOptions, dir);
  return buildAppProps({
    site,
    projectId: app.projectId,
    appKey: app.appKey,
    ...overrides,
  });
}

describe("buildAppProps", () => {
  it("returns undefined for an unknown project or application", () => {
    const app = makeApp();
    const site = makeSite(app);
    expect(buildAppProps({ site, projectId: "missing", appKey: "web" })).toBeUndefined();
    expect(buildAppProps({ site, projectId: "p", appKey: "missing" })).toBeUndefined();
  });

  it("assembles identity, links, default image, unavailable runtime, and delete contract", () => {
    const result = props(makeApp());
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.identity).toMatchObject({
      projectId: "p",
      projectName: "Alpha",
      appKey: "web",
      kind: "app",
      path: "apps/web",
      href: "/projects/p/apps/web",
      master: false,
    });
    expect(result.links).toEqual({
      chat: "/chat?app=web&project=p",
      terminal: "/terminal?app=web&project=p",
      settings: "/projects/p/apps/web/settings",
      skills: "/projects/p/apps/web/skills",
      ssh: "/ssh?project=p&app=web",
      ide: expect.stringContaining("folder="),
    });
    expect(result.header).toMatchObject({
      title: "web",
      showChatTerminal: true,
    });
    expect(result.runtime).toMatchObject({
      state: "stopped",
      label: "Stopped",
      tone: "queued",
      configured: false,
      canRestart: false,
    });
    expect(result.settings).toMatchObject({
      state: "unavailable",
      label: "Unavailable",
      copy: "The agent runtime is not configured.",
      actionLabel: "Review settings",
      href: "/projects/p/apps/web/settings",
    });
    expect(result.image).toMatchObject({
      configured: false,
      status: "default",
      state: "cancelled",
      label: "Default image",
      ref: null,
      drift: false,
      blocked: false,
      usable: false,
    });
    expect(result.restart).toMatchObject({
      available: false,
      action: "/api/apps/web/restart?project=p",
      returnTo: "/projects/p/apps/web",
    });
    expect(result.delete).toMatchObject({
      deleting: false,
      projectDeleting: false,
      pending: false,
      action: "/api/projects/p/apps/web/delete",
      returnTo: "/projects/p/apps/web",
      confirmName: "web",
      dialog: "application",
      retrying: false,
      statusLabel: null,
      banner: null,
    });
    expect(result.profileWarnings).toEqual([]);
  });

  it("derives the settings state matrix from runtime, configuration, and pending reasons", () => {
    const unavailable = props(makeApp());
    expect(unavailable?.settings).toMatchObject({
      state: "unavailable",
      tone: "cancelled",
      glyph: "slash",
    });

    const saved = props(
      makeApp(),
      { runtimeConfigured: true },
      {
        runtime: new Map([["p:web", "stopped"]]),
      },
    );
    expect(saved?.settings).toMatchObject({
      state: "saved",
      label: "Saved",
      copy: "Settings apply when the agent starts.",
    });

    const applied = props(
      makeApp(),
      { runtimeConfigured: true },
      {
        runtime: new Map([["p:web", "running"]]),
      },
    );
    expect(applied?.settings).toMatchObject({
      state: "applied",
      label: "Applied",
      copy: "Settings match the running agent.",
    });

    const restart = props(
      makeApp(),
      { runtimeConfigured: true },
      {
        runtime: new Map([["p:web", "running"]]),
        pendingRestart: new Map([["p:web", true]]),
        pendingRestartReasons: new Map([["p:web", ["settings_changed"]]]),
      },
    );
    expect(restart?.runtime).toMatchObject({
      pendingRestart: true,
      pendingRestartReasons: ["settings_changed"],
      canRestart: true,
    });
    expect(restart?.settings).toMatchObject({
      state: "restart_required",
      label: "Restart required",
      copy: "The agent is running with older settings.",
      actionLabel: null,
    });
    expect(restart?.restart).toMatchObject({
      available: true,
      action: "/api/apps/web/restart?project=p",
      returnTo: "/projects/p/apps/web",
      dialogTitle: "Restart web?",
    });

    const unknown = props(
      makeApp(),
      { runtimeConfigured: true },
      {
        runtime: new Map([["p:web", "starting"]]),
        pendingRestart: new Map([["p:web", true]]),
        pendingRestartReasons: new Map([["p:web", ["applied_state_unknown"]]]),
      },
    );
    expect(unknown?.settings).toMatchObject({
      appliedStateUnknown: true,
      copy: "The coordinator cannot confirm which settings this running agent loaded.",
    });
  });

  it("maps every image read state without secrets", () => {
    const missing = props(makeApp({ buildConfigured: true }));
    expect(missing?.image).toMatchObject({
      configured: true,
      status: "missing",
      state: "queued",
      label: "Not built",
      action: "Build image",
      buildDisabled: false,
      rollback: { available: false },
    });

    const building = props(makeApp({ buildConfigured: true, imageStatus: "building" }));
    expect(building?.image).toMatchObject({
      status: "building",
      state: "in_progress",
      building: true,
      buildDisabled: true,
      rollbackDisabled: true,
    });

    const ready = props(
      makeApp({
        buildConfigured: true,
        imageStatus: "ready",
        imageRef: "sha256:new",
        imageBuiltAt: "2026-10-20T10:00:00.000Z",
        imageBaseKind: "base",
        imageBaseRef: "ghcr.io/example/agent-base:latest",
        imageBaseDigest: "sha256:abc123",
        imageRollbackRef: "sha256:old",
        imageRollbackBuiltAt: "2026-10-19T10:00:00.000Z",
      }),
      {},
      { runtime: new Map([["p:web", "running"]]) },
    );
    expect(ready?.image).toMatchObject({
      status: "ready",
      state: "delivered",
      label: "Built",
      ref: "sha256:new",
      drift: false,
      blocked: false,
      usable: true,
      base: {
        kindLabel: "Base",
        ref: "ghcr.io/example/agent-base:latest",
        digest: "sha256:abc123",
      },
      rollback: {
        available: true,
        ref: "sha256:old",
        builtAt: "2026-10-19T10:00:00.000Z",
        action: "Roll back and restart",
        restart: true,
      },
    });

    const errored = props(
      makeApp({
        buildConfigured: true,
        imageStatus: "error",
        imageError: "build.dockerfile escapes the application directory",
      }),
    );
    expect(errored?.image).toMatchObject({
      status: "error",
      state: "failed",
      label: "Build failed",
      action: "Retry build",
      error: "build.dockerfile escapes the application directory",
    });

    const stale = props(makeApp({ buildConfigured: true, imageStatus: "stale" }));
    expect(stale?.image).toMatchObject({
      status: "stale",
      state: "expired",
      label: "Out of date",
      drift: true,
    });
  });

  it("disables image actions while deletion is pending", () => {
    const result = props(
      makeApp({ buildConfigured: true, imageStatus: "ready" }),
      {},
      {
        projectDeleting: true,
      },
    );
    expect(result?.image.buildDisabled).toBe(true);
    expect(result?.image.rollbackDisabled).toBe(true);
    expect(result?.delete).toMatchObject({
      pending: true,
      projectDeleting: true,
      dialog: "project",
      title: "Retry project deletion?",
      confirmName: "Alpha",
      action: "/api/projects/p/delete",
      statusLabel: "Project deletion incomplete",
    });
    expect(result?.header.showChatTerminal).toBe(false);
    expect(result?.restart.available).toBe(false);
  });
});

describe("appGitSummary", () => {
  it("returns an unavailable summary before status is loaded", () => {
    expect(appGitSummary(null, "repository unavailable")).toMatchObject({
      loaded: false,
      state: "unavailable",
      message: "repository unavailable",
      branch: null,
      dirty: false,
      detached: false,
      conflicted: false,
      ahead: 0,
      behind: 0,
      lastCommit: null,
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
  });

  it("maps branch, head, upstream, dirty, conflicted, detached, and last commit", () => {
    const status: GitStatus = {
      state: "ok",
      branch: { name: "main", detached: false, head: "abcdef123456" },
      upstream: { name: "origin/main", ahead: 2, behind: 1 },
      clean: false,
      files: [
        { path: "a.ts", code: "M", group: "unstaged" },
        { path: "b.ts", code: "M", group: "staged" },
        { path: "c.ts", code: "??", group: "untracked" },
        { path: "d.ts", code: "UU", group: "conflicted" },
      ],
      conflicted: true,
      lastCommit: {
        hash: "abcdef123456",
        shortHash: "abcdef1",
        subject: "feat: add app panel",
        author: "Operator",
        committedAt: "2026-10-20T10:00:00.000Z",
      },
    };
    expect(appGitSummary(status)).toMatchObject({
      loaded: true,
      state: "ok",
      branch: { name: "main", detached: false, head: "abcdef123456" },
      upstream: { name: "origin/main", ahead: 2, behind: 1 },
      ahead: 2,
      behind: 1,
      dirty: true,
      clean: false,
      conflicted: true,
      detached: false,
      counts: { staged: 1, unstaged: 1, untracked: 1, conflicted: 1 },
      lastCommit: {
        shortHash: "abcdef1",
        subject: "feat: add app panel",
        author: "Operator",
      },
    });

    expect(
      appGitSummary({
        state: "ok",
        branch: { name: null, detached: true, head: "abcdef" },
        clean: true,
      }),
    ).toMatchObject({ detached: true, dirty: false, clean: true, upstream: null });
  });
});

describe("app SSH read summary", () => {
  const now = new Date("2026-10-20T10:00:00.000Z");
  const future = "2026-10-20T12:00:00.000Z";
  const past = "2026-10-19T10:00:00.000Z";

  function sshSource() {
    const grant: SshGrant = {
      id: "g1",
      appId: "p:web",
      hostId: "h1",
      approvalId: "a1",
      grantedBy: "operator",
      grantedAt: past,
      lastUsedAt: past,
      idleExpiresAt: future,
      absoluteExpiresAt: "2026-10-27T10:00:00.000Z",
      revokedAt: null,
    };
    const approval: SshApprovalView = {
      id: "a1",
      appId: "p:web",
      hostId: "h1",
      hostName: "deploy",
      address: "10.0.0.5",
      username: "ops",
      appKey: "web",
      projectId: "p",
      action: "exec",
      commandHash: "hash",
      commandPreview: "uptime",
      commandBytes: 6,
      status: "pending",
      requestedAt: past,
      expiresAt: future,
      decidedAt: null,
      decidedBy: null,
      grantId: null,
    };
    const audit: SshAuditEntry = {
      id: 1,
      appId: "p:web",
      projectId: "p",
      appKey: "web",
      hostId: "h1",
      hostName: "deploy",
      address: "10.0.0.5",
      username: "ops",
      action: "exec",
      commandHash: "hash",
      commandPreview: "uptime",
      presentedFingerprint: null,
      detail: null,
      approvalId: "a1",
      grantId: "g1",
      startedAt: past,
      finishedAt: future,
      exitCode: 0,
      errorCode: null,
      bytesOut: 12,
      truncated: false,
    };
    return {
      listAllHosts: () => [{ host: { id: "h1", name: "deploy", hostKey: "SECRET-HOST-KEY" } }],
      listGrants: () => [grant],
      listPending: () => [approval],
      listAudit: () => [audit],
    };
  }

  it("exposes grant/approval/audit metadata without key material", () => {
    const result = props(makeApp(), { ssh: sshSource(), now }, { sshHosts: 1, sshPending: 1 });
    expect(result?.ssh).toMatchObject({
      available: true,
      hosts: 1,
      pendingApprovals: 1,
      grants: [
        {
          id: "g1",
          hostName: "deploy",
          state: "active",
          revokedAt: null,
        },
      ],
      approvals: [{ id: "a1", hostName: "deploy", action: "exec", commandPreview: "uptime" }],
      audit: [{ id: 1, hostName: "deploy", outcome: "ok", exitCode: 0 }],
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("SECRET-HOST-KEY");
    expect(encoded).not.toContain("PRIVATE KEY");
  });

  it("falls back to site counts when the SSH service is absent", () => {
    const result = props(makeApp(), {}, { sshHosts: 3, sshPending: 2 });
    expect(result?.ssh).toMatchObject({
      available: false,
      hosts: 3,
      pendingApprovals: 2,
      grants: [],
      approvals: [],
      audit: [],
    });
  });
});

describe("master and profile warnings", () => {
  it("marks the master app and carries profile warnings", () => {
    const result = props(
      makeApp({ id: "hanse-master:master", projectId: "hanse-master", appKey: "master" }),
      { profileWarnings: ["profile_not_applied"] },
    );
    expect(result?.master).toBe(true);
    expect(result?.identity.master).toBe(true);
    expect(result?.profileWarnings).toEqual(["profile_not_applied"]);
    expect(result?.header.description).toContain("Built-in Hanse assistant");
  });
});
