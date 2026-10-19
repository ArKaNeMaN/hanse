import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Handoff } from "../coordinator/handoff.js";
import type { Principal } from "../identity/principals.js";
import {
  createSession,
  deleteSession,
  listMessages,
  listSessions,
  OpencodeHttpError,
  sendPrompt,
  sendPromptAsync,
} from "../opencode/client.js";
import type { RegisteredApp } from "../registry/index.js";
import { appDir, findApp } from "./apps.js";
import { humanFrom, principalFrom } from "./auth.js";
import { buildSite, type PageChrome, renderNotFound, type SiteModel } from "./dashboard.js";
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
  });
}

function renderChatPage(
  site: SiteModel,
  found: { project: { id: string; name: string; rootPath: string }; app: RegisteredApp },
  principal: Principal,
  chrome: PageChrome,
): string {
  const { project, app } = found;
  const ref = site.apps.get(app.id);
  const runtime = site.runtime.get(app.id) ?? "stopped";
  const handoffs = contextHandoffs(site, app.id);
  const path = ref?.path ?? app.path;
  const folder = appDir(project, app);
  const appHref = `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}`;
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
    <div class="chat-sessions__list" id="session-list" aria-live="polite">
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
      <span class="chat-working" id="chat-working" hidden><span class="spinner" aria-hidden="true" data-chat-working-spinner></span><span class="chat-working__label" id="chat-working-label" role="status" aria-live="polite" aria-atomic="true">Ready</span><span class="chat-working__elapsed" id="chat-working-elapsed" aria-hidden="true" hidden></span><span class="chat-working__queued" id="chat-working-queued" aria-hidden="true" hidden></span></span>
      <button class="btn btn-ghost btn-sm chat-retry" id="chat-stream-retry" type="button" hidden>${icon("refresh")}Retry</button>
    </div>
    <div class="policy-warning" id="chat-policy-warning" role="status" hidden></div>
    <div class="chat-thread__viewport">
      <div class="chat-thread__scroll" id="chat-scroll">
        <div class="chat-thread__inner" id="chat-messages" role="log" aria-live="off">
          <div class="skeleton-stack" aria-hidden="true">
            <span class="skeleton skeleton--title"></span>
            <span class="skeleton"></span>
            <span class="skeleton skeleton--short"></span>
            <span class="skeleton"></span>
            <span class="skeleton skeleton--short"></span>
          </div>
        </div>
        <div class="chat-question-placeholder" id="chat-question-placeholder"></div>
      </div>
      <button class="btn btn-secondary btn-sm chat-new-messages" id="chat-new-messages" type="button" hidden>New messages ${icon("arrow-right")}</button>
    </div>
    <div class="chat-queue-strip" id="chat-queue-strip" hidden>
      <span class="chat-queue-strip__count" id="chat-queue-strip-count" role="status" aria-live="polite" aria-atomic="true"></span>
      <ol class="chat-queue-strip__list" id="chat-queue-strip-list"></ol>
    </div>
    <p class="chat-session-notice" id="chat-session-notice" role="status" hidden>Session too large to refresh; showing the last loaded state.</p>
    <section class="prompt-dock" id="chat-prompt-dock" aria-label="Agent requests" hidden></section>
    <form class="composer" id="chat-composer" data-no-busy>
      <div class="composer__row">
        <label class="sr-only" for="chat-prompt">Message ${escapeHtml(app.appKey)} agent</label>
        <textarea class="textarea" id="chat-prompt" name="prompt" rows="1" required placeholder="Message ${escapeHtml(app.appKey)} agent" aria-describedby="chat-composer-hint"></textarea>
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
          <a class="btn btn-ghost btn-sm" href="/projects/${encodeURIComponent(project.id)}">Open project</a>
        </div>
      </section>
      <hr class="rule" />
      <section class="chat-context__section chat-plan-section" id="chat-plan-section" aria-labelledby="context-plan-title">
        <div class="cluster summary-row"><h2 class="overline" id="context-plan-title" tabindex="-1">Plan</h2><span class="caption" id="chat-plan-summary">No plan yet</span></div>
        <p class="chat-plan__empty" id="chat-plan-empty">Send a message to start a session.</p>
        <ul class="chat-plan__list" id="chat-plan-list" hidden></ul>
      </section>
      <hr class="rule" />
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
    operatorName: principal.name,
    notice: chrome.notice,
    header: "",
    pageClass: "page--chat",
    bodyClass: "page__body--chat",
    moduleScripts: ["/assets/chat.js"],
    topbarActions,
    body: `<div class="chat-shell chat-shell--workspace" id="chat-shell" data-app-key="${escapeHtml(app.appKey)}" data-project-id="${escapeHtml(project.id)}" data-app-initials="${escapeHtml(initials(app.appKey))}" data-operator-initials="${escapeHtml(initials(principal.name))}" data-chat-sessions="closed" data-chat-context="closed">
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
  const match = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/events$/.exec(request.path);
  const found = findApp(deps, projectParam(request), safeDecode(match?.[1] ?? ""));
  if (found === undefined || deps.manager === undefined) {
    response.writeHead(404);
    response.end();
    return;
  }
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure({
      id: found.app.id,
      projectId: found.project.id,
      appKey: found.app.appKey,
      appDir: appDir(found.project, found.app),
    });
  } catch {
    response.writeHead(502);
    response.end();
    return;
  }
  const upstream = await fetch(`${endpoint}/event`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  }).catch(() => undefined);
  if (upstream === undefined || !upstream.ok || upstream.body === null) {
    response.writeHead(502);
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      response.write(Buffer.from(value));
    }
  } catch {
    controller.abort();
  }
  response.end();
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
      const first = site.projects.flatMap((project) =>
        project.apps.map((app) => ({ project, app })),
      )[0];
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
    return html(200, renderChatPage(site, found, principal, chrome));
  }

  const sessionsMatch = /^\/api\/apps\/([^/]+)\/sessions$/.exec(request.path);
  const sessionMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)$/.exec(request.path);
  const messagesMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(request.path);
  if (sessionsMatch === null && sessionMatch === null && messagesMatch === null) {
    return json(404, { error: "not found" });
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (deps.manager === undefined) {
    return json(503, { error: "agent runtime is not configured" });
  }
  if (sessionMatch !== null && request.method === "DELETE" && principal.kind !== "human") {
    return json(403, { error: "only a human principal may delete a session" });
  }

  const appKey = safeDecode((sessionsMatch ?? sessionMatch ?? messagesMatch)?.[1] ?? "");
  const found = findApp(deps, projectId, appKey);
  if (found === undefined) {
    return json(404, { error: `unknown application: ${appKey}`, code: "unknown_app" });
  }
  const asyncSend =
    messagesMatch !== null && request.method === "POST" && request.query?.async === "1";
  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure({
      id: found.app.id,
      projectId: found.project.id,
      appKey: found.app.appKey,
      appDir: appDir(found.project, found.app),
    });
  } catch (error) {
    const message = `agent failed to start: ${error instanceof Error ? error.message : String(error)}`;
    return asyncSend
      ? json(502, { error: message, code: "agent_unavailable", outcome: "not_sent" })
      : json(502, { error: message });
  }

  try {
    if (sessionsMatch !== null) {
      if (request.method === "GET") {
        return json(200, { sessions: await listSessions(endpoint) });
      }
      if (request.method === "POST") {
        return json(200, await createSession(endpoint));
      }
    }
    if (sessionMatch !== null && request.method === "DELETE") {
      await deleteSession(endpoint, safeDecode(sessionMatch[2] ?? ""));
      return json(200, { deleted: true });
    }
    if (messagesMatch !== null && request.method === "GET") {
      const sessionId = safeDecode(messagesMatch[2] ?? "");
      return json(200, { messages: await listMessages(endpoint, sessionId) });
    }
    if (messagesMatch !== null && request.method === "POST") {
      const sessionId = safeDecode(messagesMatch[2] ?? "");
      if (asyncSend) {
        let body: { text?: unknown };
        try {
          body = JSON.parse(request.body ?? "{}") as { text?: unknown };
        } catch {
          return json(400, { error: "invalid JSON body", code: "invalid_json" });
        }
        const text = typeof body.text === "string" ? body.text : "";
        if (text.trim().length === 0) {
          return json(400, { error: "empty message", code: "empty_message" });
        }
        if (Buffer.byteLength(text, "utf8") > 32 * 1024) {
          return json(400, { error: "message too large", code: "message_too_large" });
        }
        const messageID = `msg_${randomUUID().replaceAll("-", "")}`;
        try {
          await sendPromptAsync(endpoint, sessionId, text, messageID);
        } catch (error) {
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
        return json(202, { accepted: true, messageID, sessionID: sessionId });
      }
      const body = JSON.parse(request.body ?? "{}") as { text?: string };
      const text = typeof body.text === "string" ? body.text : "";
      if (text.length === 0) {
        return json(400, { error: "empty message" });
      }
      return json(200, { message: await sendPrompt(endpoint, sessionId, text) });
    }
  } catch (error) {
    if (error instanceof OpencodeHttpError && error.code === "messages_too_large") {
      return json(502, { error: "session too large to refresh", code: "messages_too_large" });
    }
    return json(502, { error: error instanceof Error ? error.message : String(error) });
  }
  return json(405, { error: "method not allowed" });
}
