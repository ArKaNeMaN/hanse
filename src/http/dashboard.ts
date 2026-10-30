import { type Handoff, listHandoffs } from "../coordinator/handoff.js";
import { type HandoffPolicy, listHandoffPolicies } from "../coordinator/policy.js";
import type { CoordinatorService } from "../coordinator/service.js";
import { isMasterProject } from "../master/constants.js";
import type { InstanceManager } from "../opencode/manager.js";
import type { RegisteredApp } from "../registry/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { buildHandoffsProps, type HandoffFilterProps } from "./props/handoffs.js";
import { buildOverviewProps } from "./props/overview.js";
import {
  type AddAppDialogProps,
  buildProjectProps,
  type NewHandoffDialogProps,
  type ProjectDeletionProps,
  type ProjectHandoffProps,
  type ProjectPolicyProps,
} from "./props/project.js";
import { buildProjectsProps } from "./props/projects.js";
import { parseHandoffFilter, sortedHandoffs } from "./props/shared.js";
import {
  appShell,
  deletionStatus,
  emptyState,
  escapeHtml,
  handoffDialog,
  icon,
  type NavProject,
  type Notice,
  pageHeader,
  plural,
  type RuntimeState,
  replyPill,
  routeCard,
  routeText,
  runtimePill,
  statusPill,
  timeAgo,
  timeTag,
} from "./ui.js";

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

