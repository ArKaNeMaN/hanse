import {
  type EffectiveValue,
  type PendingRestart,
  type ResolvedSettings,
  type ScopedValue,
  type SettingsService,
  SettingsValidationError,
} from "../settings/index.js";
import type { SettingsScope, SettingsTarget } from "../settings/types.js";
import { DEEPSEEK_FIELDS, webDriverDefinitions } from "../web/registry.js";
import type { WebToolConfig } from "../web/types.js";
import { findApp } from "./apps.js";
import { humanFrom, principalFrom } from "./auth.js";
import { buildSite, type PageChrome, renderNotFound, type SiteModel } from "./dashboard.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import { appShell, escapeHtml, icon, pageHeader, plural, safeLocalPath } from "./ui.js";

const JSON_HEADERS = { "cache-control": "no-store" };

class BodyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyValidationError";
  }
}

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

function redirect(location: string): HttpResponse {
  return {
    status: 303,
    contentType: "text/plain",
    body: "",
    headers: { location, ...JSON_HEADERS },
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function wantsHtml(request: HttpRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

function requestPath(request: HttpRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query ?? {})) {
    params.set(key, value);
  }
  const query = params.toString();
  return query.length === 0 ? request.path : `${request.path}?${query}`;
}

function pageChrome(operatorName: string, request: HttpRequest): PageChrome {
  const message = request.query?.notice;
  const notice =
    message === undefined || message.trim().length === 0
      ? undefined
      : {
          message,
          tone: request.query?.tone === "error" ? ("error" as const) : ("success" as const),
        };
  return { operatorName, notice };
}

function withNotice(location: string, message: string, tone: "success" | "error"): string {
  const hashIndex = location.indexOf("#");
  const hash = hashIndex >= 0 ? location.slice(hashIndex) : "";
  const base = hashIndex >= 0 ? location.slice(0, hashIndex) : location;
  const queryIndex = base.indexOf("?");
  const pathname = queryIndex >= 0 ? base.slice(0, queryIndex) : base;
  const params = new URLSearchParams(queryIndex >= 0 ? base.slice(queryIndex + 1) : "");
  params.set("notice", message);
  params.set("tone", tone);
  return `${pathname}?${params.toString()}${hash}`;
}

function redirectNotice(
  location: string,
  message: string,
  tone: "success" | "error",
): HttpResponse {
  return redirect(withNotice(location, message, tone));
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function parseForm(body: string | undefined): Record<string, string> {
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  if (body === undefined) {
    return fields;
  }
  for (const pair of body.split("&")) {
    const index = pair.indexOf("=");
    if (index < 0) {
      continue;
    }
    const key = safeDecode(pair.slice(0, index));
    if (DANGEROUS_KEYS.has(key)) {
      throw new BodyValidationError("request contains a forbidden field name");
    }
    fields[key] = safeDecode(pair.slice(index + 1));
  }
  return fields;
}

function isJsonRequest(request: HttpRequest): boolean {
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    return true;
  }
  return request.body?.trim().startsWith("{") ?? false;
}

function parseObjectBody(request: HttpRequest): Record<string, unknown> {
  if (!isJsonRequest(request)) {
    return parseForm(request.body);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body ?? "");
  } catch {
    throw new BodyValidationError("invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BodyValidationError("request body must be a JSON object");
  }
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new BodyValidationError("request contains a forbidden field name");
    }
  }
  return parsed as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function scopeValue(value: unknown): SettingsScope {
  if (value === "global" || value === "project" || value === "app") {
    return value;
  }
  throw new SettingsValidationError("scope must be global, project, or app");
}

function targetFrom(source: Record<string, unknown>, scope: SettingsScope): SettingsTarget {
  const projectId = stringValue(source.projectId ?? source.project);
  const appKey = stringValue(source.appKey ?? source.app);
  if (scope === "global") {
    return {};
  }
  if (scope === "project") {
    if (projectId === undefined || projectId.length === 0) {
      throw new SettingsValidationError("project scope requires projectId");
    }
    return { projectId };
  }
  if (projectId === undefined || projectId.length === 0) {
    throw new SettingsValidationError("app scope requires projectId");
  }
  if (appKey === undefined || appKey.length === 0) {
    throw new SettingsValidationError("app scope requires appKey");
  }
  return { projectId, appKey };
}

