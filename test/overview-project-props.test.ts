import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHandoff, transitionHandoff, updateHandoff } from "../src/coordinator/handoff.js";
import { setHandoffPolicy } from "../src/coordinator/policy.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { buildSite, renderOverview, renderProject, type SiteModel } from "../src/http/dashboard.js";
import { buildOverviewProps } from "../src/http/props/overview.js";
import { buildProjectProps } from "../src/http/props/project.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const databases: SqliteDatabase[] = [];
const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

function fixture(): SiteModel {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-02T12:00:00.000Z"));
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const created = "2026-01-01T00:00:00.000Z";
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Demo','main','/workspace/demo',?,?)",
  ).run(created, created);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('hanse-master','Hanse master','main','/workspace/.hanse-master',?,?)",
  ).run(created, created);
  for (const [key, kind] of [
    ["a", "app"],
    ["b", "app"],
    ["master", "app"],
  ] as const) {
    const projectId = key === "master" ? "hanse-master" : "p";
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES (?, ?, ?, ?, ?, 'AGENTS.md', ?)",
    ).run(`${projectId}:${key}`, projectId, key, `apps/${key}`, kind, created);
  }
  db.prepare(
    "INSERT INTO instances (id, app_id, state, runtime_state, updated_at) VALUES ('p:a', 'p:a', 'running', 'running', ?)",
  ).run(created);
  db.prepare(
    "INSERT INTO instances (id, app_id, state, runtime_state, updated_at) VALUES ('p:b', 'p:b', 'stopped', 'stopped', ?)",
  ).run(created);

  createHandoff(db, {
    id: "h-done",
    projectId: "p",
    fromAppId: "p:a",
    toAppId: "p:b",
    summary: "Ship the change",
    spec: "Deliver it.",
    idempotencyKey: "k-done",
  });
  transitionHandoff(db, "h-done", "dispatching");
  transitionHandoff(db, "h-done", "in_progress");
  transitionHandoff(db, "h-done", "delivered", {
    result: "Done.",
    outcome: "completed",
  });
  updateHandoff(db, "h-done", { replyState: "awaiting_approval" });

  createHandoff(db, {
    id: "h-wait",
    projectId: "p",
    fromAppId: "p:a",
    toAppId: "p:b",
    summary: "Wait for review",
    spec: "Review it.",
    idempotencyKey: "k-wait",
    requiresApproval: true,
  });

  setHandoffPolicy(db, {
    projectId: "p",
    fromAppKey: "a",
    toAppKey: "b",
    dispatchMode: "approve",
    replyMode: "approve",
  });

  const projects = [
    {
      id: "p",
      name: "Demo",
      rootPath: "/workspace/demo",
      workspaceRoot: "/workspace",
      service: new CoordinatorService(db, "p"),
    },
    {
      id: "hanse-master",
      name: "Hanse master",
      rootPath: "/workspace/.hanse-master",
      workspaceRoot: "/workspace",
      service: new CoordinatorService(db, "hanse-master"),
    },
  ];
  return buildSite({ db, getProjects: () => projects });
}

describe("overview page props", () => {
  it("assembles fleet counts, project rows, and handoff rows", () => {
    const site = fixture();
    const props = buildOverviewProps(site);
    expect(props.counts).toEqual({
      projects: 1,
      applications: 2,
      running: 1,
      starting: 0,
      stopped: 1,
      error: 0,
      handoffsWaiting: 2,
      handoffsTotal: 2,
    });
    expect(props.projects).toEqual([
      {
        id: "p",
        name: "Demo",
        rootPath: "/workspace/demo",
        appCount: 2,
        waitingCount: 2,
        lastActivity: "2026-01-02T12:00:00.000Z",
        deleting: false,
      },
    ]);
    expect(props.recentHandoffs.map((row) => row.id)).toEqual(["h-done", "h-wait"]);
    expect(props.recentHandoffs[1]).toMatchObject({
      fromAppKey: "a",
      toAppKey: "b",
      state: "awaiting_approval",
      reviewHref: "/handoffs?q=h-wait",
    });
    expect(props.waitingHandoffs.map((row) => row.displayState)).toEqual([
      "awaiting_approval",
      "awaiting_approval",
    ]);
    expect(props.waitingHandoffs[0]?.reviewHref).toBe("/handoffs?filter=waiting");
  });

  it("keeps the legacy overview HTML deriving from the same props", () => {
    const site = fixture();
    expect(renderOverview(site, { operatorName: "operator" })).toMatchSnapshot();
  });
});

