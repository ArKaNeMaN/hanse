import {
  type HandoffGrant,
  listHandoffGrants,
  listInboundHandoffGrants,
} from "../coordinator/grants.js";
import { type Handoff, listHandoffs } from "../coordinator/handoff.js";
import { type HandoffPolicy, listHandoffPolicies } from "../coordinator/policy.js";
import type { CoordinatorService } from "../coordinator/service.js";
import { isMasterProject } from "../master/constants.js";
import type { InstanceManager } from "../opencode/manager.js";
import type { RegisteredApp } from "../registry/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { type ProcessCurrent, readProcessSnapshot } from "../store/process.js";
import { parseHandoffFilter } from "./props/shared.js";
import type { RuntimeState } from "./ui.js";

export interface ProjectView {
  id: string;
  name: string;
  rootPath: string;
  workspaceRoot: string;
  baseBranch: string;
  createdAt: string;
  deleting: boolean;
  builtin?: boolean;
  apps: RegisteredApp[];
  handoffs: Handoff[];
  handoffPolicies: HandoffPolicy[];
  handoffGrants: HandoffGrant[];
  inboundHandoffGrants: HandoffGrant[];
}

export interface AppRef {
  id: string;
  appKey: string;
  path: string;
  kind: string | null;
  projectId: string;
  projectName: string;
  projectRoot: string;
  deleting: boolean;
}

/** Current process detail plus the newest history id (design §8.1-8.2). */
export type ProcessDetail = ProcessCurrent & { lastEventId: number };

export interface SiteModel {
  projects: ProjectView[];
  apps: Map<string, AppRef>;
  runtime: Map<string, RuntimeState>;
  process: Map<string, ProcessDetail>;
  pendingRestart: Map<string, boolean>;
  pendingRestartReasons: Map<string, string[]>;
  pendingCount: number;
  sshPendingCount: number;
  sshPendingByApp: Map<string, number>;
  sshHostsByApp: Map<string, number>;
  startingCount: number;
  runningCount: number;
  errorCount: number;
  stoppedCount: number;
  appCount: number;
  handoffCount: number;
}

export interface DashboardDeps {
  db: SqliteDatabase;
  getProjects: () => Array<{
    id: string;
    name: string;
    rootPath: string;
    workspaceRoot: string;
    deleting?: boolean;
    service: Pick<CoordinatorService, "listApps">;
  }>;
  manager?: Pick<InstanceManager, "pendingRestart">;
}

export type { HandoffFilter } from "./props/shared.js";
export { parseHandoffFilter };

function projectMeta(db: SqliteDatabase): Map<string, { baseBranch: string; createdAt: string }> {
  const rows = db.prepare("SELECT id, base_branch, created_at FROM projects").all() as Array<{
    id: string;
    base_branch: string;
    created_at: string;
  }>;
  return new Map(
    rows.map((row) => [row.id, { baseBranch: row.base_branch, createdAt: row.created_at }]),
  );
}

function runtimeMap(db: SqliteDatabase): Map<string, RuntimeState> {
  const rows = db.prepare("SELECT app_id, state FROM instances").all() as Array<{
    app_id: string;
    state: string;
  }>;
  const map = new Map<string, RuntimeState>();
  for (const row of rows) {
    if (
      row.state === "starting" ||
      row.state === "running" ||
      row.state === "stopped" ||
      row.state === "error"
    ) {
      map.set(row.app_id, row.state);
    } else if (row.state === "failed") {
      map.set(row.app_id, "error");
    } else {
      map.set(row.app_id, "stopped");
    }
  }
  return map;
}