function settingsPagePath(scope: SettingsScope, target: SettingsTarget): string {
  if (scope === "global") {
    return "/settings";
  }
  if (scope === "project") {
    return `/projects/${encodeURIComponent(target.projectId ?? "")}/settings`;
  }
  return `/projects/${encodeURIComponent(target.projectId ?? "")}/apps/${encodeURIComponent(
    target.appKey ?? "",
  )}/settings`;
}

function parseTarget(source: Record<string, unknown>): {
  scope: SettingsScope;
  target: SettingsTarget;
} {
  const scope = scopeValue(source.scope);
  return { scope, target: targetFrom(source, scope) };
}

function pendingFor(
  deps: HttpDeps,
  scope: SettingsScope,
  target: SettingsTarget,
): PendingRestart[] {
  const manager = deps.manager;
  if (manager === undefined) {
    return [];
  }
  const pending: PendingRestart[] = [];
  for (const project of deps.getProjects()) {
    if (scope !== "global" && target.projectId !== project.id) {
      continue;
    }
    for (const app of project.service.listApps()) {
      if (scope === "app" && app.appKey !== target.appKey) {
        continue;
      }
      const state = manager.pendingRestart(app.id);
      if (state.pending) {
        pending.push({
          appId: app.id,
          appKey: app.appKey,
          projectId: project.id,
          reasons: state.reasons,
        });
      }
    }
  }
  return pending;
}

function settingsResponse(
  settings: SettingsService,
  deps: HttpDeps,
  scope: SettingsScope,
  target: SettingsTarget,
): ResolvedSettings & { pendingRestart: PendingRestart[] } {
  return {
    ...settings.resolve(target),
    pendingRestart: pendingFor(deps, scope, target),
  };
}

function buildWebToolValue(payload: Record<string, unknown>): unknown {
  const driver = stringValue(payload.driver);
  if (driver === "builtin") {
    return { driver: "builtin" };
  }
  if (driver !== "deepseek") {
    throw new SettingsValidationError("driver must be builtin or deepseek");
  }
  const options: Record<string, unknown> = {
    provider: stringValue(payload.provider) ?? "",
  };
  const count = stringValue(payload.count);
  if (count !== undefined && count.trim().length > 0) {
    options.count = Number(count);
  }
  const timeoutMs = stringValue(payload.timeoutMs);
  if (timeoutMs !== undefined && timeoutMs.trim().length > 0) {
    options.timeoutMs = Number(timeoutMs);
  }
  const maxContentChars = stringValue(payload.maxContentChars);
  if (maxContentChars !== undefined && maxContentChars.trim().length > 0) {
    options.maxContentChars = Number(maxContentChars);
  }
  if (
    payload.needContent === "1" ||
    payload.needContent === "true" ||
    payload.needContent === "on"
  ) {
    options.needContent = true;
  }
  return { driver: "deepseek", options };
}

function settingValue(
  key: string,
  action: string,
  payload: Record<string, unknown>,
  json: boolean,
): unknown {
  if (json || key === "llm.model") {
    return payload.value;
  }
  if (action === "set") {
    return buildWebToolValue(payload);
  }
  return payload.value;
}

function mutationError(browser: boolean, returnTo: string, error: unknown): HttpResponse {
  if (error instanceof SettingsValidationError || error instanceof BodyValidationError) {
    if (browser) {
      return redirectNotice(returnTo, error.message, "error");
    }
    return json(400, { error: error.message });
  }
  throw error;
}

/* ------------------------------------------------------------------------- */
/* Dispatch                                                                  */
/* ------------------------------------------------------------------------- */

export function isSettingsRoute(method: string, pathname: string): boolean {
  if (pathname === "/settings") {
    return method === "GET";
  }
  if (pathname === "/api/settings" || pathname === "/api/settings/provider") {
    return true;
  }
  if (/^\/projects\/[^/]+\/settings$/.test(pathname)) {
    return method === "GET";
  }
  if (/^\/projects\/[^/]+\/apps\/[^/]+\/settings$/.test(pathname)) {
    return method === "GET";
  }
  return method === "POST" && /^\/api\/apps\/[^/]+\/restart$/.test(pathname);
}

function authorize(deps: HttpDeps, request: HttpRequest): HttpResponse | undefined {
  if (wantsHtml(request)) {
    if (humanFrom(deps, request) === undefined) {
      return redirect(`/login?next=${encodeURIComponent(requestPath(request))}`);
    }
    return undefined;
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may manage settings" });
  }
  return undefined;
}

