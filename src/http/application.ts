import type { PageChrome, SiteModel } from "./dashboard.js";
import {
  type AppDeleteProps,
  type AppImageProps,
  type AppSettingsProps,
  buildAppProps,
} from "./props/app.js";
import {
  appShell,
  deletionStatus,
  escapeHtml,
  icon,
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

function imagePanel(image: AppImageProps, deletionPending: boolean): string {
  const hrefs = image.hrefs;
  const disabled = image.building
    ? ' disabled aria-busy="true"'
    : deletionPending
      ? " disabled"
      : "";
  const rollbackRef = image.rollback.ref;
  const rollbackBuilt = image.rollback.builtAt;
  const rollbackAction = image.rollback.action;
  const rollbackTarget = escapeHtml(rollbackRef ?? "no previous image");
  const rollbackBody = image.rollback.restart
    ? `This replaces the current image with <span class="mono" id="image-rollback-dialog-ref">${rollbackTarget}</span> and restarts the agent. An active turn will be interrupted.`
    : `This replaces the current image with <span class="mono" id="image-rollback-dialog-ref">${rollbackTarget}</span>.`;
  const error = image.error
    ? `<p class="field-error" id="image-error" role="alert">${escapeHtml(image.error)}</p>`
    : '<p class="field-error" id="image-error" role="alert" hidden></p>';
  const baseRef = image.base.ref ?? "—";
  const baseDigest = image.base.digest ?? "—";
  const rollbackForm = `<form method="post" action="${escapeHtml(hrefs.rollback)}" id="image-rollback-form"${image.rollback.available ? "" : " hidden"}>
          <input type="hidden" name="return_to" value="${escapeHtml(hrefs.app)}" />
          <button class="btn btn-secondary btn-sm" type="button" id="image-rollback" data-dialog-open="image-rollback-dialog"${image.rollbackDisabled ? " disabled" : ""}>${icon("refresh")}<span class="btn__label">${escapeHtml(rollbackAction)}</span></button>
        </form>`;
  return `<section class="card" id="image-panel"
      data-project-id="${escapeHtml(image.projectId)}"
      data-app-key="${escapeHtml(image.appKey)}"
      data-status="${escapeHtml(image.status)}"
      data-image-ref="${escapeHtml(image.ref ?? "")}"
      data-image-url="${escapeHtml(hrefs.image)}"
      data-logs-url="${escapeHtml(hrefs.logs)}"
      data-runtime-url="${escapeHtml(hrefs.runtime)}">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <div class="cluster">
        <span class="status" id="image-status" data-status="${escapeHtml(image.status)}" data-state="${escapeHtml(image.state)}">${icon(image.glyph)}${escapeHtml(image.label)}</span>
        <button class="btn btn-ghost btn-icon btn-sm" id="image-refresh" type="button" aria-label="Refresh image status" title="Refresh image status">${icon("refresh")}</button>
      </div>
    </div>
    <div class="card__body stack--tight">
      <p class="sr-only" id="image-live" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="cluster">
        <form method="post" action="${escapeHtml(hrefs.build)}">
          <input type="hidden" name="return_to" value="${escapeHtml(hrefs.app)}" />
          <button class="btn btn-secondary btn-sm" type="submit" id="image-build" data-action-label="${escapeHtml(image.action)}"${disabled}>${icon("layers")}<span class="btn__label">${escapeHtml(image.action)}</span></button>
        </form>
      </div>
      <p class="mono" id="image-ref">${escapeHtml(image.ref ?? "Not built")}</p>
      <p class="small" id="image-hint">${escapeHtml(image.hint)}</p>
      <p class="small" id="image-notice" hidden>Restart the agent to use the new image.</p>
      ${error}
      <details class="disclosure" id="image-details">
        <summary>Image details${icon("chevron-down", "disclosure__chevron")}</summary>
        <div class="stack--tight">
          <div class="summary-row"><span class="overline">Built</span><span id="image-built" data-built-at="${escapeHtml(image.builtAt ?? "")}">${image.builtAt ? timeTag(image.builtAt) : "Never"}</span></div>
          <div class="summary-row"><span class="overline">Base</span><span id="image-base-kind">${escapeHtml(image.base.kindLabel)}</span></div>
          <div class="summary-row"><span class="overline">Base ref</span><span class="mono" id="image-base-ref">${escapeHtml(baseRef)}</span></div>
          <div class="summary-row"><span class="overline">Base digest</span><span class="mono" id="image-base-digest">${escapeHtml(baseDigest)}</span></div>
          <div class="summary-row"${image.rollback.available ? "" : " hidden"}><span class="overline">Previous</span><span class="mono" id="image-rollback-ref">${escapeHtml(rollbackRef ?? "None")}</span></div>
          <div class="summary-row"${image.rollback.available ? "" : " hidden"}><span class="overline">Previous built</span><span id="image-rollback-built" data-built-at="${escapeHtml(rollbackBuilt ?? "")}"${image.rollback.available ? "" : " hidden"}>${rollbackBuilt === null ? "" : timeTag(rollbackBuilt)}</span></div>
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
        <form method="post" action="${escapeHtml(hrefs.rollback)}">
          <div class="dialog__body">
            <p class="body">${rollbackBody}</p>
            <input type="hidden" name="return_to" value="${escapeHtml(hrefs.app)}" />
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

function defaultImagePanel(
  image: AppImageProps,
  ideHref: string,
  deletionPending: boolean,
): string {
  const hrefs = image.hrefs;
  return `<section class="card" id="image-panel"
      data-project-id="${escapeHtml(image.projectId)}"
      data-app-key="${escapeHtml(image.appKey)}"
      data-status="default"
      data-image-url="${escapeHtml(hrefs.image)}"
      data-runtime-url="${escapeHtml(hrefs.runtime)}">
    <div class="card__head">
      <h2 class="card__title" id="image-title">Image</h2>
      <span class="status" id="image-status" data-status="default" data-state="cancelled">${icon("layers")}Default image</span>
    </div>
    <div class="card__body stack--tight">
      <p class="sr-only" id="image-live" role="status" aria-live="polite" aria-atomic="true"></p>
      <p class="small" id="image-hint">This application uses the shared default agent image.</p>
      <p class="small">Add .hanse/Dockerfile to build a custom image for this application.</p>
      <p class="mono" id="image-ref">Default agent image</p>
      <div class="cluster">
        <form method="post" action="${escapeHtml(hrefs.check)}" id="image-check-form">
          <button class="btn btn-secondary btn-sm" type="submit" id="image-check"${deletionPending ? " disabled" : ""}>${icon("refresh")}<span class="btn__label">Check for changes</span></button>
        </form>
        <a class="btn btn-ghost btn-sm" href="${escapeHtml(ideHref)}" target="_blank" rel="noreferrer">${icon("external")}Open application folder</a>
      </div>
    </div>
  </section>`;
}

function settingsState(settings: AppSettingsProps): string {
  const action =
    settings.actionLabel === null
      ? ""
      : `<div class="state-strip__actions"><a class="btn btn-ghost btn-sm" href="${escapeHtml(settings.href)}">${escapeHtml(settings.actionLabel)}</a></div>`;
  return `<div class="state-strip__value"><span class="status" data-state="${escapeHtml(settings.tone)}">${icon(settings.glyph)}${escapeHtml(settings.label)}</span></div><p class="small">${escapeHtml(settings.copy)}</p>${action}`;
}

function applicationDeleteDialog(
  remove: AppDeleteProps,
  appKey: string,
  projectId: string,
): string {
  return `<dialog class="dialog" id="application-delete-dialog" aria-labelledby="application-delete-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="application-delete-title">${remove.retrying ? "Retry application deletion?" : "Delete application?"}</h2>
        <p class="dialog__meta">${escapeHtml(appKey)} / ${escapeHtml(projectId)}</p>
      </header>
      <form class="dialog__form" method="post" action="${escapeHtml(remove.action)}">
        <div class="dialog__body">
          <p class="body">This removes the application, including its sessions, handoffs, credentials, and managed images. Checking <strong>Delete files too</strong> also deletes the application source files on disk.</p>
          <div class="field">
            <label class="label" for="application-delete-confirm">Type ${escapeHtml(remove.confirmName)} to confirm (required)</label>
            <input class="input" id="application-delete-confirm" name="confirm" required autocomplete="off" spellcheck="false" aria-describedby="application-delete-confirm-hint" />
            <p class="hint" id="application-delete-confirm-hint">The application key must match exactly.</p>
          </div>
          <label class="check">
            <input class="checkbox" type="checkbox" name="deleteFiles" value="true" />
            <span>Delete files too</span>
          </label>
          <input type="hidden" name="return_to" value="${escapeHtml(remove.returnTo)}" />
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-danger" type="submit">${remove.retrying ? "Retry deletion" : "Delete application"}</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function applicationProjectDeleteDialog(
  remove: AppDeleteProps,
  projectId: string,
  projectName: string,
): string {
  return `<dialog class="dialog" id="project-delete-dialog" aria-labelledby="project-delete-title">
    <div class="dialog__frame">
      <header class="dialog__head">
        <h2 class="dialog__title" id="project-delete-title">Retry project deletion?</h2>
        <p class="dialog__meta">${escapeHtml(projectName)} / ${escapeHtml(projectId)}</p>
      </header>
      <form class="dialog__form" method="post" action="${escapeHtml(remove.action)}">
        <div class="dialog__body">
          <p class="body">This removes every application in the project, including their sessions, handoffs, credentials, and managed images. Checking <strong>Delete files too</strong> also deletes the project and application source files on disk.</p>
          <div class="field">
            <label class="label" for="project-delete-confirm">Type ${escapeHtml(remove.confirmName)} to confirm (required)</label>
            <input class="input" id="project-delete-confirm" name="confirm" required autocomplete="off" spellcheck="false" aria-describedby="project-delete-confirm-hint" />
            <p class="hint" id="project-delete-confirm-hint">The project name must match exactly.</p>
          </div>
          <label class="check">
            <input class="checkbox" type="checkbox" name="deleteFiles" value="true" />
            <span>Delete files too</span>
          </label>
          <input type="hidden" name="return_to" value="${escapeHtml(remove.returnTo)}" />
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
  const props = buildAppProps({ site, projectId, appKey, runtimeConfigured });
  if (props === undefined) {
    return undefined;
  }
  const { identity, links, delete: remove } = props;
  const deletionPending = remove.pending;

  const menu = `<details class="menu">
        <summary class="btn btn-ghost btn-icon" aria-label="More actions" title="More actions">${icon("more")}</summary>
        <nav class="menu__panel" aria-label="More actions">
          <a class="menu__item" href="${escapeHtml(links.ide)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE in this folder</a>
          <a class="menu__item" href="${escapeHtml(links.settings)}">${icon("settings")}Application settings</a>
        </nav>
      </details>`;
  const appActions = props.header.showChatTerminal
    ? `<a class="btn btn-secondary" href="${escapeHtml(links.chat)}">${icon("message")}Open chat</a><a class="btn btn-secondary" href="${escapeHtml(links.terminal)}">${icon("terminal")}Terminal</a>${menu}`
    : menu;

  const header = pageHeader({
    overline: props.header.overline,
    title: props.header.title,
    description: props.header.description,
    meta: [...props.header.meta],
    actions: appActions,
  });

  const restartDialog = props.restart.available
    ? `<dialog class="dialog" id="app-restart-dialog" aria-labelledby="app-restart-dialog-title">
      <div class="dialog__frame">
        <header class="dialog__head"><h2 class="dialog__title" id="app-restart-dialog-title">${escapeHtml(props.restart.dialogTitle)}</h2></header>
        <form method="post" action="${escapeHtml(props.restart.action)}">
          <div class="dialog__body">
            <p class="body">${escapeHtml(props.restart.dialogBody)}</p>
            <input type="hidden" name="return_to" value="${escapeHtml(props.restart.returnTo)}" />
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
      <div class="state-strip__value">${runtimePill(props.runtime.state)}</div>
      <div class="state-strip__actions" id="runtime-actions">${
        props.restart.available
          ? `<form id="runtime-restart"><button class="btn btn-secondary btn-sm" type="button" data-dialog-open="app-restart-dialog">${icon("refresh")}Restart agent</button></form>`
          : ""
      }</div>
    </div>
    <div class="state-strip__cell" id="settings-state">
      <span class="state-strip__label">Settings</span>
      ${settingsState(props.settings)}
    </div>
  </section>${restartDialog}`;

  const image = props.image.configured
    ? imagePanel(props.image, deletionPending)
    : defaultImagePanel(props.image, links.ide, deletionPending);
  const sshHosts = props.ssh.hosts;
  const sshPending = props.ssh.pendingApprovals;
  const sshPendingCopy =
    sshPending > 0
      ? `<span class="status" data-state="awaiting_approval">${icon("stamp")}${sshPending} pending ${sshPending === 1 ? "approval" : "approvals"}</span>`
      : '<p class="small">No pending approvals.</p>';
  const sshPanel = `<section class="card" id="ssh-panel" aria-labelledby="ssh-panel-title">
    <div class="card__head"><h2 class="card__title" id="ssh-panel-title">SSH access</h2><a class="btn btn-ghost btn-sm" href="${escapeHtml(links.ssh)}">${icon("terminal")}Manage</a></div>
    <div class="card__body stack--tight">
      <p class="small">${sshHosts} allowed ${sshHosts === 1 ? "host" : "hosts"}</p>
      ${sshPendingCopy}
    </div>
  </section>`;
  const deletionBanner =
    remove.banner === null
      ? ""
      : `<div class="error-state section" id="deletion-banner" role="alert">
      <span class="error-state__mark">${icon("alert-triangle", "icon--lg")}</span>
      <div>
        <h3 class="error-state__title">${escapeHtml(remove.banner.title)}</h3>
        <p class="error-state__body">${escapeHtml(remove.banner.body)}</p>
      </div>
    </div>`;

  const dangerZone = `<section class="card section" id="danger-zone" aria-labelledby="danger-zone-title">
    <div class="card__head">
      <h2 class="card__title" id="danger-zone-title">Danger zone</h2>
      ${remove.statusLabel !== null ? deletionStatus(remove.statusLabel) : remove.pending ? deletionStatus() : '<span class="badge">Destructive</span>'}
    </div>
    <div class="card__body stack--tight">
      ${
        remove.projectDeleting
          ? `<p class="small">A previous project deletion did not finish. Retry to remove the remaining applications, records, and runtime resources.</p>`
          : remove.deleting
            ? `<p class="small">A previous deletion did not finish. Retry to remove the remaining application records and runtime resources.</p>`
            : `<p class="small">Deleting this application removes its sessions, handoffs, credentials, and managed images. Source files are kept unless you choose to delete them too.</p>`
      }
    </div>
    <div class="card__foot">
      <button class="btn btn-danger" type="button" data-dialog-open="${remove.dialog === "project" ? "project-delete-dialog" : "application-delete-dialog"}">${icon("trash")}${remove.pending ? "Retry deletion" : "Delete application"}</button>
    </div>
  </section>`;

  const deleteDialogs =
    remove.dialog === "project"
      ? applicationProjectDeleteDialog(remove, identity.projectId, identity.projectName)
      : applicationDeleteDialog(remove, identity.appKey, identity.projectId);

  const masterBody = `${stateStrip}<section class="card section" id="master-panel" aria-labelledby="master-panel-title">
    <div class="card__head"><h2 class="card__title" id="master-panel-title">Master workspace</h2><span class="badge badge--mono">system</span></div>
    <div class="card__body stack--tight">
      <div class="stack--tight"><span class="overline">Directory</span><span class="mono">${escapeHtml(identity.folder)}</span></div>
      <p class="small">The master's directory is coordinator-managed and read-only inside its container. Its instructions are rewritten on every coordinator start.</p>
      <p class="small">Workspace changes go through the master's Hanse tools. Skills can be created, inspected, updated, enabled/disabled, and overridden from the master chat; deleting or renaming them remains operator-only. Provider keys, git credentials, image builds, and project deletion are operator-only UI actions.</p>
    </div>
    <div class="card__foot"><a class="btn btn-secondary btn-sm" href="${escapeHtml(links.settings)}">${icon("settings")}Application settings</a><a class="btn btn-ghost btn-sm" href="${escapeHtml(links.skills)}">${icon("code")}Skills</a></div>
  </section>`;
  const body = props.master
    ? masterBody
    : `${stateStrip}${deletionBanner}<div id="git-panel" data-project-id="${escapeHtml(identity.projectId)}" data-app-key="${escapeHtml(identity.appKey)}" data-api-base="${escapeHtml(props.git.apiBase)}">
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
      <p class="small">Git actions need JavaScript. Use the IDE for repository operations. <a class="btn btn-ghost btn-sm" href="${escapeHtml(links.ide)}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a></p>
    </noscript>
  </div>${dangerZone}${deleteDialogs}`;

  return appShell({
    title: `${identity.appKey} application`,
    active: "project",
    activeProjectId: identity.projectId,
    breadcrumb: [
      { label: "Projects", href: "/projects" },
      { label: identity.projectName, href: `/projects/${encodeURIComponent(identity.projectId)}` },
      { label: identity.appKey },
    ],
    projects: navProjects(site),
    pendingCount: site.pendingCount,
    sshPendingCount: site.sshPendingCount,
    operatorName: chrome.operatorName,
    notice: chrome.notice,
    header,
    scripts: props.master ? [] : ["/assets/git.js", "/assets/images.js"],
    body,
    settingsHref: links.settings,
    skillsHref: links.skills,
  });
}
