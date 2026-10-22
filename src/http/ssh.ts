import type { Principal } from "../identity/principals.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import {
  type SshAuditEntry,
  SshError,
  type SshHostView,
  type SshTestResult,
} from "../ssh/types.js";
import { findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import { buildSite, type PageChrome } from "./dashboard.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import {
  absoluteTime,
  appShell,
  emptyState,
  escapeHtml,
  icon,
  pageHeader,
  safeLocalPath,
  timeAgo,
  timeTag,
} from "./ui.js";

const JSON_HEADERS = { "cache-control": "no-store" };

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { ...JSON_HEADERS },
  };
}

function html(status: number, body: string): HttpResponse {
  return {
    status,
    contentType: "text/html; charset=utf-8",
    body,
    headers: { ...JSON_HEADERS },
  };
}

function redirect(
  location: string,
  message?: string,
  tone: "success" | "error" = "success",
): HttpResponse {
  let target = location;
  if (message !== undefined) {
    const hashIndex = target.indexOf("#");
    const hash = hashIndex >= 0 ? target.slice(hashIndex) : "";
    const base = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const [pathname, query = ""] = base.split("?", 2);
    const params = new URLSearchParams(query);
    params.set("notice", message);
    params.set("tone", tone);
    target = `${pathname}?${params.toString()}${hash}`;
  }
  return {
    status: 303,
    contentType: "text/plain",
    body: "",
    headers: { location: target, ...JSON_HEADERS },
  };
}

function form(body: string | undefined): URLSearchParams {
  return new URLSearchParams(body ?? "");
}

function requestPath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.set(key, value);
  }
  const query = params.toString();
  return query.length === 0 ? request.path : `${request.path}?${query}`;
}

function wantsHtml(request: HttpRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function auth(
  deps: HttpDeps,
  request: HttpRequest,
): { principal: Principal } | { response: HttpResponse } {
  const principal = principalFrom(deps, request);
  if (principal?.kind === "human") {
    return { principal };
  }
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  if (
    bearer !== undefined &&
    bearer.length > 0 &&
    verifyAgentToken(deps.db, bearer) !== undefined
  ) {
    return { response: json(403, { error: "agent tokens may not use the SSH API" }) };
  }
  if (wantsHtml(request) || request.path === "/ssh") {
    return { response: redirect(`/login?next=${encodeURIComponent(requestPath(request))}`) };
  }
  return { response: json(principal === undefined ? 401 : 403, { error: "unauthorized" }) };
}

function noticeFrom(request: HttpRequest): PageChrome["notice"] {
  const message = request.query?.notice;
  if (message === undefined || message.trim().length === 0) return undefined;
  return {
    message,
    tone: request.query?.tone === "error" ? ("error" as const) : ("success" as const),
  };
}

interface SshPageExtra {
  test?: SshTestResult & {
    hostId: string;
    hostName: string;
    prepareRePin?: boolean;
  };
  error?: { message: string; target: string; values?: Record<string, string> };
  openAdd?: boolean;
}

const IDLE_OPTIONS = [300, 900, 1800, 3600, 7200] as const;

function scopePath(projectId: string, appKey: string, hash?: string): string {
  const base =
    projectId.length > 0 && appKey.length > 0
      ? `/ssh?target=${encodeURIComponent(`${projectId}:${appKey}`)}`
      : "/ssh";
  return hash === undefined ? base : `${base}${hash}`;
}

function resolveScope(
  deps: HttpDeps,
  request: HttpRequest,
): { projectId: string; appKey: string; found: ReturnType<typeof findApp> } {
  const target = request.query?.target ?? "";
  let projectId = request.query?.project ?? "";
  let appKey = request.query?.app ?? "";
  if (target.length > 0) {
    const separator = target.indexOf(":");
    if (separator > 0) {
      projectId = target.slice(0, separator);
      appKey = target.slice(separator + 1);
    }
  }
  const found =
    projectId.length > 0 && appKey.length > 0 ? findApp(deps, projectId, appKey) : undefined;
  if (found === undefined) {
    return { projectId: "", appKey: "", found: undefined };
  }
  return { projectId: found.project.id, appKey: found.app.appKey, found };
}

function formValues(fields: URLSearchParams): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of [
    "name",
    "address",
    "port",
    "username",
    "remoteRoot",
    "requireApproval",
    "approvalIdleSec",
  ]) {
    const value = fields.get(key);
    if (value !== null) values[key] = value;
  }
  return values;
}

function queryFromReturn(returnTo: string): Record<string, string> {
  const base = returnTo.split("#")[0] ?? returnTo;
  const index = base.indexOf("?");
  return index < 0 ? {} : Object.fromEntries(new URLSearchParams(base.slice(index + 1)));
}

function shortFingerprint(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "Not set";
  return value.length <= 28 ? value : `${value.slice(0, 20)}…${value.slice(-8)}`;
}

function timeUntil(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return timeAgo(iso, now);
  if (seconds < 45) return "in a moment";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function expiryTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(absoluteTime(iso))}">${escapeHtml(timeUntil(iso))}</time>`;
}

function idleOptions(selected: number): string {
  const options: number[] = [...IDLE_OPTIONS];
  if (Number.isFinite(selected) && !options.includes(selected)) {
    options.push(selected);
    options.sort((left, right) => left - right);
  }
  return options
    .map((seconds) => {
      const label = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
      return `<option value="${seconds}"${seconds === selected ? " selected" : ""}>${label}</option>`;
    })
    .join("");
}

function hostPinState(host: SshHostView): "pinned" | "unpinned" | "mismatch" {
  if (host.hostKeyMismatchAt !== null) return "mismatch";
  return host.hostKeyFingerprint === null ? "unpinned" : "pinned";
}

function hostPinPill(host: SshHostView): string {
  const state = hostPinState(host);
  if (state === "mismatch") {
    return `<span class="status" data-state="failed">${icon("alert-triangle")}Host key changed</span>`;
  }
  if (state === "unpinned") {
    return `<span class="status" data-state="queued">${icon("clock")}Not pinned</span>`;
  }
  return `<span class="status" data-state="delivered">${icon("check")}Pinned</span>`;
}

function grantStatePill(grant: NonNullable<SshHostView["grant"]>, nowMs: number): string {
  if (grant.revokedAt !== null) {
    return `<span class="status" data-state="cancelled">${icon("slash")}Revoked</span>`;
  }
  if (Date.parse(grant.idleExpiresAt) <= nowMs || Date.parse(grant.absoluteExpiresAt) <= nowMs) {
    return `<span class="status" data-state="expired">${icon("hourglass")}Expired</span>`;
  }
  return `<span class="status" data-state="delivered">${icon("check")}Active</span>`;
}

function auditResult(entry: SshAuditEntry): string {
  if (entry.finishedAt === null) {
    return `<span class="badge badge-info">${icon("activity", "icon--sm")}running</span>`;
  }
  if (entry.errorCode !== null) {
    return `<span class="badge badge-error">${icon("alert-triangle", "icon--sm")}${escapeHtml(entry.errorCode)}</span>`;
  }
  if (entry.exitCode === 0) {
    return `<span class="badge badge-success">${icon("check", "icon--sm")}ok</span>`;
  }
  if (entry.exitCode !== null) {
    return `<span class="badge badge-error">${icon("alert-triangle", "icon--sm")}exit ${entry.exitCode}</span>`;
  }
  return `<span class="badge badge-ghost">recorded</span>`;
}

