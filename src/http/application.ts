import { isMasterApp } from "../master/constants.js";
import type { RegisteredApp } from "../registry/index.js";
import { appDir } from "./apps.js";
import type { PageChrome, SiteModel } from "./dashboard.js";
import {
  appShell,
  deletionStatus,
  escapeHtml,
  type IconName,
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

interface ImageState {
  label: string;
  state: string;
  glyph: IconName;
  action: string;
  hint: string;
}

const IMAGE_STATES: Record<RegisteredApp["imageStatus"], ImageState> = {
  missing: {
    label: "Not built",
    state: "queued",
    glyph: "clock",
    action: "Build image",
    hint: "No app image has been built. Build it before starting the agent.",
  },
  building: {
    label: "Building",
    state: "in_progress",
    glyph: "loader",
    action: "Building…",
    hint: "The runner is building this image. The previous image remains in use.",
  },
  ready: {
    label: "Built",
    state: "delivered",
    glyph: "check",
    action: "Rebuild image",
    hint: "The image matches the current Dockerfile and default base.",
  },
  stale: {
    label: "Out of date",
    state: "expired",
    glyph: "hourglass",
    action: "Rebuild image",
    hint: "The Dockerfile or default base changed. The running agent keeps the old image until you rebuild and restart.",
  },
  error: {
    label: "Build failed",
    state: "failed",
    glyph: "alert-triangle",
    action: "Retry build",
    hint: "The last build failed. The previous image is kept.",
  },
};

function imageHrefs(
  projectId: string,
  appKey: string,
): {
  appHref: string;
  buildHref: string;
  rollbackHref: string;
  imageUrl: string;
  logsUrl: string;
  runtimeUrl: string;
} {
  const key = encodeURIComponent(appKey);
  const project = encodeURIComponent(projectId);
  return {
    appHref: `/projects/${project}/apps/${key}`,
    buildHref: `/api/apps/${key}/build?project=${project}`,
    rollbackHref: `/api/apps/${key}/image/rollback?project=${project}`,
    imageUrl: `/api/apps/${key}/image?project=${project}`,
    logsUrl: `/api/apps/${key}/image/logs?project=${project}`,
    runtimeUrl: `/api/apps/${key}/runtime?project=${project}`,
  };
}

function imagePanel(
  project: { id: string },
  app: RegisteredApp,
  runtime: string,
  deletionPending: boolean,
): string {
  const status = IMAGE_STATES[app.imageStatus] ?? IMAGE_STATES.missing;
  const hrefs = imageHrefs(project.id, app.appKey);
  const building = app.imageStatus === "building";
  const disabled = building ? ' disabled aria-busy="true"' : deletionPending ? " disabled" : "";
  const rollbackRef = app.imageRollbackRef ?? null;
  const rollbackBuilt = app.imageRollbackBuiltAt ?? null;
  const activeRuntime = runtime === "running" || runtime === "starting";
  const rollbackAction = activeRuntime ? "Roll back and restart" : "Roll back image";
  const rollbackBody = activeRuntime
    ? `This replaces the current image with <span class="mono" id="image-rollback-dialog-ref">${escapeHtml(rollbackRef ?? "no previous image")}</span> and restarts the agent. An active turn will be interrupted.`
    : `This replaces the current image with <span class="mono" id="image-rollback-dialog-ref">${escapeHtml(rollbackRef ?? "no previous image")}</span>.`;
  const error = app.imageError
    ? `<p class="field-error" id="image-error" role="alert">${escapeHtml(app.imageError)}</p>`
    : '<p class="field-error" id="image-error" role="alert" hidden></p>';
  const rollbackForm = `<form method="post" action="${escapeHtml(hrefs.rollbackHref)}" id="image-rollback-form"${rollbackRef === null ? " hidden" : ""}>
          <input type="hidden" name="return_to" value="${escapeHtml(hrefs.appHref)}" />
          <button class="btn btn-secondary btn-sm" type="button" id="image-rollback" data-dialog-open="image-rollback-dialog"${building || deletionPending ? " disabled" : ""}>${icon("refresh")}<span class="btn__label">${escapeHtml(rollbackAction)}</span></button>
        </form>`;
  return `<section class="card" id="image-panel"
      data-project-id="${escapeHtml(project.id)}"
      data-app-key="${escapeHtml(app.appKey)}"
      data-status="${escapeHtml(app.imageStatus)}"
      data-image-ref="${escapeHtml(app.imageRef ?? "")}"
      data-image-url="${escapeHtml(hrefs.imageUrl)}"
      data-logs-url="${escapeHtml(hrefs.logsUrl)}"
      data-runtime-url="${escapeHtml(hrefs.runtimeUrl)}">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <div class="cluster">
        <span class="status" id="image-status" data-status="${escapeHtml(app.imageStatus)}" data-state="${status.state}">${icon(status.glyph)}${escapeHtml(status.label)}</span>
        <button class="btn btn-ghost btn-icon btn-sm" id="image-refresh" type="button" aria-label="Refresh image status" title="Refresh image status">${icon("refresh")}</button>
      </div>
    </div>
    <div class="card__body stack--tight">
      <p class="sr-only" id="image-live" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="cluster">
        <form method="post" action="${escapeHtml(hrefs.buildHref)}">
          <input type="hidden" name="return_to" value="${escapeHtml(hrefs.appHref)}" />
          <button class="btn btn-secondary btn-sm" type="submit" id="image-build" data-action-label="${escapeHtml(status.action)}"${disabled}>${icon("layers")}<span class="btn__label">${escapeHtml(status.action)}</span></button>
        </form>
      </div>
      <p class="mono" id="image-ref">${escapeHtml(app.imageRef ?? "Not built")}</p>
      <p class="small" id="image-hint">${escapeHtml(status.hint)}</p>
      <p class="small" id="image-notice" hidden>Restart the agent to use the new image.</p>
      ${error}
      <details class="disclosure" id="image-details">
        <summary>Image details${icon("chevron-down", "disclosure__chevron")}</summary>
        <div class="stack--tight">
          <div class="summary-row"><span class="overline">Built</span><span id="image-built" data-built-at="${escapeHtml(app.imageBuiltAt ?? "")}">${app.imageBuiltAt ? timeTag(app.imageBuiltAt) : "Never"}</span></div>
          <div class="summary-row"${rollbackRef === null ? " hidden" : ""}><span class="overline">Previous</span><span class="mono" id="image-rollback-ref">${escapeHtml(rollbackRef ?? "None")}</span></div>
          <div class="summary-row"${rollbackRef === null ? " hidden" : ""}><span class="overline">Previous built</span><span id="image-rollback-built" data-built-at="${escapeHtml(rollbackBuilt ?? "")}"${rollbackRef === null ? " hidden" : ""}>${rollbackBuilt === null ? "" : timeTag(rollbackBuilt)}</span></div>
          ${rollbackForm}
          <details class="disclosure" id="image-logs-details">
            <summary>Build logs${icon("chevron-down", "disclosure__chevron")}</summary>
            <pre class="mono image-logs" id="image-logs">No build logs yet.</pre>
          </details>
        </div>
      </details>
    </div>
    <dialog class="dialog" id="image-rollback-dialog" aria-labelledby="image-rollback-dialog-title">
      <div class="dialog__frame">
        <header class="dialog__head"><h2 class="dialog__title" id="image-rollback-dialog-title">Roll back image?</h2></header>
        <form method="post" action="${escapeHtml(hrefs.rollbackHref)}">
          <div class="dialog__body">
            <p class="body">${rollbackBody}</p>
            <input type="hidden" name="return_to" value="${escapeHtml(hrefs.appHref)}" />
          </div>
          <footer class="dialog__foot">
            <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
            <button class="btn btn-primary" type="submit" id="image-rollback-confirm">${escapeHtml(rollbackAction)}</button>
          </footer>
        </form>
      </div>
    </dialog>
  </section>`;
}

function defaultImagePanel(project: { id: string }, app: RegisteredApp, ideHref: string): string {
  const hrefs = imageHrefs(project.id, app.appKey);
  return `<section class="card" id="image-panel"
      data-project-id="${escapeHtml(project.id)}"
      data-app-key="${escapeHtml(app.appKey)}"
      data-status="default"
      data-runtime-url="${escapeHtml(hrefs.runtimeUrl)}">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <span class="status" id="image-status" data-status="default" data-state="cancelled">${icon("layers")}Default image</span>
    </div>
    <div class="card__body stack--tight">
      <p class="sr-only" id="image-live" role="status" aria-live="polite" aria-atomic="true"></p>
      <p class="small" id="image-hint">This application uses the shared default agent image.</p>
      <p class="small">Add .hanse/Dockerfile to build a custom image for this application.</p>
      <p class="mono" id="image-ref">Default agent image</p>
      <div class="cluster"><a class="btn btn-ghost btn-sm" href="${escapeHtml(ideHref)}" target="_blank" rel="noreferrer">${icon("external")}Open application folder</a></div>
    </div>
  </section>`;
}

function settingsState(
  pending: boolean,
  reasons: string[],
  runtimeConfigured: boolean,
  runtime: string,
  settingsHref: string,
): string {
  if (pending) {
    const unknown = reasons.includes("applied_state_unknown");
    const copy = unknown
      ? "The coordinator cannot confirm which settings this running agent loaded."
      : "The agent is running with older settings.";
    return `<div class="state-strip__value"><span class="status" data-state="awaiting_approval">${icon("stamp")}Restart required</span></div><p class="small">${copy}</p>`;
  }
  if (!runtimeConfigured) {
    return `<div class="state-strip__value"><span class="status" data-state="cancelled">${icon("slash")}Unavailable</span></div><p class="small">The agent runtime is not configured.</p><div class="state-strip__actions"><a class="btn btn-ghost btn-sm" href="${escapeHtml(settingsHref)}">Review settings</a></div>`;
  }
  if (runtime === "stopped" || runtime === "error") {
    return `<div class="state-strip__value"><span class="status" data-state="queued">${icon("clock")}Saved</span></div><p class="small">Settings apply when the agent starts.</p><div class="state-strip__actions"><a class="btn btn-ghost btn-sm" href="${escapeHtml(settingsHref)}">Review settings</a></div>`;
  }
  return `<div class="state-strip__value"><span class="status" data-state="delivered">${icon("check")}Applied</span></div><p class="small">Settings match the running agent.</p><div class="state-strip__actions"><a class="btn btn-ghost btn-sm" href="${escapeHtml(settingsHref)}">Review settings</a></div>`;
}

function applicationDeleteDialog(projectId: string, appKey: string, retrying: boolean): string {
  const appHref = `/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appKey)}`;
  return `<dialog class="dialog" id="application-delete-dialog" aria-labelledby="application-delete-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="application-delete-title">${retrying ? "Retry application deletion?" : "Delete application?"}</h2>
        <p class="dialog__meta">${escapeHtml(appKey)} / ${escapeHtml(projectId)}</p>
      </header>
      <form class="dialog__form" method="post" action="/api/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appKey)}/delete">
        <div class="dialog__body">
          <p class="body">This removes the application, including its sessions, handoffs, credentials, and managed images. Checking <strong>Delete files too</strong> also deletes the application source files on disk.</p>
          <div class="field">
            <label class="label" for="application-delete-confirm">Type ${escapeHtml(appKey)} to confirm (required)</label>
            <input class="input" id="application-delete-confirm" name="confirm" required autocomplete="off" spellcheck="false" aria-describedby="application-delete-confirm-hint" />
            <p class="hint" id="application-delete-confirm-hint">The application key must match exactly.</p>
          </div>
          <label class="check">
            <input class="checkbox" type="checkbox" name="deleteFiles" value="true" />
            <span>Delete files too</span>
          </label>
          <input type="hidden" name="return_to" value="${escapeHtml(appHref)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-danger" type="submit">${retrying ? "Retry deletion" : "Delete application"}</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function applicationProjectDeleteDialog(
  projectId: string,
  projectName: string,
  appHref: string,
): string {
  return `<dialog class="dialog" id="project-delete-dialog" aria-labelledby="project-delete-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="project-delete-title">Retry project deletion?</h2>
        <p class="dialog__meta">${escapeHtml(projectName)} / ${escapeHtml(projectId)}</p>
      </header>
      <form class="dialog__form" method="post" action="/api/projects/${encodeURIComponent(projectId)}/delete">
        <div class="dialog__body">
          <p class="body">This removes every application in the project, including their sessions, handoffs, credentials, and managed images. Checking <strong>Delete files too</strong> also deletes the project and application source files on disk.</p>
          <div class="field">
            <label class="label" for="project-delete-confirm">Type ${escapeHtml(projectName)} to confirm (required)</label>
            <input class="input" id="project-delete-confirm" name="confirm" required autocomplete="off" spellcheck="false" aria-describedby="project-delete-confirm-hint" />
            <p class="hint" id="project-delete-confirm-hint">The project name must match exactly.</p>
          </div>
          <label class="check">
            <input class="checkbox" type="checkbox" name="deleteFiles" value="true" />
            <span>Delete files too</span>
          </label>
          <input type="hidden" name="return_to" value="${escapeHtml(appHref)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-danger" type="submit">Retry deletion</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

/** Render the application page shell; repository state is hydrated by assets/git.js. */
export function renderApplication(
  site: SiteModel,
  projectId: string,
  appKey: string,
  chrome: PageChrome,
  runtimeConfigured = false,
): string | undefined {
  const project = site.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return undefined;
  }
  const app = project.apps.find((candidate) => candidate.appKey === appKey);
  if (app === undefined) {
    return undefined;
  }

  const master = isMasterApp(project.id, app.appKey);
  const runtime = site.runtime.get(app.id) ?? "stopped";
  const appDeleting = app.deleting;
  const projectDeleting = project.deleting === true;
  const deletionPending = appDeleting || projectDeleting;
  const pending = site.pendingRestart.get(app.id) ?? false;
  const pendingReasons = site.pendingRestartReasons.get(app.id) ?? [];
  const folder = appDir(project, app);
  const chatHref = `/chat?app=${encodeURIComponent(app.appKey)}&project=${encodeURIComponent(project.id)}`;
  const settingsHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/settings`;
  const apiBase = `/api/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/git`;
  const ideHref = ideFolderUrl(folder);
  const terminalHref = `/terminal?app=${encodeURIComponent(app.appKey)}&project=${encodeURIComponent(project.id)}`;
  const sshHref = `/ssh?project=${encodeURIComponent(project.id)}&app=${encodeURIComponent(app.appKey)}`;
  const sshHosts = site.sshHostsByApp.get(app.id) ?? 0;
  const sshPending = site.sshPendingByApp.get(app.id) ?? 0;
  const appHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}`;
  const canRestart = !deletionPending && (runtime === "running" || runtime === "starting");

  const menu = `<details class="menu">
        <summary class="btn btn-ghost btn-icon" aria-label="More actions" title="More actions">${icon("more")}</summary>
        <nav class="menu__panel" aria-label="More actions">
          <a class="menu__item" href="${escapeHtml(ideHref)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE in this folder</a>
          <a class="menu__item" href="${escapeHtml(settingsHref)}">${icon("settings")}Application settings</a>
        </nav>
      </details>`;
  const appActions = deletionPending
    ? menu
    : `<a class="btn btn-secondary" href="${escapeHtml(chatHref)}">${icon("message")}Open chat</a><a class="btn btn-secondary" href="${escapeHtml(terminalHref)}">${icon("terminal")}Terminal</a>${menu}`;

  const header = pageHeader({
    overline: "Application",
    title: app.appKey,
    description: master
      ? "Built-in Hanse assistant. Configure it like an agent; workspace work goes through its tools."
      : "Repository state and lightweight git actions for this application.",
    meta: [project.name, app.kind ?? "app", master ? folder : app.path],
    actions: appActions,
  });

  const restartDialog = canRestart
    ? `<dialog class="dialog" id="app-restart-dialog" aria-labelledby="app-restart-dialog-title">
      <div class="dialog__frame">
        <header class="dialog__head"><h2 class="dialog__title" id="app-restart-dialog-title">Restart ${escapeHtml(app.appKey)}?</h2></header>
        <form method="post" action="/api/apps/${encodeURIComponent(app.appKey)}/restart?project=${encodeURIComponent(project.id)}">
          <div class="dialog__body">
            <p class="body">An active turn will be interrupted. Sessions are kept.</p>
            <input type="hidden" name="return_to" value="${escapeHtml(appHref)}" />
          </div>
          <footer class="dialog__foot">
            <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
            <button class="btn btn-primary" type="submit">Restart agent</button>
          </footer>
        </form>
      </div>
    </dialog>`
    : "";

  const stateStrip = `<section class="state-strip" id="app-state" aria-label="Application state">
    <div class="state-strip__cell" id="runtime-state">
      <span class="state-strip__label">Runtime</span>
      <div class="state-strip__value">${runtimePill(runtime)}</div>
      <div class="state-strip__actions" id="runtime-actions">${
        canRestart
          ? `<form id="runtime-restart"><button class="btn btn-secondary btn-sm" type="button" data-dialog-open="app-restart-dialog">${icon("refresh")}Restart agent</button></form>`
          : ""
      }</div>
    </div>
    <div class="state-strip__cell" id="settings-state">
      <span class="state-strip__label">Settings</span>
      ${settingsState(pending, pendingReasons, runtimeConfigured, runtime, settingsHref)}
    </div>
  </section>${restartDialog}`;

  const image = app.buildConfigured
    ? imagePanel(project, app, runtime, deletionPending)
    : defaultImagePanel(project, app, ideHref);
  const sshPendingCopy =
    sshPending > 0
      ? `<span class="status" data-state="awaiting_approval">${icon("stamp")}${sshPending} pending ${sshPending === 1 ? "approval" : "approvals"}</span>`
      : '<p class="small">No pending approvals.</p>';
  const sshPanel = `<section class="card" id="ssh-panel" aria-labelledby="ssh-panel-title">
    <div class="card__head"><h2 class="card__title" id="ssh-panel-title">SSH access</h2><a class="btn btn-ghost btn-sm" href="${escapeHtml(sshHref)}">${icon("terminal")}Manage</a></div>
    <div class="card__body stack--tight">
      <p class="small">${sshHosts} allowed ${sshHosts === 1 ? "host" : "hosts"}</p>
      ${sshPendingCopy}
    </div>
  </section>`;
  const deletionBanner = deletionPending
    ? `<div class="error-state section" id="deletion-banner" role="alert">
      <span class="error-state__mark">${icon("alert-triangle", "icon--lg")}</span>
      <div>
        <h3 class="error-state__title">${projectDeleting ? "Project deletion incomplete" : "Deletion incomplete"}</h3>
        <p class="error-state__body">${projectDeleting ? "This project is marked for deletion. Chat, terminal, and start actions stay disabled until the deletion completes." : "This application is marked for deletion. Chat, terminal, and start actions stay disabled until the deletion completes."}</p>
      </div>
    </div>`
    : "";

  const dangerZone = `<section class="card section" id="danger-zone" aria-labelledby="danger-zone-title">
    <div class="card__head">
      <h2 class="card__title" id="danger-zone-title">Danger zone</h2>
      ${projectDeleting ? deletionStatus("Project deletion incomplete") : appDeleting ? deletionStatus() : '<span class="badge">Destructive</span>'}
    </div>
    <div class="card__body stack--tight">
      ${
        projectDeleting
          ? `<p class="small">A previous project deletion did not finish. Retry to remove the remaining applications, records, and runtime resources.</p>`
          : appDeleting
            ? `<p class="small">A previous deletion did not finish. Retry to remove the remaining application records and runtime resources.</p>`
            : `<p class="small">Deleting this application removes its sessions, handoffs, credentials, and managed images. Source files are kept unless you choose to delete them too.</p>`
      }
    </div>
    <div class="card__foot">
      <button class="btn btn-danger" type="button" data-dialog-open="${projectDeleting ? "project-delete-dialog" : "application-delete-dialog"}">${icon("trash")}${deletionPending ? "Retry deletion" : "Delete application"}</button>
    </div>
  </section>`;

  const deleteDialogs = projectDeleting
    ? applicationProjectDeleteDialog(project.id, project.name, appHref)
    : applicationDeleteDialog(project.id, app.appKey, appDeleting);

  const masterBody = `${stateStrip}<section class="card section" id="master-panel" aria-labelledby="master-panel-title">
    <div class="card__head"><h2 class="card__title" id="master-panel-title">Master workspace</h2><span class="badge badge--mono">system</span></div>
    <div class="card__body stack--tight">
      <div class="stack--tight"><span class="overline">Directory</span><span class="mono">${escapeHtml(folder)}</span></div>
      <p class="small">The master's directory is coordinator-managed and read-only inside its container. Its instructions are rewritten on every coordinator start.</p>
      <p class="small">Workspace changes go through the master's Hanse tools. Skills can be created, inspected, updated, enabled/disabled, and overridden from the master chat; deleting or renaming them remains operator-only. Provider keys, git credentials, image builds, and project deletion are operator-only UI actions.</p>
    </div>
    <div class="card__foot"><a class="btn btn-secondary btn-sm" href="${escapeHtml(settingsHref)}">${icon("settings")}Application settings</a><a class="btn btn-ghost btn-sm" href="${escapeHtml(`/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/skills`)}">${icon("code")}Skills</a></div>
  </section>`;
  const body = master
    ? masterBody
    : `${stateStrip}${deletionBanner}<div id="git-panel" data-project-id="${escapeHtml(project.id)}" data-app-key="${escapeHtml(app.appKey)}" data-api-base="${escapeHtml(apiBase)}">
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
        ${image}
        ${sshPanel}
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
  </div>${dangerZone}${deleteDialogs}`;

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
    sshPendingCount: site.sshPendingCount,
    operatorName: chrome.operatorName,
    notice: chrome.notice,
    header,
    scripts: master ? [] : ["/assets/git.js", "/assets/images.js"],
    body,
    settingsHref,
    skillsHref: `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/skills`,
  });
}
