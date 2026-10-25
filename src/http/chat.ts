import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { BLOCKING_RESPONSE_BUDGET_BYTES, blockingResponseBudget } from "../attachments/budget.js";
import { type CapabilityOutcome, resolveModelCapabilities } from "../attachments/capabilities.js";
import {
  completeUpload,
  discardUpload,
  finalDirFor,
  finalPathFor,
  tempPathFor,
  writeCommitMetadata,
} from "../attachments/commit.js";
import {
  attachmentsForRefs,
  parseRequestedAttachments,
  planDeliveries,
  type RequestedAttachmentInput,
  resolveSendAttachments,
  type SendAttachment,
  sendPartsForPlan,
} from "../attachments/delivery.js";
import {
  PROJECTED_RESPONSE_MAX_BYTES,
  projectedResponseBytes,
  readProjectedPage,
} from "../attachments/history.js";
import { dedupeWarnings, planInlineDelivery } from "../attachments/inline.js";
import { isInlineSafeMime } from "../attachments/mime.js";
import {
  encodeContentDisposition,
  filenameFromContentDisposition,
  safeOriginalName,
  storedNameFor,
} from "../attachments/names.js";
import {
  type AttachmentPathMode,
  attachmentRelPath,
  attachmentsHostRoot,
  attachmentTempRelPath,
} from "../attachments/paths.js";
import {
  createEventAttachmentResolver,
  createMessageProjector,
} from "../attachments/projection.js";
import {
  activeUploadIds,
  availableAttachmentBytes,
  quotaView,
  reservedAttachmentBytes,
  uploadCoordinator,
} from "../attachments/quota.js";
import {
  ensureSessionFolder,
  moveIntoPlace,
  openAttachmentFile,
  removeFileQuiet,
} from "../attachments/storage.js";
import {
  deleteAttachmentRowById,
  deliveryStatesForAttachment,
  failDeliveriesForMessage,
  insertUploadingAttachment,
  markAttachmentMissing,
  markDeliveriesUnknownForMessage,
  readAttachment,
  readSessionAttachment,
  setAttachmentMode,
} from "../attachments/store.js";
import { appStreams } from "../attachments/streams.js";
import {
  attachmentTitle as attachmentTitleForSend,
  prefixDefaultLikeTitle,
} from "../attachments/title.js";
import {
  type AttachmentRow,
  type AttachmentView,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "../attachments/types.js";
import { streamUploadBody, UploadStreamError } from "../attachments/upload.js";
import { attachmentView, draftAttachmentViews, parseAttachmentRefs } from "../attachments/views.js";
import { KeyedMutex, sessionLockKey, sessionLocks } from "../chat/locks.js";
import { collectSessionSubtreeIDs } from "../chat/session-tree.js";
import {
  bumpLastActivity,
  deletePending,
  deleteSessionChatRows,
  draftSummaries,
  ensureSessionState,
  insertEmptySessionState,
  insertPendingAndClearDraft,
  insertPendingSend,
  isSessionId,
  localSessionBlockReason,
  MAX_DRAFT_BYTES,
  nowIso,
  pendingSendView,
  readDraft,
  readPendingSend,
  readPendingSends,
  removeSessionFolder,
  sessionFolder,
  setPendingState,
  upsertSessionState,
  writeDraft,
} from "../chat/state.js";
import type { Handoff } from "../coordinator/handoff.js";
import type { Principal } from "../identity/principals.js";
import { isMasterApp } from "../master/constants.js";
import {
  abortSession,
  createSession,
  deleteSession,
  getSession,
  isDefaultTitle,
  lastAssistant,
  listMessagePage,
  listMessages,
  listSessions,
  listSessionsBounded,
  OpencodeHttpError,
  type OpencodeMessage,
  patchSessionTitle,
  sendPrompt,
  sendPromptAsync,
} from "../opencode/client.js";
import { authorizationFor } from "../opencode/endpoint-auth.js";
import { APP_STREAM_MAX_FRAME_BYTES, createRawEventStream } from "../opencode/events.js";
import { DEFAULT_MODEL, DeletionPendingError } from "../opencode/manager.js";
import type { PreviewView } from "../preview/types.js";
import type { RegisteredApp } from "../registry/index.js";
import { appDir, type FoundApp, findApp, toManagedApp } from "./apps.js";
import { humanFrom, principalFrom } from "./auth.js";
import {
  buildSite,
  operatorProjects,
  type PageChrome,
  renderNotFound,
  type SiteModel,
} from "./dashboard.js";
import { lifecycleErrorResponse, mapLifecycleHttpError } from "./errors.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import {
  appShell,
  emptyState,
  escapeHtml,
  icon,
  ideFolderUrl,
  initials,
  pageHeader,
  plural,
  routeText,
  runtimePill,
  statusPill,
} from "./ui.js";

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
}

function html(status: number, body: string): HttpResponse {
  return { status, contentType: "text/html; charset=utf-8", body };
}

function redirect(location: string): HttpResponse {
  return { status: 303, contentType: "text/plain", body: "", headers: { location } };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pageLimit(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const limit = Number(value);
  return limit <= 200 ? limit : undefined;
}

function requestPath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.set(key, value);
  }
  const query = params.toString();
  return query.length === 0 ? request.path : `${request.path}?${query}`;
}

function chatLoginRedirect(request: HttpRequest): HttpResponse {
  return redirect(`/login?next=${encodeURIComponent(requestPath(request))}`);
}

function projectParam(request: HttpRequest): string | undefined {
  const project = request.query?.project?.trim();
  return project === undefined || project.length === 0 ? undefined : project;
}

function projectAppKey(projectId: string, appKey: string): string {
  return `${projectId}:${appKey}`;
}

function effectiveModel(
  deps: HttpDeps,
  found: { project: { id: string }; app: { appKey: string } },
): string | undefined {
  try {
    return (
      deps.settings?.resolve({
        projectId: found.project.id,
        appKey: found.app.appKey,
      }).effective.llm.model.value ?? undefined
    );
  } catch {
    return undefined;
  }
}

function navProjects(site: SiteModel): Array<{ id: string; name: string; appCount: number }> {
  return site.projects.map((project) => ({
    id: project.id,
    name: project.name,
    appCount: project.apps.length,
  }));
}

function pageChrome(principal: Principal, request: HttpRequest): PageChrome {
  const message = request.query?.notice;
  const notice =
    message === undefined || message.trim().length === 0
      ? undefined
      : {
          message,
          tone: request.query?.tone === "error" ? ("error" as const) : ("success" as const),
        };
  return { operatorName: principal.name, notice };
}

function appKeyFor(site: SiteModel, appId: string): string {
  return site.apps.get(appId)?.appKey ?? appId.split(":").pop() ?? appId;
}