function testPanel(test: NonNullable<SshPageExtra["test"]>): string {
  const tone = test.ok ? "success" : "failed";
  const rows: string[] = [];
  if (test.fingerprint !== undefined) {
    rows.push(
      `<div><dt>Presented</dt><dd class="ssh-fingerprint">${escapeHtml(test.fingerprint)}</dd></div>`,
    );
  }
  if (test.previousFingerprint !== null && test.previousFingerprint !== undefined) {
    rows.push(
      `<div><dt>Previously pinned</dt><dd class="ssh-fingerprint">${escapeHtml(test.previousFingerprint)}</dd></div>`,
    );
  }
  const details = rows.length === 0 ? "" : `<dl class="ssh-test__facts">${rows.join("")}</dl>`;
  const mismatch =
    test.mismatch === true
      ? `<p class="ssh-test__note">${icon("alert-triangle", "icon--sm")}The presented host key does not match the pin. The connection failed closed. Verify the change out-of-band before preparing a re-pin.</p>`
      : "";
  const banner =
    test.serverBanner === undefined
      ? ""
      : `<p class="ssh-test__note mono">${escapeHtml(test.serverBanner)}</p>`;
  const repin =
    test.ok === true && test.prepareRePin === true && test.fingerprint !== undefined
      ? `<div class="ssh-warning">${icon("alert-triangle")}<div class="stack--tight"><p class="hint">A 10-minute re-pin observation was recorded. Verify this fingerprint out-of-band (provider console or a trusted network path), then submit the re-pin form below with the exact value.</p><p class="ssh-fingerprint">${escapeHtml(test.fingerprint)}</p></div></div>`
      : "";
  return `<div class="ssh-test" data-tone="${tone}" role="${test.ok ? "status" : "alert"}">
    <p class="ssh-test__head">${icon(test.ok ? "check" : "alert-triangle")}${test.ok ? "Authenticated" : "Test failed"}</p>
    ${test.ok ? "" : `<p class="ssh-test__note">${escapeHtml(test.message ?? "The host could not be reached.")}</p>`}
    ${details}
    ${mismatch}
    ${banner}
    ${repin}
  </div>`;
}

function hostCard(
  host: SshHostView,
  options: {
    scoped: boolean;
    scopeHref: string;
    test?: NonNullable<SshPageExtra["test"]>;
    error?: SshPageExtra["error"];
  },
): string {
  const pinState = hostPinState(host);
  const anchor = `ssh-host-${host.id}`;
  const returnTo = escapeHtml(`${options.scopeHref}#${anchor}`);
  const hostKey = host.hostKeyFingerprint;
  const clientKey = host.credential?.fingerprint ?? null;
  const isTestTarget = options.test?.hostId === host.id;
  const isErrorTarget = options.error?.target === `host:${host.id}`;
  const prepare = isTestTarget && options.test?.prepareRePin === true;
  const repinValue =
    prepare && options.test?.fingerprint !== undefined ? escapeHtml(options.test.fingerprint) : "";
  const keyOpen = prepare || pinState === "mismatch";
  const approvalBadge = host.requireApproval
    ? `<span class="badge">${icon("stamp", "icon--sm")}Approval</span>`
    : `<span class="badge badge-ghost">${icon("check", "icon--sm")}Direct</span>`;
  const access = options.scoped
    ? `<div class="ssh-host__access">
        <span class="badge ${host.allowed ? "badge-success" : "badge-ghost"}">${host.allowed ? "Allowed" : "Not allowed"}</span>
        ${host.pendingApprovals > 0 ? `<span class="badge badge-warning">${host.pendingApprovals} pending</span>` : ""}
        ${host.grant === null ? "" : `<span class="ssh-host__grant">Grant active · idle expires ${expiryTag(host.grant.idleExpiresAt)}</span>`}
      </div>`
    : "";
  const pinPinnedAt =
    host.hostKeyPinnedAt === null
      ? "This host is not pinned yet; the first successful test pins it (TOFU)."
      : `Pinned ${timeTag(host.hostKeyPinnedAt)}`;
  const mismatchNote =
    host.hostKeyMismatchAt === null
      ? ""
      : `<p class="field-error" role="alert">${icon("alert-triangle")}A presented key did not match at ${escapeHtml(absoluteTime(host.hostKeyMismatchAt))}. Connections fail closed until you re-pin.</p>`;
  return `<article class="card ssh-host" id="${escapeHtml(anchor)}" data-pin="${pinState}" aria-labelledby="${escapeHtml(anchor)}-title">
    <div class="ssh-host__body">
      <div class="ssh-host__head">
        <div class="ssh-host__ident">
          <h3 class="ssh-host__name" id="${escapeHtml(anchor)}-title">${escapeHtml(host.name)}</h3>
          <p class="ssh-host__addr mono">${escapeHtml(host.username)}@${escapeHtml(host.address)}:${host.port}</p>
        </div>
        <div class="cluster">${hostPinPill(host)}${approvalBadge}</div>
      </div>
      <dl class="ssh-host__facts">
        <div class="ssh-host__fact"><dt>Remote root</dt><dd class="mono">${host.remoteRoot === null ? "Unrestricted" : escapeHtml(host.remoteRoot)}</dd></div>
        <div class="ssh-host__fact"><dt>Host key</dt><dd><span class="mono" title="${escapeHtml(hostKey ?? "")}">${escapeHtml(shortFingerprint(hostKey))}</span></dd></div>
        <div class="ssh-host__fact"><dt>Client key</dt><dd><span class="mono" title="${escapeHtml(clientKey ?? "")}">${escapeHtml(shortFingerprint(clientKey))}</span></dd></div>
        <div class="ssh-host__fact"><dt>Approval idle</dt><dd>${host.requireApproval ? `${Math.round(host.approvalIdleSec / 60)} min` : "Not required"}</dd></div>
      </dl>
      ${access}
      ${isErrorTarget ? `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(options.error?.message ?? "The action failed.")}</p>` : ""}
      ${isTestTarget && options.test !== undefined ? testPanel(options.test) : ""}
      <details class="disclosure ssh-host__key"${keyOpen ? " open" : ""}>
        <summary><span class="cluster">Host key <span class="mono">${escapeHtml(shortFingerprint(hostKey))}</span></span>${icon("chevron-down", "disclosure__chevron")}</summary>
        <div class="stack--tight">
          <div>
            <p class="label">Pinned fingerprint</p>
            <p class="ssh-fingerprint">${hostKey === null ? "Not pinned" : escapeHtml(hostKey)}</p>
          </div>
          <p class="hint">${pinPinnedAt}</p>
          ${mismatchNote}
          <form method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/test">
            <input type="hidden" name="return_to" value="${returnTo}" />
            <input type="hidden" name="ignorePin" value="1" />
            <button class="btn btn-secondary btn-sm" type="submit">${icon("refresh")}Prepare re-pin</button>
          </form>
          <form class="stack--tight" method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/re-pin">
            <input type="hidden" name="return_to" value="${returnTo}" />
            <div class="field">
              <label class="label" for="ssh-repin-${escapeHtml(host.id)}">Observed fingerprint</label>
              <input class="input mono" id="ssh-repin-${escapeHtml(host.id)}" name="fingerprint" value="${repinValue}" placeholder="SHA256:..." required aria-describedby="ssh-repin-${escapeHtml(host.id)}-hint" />
              <p class="hint" id="ssh-repin-${escapeHtml(host.id)}-hint">Run Prepare re-pin first, verify the fingerprint independently, then submit the exact observed value.</p>
            </div>
            <button class="btn btn-secondary btn-sm" type="submit">Re-pin host key</button>
          </form>
        </div>
      </details>
      <div class="ssh-host__actions">
        <form method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/test">
          <input type="hidden" name="return_to" value="${returnTo}" />
          <button class="btn btn-secondary btn-sm" type="submit">${icon("activity")}Test connection</button>
        </form>
        <button class="btn btn-secondary btn-sm" type="button" data-dialog-open="ssh-edit-${escapeHtml(host.id)}">${icon("settings")}Edit host</button>
      </div>
    </div>
  </article>`;
}