export function buildSite(deps: DashboardDeps): SiteModel {
  const meta = projectMeta(deps.db);
  const runtime = runtimeMap(deps.db);
  const apps = new Map<string, AppRef>();
  const pendingRestart = new Map<string, boolean>();
  const pendingRestartReasons = new Map<string, string[]>();
  const projects = deps.getProjects().map((project) => {
    const details = meta.get(project.id);
    const projectApps = project.service.listApps();
    for (const app of projectApps) {
      apps.set(app.id, {
        id: app.id,
        appKey: app.appKey,
        path: app.path,
        kind: app.kind,
        projectId: project.id,
        projectName: project.name,
        projectRoot: project.rootPath,
        deleting: app.deleting,
      });
    }
    return {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      workspaceRoot: project.workspaceRoot,
      baseBranch: details?.baseBranch ?? "main",
      createdAt: details?.createdAt ?? new Date(0).toISOString(),
      deleting: project.deleting === true,
      builtin: isMasterProject(project.id),
      apps: projectApps,
      handoffs: listHandoffs(deps.db, project.id),
      handoffPolicies: listHandoffPolicies(deps.db, project.id),
      handoffGrants: listHandoffGrants(deps.db, project.id),
      inboundHandoffGrants: listInboundHandoffGrants(deps.db, project.id),
    };
  });

  const process = new Map<string, ProcessDetail>();
  for (const project of projects) {
    for (const app of project.apps) {
      process.set(app.id, readProcessSnapshot(deps.db, app.id));
    }
  }

  let pendingCount = 0;
  let sshPendingCount = 0;
  const sshPendingByApp = new Map<string, number>();
  const sshHostsByApp = new Map<string, number>();
  try {
    const now = new Date().toISOString();
    const pendingRows = deps.db
      .prepare(
        "SELECT app_id AS appId, COUNT(*) AS count FROM ssh_approvals WHERE status = 'pending' AND expires_at > ? GROUP BY app_id",
      )
      .all(now) as Array<{ appId: string; count: number }>;
    for (const row of pendingRows) {
      sshPendingByApp.set(row.appId, row.count);
      sshPendingCount += row.count;
    }
    const hostRows = deps.db
      .prepare("SELECT app_id AS appId, COUNT(*) AS count FROM app_ssh_hosts GROUP BY app_id")
      .all() as Array<{ appId: string; count: number }>;
    for (const row of hostRows) {
      sshHostsByApp.set(row.appId, row.count);
    }
  } catch {
    // The SSH tables are absent only in pre-migration fixtures; the page still renders.
  }
  let startingCount = 0;
  let runningCount = 0;
  let errorCount = 0;
  let stoppedCount = 0;
  let appCount = 0;
  let handoffCount = 0;
  const seenHandoffIds = new Set<string>();
  for (const project of projects) {
    if (project.builtin === true) {
      continue;
    }
    appCount += project.apps.length;
    for (const handoff of project.handoffs) {
      if (seenHandoffIds.has(handoff.id)) {
        continue;
      }
      seenHandoffIds.add(handoff.id);
      handoffCount += 1;
      if (handoff.state === "awaiting_approval" || handoff.replyState === "awaiting_approval") {
        pendingCount += 1;
      }
    }
    for (const app of project.apps) {
      const pending = deps.manager?.pendingRestart(app.id);
      pendingRestart.set(app.id, pending?.pending ?? false);
      pendingRestartReasons.set(app.id, pending?.reasons ?? []);
      const state = runtime.get(app.id) ?? "stopped";
      if (state === "starting") {
        startingCount += 1;
      } else if (state === "running") {
        runningCount += 1;
      } else if (state === "error") {
        errorCount += 1;
      } else {
        stoppedCount += 1;
      }
    }
  }

  return {
    projects,
    apps,
    runtime,
    process,
    pendingRestart,
    pendingRestartReasons,
    pendingCount,
    sshPendingCount,
    sshPendingByApp,
    sshHostsByApp,
    startingCount,
    runningCount,
    errorCount,
    stoppedCount,
    appCount,
    handoffCount,
  };
}

/** Projects shown to the operator: everything except the reserved master project. */
export function operatorProjects(site: SiteModel): ProjectView[] {
  return site.projects.filter((project) => project.builtin !== true);
}