function contextHandoffs(site: SiteModel, appId: string): Handoff[] {
  return site.projects
    .flatMap((project) => project.handoffs)
    .filter((handoff) => handoff.fromAppId === appId || handoff.toAppId === appId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function renderContextHandoffs(site: SiteModel, appId: string, appKey: string): string {
  const handoffs = contextHandoffs(site, appId);
  if (handoffs.length === 0) {
    return emptyState({
      iconName: "branch",
      title: "No handoffs",
      body: `No handoff routes involve ${appKey} yet.`,
      action: '<a class="btn btn-secondary btn-sm" href="/handoffs">Open inbox</a>',
    });
  }
  return `<div class="stack--tight">${handoffs
    .map(
      (handoff) => `<a class="context-handoff" href="/handoffs?q=${encodeURIComponent(handoff.id)}">
        <span class="context-handoff__head"><span class="mono table__nowrap">${escapeHtml(handoff.id.slice(0, 8))}</span>${statusPill(handoff.state)}</span>
        <span class="context-handoff__summary">${escapeHtml(handoff.summary)}</span>
        <span class="context-handoff__route">${routeText(appKeyFor(site, handoff.fromAppId), appKeyFor(site, handoff.toAppId))}</span>
      </a>`,
    )
    .join("")}</div>`;
}

function appOptions(site: SiteModel, selectedProjectId: string, selectedAppKey: string): string {
  return site.projects
    .filter((project) => project.builtin !== true || project.id === selectedProjectId)
    .map((project) => {
      const options = project.apps
        .map((app) => {
          const value = projectAppKey(project.id, app.appKey);
          const selected = project.id === selectedProjectId && app.appKey === selectedAppKey;
          return `<option value="${escapeHtml(value)}" data-project="${escapeHtml(project.id)}" data-app="${escapeHtml(app.appKey)}"${selected ? " selected" : ""}>${escapeHtml(app.appKey)}</option>`;
        })
        .join("");
      return `<optgroup label="${escapeHtml(project.name)}">${options}</optgroup>`;
    })
    .join("");
}

function renderNoApps(site: SiteModel, chrome: PageChrome): string {
  return appShell({
    title: "Chat",
    active: "none",
    breadcrumb: [{ label: "Workbench", href: "/" }, { label: "Chat" }],
    projects: navProjects(site),
    pendingCount: site.pendingCount,
    operatorName: chrome.operatorName,
    notice: chrome.notice,
    header: pageHeader({
      overline: "Workbench",
      title: "Chat",
      description: "A workspace for one application agent at a time.",
    }),
    body: emptyState({
      iconName: "message",
      title: "No applications yet",
      body: "Add an application to a project before opening a chat. The agent starts when you open its workspace.",
      action: '<a class="btn btn-primary btn-sm" href="/projects">Open projects</a>',
    }),
    skillsHref: "/skills",
  });
}

function renderPreviewRows(previews: PreviewView[]): string {
  return previews
    .map(
      (preview) => `<li class="chat-preview" data-preview-key="${escapeHtml(preview.key)}">
        <a class="chat-preview__link" href="${escapeHtml(preview.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(preview.name)}">
          <span class="chat-preview__name">${escapeHtml(preview.name)}</span>
          <span class="chat-preview__key mono" title="${escapeHtml(preview.key)}">${escapeHtml(preview.key)}</span>
          ${icon("external")}
          <span class="sr-only">(opens in a new tab)</span>
        </a>
        <button class="btn btn-ghost btn-icon btn-sm chat-preview__close" type="button" aria-label="Close preview ${escapeHtml(preview.name)}" hidden>${icon("x")}</button>
      </li>`,
    )
    .join("");
}

function renderPreviewSection(previews: PreviewView[]): string {
  return `<div class="chat-context__group" id="chat-previews"${previews.length === 0 ? " hidden" : ""}>
        <hr class="rule" />
        <section class="chat-context__section" aria-labelledby="context-previews-title">
          <div class="cluster summary-row"><h2 class="overline" id="context-previews-title">Previews</h2><span class="caption" id="chat-previews-count">${previews.length} active</span></div>
          <p class="hint">Demo only. Preview pages share the coordinator's origin and session.</p>
          <ul class="chat-previews" id="chat-previews-list" role="list">${renderPreviewRows(previews)}</ul>
        </section>
      </div>`;
}

function renderChatPage(
  site: SiteModel,
  found: {
    project: { id: string; name: string; rootPath: string; workspaceRoot: string };
    app: RegisteredApp;
  },
  principal: Principal,
  chrome: PageChrome,
  previews: PreviewView[],
): string {
  const { project, app } = found;
  const ref = site.apps.get(app.id);
  const runtime = site.runtime.get(app.id) ?? "stopped";
  const handoffs = contextHandoffs(site, app.id);
  const folder = appDir(project, app);
  const path = isMasterApp(project.id, app.appKey) ? folder : (ref?.path ?? app.path);
  const appHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}`;
  const master = isMasterApp(project.id, app.appKey);
  const settingsHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/settings`;
  const pendingRestart = site.pendingRestart.get(app.id) ?? false;
  const chatHref = `/chat?app=${encodeURIComponent(app.appKey)}&project=${encodeURIComponent(project.id)}`;
  const breadcrumb = [
    { label: "Projects", href: "/projects" },
    { label: project.name, href: `/projects/${encodeURIComponent(project.id)}` },
    { label: app.appKey, href: appHref },
    { label: "Chat" },
  ];
  const topbarActions = `<button class="btn btn-ghost btn-sm chat-input-needed" id="chat-input-needed" type="button" aria-haspopup="dialog" aria-controls="chat-queue" aria-expanded="false" aria-label="No requests need input" hidden>${icon("message")}<span class="chat-input-needed__count" id="chat-input-needed-count" aria-hidden="true">0</span></button><button class="btn btn-ghost btn-sm policy-chip" id="chat-policy-chip" type="button" aria-controls="chat-policy-warning" aria-expanded="false" hidden>${icon("alert-triangle")}<span id="chat-policy-chip-label">Policy warning</span></button><button class="btn btn-ghost btn-icon chat-context-toggle" type="button" data-chat-context-toggle aria-controls="chat-context" aria-expanded="false" aria-label="Open context panel" title="Context panel">${icon("panel-right")}</button><a class="btn btn-ghost btn-icon" href="${escapeHtml(ideFolderUrl(folder))}" target="_blank" rel="noreferrer" aria-label="Open application in IDE" title="Open in IDE">${icon("external")}</a>`;

  const sessions = `<aside class="chat-sessions" id="chat-sessions" aria-label="Sessions">
    <div class="chat-pane-head">
      <span class="overline">Sessions</span>
      <div class="cluster">
        <button class="btn btn-ghost btn-icon btn-sm" type="button" data-chat-new-session aria-label="New session" title="New session">${icon("plus")}</button>
        <button class="btn btn-ghost btn-icon btn-sm chat-sessions-close" type="button" data-chat-sessions-close aria-label="Close sessions">${icon("x")}</button>
      </div>
    </div>
    <div class="chat-sessions__tools">
      <label class="sr-only" for="session-search">Search sessions</label>
      <input class="input" id="session-search" type="search" placeholder="Filter sessions" autocomplete="off" />
    </div>
    <p class="field-error chat-sessions__error" id="session-error" role="alert" hidden></p>
    <div class="chat-sessions__list" id="session-list">
      <div class="skeleton-stack chat-sessions__skeleton" aria-hidden="true">
        <span class="skeleton skeleton--title"></span>
        <span class="skeleton"></span>
        <span class="skeleton skeleton--short"></span>
        <span class="skeleton"></span>
      </div>
    </div>
  </aside>`;

  const thread = `<section class="chat-thread" id="chat-thread" aria-label="Chat thread">
    <div class="chat-pane-head">
      <button class="btn btn-ghost btn-icon btn-sm chat-sessions-toggle" type="button" data-chat-sessions-toggle aria-controls="chat-sessions" aria-expanded="false" aria-label="Open sessions" title="Sessions">${icon("panel-left")}</button>
      <div class="chat-app-select">
        <label class="sr-only" for="chat-app-select">Application</label>
        <div class="select-wrap"><select class="select" id="chat-app-select">${appOptions(site, project.id, app.appKey)}</select>${icon("chevron-down")}</div>
      </div>
      <div class="cluster">
        <button class="btn btn-secondary btn-sm" type="button" data-chat-new-session aria-label="New session" title="New session">${icon("plus")}<span class="chat-action-label">New session</span></button>
        <span class="chat-runtime" id="chat-runtime">${runtimePill(runtime)}</span>
      </div>
    </div>
    <div class="chat-thread__meta">
      <span class="chat-session-title" id="chat-session-title">Session</span>
      <span class="mono" id="chat-session-id">-</span>
      <span class="chat-live" id="chat-live" data-state="starting">Starting agent...</span>
      <span class="caption" id="chat-message-count">0 messages</span>
      <span class="chat-waiting" id="chat-waiting" role="status" aria-live="polite" hidden>${icon("stamp")}Waiting for you</span>
      <button class="btn btn-ghost btn-sm chat-plan-chip" id="chat-plan-chip" type="button" aria-controls="chat-plan-section" title="Open the plan panel" hidden>${icon("activity")}<span id="chat-plan-chip-label">Plan 0/0</span></button>
      <button class="btn btn-ghost btn-sm chat-context-chip" id="chat-context-chip" type="button" aria-controls="chat-context-usage" hidden>${icon("gauge")}<span id="chat-context-chip-label">Context —</span><span class="sr-only" id="chat-context-chip-exact"></span><span class="chat-context-chip__meter" role="meter" aria-label="Context usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Unknown" hidden><span class="chat-context-chip__fill" aria-hidden="true"></span></span></button>
      <span class="chat-working" id="chat-working" hidden><span class="spinner" aria-hidden="true" data-chat-working-spinner></span><span class="chat-working__label" id="chat-working-label" role="status" aria-live="polite" aria-atomic="true">Ready</span><span class="chat-working__elapsed" id="chat-working-elapsed" aria-hidden="true" hidden></span><span class="chat-working__queued" id="chat-working-queued" aria-hidden="true" hidden></span></span>
      <button class="btn btn-ghost btn-sm chat-retry" id="chat-stream-retry" type="button" hidden>${icon("refresh")}Retry</button>
    </div>
    <div class="policy-warning" id="chat-policy-warning" role="status" hidden></div>
    <div class="chat-thread__viewport">
      <div class="chat-thread__scroll" id="chat-scroll">
        <div class="chat-history" id="chat-history" data-state="idle" hidden><span class="spinner" aria-hidden="true"></span><span id="chat-history-label">Loading earlier messages...</span></div>
        <div class="chat-thread__inner" id="chat-messages" role="log" aria-live="off">
          <div class="skeleton-stack" aria-hidden="true">
            <span class="skeleton skeleton--title"></span>
            <span class="skeleton"></span>
            <span class="skeleton skeleton--short"></span>
            <span class="skeleton"></span>
            <span class="skeleton skeleton--short"></span>
          </div>
        </div>
        <div class="chat-generating" id="chat-generating" hidden aria-hidden="true"><span class="chat-generating__dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="chat-generating__label" id="chat-generating-label"></span><span class="chat-generating__elapsed" id="chat-generating-elapsed"></span></div>
        <div class="chat-question-placeholder" id="chat-question-placeholder"></div>
      </div>
      <button class="btn btn-secondary btn-sm chat-new-messages" id="chat-new-messages" type="button" hidden>New messages ${icon("arrow-right")}</button>
    </div>
    <div class="chat-queue-strip" id="chat-queue-strip" hidden>
      <span class="chat-queue-strip__count" id="chat-queue-strip-count" role="status" aria-live="polite" aria-atomic="true"></span>
      <ol class="chat-queue-strip__list" id="chat-queue-strip-list"></ol>
    </div>
    <p class="chat-session-notice" id="chat-session-notice" role="status" hidden>Session too large to refresh; showing the last loaded state.</p>
    <div class="ssh-approval-slot" id="chat-ssh-approvals" hidden></div>
    <section class="prompt-dock" id="chat-prompt-dock" aria-label="Agent requests" hidden></section>
    <div class="command-palette" id="chat-command-palette" hidden>
      <div class="command-palette__head">
        <span class="overline">Commands</span>
        <span class="command-palette__status" id="chat-command-status" role="status" aria-live="polite" aria-atomic="true"></span>
      </div>
      <div class="command-palette__list" id="chat-command-listbox" role="listbox" aria-label="Slash commands"></div>
      <p class="command-palette__shadow" id="chat-command-shadow" hidden></p>
    </div>
    <form class="composer" id="chat-composer" data-no-busy>
      <div class="composer__row">
        <label class="sr-only" for="chat-prompt">Message ${escapeHtml(app.appKey)} agent</label>
        <textarea class="textarea" id="chat-prompt" name="prompt" rows="1" enterkeyhint="enter" placeholder="Message ${escapeHtml(app.appKey)} agent" aria-describedby="chat-composer-hint" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-controls="chat-command-listbox" aria-expanded="false"></textarea>
        <button class="btn btn-ghost btn-icon" id="chat-commands-button" type="button" aria-label="Commands" aria-haspopup="listbox" aria-expanded="false" aria-controls="chat-command-listbox" title="Commands">${icon("slash")}</button>
        <button class="btn btn-primary" id="chat-send" type="submit">${icon("send")}<span class="btn__label">Send</span></button>
      </div>
      <div class="composer__hint" id="chat-composer-hint">
        <span id="chat-composer-hint-text">Enter to send / Shift+Enter for a new line</span>
        <span>${plural(handoffs.length, "handoff")} in context</span>
      </div>
      <p class="field-error" id="chat-send-error" role="alert" hidden></p>
      <div class="chat-send-recovery" id="chat-send-recovery" hidden>
        <span id="chat-send-recovery-text">Delivery unknown; checking…</span>
        <button class="btn btn-secondary btn-sm" type="button" id="chat-send-check" hidden>Check again</button>
        <button class="btn btn-ghost btn-sm" type="button" id="chat-send-remove" hidden>Remove</button>
      </div>
    </form>
  </section>`;

  const context = `<aside class="chat-context" id="chat-context" aria-label="Context">
    <div class="chat-pane-head">
      <span class="overline">Context</span>
      <button class="btn btn-ghost btn-icon btn-sm chat-context-close" type="button" data-chat-context-close aria-label="Close context">${icon("x")}</button>
    </div>
    <div class="chat-context__body">
      <section class="chat-context__section" aria-labelledby="context-app-title">
        <p class="overline">Application</p>
        <div class="summary-row"><h2 class="h3" id="context-app-title">${escapeHtml(app.appKey)}</h2><span class="chat-runtime" id="chat-context-runtime">${runtimePill(runtime)}</span></div>
        <a class="small" href="/projects/${encodeURIComponent(project.id)}">${escapeHtml(project.name)}</a>
        <p class="mono">${escapeHtml(path)}</p>
        <div class="cluster">
          <a class="btn btn-secondary btn-sm" href="${escapeHtml(ideFolderUrl(folder))}" target="_blank" rel="noreferrer">${icon("external")}Open IDE</a>
          <a class="btn btn-ghost btn-sm" href="${escapeHtml(appHref)}">Application</a>
          <a class="btn btn-ghost btn-sm" href="${escapeHtml(settingsHref)}">${icon("settings")}Settings</a>
          <a class="btn btn-ghost btn-sm" href="/projects/${encodeURIComponent(project.id)}">Open project</a>
        </div>
        ${
          pendingRestart
            ? `<div class="stack--tight" id="chat-settings-pending">
                <div class="cluster"><span class="badge badge-warning">Restart required</span><span class="small">Settings changed</span></div>
                <p class="hint">Restart the agent to apply the new model, auth, or web tools. An active turn will be interrupted.</p>
                <form method="post" action="/api/apps/${encodeURIComponent(app.appKey)}/restart?project=${encodeURIComponent(project.id)}">
                  <input type="hidden" name="return_to" value="${escapeHtml(chatHref)}" />
                  <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
                </form>
              </div>`
            : ""
        }
      </section>
      ${renderPreviewSection(previews)}
      <section class="chat-context__section chat-context-usage" id="chat-context-usage" aria-labelledby="context-usage-title">
        <div class="cluster summary-row"><h2 class="overline" id="context-usage-title" tabindex="-1">Context</h2><span class="caption" id="chat-context-summary">—</span></div>
        <div class="chat-context-usage__meter" id="chat-context-meter" role="meter" aria-label="Context usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="Unknown"><span class="chat-context-usage__fill" id="chat-context-meter-fill" aria-hidden="true"></span></div>
        <p class="caption" id="chat-context-detail">Waiting for a completed step.</p>
        <div class="cluster summary-row"><p class="hint" id="chat-context-auto">Auto-compact off</p><a class="btn btn-ghost btn-sm" id="chat-context-settings" href="${escapeHtml(settingsHref)}">${icon("settings")}Settings</a></div>
        <div class="cluster">
          <button class="btn btn-secondary btn-sm" id="chat-context-compact" type="button" disabled aria-describedby="chat-context-compact-reason">Compact now</button>
        </div>
        <p class="hint" id="chat-context-compact-reason">Start a session to compact.</p>
        <div class="chat-context-usage__confirm" id="chat-context-confirm" hidden>
          <p class="caption">Summarization replaces the session history and can lose detail.</p>
          <div class="cluster">
            <button class="btn btn-danger btn-sm" id="chat-context-confirm-compact" type="button">Compact now</button>
            <button class="btn btn-ghost btn-sm" id="chat-context-confirm-cancel" type="button">Cancel</button>
          </div>
        </div>
        <p class="field-error" id="chat-context-error" role="alert" hidden></p>
      </section>
      <hr class="rule" id="chat-plan-divider" hidden />
      <section class="chat-context__section chat-plan-section" id="chat-plan-section" aria-labelledby="context-plan-title" hidden>
        <div class="cluster summary-row"><h2 class="overline" id="context-plan-title" tabindex="-1">Plan</h2><span class="caption" id="chat-plan-summary">No plan yet</span></div>
        <p class="chat-plan__empty" id="chat-plan-empty">Send a message to start a session.</p>
        <ul class="chat-plan__list" id="chat-plan-list" hidden></ul>
      </section>
      <hr class="rule" id="chat-saved-divider" hidden />
      <section class="chat-context__section" id="chat-saved-section" aria-labelledby="context-saved-title" hidden>
        <div class="cluster summary-row"><h2 class="overline" id="context-saved-title">Saved permissions</h2><span class="badge" id="chat-saved-badge" hidden>New</span></div>
        <p class="caption">Durable project grants. Revoke to restore the policy.</p>
        <div class="chat-saved" id="chat-saved-list"></div>
      </section>
      <hr class="rule" />
      <section class="chat-context__section" aria-labelledby="context-handoffs-title">
        <div class="cluster summary-row"><p class="overline" id="context-handoffs-title">Handoffs</p><a class="btn btn-ghost btn-sm" href="/handoffs?q=${encodeURIComponent(app.appKey)}">Open inbox</a></div>
        ${renderContextHandoffs(site, app.id, app.appKey)}
      </section>
      <hr class="rule" />
      <section class="chat-context__section" aria-labelledby="context-shortcuts-title">
        <p class="overline" id="context-shortcuts-title">Shortcuts</p>
        <div class="cluster">
          <a class="btn btn-ghost btn-sm" href="/handoffs?q=${encodeURIComponent(app.appKey)}">Handoff inbox</a>
          <a class="btn btn-ghost btn-sm" href="/projects/${encodeURIComponent(project.id)}">Project</a>
          <a class="btn btn-ghost btn-sm" href="${escapeHtml(ideFolderUrl(folder))}" target="_blank" rel="noreferrer">IDE</a>
        </div>
      </section>
    </div>
  </aside>`;

  return appShell({
    title: `${app.appKey} chat`,
    active: "none",
    activeProjectId: project.id,
    breadcrumb,
    projects: navProjects(site),
    pendingCount: site.pendingCount,
    settingsHref: `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/settings`,
    skillsHref: `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/skills`,
    operatorName: principal.name,
    notice: chrome.notice,
    header: "",
    pageClass: "page--chat",
    bodyClass: "page__body--chat",
    moduleScripts: ["/assets/chat.js"],
    viewport: "width=device-width, initial-scale=1, interactive-widget=resizes-content",
    topbarActions,
    body: `<div class="chat-shell chat-shell--workspace" id="chat-shell" data-app-key="${escapeHtml(app.appKey)}" data-project-id="${escapeHtml(project.id)}" data-runtime-url="${escapeHtml(`/api/apps/${encodeURIComponent(app.appKey)}/runtime?project=${encodeURIComponent(project.id)}`)}" data-ide-url="${escapeHtml(ideFolderUrl(folder))}" data-app-url="${escapeHtml(appHref)}"${master ? ' data-master="1"' : ""} data-app-initials="${escapeHtml(initials(app.appKey))}" data-operator-initials="${escapeHtml(initials(principal.name))}" data-chat-sessions="closed" data-chat-context="closed">
      <h1 class="sr-only">Chat with ${escapeHtml(app.appKey)}</h1>
      ${sessions}
      ${thread}
      ${context}
      <div class="chat-queue" id="chat-queue" role="dialog" aria-modal="false" aria-labelledby="chat-queue-title" hidden>
        <div class="chat-queue__head">
          <p class="overline" id="chat-queue-title">Needs input</p>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" data-chat-queue-close aria-label="Close request queue">${icon("x")}</button>
        </div>
        <div class="chat-queue__list" id="chat-queue-list"></div>
      </div>
      <dialog class="dialog command-confirm" id="chat-command-confirm" aria-modal="true" aria-labelledby="chat-command-confirm-title" aria-describedby="chat-command-confirm-body">
        <div class="dialog__frame">
          <div class="dialog__head">
            <h2 class="dialog__title" id="chat-command-confirm-title">Confirm command</h2>
          </div>
          <div class="dialog__body">
            <p id="chat-command-confirm-body"></p>
          </div>
          <div class="dialog__foot">
            <button class="btn btn-ghost btn-sm" type="button" id="chat-command-confirm-cancel">Cancel</button>
            <button class="btn btn-danger btn-sm" type="button" id="chat-command-confirm-accept">Confirm</button>
          </div>
        </div>
      </dialog>
      <p class="sr-only" id="chat-announcer" role="status" aria-live="polite" aria-atomic="true"></p>
      <div class="chat-scrim" data-chat-scrim></div>
    </div>`,
  });
}

export async function streamSessionEvents(
  deps: HttpDeps,
  request: HttpRequest,
  response: ServerResponse,
): Promise<void> {
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    response.writeHead(401);
    response.end();
    return;
  }
  if (principal.kind !== "human") {
    response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "only a human principal may read session events" }));
    return;
  }
  const match = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/events$/.exec(request.path);
  const found = findApp(deps, projectParam(request), safeDecode(match?.[1] ?? ""));
  if (found === undefined || deps.manager === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }
  const releaseSlot = appStreams.acquireBrowser(found.app.id);
  if (releaseSlot === undefined) {
    response.writeHead(429, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        error: "too many event streams for this application",
        code: "stream_limit",
      }),
    );
    return;
  }
  let slotReleased = false;
  const releaseOnce = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSlot();
  };
  response.once?.("close", releaseOnce);
  response.once?.("finish", releaseOnce);
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure(toManagedApp(found));
  } catch (error) {
    if (error instanceof DeletionPendingError) {
      response.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error.message, code: error.code }));
      releaseOnce();
      return;
    }
    const mapped = mapLifecycleHttpError(error);
    if (mapped !== undefined) {
      response.writeHead(mapped.status, {
        "content-type": "application/json; charset=utf-8",
        ...(mapped.headers ?? {}),
      });
      response.end(JSON.stringify(mapped.body));
      releaseOnce();
      return;
    }
    response.writeHead(502);
    response.end();
    releaseOnce();
    return;
  }
  const authorization = authorizationFor(endpoint);
  const upstream = await fetch(`${endpoint}/event`, {
    headers: {
      accept: "text/event-stream",
      ...(authorization === undefined ? {} : { authorization }),
    },
    signal: controller.signal,
  }).catch(() => undefined);
  if (upstream === undefined || !upstream.ok || upstream.body === null) {
    response.writeHead(502);
    response.end();
    releaseOnce();
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const streamID = request.headers["x-hanse-stream"]?.trim() ?? "";
  const stream = createRawEventStream(upstream.body, {
    signal: controller.signal,
    maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES,
    attachments: createEventAttachmentResolver({
      db: deps.db,
      appId: found.app.id,
      appKey: found.app.appKey,
      projectId: found.project.id,
    }),
    isPriority: () => streamID.length > 0 && appStreams.isActive(found.app.id, streamID),
  });
  try {
    for await (const event of stream.events) {
      if (response.destroyed || response.writableEnded) break;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch {
    controller.abort();
  } finally {
    stream.close();
    releaseOnce();
  }
  response.end();
}

type UpstreamSessionCheck = "reachable" | "missing" | "gone" | "unavailable";

function appNotFound(appKey: string): HttpResponse {
  return json(404, { error: `unknown application: ${appKey}`, code: "app_not_found" });
}

function invalidSession(): HttpResponse {
  return json(400, { error: "invalid session id", code: "invalid_session" });
}

function agentUnavailable(): HttpResponse {
  return json(503, { error: "agent is not running", code: "agent_unavailable" });
}

async function checkUpstreamSession(
  endpoint: string | undefined,
  sessionId: string,
): Promise<UpstreamSessionCheck> {
  if (endpoint === undefined) return "unavailable";
  try {
    await getSession(endpoint, sessionId, { timeoutMs: 5_000 });
    return "reachable";
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.status === 410) return "gone";
    if (error instanceof OpencodeHttpError && error.status === 404) return "missing";
    return "unavailable";
  }
}

function isSessionGone(error: unknown): boolean {
  return error instanceof OpencodeHttpError && (error.status === 404 || error.status === 410);
}

function parseSessionTitle(body: string | undefined): { title?: string } | { invalid: true } {
  let parsed: unknown = {};
  const raw = body ?? "";
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { invalid: true };
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { invalid: true };
  }
  const value = (parsed as Record<string, unknown>).title;
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "string") {
    return { invalid: true };
  }
  const singleLine = value.replace(/[\r\n\t]+/g, " ");
  const cleaned = Array.from(singleLine)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && code !== 0x2028 && code !== 0x2029;
    })
    .join("")
    .trim();
  if (cleaned.length < 1 || cleaned.length > 120) {
    return { invalid: true };
  }
  return { title: cleaned };
}