function addHostDialog(options: {
  open: boolean;
  values: Record<string, string>;
  error?: string;
  returnTo: string;
}): string {
  const values = options.values;
  const requireApproval = values.requireApproval !== "0";
  const idle = Number(values.approvalIdleSec ?? "1800");
  const error =
    options.error === undefined
      ? ""
      : `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(options.error)}</p>`;
  return `<dialog class="dialog ssh-dialog" id="ssh-add-dialog" aria-labelledby="ssh-add-title"${options.open ? " open" : ""}>
    <div class="dialog__frame">
      <form class="dialog__form" method="post" action="/ssh/hosts">
        <header class="dialog__head">
          <h2 class="dialog__title" id="ssh-add-title">Add SSH host</h2>
          <p class="dialog__meta">Coordinator-held key · per-application access</p>
        </header>
        <div class="dialog__body">
          ${error}
          <input type="hidden" name="return_to" value="${escapeHtml(options.returnTo)}" />
          <fieldset class="ssh-form__group">
            <legend class="overline">Connection</legend>
            <div class="ssh-form__grid">
              <div class="field">
                <label class="label" for="ssh-add-name">Name (required)</label>
                <input class="input" id="ssh-add-name" name="name" value="${escapeHtml(values.name ?? "")}" required />
              </div>
              <div class="field">
                <label class="label" for="ssh-add-address">Address (required)</label>
                <input class="input" id="ssh-add-address" name="address" value="${escapeHtml(values.address ?? "")}" placeholder="10.0.0.12" required aria-describedby="ssh-add-address-hint" />
                <p class="hint" id="ssh-add-address-hint">Hostname or IP reachable from the coordinator.</p>
              </div>
              <div class="field">
                <label class="label" for="ssh-add-port">Port</label>
                <input class="input" id="ssh-add-port" name="port" type="number" min="1" max="65535" value="${escapeHtml(values.port ?? "22")}" required />
              </div>
              <div class="field">
                <label class="label" for="ssh-add-username">User (required)</label>
                <input class="input" id="ssh-add-username" name="username" value="${escapeHtml(values.username ?? "")}" placeholder="deploy" required />
              </div>
              <div class="field ssh-form__full">
                <label class="label" for="ssh-add-remote-root">Remote root (optional)</label>
                <input class="input mono" id="ssh-add-remote-root" name="remoteRoot" value="${escapeHtml(values.remoteRoot ?? "")}" placeholder="/srv/app" aria-describedby="ssh-add-remote-root-hint" />
                <p class="hint" id="ssh-add-remote-root-hint">Confines SFTP transfers only. Commands are not confined to this directory.</p>
              </div>
            </div>
            <div class="ssh-warning">${icon("alert-triangle")}<p class="hint">Never target the coordinator host, a host that can read coordinator state, the Docker socket, or any host whose compromise grants control of this deployment.</p></div>
          </fieldset>
          <fieldset class="ssh-form__group">
            <legend class="overline">Private key</legend>
            <div class="field">
              <label class="label" for="ssh-add-private-key">Private key (required)</label>
              <textarea class="textarea mono" id="ssh-add-private-key" name="privateKey" rows="5" required spellcheck="false" aria-describedby="ssh-add-private-key-hint"></textarea>
              <p class="hint" id="ssh-add-private-key-hint">Unencrypted OpenSSH key. It is sealed in the coordinator and never shown again; only the derived public key is displayed.</p>
            </div>
            <div class="field">
              <label class="label" for="ssh-add-key-file">Load from file (optional)</label>
              <input class="input" id="ssh-add-key-file" type="file" data-ssh-key-file data-ssh-key-target="ssh-add-private-key" aria-describedby="ssh-add-key-file-hint" />
              <p class="hint" id="ssh-add-key-file-hint">Browser-local convenience: the file is read into the field above and posted with the form.</p>
            </div>
          </fieldset>
          <fieldset class="ssh-form__group">
            <legend class="overline">Access policy</legend>
            <label class="check"><input class="checkbox" type="checkbox" name="requireApproval" value="1"${requireApproval ? " checked" : ""} /><span>Ask for approval before each session</span></label>
            <input type="hidden" name="requireApproval" value="0" />
            <div class="field">
              <label class="label" for="ssh-add-idle">Idle grant</label>
              <select class="select" id="ssh-add-idle" name="approvalIdleSec" aria-describedby="ssh-add-idle-hint">${idleOptions(idle)}</select>
              <p class="hint" id="ssh-add-idle-hint">How long an approved session stays usable without another request. The absolute cap is 8 hours.</p>
            </div>
          </fieldset>
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit">Add host</button>
        </footer>
      </form>
    </div>
  </dialog>`;
}

