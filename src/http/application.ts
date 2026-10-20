import type { RegisteredApp } from "../registry/index.js";
import { appDir } from "./apps.js";
import type { PageChrome, SiteModel } from "./dashboard.js";
import {
  appShell,
  escapeHtml,
  icon,
  ideFolderUrl,
  pageHeader,
  runtimePill,
  timeTag,
} from "./ui.js";

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

const IMAGE_STATUS: Record<
  RegisteredApp["imageStatus"],
  { label: string; tone: string; action: string; hint: string }
> = {
  missing: {
    label: "Missing",
    tone: "badge-ghost",
    action: "Build image",
    hint: "No app image has been built. Build it before starting the agent.",
  },
  building: {
    label: "Building",
    tone: "badge-info",
    action: "Building...",
    hint: "The runner is building this image. The previous image remains in use.",
  },
  ready: {
    label: "Ready",
    tone: "badge-success",
    action: "Rebuild image",
    hint: "The image matches the current Dockerfile and default base.",
  },
  stale: {
    label: "Stale",
    tone: "badge-warning",
    action: "Rebuild image",
    hint: "The Dockerfile or default base changed. The running container keeps the old image until you rebuild.",
  },
  error: {
    label: "Error",
    tone: "badge-error",
    action: "Retry build",
    hint: "The last build failed. Review the logs and retry; the previous image is kept.",
  },
};

function imagePanel(
  project: { id: string },
  app: RegisteredApp,
  imageStatus: RegisteredApp["imageStatus"],
): string {
  const status = IMAGE_STATUS[imageStatus] ?? IMAGE_STATUS.missing;
  const buildHref = `/api/apps/${encodeURIComponent(app.appKey)}/build?project=${encodeURIComponent(project.id)}`;
  const rollbackHref = `/api/apps/${encodeURIComponent(app.appKey)}/image/rollback?project=${encodeURIComponent(project.id)}`;
  const imageUrl = `/api/apps/${encodeURIComponent(app.appKey)}/image?project=${encodeURIComponent(project.id)}`;
  const logsUrl = `/api/apps/${encodeURIComponent(app.appKey)}/image/logs?project=${encodeURIComponent(project.id)}`;
  const appHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}`;
  const disabled = imageStatus === "building" ? " disabled" : "";
  const rollbackRef = app.imageRollbackRef ?? null;
  const rollbackBuilt = app.imageRollbackBuiltAt ?? null;
  const error = app.imageError
    ? `<p class="small" id="image-error">${escapeHtml(app.imageError)}</p>`
    : '<p class="small" id="image-error" hidden></p>';
  return `<section class="card section" id="image-panel"
      data-project-id="${escapeHtml(project.id)}"
      data-app-key="${escapeHtml(app.appKey)}"
      data-status="${escapeHtml(imageStatus)}"
      data-image-url="${escapeHtml(imageUrl)}"
      data-logs-url="${escapeHtml(logsUrl)}">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <div class="cluster">
        <span class="badge ${status.tone}" id="image-status" data-status="${escapeHtml(imageStatus)}" role="status" aria-live="polite">${escapeHtml(status.label)}</span>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" id="image-refresh" aria-label="Refresh image status" title="Refresh image status">${icon("refresh")}</button>
      </div>
    </div>
    <div class="card__body stack--tight">
      <p class="sr-only" id="image-live" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="cluster">
        <form method="post" action="${escapeHtml(buildHref)}">
          <input type="hidden" name="return_to" value="${escapeHtml(appHref)}" />
          <button class="btn btn-primary btn-sm" type="submit" id="image-build" data-action-label="${escapeHtml(status.action)}"${disabled}>${icon("layers")}${escapeHtml(status.action)}</button>
        </form>
        <span class="small" id="image-hint">${escapeHtml(status.hint)}</span>
      </div>
      <div class="stack--tight"><span class="overline">Reference</span><span class="mono" id="image-ref">${escapeHtml(app.imageRef ?? "Not built")}</span></div>
      <div class="stack--tight"><span class="overline">Built</span><span class="small" id="image-built" data-built-at="${escapeHtml(app.imageBuiltAt ?? "")}">${app.imageBuiltAt ? timeTag(app.imageBuiltAt) : "Never"}</span></div>
      <div class="stack--tight"><span class="overline">Rollback</span><span class="mono" id="image-rollback-ref">${escapeHtml(rollbackRef ?? "None")}</span><span class="small" id="image-rollback-built" data-built-at="${escapeHtml(rollbackBuilt ?? "")}"${rollbackRef === null ? " hidden" : ""}>${rollbackBuilt ? timeTag(rollbackBuilt) : ""}</span></div>
      <form method="post" action="${escapeHtml(rollbackHref)}" id="image-rollback-form"${rollbackRef === null ? " hidden" : ""}>
        <input type="hidden" name="return_to" value="${escapeHtml(appHref)}" />
        <button class="btn btn-secondary btn-sm" type="submit" id="image-rollback">${icon("refresh")}Roll back to previous image</button>
      </form>
      ${error}
      <div class="stack--tight">
        <div class="cluster">
          <span class="overline">Build logs</span>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" id="image-logs-refresh" aria-label="Refresh build logs" title="Refresh build logs">${icon("refresh")}</button>
        </div>
        <pre class="mono prose--pre image-logs" id="image-logs" aria-live="polite">No build logs yet.</pre>
      </div>
    </div>
  </section>`;
}

function defaultImagePanel(project: { id: string }, app: RegisteredApp): string {
  return `<section class="card section" id="image-panel"
      data-project-id="${escapeHtml(project.id)}"
      data-app-key="${escapeHtml(app.appKey)}"
      data-status="default">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <span class="badge badge-ghost" id="image-status" data-status="default" role="status">Default</span>
    </div>
    <div class="card__body stack--tight">
      <p class="small" id="image-hint">This application uses the shared default agent image. Add a per-app Dockerfile build configuration to use a custom image.</p>
      <div class="stack--tight"><span class="overline">Agent image</span><span class="mono" id="image-ref">Default agent image</span></div>
    </div>
  </section>`;
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
  const terminalHref = `/terminal?app=${encodeURIComponent(app.appKey)}&project=${encodeURIComponent(project.id)}`;

  const header = pageHeader({
    overline: "Application",
    title: app.appKey,
    description: "Repository state, branch, and lightweight git actions for this application.",
    meta: [project.name, app.kind ?? "app", app.path],
    actions: `<a class="btn btn-secondary" href="${escapeHtml(terminalHref)}">${icon("terminal")}Terminal</a><a class="btn btn-secondary" href="${escapeHtml(settingsHref)}">${icon("settings")}Settings</a><a class="btn btn-secondary" href="${escapeHtml(chatHref)}">${icon("message")}Open chat</a><a class="btn btn-secondary" href="${escapeHtml(ideHref)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a>`,
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

  const image = app.buildConfigured
    ? imagePanel(project, app, app.imageStatus)
    : defaultImagePanel(project, app);
  const body = `${pendingBanner}${image}<div id="git-panel" data-project-id="${escapeHtml(project.id)}" data-app-key="${escapeHtml(app.appKey)}" data-api-base="${escapeHtml(apiBase)}">
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
    scripts: ["/assets/git.js", "/assets/images.js"],
    body,
  });
}