function parseForce(body: string | undefined): { force: boolean; invalid: boolean } {
  const raw = body ?? "";
  if (raw.trim().length === 0) return { force: false, invalid: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { force: false, invalid: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { force: false, invalid: true };
  }
  return { force: (parsed as Record<string, unknown>).force === true, invalid: false };
}

function newPendingId(): string {
  return `pend_${randomUUID().replaceAll("-", "")}`;
}

function newMessageId(): string {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

/** Per-app upload/quota lock; lock order is ensure -> session -> quota. */
const appUploadLocks = new KeyedMutex();

function newAttachmentId(): string {
  return `att_${randomUUID().replaceAll("-", "")}`;
}

/** Shared mutation Origin check: absent is allowed; `null`, malformed, or a host mismatch is not. */
function crossSiteMutation(request: HttpRequest): boolean {
  const origin = request.origin?.trim();
  if (origin === undefined || origin.length === 0) return false;
  if (origin === "null") return true;
  if (request.host === undefined || request.host.length === 0) return true;
  try {
    return new URL(origin).host.toLowerCase() !== request.host.toLowerCase();
  } catch {
    return true;
  }
}

function attachmentPathMode(deps: HttpDeps): AttachmentPathMode {
  return deps.manager?.attachmentsPathMode?.() ?? "container";
}

function _attachmentVisibleRootFor(deps: HttpDeps, found: FoundApp): string {
  const manager = deps.manager;
  if (manager?.attachmentVisibleRoot !== undefined) {
    return manager.attachmentVisibleRoot(found.app);
  }
  return appAttachmentRoot(deps, found) ?? "";
}

function appAttachmentRoot(deps: HttpDeps, found: FoundApp): string | undefined {
  return deps.agentsHome === undefined
    ? undefined
    : path.dirname(attachmentsHostRoot(deps.agentsHome, found.project.id, found.app.appKey));
}

function quotaPercent(deps: HttpDeps, appId: string): number {
  return quotaView(availableAttachmentBytes(deps.db, appId)).percent;
}

function attachmentViewFor(
  deps: HttpDeps,
  found: FoundApp,
  row: AttachmentRow,
  state?: AttachmentView["state"],
): AttachmentView {
  return attachmentView(row, {
    appKey: found.app.appKey,
    projectId: found.project.id,
    deliveryStates: deliveryStatesForAttachment(deps.db, found.app.id, row.id),
    ...(state === undefined ? {} : { state }),
  });
}

function _writeJson(_headers: Record<string, string>, body: unknown): string {
  return JSON.stringify(body);
}

function removeLocalSessionRows(deps: HttpDeps, found: FoundApp, sessionId: string): void {
  deleteSessionChatRows(deps.db, found.app.id, sessionId);
  removeSessionFolder(
    sessionFolder(deps.agentsHome, found.project.id, found.app.appKey, sessionId),
  );
}

function markHandoffsDeleted(deps: HttpDeps, sessionId: string): void {
  const now = new Date().toISOString();
  deps.db
    .prepare(
      `UPDATE handoffs SET
         source_session_deleted_at = COALESCE(source_session_deleted_at, ?),
         updated_at = ?
       WHERE (source_session_id = ? OR reply_delivered_session_id = ?)
         AND source_session_deleted_at IS NULL`,
    )
    .run(now, now, sessionId, sessionId);
}

async function handleDraft(
  deps: HttpDeps,
  found: FoundApp,
  request: HttpRequest,
  sessionId: string,
): Promise<HttpResponse> {
  if (request.method === "GET") {
    const now = nowIso();
    return sessionLocks.run(sessionLockKey(found.app.id, sessionId), () => {
      const draft = readDraft(deps.db, found.app.id, sessionId);
      bumpLastActivity(deps.db, found.app.id, sessionId, now);
      const pendingSends = readPendingSends(deps.db, found.app.id, sessionId).map(pendingSendView);
      return json(200, {
        text: draft?.text ?? "",
        attachments: draftAttachmentViews(deps.db, found.app.id, sessionId, {
          appKey: found.app.appKey,
          projectId: found.project.id,
        }),
        pendingSends,
        quota: { percent: quotaPercent(deps, found.app.id) },
        updatedAt: draft?.updatedAt ?? null,
      });
    });
  }
  if (request.method !== "PUT") {
    return json(405, { error: "method not allowed" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body ?? "");
  } catch {
    return json(400, { error: "invalid JSON body", code: "invalid_json" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return json(400, { error: "invalid JSON body", code: "invalid_json" });
  }
  const value = (parsed as Record<string, unknown>).text;
  if (typeof value !== "string") {
    return json(400, { error: "invalid JSON body", code: "invalid_json" });
  }
  const text = value;
  if (Buffer.byteLength(text, "utf8") > MAX_DRAFT_BYTES) {
    return json(400, { error: "draft too large", code: "draft_too_large" });
  }
  const endpoint = deps.manager?.endpointFor?.(found.app.id);
  const now = nowIso();
  return sessionLocks.run(sessionLockKey(found.app.id, sessionId), async () => {
    const check = await checkUpstreamSession(endpoint, sessionId);
    if (check === "missing") {
      return json(404, { error: "session not found", code: "session_not_found" });
    }
    if (check === "gone") {
      return json(410, { error: "session is gone", code: "session_gone" });
    }
    writeDraft(deps.db, found.app.id, sessionId, text, now);
    if (check === "reachable") {
      ensureSessionState(deps.db, found.app.id, sessionId, now);
    } else {
      bumpLastActivity(deps.db, found.app.id, sessionId, now);
    }
    return json(200, { text, updatedAt: now });
  });
}

async function handleTouch(
  deps: HttpDeps,
  found: FoundApp,
  sessionId: string,
): Promise<HttpResponse> {
  const endpoint = deps.manager?.endpointFor?.(found.app.id);
  const now = nowIso();
  return sessionLocks.run(sessionLockKey(found.app.id, sessionId), async () => {
    if (endpoint !== undefined) {
      const check = await checkUpstreamSession(endpoint, sessionId);
      if (check === "missing") {
        return json(404, { error: "session not found", code: "session_not_found" });
      }
      if (check === "gone") {
        return json(410, { error: "session is gone", code: "session_gone" });
      }
      if (check === "reachable") {
        ensureSessionState(deps.db, found.app.id, sessionId, now);
        return json(200, { touched: true });
      }
    }
    bumpLastActivity(deps.db, found.app.id, sessionId, now);
    return json(200, { touched: true });
  });
}

async function handleDeleteIfEmpty(
  deps: HttpDeps,
  found: FoundApp,
  sessionId: string,
): Promise<HttpResponse> {
  if (found.app.deleting || found.project.deleting) {
    return json(409, { error: "application is pending deletion", code: "deletion_pending" });
  }
  const manager = deps.manager;
  if (manager === undefined) return agentUnavailable();
  return sessionLocks.run(sessionLockKey(found.app.id, sessionId), async () => {
    const blocked = localSessionBlockReason(deps.db, found.app.id, sessionId);
    if (blocked !== undefined) {
      return json(200, { deleted: false, reason: blocked });
    }
    const endpoint = manager.endpointFor?.(found.app.id);
    if (endpoint === undefined) return agentUnavailable();
    let upstreamGone = false;
    try {
      const page = await listMessagePage(endpoint, sessionId, {
        limit: 1,
        timeoutMs: 5_000,
      });
      if (page.messages.length > 0) {
        return json(200, { deleted: false, reason: "has_messages" });
      }
    } catch (error) {
      if (isSessionGone(error)) {
        upstreamGone = true;
      } else if (error instanceof OpencodeHttpError && error.code === "messages_too_large") {
        return json(200, { deleted: false, reason: "has_messages" });
      } else {
        return json(503, {
          error: "could not verify the session is empty",
          code: "empty_check_failed",
        });
      }
    }
    if (!upstreamGone) {
      try {
        await deleteSession(endpoint, sessionId, { timeoutMs: 5_000 });
      } catch (error) {
        if (!isSessionGone(error)) {
          return json(503, {
            error: "could not delete the session",
            code: "delete_failed",
          });
        }
        upstreamGone = true;
      }
    }
    removeLocalSessionRows(deps, found, sessionId);
    return json(200, { deleted: true, upstream: !upstreamGone });
  });
}

async function handlePendingRetry(
  deps: HttpDeps,
  found: FoundApp,
  request: HttpRequest,
  sessionId: string,
  pendingId: string,
): Promise<HttpResponse> {
  const manager = deps.manager;
  if (manager === undefined) return agentUnavailable();
  const forceParsed = parseForce(request.body);
  if (forceParsed.invalid) {
    return json(400, { error: "invalid JSON body", code: "invalid_json" });
  }
  const force = forceParsed.force;
  const recovery = manager.pendingRecovery;
  if (recovery === undefined) return agentUnavailable();
  const endpoint = manager.endpointFor?.(found.app.id);
  if (endpoint === undefined) return agentUnavailable();
  const key = sessionLockKey(found.app.id, sessionId);
  const snapshot = await sessionLocks.run(key, () =>
    readPendingSend(deps.db, found.app.id, sessionId, pendingId),
  );
  if (snapshot === undefined) {
    return json(404, { error: "pending send not found", code: "pending_not_found" });
  }
  if (snapshot.state === "sending") {
    return json(409, { error: "send is still in flight", code: "pending_in_flight" });
  }
  const outcome =
    snapshot.state === "failed"
      ? await recovery.recheckOnce(found.app.id, snapshot)
      : await recovery.recheck(found.app.id, snapshot);
  if (outcome === "pending") {
    return json(202, { rechecking: true });
  }
  if (outcome === "found") {
    return json(200, { retried: false, confirmed: true });
  }
  if (outcome === "unknown" && (!force || snapshot.state !== "unknown")) {
    return json(409, {
      error: "send outcome is still unknown",
      code: "still_unknown",
    });
  }
  if (outcome === "absent" && (await recovery.sessionMissing(found.app.id, sessionId))) {
    removeLocalSessionRows(deps, found, sessionId);
    return json(404, { error: "session not found", code: "session_not_found" });
  }
  const refs = parseAttachmentRefs(snapshot.attachmentsJson);
  const requested: RequestedAttachmentInput[] = refs.map((ref) => ({
    id: ref.id,
    ...(ref.mode === undefined ? {} : { mode: ref.mode }),
    explicitMode: ref.mode !== undefined,
  }));
  const capability = await capabilityForSend(deps, found, endpoint, sessionId, requested);
  const appRoot = appAttachmentRoot(deps, found);
  const prepared = await sessionLocks.run(key, () => {
    const current = readPendingSend(deps.db, found.app.id, sessionId, snapshot.id);
    if (current === undefined) return { missing: true as const };
    if (current.state === "sending") return { inflight: true as const };
    const rows =
      refs.length === 0 || appRoot === undefined
        ? []
        : attachmentsForRefs(deps.db, found.app.id, sessionId, refs, appRoot);
    if (refs.length > 0 && rows.length !== refs.length) {
      return { missingAttachment: true as const };
    }
    const plan = planInlineDelivery({ rows, requested, capability });
    if (!plan.ok) return { failedPlan: plan.error };
    const planned = sendAttachments(rows, plan.plan.modes);
    const now = nowIso();
    const messageID = newMessageId();
    insertPendingSend(deps.db, {
      id: newPendingId(),
      appId: found.app.id,
      sessionId,
      messageID,
      text: current.text,
      now,
      ...(refs.length === 0 ? {} : { attachmentsJson: current.attachmentsJson }),
      deliveries: planned.deliveries,
      deletePendingId: current.id,
      failMessageId: current.messageID,
    });
    const parts = attachParts({
      deps,
      found,
      sessionId,
      text: current.text,
      attachments: planned.attachments,
    });
    return {
      text: current.text,
      messageID,
      parts,
      warnings: dedupeWarnings(plan.plan.warnings),
    };
  });
  if ("missing" in prepared) {
    return json(200, { retried: false, confirmed: true });
  }
  if ("inflight" in prepared) {
    return json(409, { error: "send is still in flight", code: "pending_in_flight" });
  }
  if ("missingAttachment" in prepared) {
    return json(409, { error: "attachment file is missing", code: "attachment_missing" });
  }
  if ("failedPlan" in prepared && prepared.failedPlan !== undefined) {
    return json(prepared.failedPlan.status, {
      error: prepared.failedPlan.message,
      code: prepared.failedPlan.code,
    });
  }
  const messageID = prepared.messageID;
  const warningFields = prepared.warnings.length === 0 ? {} : { warnings: prepared.warnings };
  await manager.preparePendingConfirmation?.(found.app.id).catch(() => undefined);
  try {
    await sendPromptAsync(
      endpoint,
      sessionId,
      prepared.text,
      messageID,
      undefined,
      effectiveModel(deps, found) ?? DEFAULT_MODEL,
      prepared.parts,
    );
  } catch (error) {
    const state =
      error instanceof OpencodeHttpError && (error.status === 0 || error.status >= 500)
        ? "unknown"
        : "failed";
    const failureNow = nowIso();
    await sessionLocks.run(key, () => {
      const created = readPendingSends(deps.db, found.app.id, sessionId).find(
        (candidate) => candidate.messageID === messageID,
      );
      if (created !== undefined) {
        setPendingState(deps.db, created.id, state, "retry_dispatch_failed", failureNow);
      }
      if (state === "unknown") {
        markDeliveriesUnknownForMessage(
          deps.db,
          found.app.id,
          sessionId,
          messageID,
          "retry_dispatch_failed",
          failureNow,
        );
      } else {
        failDeliveriesForMessage(
          deps.db,
          found.app.id,
          sessionId,
          messageID,
          "retry_dispatch_failed",
          failureNow,
          ["sending"],
        );
      }
    });
    return json(502, {
      error: error instanceof Error ? error.message : String(error),
      code: "agent_unavailable",
      outcome: state === "unknown" ? "unknown" : "not_sent",
    });
  }
  manager.armPendingConfirmation?.(found.app.id);
  return json(200, { retried: true, messageID, ...warningFields });
}

async function handlePendingDismiss(
  deps: HttpDeps,
  found: FoundApp,
  request: HttpRequest,
  sessionId: string,
  pendingId: string,
): Promise<HttpResponse> {
  const manager = deps.manager;
  if (manager === undefined) return agentUnavailable();
  const forceParsed = parseForce(request.body);
  if (forceParsed.invalid) {
    return json(400, { error: "invalid JSON body", code: "invalid_json" });
  }
  const force = forceParsed.force;
  const recovery = manager.pendingRecovery;
  if (recovery === undefined) return agentUnavailable();
  const key = sessionLockKey(found.app.id, sessionId);
  const snapshot = await sessionLocks.run(key, () =>
    readPendingSend(deps.db, found.app.id, sessionId, pendingId),
  );
  if (snapshot === undefined) {
    return json(404, { error: "pending send not found", code: "pending_not_found" });
  }
  if (snapshot.state === "sending") {
    return json(409, { error: "send is still in flight", code: "pending_in_flight" });
  }
  if (manager.endpointFor?.(found.app.id) === undefined) {
    if (!force) return agentUnavailable();
    await sessionLocks.run(key, () => {
      const now = nowIso();
      deps.db.transaction(() => {
        failDeliveriesForMessage(
          deps.db,
          found.app.id,
          sessionId,
          snapshot.messageID,
          "dismissed",
          now,
          ["sending", "unknown"],
        );
        deletePending(deps.db, snapshot.id);
      })();
    });
    return json(200, { dismissed: true });
  }
  const outcome =
    snapshot.state === "failed"
      ? await recovery.recheckOnce(found.app.id, snapshot)
      : await recovery.recheck(found.app.id, snapshot);
  if (outcome === "pending") {
    return json(202, { rechecking: true });
  }
  if (outcome === "found") {
    return json(200, { dismissed: false, confirmed: true });
  }
  if (outcome === "unknown" && (!force || snapshot.state !== "unknown")) {
    return json(409, {
      error: "send outcome is still unknown",
      code: "still_unknown",
    });
  }
  if (outcome === "absent" && (await recovery.sessionMissing(found.app.id, sessionId))) {
    removeLocalSessionRows(deps, found, sessionId);
    return json(200, { dismissed: true });
  }
  await sessionLocks.run(key, () => {
    const current = readPendingSend(deps.db, found.app.id, sessionId, snapshot.id);
    if (current !== undefined && current.state !== "sending") {
      const now = nowIso();
      deps.db.transaction(() => {
        failDeliveriesForMessage(
          deps.db,
          found.app.id,
          sessionId,
          current.messageID,
          "dismissed",
          now,
          ["sending", "unknown"],
        );
        deletePending(deps.db, current.id);
      })();
    }
  });
  return json(200, { dismissed: true });
}

async function handleSessionCreate(
  deps: HttpDeps,
  found: FoundApp,
  endpoint: string,
  request: HttpRequest,
): Promise<HttpResponse> {
  const parsed = parseSessionTitle(request.body);
  if ("invalid" in parsed) {
    return json(400, { error: "invalid session title", code: "invalid_title" });
  }
  const created = await createSession(
    endpoint,
    parsed.title === undefined ? undefined : prefixDefaultLikeTitle(parsed.title),
  );
  try {
    insertEmptySessionState(deps.db, found.app.id, created.id, nowIso());
  } catch {
    // The upstream session exists; a missing state row is treated as unknown (no Draft label) and
    // the next successful PUT/touch upserts it with has_messages=1.
  }
  return json(200, created);
}

async function capabilityForSend(
  deps: HttpDeps,
  found: FoundApp,
  endpoint: string,
  sessionId: string,
  requested: RequestedAttachmentInput[] | undefined,
): Promise<CapabilityOutcome> {
  if (requested === undefined || requested.length === 0) return { status: "unknown" };
  const mayInline = requested.some((item) => {
    if (item.mode === "file") return false;
    const row = readSessionAttachment(deps.db, found.app.id, sessionId, item.id);
    if (row === undefined) return false;
    if (item.mode === "inline") return true;
    return row.kind === "image" || row.kind === "video" || row.kind === "pdf";
  });
  if (!mayInline) return { status: "unknown" };
  return resolveModelCapabilities(endpoint, effectiveModel(deps, found) ?? DEFAULT_MODEL);
}

function sendAttachments(
  rows: AttachmentRow[],
  modes: ReadonlyMap<string, "inline" | "file">,
): { attachments: SendAttachment[]; deliveries: ReturnType<typeof planDeliveries> } {
  const attachments: SendAttachment[] = rows.map((row) => ({
    row,
    mode: modes.get(row.id) ?? "file",
    partId: null,
  }));
  const deliveries = planDeliveries(attachments);
  for (const [index, delivery] of deliveries.entries()) {
    const attachment = attachments[index];
    if (attachment !== undefined) attachment.partId = delivery.partId;
  }
  return { attachments, deliveries };
}

function attachParts(input: {
  deps: HttpDeps;
  found: FoundApp;
  sessionId: string;
  text: string;
  attachments: SendAttachment[];
}): ReturnType<typeof sendPartsForPlan> | undefined {
  if (input.attachments.length === 0 || input.deps.agentsHome === undefined) return undefined;
  return sendPartsForPlan({
    text: input.text,
    agentsHome: input.deps.agentsHome,
    projectId: input.found.project.id,
    appKey: input.found.app.appKey,
    pathMode: attachmentPathMode(input.deps),
    sessionId: input.sessionId,
    attachments: input.attachments,
  });
}

async function dispatchTextSend(
  deps: HttpDeps,
  found: FoundApp,
  endpoint: string,
  sessionId: string,
  text: string,
  asyncSend: boolean,
  requested?: RequestedAttachmentInput[],
  streamID?: string,
): Promise<HttpResponse> {
  const appRoot = appAttachmentRoot(deps, found);
  if (requested !== undefined && appRoot === undefined) {
    return agentUnavailable();
  }
  if (requested !== undefined && requested.length > 0) {
    let currentTitle: string | undefined;
    try {
      const session = await getSession(endpoint, sessionId, { timeoutMs: 5_000 });
      currentTitle = typeof session.title === "string" ? session.title : undefined;
    } catch (error) {
      if (error instanceof OpencodeHttpError && (error.status === 404 || error.status === 410)) {
        return json(404, { error: "session not found", code: "session_not_found" });
      }
      return json(409, {
        error: "the session title must be set before sending attachments",
        code: "title_required",
      });
    }
    if (isDefaultTitle(currentTitle)) {
      try {
        await patchSessionTitle(endpoint, sessionId, attachmentTitleForSend(text));
      } catch {
        return json(409, {
          error: "the session title must be set before sending attachments",
          code: "title_required",
        });
      }
    }
  }

  const capability = await capabilityForSend(deps, found, endpoint, sessionId, requested);
  const messageID = newMessageId();
  const pendingId = newPendingId();
  const now = nowIso();
  let attachments: SendAttachment[] = [];
  let warnings: string[] = [];
  const prepared = await sessionLocks.run(sessionLockKey(found.app.id, sessionId), () => {
    if (requested !== undefined && requested.length > 0) {
      const resolved = resolveSendAttachments(deps.db, appRoot as string, {
        appId: found.app.id,
        sessionId,
        requested,
        now,
      });
      if (!resolved.ok) return resolved;
      const plan = planInlineDelivery({
        rows: resolved.rows,
        requested,
        capability,
      });
      if (!plan.ok) return { ok: false as const, ...plan.error };
      const prepared = sendAttachments(resolved.rows, plan.plan.modes);
      attachments = prepared.attachments;
      warnings = dedupeWarnings([...resolved.warnings, ...plan.plan.warnings]);
      insertPendingAndClearDraft(deps.db, {
        id: pendingId,
        appId: found.app.id,
        sessionId,
        messageID,
        text,
        now,
        ...(resolved.refs.length === 0 ? {} : { attachmentsJson: JSON.stringify(resolved.refs) }),
        deliveries: prepared.deliveries,
      });
      return { ok: true as const };
    }
    insertPendingAndClearDraft(deps.db, {
      id: pendingId,
      appId: found.app.id,
      sessionId,
      messageID,
      text,
      now,
    });
    return { ok: true as const };
  });
  if (!prepared.ok) {
    return json(prepared.status, { error: prepared.message, code: prepared.code });
  }
  const parts = attachParts({ deps, found, sessionId, text, attachments });
  const warningFields = warnings.length === 0 ? {} : { warnings };
  appStreams.registerActive(found.app.id, streamID);
  await deps.manager?.preparePendingConfirmation?.(found.app.id).catch(() => undefined);
  if (asyncSend) {
    try {
      await sendPromptAsync(
        endpoint,
        sessionId,
        text,
        messageID,
        undefined,
        effectiveModel(deps, found) ?? DEFAULT_MODEL,
        parts,
      );
    } catch (error) {
      const unknown = error instanceof OpencodeHttpError && error.status === 0;
      const state = unknown ? "unknown" : "failed";
      const failureNow = nowIso();
      setPendingState(deps.db, pendingId, state, "dispatch_failed", failureNow);
      if (state === "unknown") {
        markDeliveriesUnknownForMessage(
          deps.db,
          found.app.id,
          sessionId,
          messageID,
          "dispatch_failed",
          failureNow,
        );
      } else {
        failDeliveriesForMessage(
          deps.db,
          found.app.id,
          sessionId,
          messageID,
          "dispatch_failed",
          failureNow,
          ["sending"],
        );
      }
      if (error instanceof OpencodeHttpError) {
        if (error.status === 404) {
          return json(404, {
            error: "session not found",
            code: "session_not_found",
            outcome: "not_sent",
          });
        }
        if (error.status === 405) {
          return json(502, {
            error: "async prompt route unavailable",
            code: "async_unavailable",
            outcome: "not_sent",
          });
        }
        if (error.status === 0) {
          return json(502, {
            error: error.message,
            code: "agent_unavailable",
            outcome: "unknown",
            messageID,
            sessionID: sessionId,
          });
        }
        return json(502, {
          error: error.message,
          code: "agent_unavailable",
          outcome: "not_sent",
        });
      }
      return json(502, {
        error: error instanceof Error ? error.message : String(error),
        code: "agent_unavailable",
        outcome: "unknown",
        messageID,
        sessionID: sessionId,
      });
    }
    deps.manager?.armPendingConfirmation?.(found.app.id);
    return json(202, { accepted: true, messageID, sessionID: sessionId, ...warningFields });
  }
  const releaseBlocking = await blockingResponseBudget.acquire(BLOCKING_RESPONSE_BUDGET_BYTES);
  if (releaseBlocking === undefined) {
    const failureNow = nowIso();
    setPendingState(deps.db, pendingId, "failed", "blocking_busy", failureNow);
    failDeliveriesForMessage(
      deps.db,
      found.app.id,
      sessionId,
      messageID,
      "blocking_busy",
      failureNow,
      ["sending"],
    );
    return json(503, {
      error: "another blocking send is in flight",
      code: "blocking_busy",
      outcome: "not_sent",
      userMessageID: messageID,
    });
  }
  try {
    const raw = await sendPrompt(
      endpoint,
      sessionId,
      text,
      effectiveModel(deps, found) ?? DEFAULT_MODEL,
      messageID,
      parts,
    );
    await sessionLocks.run(sessionLockKey(found.app.id, sessionId), () => {
      confirmBlockingSend(deps, found, sessionId, messageID);
    });
    const assistant = lastAssistant(raw);
    const assistantID =
      assistant !== undefined && typeof assistant.info.id === "string"
        ? assistant.info.id
        : messageID;
    if (assistant === undefined) {
      return json(200, {
        messageID: assistantID,
        userMessageID: messageID,
        info: null,
        truncated: true,
        ...warningFields,
      });
    }
    const projected: OpencodeMessage[] = [assistant];
    createMessageProjector({
      db: deps.db,
      appId: found.app.id,
      appKey: found.app.appKey,
      projectId: found.project.id,
    })(projected);
    const message = projected[0] ?? assistant;
    const payload = {
      messageID: assistantID,
      userMessageID: messageID,
      info: message.info,
      parts: message.parts,
      ...warningFields,
    };
    if (projectedResponseBytes(payload) > PROJECTED_RESPONSE_MAX_BYTES) {
      return json(200, {
        messageID: assistantID,
        userMessageID: messageID,
        info: null,
        truncated: true,
        ...warningFields,
      });
    }
    return json(200, payload);
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.code === "response_too_large") {
      await sessionLocks.run(sessionLockKey(found.app.id, sessionId), () => {
        confirmBlockingSend(deps, found, sessionId, messageID);
      });
      return json(200, {
        messageID: salvageMessageId(error.bodyExcerpt) ?? messageID,
        userMessageID: messageID,
        info: null,
        truncated: true,
        ...warningFields,
      });
    }
    const state =
      error instanceof OpencodeHttpError && (error.status === 0 || error.status >= 500)
        ? "unknown"
        : error instanceof OpencodeHttpError && error.status === 404
          ? "failed"
          : "unknown";
    const failureNow = nowIso();
    setPendingState(deps.db, pendingId, state, "dispatch_failed", failureNow);
    if (state === "unknown") {
      markDeliveriesUnknownForMessage(
        deps.db,
        found.app.id,
        sessionId,
        messageID,
        "dispatch_failed",
        failureNow,
      );
    } else {
      failDeliveriesForMessage(
        deps.db,
        found.app.id,
        sessionId,
        messageID,
        "dispatch_failed",
        failureNow,
        ["sending"],
      );
    }
    throw error;
  } finally {
    releaseBlocking();
  }
}

function salvageMessageId(excerpt: string): string | undefined {
  const match = /"id"\s*:\s*"(msg_[A-Za-z0-9]+)"/.exec(excerpt);
  return match?.[1];
}

function confirmBlockingSend(
  deps: HttpDeps,
  found: FoundApp,
  sessionId: string,
  messageID: string,
): void {
  const now = nowIso();
  deps.db
    .prepare(`DELETE FROM pending_sends WHERE app_id = ? AND session_id = ? AND message_id = ?`)
    .run(found.app.id, sessionId, messageID);
  deps.db
    .prepare(
      `UPDATE attachment_deliveries SET state = 'sent', error_code = NULL, updated_at = ?
        WHERE app_id = ? AND session_id = ? AND message_id = ?`,
    )
    .run(now, found.app.id, sessionId, messageID);
  upsertSessionState(deps.db, found.app.id, sessionId, 1, now);
}

function respondJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(value));
}

function headerValue(headers: IncomingMessage["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function uploadLifecycleError(
  error: unknown,
): { status: number; body: unknown; headers?: Record<string, string> } | undefined {
  if (error instanceof DeletionPendingError) {
    return { status: 409, body: { error: error.message, code: error.code } };
  }
  const mapped = lifecycleErrorResponse(error);
  if (mapped !== undefined) {
    return {
      status: mapped.status,
      body: JSON.parse(mapped.body) as unknown,
      ...(mapped.headers === undefined ? {} : { headers: mapped.headers }),
    };
  }
  return undefined;
}

/**
 * Binary upload entry point. Authentication and the cross-site Origin check run before the body is
 * consumed; the body is streamed to a temp file under the per-app upload lock (design §D2/§6.1).
 */
export async function handleAttachmentUpload(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const match = /^\/api\/apps\/([^/]+)\/attachments$/.exec(url.pathname);
  if (match === null) {
    respondJson(response, 404, { error: "not found" });
    return;
  }
  const httpRequest: HttpRequest = {
    method: request.method ?? "POST",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: {
      authorization: headerValue(request.headers, "authorization"),
      cookie: headerValue(request.headers, "cookie"),
      accept: headerValue(request.headers, "accept"),
      "content-type": headerValue(request.headers, "content-type"),
    },
    origin: headerValue(request.headers, "origin"),
    host: headerValue(request.headers, "host"),
  };
  const principal = principalFrom(deps, httpRequest);
  if (principal === undefined) {
    request.resume();
    respondJson(response, 401, { error: "sign in required" });
    return;
  }
  if (principal.kind !== "human") {
    request.resume();
    respondJson(response, 403, { error: "only a human principal may upload attachments" });
    return;
  }
  if (crossSiteMutation(httpRequest)) {
    request.resume();
    respondJson(response, 403, {
      error: "cross-site request rejected",
      code: "cross_site_request",
    });
    return;
  }
  const found = findApp(deps, projectParam(httpRequest), safeDecode(match[1] ?? ""));
  if (found === undefined) {
    request.resume();
    respondJson(response, 404, {
      error: `unknown application: ${match[1] ?? ""}`,
      code: "app_not_found",
    });
    return;
  }
  if (found.app.deleting || found.project.deleting) {
    request.resume();
    respondJson(response, 409, {
      error: "application is pending deletion",
      code: "deletion_pending",
    });
    return;
  }
  const sessionId = url.searchParams.get("session") ?? "";
  if (!isSessionId(sessionId)) {
    request.resume();
    respondJson(response, 400, { error: "invalid session id", code: "invalid_session" });
    return;
  }
  const filename = safeOriginalName(
    filenameFromContentDisposition(headerValue(request.headers, "content-disposition")) ?? "",
  );
  if (filename.length === 0) {
    request.resume();
    respondJson(response, 400, { error: "invalid filename", code: "invalid_filename" });
    return;
  }
  const rawLength = headerValue(request.headers, "content-length");
  const contentLength = rawLength === undefined ? undefined : Number(rawLength);
  if (
    contentLength !== undefined &&
    (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_FILE_BYTES)
  ) {
    request.resume();
    respondJson(response, 413, { error: "file exceeds the upload cap", code: "file_too_large" });
    return;
  }
  const manager = deps.manager;
  if (manager === undefined) {
    request.resume();
    respondJson(response, 503, { error: "agent is not running", code: "agent_unavailable" });
    return;
  }
  let endpoint: string;
  try {
    endpoint = await manager.ensure(toManagedApp(found));
  } catch (error) {
    request.resume();
    const mapped = uploadLifecycleError(error);
    if (mapped !== undefined) {
      respondJson(response, mapped.status, mapped.body, mapped.headers);
      return;
    }
    respondJson(response, 503, { error: "agent is not running", code: "agent_unavailable" });
    return;
  }
  const check = await checkUpstreamSession(endpoint, sessionId);
  if (check !== "reachable") {
    request.resume();
    if (check === "missing" || check === "gone") {
      respondJson(response, 404, { error: "session not found", code: "session_not_found" });
    } else {
      respondJson(response, 503, { error: "agent is not running", code: "agent_unavailable" });
    }
    return;
  }
  const appRoot = appAttachmentRoot(deps, found);
  if (appRoot === undefined) {
    request.resume();
    respondJson(response, 503, {
      error: "attachment storage is unavailable",
      code: "agent_unavailable",
    });
    return;
  }

  const declaredSize = Math.min(
    contentLength !== undefined && contentLength > 0 ? contentLength : MAX_FILE_BYTES,
    MAX_FILE_BYTES,
  );
  const id = newAttachmentId();
  const tempRelPath = attachmentTempRelPath(sessionId, id);
  const reservation = uploadCoordinator.reserve(found.app.id, declaredSize);
  if (!reservation.ok) {
    request.resume();
    respondJson(
      response,
      429,
      { error: "too many concurrent uploads", code: "upload_busy" },
      { "retry-after": "2" },
    );
    return;
  }

  let reserved = false;
  let tempPath: string | undefined;
  let committed = false;
  try {
    const prepared = await appUploadLocks.run(found.app.id, () => {
      if (reservedAttachmentBytes(deps.db, found.app.id) + declaredSize > 5 * 1024 * 1024 * 1024) {
        return { ok: false as const, status: 507, code: "attachment_quota_exceeded" };
      }
      try {
        const sessionDir = ensureSessionFolder(appRoot, sessionId);
        tempPath = path.join(sessionDir, ".tmp", `${id}.part`);
      } catch {
        return { ok: false as const, status: 400, code: "invalid_session" };
      }
      insertUploadingAttachment(deps.db, {
        id,
        appId: found.app.id,
        sessionId,
        originalName: filename,
        tempRelPath,
        declaredSize,
        now: nowIso(),
      });
      reserved = true;
      return { ok: true as const };
    });
    if (!prepared.ok) {
      request.resume();
      respondJson(response, prepared.status, { error: prepared.code, code: prepared.code });
      return;
    }
    if (tempPath === undefined) {
      request.resume();
      respondJson(response, 500, { error: "attachment storage is unavailable" });
      return;
    }
    activeUploadIds.add(id);
    const streamed = await streamUploadBody(request, tempPath, filename);
    if (streamed.sniffed.kind === "image" && streamed.size > MAX_IMAGE_BYTES) {
      throw new UploadStreamError("file_too_large", "image exceeds the upload cap");
    }
    const storedName = storedNameFor(id, filename);
    const relPath = attachmentRelPath(sessionId, storedName);
    const commit = await sessionLocks.run(sessionLockKey(found.app.id, sessionId), async () => {
      const finalCheck = await checkUpstreamSession(endpoint, sessionId);
      if (finalCheck !== "reachable") {
        return {
          ok: false as const,
          status: finalCheck === "missing" || finalCheck === "gone" ? 404 : 503,
          code:
            finalCheck === "missing" || finalCheck === "gone"
              ? "session_not_found"
              : "agent_unavailable",
        };
      }
      const quota = await appUploadLocks.run(found.app.id, () => {
        const otherReserved = deps.db
          .prepare(
            `SELECT COALESCE(SUM(MIN(COALESCE(declared_size, ?), ?)), 0) AS used
               FROM app_attachments
              WHERE app_id = ? AND state = 'uploading' AND id <> ?`,
          )
          .get(MAX_FILE_BYTES, MAX_FILE_BYTES, found.app.id, id) as { used: number };
        return availableAttachmentBytes(deps.db, found.app.id) + otherReserved.used + streamed.size;
      });
      if (quota > 5 * 1024 * 1024 * 1024) {
        return { ok: false as const, status: 507, code: "attachment_quota_exceeded" };
      }
      const row = readAttachment(deps.db, found.app.id, id);
      if (row === undefined) return { ok: false as const, status: 500, code: "upload_failed" };
      writeCommitMetadata(deps.db, {
        id,
        storedName,
        relPath,
        mime: streamed.sniffed.mime,
        size: streamed.size,
        kind: streamed.sniffed.kind,
        now: nowIso(),
      });
      const finalRow = {
        ...row,
        storedName,
        relPath,
        mime: streamed.sniffed.mime,
        size: streamed.size,
        kind: streamed.sniffed.kind,
      };
      const final = finalPathFor(appRoot, finalRow);
      const temp = tempPathFor(appRoot, finalRow);
      if (final === undefined || temp === undefined) {
        return { ok: false as const, status: 500, code: "upload_failed" };
      }
      try {
        moveIntoPlace(temp, final, finalDirFor(appRoot, finalRow));
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOSPC"
            ? "attachment_storage_full"
            : "upload_failed";
        return { ok: false as const, status: code === "attachment_storage_full" ? 507 : 500, code };
      }
      completeUpload(deps.db, id, nowIso());
      return { ok: true as const };
    });
    if (!commit.ok) {
      const row = readAttachment(deps.db, found.app.id, id);
      if (row !== undefined) {
        discardUpload(
          deps.db,
          { ...row, storedName: null, relPath: null, tempRelPath: row.tempRelPath },
          appRoot,
        );
      }
      respondJson(response, commit.status, { error: commit.code, code: commit.code });
      return;
    }
    committed = true;
    const row = readAttachment(deps.db, found.app.id, id);
    if (row === undefined) {
      respondJson(response, 500, { error: "upload failed" });
      return;
    }
    respondJson(response, 201, {
      attachment: attachmentViewFor(deps, found, row, "draft"),
      quota: { percent: quotaPercent(deps, found.app.id) },
    });
  } catch (error) {
    if (reserved && !committed) {
      const row = readAttachment(deps.db, found.app.id, id);
      if (row !== undefined) {
        discardUpload(
          deps.db,
          { ...row, storedName: null, relPath: null, tempRelPath: row.tempRelPath },
          appRoot,
        );
      } else if (tempPath !== undefined) {
        removeFileQuiet(tempPath);
      }
    }
    if (error instanceof UploadStreamError) {
      if (error.code === "upload_aborted") {
        if (!response.headersSent) response.destroy();
        return;
      }
      const status =
        error.code === "file_too_large" ? 413 : error.code === "empty_file" ? 400 : 507;
      respondJson(response, status, { error: error.message, code: error.code });
      return;
    }
    respondJson(response, 500, { error: "upload failed" });
  } finally {
    uploadCoordinator.release(found.app.id, declaredSize);
    activeUploadIds.delete(id);
  }
}

/** Human-only attachment download; no Range support in v1 (design §6.7). */
export async function handleAttachmentDownload(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const match = /^\/api\/apps\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
  if (match === null) {
    respondJson(response, 404, { error: "not found" });
    return;
  }
  const httpRequest: HttpRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: {
      authorization: headerValue(request.headers, "authorization"),
      cookie: headerValue(request.headers, "cookie"),
    },
    host: headerValue(request.headers, "host"),
  };
  const principal = principalFrom(deps, httpRequest);
  if (principal === undefined) {
    respondJson(response, 401, { error: "sign in required" });
    return;
  }
  if (principal.kind !== "human") {
    respondJson(response, 403, { error: "only a human principal may download attachments" });
    return;
  }
  const found = findApp(deps, projectParam(httpRequest), safeDecode(match[1] ?? ""));
  if (found === undefined) {
    respondJson(response, 404, { error: "attachment not found", code: "attachment_not_found" });
    return;
  }
  const appRoot = appAttachmentRoot(deps, found);
  const row = readAttachment(deps.db, found.app.id, safeDecode(match[2] ?? ""));
  if (appRoot === undefined || row === undefined || row.state !== "available") {
    respondJson(response, 404, { error: "attachment not found", code: "attachment_not_found" });
    return;
  }
  const opened = openAttachmentFile(appRoot, row);
  if (opened === undefined) {
    markAttachmentMissing(deps.db, row.id, nowIso());
    respondJson(response, 404, { error: "attachment not found", code: "attachment_not_found" });
    return;
  }
  const mime = row.mime ?? "application/octet-stream";
  const disposition = isInlineSafeMime(mime) ? "inline" : "attachment";
  response.writeHead(200, {
    "content-type": mime,
    "content-length": String(opened.size),
    "content-disposition": encodeContentDisposition(disposition, row.originalName),
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=3600",
  });
  const stream = createReadStream("", { fd: opened.fd, autoClose: true });
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
  stream.pipe(response);
}

function isInlineKind(kind: AttachmentRow["kind"]): boolean {
  return kind === "image" || kind === "video" || kind === "pdf";
}

async function handleAttachmentMutation(
  deps: HttpDeps,
  found: FoundApp,
  request: HttpRequest,
  attachmentId: string,
): Promise<HttpResponse> {
  if (crossSiteMutation(request)) {
    return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
  }
  if (request.method !== "PATCH" && request.method !== "DELETE") {
    return json(405, { error: "method not allowed" });
  }
  const row = readAttachment(deps.db, found.app.id, attachmentId);
  if (row === undefined) {
    return json(404, { error: "attachment not found", code: "attachment_not_found" });
  }
  const key = sessionLockKey(found.app.id, row.sessionId);
  if (request.method === "PATCH") {
    return sessionLocks.run(key, () => {
      const current = readAttachment(deps.db, found.app.id, attachmentId);
      if (current === undefined || current.state === "missing") {
        return json(404, { error: "attachment not found", code: "attachment_not_found" });
      }
      if (current.state === "uploading") {
        return json(409, {
          error: "attachment is still uploading",
          code: "attachment_uploading",
        });
      }
      const states = deliveryStatesForAttachment(deps.db, found.app.id, current.id);
      if (states.some((state) => state === "sending")) {
        return json(409, { error: "delivery is in flight", code: "delivery_in_flight" });
      }
      if (states.some((state) => state === "unknown")) {
        return json(409, { error: "delivery outcome is unknown", code: "attachment_unknown" });
      }
      if (states.some((state) => state === "sent")) {
        return json(409, { error: "attachment was already sent", code: "attachment_sent" });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body ?? "");
      } catch {
        return json(400, { error: "invalid JSON body", code: "invalid_json" });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json(400, { error: "invalid JSON body", code: "invalid_json" });
      }
      const mode = (parsed as Record<string, unknown>).mode;
      if (mode !== "auto" && mode !== "inline" && mode !== "file") {
        return json(400, { error: "invalid attachment mode", code: "invalid_mode" });
      }
      if (mode === "inline" && !isInlineKind(current.kind)) {
        return json(400, {
          error: "this attachment kind cannot be sent inline",
          code: "mode_not_supported",
        });
      }
      setAttachmentMode(deps.db, found.app.id, current.id, mode, nowIso());
      const updated = readAttachment(deps.db, found.app.id, current.id);
      return json(
        200,
        updated === undefined ? null : attachmentViewFor(deps, found, updated, "draft"),
      );
    });
  }
  const appRoot = appAttachmentRoot(deps, found);
  return sessionLocks.run(key, () => {
    const current = readAttachment(deps.db, found.app.id, attachmentId);
    if (current === undefined || current.state === "missing") {
      return json(404, { error: "attachment not found", code: "attachment_not_found" });
    }
    if (current.state === "uploading") {
      return json(409, { error: "attachment is still uploading", code: "attachment_uploading" });
    }
    const states = deliveryStatesForAttachment(deps.db, found.app.id, current.id);
    if (states.some((state) => state === "sending")) {
      return json(409, { error: "delivery is in flight", code: "delivery_in_flight" });
    }
    if (states.some((state) => state === "unknown")) {
      return json(409, { error: "delivery outcome is unknown", code: "attachment_unknown" });
    }
    if (states.some((state) => state === "sent")) {
      return json(409, { error: "attachment was already sent", code: "attachment_sent" });
    }
    if (appRoot !== undefined && current.relPath !== null) {
      removeFileQuiet(finalPathFor(appRoot, current));
    }
    deleteAttachmentRowById(deps.db, current.id);
    return json(200, { deleted: true });
  });
}

export async function handleChat(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const projectId = projectParam(request);

  if (request.method === "GET" && request.path === "/chat") {
    const principal = humanFrom(deps, request);
    if (principal === undefined) {
      return chatLoginRedirect(request);
    }
    const appKey = request.query?.app?.trim();
    const site = buildSite(deps);
    const chrome = pageChrome(principal, request);
    if (appKey === undefined || appKey.length === 0) {
      const candidates = operatorProjects(site).flatMap((project) =>
        project.apps.map((app) => ({ project, app })),
      );
      const first =
        candidates[0] ??
        site.projects.flatMap((project) => project.apps.map((app) => ({ project, app })))[0];
      if (first === undefined) {
        return html(200, renderNoApps(site, chrome));
      }
      return redirect(
        `/chat?app=${encodeURIComponent(first.app.appKey)}&project=${encodeURIComponent(first.project.id)}`,
      );
    }
    const found = findApp(deps, projectId, appKey);
    if (found === undefined) {
      return html(404, renderNotFound(site, chrome));
    }
    if (request.host !== undefined) {
      deps.previews?.recordOperatorHost(found.app.id, request.host);
    }
    const previews = deps.previews?.views(found.app.id) ?? [];
    return html(200, renderChatPage(site, found, principal, chrome, previews));
  }

  const sessionsMatch = /^\/api\/apps\/([^/]+)\/sessions$/.exec(request.path);
  const sessionMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)$/.exec(request.path);
  const messagesMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(request.path);
  const abortMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/abort$/.exec(request.path);
  const draftMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/draft$/.exec(request.path);
  const touchMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/touch$/.exec(request.path);
  const deleteIfEmptyMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/delete-if-empty$/.exec(
    request.path,
  );
  const pendingRetryMatch =
    /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/pending\/([^/]+)\/retry$/.exec(request.path);
  const pendingMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/pending\/([^/]+)$/.exec(
    request.path,
  );
  const attachmentMatch = /^\/api\/apps\/([^/]+)\/attachments\/([^/]+)$/.exec(request.path);
  if (
    sessionsMatch === null &&
    sessionMatch === null &&
    messagesMatch === null &&
    abortMatch === null &&
    draftMatch === null &&
    touchMatch === null &&
    deleteIfEmptyMatch === null &&
    pendingRetryMatch === null &&
    pendingMatch === null &&
    attachmentMatch === null
  ) {
    return json(404, { error: "not found" });
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (request.method !== "GET" && crossSiteMutation(request)) {
    return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
  }
  if (abortMatch !== null && principal.kind !== "human") {
    return json(403, { error: "only a human principal may abort a session" });
  }
  if (abortMatch !== null && request.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }
  if (sessionMatch !== null && request.method === "DELETE" && principal.kind !== "human") {
    return json(403, { error: "only a human principal may delete a session" });
  }
  const humanOnly =
    draftMatch !== null ||
    touchMatch !== null ||
    deleteIfEmptyMatch !== null ||
    pendingRetryMatch !== null ||
    pendingMatch !== null ||
    attachmentMatch !== null;
  if (humanOnly && principal.kind !== "human") {
    return json(403, { error: "only a human principal may manage drafts" });
  }

  const appKey = safeDecode(
    (sessionsMatch ??
      sessionMatch ??
      messagesMatch ??
      abortMatch ??
      draftMatch ??
      touchMatch ??
      deleteIfEmptyMatch ??
      pendingRetryMatch ??
      pendingMatch ??
      attachmentMatch)?.[1] ?? "",
  );
  const found = findApp(deps, projectId, appKey);
  if (found === undefined) {
    const newRoutes =
      draftMatch !== null ||
      touchMatch !== null ||
      deleteIfEmptyMatch !== null ||
      pendingRetryMatch !== null ||
      pendingMatch !== null ||
      attachmentMatch !== null;
    return newRoutes
      ? appNotFound(appKey)
      : json(404, { error: `unknown application: ${appKey}`, code: "unknown_app" });
  }
  const sessionId = safeDecode(
    (sessionMatch ??
      messagesMatch ??
      abortMatch ??
      draftMatch ??
      touchMatch ??
      deleteIfEmptyMatch ??
      pendingRetryMatch ??
      pendingMatch)?.[2] ?? "",
  );
  const draftRoutes = draftMatch !== null || touchMatch !== null;
  if (
    (draftRoutes ||
      deleteIfEmptyMatch !== null ||
      pendingRetryMatch !== null ||
      pendingMatch !== null) &&
    !isSessionId(sessionId)
  ) {
    return invalidSession();
  }
  if (attachmentMatch !== null) {
    return handleAttachmentMutation(deps, found, request, safeDecode(attachmentMatch[2] ?? ""));
  }
  if (draftMatch !== null) {
    if (request.method !== "GET" && request.method !== "PUT") {
      return json(405, { error: "method not allowed" });
    }
    return handleDraft(deps, found, request, sessionId);
  }
  if (touchMatch !== null) {
    if (request.method !== "POST") {
      return json(405, { error: "method not allowed" });
    }
    return handleTouch(deps, found, sessionId);
  }
  if (deleteIfEmptyMatch !== null) {
    if (request.method !== "POST") {
      return json(405, { error: "method not allowed" });
    }
    return handleDeleteIfEmpty(deps, found, sessionId);
  }
  if (pendingRetryMatch !== null) {
    if (request.method !== "POST") {
      return json(405, { error: "method not allowed" });
    }
    return handlePendingRetry(
      deps,
      found,
      request,
      sessionId,
      safeDecode(pendingRetryMatch[3] ?? ""),
    );
  }
  if (pendingMatch !== null) {
    if (request.method !== "DELETE") {
      return json(405, { error: "method not allowed" });
    }
    return handlePendingDismiss(deps, found, request, sessionId, safeDecode(pendingMatch[3] ?? ""));
  }
  if (sessionMatch !== null && request.method === "DELETE" && !isSessionId(sessionId)) {
    return invalidSession();
  }
  if (deps.manager === undefined) {
    return json(503, { error: "agent runtime is not configured" });
  }
  if (abortMatch !== null) {
    if (found.app.deleting || found.project.deleting) {
      return json(409, { error: "application is pending deletion", code: "deletion_pending" });
    }
    const endpoint = deps.manager.endpointFor(found.app.id);
    if (endpoint === undefined) {
      return json(503, { error: "agent is not running", code: "agent_not_running" });
    }
    try {
      return json(200, { aborted: await abortSession(endpoint, sessionId) });
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404) {
        return json(404, { error: "session not found", code: "session_not_found" });
      }
      return json(502, { error: "could not stop the turn", code: "abort_failed" });
    }
  }
  const asyncSend =
    messagesMatch !== null && request.method === "POST" && request.query?.async === "1";
  const pagedRead = messagesMatch !== null && request.method === "GET";
  let limit: number | undefined;
  let before: string | undefined;
  if (pagedRead) {
    const rawLimit = request.query?.limit;
    if (rawLimit !== undefined) {
      limit = pageLimit(rawLimit);
      if (limit === undefined) {
        return json(400, { error: "invalid limit", code: "invalid_limit" });
      }
    }
    const rawBefore = request.query?.before;
    if (rawBefore !== undefined) {
      if (limit === undefined) {
        return json(400, { error: "before requires limit", code: "cursor_requires_limit" });
      }
      before = rawBefore.trim();
      if (before.length === 0) {
        return json(400, { error: "invalid message cursor", code: "invalid_cursor" });
      }
    }
  }
  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure(toManagedApp(found));
  } catch (error) {
    if (error instanceof DeletionPendingError) {
      return json(409, { error: error.message, code: error.code });
    }
    const mapped = lifecycleErrorResponse(error);
    if (mapped !== undefined) {
      return mapped;
    }
    const message = `agent failed to start: ${error instanceof Error ? error.message : String(error)}`;
    return asyncSend
      ? json(502, { error: message, code: "agent_unavailable", outcome: "not_sent" })
      : json(502, { error: message });
  }

  try {
    if (sessionsMatch !== null) {
      if (request.method === "GET") {
        const sessions = await listSessions(endpoint);
        const summaries = draftSummaries(
          deps.db,
          found.app.id,
          sessions.map((session) => session.id),
        );
        return json(200, {
          sessions: sessions.map((session) => ({
            ...session,
            draft: summaries.get(session.id) ?? {
              hasText: false,
              attachmentCount: 0,
              emptyDraft: false,
              updatedAt: null,
            },
          })),
        });
      }
      if (request.method === "POST") {
        return handleSessionCreate(deps, found, endpoint, request);
      }
    }
    if (sessionMatch !== null && request.method === "DELETE") {
      return await sessionLocks.run(sessionLockKey(found.app.id, sessionId), async () => {
        let ids = [sessionId];
        try {
          const listed = await listSessionsBounded(endpoint);
          if (Array.isArray(listed)) {
            ids = collectSessionSubtreeIDs(listed, sessionId);
          }
        } catch {
          // Best effort: a failed, oversized, or timed-out listing falls back to the requested id;
          // the upstream delete still cascades to descendants.
          ids = [sessionId];
        }
        try {
          await deleteSession(endpoint, sessionId);
        } catch (error) {
          if (!isSessionGone(error)) throw error;
        }
        for (const id of ids) {
          try {
            removeLocalSessionRows(deps, found, id);
          } catch {
            // Best effort per id; the upstream session is already deleted.
          }
        }
        for (const id of ids) {
          try {
            markHandoffsDeleted(deps, id);
          } catch {
            // Best effort per id; the upstream session is already deleted.
          }
        }
        return json(200, { deleted: true });
      });
    }
    if (messagesMatch !== null && request.method === "GET") {
      const project = createMessageProjector({
        db: deps.db,
        appId: found.app.id,
        appKey: found.app.appKey,
        projectId: found.project.id,
      });
      if (limit === undefined) {
        const messages = await listMessages(endpoint, sessionId, { project });
        const payload = { messages };
        if (projectedResponseBytes(payload) > PROJECTED_RESPONSE_MAX_BYTES) {
          return json(502, {
            error: "session too large to refresh",
            code: "messages_too_large",
          });
        }
        return json(200, payload);
      }
      try {
        const page = await readProjectedPage(
          endpoint,
          sessionId,
          before === undefined ? { limit, project } : { limit, before, project },
        );
        const payload = { messages: page.messages, nextCursor: page.nextCursor ?? null };
        if (projectedResponseBytes(payload) > PROJECTED_RESPONSE_MAX_BYTES) {
          return json(502, {
            error: "session too large to refresh",
            code: "messages_too_large",
          });
        }
        return json(200, payload);
      } catch (error) {
        if (error instanceof OpencodeHttpError && error.status === 400 && before !== undefined) {
          return json(400, { error: "invalid message cursor", code: "invalid_cursor" });
        }
        if (error instanceof OpencodeHttpError && error.status === 404) {
          return json(404, { error: "session not found", code: "session_not_found" });
        }
        if (error instanceof OpencodeHttpError && error.code === "messages_too_large") {
          return json(502, {
            error: "session too large to refresh",
            code: "messages_too_large",
          });
        }
        if (error instanceof OpencodeHttpError && error.code === "history_busy") {
          return json(503, {
            error: "history is busy; retry shortly",
            code: "history_busy",
          });
        }
        throw error;
      }
    }
    if (messagesMatch !== null && request.method === "POST") {
      let body: { text?: unknown; attachments?: unknown; streamID?: unknown };
      try {
        body = JSON.parse(request.body ?? "{}") as { text?: unknown; attachments?: unknown };
      } catch {
        return json(400, { error: "invalid JSON body", code: "invalid_json" });
      }
      const text = typeof body.text === "string" ? body.text : "";
      const requested = parseRequestedAttachments(body.attachments);
      if (body.attachments !== undefined && requested === undefined) {
        return json(400, {
          error: "invalid attachment item",
          code: "invalid_attachment_item",
        });
      }
      if (requested !== undefined && requested.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return json(400, {
          error: "too many attachments",
          code: "too_many_attachments",
        });
      }
      if (text.trim().length === 0 && (requested === undefined || requested.length === 0)) {
        return json(400, { error: "empty message", code: "empty_message" });
      }
      if (Buffer.byteLength(text, "utf8") > 32 * 1024) {
        return json(400, { error: "message too large", code: "message_too_large" });
      }
      const streamID =
        typeof body.streamID === "string"
          ? body.streamID
          : request.headers["x-hanse-stream"]?.trim() || undefined;
      return dispatchTextSend(
        deps,
        found,
        endpoint,
        sessionId,
        text,
        asyncSend,
        requested,
        streamID,
      );
    }
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.code === "messages_too_large") {
      return json(502, { error: "session too large to refresh", code: "messages_too_large" });
    }
    if (error instanceof OpencodeHttpError && error.code === "history_busy") {
      return json(503, { error: "history is busy; retry shortly", code: "history_busy" });
    }
    return json(502, { error: error instanceof Error ? error.message : String(error) });
  }
  return json(405, { error: "method not allowed" });
}