function editHostDialog(
  host: SshHostView,
  options: {
    open: boolean;
    values: Record<string, string>;
    error?: string;
    returnTo: string;
  },
): string {
  const id = escapeHtml(host.id);
  const values = options.values;
  const requireApproval =
    values.requireApproval === undefined ? host.requireApproval : values.requireApproval !== "0";
  const idle = Number(values.approvalIdleSec ?? String(host.approvalIdleSec));
  const error =
    options.error === undefined
      ? ""
      : `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(options.error)}</p>`;
  const credential = host.credential;
  const publicKey =
    credential === null
      ? `<p class="hint">No client key is stored for this host.</p>`
      : `<div class="ssh-public-key">
          <div class="ssh-key-meta">
            <span class="overline">Client public key</span>
            <button class="btn btn-ghost btn-sm" type="button" data-ssh-copy="ssh-pub-${id}" aria-label="Copy public key">${icon("copy")}Copy</button>
          </div>
          <code id="ssh-pub-${id}" class="ssh-fingerprint">${escapeHtml(credential.publicKey)}</code>
          <div class="ssh-key-meta">
            <span class="badge badge--mono">${escapeHtml(credential.keyType)}</span>
            ${credential.bits === null ? "" : `<span class="badge badge--mono">${credential.bits} bits</span>`}
            <span class="mono">${escapeHtml(credential.fingerprint)}</span>
          </div>
          <p class="hint">Install this public key on the remote account before testing the connection.</p>
        </div>`;
  const pinnedAt =
    host.hostKeyPinnedAt === null
      ? "The next successful test pins it (TOFU)."
      : `Pinned ${absoluteTime(host.hostKeyPinnedAt)}`;
  return `<dialog class="dialog ssh-dialog" id="ssh-edit-${id}" aria-labelledby="ssh-edit-${id}-title"${options.open ? " open" : ""}>
    <div class="dialog__frame">
      <form class="dialog__form" method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/update">
        <header class="dialog__head">
          <h2 class="dialog__title" id="ssh-edit-${id}-title">Edit ${escapeHtml(host.name)}</h2>
          <p class="dialog__meta">${escapeHtml(host.username)}@${escapeHtml(host.address)}:${host.port}</p>
        </header>
        <div class="dialog__body">
          ${error}
          <input type="hidden" name="return_to" value="${escapeHtml(options.returnTo)}" />
          <fieldset class="ssh-form__group">
            <legend class="overline">Connection</legend>
            <div class="ssh-form__grid">
              <div class="field">
                <label class="label" for="ssh-edit-${id}-name">Name (required)</label>
                <input class="input" id="ssh-edit-${id}-name" name="name" value="${escapeHtml(values.name ?? host.name)}" required />
              </div>
              <div class="field">
                <label class="label" for="ssh-edit-${id}-address">Address (required)</label>
                <input class="input" id="ssh-edit-${id}-address" name="address" value="${escapeHtml(values.address ?? host.address)}" required />
              </div>
              <div class="field">
                <label class="label" for="ssh-edit-${id}-port">Port</label>
                <input class="input" id="ssh-edit-${id}-port" name="port" type="number" min="1" max="65535" value="${escapeHtml(values.port ?? String(host.port))}" required />
              </div>
              <div class="field">
                <label class="label" for="ssh-edit-${id}-username">User (required)</label>
                <input class="input" id="ssh-edit-${id}-username" name="username" value="${escapeHtml(values.username ?? host.username)}" required />
              </div>
              <div class="field ssh-form__full">
                <label class="label" for="ssh-edit-${id}-remote-root">Remote root (optional)</label>
                <input class="input mono" id="ssh-edit-${id}-remote-root" name="remoteRoot" value="${escapeHtml(values.remoteRoot ?? host.remoteRoot ?? "")}" placeholder="/srv/app" aria-describedby="ssh-edit-${id}-remote-root-hint" />
                <p class="hint" id="ssh-edit-${id}-remote-root-hint">Confines SFTP transfers only. Commands are not confined to this directory.</p>
              </div>
            </div>
          </fieldset>
          <fieldset class="ssh-form__group">
            <legend class="overline">Private key</legend>
            ${publicKey}
            <div class="field">
              <label class="label" for="ssh-edit-${id}-private-key">Replace private key (optional)</label>
              <textarea class="textarea mono" id="ssh-edit-${id}-private-key" name="privateKey" rows="4" spellcheck="false" aria-describedby="ssh-edit-${id}-private-key-hint"></textarea>
              <p class="hint" id="ssh-edit-${id}-private-key-hint">Leave empty to keep the current key. The private key is write-only and never rendered.</p>
            </div>
            <div class="field">
              <label class="label" for="ssh-edit-${id}-key-file">Load replacement from file (optional)</label>
              <input class="input" id="ssh-edit-${id}-key-file" type="file" data-ssh-key-file data-ssh-key-target="ssh-edit-${id}-private-key" />
            </div>
          </fieldset>
          <fieldset class="ssh-form__group">
            <legend class="overline">Access policy</legend>
            <label class="check"><input class="checkbox" type="checkbox" name="requireApproval" value="1"${requireApproval ? " checked" : ""} /><span>Ask for approval before each session</span></label>
            <input type="hidden" name="requireApproval" value="0" />
            <div class="field">
              <label class="label" for="ssh-edit-${id}-idle">Idle grant</label>
              <select class="select" id="ssh-edit-${id}-idle" name="approvalIdleSec" aria-describedby="ssh-edit-${id}-idle-hint">${idleOptions(idle)}</select>
              <p class="hint" id="ssh-edit-${id}-idle-hint">Applies to newly approved sessions. The absolute cap is 8 hours.</p>
            </div>
          </fieldset>
          <fieldset class="ssh-form__group">
            <legend class="overline">Host key</legend>
            <div>
              <p class="label">Pinned fingerprint</p>
              <p class="ssh-fingerprint">${host.hostKeyFingerprint === null ? "Not pinned" : escapeHtml(host.hostKeyFingerprint)}</p>
            </div>
            <p class="hint">${escapeHtml(pinnedAt)}</p>
            ${host.hostKeyMismatchAt === null ? "" : `<p class="field-error" role="alert">${icon("alert-triangle")}Mismatch observed at ${escapeHtml(absoluteTime(host.hostKeyMismatchAt))}. Connections fail closed until re-pinned.</p>`}
            <p class="hint">Changing the address or port clears the pin. Use Test connection and Prepare re-pin on the host card to change it.</p>
          </fieldset>
          <fieldset class="ssh-form__group ssh-form__group--danger">
            <legend class="overline">Danger zone</legend>
            <p class="hint">Deleting this host removes its sealed key and every per-application grant. Audit history is kept.</p>
            <div class="cluster">
              <button class="btn btn-danger btn-sm" type="submit" form="ssh-delete-${id}">${icon("trash")}Delete host</button>
            </div>
          </fieldset>
        </div>
        <footer class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-primary" type="submit">Save host</button>
        </footer>
      </form>
      <form id="ssh-delete-${id}" method="post" action="/ssh/hosts/${encodeURIComponent(host.id)}/delete" data-ssh-confirm="Delete this SSH host? Its sealed key and every application grant are removed.">
        <input type="hidden" name="return_to" value="${escapeHtml(`${scopePathFromReturn(options.returnTo)}#ssh-hosts`)}" />
      </form>
    </div>
  </dialog>`;
}

function scopePathFromReturn(returnTo: string): string {
  const hashIndex = returnTo.indexOf("#");
  return hashIndex < 0 ? returnTo : returnTo.slice(0, hashIndex);
}

function renderPage(
  deps: HttpDeps,
  request: HttpRequest,
  principal: Principal,
  extra?: SshPageExtra,
): HttpResponse {
  const ssh = deps.ssh;
  if (ssh === undefined) return html(503, "SSH is not configured");
  const site = buildSite(deps);
  const scope = resolveScope(deps, request);
  const found = scope.found;
  const agent =
    found === undefined
      ? undefined
      : { appId: found.app.id, projectId: found.project.id, appKey: found.app.appKey };
  const hosts = ssh.listAllHosts();
  const views = agent === undefined ? [] : ssh.listHosts(agent);
  const viewById = new Map(views.map((view) => [view.id, view]));
  const allowed = new Set(views.map((view) => view.id));
  const grants = found === undefined ? [] : ssh.listGrants(found.app.id);
  const pending = ssh.listPending(found?.app.id);
  const audit = ssh.listAudit(found?.app.id, 30);
  const nowMs = Date.now();
  const scoped = found !== undefined;
  const scopeHref = scopePath(scope.projectId, scope.appKey);
  const hostsHref = `${scopeHref}#ssh-hosts`;
  const accessHref = `${scopeHref}#ssh-access`;
  const approvalsHref = `${scopeHref}#ssh-approvals`;
  const auditHref = `${scopeHref}#ssh-audit`;
  const hostViews: SshHostView[] = hosts.map(({ host, credential }) => {
    const view = viewById.get(host.id);
    return {
      ...host,
      credential,
      allowed: scoped ? allowed.has(host.id) : false,
      grant: view?.grant ?? null,
      pendingApprovals: view?.pendingApprovals ?? 0,
    };
  });
  const hostNames = new Map(hosts.map(({ host }) => [host.id, host.name]));
  const pinnedCount = hostViews.filter(
    (host) => host.hostKeyFingerprint !== null && host.hostKeyMismatchAt === null,
  ).length;
  const unpinnedCount = hostViews.filter((host) => host.hostKeyFingerprint === null).length;
  const mismatchCount = hostViews.filter((host) => host.hostKeyMismatchAt !== null).length;
  const activeGrants = grants.filter(
    (grant) =>
      grant.revokedAt === null &&
      Date.parse(grant.idleExpiresAt) > nowMs &&
      Date.parse(grant.absoluteExpiresAt) > nowMs,
  );
  const scopeOptions =
    '<option value="">All applications</option>' +
    deps
      .getProjects()
      .map((project) => {
        const apps = project.service.listApps();
        if (apps.length === 0) return "";
        const options = apps
          .map((app) => {
            const value = `${project.id}:${app.appKey}`;
            const selected = found?.project.id === project.id && found.app.appKey === app.appKey;
            return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(`${project.name} / ${app.appKey}`)}</option>`;
          })
          .join("");
        return `<optgroup label="${escapeHtml(project.name)}">${options}</optgroup>`;
      })
      .join("");
  const pinWarning =
    mismatchCount > 0
      ? `<span class="badge badge-warning">${mismatchCount} mismatch</span>`
      : unpinnedCount > 0
        ? `<span class="badge">${unpinnedCount} unpinned</span>`
        : "";
  const nav = `<nav class="settings-nav ssh-nav" aria-label="SSH console">
    <div class="settings-nav__sections" aria-label="SSH sections">
      <a class="settings-nav__link" href="${escapeHtml(hostsHref)}">Hosts</a>
      <a class="settings-nav__link" href="${escapeHtml(accessHref)}">Access</a>
      <a class="settings-nav__link" href="${escapeHtml(approvalsHref)}">Approvals (${pending.length})</a>
      <a class="settings-nav__link" href="${escapeHtml(auditHref)}">Audit</a>
    </div>
    <form class="ssh-nav__scope" method="get" action="/ssh">
      <label class="label ssh-nav__scope-label" for="ssh-scope">Application scope</label>
      <div class="ssh-nav__scope-controls">
        <select class="select ssh-nav__select" id="ssh-scope" name="target">${scopeOptions}</select>
        <button class="btn btn-secondary btn-sm" type="submit">Apply</button>
      </div>
    </form>
  </nav>`;
  const watch = `<div class="watch-strip watch-strip--4 ssh-watch">
    <div class="watch"><p class="watch__value">${hostViews.length}</p><p class="watch__label">Hosts</p></div>
    <div class="watch"><p class="watch__value">${pinnedCount} / ${hostViews.length}</p><p class="watch__label">Host keys pinned</p>${pinWarning}</div>
    <div class="watch"><p class="watch__value">${pending.length}</p><p class="watch__label">Pending approvals</p></div>
    <div class="watch"><p class="watch__value">${scoped ? activeGrants.length : "&mdash;"}</p><p class="watch__label">Active grants${scoped ? "" : " (choose a scope)"}</p></div>
  </div>`;
  const hostCards = hostViews
    .map((host) =>
      hostCard(host, {
        scoped,
        scopeHref,
        ...(extra?.test === undefined ? {} : { test: extra.test }),
        ...(extra?.error === undefined ? {} : { error: extra.error }),
      }),
    )
    .join("");
  const hostsContent =
    hostViews.length === 0
      ? emptyState({
          iconName: "terminal",
          title: "No SSH hosts yet",
          body: "Add a host to hold its key in the coordinator, pin its host key, and grant access per application.",
          action: `<button class="btn btn-primary btn-sm" type="button" data-dialog-open="ssh-add-dialog">${icon("plus")}Add host</button>`,
        })
      : `<div class="ssh-grid">${hostCards}</div>`;
  const allowlist =
    hostViews.length === 0
      ? `<p class="hint">No hosts are configured. Add a host before granting access.</p>`
      : `<div class="ssh-allowlist">${hostViews
          .map(
            (host) =>
              `<label class="check"><input class="checkbox" type="checkbox" name="hostIds" value="${escapeHtml(host.id)}"${allowed.has(host.id) ? " checked" : ""} /><span><strong>${escapeHtml(host.name)}</strong> <span class="mono">${escapeHtml(host.address)}</span> ${hostPinPill(host)}</span></label>`,
          )
          .join("")}</div>`;
  const accessBody = scoped
    ? `<div class="ssh-panel stack">
        ${
          extra?.error?.target === "access"
            ? `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(extra.error.message)}</p>`
            : ""
        }
        <form class="stack" method="post" action="/ssh/grants">
          <input type="hidden" name="project" value="${escapeHtml(found.project.id)}" />
          <input type="hidden" name="app" value="${escapeHtml(found.app.appKey)}" />
          <input type="hidden" name="return_to" value="${escapeHtml(accessHref)}" />
          ${allowlist}
          <p class="hint">Unchecking a host removes the application's access and revokes any active grant for that host.</p>
          <div><button class="btn btn-primary btn-sm" type="submit">Save allowlist</button></div>
        </form>
        <h3 class="ssh-subtitle">Grants</h3>
        <p class="hint">Active, expired, and revoked approvals for this application.</p>
        ${
          grants.length === 0
            ? `<p class="hint">No grants yet. Approving a pending request creates an idle grant.</p>`
            : `<div class="table-wrap"><table class="table table--stack">
                <thead><tr><th scope="col">Host</th><th scope="col">Granted by</th><th scope="col">Idle expires</th><th scope="col">State</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                <tbody>${grants
                  .map((grant) => {
                    const hostName = hostNames.get(grant.hostId) ?? "Unknown host";
                    const revoke =
                      grant.revokedAt === null
                        ? `<form method="post" action="/ssh/grants/${encodeURIComponent(grant.id)}/revoke">
                            <input type="hidden" name="appId" value="${escapeHtml(grant.appId)}" />
                            <input type="hidden" name="return_to" value="${escapeHtml(accessHref)}" />
                            <button class="btn btn-danger btn-sm" type="submit">Revoke</button>
                          </form>`
                        : "";
                    return `<tr>
                      <td data-label="Host"><span class="mono">${escapeHtml(hostName)}</span></td>
                      <td data-label="Granted by">${escapeHtml(grant.grantedBy)}</td>
                      <td data-label="Idle expires">${expiryTag(grant.idleExpiresAt)}</td>
                      <td data-label="State">${grantStatePill(grant, nowMs)}</td>
                      <td class="table__actions">${revoke}</td>
                    </tr>`;
                  })
                  .join("")}</tbody>
              </table></div>`
        }
      </div>`
    : emptyState({
        iconName: "lock",
        title: "Choose an application",
        body: "Access is scoped to one application. Use the Application scope picker above to view its allowlist, grants, approvals, and audit.",
      });
  const accessSection = `<section class="section ssh-section" id="ssh-access" aria-labelledby="ssh-access-title">
    <div class="section__head">
      <h2 class="section__title" id="ssh-access-title">${scoped ? `Access for ${escapeHtml(found.project.name)} / ${escapeHtml(found.app.appKey)}` : "Application access"}</h2>
      <p class="section__note">${scoped ? `${allowed.size} of ${hostViews.length} hosts allowed` : "Per-application allowlists and grants."}</p>
    </div>
    ${accessBody}
  </section>`;
  const approvalCards = pending
    .map(
      (approval) => `<article class="ssh-approval">
        <div class="ssh-approval__head">
          <div class="ssh-approval__ident">
            <h3 class="ssh-approval__title">${escapeHtml(approval.hostName)}</h3>
            <p class="ssh-approval__meta"><span class="badge badge--mono">${escapeHtml(approval.action)}</span> ${escapeHtml(approval.appKey)}</p>
          </div>
          <p class="ssh-approval__meta">requested ${timeTag(approval.requestedAt)} · expires ${expiryTag(approval.expiresAt)}</p>
        </div>
        <pre class="ssh-command">${escapeHtml(approval.commandPreview)}</pre>
        <div class="ssh-approval__foot">
          <p class="hint">Approving creates an idle grant for this host.</p>
          <div class="cluster">
            <form method="post" action="/ssh/approvals/${encodeURIComponent(approval.id)}/decision">
              <input type="hidden" name="appId" value="${escapeHtml(approval.appId)}" />
              <input type="hidden" name="decision" value="approve" />
              <input type="hidden" name="return_to" value="${escapeHtml(approvalsHref)}" />
              <button class="btn btn-primary btn-sm" type="submit">Approve</button>
            </form>
            <form method="post" action="/ssh/approvals/${encodeURIComponent(approval.id)}/decision">
              <input type="hidden" name="appId" value="${escapeHtml(approval.appId)}" />
              <input type="hidden" name="decision" value="reject" />
              <input type="hidden" name="return_to" value="${escapeHtml(approvalsHref)}" />
              <button class="btn btn-danger btn-sm" type="submit">Reject</button>
            </form>
          </div>
        </div>
      </article>`,
    )
    .join("");
  const approvalsContent =
    pending.length === 0
      ? emptyState({
          iconName: "inbox",
          title: "No pending approvals",
          body: "Requests appear here and in chat. Each request expires after 5 minutes.",
        })
      : `<div class="ssh-approvals">${approvalCards}</div>`;
  const approvalsSection = `<section class="section ssh-section" id="ssh-approvals" aria-labelledby="ssh-approvals-title">
    <div class="section__head">
      <h2 class="section__title" id="ssh-approvals-title">Pending approvals</h2>
      <p class="section__note">${scoped ? `Scoped to ${escapeHtml(found.project.name)} / ${escapeHtml(found.app.appKey)}` : "All applications"}</p>
    </div>
    ${
      extra?.error?.target === "approvals"
        ? `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(extra.error.message)}</p>`
        : ""
    }
    ${approvalsContent}
  </section>`;
  const auditRows = audit
    .map(
      (entry) => `<tr>
        <td data-label="Time">${timeTag(entry.startedAt)}</td>
        <td data-label="Action"><span class="badge badge--mono">${escapeHtml(entry.action)}</span></td>
        <td data-label="Host"><span class="mono">${escapeHtml(entry.hostName)}</span></td>
        ${scoped ? "" : `<td data-label="Application"><span class="mono">${escapeHtml(entry.appKey)}</span></td>`}
        <td data-label="Command"><span class="mono ssh-audit__command">${escapeHtml(entry.commandPreview ?? "—")}</span></td>
        <td data-label="Result">${auditResult(entry)}</td>
      </tr>`,
    )
    .join("");
  const auditContent =
    audit.length === 0
      ? emptyState({
          iconName: "activity",
          title: "No SSH activity yet",
          body: "Tests, commands, uploads, and downloads are recorded here with their result.",
        })
      : `<div class="ssh-panel ssh-panel--flush"><div class="table-wrap"><table class="table table--stack">
          <thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Host</th>${scoped ? "" : '<th scope="col">Application</th>'}<th scope="col">Command</th><th scope="col">Result</th></tr></thead>
          <tbody>${auditRows}</tbody>
        </table></div></div>
        <p class="hint ssh-note">Showing the 30 most recent events.</p>`;
  const auditSection = `<section class="section ssh-section" id="ssh-audit" aria-labelledby="ssh-audit-title">
    <div class="section__head">
      <h2 class="section__title" id="ssh-audit-title">Audit</h2>
      <p class="section__note">${scoped ? `Scoped to ${escapeHtml(found.project.name)} / ${escapeHtml(found.app.appKey)}` : "All applications"}</p>
    </div>
    ${auditContent}
  </section>`;
  const addOpen = extra?.openAdd === true || extra?.error?.target === "add";
  const addValues = extra?.error?.target === "add" ? (extra.error.values ?? {}) : {};
  const editDialogs = hostViews
    .map((host) => {
      const target = `edit:${host.id}`;
      const isError = extra?.error?.target === target;
      return editHostDialog(host, {
        open: isError,
        values: isError ? (extra?.error?.values ?? {}) : {},
        ...(isError && extra?.error !== undefined ? { error: extra.error.message } : {}),
        returnTo: `${scopeHref}#ssh-host-${host.id}`,
      });
    })
    .join("");
  const header = pageHeader({
    overline: "Access",
    title: "SSH hosts",
    description:
      "Coordinator-held keys, host-key pinning, per-application grants, approvals, and audit.",
    actions: `<a class="btn btn-secondary" href="${escapeHtml(scopeHref)}">${icon("refresh")}Refresh</a><button class="btn btn-primary" type="button" data-dialog-open="ssh-add-dialog">${icon("plus")}Add host</button>`,
  });
  const hostsSection = `<section class="section ssh-section" id="ssh-hosts" aria-labelledby="ssh-hosts-title">
    <div class="section__head">
      <h2 class="section__title" id="ssh-hosts-title">Hosts</h2>
      <p class="section__note">One coordinator-held key per host. Host keys are pinned on first use (TOFU) and fail closed on a mismatch.</p>
    </div>
    ${hostsContent}
  </section>`;
  const body = `${header}
    ${nav}
    ${watch}
    ${hostsSection}
    ${accessSection}
    ${approvalsSection}
    ${auditSection}
    ${addHostDialog({ open: addOpen, values: addValues, ...(extra?.error?.target === "add" ? { error: extra.error.message } : {}), returnTo: hostsHref })}
    ${editDialogs}`;
  return html(
    200,
    appShell({
      title: "SSH",
      active: "ssh",
      breadcrumb: [{ label: "Settings", href: "/settings" }, { label: "SSH" }],
      projects: site.projects.map((project) => ({
        id: project.id,
        name: project.name,
        appCount: project.apps.length,
      })),
      pendingCount: site.pendingCount,
      sshPendingCount: site.sshPendingCount,
      operatorName: principal.name,
      notice: noticeFrom(request),
      header: "",
      scripts: ["/assets/ssh.js"],
      body,
      settingsHref:
        found === undefined
          ? "/settings"
          : `/projects/${encodeURIComponent(found.project.id)}/apps/${encodeURIComponent(found.app.appKey)}/settings`,
    }),
  );
}

