import { GitCredentialValidationError } from "../git/credentials.js";
import {
  collisionWarnings,
  type ModelProvider,
  ModelProviderConflictError,
  ModelProviderInUseError,
  type ModelProviderModel,
  ModelProviderNotFoundError,
  ModelProviderValidationError,
  parseModelLines,
  providerBaseUrlWarnings,
} from "../model-providers/index.js";
import type { RegisteredApp } from "../registry/index.js";
import {
  type EffectiveValue,
  type PendingRestart,
  type ResolvedSettings,
  type ScopedValue,
  type SettingsService,
  SettingsValidationError,
} from "../settings/index.js";
import type {
  GitAuthKind,
  GitAuthScoped,
  GitAuthScopedState,
  GitAuthStatus,
  SettingsScope,
  SettingsTarget,
} from "../settings/types.js";
import { DEEPSEEK_FIELDS, webDriverDefinitions } from "../web/registry.js";
import type { WebToolConfig } from "../web/types.js";
import { findApp, toManagedApp } from "./apps.js";
import { humanFrom, principalFrom } from "./auth.js";
import { crossSiteMutation } from "./chat.js";
import {
  buildSite,
  type PageChrome,
  type ProjectView,
  renderNotFound,
  type SiteModel,
} from "./dashboard.js";
import { lifecycleErrorResponse } from "./errors.js";
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

function wantsFragment(request: HttpRequest): boolean {
  return (request.headers["x-hanse-fragment"] ?? "").trim().toLowerCase() === "settings";
}

const SECTION_KEYS = ["agent", "web", "context", "git", "restart", "warnings"] as const;

type SettingsSectionKey = (typeof SECTION_KEYS)[number];

type SettingsSections = Record<SettingsSectionKey, string>;

interface SettingsPageEntities {
  project?: ProjectView;
  app?: RegisteredApp;
}

function pageEntities(
  site: SiteModel,
  scope: SettingsScope,
  target: SettingsTarget,
): SettingsPageEntities | undefined {
  if (scope === "global") {
    return {};
  }
  const project =
    target.projectId === undefined
      ? undefined
      : site.projects.find((entry) => entry.id === target.projectId);
  if (project === undefined) {
    return undefined;
  }
  if (scope === "project") {
    return { project };
  }
  const app = project.apps.find((entry) => entry.appKey === target.appKey);
  if (app === undefined) {
    return undefined;
  }
  return { project, app };
}