export interface SiteModel {
  projects: ProjectView[];
  apps: Map<string, AppRef>;
  runtime: Map<string, RuntimeState>;
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

export interface PageChrome {
  operatorName: string;
  notice?: Notice;
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
    };
  });

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
  for (const project of projects) {
    if (project.builtin === true) {
      continue;
    }
    handoffCount += project.handoffs.length;
    appCount += project.apps.length;
    for (const handoff of project.handoffs) {
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

/* ------------------------------------------------------------------------- */
/* Shared page chrome                                                       */
/* ------------------------------------------------------------------------- */

function navProjects(site: SiteModel): NavProject[] {
  return site.projects.map((project) => ({
    id: project.id,
    name: project.name,
    appCount: project.apps.length,
  }));
}

function shell(
  site: SiteModel,
  chrome: PageChrome,
  options: {
    title: string;
    active: "overview" | "projects" | "project" | "handoffs" | "none";
    activeProjectId?: string;
    breadcrumb: Array<{ label: string; href?: string }>;
    header: string;
    body: string;
    settingsHref?: string;
    skillsHref?: string;
    moduleScripts?: string[];
    contentScript?: boolean;
  },
): string {
  return appShell({
    title: options.title,
    active: options.active,
    activeProjectId: options.activeProjectId,
    breadcrumb: options.breadcrumb,
    projects: navProjects(site),
    pendingCount: site.pendingCount,
    operatorName: chrome.operatorName,
    header: options.header,
    body: options.body,
    notice: chrome.notice,
    settingsHref: options.settingsHref,
    skillsHref: options.skillsHref,
    moduleScripts: options.moduleScripts,
    ...(options.contentScript === undefined ? {} : { contentScript: options.contentScript }),
  });
}

function projectHandoffRows(handoffs: readonly ProjectHandoffProps[]): string {
  if (handoffs.length === 0) {
    return "";
  }
  return handoffs
    .map((handoff) => {
      return `<tr id="handoff-${escapeHtml(handoff.id)}">
        <td data-label="Route">${routeText(handoff.fromAppKey, handoff.toAppKey)}</td>
        <td data-label="State"><div class="cluster">${statusPill(handoff.state)}${replyPill(handoff.replyState)}</div></td>
        <td data-label="Summary"><span class="table__primary">${escapeHtml(handoff.summary)}</span></td>
        <td data-label="Updated"><span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span></td>
        <td data-label="Actions" class="table__actions"><button class="btn btn-ghost btn-sm" type="button" data-dialog-open="h-${escapeHtml(handoff.id)}">Review</button></td>
      </tr>`;
    })
    .join("");
}

/* ------------------------------------------------------------------------- */
/* Dialogs                                                                  */
/* ------------------------------------------------------------------------- */

function newProjectDialog(): string {
  return `<dialog class="dialog" id="new-project" aria-labelledby="new-project-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="new-project-title">New project</h2>
        <p class="dialog__meta">Creates a project manifest in the workspace</p>
      </header>
      <form class="dialog__form" method="post" action="/api/projects">
        <div class="dialog__body">
          <div class="field">
            <label class="label" for="new-project-name">Project name (required)</label>
            <input class="input" id="new-project-name" name="name" required autocomplete="off" placeholder="northbank" aria-describedby="new-project-hint" />
            <p class="hint" id="new-project-hint">A slugged folder with .hanse/project.yaml is created under the workspace root.</p>
          </div>
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit">Create project</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function addAppDialog(dialog: AddAppDialogProps): string {
  return `<dialog class="dialog" id="add-app" aria-labelledby="add-app-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="add-app-title">Add application</h2>
        <p class="dialog__meta">${escapeHtml(dialog.projectName)} / ${escapeHtml(dialog.rootPath)}</p>
      </header>
      <form class="dialog__form" method="post" action="${escapeHtml(dialog.action)}">
        <div class="dialog__body">
          <div class="field">
            <label class="label" for="add-app-name">Application name (required)</label>
            <input class="input" id="add-app-name" name="name" required autocomplete="off" placeholder="gateway" aria-describedby="add-app-name-hint" />
            <p class="hint" id="add-app-name-hint">Used as the app key in routes and handoffs.</p>
          </div>
          <div class="field">
            <label class="label" for="add-app-path">Path, optional</label>
            <input class="input" id="add-app-path" name="path" autocomplete="off" placeholder="apps/gateway" aria-describedby="add-app-path-hint" />
            <p class="hint" id="add-app-path-hint">Relative to the project root. Defaults to apps/&lt;slug&gt;.</p>
          </div>
          <div class="field">
            <label class="label" for="add-app-remote">Git remote, optional</label>
            <input class="input" id="add-app-remote" name="remote" autocomplete="off" placeholder="git@github.com:org/gateway.git" aria-describedby="add-app-remote-hint" />
            <p class="hint" id="add-app-remote-hint">Clones the repository into the path when provided.</p>
          </div>
          <input type="hidden" name="return_to" value="${escapeHtml(dialog.returnTo)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit">Add application</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function projectDeleteDialog(dialog: ProjectDeletionProps): string {
  const retrying = dialog.deleting;
  return `<dialog class="dialog" id="project-delete-dialog" aria-labelledby="project-delete-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="project-delete-title">${retrying ? "Retry project deletion?" : "Delete project?"}</h2>
        <p class="dialog__meta">${escapeHtml(dialog.projectName)} / ${plural(dialog.appCount, "application")}</p>
      </header>
      <form class="dialog__form" method="post" action="${escapeHtml(dialog.action)}">
        <div class="dialog__body">
          <p class="body">This removes every application in the project, including their sessions, handoffs, credentials, and managed images. Checking <strong>Delete files too</strong> also deletes the project and application source files on disk.</p>
          <div class="field">
            <label class="label" for="project-delete-confirm">Type ${escapeHtml(dialog.confirmName)} to confirm (required)</label>
            <input class="input" id="project-delete-confirm" name="confirm" required autocomplete="off" spellcheck="false" aria-describedby="project-delete-confirm-hint" />
            <p class="hint" id="project-delete-confirm-hint">The project name must match exactly.</p>
          </div>
          <label class="check">
            <input class="checkbox" type="checkbox" name="deleteFiles" value="true" />
            <span>Delete files too</span>
          </label>
          <input type="hidden" name="return_to" value="${escapeHtml(dialog.returnTo)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-danger" type="submit">${retrying ? "Retry deletion" : "Delete project"}</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function handoffPolicyCard(projectId: string, policy: ProjectPolicyProps): string {
  const key = (value: string): string => (value === "*" ? "Any application" : value);
  const appOption = (appKey: string): string =>
    `<option value="${escapeHtml(appKey)}">${escapeHtml(appKey)}</option>`;
  const anyOption = '<option value="*">Any application</option>';
  const rules = policy.rules;
  const encodedId = encodeURIComponent(projectId);
  const rows =
    rules.length === 0
      ? '<p class="small">No rules. Dispatch and replies are autonomous for every directed pair.</p>'
      : `<div class="table-wrap"><table class="table table--stack">
          <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Dispatch</th><th scope="col">Reply</th><th scope="col"></th></tr></thead>
          <tbody>${rules
            .map(
              (rule) => `<tr>
                <td data-label="From"><span class="mono">${escapeHtml(key(rule.fromAppKey))}</span></td>
                <td data-label="To"><span class="mono">${escapeHtml(key(rule.toAppKey))}</span></td>
                <td data-label="Dispatch"><span class="mono">${escapeHtml(rule.dispatchMode)}</span></td>
                <td data-label="Reply"><span class="mono">${escapeHtml(rule.replyMode)}</span></td>
                <td data-label="" class="table__actions"><form method="post" action="/api/projects/${encodedId}/handoff-policy/delete">
                  <input type="hidden" name="from" value="${escapeHtml(rule.fromAppKey)}" />
                  <input type="hidden" name="to" value="${escapeHtml(rule.toAppKey)}" />
                  <input type="hidden" name="return_to" value="/projects/${encodedId}" />
                  <button class="btn btn-ghost btn-sm" type="submit">Delete</button>
                </form></td>
              </tr>`,
            )
            .join("")}</tbody>
        </table></div>`;
  return `<section class="card" aria-labelledby="handoff-policy-title">
    <div class="card__head"><h2 class="card__title" id="handoff-policy-title">Handoff policy</h2><span class="badge">${rules.length} rules</span></div>
    <div class="card__body stack--tight">
      <p class="small">The most specific rule wins: exact pair, then one wildcard (a from-specific rule wins a tie), then the project default. No matching rule means <span class="mono">auto</span> dispatch and <span class="mono">auto</span> reply.</p>
      ${rows}
      <form class="stack--tight" method="post" action="/api/projects/${encodedId}/handoff-policy">
        <div class="cluster">
          <div class="field"><label class="label" for="handoff-policy-from">From</label><div class="select-wrap"><select class="select" id="handoff-policy-from" name="from">${anyOption}${policy.appOptions.map((appKey) => appOption(appKey)).join("")}</select>${icon("chevron-down")}</div></div>
          <div class="field"><label class="label" for="handoff-policy-to">To</label><div class="select-wrap"><select class="select" id="handoff-policy-to" name="to">${anyOption}${policy.appOptions.map((appKey) => appOption(appKey)).join("")}</select>${icon("chevron-down")}</div></div>
          <div class="field"><label class="label" for="handoff-policy-dispatch">Dispatch</label><div class="select-wrap"><select class="select" id="handoff-policy-dispatch" name="dispatch_mode"><option value="auto">Auto</option><option value="approve">Approve</option><option value="deny">Deny</option></select>${icon("chevron-down")}</div></div>
          <div class="field"><label class="label" for="handoff-policy-reply">Reply</label><div class="select-wrap"><select class="select" id="handoff-policy-reply" name="reply_mode"><option value="auto">Auto</option><option value="approve">Approve</option></select>${icon("chevron-down")}</div></div>
        </div>
        <input type="hidden" name="return_to" value="/projects/${encodedId}" />
        <div class="cluster"><button class="btn btn-secondary btn-sm" type="submit">Save rule</button></div>
      </form>
    </div>
  </section>`;
}

function newHandoffDialog(dialog: NewHandoffDialogProps): string {
  const option = (appKey: string, selectedKey: string | null): string =>
    `<option value="${escapeHtml(appKey)}"${appKey === selectedKey ? " selected" : ""}>${escapeHtml(appKey)}</option>`;
  const fromOptions = dialog.appOptions.map((appKey) => option(appKey, dialog.fromKey)).join("");
  const toOptions = dialog.appOptions.map((appKey) => option(appKey, dialog.toKey)).join("");
  const empty = dialog.disabled;
  return `<dialog class="dialog" id="new-handoff" aria-labelledby="new-handoff-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="new-handoff-title">New handoff</h2>
        <p class="dialog__meta">${escapeHtml(dialog.projectName)} / ${plural(dialog.appOptions.length, "application")}</p>
      </header>
      <form class="dialog__form" method="post" action="${escapeHtml(dialog.action)}">
        <div class="dialog__body">
          <div class="field">
            <label class="label" for="handoff-summary">Summary (required)</label>
            <input class="input" id="handoff-summary" name="summary" required autocomplete="off" placeholder="Add an idempotency key to invoice sync" aria-describedby="handoff-summary-hint" />
            <p class="hint" id="handoff-summary-hint">The receiving agent sees this first.</p>
          </div>
          <div class="field">
            <label class="label" for="handoff-from">From application</label>
            <div class="select-wrap">
              <select class="select" id="handoff-from" name="from"${empty ? " disabled" : ""}>${fromOptions || '<option value="">No applications</option>'}</select>
              ${icon("chevron-down")}
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-to">To application</label>
            <div class="select-wrap">
              <select class="select" id="handoff-to" name="to"${empty ? " disabled" : ""}>${toOptions || '<option value="">No applications</option>'}</select>
              ${icon("chevron-down")}
            </div>
          </div>
          <div class="field">
            <label class="label" for="handoff-spec">Specification</label>
            <textarea class="textarea" id="handoff-spec" name="spec" placeholder="Describe the change, constraints, and expected result" aria-describedby="handoff-spec-hint"></textarea>
            <p class="hint" id="handoff-spec-hint">Plain text. The target agent reads this as the task contract.</p>
          </div>
          <label class="check">
            <input class="checkbox" type="checkbox" name="requires_approval" value="1" checked />
            <span>Require operator approval for this handoff</span>
          </label>
          ${empty ? '<p class="hint">Add an application to this project before creating a handoff.</p>' : ""}
          <input type="hidden" name="project" value="${escapeHtml(dialog.projectId)}" />
          <input type="hidden" name="return_to" value="${escapeHtml(dialog.returnTo)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit"${empty ? " disabled" : ""}>Create handoff</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function handoffDialogs(handoffs: readonly ProjectHandoffProps[]): string {
  return handoffs
    .map((handoff) =>
      handoffDialog({
        id: handoff.id,
        state: handoff.displayState,
        from: handoff.fromAppKey,
        to: handoff.toAppKey,
        summary: handoff.summary,
        spec: handoff.spec,
        attempts: handoff.attempts,
        error: handoff.error,
        result: handoff.result,
        outcome: handoff.outcome,
        createdAt: handoff.createdAt,
        updatedAt: handoff.updatedAt,
        returnTo: handoff.returnTo,
        approvalKind: handoff.approvalKind,
        policyDispatchMode: handoff.policyDispatchMode,
        policyReplyMode: handoff.policyReplyMode,
        origin: handoff.origin,
        sourceSessionId: handoff.sourceSessionId,
        sourceSessionHref: handoff.sourceSessionHref,
        sourceSessionDeleted: handoff.sourceSessionDeleted,
        targetSessionId: handoff.targetSessionId,
        targetSessionHref: handoff.targetSessionHref,
        replyState: handoff.replyState,
        replyError: handoff.replyError,
        replyDeliveredSessionId: handoff.replyDeliveredSessionId,
        replyDeliveredAt: handoff.replyDeliveredAt,
        replyDeliveredHref: handoff.replyDeliveredHref,
        deliveredVia: handoff.deliveredVia,
        operatorNote: handoff.operatorNote,
        canCancel: handoff.canCancel,
        canRelaunch: handoff.canRelaunch,
        canRetryReply: handoff.canRetryReply,
        canCancelReply: handoff.canCancelReply,
      }),
    )
    .join("");
}

/* ------------------------------------------------------------------------- */
/* Overview                                                                 */
/* ------------------------------------------------------------------------- */

export function renderOverview(site: SiteModel, chrome: PageChrome): string {
  const props = buildOverviewProps(site);

  const header = pageHeader({
    overline: "Workbench",
    title: "Fleet overview",
    description: "Current state of every project, application, and handoff in this workspace.",
    meta: [
      `${plural(props.counts.projects, "project")}`,
      `${plural(props.counts.applications, "application")}`,
    ],
    actions:
      props.counts.projects === 0
        ? undefined
        : `<button class="btn btn-primary" type="button" data-dialog-open="new-project">${icon("plus")}New project</button>`,
  });

  const empty =
    props.counts.projects === 0
      ? `${emptyState({
          iconName: "folder",
          title: "No projects yet",
          body: "Create a project, or mount a folder with .hanse/project.yaml and restart the coordinator.",
          action: `<button class="btn btn-primary btn-sm" type="button" data-dialog-open="new-project">${icon("plus")}New project</button>`,
        })}
        <p class="hint">The manifest is the source of truth: .hanse/project.yaml lists the project id, name, base branch, and applications.</p>`
      : "";

  const watch = `<div class="watch-strip watch-strip--4">
    <div class="watch"><p class="watch__value">${props.counts.projects}</p><p class="watch__label">Projects</p></div>
    <div class="watch"><p class="watch__value">${props.counts.applications}</p><p class="watch__label">Applications</p></div>
    <div class="watch"><p class="watch__value">${props.counts.running}</p><p class="watch__label">Agents running</p></div>
    <div class="watch"><p class="watch__value">${props.counts.handoffsWaiting}</p><p class="watch__label">Handoffs waiting</p></div>
  </div>`;

  const projectRows = props.projects
    .map((project) => {
      return `<tr>
        <td data-label="Project"><div class="cluster"><a class="table__primary" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a>${project.deleting ? deletionStatus() : ""}</div></td>
        <td data-label="Root path"><span class="mono">${escapeHtml(project.rootPath)}</span></td>
        <td data-label="Apps" class="table__num">${project.appCount}</td>
        <td data-label="Waiting" class="table__num">${project.waitingCount}</td>
        <td data-label="Last activity"><span class="mono table__nowrap">${timeTag(project.lastActivity)}</span></td>
        <td data-label="Actions" class="table__actions"><a class="btn btn-ghost btn-icon btn-sm" href="/projects/${encodeURIComponent(project.id)}" aria-label="Open ${escapeHtml(project.name)}">${icon("chevron-right")}</a></td>
      </tr>`;
    })
    .join("");

  const projectLedger =
    props.projects.length === 0
      ? ""
      : `<section class="card" aria-labelledby="project-ledger-title">
          <div class="card__head">
            <h2 class="card__title" id="project-ledger-title">Project ledger</h2>
            <a class="btn btn-ghost btn-sm" href="/projects">All projects ${icon("arrow-right")}</a>
          </div>
          <div class="card__body card__body--flush">
            <div class="table-wrap">
              <table class="table table--stack">
                <thead><tr><th scope="col">Project</th><th scope="col">Root path</th><th scope="col">Apps</th><th scope="col">Waiting</th><th scope="col">Last activity</th><th scope="col"></th></tr></thead>
                <tbody>${projectRows}</tbody>
              </table>
            </div>
          </div>
        </section>`;

  const recentTable =
    props.recentHandoffs.length === 0
      ? emptyState({
          iconName: "branch",
          title: "No handoffs yet",
          body: "Handoffs route work between applications. Open a project to create the first one.",
          action: `<a class="btn btn-secondary btn-sm" href="/projects">Open a project</a>`,
        })
      : `<div class="table-wrap">
          <table class="table table--stack table--handoffs">
            <thead><tr><th scope="col">Route</th><th scope="col">Summary</th><th scope="col">State</th><th scope="col">Time</th><th scope="col"></th></tr></thead>
            <tbody>${props.recentHandoffs
              .map(
                (handoff) => `<tr>
                  <td data-label="Route">${routeText(handoff.fromAppKey, handoff.toAppKey)}</td>
                  <td data-label="Summary"><span class="table__primary">${escapeHtml(handoff.summary)}</span></td>
                  <td data-label="State"><div class="cluster">${statusPill(handoff.state)}${replyPill(handoff.replyState)}</div></td>
                  <td data-label="Time"><span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span></td>
                  <td data-label="Actions" class="table__actions"><a class="btn btn-ghost btn-sm" href="${handoff.reviewHref}">Review</a></td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>
        </div>`;

  const waitingCards =
    props.waitingHandoffs.length === 0
      ? emptyState({
          iconName: "inbox",
          title: "No handoffs waiting",
          body: "Requests that require operator approval arrive here.",
          action: `<a class="btn btn-secondary btn-sm" href="/handoffs">Open inbox</a>`,
        })
      : `<div class="stack">${props.waitingHandoffs
          .map((handoff) =>
            routeCard({
              id: handoff.id,
              state: handoff.displayState,
              from: handoff.fromAppKey,
              to: handoff.toAppKey,
              summary: handoff.summary,
              foot: `<span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span><a class="btn btn-ghost btn-sm" href="${handoff.reviewHref}">Review ${icon("arrow-right")}</a>`,
            }),
          )
          .join("")}</div>`;

  const body =
    props.counts.projects === 0
      ? `${empty}${newProjectDialog()}`
      : `${watch}
        <div class="workbench-grid section">
          <div class="stack">
            ${projectLedger}
            <section class="card" aria-labelledby="recent-handoffs-title">
              <div class="card__head">
                <h2 class="card__title" id="recent-handoffs-title">Recent handoffs</h2>
                <a class="btn btn-ghost btn-sm" href="/handoffs">Handoffs inbox ${icon("arrow-right")}</a>
              </div>
              <div class="card__body${props.recentHandoffs.length === 0 ? "" : " card__body--flush"}">${recentTable}</div>
            </section>
          </div>
          <aside class="rail-stack" aria-label="Attention and runtime">
            <section class="card" aria-labelledby="waiting-title">
              <div class="card__head"><h2 class="card__title" id="waiting-title">Waiting for approval</h2><span class="mono">${props.waitingHandoffs.length}</span></div>
              <div class="card__body">${waitingCards}</div>
            </section>
            <section class="card" aria-labelledby="runtime-title">
              <div class="card__head"><h2 class="card__title" id="runtime-title">Runtime</h2><span class="mono">${plural(props.counts.applications, "app")}</span></div>
              <div class="card__body stack--tight">
                <div class="summary-row"><span class="small">Starting</span><span class="cluster">${runtimePill("starting")}<span class="mono">${props.counts.starting}</span></span></div>
                <div class="summary-row"><span class="small">Running</span><span class="cluster">${runtimePill("running")}<span class="mono">${props.counts.running}</span></span></div>
                <div class="summary-row"><span class="small">Stopped</span><span class="cluster">${runtimePill("stopped")}<span class="mono">${props.counts.stopped}</span></span></div>
                <div class="summary-row"><span class="small">Error</span><span class="cluster">${runtimePill("error")}<span class="mono">${props.counts.error}</span></span></div>
              </div>
              <div class="card__foot"><a class="btn btn-ghost btn-sm" href="/projects">Inspect applications ${icon("arrow-right")}</a></div>
            </section>
          </aside>
        </div>
        ${newProjectDialog()}`;

  return shell(site, chrome, {
    title: "Fleet overview",
    active: "overview",
    breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Overview" }],
    header,
    body,
    skillsHref: "/skills",
  });
}

/* ------------------------------------------------------------------------- */
/* Projects index                                                           */
/* ------------------------------------------------------------------------- */

export function renderProjects(
  site: SiteModel,
  options: { q?: string; chrome: PageChrome },
): string {
  const props = buildProjectsProps(site, options.q);
  const query = props.query;

  const header = pageHeader({
    overline: "Workbench",
    title: "Projects",
    description:
      "Every project discovered under the workspace root, with its applications and handoff activity.",
    meta: [`${plural(props.projectCount, "project")}`, `${plural(props.appCount, "application")}`],
    actions:
      props.projectCount === 0
        ? undefined
        : `<button class="btn btn-primary" type="button" data-dialog-open="new-project">${icon("plus")}New project</button>`,
  });

  const search = `<form class="toolbar" method="get" action="/projects" role="search">
    <label class="sr-only" for="project-search">Search projects</label>
    <input class="input search-input" id="project-search" name="q" value="${escapeHtml(query)}" placeholder="Name or root path" autocomplete="off" />
    <button class="btn btn-secondary" type="submit">${icon("search")}Search</button>
    ${query.length > 0 ? '<a class="btn btn-ghost" href="/projects">Clear search</a>' : ""}
  </form>`;

  let content: string;
  if (props.projectCount === 0) {
    content = `${emptyState({
      iconName: "folder",
      title: "No projects yet",
      body: "Create a project, or mount a folder with .hanse/project.yaml and restart the coordinator.",
      action: `<button class="btn btn-primary btn-sm" type="button" data-dialog-open="new-project">${icon("plus")}New project</button>`,
    })}
    <p class="hint">A project is a folder with a manifest. Applications are repositories inside it, each with an isolated agent state.</p>`;
  } else if (props.matchedCount === 0) {
    content = emptyState({
      iconName: "search",
      title: "No matching projects",
      body: `Nothing matches “${query}”. Search by project name or root path.`,
      action: `<a class="btn btn-secondary btn-sm" href="/projects">Clear search</a>`,
    });
  } else {
    const rows = props.rows
      .map((project) => {
        return `<tr>
          <td data-label="Project"><div class="cluster"><a class="table__primary" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a>${project.deleting ? deletionStatus() : ""}</div></td>
          <td data-label="Root path"><span class="mono">${escapeHtml(project.rootPath)}</span></td>
          <td data-label="Apps" class="table__num">${project.appCount}</td>
          <td data-label="Waiting" class="table__num">${project.waitingCount}</td>
          <td data-label="Updated"><span class="mono table__nowrap">${timeTag(project.updatedAt)}</span></td>
          <td data-label="Actions" class="table__actions"><a class="btn btn-ghost btn-icon btn-sm" href="/projects/${encodeURIComponent(project.id)}" aria-label="Open ${escapeHtml(project.name)}">${icon("chevron-right")}</a></td>
        </tr>`;
      })
      .join("");
    content = `${search}
      <section class="card" aria-labelledby="projects-table-title">
        <div class="card__head"><h2 class="card__title" id="projects-table-title">Project ledger</h2><span class="mono">${plural(props.matchedCount, "project")}</span></div>
        <div class="card__body card__body--flush">
          <div class="table-wrap">
            <table class="table table--stack">
              <thead><tr><th scope="col">Project</th><th scope="col">Root path</th><th scope="col">Apps</th><th scope="col">Waiting</th><th scope="col">Updated</th><th scope="col"></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </section>`;
  }

  return shell(site, options.chrome, {
    title: "Projects",
    active: "projects",
    breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Projects" }],
    header,
    body: `${content}${newProjectDialog()}`,
    skillsHref: "/skills",
  });
}

/* ------------------------------------------------------------------------- */
/* Project detail                                                           */
/* ------------------------------------------------------------------------- */

export function renderProject(
  site: SiteModel,
  projectId: string,
  chrome: PageChrome,
): string | undefined {
  const props = buildProjectProps(site, projectId);
  if (props === undefined) {
    return undefined;
  }
  const master = props.masterSummary;
  if (master !== null) {
    const header = pageHeader({
      overline: "Master",
      title: "Hanse master",
      description: "Built-in assistant that configures and operates this Hanse instance.",
      meta: [master.runtime, master.path],
      actions: `<a class="btn btn-primary" href="${escapeHtml(master.chatHref)}">${icon("message")}Open chat</a><a class="btn btn-secondary" href="${escapeHtml(master.settingsHref)}">${icon("settings")}Settings</a>`,
    });
    const body = `<div class="watch-strip watch-strip--2">
      <div class="watch"><p class="watch__value">${runtimePill(master.runtime)}</p><p class="watch__label">Runtime</p></div>
      <div class="watch"><p class="watch__value">${escapeHtml(master.kind)}</p><p class="watch__label">Kind</p></div>
    </div>
    <section class="card section" aria-labelledby="master-card-title">
      <div class="card__head"><h2 class="card__title" id="master-card-title">Master agent</h2><span class="badge badge--mono">system</span></div>
      <div class="card__body stack--tight">
        <p class="small">The master runs as an isolated agent. It creates projects and applications, writes their instructions, changes non-secret settings, and starts or restarts application agents through its Hanse tools.</p>
        <p class="small">Its own directory is coordinator-managed and read-only inside its container. Its instructions are rewritten from the coordinator on every start.</p>
        <p class="small">Skills can be created, inspected, updated, enabled/disabled, and overridden from the master chat; deleting or renaming them stays operator-only. Provider keys, git credentials, image builds, and project deletion are operator-only UI actions.</p>
      </div>
      <div class="card__foot"><a class="btn btn-secondary btn-sm" href="${escapeHtml(master.chatHref)}">${icon("message")}Open chat</a><a class="btn btn-ghost btn-sm" href="${escapeHtml(master.settingsHref)}">${icon("settings")}Application settings</a><a class="btn btn-ghost btn-sm" href="${escapeHtml(master.skillsHref)}">${icon("code")}Skills</a></div>
    </section>`;
    return shell(site, chrome, {
      title: "Hanse master",
      active: "project",
      activeProjectId: props.project.id,
      breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Master" }],
      header,
      body,
      settingsHref: master.settingsHref,
      skillsHref: master.skillsHref,
    });
  }
  const project = props.project;

  const header = pageHeader({
    overline: "Project",
    title: project.name,
    description: "Applications, handoff routes, and runtime state for this project.",
    meta: [
      project.rootPath,
      `base ${project.baseBranch}`,
      plural(props.apps.length, "application"),
      `${props.counts.waiting} waiting`,
    ],
    actions: `<a class="btn btn-secondary" href="${escapeHtml(props.hrefs.settings)}">${icon("settings")}Settings</a><a class="btn btn-secondary" href="${escapeHtml(props.hrefs.ide)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a><button class="btn btn-primary" type="button" data-dialog-open="new-handoff">${icon("branch")}New handoff</button>`,
  });

  const appRows = props.apps
    .map((app) => {
      const chatLink =
        app.chatHref === null
          ? ""
          : `<a class="btn btn-ghost btn-sm" href="${escapeHtml(app.chatHref)}">${icon("message")}Chat</a>`;
      return `<tr>
        <td data-label="Application"><div class="cluster"><strong class="table__primary"><a href="${escapeHtml(app.href)}">${escapeHtml(app.appKey)}</a></strong>${app.deleting ? deletionStatus() : ""}</div></td>
        <td data-label="Kind"><span class="badge badge--mono">${escapeHtml(app.kind)}</span></td>
        <td data-label="Path"><span class="mono">${escapeHtml(app.path)}</span></td>
        <td data-label="Runtime"><div class="cluster">${runtimePill(app.runtime)}${app.pendingRestart ? `<a class="badge badge-warning" href="${escapeHtml(app.restartHref)}">Restart required</a>` : ""}</div></td>
        <td data-label="Actions" class="table__actions"><div class="table__action-group">
          ${chatLink}
          <a class="btn btn-ghost btn-icon btn-sm" href="${escapeHtml(app.ideHref)}" target="_blank" rel="noreferrer" aria-label="Open ${escapeHtml(app.appKey)} in IDE" title="Open in IDE">${icon("external")}</a>
          <a class="btn btn-ghost btn-icon btn-sm" href="${escapeHtml(app.href)}" aria-label="Open ${escapeHtml(app.appKey)} application" title="Open application">${icon("chevron-right")}</a>
        </div></td>
      </tr>`;
    })
    .join("");

  const appsContent =
    props.apps.length === 0
      ? emptyState({
          iconName: "folder",
          title: "No applications",
          body: "Add the first application to this project, then start a chat with its agent.",
          action: `<button class="btn btn-secondary btn-sm" type="button" data-dialog-open="add-app">${icon("plus")}Add application</button>`,
        })
      : `<div class="table-wrap">
          <table class="table table--stack">
            <thead><tr><th scope="col">Application</th><th scope="col">Kind</th><th scope="col">Path</th><th scope="col">Runtime</th><th scope="col"></th></tr></thead>
            <tbody>${appRows}</tbody>
          </table>
        </div>`;

  const handoffsContent =
    props.handoffs.length === 0
      ? emptyState({
          iconName: "branch",
          title: "No handoffs yet",
          body: "Route a change to a sibling application. Approval keeps the request in the inbox until an operator decides.",
          action: `<button class="btn btn-secondary btn-sm" type="button" data-dialog-open="new-handoff">${icon("plus")}New handoff</button>`,
        })
      : `<div class="table-wrap">
          <table class="table table--stack table--handoffs">
            <thead><tr><th scope="col">Route</th><th scope="col">State</th><th scope="col">Summary</th><th scope="col">Updated</th><th scope="col"></th></tr></thead>
            <tbody>${projectHandoffRows(sortedHandoffs(props.handoffs))}</tbody>
          </table>
        </div>`;

  const waitingCards =
    props.waitingHandoffs.length === 0
      ? emptyState({
          iconName: "inbox",
          title: "Nothing waiting",
          body: "Approval requests from this project appear here.",
          action: `<a class="btn btn-secondary btn-sm" href="/handoffs?filter=waiting">Open inbox</a>`,
        })
      : `<div class="stack">${props.waitingHandoffs
          .map((handoff) =>
            routeCard({
              id: handoff.id,
              state: handoff.displayState,
              from: handoff.fromAppKey,
              to: handoff.toAppKey,
              summary: handoff.summary,
              foot: `<span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span><button class="btn btn-ghost btn-sm" type="button" data-dialog-open="h-${escapeHtml(handoff.id)}">Review ${icon("arrow-right")}</button>`,
            }),
          )
          .join("")}</div>`;

  const manifest = `<section class="card" aria-labelledby="manifest-title">
    <div class="card__head"><h2 class="card__title" id="manifest-title">Manifest</h2><span class="badge badge--mono">project</span></div>
    <div class="card__body stack--tight">
      <div class="stack--tight"><span class="overline">Manifest</span><span class="mono">.hanse/project.yaml</span></div>
      <div class="stack--tight"><span class="overline">Base branch</span><span class="mono">${escapeHtml(project.baseBranch)}</span></div>
      <div class="stack--tight"><span class="overline">Applications</span><span class="mono">${props.apps.length}</span></div>
      <div class="stack--tight"><span class="overline">Root path</span><span class="mono">${escapeHtml(project.rootPath)}</span></div>
    </div>
    <div class="card__foot"><a class="btn btn-ghost btn-sm" href="${escapeHtml(props.hrefs.ide)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a></div>
  </section>`;

  const dangerZone = `<section class="card section" id="danger-zone" aria-labelledby="danger-zone-title">
    <div class="card__head">
      <h2 class="card__title" id="danger-zone-title">Danger zone</h2>
      ${props.deletion.deleting ? deletionStatus() : '<span class="badge">Destructive</span>'}
    </div>
    <div class="card__body stack--tight">
      ${
        props.deletion.deleting
          ? `<p class="small">A previous deletion did not finish. Retry to remove the remaining applications, records, and runtime resources. Chat and start stay disabled until deletion completes.</p>`
          : `<p class="small">Deleting this project removes every application, session, handoff, credential, and managed image. Source files are kept unless you choose to delete them too.</p>`
      }
    </div>
    <div class="card__foot">
      <button class="btn btn-danger" type="button" data-dialog-open="project-delete-dialog">${icon("trash")}${props.deletion.deleting ? "Retry deletion" : "Delete project"}</button>
    </div>
  </section>`;

  const body = `<div class="watch-strip watch-strip--4">
      <div class="watch"><p class="watch__value">${props.apps.length}</p><p class="watch__label">Applications</p></div>
      <div class="watch"><p class="watch__value">${props.counts.running}</p><p class="watch__label">Running</p></div>
      <div class="watch"><p class="watch__value">${props.counts.waiting}</p><p class="watch__label">Waiting</p></div>
      <div class="watch"><p class="watch__value">${escapeHtml(timeAgo(props.lastActivity))}</p><p class="watch__label">Last activity</p></div>
    </div>
    <div class="workbench-grid workbench-grid--detail section">
      <div class="stack">
        <section class="card" aria-labelledby="apps-title">
          <div class="card__head">
            <h2 class="card__title" id="apps-title">Applications</h2>
            <div class="cluster"><span class="badge">${plural(props.apps.length, "app")}</span><button class="btn btn-ghost btn-sm" type="button" data-dialog-open="add-app">${icon("plus")}Add app</button></div>
          </div>
          <div class="card__body${props.apps.length === 0 ? "" : " card__body--flush"}">${appsContent}</div>
        </section>
        <section class="card" aria-labelledby="project-handoffs-title">
          <div class="card__head"><h2 class="card__title" id="project-handoffs-title">Handoffs</h2><span class="mono">${props.counts.handoffs}</span></div>
          <div class="card__body${props.handoffs.length === 0 ? "" : " card__body--flush"}">${handoffsContent}</div>
        </section>
        ${handoffPolicyCard(project.id, props.policy)}
      </div>
      <aside class="rail-stack" aria-label="Project attention">
        <section class="card" aria-labelledby="project-waiting-title">
          <div class="card__head"><h2 class="card__title" id="project-waiting-title">Waiting for approval</h2><span class="mono">${props.waitingHandoffs.length}</span></div>
          <div class="card__body">${waitingCards}</div>
        </section>
        ${manifest}
      </aside>
    </div>
    ${dangerZone}
    ${addAppDialog(props.dialogs.addApp)}
    ${projectDeleteDialog(props.dialogs.delete)}
    ${newHandoffDialog(props.dialogs.newHandoff)}
    ${handoffDialogs(props.handoffs)}`;

  return shell(site, chrome, {
    title: project.name,
    active: "project",
    activeProjectId: project.id,
    breadcrumb: [{ label: "Projects", href: "/projects" }, { label: project.name }],
    header,
    body,
    settingsHref: props.hrefs.settings,
    skillsHref: props.hrefs.skills,
    moduleScripts: ["/assets/handoff.js"],
  });
}

/* ------------------------------------------------------------------------- */
/* Handoffs inbox                                                           */
/* ------------------------------------------------------------------------- */

export function renderHandoffs(
  site: SiteModel,
  options: { filter?: string; q?: string; chrome: PageChrome },
): string {
  const props = buildHandoffsProps(site, options.filter, options.q);
  const counts = props.counts;

  const header = pageHeader({
    overline: "Workbench",
    title: "Handoffs",
    description: "Requests between sibling applications, with operator approval where required.",
    meta: [
      `${counts.all} total`,
      `${counts.waiting} waiting`,
      `${counts.active} active`,
      `${counts.replies} replies waiting`,
    ],
  });

  const segment = (entry: HandoffFilterProps): string =>
    `<a class="segmented__item" href="${escapeHtml(entry.href)}"${entry.current ? ' aria-current="page"' : ""}>${entry.label} <span class="mono">${entry.count}</span></a>`;

  const toolbar = `<div class="toolbar">
    <div class="segmented" role="group" aria-label="Handoff filter">
      ${props.filters.map(segment).join("\n      ")}
    </div>
    <form class="cluster" method="get" action="${props.search.action}" role="search">
      ${props.search.hiddenFilter === null ? "" : `<input type="hidden" name="filter" value="${props.search.hiddenFilter}" />`}
      <label class="sr-only" for="handoff-search">Search handoffs</label>
      <input class="input search-input" id="handoff-search" name="q" value="${escapeHtml(props.search.query)}" placeholder="${escapeHtml(props.search.placeholder)}" autocomplete="off" />
      <button class="btn btn-secondary" type="submit">${icon("search")}Search</button>
      ${props.search.clearHref === null ? "" : `<a class="btn btn-ghost" href="${escapeHtml(props.search.clearHref)}">Clear search</a>`}
    </form>
  </div>`;

  let content: string;
  if (props.emptyState !== null) {
    const empty = props.emptyState;
    content = `${toolbar}${emptyState({
      iconName: empty.iconName,
      title: empty.title,
      body: empty.body,
      action: `<a class="btn btn-secondary btn-sm" href="${escapeHtml(empty.actionHref)}">${empty.actionLabel}</a>`,
    })}`;
  } else {
    const rows = props.rows
      .map((handoff) => {
        const inline =
          handoff.inlineDecision === null
            ? ""
            : `<form class="table__inline-form" method="post" action="${handoff.inlineDecision.action}">
                <input type="hidden" name="approval_kind" value="${handoff.inlineDecision.approvalKind}" />
                <input type="hidden" name="return_to" value="${escapeHtml(handoff.inlineDecision.returnTo)}" />
                <button class="btn btn-danger btn-sm" type="submit" name="decision" value="rejected">Reject</button>
                <button class="btn btn-primary btn-sm" type="submit" name="decision" value="approved">Approve</button>
              </form>`;
        return `<tr id="handoff-${escapeHtml(handoff.id)}">
          <td data-label="Id"><span class="mono table__nowrap">${escapeHtml(handoff.shortId)}</span></td>
          <td data-label="Route">${routeText(handoff.fromAppKey, handoff.toAppKey)}</td>
          <td data-label="State"><div class="cluster">${statusPill(handoff.state)}${replyPill(handoff.replyState)}</div></td>
          <td data-label="Summary"><span class="table__primary">${escapeHtml(handoff.summary)}</span></td>
          <td data-label="Updated"><span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span></td>
          <td data-label="Actions" class="table__actions"><div class="table__action-group">${inline}<button class="btn btn-ghost btn-sm" type="button" data-dialog-open="h-${escapeHtml(handoff.id)}">Review</button></div></td>
        </tr>`;
      })
      .join("");
    content = `${toolbar}
      <section class="card" aria-labelledby="handoffs-table-title">
        <div class="card__head"><h2 class="card__title" id="handoffs-table-title">${props.tableTitle}</h2><span class="mono">${props.rows.length}</span></div>
        <div class="card__body card__body--flush">
          <div class="table-wrap">
            <table class="table table--stack table--handoffs table--inbox">
              <thead><tr><th scope="col">Id</th><th scope="col">Route</th><th scope="col">State</th><th scope="col">Summary</th><th scope="col">Updated</th><th scope="col"></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </section>
      ${handoffDialogs(props.rows.map((row) => row.dialog))}`;
  }

  return shell(site, options.chrome, {
    title: "Handoffs",
    active: "handoffs",
    breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Handoffs" }],
    header,
    body: content,
    skillsHref: "/skills",
    moduleScripts: ["/assets/handoff.js"],
  });
}

/* ------------------------------------------------------------------------- */
/* Errors                                                                   */
/* ------------------------------------------------------------------------- */

export function renderNotFound(
  site: SiteModel,
  chrome: PageChrome,
  contentScript?: boolean,
): string {
  const header = pageHeader({
    overline: "404",
    title: "Page not found",
    description: "The route does not exist, or the project was not discovered by this coordinator.",
  });
  const body = `<div class="error-state" role="alert">
    <span class="error-state__mark">${icon("alert-triangle", "icon--lg")}</span>
    <div>
      <h3 class="error-state__title">Nothing is moored here</h3>
      <p class="error-state__body">Check the address, or return to the fleet overview to find the project you expected.</p>
      <div class="cluster"><a class="btn btn-primary btn-sm" href="/">Open overview</a><a class="btn btn-secondary btn-sm" href="/projects">Browse projects</a></div>
    </div>
  </div>`;
  return shell(site, chrome, {
    title: "Page not found",
    active: "none",
    breadcrumb: [{ label: "404" }],
    header,
    body,
    ...(contentScript === undefined ? {} : { contentScript }),
  });
}

export function renderErrorPage(site: SiteModel, chrome: PageChrome, message: string): string {
  const header = pageHeader({
    overline: "Error",
    title: "The page could not be rendered",
    description: "The coordinator hit an unexpected error while building this view.",
  });
  const body = `<div class="error-state" role="alert">
    <span class="error-state__mark">${icon("alert-triangle", "icon--lg")}</span>
    <div>
      <h3 class="error-state__title">Coordinator error</h3>
      <p class="error-state__body">${escapeHtml(message)}</p>
      <span class="mono">retry the request, or inspect the coordinator log</span>
      <div class="cluster"><a class="btn btn-secondary btn-sm" href="/">Return to overview</a></div>
    </div>
  </div>`;
  return shell(site, chrome, {
    title: "Coordinator error",
    active: "none",
    breadcrumb: [{ label: "Error" }],
    header,
    body,
  });
}