function apiHostView(host: SshHostView): unknown {
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    port: host.port,
    username: host.username,
    hostKeyFingerprint: host.hostKeyFingerprint,
    hostKeyPinnedAt: host.hostKeyPinnedAt,
    hostKeyMismatchAt: host.hostKeyMismatchAt,
    requireApproval: host.requireApproval,
    approvalIdleSec: host.approvalIdleSec,
    remoteRoot: host.remoteRoot,
    credential: host.credential,
    allowed: host.allowed,
    grant: host.grant,
    pendingApprovals: host.pendingApprovals,
  };
}

function asBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "1" || value === "true" || value === "on";
}

function asInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isSshRoute(_method: string, pathname: string): boolean {
  if (pathname === "/ssh" || pathname.startsWith("/ssh/")) return true;
  if (pathname === "/api/ssh" || pathname.startsWith("/api/ssh/")) return true;
  if (/^\/api\/projects\/[^/]+\/apps\/[^/]+\/ssh(?:\/|$)/.test(pathname)) return true;
  if (/^\/api\/apps\/[^/]+\/ssh(?:\/|$)/.test(pathname)) return true;
  return false;
}

function resolveApp(
  deps: HttpDeps,
  request: HttpRequest,
): { appId: string; projectId: string; appKey: string } | undefined {
  const match = /^\/api\/apps\/([^/]+)\/ssh\//.exec(request.path);
  if (match !== null) {
    const found = findApp(deps, request.query?.project, decodeURIComponent(match[1] as string));
    return found === undefined
      ? undefined
      : { appId: found.app.id, projectId: found.project.id, appKey: found.app.appKey };
  }
  const projectMatch = /^\/api\/projects\/([^/]+)\/apps\/([^/]+)\/ssh(?:\/|$)/.exec(request.path);
  if (projectMatch !== null) {
    const found = findApp(
      deps,
      decodeURIComponent(projectMatch[1] as string),
      decodeURIComponent(projectMatch[2] as string),
    );
    return found === undefined
      ? undefined
      : { appId: found.app.id, projectId: found.project.id, appKey: found.app.appKey };
  }
  return undefined;
}