function targetExists(deps: HttpDeps, scope: SettingsScope, target: SettingsTarget): boolean {
  if (scope === "global") {
    return true;
  }
  const project = deps.getProjects().find((entry) => entry.id === target.projectId);
  if (project === undefined) {
    return false;
  }
  if (scope === "project") {
    return true;
  }
  return project.service.listApps().some((app) => app.appKey === target.appKey);
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

function firstAppSettingsPath(site: SiteModel, projectId?: string): string | undefined {
  const project =
    projectId === undefined
      ? site.projects.find((entry) => entry.apps.length > 0)
      : site.projects.find((entry) => entry.id === projectId);
  const app = project?.apps[0];
  if (project === undefined || app === undefined) {
    return undefined;
  }
  return `/projects/${encodeURIComponent(project.id)}/apps/${encodeURIComponent(app.appKey)}/settings`;
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

function fragmentResponse(
  deps: HttpDeps,
  settings: SettingsService,
  scope: SettingsScope,
  target: SettingsTarget,
  changed: SettingsSectionKey[],
): HttpResponse {
  const site = buildSite(deps);
  const entities = pageEntities(site, scope, target);
  if (entities === undefined) {
    return json(404, { error: "not found" });
  }
  const resolved = settingsResponse(settings, deps, scope, target);
  const sections = settingsSections({
    site,
    scope,
    target,
    resolved,
    deps,
    returnTo: settingsPagePath(scope, target),
    ...(entities.project === undefined ? {} : { project: entities.project }),
    ...(entities.app === undefined ? {} : { app: entities.app }),
  });
  const selected: Partial<SettingsSections> = {};
  for (const key of changed) {
    selected[key] = sections[key];
  }
  return json(200, { ok: true, changed, sections: selected });
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

function contextSettingValue(key: string, raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  if (key === "context.auto_compact.enabled") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "on" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "off" || normalized === "0") {
      return false;
    }
    return raw;
  }
  if (key === "context.auto_compact.percent") {
    if (raw.trim().length === 0) {
      return raw;
    }
    return Number(raw);
  }
  return raw;
}

function settingValue(
  key: string,
  action: string,
  payload: Record<string, unknown>,
  json: boolean,
): unknown {
  if (json) {
    return payload.value;
  }
  if (key === "context.auto_compact.enabled" || key === "context.auto_compact.percent") {
    return contextSettingValue(key, payload.value);
  }
  if (key !== "web.search" && key !== "web.fetch") {
    return payload.value;
  }
  if (action === "set") {
    return buildWebToolValue(payload);
  }
  return payload.value;
}

function mutationSections(key: string): SettingsSectionKey[] {
  if (key.startsWith("git.")) {
    return ["git", "restart"];
  }
  if (key.startsWith("context.")) {
    return ["context", "restart", "warnings"];
  }
  return ["agent", "web", "context", "restart", "warnings"];
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

function gitAuthMutationError(error: unknown): HttpResponse {
  if (error instanceof GitCredentialValidationError) {
    return json(400, {
      error: error.message,
      code: "invalid_git_credential",
      ...(error.field === undefined ? {} : { field: error.field }),
    });
  }
  if (error instanceof SettingsValidationError) {
    return json(400, { error: error.message, code: "invalid_git_credential" });
  }
  if (error instanceof BodyValidationError) {
    return json(400, { error: error.message, code: "invalid_request" });
  }
  throw error;
}

function modelProviderWarnings(
  providers: readonly ModelProvider[],
  existingProviderIds: ReadonlySet<string>,
): Record<string, string[]> {
  const warnings: Record<string, string[]> = {};
  for (const provider of providers) {
    const list = [
      ...collisionWarnings(provider.id, existingProviderIds),
      ...providerBaseUrlWarnings(provider.baseUrl),
    ];
    if (list.length > 0) {
      warnings[provider.id] = list;
    }
  }
  return warnings;
}

function modelProviderMutationError(
  browser: boolean,
  returnTo: string,
  error: unknown,
): HttpResponse {
  if (error instanceof ModelProviderValidationError || error instanceof BodyValidationError) {
    return browser
      ? redirectNotice(returnTo, error.message, "error")
      : json(400, { error: error.message, code: "VALIDATION" });
  }
  if (error instanceof ModelProviderConflictError) {
    return browser
      ? redirectNotice(returnTo, error.message, "error")
      : json(409, { error: error.message, code: error.code });
  }
  if (error instanceof ModelProviderInUseError) {
    return browser
      ? redirectNotice(returnTo, error.message, "error")
      : json(409, { error: error.message, code: error.code, references: error.references });
  }
  if (error instanceof ModelProviderNotFoundError) {
    return browser
      ? redirectNotice(returnTo, error.message, "error")
      : json(404, { error: error.message, code: error.code });
  }
  if (error instanceof SettingsValidationError) {
    return browser
      ? redirectNotice(returnTo, error.message, "error")
      : json(400, { error: error.message, code: "VALIDATION" });
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
  if (pathname === "/api/settings/model-providers") {
    return true;
  }
  if (pathname === "/api/settings/git") {
    return method === "POST";
  }
  if (/^\/projects\/[^/]+\/settings$/.test(pathname)) {
    return method === "GET";
  }
  if (/^\/projects\/[^/]+\/apps\/[^/]+\/settings$/.test(pathname)) {
    return method === "GET";
  }
  return method === "POST" && /^\/api\/apps\/[^/]+\/restart$/.test(pathname);
}

function authorize(
  deps: HttpDeps,
  request: HttpRequest,
  browser: boolean,
): HttpResponse | undefined {
  if (browser) {
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
  const fragment = wantsFragment(request);
  const browser = wantsHtml(request) && !fragment;
  const denied = authorize(deps, request, browser);
  if (denied !== undefined) {
    return denied;
  }
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
    let key = "";
    const jsonBody = isJsonRequest(request);
    try {
      payload = parseObjectBody(request);
      ({ scope, target } = parseTarget(payload));
      returnTo = safeLocalPath(stringValue(payload.return_to), settingsPagePath(scope, target));
      if (fragment && !targetExists(deps, scope, target)) {
        return json(404, { error: "not found" });
      }
      key = stringValue(payload.key) ?? "";
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
    if (fragment) {
      return fragmentResponse(deps, settings, scope, target, mutationSections(key));
    }
    return browser
      ? redirectNotice(returnTo, "Settings saved.", "success")
      : json(200, settingsResponse(settings, deps, scope, target));
  }

  if (request.path === "/api/settings/git" && request.method === "POST") {
    try {
      if (!isJsonRequest(request)) {
        throw new BodyValidationError("Git credential requests must use a JSON body.");
      }
      const payload = parseObjectBody(request);
      const { scope, target } = parseTarget(payload);
      if (fragment && !targetExists(deps, scope, target)) {
        return json(404, { error: "not found" });
      }
      const kind = stringValue(payload.kind);
      if (kind !== "ssh" && kind !== "https") {
        throw new SettingsValidationError("kind must be ssh or https");
      }
      const action = stringValue(payload.action) ?? "";
      if (action === "set") {
        if (payload.value === undefined) {
          throw new SettingsValidationError("value is required for set");
        }
        settings.setGitAuth(scope, target, kind, payload.value, actor);
      } else if (action === "clear" || action === "inherit") {
        if (payload.value !== undefined) {
          throw new SettingsValidationError("value is not allowed for clear or inherit");
        }
        if (action === "clear") {
          settings.clearGitAuth(scope, target, kind, actor);
        } else {
          settings.inheritGitAuth(scope, target, kind);
        }
      } else {
        throw new SettingsValidationError("action must be set, clear, or inherit");
      }
      if (fragment) {
        return fragmentResponse(deps, settings, scope, target, ["git", "restart"]);
      }
      return json(200, settingsResponse(settings, deps, scope, target));
    } catch (error) {
      return gitAuthMutationError(error);
    }
  }

  if (request.path === "/api/settings/model-providers") {
    const modelProviders = deps.modelProviders;
    if (modelProviders === undefined) {
      return json(503, {
        error: "model providers are not configured",
        code: "model_providers_not_configured",
      });
    }
    if (request.method === "GET") {
      const providers = modelProviders.list();
      return json(200, {
        providers,
        warnings: modelProviderWarnings(providers, new Set(settings.allProviderIds())),
      });
    }
    if (request.method === "POST") {
      if (crossSiteMutation(request)) {
        return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
      }
      let payload: Record<string, unknown> = {};
      let returnTo = "/settings#custom-providers";
      try {
        payload = parseObjectBody(request);
        returnTo = safeLocalPath(stringValue(payload.return_to), "/settings#custom-providers");
        const action = stringValue(payload.action) ?? "";
        const id = stringValue(payload.id)?.trim() ?? "";
        if (payload.delete === "1" || action === "delete") {
          modelProviders.delete(id, actor);
        } else if (action === "create" || action === "update") {
          const name = stringValue(payload.name);
          const baseUrl = stringValue(payload.baseUrl ?? payload.base_url) ?? "";
          const models =
            typeof payload.models === "string" ? parseModelLines(payload.models) : payload.models;
          if (action === "create") {
            modelProviders.create({ id, name, baseUrl, models }, actor);
          } else {
            modelProviders.update(id, { id, name, baseUrl, models }, actor);
          }
        } else {
          throw new SettingsValidationError("action must be create, update, or delete");
        }
      } catch (error) {
        return modelProviderMutationError(browser, returnTo, error);
      }
      if (fragment) {
        return fragmentResponse(deps, settings, "global", {}, ["agent", "restart", "warnings"]);
      }
      if (browser) {
        const deleted = payload.delete === "1" || payload.action === "delete";
        return redirectNotice(
          returnTo,
          deleted ? "Provider deleted." : "Provider saved.",
          "success",
        );
      }
      const providers = modelProviders.list();
      return json(200, {
        ok: true,
        providers,
        warnings: modelProviderWarnings(providers, new Set(settings.allProviderIds())),
      });
    }
    return json(405, { error: "method not allowed" });
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
      if (fragment && !targetExists(deps, scope, target)) {
        return json(404, { error: "not found" });
      }
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
    if (fragment) {
      return fragmentResponse(deps, settings, scope, target, [
        "agent",
        "web",
        "context",
        "restart",
        "warnings",
      ]);
    }
    return browser
      ? redirectNotice(returnTo, "Provider key updated.", "success")
      : json(200, { ok: true, ...settingsResponse(settings, deps, scope, target) });
  }

  const restartMatch = /^\/api\/apps\/([^/]+)\/restart$/.exec(request.path);
  if (restartMatch !== null && request.method === "POST") {
    if (crossSiteMutation(request)) {
      return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
    }
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
    const manager = deps.manager;
    if (manager === undefined) {
      return browser
        ? redirectNotice(returnTo, "Agent runtime is not configured.", "error")
        : json(503, { error: "agent runtime is not configured" });
    }
    try {
      deps.deploymentLock?.assertUnlocked("restart");
    } catch (error) {
      const mapped = lifecycleErrorResponse(error);
      if (mapped !== undefined) {
        return mapped;
      }
      throw error;
    }
    const managed = toManagedApp(found);
    let running: boolean;
    try {
      running = await manager.preflightRestart(managed);
    } catch (error) {
      const mapped = lifecycleErrorResponse(error);
      if (mapped !== undefined) {
        if (browser) {
          return redirectNotice(
            returnTo,
            error instanceof Error ? error.message : "The application image is not ready.",
            "error",
          );
        }
        return mapped;
      }
      throw error;
    }
    if (!running) {
      return browser
        ? redirectNotice(returnTo, "Agent is not running; settings apply on next start.", "success")
        : json(200, { restarted: false, reason: "not_running" });
    }
    const asynchronous = request.query?.async === "1" || request.query?.async === "true";
    const claim = manager.beginRestart(managed);
    if (!claim.accepted || claim.completion === undefined) {
      return json(409, { error: "restart_in_progress" });
    }
    if (asynchronous) {
      return json(202, { accepted: true, appId: found.app.id });
    }
    let restarted: boolean;
    try {
      restarted = await claim.completion;
    } catch (error) {
      const mapped = lifecycleErrorResponse(error);
      if (mapped !== undefined) {
        return mapped;
      }
      return browser
        ? redirectNotice(returnTo, "Restart failed. Check the runtime log and retry.", "error")
        : json(502, { error: "restart failed" });
    }
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

function effectiveText(effective: EffectiveValue<unknown>): string {
  if (effective.state === "default") {
    return effective.value === null ? "Not set" : formatValue(effective.value);
  }
  if (effective.state === "cleared") {
    return "Cleared";
  }
  return formatValue(effective.value);
}

function sourceName(source: SettingsScope | "default"): string {
  return source === "default" ? "default" : scopeLabel(source);
}

function sourceLine(effective: EffectiveValue<unknown>): string {
  if (effective.state === "cleared" && effective.source !== "default") {
    return `Cleared at ${scopeLabel(effective.source)}`;
  }
  if (effective.source === "default") {
    return "default";
  }
  return `from ${scopeLabel(effective.source)}`;
}

function ownValue(
  resolved: ResolvedSettings,
  scope: SettingsScope,
  key: string,
): ScopedValue<unknown> {
  return resolved.scoped[`${scope}:${key}`] ?? { state: "absent", value: null };
}

function stringPrefill(
  scope: SettingsScope,
  own: ScopedValue<unknown>,
  effective: EffectiveValue<string>,
): { value: string; placeholder: string } {
  if (own.state === "set" && typeof own.value === "string") {
    return { value: own.value, placeholder: "" };
  }
  const prefix = scope === "global" ? "Default" : "Inherited";
  const fallback =
    effective.state === "cleared"
      ? "Cleared"
      : effective.value === null
        ? "Not set"
        : effective.value;
  return { value: "", placeholder: `${prefix}: ${fallback}` };
}

function isWebToolConfig(value: unknown): value is WebToolConfig {
  if (typeof value !== "object" || value === null || !("driver" in value)) {
    return false;
  }
  const driver = (value as { driver?: unknown }).driver;
  return driver === "builtin" || driver === "deepseek";
}

function ownWebValue(
  resolved: ResolvedSettings,
  scope: SettingsScope,
  key: string,
): WebToolConfig | null {
  const own = ownValue(resolved, scope, key);
  return own.state === "set" && isWebToolConfig(own.value) ? own.value : null;
}

function withHash(pathname: string, hash: string): string {
  return `${pathname}${hash}`;
}

function fieldErrorSlot(id: string): string {
  return `<p class="field-error" id="${escapeHtml(id)}" data-settings-error role="alert" hidden></p>`;
}

function warningList(warnings: string[]): string {
  return warnings
    .map(
      (warning) =>
        `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(warning)}</p>`,
    )
    .join("");
}

function scopeStateLabel(state: ScopedValue<unknown>["state"]): string {
  if (state === "set") {
    return "Set";
  }
  return state === "cleared" ? "Cleared" : "Inherited";
}

function scopeDetailsHtml(resolved: ResolvedSettings, scope: SettingsScope, key: string): string {
  if (scope === "global") {
    return "";
  }
  const rows = applicableScopes(scope)
    .map((entry) => {
      const row = resolved.scoped[`${entry}:${key}`] ?? { state: "absent", value: null };
      const value =
        row.state === "set"
          ? `<span class="mono">${escapeHtml(formatValue(row.value))}</span>`
          : "";
      return `<div class="scope-list__row"><dt>${escapeHtml(scopeLabel(entry))}</dt><dd>${value}<span class="scope-list__state">${escapeHtml(scopeStateLabel(row.state))}</span></dd></div>`;
    })
    .join("");
  return `<details class="disclosure scope-details">
    <summary>Scope details${icon("chevron-down", "disclosure__chevron")}</summary>
    <dl class="scope-list">${rows}</dl>
  </details>`;
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

function inheritAction(options: {
  scope: SettingsScope;
  ownState: ScopedValue<unknown>["state"];
  effective: EffectiveValue<unknown>;
}): { button: string; reason: string } {
  if (options.scope === "global") {
    return { button: "", reason: "" };
  }
  const attributes =
    'class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit" formnovalidate data-settings-inherit';
  if (options.ownState !== "absent") {
    return { button: `<button ${attributes}>Inherit</button>`, reason: "" };
  }
  const inherited =
    options.effective.source !== "default" &&
    (options.effective.state === "set" || options.effective.state === "cleared");
  const reason = inherited
    ? `Already inherited from ${scopeLabel(options.effective.source as SettingsScope)}.`
    : "Already uses the default.";
  return {
    button: `<button ${attributes} disabled>Inherit</button>`,
    reason: `<p class="hint setting-row__reason">${escapeHtml(reason)}</p>`,
  };
}

function clearAction(options: {
  scope: SettingsScope;
  ownState: ScopedValue<unknown>["state"];
  label: string;
  globalWarning: boolean;
}): { button: string; reason: string; warning: string } {
  const warning =
    options.scope === "global" && options.globalWarning
      ? '<p class="hint setting-row__reason">Clearing here disables this setting for every application.</p>'
      : "";
  const attributes = `class="btn btn-danger btn-sm" type="submit" name="action" value="clear" formnovalidate data-confirm-clear data-setting-label="${escapeHtml(options.label)}"`;
  if (options.ownState === "cleared") {
    return {
      button: `<button ${attributes} disabled>Clear</button>`,
      reason: '<p class="hint setting-row__reason">Already cleared at this scope.</p>',
      warning,
    };
  }
  return { button: `<button ${attributes}>Clear</button>`, reason: "", warning };
}

function standardActions(options: {
  scope: SettingsScope;
  ownState: ScopedValue<unknown>["state"];
  effective: EffectiveValue<unknown>;
  label: string;
  clearable: boolean;
  globalWarning?: boolean;
}): string {
  const inherit = inheritAction({
    scope: options.scope,
    ownState: options.ownState,
    effective: options.effective,
  });
  const clear = options.clearable
    ? clearAction({
        scope: options.scope,
        ownState: options.ownState,
        label: options.label,
        globalWarning: options.globalWarning === true,
      })
    : { button: "", reason: "", warning: "" };
  return `<div class="setting-row__actions">
      <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
      ${inherit.button}
      ${clear.button}
    </div>
    ${inherit.reason}
    ${clear.reason}
    ${clear.warning}`;
}

function settingRow(options: {
  id: string;
  title: string;
  summaryNote?: string;
  effectiveText: string;
  source: string;
  state?: string;
  hint?: string;
  warnings?: string[];
  body: string;
  details?: string;
}): string {
  const note =
    options.summaryNote === undefined
      ? ""
      : `<span class="setting-row__affordance">${escapeHtml(options.summaryNote)}</span>`;
  return `<details class="setting-row" id="${escapeHtml(options.id)}">
    <summary class="setting-row__summary">
      <span class="setting-row__title">${escapeHtml(options.title)}${note}</span>
      <span class="setting-row__effective">
        <span class="mono">${escapeHtml(options.effectiveText)}</span>
        <span class="setting-row__source">${escapeHtml(options.source)}</span>
      </span>
      <span class="setting-row__state">${options.state ?? ""}</span>
      <span class="setting-row__chevron">${icon("chevron-down")}</span>
    </summary>
    <div class="setting-row__body">
      ${options.hint === undefined ? "" : `<p class="hint">${escapeHtml(options.hint)}</p>`}
      ${options.warnings === undefined || options.warnings.length === 0 ? "" : warningList(options.warnings)}
      ${options.body}
      ${options.details ?? ""}
    </div>
  </details>`;
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
  title: string;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
  resolved: ResolvedSettings;
  effective: EffectiveValue<WebToolConfig>;
  current: WebToolConfig | null;
}): string {
  const driver = options.current?.driver;
  const choices = webDriverDefinitions
    .map(
      (definition) =>
        `<option value="${escapeHtml(definition.id)}"${definition.id === driver ? " selected" : ""}>${escapeHtml(definition.label)}</option>`,
    )
    .join("");
  const placeholder = `<option value=""${driver === undefined ? " selected" : ""} disabled>Choose a driver</option>`;
  const own = ownValue(options.resolved, options.scope, options.key);
  const inherited =
    options.scope !== "global" && own.state === "absent" && options.effective.value !== null
      ? `<p class="hint">This scope inherits ${escapeHtml(options.effective.value.driver)} from ${escapeHtml(sourceName(options.effective.source))}. Saving creates an override.</p>`
      : "";
  return `<form class="setting-row__form" method="post" action="/api/settings" data-settings-form data-no-busy data-success-notice="Settings saved.">
    ${hiddenTarget(options.scope, options.target, withHash(options.returnTo, `#${options.key.replace(/\./g, "-")}`))}
    <input type="hidden" name="key" value="${escapeHtml(options.key)}" />
    ${inherited}
    <div class="field">
      <label class="label" for="${escapeHtml(options.key.replace(/\./g, "-"))}-driver">Driver</label>
      <div class="select-wrap">
        <select class="select" id="${escapeHtml(options.key.replace(/\./g, "-"))}-driver" name="driver" data-settings-driver required>${placeholder}${choices}</select>
        ${icon("chevron-down")}
      </div>
    </div>
    ${driverFields(options.current, options.key)}
    ${standardActions({
      scope: options.scope,
      ownState: own.state,
      effective: options.effective as EffectiveValue<unknown>,
      label: options.title,
      clearable: true,
      globalWarning: true,
    })}
  </form>`;
}

function modelControls(options: {
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  effective: EffectiveValue<string>;
  providers: readonly ModelProvider[];
  returnTo: string;
}): string {
  const own = ownValue(options.resolved, options.scope, "llm.model");
  const prefill = stringPrefill(options.scope, own, options.effective);
  const pairs = [
    ...new Set(
      options.providers.flatMap((provider) =>
        provider.models.map((model) => `${provider.id}/${model.id}`),
      ),
    ),
  ].sort();
  const datalist =
    pairs.length === 0
      ? ""
      : `<datalist id="model-options">${pairs
          .map((value) => `<option value="${escapeHtml(value)}"></option>`)
          .join("")}</datalist>`;
  const listAttribute = pairs.length === 0 ? "" : ' list="model-options"';
  return `<form class="setting-row__form" method="post" action="/api/settings" data-settings-form data-no-busy data-success-notice="Settings saved.">
    ${hiddenTarget(options.scope, options.target, withHash(options.returnTo, "#setting-llm-model"))}
    <input type="hidden" name="key" value="llm.model" />
    <div class="field">
      <label class="label" for="model-value">Model</label>
      <input class="input" id="model-value" name="value" type="text"${listAttribute} placeholder="${escapeHtml(prefill.placeholder)}" value="${escapeHtml(prefill.value)}" required autocomplete="off" />
      ${datalist}
    </div>
    ${standardActions({
      scope: options.scope,
      ownState: own.state,
      effective: options.effective as EffectiveValue<unknown>,
      label: "Model",
      clearable: false,
    })}
  </form>`;
}

function scopePrefillPrefix(scope: SettingsScope): string {
  return scope === "global" ? "Default" : "Inherited";
}

function contextEnabledControls(options: {
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  effective: EffectiveValue<boolean>;
  returnTo: string;
}): string {
  const own = ownValue(options.resolved, options.scope, "context.auto_compact.enabled");
  const prefill =
    own.state === "set" && typeof own.value === "boolean" ? (own.value ? "true" : "false") : "";
  const placeholder =
    prefill.length > 0
      ? ""
      : `<option value="" selected disabled>${escapeHtml(scopePrefillPrefix(options.scope))}: ${options.effective.value === true ? "On" : "Off"}</option>`;
  return `<form class="setting-row__form" method="post" action="/api/settings" data-settings-form data-no-busy data-success-notice="Settings saved.">
    ${hiddenTarget(options.scope, options.target, withHash(options.returnTo, "#setting-context-auto-compact"))}
    <input type="hidden" name="key" value="context.auto_compact.enabled" />
    <div class="field">
      <label class="label" for="context-auto-compact-enabled">Auto-compaction</label>
      <div class="select-wrap">
        <select class="select" id="context-auto-compact-enabled" name="value" required>${placeholder}<option value="true"${prefill === "true" ? " selected" : ""}>On</option><option value="false"${prefill === "false" ? " selected" : ""}>Off</option></select>
        ${icon("chevron-down")}
      </div>
    </div>
    ${standardActions({
      scope: options.scope,
      ownState: own.state,
      effective: options.effective as EffectiveValue<unknown>,
      label: "Auto-compaction",
      clearable: false,
    })}
  </form>`;
}

function contextPercentControls(options: {
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings;
  effective: EffectiveValue<number>;
  returnTo: string;
}): string {
  const own = ownValue(options.resolved, options.scope, "context.auto_compact.percent");
  const value = own.state === "set" && typeof own.value === "number" ? String(own.value) : "";
  const effectivePercent = options.effective.value ?? 80;
  const placeholder =
    value.length > 0 ? "" : `${scopePrefillPrefix(options.scope)}: ${effectivePercent}%`;
  return `<form class="setting-row__form" method="post" action="/api/settings" data-settings-form data-no-busy data-success-notice="Settings saved.">
    ${hiddenTarget(options.scope, options.target, withHash(options.returnTo, "#setting-context-auto-compact-percent"))}
    <input type="hidden" name="key" value="context.auto_compact.percent" />
    <div class="field">
      <label class="label" for="context-auto-compact-percent">Threshold</label>
      <input class="input" id="context-auto-compact-percent" name="value" type="number" min="1" max="99" step="1" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" required />
    </div>
    ${standardActions({
      scope: options.scope,
      ownState: own.state,
      effective: options.effective as EffectiveValue<unknown>,
      label: "Auto-compaction threshold",
      clearable: false,
    })}
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

function providerPill(status: ResolvedSettings["providerKeys"][string]): string {
  switch (status.state) {
    case "set":
      return `<span class="status" data-state="delivered">${icon("check")}Set</span>`;
    case "cleared":
      return `<span class="status" data-state="cancelled">${icon("slash")}Cleared</span>`;
    case "host":
      return `<span class="status" data-state="in_progress">${icon("lock")}Host auth</span>`;
    case "error":
      return `<span class="status" data-state="failed">${icon("alert-triangle")}Error</span>`;
    default:
      return `<span class="status" data-state="cancelled">${icon("slash")}Missing</span>`;
  }
}

function providerSourceLine(status: ResolvedSettings["providerKeys"][string]): string {
  if (status.state === "set") {
    return `from ${scopeLabel(status.source)}`;
  }
  if (status.state === "cleared") {
    return `Cleared at ${scopeLabel(status.source)}`;
  }
  if (status.state === "host") {
    return "from host auth";
  }
  if (status.state === "error") {
    return "error";
  }
  return "default";
}

function providerInheritAction(
  status: ResolvedSettings["providerKeys"][string],
  scope: SettingsScope,
): { button: string; reason: string } {
  if (scope === "global") {
    return { button: "", reason: "" };
  }
  const attributes =
    'class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit" formnovalidate data-settings-inherit';
  if ((status.state === "set" || status.state === "cleared") && status.source === scope) {
    return { button: `<button ${attributes}>Inherit</button>`, reason: "" };
  }
  const inheritedFrom =
    status.state === "set" || status.state === "cleared"
      ? scopeLabel(status.source)
      : status.state === "host"
        ? "host auth"
        : "default";
  return {
    button: `<button ${attributes} disabled>Inherit</button>`,
    reason: `<p class="hint setting-row__reason">Already inherited from ${escapeHtml(inheritedFrom)}.</p>`,
  };
}

function providerClearAction(
  status: ResolvedSettings["providerKeys"][string],
  scope: SettingsScope,
  provider: string,
): { button: string; reason: string } {
  const attributes = `class="btn btn-danger btn-sm" type="submit" name="action" value="clear" formnovalidate data-confirm-clear data-setting-label="${escapeHtml(`${provider} key`)}"`;
  if (status.state === "cleared" && status.source === scope) {
    return {
      button: `<button ${attributes} disabled>Clear</button>`,
      reason: '<p class="hint setting-row__reason">Already cleared at this scope.</p>',
    };
  }
  return { button: `<button ${attributes}>Clear</button>`, reason: "" };
}

function formatModelsText(models: readonly ModelProviderModel[]): string {
  return models
    .map((model) =>
      [
        model.id,
        String(model.limit.context),
        String(model.limit.output),
        ...(model.name === undefined ? [] : [model.name]),
      ].join(" | "),
    )
    .join("\n");
}

function customProvidersBlock(options: {
  scope: SettingsScope;
  resolved: ResolvedSettings;
  providers: readonly ModelProvider[];
  providerKeyIds: ReadonlySet<string>;
}): string {
  if (options.scope !== "global") {
    return `<p class="hint">Custom model providers are global. <a href="/settings#custom-providers">Manage in Global settings</a>.</p>`;
  }
  const rows =
    options.providers.length === 0
      ? '<p class="hint">No custom providers yet.</p>'
      : options.providers
          .map((provider, index) => {
            const keyStatus =
              options.resolved.providerKeys[provider.id] ?? ({ state: "missing" } as const);
            const warnings = [
              ...collisionWarnings(provider.id, options.providerKeyIds),
              ...providerBaseUrlWarnings(provider.baseUrl),
            ];
            const nameId = `custom-provider-name-${index}`;
            const urlId = `custom-provider-url-${index}`;
            const modelsId = `custom-provider-models-${index}`;
            const body = `<p class="hint">Key: <a href="#${providerRowId(provider.id)}">${providerStatusLabel(keyStatus)}</a> · ${plural(provider.models.length, "model")}</p>
              <form class="setting-row__form" method="post" action="/api/settings/model-providers" data-settings-form data-no-busy data-success-notice="Provider saved.">
                <input type="hidden" name="action" value="update" />
                <input type="hidden" name="id" value="${escapeHtml(provider.id)}" />
                <input type="hidden" name="return_to" value="/settings#custom-providers" />
                ${fieldErrorSlot(`custom-provider-error-${index}`)}
                <div class="field">
                  <label class="label" for="${nameId}">Name</label>
                  <input class="input" id="${nameId}" name="name" type="text" value="${escapeHtml(provider.name)}" autocomplete="off" />
                </div>
                <div class="field">
                  <label class="label" for="${urlId}">Base URL</label>
                  <input class="input" id="${urlId}" name="baseUrl" type="text" value="${escapeHtml(provider.baseUrl)}" required autocomplete="off" />
                </div>
                <div class="field">
                  <label class="label" for="${modelsId}">Models</label>
                  <textarea class="input" id="${modelsId}" name="models" rows="4" required>${escapeHtml(formatModelsText(provider.models))}</textarea>
                  <p class="hint">One per line: id | context | output | optional name.</p>
                </div>
                <div class="setting-row__actions">
                  <button class="btn btn-primary btn-sm" type="submit">Save</button>
                  <button class="btn btn-danger btn-sm" type="submit" name="delete" value="1" data-confirm="Delete provider ${escapeHtml(provider.id)}?">Delete</button>
                </div>
              </form>`;
            return settingRow({
              id: `custom-provider-${encodeURIComponent(provider.id)}`,
              title: `${provider.name} (${provider.id})`,
              summaryNote: "Edit",
              effectiveText: provider.baseUrl,
              source: "Global",
              state: providerPill(keyStatus),
              warnings,
              body,
            });
          })
          .join("");
  const add = `<details class="disclosure provider-add">
    <summary>Add custom provider${icon("chevron-down", "disclosure__chevron")}</summary>
    <form class="setting-row__form provider-add__form" method="post" action="/api/settings/model-providers" data-settings-form data-no-busy data-success-notice="Provider saved.">
      <input type="hidden" name="action" value="create" />
      <input type="hidden" name="return_to" value="/settings#custom-providers" />
      ${fieldErrorSlot("custom-provider-add-error")}
      <div class="field">
        <label class="label" for="custom-provider-new-id">Provider id</label>
        <input class="input" id="custom-provider-new-id" name="id" type="text" placeholder="llm-lan" required autocomplete="off" />
      </div>
      <div class="field">
        <label class="label" for="custom-provider-new-name">Name</label>
        <input class="input" id="custom-provider-new-name" name="name" type="text" placeholder="LLM LAN" autocomplete="off" />
      </div>
      <div class="field">
        <label class="label" for="custom-provider-new-url">Base URL</label>
        <input class="input" id="custom-provider-new-url" name="baseUrl" type="text" placeholder="http://gateway.example:4000/v1" required autocomplete="off" />
        <p class="hint">Resolved inside the app container: use the host LAN address, not 127.0.0.1 or localhost.</p>
      </div>
      <div class="field">
        <label class="label" for="custom-provider-new-models">Models</label>
        <textarea class="input" id="custom-provider-new-models" name="models" rows="4" placeholder="deepseek | 1000000 | 64000" required></textarea>
        <p class="hint">One per line: id | context | output | optional name.</p>
      </div>
      <div class="setting-row__actions">
        <button class="btn btn-primary btn-sm" type="submit">Save</button>
      </div>
    </form>
  </details>`;
  return `<div class="providers" id="custom-providers" aria-labelledby="custom-providers-title">
    <div class="providers__head">
      <h3 class="card__title" id="custom-providers-title">Custom model providers</h3>
      <span class="badge">${plural(options.providers.length, "provider")}</span>
    </div>
    <p class="hint providers__hint">Global OpenAI-compatible endpoints. The API key stays in the Providers block.</p>
    ${rows}${add}
  </div>`;
}

function providerRowId(provider: string): string {
  return `provider-${encodeURIComponent(provider)}`;
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
            const inherit = providerInheritAction(status, options.scope);
            const clear = providerClearAction(status, options.scope, provider);
            const errorId = `provider-error-${index}`;
            const form = `<form class="setting-row__form" method="post" action="/api/settings/provider" data-settings-form data-no-busy data-success-notice="Provider key updated.">
              ${hiddenTarget(options.scope, options.target, withHash(options.returnTo, "#providers"))}
              <input type="hidden" name="provider" value="${escapeHtml(provider)}" />
              <div class="field">
                <label class="label" for="provider-key-${index}">API key</label>
                <input class="input" id="provider-key-${index}" name="key" type="password" autocomplete="new-password" placeholder="Not shown" required />
              </div>
              <div class="setting-row__actions">
                <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
                ${inherit.button}
                ${clear.button}
              </div>
              ${inherit.reason}
              ${clear.reason}
            </form>`;
            return settingRow({
              id: providerRowId(provider),
              title: provider,
              summaryNote: "Change key",
              effectiveText: providerStatusLabel(status),
              source: providerSourceLine(status),
              state: providerPill(status),
              body: `${fieldErrorSlot(errorId)}${form}`,
            });
          })
          .join("");
  return `<div class="providers" id="providers" aria-labelledby="providers-title">
    <div class="providers__head">
      <h3 class="card__title" id="providers-title">Providers</h3>
      <span class="badge">${plural(providers.length, "provider")}</span>
    </div>
    <p class="hint providers__hint">Keys are encrypted at rest and never shown again. A cleared key suppresses wider scopes and host auth.</p>
    ${rows}
    <details class="disclosure provider-add">
      <summary>Add provider key${icon("chevron-down", "disclosure__chevron")}</summary>
      <form class="setting-row__form provider-add__form" method="post" action="/api/settings/provider" data-settings-form data-no-busy data-success-notice="Provider key updated.">
        ${hiddenTarget(options.scope, options.target, withHash(options.returnTo, "#providers"))}
        ${fieldErrorSlot("provider-add-error")}
        <div class="field">
          <label class="label" for="provider-new">Provider</label>
          <input class="input" id="provider-new" name="provider" type="text" placeholder="deepseek" required autocomplete="off" />
        </div>
        <div class="field">
          <label class="label" for="provider-new-key">API key</label>
          <input class="input" id="provider-new-key" name="key" type="password" autocomplete="new-password" required />
        </div>
        <div class="setting-row__actions">
          <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
        </div>
      </form>
    </details>
  </div>`;
}

function humanReason(reason: string): string {
  if (reason === "settings_changed") {
    return "Settings changed";
  }
  if (reason === "profile_not_applied") {
    return "Agent profile not applied";
  }
  if (reason === "applied_state_unknown") {
    return "Applied state unknown";
  }
  return reason;
}

function pendingSection(options: {
  pending: PendingRestart[];
  returnTo: string;
  profileWarnings: string[];
}): string {
  const rows =
    options.pending.length === 0
      ? '<p class="hint">No running agents are waiting for a restart.</p>'
      : `<div class="stack--tight">${options.pending
          .map((entry) => {
            const href = `/projects/${encodeURIComponent(entry.projectId)}/apps/${encodeURIComponent(entry.appKey)}`;
            return `<div class="cluster" id="pending-${escapeHtml(entry.appId)}">
              <span class="status" data-state="awaiting_approval">${icon("stamp")}Restart required</span>
              <a class="small" href="${escapeHtml(href)}">${escapeHtml(entry.appKey)}</a>
              <span class="small">${escapeHtml(entry.reasons.map(humanReason).join(", "))}</span>
              <form method="post" action="/api/apps/${encodeURIComponent(entry.appKey)}/restart?project=${encodeURIComponent(entry.projectId)}">
                <input type="hidden" name="return_to" value="${escapeHtml(options.returnTo)}" />
                <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
              </form>
            </div>`;
          })
          .join("")}</div>`;
  return `<section class="card settings-section" id="settings-restart" aria-labelledby="restart-pending-title">
    <div class="card__head">
      <h2 class="card__title" id="restart-pending-title">Restart &amp; pending</h2>
      <span class="badge">${options.pending.length}</span>
    </div>
    <div class="card__body" id="restart-pending">
      <p class="hint">Settings changes apply only on an explicit restart. A restart interrupts an active turn; sessions are kept.</p>
      ${rows}
    </div>
    ${profileWarningsSection(options.profileWarnings)}
  </section>`;
}

function warningsSection(warnings: string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return `<section class="settings-warning" aria-labelledby="settings-warnings-title">
    <p class="settings-warning__title" id="settings-warnings-title">${icon("alert-triangle")}Warnings</p>
    <div class="stack--tight">${warningList(warnings)}</div>
  </section>`;
}

function profileWarningsSection(warnings: string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return `<div class="settings-warning settings-warning--profile" aria-labelledby="profile-warnings-title">
    <p class="settings-warning__title" id="profile-warnings-title">${icon("alert-triangle")}OMO profile warnings</p>
    <div class="stack--tight">${warningList(warnings)}</div>
  </div>`;
}

function gitAuthPill(status: GitAuthStatus): string {
  switch (status.state) {
    case "set":
      return `<span class="status" data-state="delivered">${icon("check")}Set</span>`;
    case "cleared":
      return `<span class="status" data-state="cancelled">${icon("slash")}Cleared</span>`;
    case "error":
      return `<span class="status" data-state="failed">${icon("alert-triangle")}Error</span>`;
    default:
      return `<span class="status" data-state="cancelled">${icon("slash")}Missing</span>`;
  }
}

function gitAuthSourceLine(status: GitAuthStatus): string {
  if (status.state === "set") {
    return `from ${scopeLabel(status.source)}`;
  }
  if (status.state === "cleared") {
    return `Cleared at ${scopeLabel(status.source)}`;
  }
  return "default";
}

function gitAuthMetadata(status: GitAuthStatus): string {
  if (status.state === "set" && status.kind === "ssh") {
    return status.publicKey;
  }
  if (status.state === "set" && status.kind === "https") {
    return status.hosts.join(", ");
  }
  if (status.state === "cleared") {
    return "Cleared";
  }
  if (status.state === "error") {
    return "Error";
  }
  return "Not set";
}

function gitAuthScopeDetails(
  scoped: Record<SettingsScope, GitAuthScopedState>,
  scope: SettingsScope,
): string {
  if (scope === "global") {
    return "";
  }
  const rows = applicableScopes(scope)
    .map((entry) => {
      const state = scoped[entry] ?? "absent";
      const label = state === "absent" ? "Inherited" : state === "cleared" ? "Cleared" : "Set";
      return `<div class="scope-list__row"><dt>${escapeHtml(scopeLabel(entry))}</dt><dd><span class="scope-list__state">${escapeHtml(label)}</span></dd></div>`;
    })
    .join("");
  return `<details class="disclosure scope-details">
    <summary>Scope details${icon("chevron-down", "disclosure__chevron")}</summary>
    <dl class="scope-list">${rows}</dl>
  </details>`;
}

function gitAuthDetails(status: GitAuthStatus): string {
  if (status.state === "set" && status.kind === "ssh") {
    return `<div class="stack--tight">
      <span class="overline">Public key</span>
      <span class="mono small" id="git-ssh-public-key">${escapeHtml(status.publicKey)}</span>
      <span class="overline">Fingerprint</span>
      <span class="mono small" id="git-ssh-fingerprint">${escapeHtml(status.fingerprint)}</span>
      <span class="overline">known_hosts</span>
      <span class="small">${status.hasKnownHosts ? "Set — strict host checking." : "Not set — accept-new (TOFU) on first connection."}</span>
    </div>`;
  }
  if (status.state === "set" && status.kind === "https") {
    return `<div class="stack--tight">
      <span class="overline">Allowed hosts</span>
      <span class="mono small" id="git-https-allowed-hosts">${escapeHtml(status.hosts.join(", "))}</span>
      <span class="overline">Username</span>
      <span class="mono small" id="git-https-username-value">${escapeHtml(status.username)}</span>
    </div>`;
  }
  if (status.state === "error") {
    return `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(status.message)}</p>`;
  }
  if (status.state === "cleared") {
    return '<p class="hint">A tombstone at this scope suppresses wider credentials; nothing is materialized for the app.</p>';
  }
  return '<p class="hint">No credential is set or inherited; git operations that need a remote credential fail closed.</p>';
}

function gitAuthForm(options: {
  kind: GitAuthKind;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
  allowTest: boolean;
  inheritReason?: string;
  clearReason?: string;
}): string {
  const prefix = `git-${options.kind}`;
  const fields =
    options.kind === "ssh"
      ? `<div class="field">
          <label class="label" for="${prefix}-private-key">SSH private key</label>
          <textarea class="textarea" id="${prefix}-private-key" name="privateKey" rows="6" autocomplete="off" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
        </div>
        <div class="field">
          <label class="label" for="${prefix}-known-hosts">known_hosts (optional)</label>
          <textarea class="textarea" id="${prefix}-known-hosts" name="knownHosts" rows="4" autocomplete="off" spellcheck="false" placeholder="github.com ssh-ed25519 AAAA..."></textarea>
        </div>`
      : `<div class="field">
          <label class="label" for="${prefix}-hosts">Allowed hosts</label>
          <textarea class="textarea" id="${prefix}-hosts" name="hosts" rows="3" autocomplete="off" spellcheck="false" placeholder="github.com&#10;gitlab.com"></textarea>
        </div>
        <div class="field">
          <label class="label" for="${prefix}-username">Username</label>
          <input class="input" id="${prefix}-username" name="username" type="text" autocomplete="off" placeholder="x-access-token" />
        </div>
        <div class="field">
          <label class="label" for="${prefix}-token">Token</label>
          <input class="input" id="${prefix}-token" name="token" type="password" autocomplete="new-password" placeholder="Not shown" />
        </div>`;
  const testFields = options.allowTest
    ? `<div class="field">
          <label class="label" for="${prefix}-test-remote">Remote (optional)</label>
          <input class="input" id="${prefix}-test-remote" name="testRemote" type="text" autocomplete="off" spellcheck="false" placeholder="Defaults to origin" />
        </div>`
    : "";
  const testButton = options.allowTest
    ? '<button class="btn btn-secondary btn-sm" type="submit" data-git-test>Test connection</button>'
    : "";
  const inheritButton =
    options.scope === "global"
      ? ""
      : `<button class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit" formnovalidate data-settings-inherit${options.inheritReason === undefined ? "" : " disabled"}>Inherit</button>`;
  const clearButton = `<button class="btn btn-danger btn-sm" type="submit" name="action" value="clear" formnovalidate${options.clearReason === undefined ? "" : " disabled"}>Clear</button>`;
  return `<form class="stack--tight" data-git-auth data-no-busy method="post" action="/api/settings/git">
    ${hiddenTarget(options.scope, options.target, options.returnTo)}
    <input type="hidden" name="kind" value="${escapeHtml(options.kind)}" />
    ${fields}
    ${testFields}
    <div class="setting-row__actions">
      <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
      ${inheritButton}
      ${clearButton}
      ${testButton}
    </div>
    ${options.inheritReason === undefined ? "" : `<p class="hint setting-row__reason">${escapeHtml(options.inheritReason)}</p>`}
    ${options.clearReason === undefined ? "" : `<p class="hint setting-row__reason">${escapeHtml(options.clearReason)}</p>`}
    ${
      options.allowTest
        ? `<div class="stack--tight" data-git-test-result hidden>
      <p class="small" data-git-test-summary role="status" aria-live="polite"></p>
      <ul class="small" data-git-test-warnings hidden></ul>
      <p class="field-error" role="alert" data-git-test-error hidden></p>
    </div>`
        : ""
    }
    <p class="field-error" role="alert" data-git-error hidden></p>
  </form>`;
}

function gitCredentialRow(options: {
  kind: GitAuthKind;
  title: string;
  status: GitAuthStatus;
  scoped: Record<SettingsScope, GitAuthScopedState>;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
  allowTest: boolean;
}): string {
  const scopedState = options.scoped[options.scope] ?? "absent";
  const inheritReason =
    options.scope === "global" || scopedState !== "absent"
      ? undefined
      : options.status.state === "set" || options.status.state === "cleared"
        ? `Already inherited from ${scopeLabel(options.status.source)}.`
        : "No credential is set at this scope.";
  const clearReason = scopedState === "cleared" ? "Already cleared at this scope." : undefined;
  return settingRow({
    id: `setting-git-${options.kind}`,
    title: options.title,
    effectiveText: gitAuthMetadata(options.status),
    source: gitAuthSourceLine(options.status),
    state: gitAuthPill(options.status),
    body: `<div class="stack--tight" id="git-${options.kind}">
      ${gitAuthDetails(options.status)}
      ${gitAuthForm({
        kind: options.kind,
        scope: options.scope,
        target: options.target,
        returnTo: withHash(options.returnTo, `#setting-git-${options.kind}`),
        allowTest: options.allowTest,
        ...(inheritReason === undefined ? {} : { inheritReason }),
        ...(clearReason === undefined ? {} : { clearReason }),
      })}
    </div>`,
    details: gitAuthScopeDetails(options.scoped, options.scope),
  });
}

function gitIdentityRow(options: {
  key: "git.user.name" | "git.user.email";
  title: string;
  id: "git-identity-name" | "git-identity-email";
  inputId: string;
  effective: EffectiveValue<string>;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
  resolved: ResolvedSettings;
}): string {
  const own = ownValue(options.resolved, options.scope, options.key);
  const prefill = stringPrefill(options.scope, own, options.effective);
  const rowId =
    options.key === "git.user.name" ? "setting-git-user-name" : "setting-git-user-email";
  const errorId = `${rowId}-error`;
  const form = `<div id="${options.id}">
    <form class="setting-row__form" method="post" action="/api/settings" data-settings-form data-no-busy data-success-notice="Settings saved.">
      ${hiddenTarget(options.scope, options.target, withHash(options.returnTo, `#${rowId}`))}
      <input type="hidden" name="key" value="${escapeHtml(options.key)}" />
      <div class="field">
        <label class="label" for="${escapeHtml(options.inputId)}">${escapeHtml(options.title)}</label>
        <input class="input" id="${escapeHtml(options.inputId)}" name="value" type="text" autocomplete="off" placeholder="${escapeHtml(prefill.placeholder)}" value="${escapeHtml(prefill.value)}" />
      </div>
      ${standardActions({
        scope: options.scope,
        ownState: own.state,
        effective: options.effective as EffectiveValue<unknown>,
        label: options.title,
        clearable: false,
      })}
    </form>
  </div>`;
  return settingRow({
    id: rowId,
    title: options.title,
    effectiveText: effectiveText(options.effective as EffectiveValue<unknown>),
    source: sourceLine(options.effective as EffectiveValue<unknown>),
    body: `${fieldErrorSlot(errorId)}${form}`,
    details: scopeDetailsHtml(options.resolved, options.scope, options.key),
  });
}

function gitSection(options: {
  resolved: ResolvedSettings;
  scope: SettingsScope;
  target: SettingsTarget;
  returnTo: string;
  testAppPath?: string;
}): string {
  const gitAuth: ResolvedSettings["gitAuth"] = options.resolved.gitAuth;
  const scoped: GitAuthScoped = options.resolved.gitAuthScoped;
  const credentials = [
    gitCredentialRow({
      kind: "ssh",
      title: "SSH credential",
      status: gitAuth.ssh,
      scoped: scoped.ssh,
      scope: options.scope,
      target: options.target,
      returnTo: options.returnTo,
      allowTest: options.scope === "app",
    }),
    gitCredentialRow({
      kind: "https",
      title: "HTTPS credential",
      status: gitAuth.https,
      scoped: scoped.https,
      scope: options.scope,
      target: options.target,
      returnTo: options.returnTo,
      allowTest: options.scope === "app",
    }),
  ].join("");
  const testNote =
    options.scope === "app"
      ? '<p class="hint">Test connection checks the draft values against the remote without saving them. The agent must be running.</p>'
      : `<div class="stack--tight">
        <span class="overline">Credential check</span>
        <p class="hint">Run the remote check from an application settings page.</p>
        ${
          options.testAppPath === undefined
            ? ""
            : `<a class="btn btn-ghost btn-sm" href="${escapeHtml(options.testAppPath)}">Application settings</a>`
        }
      </div>`;
  return `<section class="card settings-section" id="settings-git" aria-labelledby="git-title">
    <div class="card__head">
      <h2 class="card__title" id="git-title">Git</h2>
      <span class="badge">Identity and credentials</span>
    </div>
    <div class="card__body card__body--flush" id="git">
      <noscript><p class="hint settings-noscript">Git credential changes require JavaScript.</p></noscript>
      ${gitIdentityRow({
        key: "git.user.name",
        title: "User name",
        id: "git-identity-name",
        inputId: "git-user-name",
        effective: options.resolved.effective.git.user.name,
        scope: options.scope,
        target: options.target,
        returnTo: options.returnTo,
        resolved: options.resolved,
      })}
      ${gitIdentityRow({
        key: "git.user.email",
        title: "User email",
        id: "git-identity-email",
        inputId: "git-user-email",
        effective: options.resolved.effective.git.user.email,
        scope: options.scope,
        target: options.target,
        returnTo: options.returnTo,
        resolved: options.resolved,
      })}
      ${credentials}
      <div class="stack--tight git-notes">
        ${testNote}
        <span class="overline">Security notes</span>
        <p class="hint">Passphrase-protected SSH keys are not supported in v1; use an unencrypted deploy key. Without known_hosts, SSH uses accept-new (TOFU) on first connection. HTTPS hosts are mandatory and matched exactly; remote URLs with a different host fail closed. Use scoped deploy keys or fine-grained tokens with the least privilege — the agent can read its own materialized credentials.</p>
      </div>
    </div>
  </section>`;
}

function settingsNav(options: { scope: SettingsScope; target: SettingsTarget }): string {
  const globalLink = `<a class="settings-nav__link" href="/settings">Global</a>`;
  const projectHref =
    options.target.projectId === undefined
      ? undefined
      : `/projects/${encodeURIComponent(options.target.projectId)}/settings`;
  const appHref =
    options.target.projectId === undefined || options.target.appKey === undefined
      ? undefined
      : `/projects/${encodeURIComponent(options.target.projectId)}/apps/${encodeURIComponent(options.target.appKey)}/settings`;
  const current = (label: string, short?: string): string =>
    short === undefined
      ? `<span class="settings-nav__link" aria-current="page">${icon("check")}${escapeHtml(label)}</span>`
      : `<span class="settings-nav__link" aria-current="page">${icon("check")}<span class="settings-nav__scope-full">${escapeHtml(label)}</span><span class="settings-nav__scope-short">${escapeHtml(short)}</span></span>`;
  const scopes =
    options.scope === "global"
      ? ""
      : `<div class="settings-nav__scopes" role="group" aria-label="Settings scope">
        ${globalLink}
        ${
          options.scope === "project"
            ? current("Project")
            : `<a class="settings-nav__link" href="${escapeHtml(projectHref ?? "/settings")}">Project</a>`
        }
        ${
          options.scope === "app"
            ? current("Application", "App")
            : appHref === undefined
              ? ""
              : `<a class="settings-nav__link" href="${escapeHtml(appHref)}">Application</a>`
        }
      </div>`;
  return `<nav class="settings-nav" aria-label="Settings">
    ${scopes}
    <div class="settings-nav__sections" aria-label="Settings sections">
      <a class="settings-nav__link" href="#settings-agent">Agent</a>
      <a class="settings-nav__link" href="#settings-web">Web tools</a>
      <a class="settings-nav__link" href="#settings-context">Context</a>
      <a class="settings-nav__link" href="#settings-git">Git</a>
      <a class="settings-nav__link" href="#settings-restart">Restart</a>
    </div>
  </nav>`;
}

function clearDialog(): string {
  return `<dialog class="dialog" id="settings-clear-dialog" aria-labelledby="settings-clear-title">
    <div class="dialog__frame">
      <form class="dialog__form" method="post" action="/api/settings" id="settings-clear-form" data-no-busy>
        <input type="hidden" name="action" value="clear" />
        <div class="dialog__head">
          <h2 class="dialog__title" id="settings-clear-title">Clear setting at this scope?</h2>
          <p class="dialog__meta" id="settings-clear-meta"></p>
        </div>
        <div class="dialog__body">
          <p id="settings-clear-body">Wider scopes will no longer apply. The setting stays disabled until you set it again.</p>
          <p class="field-error" data-settings-error role="alert" hidden></p>
        </div>
        <div class="dialog__foot">
          <button class="btn btn-ghost" type="button" data-dialog-close>Cancel</button>
          <button class="btn btn-danger" type="submit">Clear setting</button>
        </div>
      </form>
    </div>
  </dialog>`;
}

function settingsSections(options: {
  site: SiteModel;
  scope: SettingsScope;
  target: SettingsTarget;
  resolved: ResolvedSettings & { pendingRestart: PendingRestart[] };
  deps: HttpDeps;
  returnTo: string;
  project?: ProjectView;
  app?: RegisteredApp;
}): SettingsSections {
  const effectiveModel = options.resolved.effective.llm.model;
  const modelWarning = modelProviderWarning(options.resolved);
  const customProviders = options.deps.modelProviders?.list() ?? [];
  const providerKeyIds = new Set(options.deps.settings?.allProviderIds() ?? []);
  const searchEffective = options.resolved.effective.web.search;
  const fetchEffective = options.resolved.effective.web.fetch;

  const agentRows = `${settingRow({
    id: "setting-llm-model",
    title: "Model",
    effectiveText: effectiveText(effectiveModel as EffectiveValue<unknown>),
    source: sourceLine(effectiveModel as EffectiveValue<unknown>),
    hint: "Selected model applies to new sessions and OMO agents; existing sessions may keep their model.",
    ...(modelWarning === undefined ? {} : { warnings: [modelWarning] }),
    body: `${fieldErrorSlot("setting-llm-model-error")}${modelControls({
      scope: options.scope,
      target: options.target,
      resolved: options.resolved,
      effective: effectiveModel,
      providers: customProviders,
      returnTo: options.returnTo,
    })}`,
    details: scopeDetailsHtml(options.resolved, options.scope, "llm.model"),
  })}${providerSection({
    resolved: options.resolved,
    scope: options.scope,
    target: options.target,
    returnTo: options.returnTo,
  })}${customProvidersBlock({
    scope: options.scope,
    resolved: options.resolved,
    providers: customProviders,
    providerKeyIds,
  })}`;

  const webRows = `${settingRow({
    id: "setting-web-search",
    title: "Web search",
    effectiveText:
      searchEffective.value === null
        ? effectiveText(searchEffective as EffectiveValue<unknown>)
        : searchEffective.value.driver,
    source: sourceLine(searchEffective as EffectiveValue<unknown>),
    hint: "Built-in uses the existing OMO/opencode tools. DeepSeek uses the managed hanse_web MCP server.",
    ...(webToolWarning("web.search", searchEffective, options.resolved) === undefined
      ? {}
      : { warnings: [webToolWarning("web.search", searchEffective, options.resolved) as string] }),
    body: `${fieldErrorSlot("setting-web-search-error")}${webControls({
      key: "web.search",
      title: "Web search",
      scope: options.scope,
      target: options.target,
      returnTo: options.returnTo,
      resolved: options.resolved,
      effective: searchEffective,
      current: ownWebValue(options.resolved, options.scope, "web.search"),
    })}`,
    details: scopeDetailsHtml(options.resolved, options.scope, "web.search"),
  })}${settingRow({
    id: "setting-web-fetch",
    title: "Web fetch",
    effectiveText:
      fetchEffective.value === null
        ? effectiveText(fetchEffective as EffectiveValue<unknown>)
        : fetchEffective.value.driver,
    source: sourceLine(fetchEffective as EffectiveValue<unknown>),
    hint: "Built-in uses opencode webfetch. DeepSeek uses the managed hanse_web MCP server.",
    ...(webToolWarning("web.fetch", fetchEffective, options.resolved) === undefined
      ? {}
      : { warnings: [webToolWarning("web.fetch", fetchEffective, options.resolved) as string] }),
    body: `${fieldErrorSlot("setting-web-fetch-error")}${webControls({
      key: "web.fetch",
      title: "Web fetch",
      scope: options.scope,
      target: options.target,
      returnTo: options.returnTo,
      resolved: options.resolved,
      effective: fetchEffective,
      current: ownWebValue(options.resolved, options.scope, "web.fetch"),
    })}`,
    details: scopeDetailsHtml(options.resolved, options.scope, "web.fetch"),
  })}`;

  const enabledEffective = options.resolved.effective.context.autoCompact.enabled;
  const percentEffective = options.resolved.effective.context.autoCompact.percent;
  const contextRows = `${settingRow({
    id: "setting-context-auto-compact",
    title: "Auto-compaction",
    effectiveText: enabledEffective.value === true ? "On" : "Off",
    source: sourceLine(enabledEffective as EffectiveValue<unknown>),
    hint: "Automatically compacts top-level sessions when context usage crosses the threshold. Live; no restart is required.",
    body: `${fieldErrorSlot("setting-context-auto-compact-error")}${contextEnabledControls({
      scope: options.scope,
      target: options.target,
      resolved: options.resolved,
      effective: enabledEffective,
      returnTo: options.returnTo,
    })}`,
    details: scopeDetailsHtml(options.resolved, options.scope, "context.auto_compact.enabled"),
  })}${settingRow({
    id: "setting-context-auto-compact-percent",
    title: "Auto-compaction threshold",
    effectiveText:
      percentEffective.value === null
        ? effectiveText(percentEffective as EffectiveValue<unknown>)
        : `${percentEffective.value}%`,
    source: sourceLine(percentEffective as EffectiveValue<unknown>),
    hint: "Percentage of the model context window used when auto-compaction is on. opencode's own overflow compaction remains a fallback.",
    body: `${fieldErrorSlot("setting-context-auto-compact-percent-error")}${contextPercentControls({
      scope: options.scope,
      target: options.target,
      resolved: options.resolved,
      effective: percentEffective,
      returnTo: options.returnTo,
    })}`,
    details: scopeDetailsHtml(options.resolved, options.scope, "context.auto_compact.percent"),
  })}`;

  const profileWarnings =
    options.scope === "app" && options.app !== undefined
      ? (options.deps.manager?.profileWarnings(options.app.id) ?? [])
      : [];

  return {
    agent: `<section class="card settings-section" id="settings-agent" aria-labelledby="settings-agent-title">
        <div class="card__head">
          <h2 class="card__title" id="settings-agent-title">Agent</h2>
          <span class="badge">Model and providers</span>
        </div>
        <div class="card__body card__body--flush">${agentRows}</div>
      </section>`,
    web: `<section class="card settings-section" id="settings-web" aria-labelledby="settings-web-title">
        <div class="card__head">
          <h2 class="card__title" id="settings-web-title">Web tools</h2>
          <span class="badge">Search and fetch</span>
        </div>
        <div class="card__body card__body--flush">${webRows}</div>
      </section>`,
    context: `<section class="card settings-section" id="settings-context" aria-labelledby="settings-context-title">
        <div class="card__head">
          <h2 class="card__title" id="settings-context-title">Context</h2>
          <span class="badge">Auto-compaction</span>
        </div>
        <div class="card__body card__body--flush">${contextRows}</div>
      </section>`,
    git: gitSection({
      resolved: options.resolved,
      scope: options.scope,
      target: options.target,
      returnTo: options.returnTo,
      ...(options.scope === "app"
        ? {}
        : { testAppPath: firstAppSettingsPath(options.site, options.project?.id) }),
    }),
    restart: pendingSection({
      pending: options.resolved.pendingRestart,
      returnTo: options.returnTo,
      profileWarnings,
    }),
    warnings: warningsSection(options.resolved.warnings),
  };
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
  const entities = pageEntities(options.site, options.scope, options.target);
  if (entities === undefined) {
    return undefined;
  }
  const project = entities.project;
  const app = entities.app;

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

  const sections = settingsSections({
    site: options.site,
    scope: options.scope,
    target: options.target,
    resolved: options.resolved,
    deps: options.deps,
    returnTo: options.path,
    ...(project === undefined ? {} : { project }),
    ...(app === undefined ? {} : { app }),
  });

  const body = `${settingsNav({ scope: options.scope, target: options.target })}
    <div id="settings-warnings">${sections.warnings}</div>
    <div class="settings-sections">
      ${sections.agent}
      ${sections.web}
      ${sections.context}
      ${sections.git}
      ${sections.restart}
    </div>
    ${clearDialog()}`;

  const header = pageHeader({
    overline: "Settings",
    title,
    description,
  });

  return appShell({
    title,
    active: "settings",
    activeProjectId: project?.id,
    settingsHref: options.path,
    skillsHref:
      options.scope === "global"
        ? "/skills"
        : options.scope === "project"
          ? `/projects/${encodeURIComponent(options.target.projectId ?? "")}/skills`
          : `/projects/${encodeURIComponent(options.target.projectId ?? "")}/apps/${encodeURIComponent(options.target.appKey ?? "")}/skills`,
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
    scripts: ["/assets/settings.js", "/assets/git-settings.js"],
    body,
  });
}
