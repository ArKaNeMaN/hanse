import type { RegisteredApp } from "../registry/index.js";
import { appDir } from "./apps.js";
import type { PageChrome, SiteModel } from "./dashboard.js";
import { appShell, escapeHtml, icon, ideFolderUrl, pageHeader, runtimePill } from "./ui.js";

function navProjects(site: SiteModel): Array<{ id: string; name: string; appCount: number }> {
  return site.projects.map((project) => ({
    id: project.id,
    name: project.name,
    appCount: project.apps.length,
  }));
}

function loadingBody(id: string, lines: number): string {
  const skeletons = Array.from({ length: lines }, (_, index) => {
    const modifier =
      index === 0 ? " skeleton--title" : index === lines - 1 ? " skeleton--short" : "";
    return `<span class="skeleton${modifier}"></span>`;
  }).join("");
  return `<div class="card__body" id="${id}" aria-busy="true"><span class="sr-only">Loading repository status.</span><div class="skeleton-stack" aria-hidden="true">${skeletons}</div></div>`;
}

function applicationRail(
  project: { id: string; name: string },
  app: RegisteredApp,
  runtime: string,
  settingsHref: string,
  pending: boolean,
): string {
  return `<section class="card" aria-labelledby="application-card-title">
    <div class="card__head"><h2 class="card__title" id="application-card-title">Application</h2></div>
    <div class="card__body stack--tight">
      <div class="cluster">${runtime}<span class="badge badge--mono">${escapeHtml(app.kind ?? "app")}</span>${pending ? '<span class="badge badge-warning">Restart required</span>' : ""}</div>
      <div class="stack--tight"><span class="overline">Project</span><a class="small" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a></div>
      <div class="stack--tight"><span class="overline">Path</span><span class="mono">${escapeHtml(app.path)}</span></div>
      <div class="stack--tight"><span class="overline">Settings</span><a class="small" href="${escapeHtml(settingsHref)}">Application settings</a></div>
    </div>
  </section>`;
}

/** Render the application page shell; repository state is hydrated by assets/git.js. */
export function renderApplication(
  site: SiteModel,
  projectId: string,
  appKey: string,
  chrome: PageChrome,
): string | undefined {
  const project = site.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return undefined;
  }
  const app = project.apps.find((candidate) => candidate.appKey === appKey);
  if (app === undefined) {
    return undefined;
  }

  const runtime = site.runtime.get(app.id) ?? "stopped";
  const pending = site.pendingRestart.get(app.id) ?? false;
  const folder = appDir(project, app);
  const chatHref = `/chat?app=${encodeURIComponent(app.appKey)}&project=${encodeURIComponent(project.id)}`;
  const settingsHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/settings`;
  const apiBase = `/api/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/git`;
  const ideHref = ideFolderUrl(folder);

  const header = pageHeader({
    overline: "Application",
    title: app.appKey,
    description: "Repository state, branch, and lightweight git actions for this application.",
    meta: [project.name, app.kind ?? "app", app.path],
    actions: `<a class="btn btn-secondary" href="${escapeHtml(settingsHref)}">${icon("settings")}Settings</a><a class="btn btn-secondary" href="${escapeHtml(chatHref)}">${icon("message")}Open chat</a><a class="btn btn-secondary" href="${escapeHtml(ideHref)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a>`,
  });

  const pendingBanner = pending
    ? `<section class="card section" id="settings-pending" aria-labelledby="settings-pending-title">
        <div class="card__body cluster">
          <span class="badge badge-warning">Restart required</span>
          <div class="stack--tight"><h2 class="card__title" id="settings-pending-title">Settings changed</h2><p class="small">The agent is running with older settings. Restart it to apply the new model, auth, or web tools.</p></div>
          <form method="post" action="/api/apps/${encodeURIComponent(app.appKey)}/restart?project=${encodeURIComponent(project.id)}">
            <input type="hidden" name="return_to" value="${escapeHtml(`/projects/${project.id}/apps/${app.appKey}`)}" />
            <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
          </form>
        </div>
      </section>`
    : "";

  const body = `${pendingBanner}<div id="git-panel" data-project-id="${escapeHtml(project.id)}" data-app-key="${escapeHtml(app.appKey)}" data-api-base="${escapeHtml(apiBase)}">
    <p id="git-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
    <div class="workbench-grid workbench-grid--detail section">
      <div class="stack">
        <section class="card" id="repository-card" aria-labelledby="repository-title">
          <div class="card__head">
            <h2 class="card__title" id="repository-title">Repository</h2>
            <div class="cluster">
              <span class="mono" id="git-refreshed">Loading status</span>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" id="git-refresh" aria-label="Refresh repository status" title="Refresh repository status">${icon("refresh")}</button>
            </div>
          </div>
          ${loadingBody("git-repository-body", 5)}
        </section>
        <section class="card" id="changes-card" aria-labelledby="changes-title">
          <div class="card__head">
            <h2 class="card__title" id="changes-title">Changes</h2>
            <div class="cluster" id="git-change-counts"></div>
          </div>
          ${loadingBody("git-changes-body", 4)}
        </section>
      </div>
      <aside class="rail-stack" aria-label="Application details">
        ${applicationRail(project, app, runtimePill(runtime), settingsHref, pending)}
        <section class="card" aria-labelledby="remotes-title">
          <div class="card__head"><h2 class="card__title" id="remotes-title">Remotes</h2></div>
          ${loadingBody("git-remotes-body", 3)}
        </section>
        <section class="card" aria-labelledby="last-commit-title">
          <div class="card__head"><h2 class="card__title" id="last-commit-title">Last commit</h2></div>
          ${loadingBody("git-last-commit-body", 3)}
        </section>
      </aside>
    </div>
    <noscript>
      <p class="small">Git actions need JavaScript. Use the IDE for repository operations. <a class="btn btn-ghost btn-sm" href="${escapeHtml(ideHref)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a></p>
    </noscript>
  </div>`;

  return appShell({
    title: `${app.appKey} application`,
    active: "project",
    activeProjectId: project.id,
    breadcrumb: [
      { label: "Projects", href: "/projects" },
      { label: project.name, href: `/projects/${encodeURIComponent(project.id)}` },
      { label: app.appKey },
    ],
    projects: navProjects(site),
    pendingCount: site.pendingCount,
    operatorName: chrome.operatorName,
    notice: chrome.notice,
    header,
    scripts: ["/assets/git.js"],
    body,
  });
}