export async function handleSsh(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const ssh = deps.ssh;
  if (ssh === undefined) return json(503, { error: "ssh_unavailable" });
  const authorization = auth(deps, request);
  if ("response" in authorization) return authorization.response;
  const principal = authorization.principal;

  if (request.method === "GET" && request.path === "/ssh") {
    return renderPage(deps, request, principal);
  }

  if (request.method === "GET" && request.path === "/api/ssh/hosts") {
    return json(200, {
      hosts: ssh
        .listAllHosts()
        .map(({ host, credential }) =>
          apiHostView({ ...host, credential, allowed: false, grant: null, pendingApprovals: 0 }),
        ),
    });
  }
  if (request.method === "GET" && request.path === "/api/ssh/approvals/count") {
    return json(200, { count: ssh.countPending() });
  }
  if (request.method === "POST" && request.path === "/api/ssh/hosts") {
    try {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      const created = ssh.createHost(
        {
          name: String(body.name ?? ""),
          address: String(body.address ?? ""),
          ...(typeof body.port === "number" ? { port: body.port } : {}),
          username: String(body.username ?? ""),
          privateKey: String(body.privateKey ?? ""),
          ...(typeof body.requireApproval === "boolean"
            ? { requireApproval: body.requireApproval }
            : {}),
          ...(typeof body.approvalIdleSec === "number"
            ? { approvalIdleSec: body.approvalIdleSec }
            : {}),
          ...(body.remoteRoot === null || typeof body.remoteRoot === "string"
            ? { remoteRoot: body.remoteRoot as string | null }
            : {}),
        },
        principal.name,
      );
      return json(201, { host: apiHostView(created) });
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const hostMatch = /^\/api\/ssh\/hosts\/([^/]+)(?:\/(test|re-pin))?$/.exec(request.path);
  if (hostMatch !== null) {
    const hostId = decodeURIComponent(hostMatch[1] as string);
    const action = hostMatch[2];
    try {
      if (request.method === "PATCH" && action === undefined) {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        return json(200, {
          host: apiHostView(
            ssh.updateHost(
              hostId,
              {
                ...(typeof body.name === "string" ? { name: body.name } : {}),
                ...(typeof body.address === "string" ? { address: body.address } : {}),
                ...(typeof body.port === "number" ? { port: body.port } : {}),
                ...(typeof body.username === "string" ? { username: body.username } : {}),
                ...(typeof body.privateKey === "string" ? { privateKey: body.privateKey } : {}),
                ...(typeof body.requireApproval === "boolean"
                  ? { requireApproval: body.requireApproval }
                  : {}),
                ...(typeof body.approvalIdleSec === "number"
                  ? { approvalIdleSec: body.approvalIdleSec }
                  : {}),
                ...(body.remoteRoot === null || typeof body.remoteRoot === "string"
                  ? { remoteRoot: body.remoteRoot as string | null }
                  : {}),
              },
              principal.name,
            ),
          ),
        });
      }
      if (request.method === "DELETE" && action === undefined) {
        ssh.deleteHost(hostId, principal.name);
        return json(200, { deleted: true });
      }
      if (request.method === "POST" && action === "test") {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        return json(200, {
          result: await ssh.testHost(hostId, { ignorePin: body.ignorePin === true }),
        });
      }
      if (request.method === "POST" && action === "re-pin") {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        return json(200, {
          host: apiHostView(ssh.rePin(hostId, String(body.fingerprint ?? ""), principal.name)),
        });
      }
      return json(405, { error: "method_not_allowed" });
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(code === "ssh_host_not_allowed" ? 404 : 400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const appApprovals = /^\/api\/apps\/[^/]+\/ssh\/approvals(?:\/([^/]+)\/decision)?$/.exec(
    request.path,
  );
  if (appApprovals !== null) {
    const resolved = resolveApp(deps, request);
    if (resolved === undefined) return json(404, { error: "app_not_found" });
    try {
      if (request.method === "GET" && appApprovals[1] === undefined) {
        return json(200, { approvals: ssh.listPending(resolved.appId) });
      }
      if (request.method === "POST" && appApprovals[1] !== undefined) {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        const decision = body.decision === "reject" ? "reject" : "approve";
        return json(200, {
          approval: ssh.decideApproval(
            decodeURIComponent(appApprovals[1] as string),
            resolved.appId,
            decision,
            principal.name,
          ),
        });
      }
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(code === "ssh_approval_expired" ? 409 : 400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return json(405, { error: "method_not_allowed" });
  }

  const appAudit = /^\/api\/apps\/[^/]+\/ssh\/audit$/.test(request.path);
  if (appAudit && request.method === "GET") {
    const resolved = resolveApp(deps, request);
    if (resolved === undefined) return json(404, { error: "app_not_found" });
    const limit = asInt(request.query?.limit) ?? 50;
    const before = asInt(request.query?.before);
    return json(200, {
      audit: ssh.listAudit(resolved.appId, Math.min(Math.max(limit, 1), 200), before),
    });
  }

  const projectGrants =
    /^\/api\/projects\/[^/]+\/apps\/[^/]+\/ssh(?:\/grants\/([^/]+)\/revoke)?$/.exec(request.path);
  if (projectGrants !== null) {
    const resolved = resolveApp(deps, request);
    if (resolved === undefined) return json(404, { error: "app_not_found" });
    try {
      if (request.method === "GET" && projectGrants[1] === undefined) {
        const agent = {
          appId: resolved.appId,
          projectId: resolved.projectId,
          appKey: resolved.appKey,
        };
        return json(200, {
          hosts: ssh.listHosts(agent).map(apiHostView),
          grants: ssh.listGrants(resolved.appId),
        });
      }
      if (request.method === "POST" && projectGrants[1] === undefined) {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        const hostIds = Array.isArray(body.hostIds)
          ? body.hostIds.filter((value): value is string => typeof value === "string")
          : [];
        ssh.replaceAppHosts(resolved.appId, hostIds, principal.name);
        return json(200, {
          hosts: ssh
            .listHosts({
              appId: resolved.appId,
              projectId: resolved.projectId,
              appKey: resolved.appKey,
            })
            .map(apiHostView),
        });
      }
      if (request.method === "POST" && projectGrants[1] !== undefined) {
        ssh.revokeGrant(decodeURIComponent(projectGrants[1] as string), principal.name);
        return json(200, { revoked: true });
      }
    } catch (error) {
      const code = error instanceof SshError ? error.code : "ssh_invalid_argument";
      return json(400, {
        error: code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return json(405, { error: "method_not_allowed" });
  }

  const pageAction = /^\/ssh\/hosts\/([^/]+)\/(test|update|delete|re-pin)$/.exec(request.path);
  if (request.method === "POST" && pageAction !== null) {
    const hostId = decodeURIComponent(pageAction[1] as string);
    const action = pageAction[2];
    const fields = form(request.body);
    const fallback = scopePath("", "");
    const returnTo = safeLocalPath(fields.get("return_to") ?? fallback, fallback);
    try {
      if (action === "test") {
        const ignorePin = fields.get("ignorePin") === "1";
        const result = await ssh.testHost(hostId, { ignorePin });
        const host = ssh.getHostView(hostId);
        return renderPage(
          deps,
          {
            ...request,
            query: queryFromReturn(returnTo),
          },
          principal,
          {
            test: {
              ...result,
              hostId,
              hostName: host?.name ?? hostId,
              prepareRePin: ignorePin,
            },
          },
        );
      }
      if (action === "update") {
        ssh.updateHost(
          hostId,
          {
            name: fields.get("name") ?? undefined,
            address: fields.get("address") ?? undefined,
            port: asInt(fields.get("port") ?? undefined),
            username: fields.get("username") ?? undefined,
            ...(fields.get("privateKey")?.trim()
              ? { privateKey: fields.get("privateKey") as string }
              : {}),
            requireApproval: asBool(fields.get("requireApproval") ?? undefined),
            approvalIdleSec: asInt(fields.get("approvalIdleSec") ?? undefined),
            ...(fields.get("remoteRoot") === null
              ? {}
              : { remoteRoot: fields.get("remoteRoot")?.trim() || null }),
          },
          principal.name,
        );
        return redirect(returnTo, "Host updated");
      }
      if (action === "delete") {
        ssh.deleteHost(hostId, principal.name);
        return redirect(returnTo, "Host deleted");
      }
      if (action === "re-pin") {
        ssh.rePin(hostId, fields.get("fingerprint") ?? "", principal.name);
        return redirect(returnTo, "Host key re-pinned");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const target =
        action === "update" || action === "delete" ? `edit:${hostId}` : `host:${hostId}`;
      return renderPage(deps, { ...request, query: queryFromReturn(returnTo) }, principal, {
        error: {
          message,
          target,
          ...(action === "update" ? { values: formValues(fields) } : {}),
        },
      });
    }
  }

  if (request.method === "POST" && request.path === "/ssh/hosts") {
    const fields = form(request.body);
    const fallback = scopePath("", "");
    const returnTo = safeLocalPath(fields.get("return_to") ?? fallback, fallback);
    try {
      ssh.createHost(
        {
          name: fields.get("name") ?? "",
          address: fields.get("address") ?? "",
          port: asInt(fields.get("port") ?? undefined),
          username: fields.get("username") ?? "",
          privateKey: fields.get("privateKey") ?? "",
          requireApproval: asBool(fields.get("requireApproval") ?? undefined),
          approvalIdleSec: asInt(fields.get("approvalIdleSec") ?? undefined),
          ...(fields.get("remoteRoot") === null
            ? {}
            : { remoteRoot: fields.get("remoteRoot")?.trim() || null }),
        },
        principal.name,
      );
      return redirect(returnTo, "Host added");
    } catch (error) {
      return renderPage(deps, { ...request, query: queryFromReturn(returnTo) }, principal, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          target: "add",
          values: formValues(fields),
        },
      });
    }
  }

  if (request.method === "POST" && request.path === "/ssh/grants") {
    const fields = form(request.body);
    const fallback = scopePath("", "");
    const returnTo = safeLocalPath(fields.get("return_to") ?? fallback, fallback);
    const found = findApp(deps, fields.get("project") ?? undefined, fields.get("app") ?? "");
    if (found === undefined)
      return renderPage(deps, { ...request, query: queryFromReturn(returnTo) }, principal, {
        error: { message: "Application not found", target: "access" },
      });
    try {
      ssh.replaceAppHosts(found.app.id, fields.getAll("hostIds"), principal.name);
      return redirect(
        `${scopePath(found.project.id, found.app.appKey)}#ssh-access`,
        "Allowlist saved",
      );
    } catch (error) {
      return renderPage(deps, { ...request, query: queryFromReturn(returnTo) }, principal, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          target: "access",
        },
      });
    }
  }

  if (request.method === "POST" && request.path.startsWith("/ssh/grants/")) {
    const match = /^\/ssh\/grants\/([^/]+)\/revoke$/.exec(request.path);
    if (match !== null) {
      const fields = form(request.body);
      const fallback = scopePath("", "");
      const returnTo = safeLocalPath(fields.get("return_to") ?? fallback, fallback);
      try {
        ssh.revokeGrant(decodeURIComponent(match[1] as string), principal.name);
        return redirect(returnTo, "Grant revoked");
      } catch (error) {
        return renderPage(deps, { ...request, query: queryFromReturn(returnTo) }, principal, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            target: "access",
          },
        });
      }
    }
  }

  if (request.method === "POST" && request.path.startsWith("/ssh/approvals/")) {
    const match = /^\/ssh\/approvals\/([^/]+)\/decision$/.exec(request.path);
    if (match !== null) {
      const fields = form(request.body);
      const fallback = scopePath("", "");
      const returnTo = safeLocalPath(fields.get("return_to") ?? fallback, fallback);
      try {
        ssh.decideApproval(
          decodeURIComponent(match[1] as string),
          fields.get("appId") ?? "",
          fields.get("decision") === "reject" ? "reject" : "approve",
          principal.name,
        );
        return redirect(returnTo, "Approval recorded");
      } catch (error) {
        return renderPage(deps, { ...request, query: queryFromReturn(returnTo) }, principal, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            target: "approvals",
          },
        });
      }
    }
  }

  return json(404, { error: "not_found" });
}
