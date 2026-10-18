import { type Handoff, type HandoffState, listHandoffs } from "../coordinator/handoff.js";
import type { CoordinatorService } from "../coordinator/service.js";
import type { RegisteredApp } from "../registry/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { appDir } from "./apps.js";
import {
  appShell,
  emptyState,
  escapeHtml,
  handoffDialog,
  icon,
  ideFolderUrl,
  type NavProject,
  type Notice,
  pageHeader,
  plural,
  type RuntimeState,
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
  baseBranch: string;
  createdAt: string;
  apps: RegisteredApp[];
  handoffs: Handoff[];
}

export interface AppRef {
  id: string;
  appKey: string;
  path: string;
  kind: string | null;
  projectId: string;
  projectName: string;
  projectRoot: string;
}

export interface SiteModel {
  projects: ProjectView[];
  apps: Map<string, AppRef>;
  runtime: Map<string, RuntimeState>;
  pendingCount: number;
  runningCount: number;
  failedCount: number;
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
    service: Pick<CoordinatorService, "listApps">;
  }>;
}

export interface PageChrome {
  operatorName: string;
  notice?: Notice;
}

const ACTIVE_STATES: readonly HandoffState[] = ["queued", "dispatching", "in_progress"];
const CLOSED_STATES: readonly HandoffState[] = [
  "delivered",
  "rejected",
  "failed",
  "expired",
  "cancelled",
];

export type HandoffFilter = "all" | "waiting" | "active" | "closed";

export function parseHandoffFilter(value: string | undefined): HandoffFilter {
  return value === "waiting" || value === "active" || value === "closed" ? value : "all";
}

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
    if (row.state === "running" || row.state === "failed") {
      map.set(row.app_id, row.state);
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
      });
    }
    return {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      baseBranch: details?.baseBranch ?? "main",
      createdAt: details?.createdAt ?? new Date(0).toISOString(),
      apps: projectApps,
      handoffs: listHandoffs(deps.db, project.id),
    };
  });

  let pendingCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  let stoppedCount = 0;
  let appCount = 0;
  let handoffCount = 0;
  for (const project of projects) {
    handoffCount += project.handoffs.length;
    appCount += project.apps.length;
    for (const handoff of project.handoffs) {
      if (handoff.state === "awaiting_approval") {
        pendingCount += 1;
      }
    }
    for (const app of project.apps) {
      const state = runtime.get(app.id) ?? "stopped";
      if (state === "running") {
        runningCount += 1;
      } else if (state === "failed") {
        failedCount += 1;
      } else {
        stoppedCount += 1;
      }
    }
  }

  return {
    projects,
    apps,
    runtime,
    pendingCount,
    runningCount,
    failedCount,
    stoppedCount,
    appCount,
    handoffCount,
  };
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
  });
}

function handoffCounts(handoffs: Handoff[]): {
  all: number;
  waiting: number;
  active: number;
  closed: number;
} {
  let waiting = 0;
  let active = 0;
  let closed = 0;
  for (const handoff of handoffs) {
    if (handoff.state === "awaiting_approval") {
      waiting += 1;
    } else if (ACTIVE_STATES.includes(handoff.state)) {
      active += 1;
    } else if (CLOSED_STATES.includes(handoff.state)) {
      closed += 1;
    }
  }
  return { all: handoffs.length, waiting, active, closed };
}