export async function handleSettings(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  if (deps.settings === undefined) {
    return json(503, { error: "settings are not configured" });
  }
  const denied = authorize(deps, request);
  if (denied !== undefined) {
    return denied;
  }
  const browser = wantsHtml(request);
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return redirect(`/login?next=${encodeURIComponent(requestPath(request))}`);
  }
  const actor = principal.name;
  const settings = deps.settings;

  if (request.path === "/api/settings" && request.method === "GET") {
    const query = request.query ?? {};
    try {
      const { scope, target } = parseTarget(query);
      return json(200, settingsResponse(settings, deps, scope, target));
    } catch (error) {
      return mutationError(browser, "/settings", error);
    }
  }

  if (request.path === "/api/settings" && request.method === "POST") {
    let payload: Record<string, unknown>;
    let scope: SettingsScope;
    let target: SettingsTarget;
    let returnTo = "/settings";
    const jsonBody = isJsonRequest(request);
    try {
      payload = parseObjectBody(request);
      ({ scope, target } = parseTarget(payload));
      returnTo = safeLocalPath(stringValue(payload.return_to), settingsPagePath(scope, target));
      const key = stringValue(payload.key) ?? "";
      const action = stringValue(payload.action) ?? "";
      if (action === "set") {
        settings.set(scope, target, key, settingValue(key, action, payload, jsonBody), actor);
      } else if (action === "clear") {
        settings.clear(scope, target, key, actor);
      } else if (action === "inherit") {
        settings.inherit(scope, target, key);
      } else {
        throw new SettingsValidationError("action must be set, clear, or inherit");
      }
    } catch (error) {
      return mutationError(browser, returnTo, error);
    }
    return browser
      ? redirectNotice(returnTo, "Settings saved.", "success")
      : json(200, settingsResponse(settings, deps, scope, target));
  }

  if (request.path === "/api/settings/provider" && request.method === "POST") {
    let payload: Record<string, unknown>;
    let scope: SettingsScope;
    let target: SettingsTarget;
    let returnTo = "/settings";
    try {
      payload = parseObjectBody(request);
      ({ scope, target } = parseTarget(payload));
      returnTo = safeLocalPath(stringValue(payload.return_to), settingsPagePath(scope, target));
      const provider = stringValue(payload.provider) ?? "";
      const action = stringValue(payload.action) ?? "";
      if (action === "set") {
        settings.setProviderKey(scope, target, provider, stringValue(payload.key) ?? "", actor);
      } else if (action === "clear") {
        settings.clearProviderKey(scope, target, provider, actor);
      } else if (action === "inherit") {
        settings.inheritProviderKey(scope, target, provider);
      } else {
        throw new SettingsValidationError("action must be set, clear, or inherit");
      }
    } catch (error) {
      return mutationError(browser, returnTo, error);
    }
    return browser
      ? redirectNotice(returnTo, "Provider key updated.", "success")
      : json(200, { ok: true, ...settingsResponse(settings, deps, scope, target) });
  }

  const restartMatch = /^\/api\/apps\/([^/]+)\/restart$/.exec(request.path);
  if (restartMatch !== null && request.method === "POST") {
    const appKey = safeDecode(restartMatch[1] ?? "");
    const projectId = request.query?.project?.trim() || undefined;
    const found = findApp(deps, projectId, appKey);
    const rawReturn = request.query?.return_to ?? "";
    let returnTo = safeLocalPath(rawReturn, projectId === undefined ? "/settings" : "");
    if (returnTo.length === 0) {
      returnTo =
        found === undefined
          ? "/settings"
          : settingsPagePath("app", {
              projectId: found.project.id,
              appKey: found.app.appKey,
            });
    }
    if (request.body !== undefined && request.body.length > 0 && !isJsonRequest(request)) {
      try {
        const fields = parseForm(request.body);
        returnTo = safeLocalPath(
          fields.return_to,
          found === undefined
            ? "/settings"
            : settingsPagePath("app", {
                projectId: found.project.id,
                appKey: found.app.appKey,
              }),
        );
      } catch (error) {
        if (error instanceof BodyValidationError) {
          return mutationError(browser, returnTo, error);
        }
        throw error;
      }
    }
    if (found === undefined) {
      return browser
        ? redirectNotice(returnTo, "Application not found.", "error")
        : json(404, { error: "not found" });
    }
    if (deps.manager === undefined) {
      return browser
        ? redirectNotice(returnTo, "Agent runtime is not configured.", "error")
        : json(503, { error: "agent runtime is not configured" });
    }
    const restarted = await deps.manager.stopApp(found.app.id);
    if (browser) {
      return redirectNotice(
        returnTo,
        restarted ? "Agent restarted." : "Agent is not running; settings apply on next start.",
        "success",
      );
    }
    return restarted
      ? json(200, { restarted: true })
      : json(200, { restarted: false, reason: "not_running" });
  }

  const page = settingsPageFor(request.path);
  if (page === undefined || request.method !== "GET") {
    return json(404, { error: "not found" });
  }
  const site = buildSite(deps);
  let resolved: ResolvedSettings & { pendingRestart: PendingRestart[] };
  try {
    resolved = settingsResponse(settings, deps, page.scope, page.target);
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return redirectNotice("/settings", error.message, "error");
    }
    throw error;
  }
  const chrome = pageChrome(actor, request);
  const rendered = renderSettingsPage({
    site,
    scope: page.scope,
    target: page.target,
    resolved,
    chrome,
    deps,
    path: request.path,
  });
  if (rendered === undefined) {
    return html(404, renderNotFound(site, chrome));
  }
  return html(200, rendered);
}

