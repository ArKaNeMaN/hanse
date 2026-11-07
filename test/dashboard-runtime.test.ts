import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { buildSite, type DashboardDeps, renderOverview } from "../src/http/dashboard.js";
import { buildOverviewProps } from "../src/http/props/overview.js";
import { type RuntimeState, runtimePill } from "../src/http/ui.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

const now = "2026-10-21T00:00:00.000Z";

function fixture(): DashboardDeps {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp/p',?,?)",
  ).run(now, now);
  const states: Array<[string, string]> = [
    ["starting", "starting"],
    ["running", "running"],
    ["stopped", "stopped"],
    ["error", "error"],
    ["legacy", "failed"],
    ["unknown", "bogus"],
  ];
  for (const [appKey, state] of states) {
    const id = `p:${appKey}`;
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, 'p', ?, ?, 'AGENTS.md', ?)",
    ).run(id, appKey, `apps/${appKey}`, now);
    db.prepare(
      "INSERT INTO instances (id, app_id, state, runtime_state, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, id, state, state, now);
  }
  return {
    db,
    getProjects: () => [
      {
        id: "p",
        name: "P",
        rootPath: "/tmp/p",
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, "p"),
      },
    ],
  };
}

function processFixture(): DashboardDeps {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main','/tmp/p',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('hanse-master','Hanse master','main','/tmp/.hanse-master',?,?)",
  ).run(now, now);
  const apps: Array<{
    projectId: string;
    appKey: string;
    state: string;
    phase: string | null;
    updatedAt: string;
  }> = [
    {
      projectId: "p",
      appKey: "a",
      state: "starting",
      phase: "requested",
      updatedAt: "2026-11-07T00:00:05.000Z",
    },
    {
      projectId: "p",
      appKey: "b",
      state: "starting",
      phase: "stopping",
      updatedAt: "2026-11-07T00:00:06.000Z",
    },
    {
      projectId: "p",
      appKey: "c",
      state: "error",
      phase: "failed",
      updatedAt: "2026-11-07T00:00:07.000Z",
    },
    {
      projectId: "p",
      appKey: "d",
      state: "running",
      phase: "ready",
      updatedAt: "2026-11-07T00:00:08.000Z",
    },
    {
      projectId: "p",
      appKey: "e",
      state: "starting",
      phase: "waiting_ready",
      updatedAt: "2026-11-07T00:00:04.000Z",
    },
    {
      projectId: "p",
      appKey: "f",
      state: "starting",
      phase: "preparing",
      updatedAt: "2026-11-07T00:00:03.000Z",
    },
    {
      projectId: "p",
      appKey: "g",
      state: "error",
      phase: "failed",
      updatedAt: "2026-11-07T00:00:02.000Z",
    },
    {
      projectId: "hanse-master",
      appKey: "master",
      state: "error",
      phase: "failed",
      updatedAt: "2026-11-07T00:00:09.000Z",
    },
  ];
  for (const app of apps) {
    const id = `${app.projectId}:${app.appKey}`;
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?, ?, ?, ?, 'AGENTS.md', ?)",
    ).run(id, app.projectId, app.appKey, `apps/${app.appKey}`, now);
    db.prepare(
      `INSERT INTO instances
         (id, app_id, state, runtime_state, updated_at, process_attempt_id, process_phase,
          process_started_at, process_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      id,
      app.state,
      app.state,
      app.updatedAt,
      app.state === "running" ? null : "attempt",
      app.phase,
      app.state === "running" ? null : "2026-11-07T00:00:00.000Z",
      app.updatedAt,
    );
  }
  return {
    db,
    getProjects: () => [
      {
        id: "p",
        name: "P",
        rootPath: "/tmp/p",
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, "p"),
      },
      {
        id: "hanse-master",
        name: "Hanse master",
        rootPath: "/tmp/.hanse-master",
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, "hanse-master"),
      },
    ],
  };
}

describe("runtime vocabulary and counts", () => {
  it("maps the four states, normalizes legacy failed, and counts each state", () => {
    const site = buildSite(fixture());

    expect(site.runtime.get("p:starting")).toBe("starting");
    expect(site.runtime.get("p:running")).toBe("running");
    expect(site.runtime.get("p:stopped")).toBe("stopped");
    expect(site.runtime.get("p:error")).toBe("error");
    expect(site.runtime.get("p:legacy")).toBe("error");
    expect(site.runtime.get("p:unknown")).toBe("stopped");

    expect(site.startingCount).toBe(1);
    expect(site.runningCount).toBe(1);
    expect(site.stoppedCount).toBe(2);
    expect(site.errorCount).toBe(2);
  });

  it("renders one runtime row per state", () => {
    const page = renderOverview(buildSite(fixture()), { operatorName: "op" });

    expect(page).toContain('<span class="status" data-state="dispatching">');
    expect(page).toContain("Starting</span>");
    expect(page).toContain('<span class="status" data-state="in_progress">');
    expect(page).toContain("Running</span>");
    expect(page).toContain('<span class="status" data-state="queued">');
    expect(page).toContain("Stopped</span>");
    expect(page).toContain('<span class="status" data-state="failed">');
    expect(page).toContain("Error</span>");
    expect(page).not.toContain("Failed</span>");
  });

  it("maps every runtime state to its label, pill state, and glyph", () => {
    const expected: Array<[RuntimeState, string, string]> = [
      ["starting", "dispatching", "Starting"],
      ["running", "in_progress", "Running"],
      ["stopped", "queued", "Stopped"],
      ["error", "failed", "Error"],
    ];
    for (const [state, pillState, label] of expected) {
      const pill = runtimePill(state);
      expect(pill).toContain(`data-state="${pillState}"`);
      expect(pill).toContain(`${label}</span>`);
    }
  });
});

describe("process detail and overview summary", () => {
  it("carries the process snapshot per app", () => {
    const site = buildSite(processFixture());

    expect(site.process.get("p:a")).toMatchObject({
      state: "starting",
      phase: "requested",
      attemptId: "attempt",
      startedAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:05.000Z",
      error: null,
      lastEventId: 0,
    });
    expect(site.process.get("p:d")).toMatchObject({ state: "running", phase: "ready" });
  });

  it("counts starting and stopping by phase, keeps coarse counts, and lists five affected apps", () => {
    const site = buildSite(processFixture());
    const props = buildOverviewProps(site);

    expect(props.counts).toMatchObject({ starting: 4, running: 1, error: 2, stopped: 0 });
    expect(props.processes).toMatchObject({ starting: 3, stopping: 1, error: 2 });
    expect(props.processes.apps.map((row) => row.appId)).toEqual([
      "p:c",
      "p:b",
      "p:a",
      "p:e",
      "p:f",
    ]);
    expect(props.processes.apps.map((row) => row.appId)).not.toContain("hanse-master:master");
    expect(props.processes.apps[1]).toEqual({
      appId: "p:b",
      appKey: "b",
      projectId: "p",
      projectName: "P",
      state: "starting",
      phase: "stopping",
      updatedAt: "2026-11-07T00:00:06.000Z",
      chatHref: "/chat?app=b&project=p",
      appHref: "/projects/p/apps/b",
    });
  });
});