function appKeyFor(site: SiteModel, appId: string): string {
  return site.apps.get(appId)?.appKey ?? appId.split(":").pop() ?? appId;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function shortTime(iso: string): string {
  return timeAgo(iso);
}

function projectLastActivity(project: ProjectView): string {
  let latest = project.createdAt;
  for (const handoff of project.handoffs) {
    if (handoff.updatedAt > latest) {
      latest = handoff.updatedAt;
    }
  }
  return latest;
}

function allHandoffs(site: SiteModel): Handoff[] {
  return site.projects.flatMap((project) => project.handoffs);
}

function sortedHandoffs(handoffs: Handoff[]): Handoff[] {
  return [...handoffs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function waitingHandoffs(site: SiteModel): Handoff[] {
  return sortedHandoffs(
    allHandoffs(site).filter((handoff) => handoff.state === "awaiting_approval"),
  );
}

function reviewHref(handoff: Handoff, filter: HandoffFilter = "all"): string {
  const params = new URLSearchParams();
  if (filter !== "all") {
    params.set("filter", filter);
  }
  params.set("q", shortId(handoff.id));
  return `/handoffs?${params.toString()}`;
}

function projectHandoffRows(site: SiteModel, project: ProjectView): string {
  if (project.handoffs.length === 0) {
    return "";
  }
  return sortedHandoffs(project.handoffs)
    .map((handoff) => {
      return `<tr id="handoff-${escapeHtml(handoff.id)}">
        <td data-label="Route">${routeText(appKeyFor(site, handoff.fromAppId), appKeyFor(site, handoff.toAppId))}</td>
        <td data-label="State">${statusPill(handoff.state)}</td>
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

function addAppDialog(project: ProjectView): string {
  return `<dialog class="dialog" id="add-app" aria-labelledby="add-app-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="add-app-title">Add application</h2>
        <p class="dialog__meta">${escapeHtml(project.name)} / ${escapeHtml(project.rootPath)}</p>
      </header>
      <form class="dialog__form" method="post" action="/api/projects/${encodeURIComponent(project.id)}/apps">
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
          <input type="hidden" name="return_to" value="/projects/${escapeHtml(project.id)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit">Add application</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function newHandoffDialog(project: ProjectView): string {
  const fromKey = project.apps[0]?.appKey;
  const toKey = project.apps[1]?.appKey ?? fromKey;
  const option = (appKey: string, selectedKey: string | undefined): string =>
    `<option value="${escapeHtml(appKey)}"${appKey === selectedKey ? " selected" : ""}>${escapeHtml(appKey)}</option>`;
  const fromOptions = project.apps.map((app) => option(app.appKey, fromKey)).join("");
  const toOptions = project.apps.map((app) => option(app.appKey, toKey)).join("");
  const empty = project.apps.length === 0;
  return `<dialog class="dialog" id="new-handoff" aria-labelledby="new-handoff-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="new-handoff-title">New handoff</h2>
        <p class="dialog__meta">${escapeHtml(project.name)} / ${plural(project.apps.length, "application")}</p>
      </header>
      <form class="dialog__form" method="post" action="/api/handoffs">
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
            <span>Requires operator approval before dispatch</span>
          </label>
          ${empty ? '<p class="hint">Add an application to this project before creating a handoff.</p>' : ""}
          <input type="hidden" name="project" value="${escapeHtml(project.id)}" />
          <input type="hidden" name="return_to" value="/projects/${escapeHtml(project.id)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit"${empty ? " disabled" : ""}>Create handoff</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function handoffDialogs(handoffs: Handoff[], site: SiteModel, returnTo: string): string {
  return handoffs
    .map((handoff) =>
      handoffDialog({
        id: handoff.id,
        state: handoff.state,
        from: appKeyFor(site, handoff.fromAppId),
        to: appKeyFor(site, handoff.toAppId),
        summary: handoff.summary,
        spec: handoff.spec,
        attempts: handoff.attempts,
        error: handoff.error,
        result: handoff.result,
        createdAt: handoff.createdAt,
        updatedAt: handoff.updatedAt,
        returnTo,
        canDecide: handoff.state === "awaiting_approval",
      }),
    )
    .join("");
}

/* ------------------------------------------------------------------------- */
/* Overview                                                                 */
/* ------------------------------------------------------------------------- */

export function renderOverview(site: SiteModel, chrome: PageChrome): string {
  const projects = [...site.projects].sort((a, b) =>
    projectLastActivity(b).localeCompare(projectLastActivity(a)),
  );
  const recent = sortedHandoffs(allHandoffs(site)).slice(0, 8);
  const waiting = waitingHandoffs(site);

  const header = pageHeader({
    overline: "Workbench",
    title: "Fleet overview",
    description: "Current state of every project, application, and handoff in this workspace.",
    meta: [`${plural(site.projects.length, "project")}`, `${plural(site.appCount, "application")}`],
    actions:
      site.projects.length === 0
        ? undefined
        : `<button class="btn btn-primary" type="button" data-dialog-open="new-project">${icon("plus")}New project</button>`,
  });

  const empty =
    site.projects.length === 0
      ? `${emptyState({
          iconName: "folder",
          title: "No projects yet",
          body: "Create a project, or mount a folder with .hanse/project.yaml and restart the coordinator.",
          action: `<button class="btn btn-primary btn-sm" type="button" data-dialog-open="new-project">${icon("plus")}New project</button>`,
        })}
        <p class="hint">The manifest is the source of truth: .hanse/project.yaml lists the project id, name, base branch, and applications.</p>`
      : "";

  const watch = `<div class="watch-strip watch-strip--4">
    <div class="watch"><p class="watch__value">${site.projects.length}</p><p class="watch__label">Projects</p></div>
    <div class="watch"><p class="watch__value">${site.appCount}</p><p class="watch__label">Applications</p></div>
    <div class="watch"><p class="watch__value">${site.runningCount}</p><p class="watch__label">Agents running</p></div>
    <div class="watch"><p class="watch__value">${site.pendingCount}</p><p class="watch__label">Handoffs waiting</p></div>
  </div>`;

  const projectRows = projects
    .map((project) => {
      const counts = handoffCounts(project.handoffs);
      return `<tr>
        <td data-label="Project"><a class="table__primary" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></td>
        <td data-label="Root path"><span class="mono">${escapeHtml(project.rootPath)}</span></td>
        <td data-label="Apps" class="table__num">${project.apps.length}</td>
        <td data-label="Waiting" class="table__num">${counts.waiting}</td>
        <td data-label="Last activity"><span class="mono table__nowrap">${timeTag(projectLastActivity(project))}</span></td>
        <td data-label="Actions" class="table__actions"><a class="btn btn-ghost btn-icon btn-sm" href="/projects/${encodeURIComponent(project.id)}" aria-label="Open ${escapeHtml(project.name)}">${icon("chevron-right")}</a></td>
      </tr>`;
    })
    .join("");

  const projectLedger =
    site.projects.length === 0
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
    recent.length === 0
      ? emptyState({
          iconName: "branch",
          title: "No handoffs yet",
          body: "Handoffs route work between applications. Open a project to create the first one.",
          action: `<a class="btn btn-secondary btn-sm" href="/projects">Open a project</a>`,
        })
      : `<div class="table-wrap">
          <table class="table table--stack table--handoffs">
            <thead><tr><th scope="col">Route</th><th scope="col">Summary</th><th scope="col">State</th><th scope="col">Time</th><th scope="col"></th></tr></thead>
            <tbody>${recent
              .map(
                (handoff) => `<tr>
                  <td data-label="Route">${routeText(appKeyFor(site, handoff.fromAppId), appKeyFor(site, handoff.toAppId))}</td>
                  <td data-label="Summary"><span class="table__primary">${escapeHtml(handoff.summary)}</span></td>
                  <td data-label="State">${statusPill(handoff.state)}</td>
                  <td data-label="Time"><span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span></td>
                  <td data-label="Actions" class="table__actions"><a class="btn btn-ghost btn-sm" href="${reviewHref(handoff)}">Review</a></td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>
        </div>`;

  const waitingCards =
    waiting.length === 0
      ? emptyState({
          iconName: "inbox",
          title: "No handoffs waiting",
          body: "Requests that require operator approval arrive here.",
          action: `<a class="btn btn-secondary btn-sm" href="/handoffs">Open inbox</a>`,
        })
      : `<div class="stack">${waiting
          .map((handoff) =>
            routeCard({
              id: handoff.id,
              state: handoff.state,
              from: appKeyFor(site, handoff.fromAppId),
              to: appKeyFor(site, handoff.toAppId),
              summary: handoff.summary,
              foot: `<span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span><a class="btn btn-ghost btn-sm" href="/handoffs?filter=waiting">Review ${icon("arrow-right")}</a>`,
            }),
          )
          .join("")}</div>`;

  const body =
    site.projects.length === 0
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
              <div class="card__body${recent.length === 0 ? "" : " card__body--flush"}">${recentTable}</div>
            </section>
          </div>
          <aside class="rail-stack" aria-label="Attention and runtime">
            <section class="card" aria-labelledby="waiting-title">
              <div class="card__head"><h2 class="card__title" id="waiting-title">Waiting for approval</h2><span class="mono">${waiting.length}</span></div>
              <div class="card__body">${waitingCards}</div>
            </section>
            <section class="card" aria-labelledby="runtime-title">
              <div class="card__head"><h2 class="card__title" id="runtime-title">Runtime</h2><span class="mono">${plural(site.appCount, "app")}</span></div>
              <div class="card__body stack--tight">
                <div class="summary-row"><span class="small">Running</span><span class="cluster">${runtimePill("running")}<span class="mono">${site.runningCount}</span></span></div>
                <div class="summary-row"><span class="small">Stopped</span><span class="cluster">${runtimePill("stopped")}<span class="mono">${site.stoppedCount}</span></span></div>
                <div class="summary-row"><span class="small">Failed</span><span class="cluster">${runtimePill("failed")}<span class="mono">${site.failedCount}</span></span></div>
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
  });
}

/* ------------------------------------------------------------------------- */
/* Projects index                                                           */
/* ------------------------------------------------------------------------- */

export function renderProjects(
  site: SiteModel,
  options: { q?: string; chrome: PageChrome },
): string {
  const query = (options.q ?? "").trim();
  const needle = query.toLowerCase();
  const filtered = site.projects.filter((project) => {
    if (needle.length === 0) {
      return true;
    }
    return (
      project.name.toLowerCase().includes(needle) || project.rootPath.toLowerCase().includes(needle)
    );
  });
  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));

  const header = pageHeader({
    overline: "Workbench",
    title: "Projects",
    description:
      "Every project discovered under the workspace root, with its applications and handoff activity.",
    meta: [`${plural(site.projects.length, "project")}`, `${plural(site.appCount, "application")}`],
    actions:
      site.projects.length === 0
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
  if (site.projects.length === 0) {
    content = `${emptyState({
      iconName: "folder",
      title: "No projects yet",
      body: "Create a project, or mount a folder with .hanse/project.yaml and restart the coordinator.",
      action: `<button class="btn btn-primary btn-sm" type="button" data-dialog-open="new-project">${icon("plus")}New project</button>`,
    })}
    <p class="hint">A project is a folder with a manifest. Applications are repositories inside it, each with an isolated agent state.</p>`;
  } else if (sorted.length === 0) {
    content = emptyState({
      iconName: "search",
      title: "No matching projects",
      body: `Nothing matches “${query}”. Search by project name or root path.`,
      action: `<a class="btn btn-secondary btn-sm" href="/projects">Clear search</a>`,
    });
  } else {
    const rows = sorted
      .map((project) => {
        const counts = handoffCounts(project.handoffs);
        return `<tr>
          <td data-label="Project"><a class="table__primary" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></td>
          <td data-label="Root path"><span class="mono">${escapeHtml(project.rootPath)}</span></td>
          <td data-label="Apps" class="table__num">${project.apps.length}</td>
          <td data-label="Waiting" class="table__num">${counts.waiting}</td>
          <td data-label="Updated"><span class="mono table__nowrap">${timeTag(projectLastActivity(project))}</span></td>
          <td data-label="Actions" class="table__actions"><a class="btn btn-ghost btn-icon btn-sm" href="/projects/${encodeURIComponent(project.id)}" aria-label="Open ${escapeHtml(project.name)}">${icon("chevron-right")}</a></td>
        </tr>`;
      })
      .join("");
    content = `${search}
      <section class="card" aria-labelledby="projects-table-title">
        <div class="card__head"><h2 class="card__title" id="projects-table-title">Project ledger</h2><span class="mono">${plural(sorted.length, "project")}</span></div>
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
  const project = site.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return undefined;
  }
  const counts = handoffCounts(project.handoffs);
  const waiting = sortedHandoffs(
    project.handoffs.filter((handoff) => handoff.state === "awaiting_approval"),
  );
  const running = project.apps.filter(
    (app) => (site.runtime.get(app.id) ?? "stopped") === "running",
  ).length;

  const header = pageHeader({
    overline: "Project",
    title: project.name,
    description: "Applications, handoff routes, and runtime state for this project.",
    meta: [
      project.rootPath,
      `base ${project.baseBranch}`,
      plural(project.apps.length, "application"),
      `${counts.waiting} waiting`,
    ],
    actions: `<a class="btn btn-secondary" href="${escapeHtml(ideFolderUrl(project.rootPath))}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a><button class="btn btn-primary" type="button" data-dialog-open="new-handoff">${icon("branch")}New handoff</button>`,
  });

  const appRows = project.apps
    .map((app) => {
      const runtime = site.runtime.get(app.id) ?? "stopped";
      const appHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}`;
      return `<tr>
        <td data-label="Application"><strong class="table__primary"><a href="${escapeHtml(appHref)}">${escapeHtml(app.appKey)}</a></strong></td>
        <td data-label="Kind"><span class="badge badge--mono">${escapeHtml(app.kind ?? "app")}</span></td>
        <td data-label="Path"><span class="mono">${escapeHtml(app.path)}</span></td>
        <td data-label="Runtime">${runtimePill(runtime)}</td>
        <td data-label="Actions" class="table__actions"><div class="table__action-group">
          <a class="btn btn-ghost btn-sm" href="${escapeHtml(`/chat?app=${encodeURIComponent(app.appKey)}&project=${encodeURIComponent(project.id)}`)}">${icon("message")}Chat</a>
          <a class="btn btn-ghost btn-icon btn-sm" href="${escapeHtml(ideFolderUrl(appDir(project, app)))}" target="_blank" rel="noreferrer" aria-label="Open ${escapeHtml(app.appKey)} in IDE" title="Open in IDE">${icon("external")}</a>
          <a class="btn btn-ghost btn-icon btn-sm" href="${escapeHtml(appHref)}" aria-label="Open ${escapeHtml(app.appKey)} application" title="Open application">${icon("chevron-right")}</a>
        </div></td>
      </tr>`;
    })
    .join("");

  const appsContent =
    project.apps.length === 0
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
    project.handoffs.length === 0
      ? emptyState({
          iconName: "branch",
          title: "No handoffs yet",
          body: "Route a change to a sibling application. Approval keeps the request in the inbox until an operator decides.",
          action: `<button class="btn btn-secondary btn-sm" type="button" data-dialog-open="new-handoff">${icon("plus")}New handoff</button>`,
        })
      : `<div class="table-wrap">
          <table class="table table--stack table--handoffs">
            <thead><tr><th scope="col">Route</th><th scope="col">State</th><th scope="col">Summary</th><th scope="col">Updated</th><th scope="col"></th></tr></thead>
            <tbody>${projectHandoffRows(site, project)}</tbody>
          </table>
        </div>`;

  const waitingCards =
    waiting.length === 0
      ? emptyState({
          iconName: "inbox",
          title: "Nothing waiting",
          body: "Approval requests from this project appear here.",
          action: `<a class="btn btn-secondary btn-sm" href="/handoffs?filter=waiting">Open inbox</a>`,
        })
      : `<div class="stack">${waiting
          .map((handoff) =>
            routeCard({
              id: handoff.id,
              state: handoff.state,
              from: appKeyFor(site, handoff.fromAppId),
              to: appKeyFor(site, handoff.toAppId),
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
      <div class="stack--tight"><span class="overline">Applications</span><span class="mono">${project.apps.length}</span></div>
      <div class="stack--tight"><span class="overline">Root path</span><span class="mono">${escapeHtml(project.rootPath)}</span></div>
    </div>
    <div class="card__foot"><a class="btn btn-ghost btn-sm" href="${escapeHtml(ideFolderUrl(project.rootPath))}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a></div>
  </section>`;

  const body = `<div class="watch-strip watch-strip--4">
      <div class="watch"><p class="watch__value">${project.apps.length}</p><p class="watch__label">Applications</p></div>
      <div class="watch"><p class="watch__value">${running}</p><p class="watch__label">Running</p></div>
      <div class="watch"><p class="watch__value">${counts.waiting}</p><p class="watch__label">Waiting</p></div>
      <div class="watch"><p class="watch__value">${escapeHtml(shortTime(projectLastActivity(project)))}</p><p class="watch__label">Last activity</p></div>
    </div>
    <div class="workbench-grid workbench-grid--detail section">
      <div class="stack">
        <section class="card" aria-labelledby="apps-title">
          <div class="card__head">
            <h2 class="card__title" id="apps-title">Applications</h2>
            <div class="cluster"><span class="badge">${plural(project.apps.length, "app")}</span><button class="btn btn-ghost btn-sm" type="button" data-dialog-open="add-app">${icon("plus")}Add app</button></div>
          </div>
          <div class="card__body${project.apps.length === 0 ? "" : " card__body--flush"}">${appsContent}</div>
        </section>
        <section class="card" aria-labelledby="project-handoffs-title">
          <div class="card__head"><h2 class="card__title" id="project-handoffs-title">Handoffs</h2><span class="mono">${counts.all}</span></div>
          <div class="card__body${project.handoffs.length === 0 ? "" : " card__body--flush"}">${handoffsContent}</div>
        </section>
      </div>
      <aside class="rail-stack" aria-label="Project attention">
        <section class="card" aria-labelledby="project-waiting-title">
          <div class="card__head"><h2 class="card__title" id="project-waiting-title">Waiting for approval</h2><span class="mono">${waiting.length}</span></div>
          <div class="card__body">${waitingCards}</div>
        </section>
        ${manifest}
      </aside>
    </div>
    ${addAppDialog(project)}
    ${newHandoffDialog(project)}
    ${handoffDialogs(project.handoffs, site, `/projects/${project.id}`)}`;

  return shell(site, chrome, {
    title: project.name,
    active: "project",
    activeProjectId: project.id,
    breadcrumb: [{ label: "Projects", href: "/projects" }, { label: project.name }],
    header,
    body,
  });
}

/* ------------------------------------------------------------------------- */
/* Handoffs inbox                                                           */
/* ------------------------------------------------------------------------- */

function filterHref(filter: HandoffFilter, q: string): string {
  const params = new URLSearchParams();
  if (filter !== "all") {
    params.set("filter", filter);
  }
  if (q.length > 0) {
    params.set("q", q);
  }
  const query = params.toString();
  return query.length === 0 ? "/handoffs" : `/handoffs?${query}`;
}

function matchesQuery(site: SiteModel, handoff: Handoff, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  const from = appKeyFor(site, handoff.fromAppId).toLowerCase();
  const to = appKeyFor(site, handoff.toAppId).toLowerCase();
  const project = site.apps.get(handoff.fromAppId)?.projectName.toLowerCase() ?? "";
  return (
    handoff.id.toLowerCase().includes(needle) ||
    handoff.summary.toLowerCase().includes(needle) ||
    from.includes(needle) ||
    to.includes(needle) ||
    project.includes(needle)
  );
}

export function renderHandoffs(
  site: SiteModel,
  options: { filter?: string; q?: string; chrome: PageChrome },
): string {
  const filter = parseHandoffFilter(options.filter);
  const query = (options.q ?? "").trim();
  const needle = query.toLowerCase();
  const counts = handoffCounts(allHandoffs(site));
  const filtered = sortedHandoffs(
    allHandoffs(site).filter((handoff) => {
      if (filter === "waiting" && handoff.state !== "awaiting_approval") {
        return false;
      }
      if (filter === "active" && !ACTIVE_STATES.includes(handoff.state)) {
        return false;
      }
      if (filter === "closed" && !CLOSED_STATES.includes(handoff.state)) {
        return false;
      }
      return matchesQuery(site, handoff, needle);
    }),
  );

  const header = pageHeader({
    overline: "Workbench",
    title: "Handoffs",
    description: "Requests between sibling applications, with operator approval where required.",
    meta: [`${counts.all} total`, `${counts.waiting} waiting`, `${counts.active} active`],
  });

  const segment = (value: HandoffFilter, label: string, count: number): string => {
    const active = filter === value;
    return `<a class="segmented__item" href="${escapeHtml(filterHref(value, query))}"${active ? ' aria-current="page"' : ""}>${label} <span class="mono">${count}</span></a>`;
  };

  const toolbar = `<div class="toolbar">
    <div class="segmented" role="group" aria-label="Handoff filter">
      ${segment("all", "All", counts.all)}
      ${segment("waiting", "Waiting", counts.waiting)}
      ${segment("active", "Active", counts.active)}
      ${segment("closed", "Closed", counts.closed)}
    </div>
    <form class="cluster" method="get" action="/handoffs" role="search">
      ${filter === "all" ? "" : `<input type="hidden" name="filter" value="${filter}" />`}
      <label class="sr-only" for="handoff-search">Search handoffs</label>
      <input class="input search-input" id="handoff-search" name="q" value="${escapeHtml(query)}" placeholder="Id, summary, application" autocomplete="off" />
      <button class="btn btn-secondary" type="submit">${icon("search")}Search</button>
      ${query.length > 0 ? `<a class="btn btn-ghost" href="${escapeHtml(filterHref(filter, ""))}">Clear search</a>` : ""}
    </form>
  </div>`;

  let content: string;
  if (filtered.length === 0) {
    const allEmpty = counts.all === 0;
    const title = allEmpty
      ? "No handoffs yet"
      : query.length > 0
        ? "No matching handoffs"
        : filter === "waiting"
          ? "No handoffs waiting"
          : filter === "active"
            ? "No active handoffs"
            : "No closed handoffs";
    const body = allEmpty
      ? "Handoffs route work between applications. Open a project to create the first one."
      : query.length > 0
        ? `Nothing matches “${query}” in this filter.`
        : filter === "waiting"
          ? "Approval requests arrive here when an agent requires a human decision."
          : filter === "active"
            ? "Queued, dispatching, and in-progress handoffs appear here."
            : "Delivered, rejected, failed, expired, and cancelled handoffs appear here.";
    const action = allEmpty
      ? `<a class="btn btn-secondary btn-sm" href="/projects">Open a project</a>`
      : query.length > 0
        ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(filterHref(filter, ""))}">Clear search</a>`
        : `<a class="btn btn-secondary btn-sm" href="/handoffs">Show all handoffs</a>`;
    content = `${toolbar}${emptyState({
      iconName: allEmpty ? "branch" : "search",
      title,
      body,
      action,
    })}`;
  } else {
    const rows = filtered
      .map((handoff) => {
        const inline =
          handoff.state === "awaiting_approval"
            ? `<form class="table__inline-form" method="post" action="/api/handoffs/${encodeURIComponent(handoff.id)}/decision">
                <input type="hidden" name="return_to" value="${escapeHtml(filterHref(filter, ""))}" />
                <button class="btn btn-danger btn-sm" type="submit" name="decision" value="rejected">Reject</button>
                <button class="btn btn-primary btn-sm" type="submit" name="decision" value="approved">Approve</button>
              </form>`
            : "";
        return `<tr id="handoff-${escapeHtml(handoff.id)}">
          <td data-label="Id"><span class="mono table__nowrap">${escapeHtml(shortId(handoff.id))}</span></td>
          <td data-label="Route">${routeText(appKeyFor(site, handoff.fromAppId), appKeyFor(site, handoff.toAppId))}</td>
          <td data-label="State">${statusPill(handoff.state)}</td>
          <td data-label="Summary"><span class="table__primary">${escapeHtml(handoff.summary)}</span></td>
          <td data-label="Updated"><span class="mono table__nowrap">${timeTag(handoff.updatedAt)}</span></td>
          <td data-label="Actions" class="table__actions"><div class="table__action-group">${inline}<button class="btn btn-ghost btn-sm" type="button" data-dialog-open="h-${escapeHtml(handoff.id)}">Review</button></div></td>
        </tr>`;
      })
      .join("");
    content = `${toolbar}
      <section class="card" aria-labelledby="handoffs-table-title">
        <div class="card__head"><h2 class="card__title" id="handoffs-table-title">${filter === "all" ? "All handoffs" : filter === "waiting" ? "Waiting for approval" : filter === "active" ? "Active handoffs" : "Closed handoffs"}</h2><span class="mono">${filtered.length}</span></div>
        <div class="card__body card__body--flush">
          <div class="table-wrap">
            <table class="table table--stack table--handoffs table--inbox">
              <thead><tr><th scope="col">Id</th><th scope="col">Route</th><th scope="col">State</th><th scope="col">Summary</th><th scope="col">Updated</th><th scope="col"></th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </section>
      ${handoffDialogs(filtered, site, filterHref(filter, ""))}`;
  }

  return shell(site, options.chrome, {
    title: "Handoffs",
    active: "handoffs",
    breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Handoffs" }],
    header,
    body: content,
  });
}

/* ------------------------------------------------------------------------- */
/* Errors                                                                   */
/* ------------------------------------------------------------------------- */

export function renderNotFound(site: SiteModel, chrome: PageChrome): string {
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