function settingsPageFor(
  pathname: string,
): { scope: SettingsScope; target: SettingsTarget } | undefined {
  if (pathname === "/settings") {
    return { scope: "global", target: {} };
  }
  const project = /^\/projects\/([^/]+)\/settings$/.exec(pathname);
  if (project !== null) {
    return {
      scope: "project",
      target: { projectId: safeDecode(project[1] ?? "") },
    };
  }
  const app = /^\/projects\/([^/]+)\/apps\/([^/]+)\/settings$/.exec(pathname);
  if (app !== null) {
    return {
      scope: "app",
      target: {
        projectId: safeDecode(app[1] ?? ""),
        appKey: safeDecode(app[2] ?? ""),
      },
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------------- */
/* Settings pages                                                            */
/* ------------------------------------------------------------------------- */

function scopeLabel(scope: SettingsScope): string {
  if (scope === "global") {
    return "Global";
  }
  return scope === "project" ? "Project" : "Application";
}

function applicableScopes(scope: SettingsScope): SettingsScope[] {
  if (scope === "global") {
    return ["global"];
  }
  return scope === "project" ? ["global", "project"] : ["global", "project", "app"];
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Cleared";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function effectiveBadge(effective: EffectiveValue<unknown>): string {
  if (effective.state === "default") {
    return '<span class="badge">Default</span>';
  }
  if (effective.state === "cleared") {
    return `<span class="badge badge-warning">Cleared at ${escapeHtml(effective.source)}</span>`;
  }
  return `<span class="badge badge--mono">${escapeHtml(effective.source)}</span>`;
}

function stateTone(state: string): string {
  if (state === "set") return "badge-success";
  if (state === "cleared") return "badge-warning";
  return "badge-ghost";
}

function scopedRows(resolved: ResolvedSettings, scope: SettingsScope, key: string): string {
  const rows = applicableScopes(scope)
    .map((entry) => {
      const row = resolved.scoped[`${entry}:${key}`] as ScopedValue<unknown> | undefined;
      const state = row?.state ?? "absent";
      const value = state === "absent" ? "Inherited" : formatValue(row?.value ?? null);
      return `<tr>
        <td data-label="Scope"><span class="mono">${escapeHtml(scopeLabel(entry))}</span></td>
        <td data-label="State"><span class="badge ${stateTone(state)}">${escapeHtml(state)}</span></td>
        <td data-label="Value"><span class="small">${escapeHtml(value)}</span></td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap">
    <table class="table table--stack">
      <thead><tr><th scope="col">Scope</th><th scope="col">State</th><th scope="col">Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function hiddenTarget(scope: SettingsScope, target: SettingsTarget, returnTo: string): string {
  const fields = [
    `<input type="hidden" name="scope" value="${escapeHtml(scope)}" />`,
    `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />`,
  ];
  if (scope !== "global") {
    fields.push(
      `<input type="hidden" name="projectId" value="${escapeHtml(target.projectId ?? "")}" />`,
    );
  }
  if (scope === "app") {
    fields.push(`<input type="hidden" name="appKey" value="${escapeHtml(target.appKey ?? "")}" />`);
  }
  return fields.join("");
}

function effectiveCard(options: {
  title: string;
  key: string;
  effective: EffectiveValue<unknown>;
  scope: SettingsScope;
  resolved: ResolvedSettings;
  controls: string;
  hint?: string;
  warning?: string;
}): string {
  const value = formatValue(options.effective.value);
  const cleared = options.effective.value === null;
  return `<section class="card" id="setting-${escapeHtml(options.key.replace(/\./g, "-"))}" aria-labelledby="setting-${escapeHtml(options.key.replace(/\./g, "-"))}-title">
    <div class="card__head">
      <h2 class="card__title" id="setting-${escapeHtml(options.key.replace(/\./g, "-"))}-title">${escapeHtml(options.title)}</h2>
      <div class="cluster">${effectiveBadge(options.effective)}</div>
    </div>
    <div class="card__body stack--tight">
      <div class="stack--tight">
        <span class="overline">Effective value</span>
        <span class="mono">${escapeHtml(value)}</span>
        ${cleared ? '<span class="small">This tool is disabled at the effective scope.</span>' : ""}
      </div>
      <div class="stack--tight">
        <span class="overline">Scoped state</span>
        ${scopedRows(options.resolved, options.scope, options.key)}
      </div>
      ${options.hint === undefined ? "" : `<p class="hint">${escapeHtml(options.hint)}</p>`}
      ${options.warning === undefined ? "" : `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(options.warning)}</p>`}
      ${options.controls}
    </div>
  </section>`;
}

function modelProviderWarning(resolved: ResolvedSettings): string | undefined {
  const model = resolved.effective.llm.model.value;
  if (model === null) {
    return undefined;
  }
  const provider = model.split("/")[0] ?? "";
  const status = resolved.providerKeys[provider];
  if (status === undefined || status.state === "missing") {
    return `No provider key or host auth is configured for "${provider}". The selected model may fail to authenticate.`;
  }
  if (status.state === "error") {
    return `Provider "${provider}" has an unusable key: ${status.message}`;
  }
  return undefined;
}

function driverFields(current: WebToolConfig | null, key: string): string {
  const deepseekSelected = current !== null && current.driver === "deepseek";
  const options = deepseekSelected && current.driver === "deepseek" ? current.options : {};
  const prefix = key.replace(/\./g, "-");
  const fields = DEEPSEEK_FIELDS.map((field) => {
    const raw = (options as Record<string, unknown>)[field.name];
    if (field.type === "checkbox") {
      const checked = raw === true ? " checked" : "";
      return `<label class="check"><input class="checkbox" type="checkbox" name="${escapeHtml(field.name)}" value="1"${checked} /><span>${escapeHtml(field.label)}</span></label>`;
    }
    const type = field.type === "number" ? "number" : "text";
    const min = field.min === undefined ? "" : ` min="${field.min}"`;
    const max = field.max === undefined ? "" : ` max="${field.max}"`;
    const placeholder =
      field.placeholder === undefined ? "" : ` placeholder="${escapeHtml(field.placeholder)}"`;
    const value = raw === undefined ? "" : String(raw);
    const required = field.required === true && deepseekSelected ? " required" : "";
    const id = `${prefix}-${field.name}`;
    return `<div class="field"><label class="label" for="${escapeHtml(id)}">${escapeHtml(field.label)}</label><input class="input" id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" type="${type}"${min}${max}${required} value="${escapeHtml(value)}"${placeholder} /></div>`;
  }).join("");
  return `<div class="stack--tight" data-driver-fields="deepseek"${deepseekSelected ? "" : " hidden"}>${fields}</div>`;
}

function webControls(options: {
  key: string;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
  current: WebToolConfig | null;
  clearable: boolean;
}): string {
  const driver = options.current?.driver === "deepseek" ? "deepseek" : "builtin";
  const choices = webDriverDefinitions
    .map(
      (definition) =>
        `<option value="${escapeHtml(definition.id)}"${definition.id === driver ? " selected" : ""}>${escapeHtml(definition.label)}</option>`,
    )
    .join("");
  const clear = options.clearable
    ? '<button class="btn btn-danger btn-sm" type="submit" name="action" value="clear">Clear</button>'
    : "";
  return `<form class="stack--tight" method="post" action="/api/settings">
    ${hiddenTarget(options.scope, options.target, options.returnTo)}
    <input type="hidden" name="key" value="${escapeHtml(options.key)}" />
    <div class="field">
      <label class="label" for="${escapeHtml(options.key.replace(/\./g, "-"))}-driver">Driver</label>
      <div class="select-wrap">
        <select class="select" id="${escapeHtml(options.key.replace(/\./g, "-"))}-driver" name="driver" data-settings-driver>${choices}</select>
        ${icon("chevron-down")}
      </div>
    </div>
    ${driverFields(options.current, options.key)}
    <div class="cluster">
      <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Set</button>
      <button class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit">Inherit</button>
      ${clear}
    </div>
  </form>`;
}

function modelControls(scope: SettingsScope, target: SettingsTarget, returnTo: string): string {
  return `<form class="stack--tight" method="post" action="/api/settings">
    ${hiddenTarget(scope, target, returnTo)}
    <input type="hidden" name="key" value="llm.model" />
    <div class="field">
      <label class="label" for="model-value">Model</label>
      <input class="input" id="model-value" name="value" type="text" placeholder="provider/model" required autocomplete="off" />
    </div>
    <div class="cluster">
      <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Set model</button>
      <button class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit">Inherit</button>
    </div>
  </form>`;
}

function webToolWarning(
  key: string,
  effective: EffectiveValue<WebToolConfig>,
  resolved: ResolvedSettings,
): string | undefined {
  const value = effective.value;
  if (value === null) {
    return undefined;
  }
  if (value.driver === "builtin") {
    if (key === "web.search" && (process.env.HANSE_OMO_PLUGIN ?? "").trim().length === 0) {
      return "Built-in search requires the OMO baseline (HANSE_OMO_PLUGIN). No built-in search tool is available until OMO is installed and enabled.";
    }
    return undefined;
  }
  const status = resolved.providerKeys[value.options.provider];
  if (status === undefined || status.state === "missing") {
    return `No provider key or host auth is configured for "${value.options.provider}". The managed web tool will be unavailable.`;
  }
  if (status.state === "error") {
    return `Provider "${value.options.provider}" has an unusable key: ${status.message}`;
  }
  return undefined;
}

function providerStatusLabel(status: ResolvedSettings["providerKeys"][string]): string {
  switch (status.state) {
    case "set":
      return `Set at ${status.source}`;
    case "cleared":
      return `Cleared at ${status.source}`;
    case "host":
      return `Host auth (${status.authType})`;
    case "error":
      return `Error: ${status.message}`;
    default:
      return "Missing";
  }
}

function providerSection(options: {
  resolved: ResolvedSettings;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
}): string {
  const providers = Object.entries(options.resolved.providerKeys).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rows =
    providers.length === 0
      ? '<p class="hint">No providers are referenced by the effective model or web tools.</p>'
      : providers
          .map(([provider, status], index) => {
            const tone =
              status.state === "set"
                ? "badge-success"
                : status.state === "cleared"
                  ? "badge-warning"
                  : status.state === "error"
                    ? "badge-error"
                    : "badge-ghost";
            const providerId = `provider-${index}`;
            const keyId = `provider-key-${index}`;
            return `<div class="card__body stack--tight" id="${providerId}">
              <div class="cluster"><span class="mono">${escapeHtml(provider)}</span><span class="badge ${tone}">${escapeHtml(providerStatusLabel(status))}</span></div>
              <form class="cluster" method="post" action="/api/settings/provider">
                ${hiddenTarget(options.scope, options.target, options.returnTo)}
                <input type="hidden" name="provider" value="${escapeHtml(provider)}" />
                <div class="field"><label class="label" for="${keyId}">API key</label><input class="input" id="${keyId}" name="key" type="password" autocomplete="new-password" placeholder="Not shown" /></div>
                <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Set key</button>
                <button class="btn btn-secondary btn-sm" type="submit" name="action" value="clear">Clear</button>
                <button class="btn btn-ghost btn-sm" type="submit" name="action" value="inherit">Inherit</button>
              </form>
            </div>`;
          })
          .join("");
  return `<section class="card" id="providers" aria-labelledby="providers-title">
    <div class="card__head"><h2 class="card__title" id="providers-title">Providers</h2><span class="badge">${plural(providers.length, "provider")}</span></div>
    <div class="card__body stack--tight">
      <p class="hint">Keys are encrypted at rest and never shown again. A cleared key suppresses wider scopes and host auth.</p>
      ${rows}
      <form class="stack--tight" method="post" action="/api/settings/provider">
        ${hiddenTarget(options.scope, options.target, options.returnTo)}
        <div class="field"><label class="label" for="provider-new">Provider</label><input class="input" id="provider-new" name="provider" type="text" placeholder="deepseek" required autocomplete="off" /></div>
        <div class="field"><label class="label" for="provider-new-key">API key</label><input class="input" id="provider-new-key" name="key" type="password" autocomplete="new-password" required /></div>
        <div class="cluster"><button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Set provider key</button></div>
      </form>
    </div>
  </section>`;
}

function pendingSection(options: { pending: PendingRestart[]; returnTo: string }): string {
  const rows =
    options.pending.length === 0
      ? '<p class="hint">No running agents are waiting for a restart.</p>'
      : `<div class="stack--tight">${options.pending
          .map((entry) => {
            const href = `/projects/${encodeURIComponent(entry.projectId)}/apps/${encodeURIComponent(entry.appKey)}`;
            return `<div class="cluster" id="pending-${escapeHtml(entry.appId)}">
              <span class="badge badge-warning">Restart required</span>
              <a class="small" href="${escapeHtml(href)}">${escapeHtml(entry.appKey)}</a>
              <span class="mono">${escapeHtml(entry.reasons.join(", "))}</span>
              <form method="post" action="/api/apps/${encodeURIComponent(entry.appKey)}/restart?project=${encodeURIComponent(entry.projectId)}">
                <input type="hidden" name="return_to" value="${escapeHtml(options.returnTo)}" />
                <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
              </form>
            </div>`;
          })
          .join("")}</div>`;
  return `<section class="card" id="restart-pending" aria-labelledby="restart-pending-title">
    <div class="card__head"><h2 class="card__title" id="restart-pending-title">Restart &amp; pending</h2><span class="badge">${options.pending.length}</span></div>
    <div class="card__body stack--tight">
      <p class="hint">Settings changes apply only on an explicit restart. A restart interrupts an active turn; sessions are kept.</p>
      ${rows}
    </div>
  </section>`;
}

function warningsSection(warnings: string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return `<section class="card" aria-labelledby="settings-warnings-title">
    <div class="card__head"><h2 class="card__title" id="settings-warnings-title">Warnings</h2><span class="badge badge-warning">${warnings.length}</span></div>
    <div class="card__body stack--tight">${warnings
      .map(
        (warning) =>
          `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(warning)}</p>`,
      )
      .join("")}</div>
  </section>`;
}

function profileWarningsSection(warnings: string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return `<section class="card" aria-labelledby="profile-warnings-title">
    <div class="card__head"><h2 class="card__title" id="profile-warnings-title">OMO profile warnings</h2><span class="badge badge-warning">${warnings.length}</span></div>
    <div class="card__body stack--tight">${warnings
      .map(
        (warning) =>
          `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(warning)}</p>`,
      )
      .join("")}</div>
  </section>`;
}

function renderSettingsPage(options: {
  site: SiteModel;
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings & { pendingRestart: PendingRestart[] };
  chrome: PageChrome;
  deps: HttpDeps;
  path: string;
}): string | undefined {
  const project =
    options.target.projectId === undefined
      ? undefined
      : options.site.projects.find((entry) => entry.id === options.target.projectId);
  if (options.scope !== "global" && project === undefined) {
    return undefined;
  }
  const app =
    options.scope === "app" && project !== undefined
      ? project.apps.find((entry) => entry.appKey === options.target.appKey)
      : undefined;
  if (options.scope === "app" && app === undefined) {
    return undefined;
  }

  const title =
    options.scope === "global"
      ? "Settings"
      : options.scope === "project" && project !== undefined
        ? `${project.name} settings`
        : `${app?.appKey ?? ""} settings`;
  const description =
    options.scope === "global"
      ? "Coordinator-wide defaults for models, provider keys, and web tools. Narrower scopes can override them."
      : options.scope === "project"
        ? `Project overrides for ${project?.name ?? ""}. Application scopes can override these values.`
        : `Application overrides for ${app?.appKey ?? ""}. These values are the narrowest scope.`;

  const breadcrumb =
    options.scope === "global"
      ? [{ label: "Workbench", href: "/" }, { label: "Settings" }]
      : options.scope === "project"
        ? [
            { label: "Projects", href: "/projects" },
            {
              label: project?.name ?? "",
              href: `/projects/${encodeURIComponent(project?.id ?? "")}`,
            },
            { label: "Settings" },
          ]
        : [
            { label: "Projects", href: "/projects" },
            {
              label: project?.name ?? "",
              href: `/projects/${encodeURIComponent(project?.id ?? "")}`,
            },
            {
              label: app?.appKey ?? "",
              href: `/projects/${encodeURIComponent(project?.id ?? "")}/apps/${encodeURIComponent(app?.appKey ?? "")}`,
            },
            { label: "Settings" },
          ];

  const returnTo = options.path;
  const effectiveModel = options.resolved.effective.llm.model;
  const modelWarning = modelProviderWarning(options.resolved);
  const scopedLinks =
    options.scope === "global"
      ? ""
      : `<div class="cluster"><a class="btn btn-ghost btn-sm" href="/settings">Global settings</a>${
          options.scope === "app" && project !== undefined
            ? `<a class="btn btn-ghost btn-sm" href="/projects/${encodeURIComponent(project.id)}/settings">Project settings</a>`
            : ""
        }</div>`;

  const header = pageHeader({
    overline: "Settings",
    title,
    description,
    meta: [scopeLabel(options.scope), `model ${formatValue(effectiveModel.value)}`],
  });

  const body = `${warningsSection(options.resolved.warnings)}
    <div class="stack section">
      <section class="card" aria-labelledby="settings-scope-title">
        <div class="card__head"><h2 class="card__title" id="settings-scope-title">Scope</h2><span class="badge badge--mono">${escapeHtml(scopeLabel(options.scope))}</span></div>
        <div class="card__body stack--tight">
          <p class="hint">Resolution walks global to project to application. Inherit removes this scope's row; Clear disables a clearable setting at this scope.</p>
          ${scopedLinks}
        </div>
      </section>
      ${effectiveCard({
        title: "Model",
        key: "llm.model",
        effective: effectiveModel as EffectiveValue<unknown>,
        scope: options.scope,
        resolved: options.resolved,
        hint: "Selected model applies to new sessions and OMO agents; existing sessions may keep their model.",
        warning: modelWarning,
        controls: modelControls(options.scope, options.target, returnTo),
      })}
      ${providerSection({
        resolved: options.resolved,
        scope: options.scope,
        target: options.target,
        returnTo,
      })}
      ${effectiveCard({
        title: "Web search",
        key: "web.search",
        effective: options.resolved.effective.web.search as EffectiveValue<unknown>,
        scope: options.scope,
        resolved: options.resolved,
        hint: "Built-in uses the existing OMO/opencode tools. DeepSeek uses the managed hanse_web MCP server.",
        warning: webToolWarning(
          "web.search",
          options.resolved.effective.web.search,
          options.resolved,
        ),
        controls: webControls({
          key: "web.search",
          scope: options.scope,
          target: options.target,
          returnTo,
          current: options.resolved.effective.web.search.value,
          clearable: true,
        }),
      })}
      ${effectiveCard({
        title: "Web fetch",
        key: "web.fetch",
        effective: options.resolved.effective.web.fetch as EffectiveValue<unknown>,
        scope: options.scope,
        resolved: options.resolved,
        hint: "Built-in uses opencode webfetch. DeepSeek uses the managed hanse_web MCP server.",
        warning: webToolWarning(
          "web.fetch",
          options.resolved.effective.web.fetch,
          options.resolved,
        ),
        controls: webControls({
          key: "web.fetch",
          scope: options.scope,
          target: options.target,
          returnTo,
          current: options.resolved.effective.web.fetch.value,
          clearable: true,
        }),
      })}
      ${pendingSection({ pending: options.resolved.pendingRestart, returnTo })}
      ${
        options.scope === "app" && app !== undefined
          ? profileWarningsSection(options.deps.manager?.profileWarnings(app.id) ?? [])
          : ""
      }
    </div>`;

  return appShell({
    title,
    active: "settings",
    activeProjectId: project?.id,
    breadcrumb,
    projects: options.site.projects.map((entry) => ({
      id: entry.id,
      name: entry.name,
      appCount: entry.apps.length,
    })),
    pendingCount: options.site.pendingCount,
    operatorName: options.chrome.operatorName,
    notice: options.chrome.notice,
    header,
    scripts: ["/assets/settings.js"],
    body,
  });
}