describe("project page props", () => {
  it("assembles project summary, apps, handoffs, policy, deletion, and dialogs", () => {
    const site = fixture();
    const props = buildProjectProps(site, "p");
    expect(props).toBeDefined();
    expect(props?.project).toEqual({
      id: "p",
      name: "Demo",
      rootPath: "/workspace/demo",
      baseBranch: "main",
      deleting: false,
    });
    expect(props?.counts).toEqual({
      applications: 2,
      running: 1,
      waiting: 2,
      handoffs: 2,
    });
    expect(props?.apps[0]).toMatchObject({
      id: "p:a",
      appKey: "a",
      kind: "app",
      runtime: "running",
      pendingRestart: false,
      deleting: false,
      href: "/projects/p/apps/a",
      chatHref: "/chat?app=a&project=p",
      settingsHref: "/projects/p/apps/a/settings",
      skillsHref: "/projects/p/apps/a/skills",
    });
    expect(props?.handoffs[0]).toMatchObject({
      id: "h-done",
      approvalKind: "reply",
      displayState: "awaiting_approval",
      canCancel: false,
      canRelaunch: false,
      returnTo: "/projects/p",
    });
    expect(props?.policy).toMatchObject({
      appOptions: ["a", "b"],
      wildcard: "*",
      dispatchModes: ["auto", "approve", "deny"],
      replyModes: ["auto", "approve"],
    });
    expect(props?.policy.rules[0]).toMatchObject({
      fromAppKey: "a",
      toAppKey: "b",
      dispatchMode: "approve",
      replyMode: "approve",
    });
    expect(props?.deletion).toEqual({
      deleting: false,
      projectName: "Demo",
      appCount: 2,
      action: "/api/projects/p/delete",
      returnTo: "/projects/p",
      confirmName: "Demo",
    });
    expect(props?.dialogs.addApp).toMatchObject({
      action: "/api/projects/p/apps",
      returnTo: "/projects/p",
    });
    expect(props?.dialogs.newHandoff).toMatchObject({
      action: "/api/handoffs",
      fromKey: "a",
      toKey: "b",
      disabled: false,
    });
    expect(props?.master).toBe(false);
    expect(props?.masterSummary).toBeNull();
  });

  it("keeps the legacy project HTML deriving from the same props", () => {
    const site = fixture();
    expect(renderProject(site, "p", { operatorName: "operator" })).toMatchSnapshot();
  });

  it("returns the master variant without mutating actions", () => {
    const site = fixture();
    const props = buildProjectProps(site, "hanse-master");
    expect(props?.master).toBe(true);
    expect(props?.masterSummary).toEqual({
      runtime: "stopped",
      kind: "app",
      path: "apps/master",
      chatHref: "/chat?app=master&project=hanse-master",
      settingsHref: "/projects/hanse-master/apps/master/settings",
      skillsHref: "/projects/hanse-master/apps/master/skills",
    });
    expect(renderProject(site, "hanse-master", { operatorName: "operator" })).toMatchSnapshot();
  });

  it("returns undefined for an unknown project", () => {
    const site = fixture();
    expect(buildProjectProps(site, "missing")).toBeUndefined();
    expect(renderProject(site, "missing", { operatorName: "operator" })).toBeUndefined();
  });
});
