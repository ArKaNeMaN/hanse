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
import {
  type PendingRestart,
  type ResolvedSettings,
  type SettingsService,
  SettingsValidationError,
} from "../settings/index.js";
import type { SettingsScope, SettingsTarget } from "../settings/types.js";
import { findApp, toManagedApp } from "./apps.js";
import { humanFrom, principalFrom } from "./auth.js";
import { crossSiteMutation } from "./chat.js";
import { buildSite, type PageChrome, renderNotFound, type SiteModel } from "./dashboard.js";
import { lifecycleErrorResponse } from "./errors.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import {
  buildSettingsProps,
  parseSettingsTarget,
  type SettingsGitCredentialProps,
  type SettingsProps,
  type SettingsProviderRowProps,
  type SettingsRowActionsProps,
  type SettingsRowProps,
  type SettingsScopeDetailProps,
  settingsPagePath,
} from "./props/settings.js";
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

const MODEL_FIELD_RE =
  /^model-(\d+)-(id|name|context|input|output|attachment|reasoning|toolCall|temperature|costInput|costOutput)$/;

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return Number(value);
}

function modelsFromPayload(payload: Record<string, unknown>): unknown {
  if (payload.models !== undefined) {
    return typeof payload.models === "string" ? parseModelLines(payload.models) : payload.models;
  }
  const rows = new Map<number, Record<string, string>>();
  for (const [key, value] of Object.entries(payload)) {
    const match = MODEL_FIELD_RE.exec(key);
    if (match === null || typeof value !== "string") {
      continue;
    }
    const index = Number(match[1]);
    const field = match[2];
    if (field === undefined) {
      continue;
    }
    const row = rows.get(index) ?? {};
    row[field] = value;
    rows.set(index, row);
  }
  if (rows.size === 0) {
    return undefined;
  }
  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => {
      const input = numberOrUndefined(row.input);
      const costInput = numberOrUndefined(row.costInput);
      const costOutput = numberOrUndefined(row.costOutput);
      const hasCost = costInput !== undefined || costOutput !== undefined;
      return {
        id: row.id ?? "",
        ...(row.name === undefined || row.name.trim().length === 0 ? {} : { name: row.name }),
        limit: {
          context: numberOrUndefined(row.context),
          ...(input === undefined ? {} : { input }),
          output: numberOrUndefined(row.output),
        },
        attachment: row.attachment === "1",
        reasoning: row.reasoning === "1",
        toolCall: row.toolCall === "1",
        temperature: row.temperature === "1",
        ...(hasCost
          ? {
              cost: {
                input: costInput ?? 0,
                output: costOutput ?? 0,
              },
            }
          : {}),
      };
    });
}

function parseTarget(source: Record<string, unknown>): {
  scope: SettingsScope;
  target: SettingsTarget;
} {
  return parseSettingsTarget(source);
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
  scope: SettingsScope,
  target: SettingsTarget,
  changed: SettingsSectionKey[],
): HttpResponse {
  const site = buildSite(deps);
  const props = buildSettingsProps({ deps, site, scope, target });
  if (props === undefined) {
    return json(404, { error: "not found" });
  }
  const sections = settingsSections(props);
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
      return fragmentResponse(deps, scope, target, mutationSections(key));
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
        return fragmentResponse(deps, scope, target, ["git", "restart"]);
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
          const models = modelsFromPayload(payload);
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
        return fragmentResponse(deps, "global", {}, ["agent", "restart", "warnings"]);
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
      return fragmentResponse(deps, scope, target, [
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
  const chrome = pageChrome(actor, request);
  let props: SettingsProps | undefined;
  try {
    props = buildSettingsProps({
      deps,
      site,
      scope: page.scope,
      target: page.target,
      notice: chrome.notice ?? null,
    });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return redirectNotice("/settings", error.message, "error");
    }
    throw error;
  }
  if (props === undefined) {
    return html(404, renderNotFound(site, chrome));
  }
  return html(200, renderSettingsPage({ props, site, chrome, path: request.path }));
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

function fieldErrorSlot(id: string): string {
  return `<p class="field-error" id="${escapeHtml(id)}" data-settings-error role="alert" hidden></p>`;
}

function warningList(warnings: readonly string[]): string {
  return warnings
    .map(
      (warning) =>
        `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(warning)}</p>`,
    )
    .join("");
}

function hiddenTarget(
  form: SettingsProps["rows"]["model"]["form"],
  returnTo: string = form.hidden.returnTo,
): string {
  const fields = [
    `<input type="hidden" name="scope" value="${escapeHtml(form.hidden.scope)}" />`,
    `<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}" />`,
  ];
  if (form.hidden.scope !== "global") {
    fields.push(
      `<input type="hidden" name="projectId" value="${escapeHtml(form.hidden.projectId ?? "")}" />`,
    );
  }
  if (form.hidden.scope === "app") {
    fields.push(
      `<input type="hidden" name="appKey" value="${escapeHtml(form.hidden.appKey ?? "")}" />`,
    );
  }
  return fields.join("");
}

function actionButtons(actions: SettingsRowActionsProps): string {
  const inherit = actions.inherit;
  const clear = actions.clear;
  return `<div class="setting-row__actions">
      <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
      ${inherit === null ? "" : `<button class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit" formnovalidate data-settings-inherit${inherit.enabled ? "" : " disabled"}>Inherit</button>`}
      ${clear === null ? "" : `<button class="btn btn-danger btn-sm" type="submit" name="action" value="clear" formnovalidate data-confirm-clear data-setting-label="${escapeHtml(clear.confirmLabel ?? "")}"${clear.enabled ? "" : " disabled"}>Clear</button>`}
    </div>
    ${inherit === null || inherit.reason === null ? "" : `<p class="hint setting-row__reason">${escapeHtml(inherit.reason)}</p>`}
    ${clear === null || clear.reason === null ? "" : `<p class="hint setting-row__reason">${escapeHtml(clear.reason)}</p>`}
    ${clear === null || clear.warning === null ? "" : `<p class="hint setting-row__reason">${escapeHtml(clear.warning)}</p>`}`;
}

function settingRow(options: {
  id: string;
  title: string;
  summaryNote?: string;
  effectiveText: string;
  source: string;
  state?: string;
  hint?: string | null;
  warnings?: readonly string[];
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
      ${options.hint === undefined || options.hint === null ? "" : `<p class="hint">${escapeHtml(options.hint)}</p>`}
      ${options.warnings === undefined || options.warnings.length === 0 ? "" : warningList(options.warnings)}
      ${options.body}
      ${options.details ?? ""}
    </div>
  </details>`;
}

function scopeDetailsHtml(details: readonly SettingsScopeDetailProps[]): string {
  if (details.length === 0) {
    return "";
  }
  const rows = details
    .map(
      (row) =>
        `<div class="scope-list__row"><dt>${escapeHtml(row.label)}</dt><dd>${row.valueText === null ? "" : `<span class="mono">${escapeHtml(row.valueText)}</span>`}<span class="scope-list__state">${escapeHtml(row.stateLabel)}</span></dd></div>`,
    )
    .join("");
  return `<details class="disclosure scope-details">
    <summary>Scope details${icon("chevron-down", "disclosure__chevron")}</summary>
    <dl class="scope-list">${rows}</dl>
  </details>`;
}

function textField(row: SettingsRowProps, label: string): string {
  const text = row.text;
  if (text === null) {
    return "";
  }
  const listAttribute = text.listId === null ? "" : ` list="${escapeHtml(text.listId)}"`;
  const datalist =
    text.listId === null
      ? ""
      : `<datalist id="${escapeHtml(text.listId)}">${text.options
          .map((value) => `<option value="${escapeHtml(value)}"></option>`)
          .join("")}</datalist>`;
  const id =
    row.kind === "model"
      ? "model-value"
      : row.key === "git.user.name"
        ? "git-user-name"
        : "git-user-email";
  const name = row.kind === "model" ? "value" : "value";
  return `<div class="field">
      <label class="label" for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <input class="input" id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="text"${listAttribute} placeholder="${escapeHtml(text.placeholder)}" value="${escapeHtml(text.value)}"${text.required ? " required" : ""}${text.autocomplete === null ? "" : ` autocomplete="${escapeHtml(text.autocomplete)}"`} />
      ${datalist}
    </div>`;
}

function modelControls(row: SettingsRowProps): string {
  return `<form class="setting-row__form" method="post" action="${escapeHtml(row.form.action)}" data-settings-form data-no-busy data-success-notice="${escapeHtml(row.form.successNotice)}">
    ${hiddenTarget(row.form)}
    <input type="hidden" name="key" value="${escapeHtml(row.key)}" />
    ${textField(row, "Model")}
    ${actionButtons(row.actions)}
  </form>`;
}

function driverFields(row: SettingsRowProps): string {
  const driver = row.driver;
  if (driver === null) {
    return "";
  }
  const prefix = row.key.replace(/\./g, "-");
  const fields = driver.fields
    .map((field) => {
      if (field.type === "checkbox") {
        return `<label class="check"><input class="checkbox" type="checkbox" name="${escapeHtml(field.name)}" value="1"${field.checked ? " checked" : ""} /><span>${escapeHtml(field.label)}</span></label>`;
      }
      const min = field.min === null ? "" : ` min="${field.min}"`;
      const max = field.max === null ? "" : ` max="${field.max}"`;
      const placeholder =
        field.placeholder === null ? "" : ` placeholder="${escapeHtml(field.placeholder)}"`;
      const required = field.required && driver.showFields ? " required" : "";
      const id = `${prefix}-${field.name}`;
      return `<div class="field"><label class="label" for="${escapeHtml(id)}">${escapeHtml(field.label)}</label><input class="input" id="${escapeHtml(id)}" name="${escapeHtml(field.name)}" type="${field.type}"${min}${max}${required} value="${escapeHtml(field.value)}"${placeholder} /></div>`;
    })
    .join("");
  return `<div class="stack--tight" data-driver-fields="deepseek"${driver.showFields ? "" : " hidden"}>${fields}</div>`;
}

function webControls(row: SettingsRowProps): string {
  const driver = row.driver;
  if (driver === null) {
    return "";
  }
  const choices = driver.options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("");
  const placeholder =
    driver.placeholder === null
      ? ""
      : `<option value="${escapeHtml(driver.placeholder.value)}"${driver.placeholder.selected ? " selected" : ""}${driver.placeholder.disabled ? " disabled" : ""}>${escapeHtml(driver.placeholder.label)}</option>`;
  return `<form class="setting-row__form" method="post" action="${escapeHtml(row.form.action)}" data-settings-form data-no-busy data-success-notice="${escapeHtml(row.form.successNotice)}">
    ${hiddenTarget(row.form)}
    <input type="hidden" name="key" value="${escapeHtml(row.key)}" />
    ${row.inheritedNote === null ? "" : `<p class="hint">${escapeHtml(row.inheritedNote)}</p>`}
    <div class="field">
      <label class="label" for="${escapeHtml(row.key.replace(/\./g, "-"))}-driver">Driver</label>
      <div class="select-wrap">
        <select class="select" id="${escapeHtml(row.key.replace(/\./g, "-"))}-driver" name="driver" data-settings-driver required>${placeholder}${choices}</select>
        ${icon("chevron-down")}
      </div>
    </div>
    ${driverFields(row)}
    ${actionButtons(row.actions)}
  </form>`;
}

function contextEnabledControls(row: SettingsRowProps): string {
  const select = row.select;
  if (select === null) {
    return "";
  }
  const placeholder =
    select.placeholder === null
      ? ""
      : `<option value="${escapeHtml(select.placeholder.value)}"${select.placeholder.selected ? " selected" : ""}${select.placeholder.disabled ? " disabled" : ""}>${escapeHtml(select.placeholder.label)}</option>`;
  const options = select.options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("");
  return `<form class="setting-row__form" method="post" action="${escapeHtml(row.form.action)}" data-settings-form data-no-busy data-success-notice="${escapeHtml(row.form.successNotice)}">
    ${hiddenTarget(row.form)}
    <input type="hidden" name="key" value="${escapeHtml(row.key)}" />
    <div class="field">
      <label class="label" for="context-auto-compact-enabled">Auto-compaction</label>
      <div class="select-wrap">
        <select class="select" id="context-auto-compact-enabled" name="value" required>${placeholder}${options}</select>
        ${icon("chevron-down")}
      </div>
    </div>
    ${actionButtons(row.actions)}
  </form>`;
}

function contextPercentControls(row: SettingsRowProps): string {
  const number = row.number;
  if (number === null) {
    return "";
  }
  return `<form class="setting-row__form" method="post" action="${escapeHtml(row.form.action)}" data-settings-form data-no-busy data-success-notice="${escapeHtml(row.form.successNotice)}">
    ${hiddenTarget(row.form)}
    <input type="hidden" name="key" value="${escapeHtml(row.key)}" />
    <div class="field">
      <label class="label" for="context-auto-compact-percent">Threshold</label>
      <input class="input" id="context-auto-compact-percent" name="value" type="number" min="${number.min}" max="${number.max}" step="${number.step}" placeholder="${escapeHtml(number.placeholder)}" value="${escapeHtml(number.value)}"${number.required ? " required" : ""} />
    </div>
    ${actionButtons(row.actions)}
  </form>`;
}

function providerPill(status: SettingsProviderRowProps["status"]): string {
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

function providerSection(props: SettingsProps): string {
  const providers = props.providers;
  const rows =
    providers.length === 0
      ? '<p class="hint">No providers are referenced by the effective model or web tools.</p>'
      : providers
          .map((provider) =>
            settingRow({
              id: provider.rowId,
              title: provider.provider,
              summaryNote: "Change key",
              effectiveText: provider.effectiveText,
              source: provider.sourceLine,
              state: providerPill(provider.status),
              body: `${fieldErrorSlot(provider.errorSlotId)}<form class="setting-row__form" method="post" action="${escapeHtml(provider.form.action)}" data-settings-form data-no-busy data-success-notice="${escapeHtml(provider.form.successNotice)}">
              ${hiddenTarget(provider.form)}
              <input type="hidden" name="provider" value="${escapeHtml(provider.provider)}" />
              <div class="field">
                <label class="label" for="provider-key-${providers.indexOf(provider)}">API key</label>
                <input class="input" id="provider-key-${providers.indexOf(provider)}" name="key" type="password" autocomplete="new-password" placeholder="${escapeHtml(provider.masked)}" required />
              </div>
              <div class="setting-row__actions">
                <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
                ${provider.actions.inherit === null ? "" : `<button class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit" formnovalidate data-settings-inherit${provider.actions.inherit.enabled ? "" : " disabled"}>Inherit</button>`}
                ${provider.actions.clear === null ? "" : `<button class="btn btn-danger btn-sm" type="submit" name="action" value="clear" formnovalidate data-confirm-clear data-setting-label="${escapeHtml(provider.actions.clear.confirmLabel ?? "")}"${provider.actions.clear.enabled ? "" : " disabled"}>Clear</button>`}
              </div>
              ${provider.actions.inherit === null || provider.actions.inherit.reason === null ? "" : `<p class="hint setting-row__reason">${escapeHtml(provider.actions.inherit.reason)}</p>`}
              ${provider.actions.clear === null || provider.actions.clear.reason === null ? "" : `<p class="hint setting-row__reason">${escapeHtml(provider.actions.clear.reason)}</p>`}
            </form>`,
            }),
          )
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
        ${hiddenTarget(props.rows.model.form, `${props.scope.href}#providers`)}
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

type ModelProviderLabels = SettingsProps["labels"]["modelProviders"];

interface ModelRowValues {
  readonly id?: string;
  readonly name?: string;
  readonly context?: string;
  readonly input?: string;
  readonly output?: string;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly temperature?: boolean;
  readonly costInput?: string;
  readonly costOutput?: string;
}

function modelRowValues(model: ModelProviderModel): ModelRowValues {
  return {
    id: model.id,
    name: model.name,
    context: String(model.limit.context),
    input: model.limit.input === undefined ? "" : String(model.limit.input),
    output: String(model.limit.output),
    attachment: model.attachment === true,
    reasoning: model.reasoning === true,
    toolCall: model.toolCall !== false,
    temperature: model.temperature === true,
    costInput: model.cost === undefined ? "" : String(model.cost.input),
    costOutput: model.cost === undefined ? "" : String(model.cost.output),
  };
}

function modelRowFields(
  index: number,
  prefix: string,
  values: ModelRowValues,
  labels: ModelProviderLabels,
  withIds = true,
): string {
  const fieldId = (field: string) => `${prefix}-${index}-${field}`;
  const labelFor = (field: string) => (withIds ? ` for="${escapeHtml(fieldId(field))}"` : "");
  const inputId = (field: string) => (withIds ? ` id="${escapeHtml(fieldId(field))}"` : "");
  const textField = (
    field: string,
    label: string,
    value: string,
    placeholder: string,
    type = "text",
  ) =>
    `<div class="field">
      <label class="label"${labelFor(field)} data-model-label="${field}">${escapeHtml(label)}</label>
      <input class="input"${inputId(field)} name="model-${index}-${field}" data-model-field="${field}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"${type === "number" ? ' min="0" step="any"' : ""} />
    </div>`;
  const checkbox = (field: string, label: string, checked: boolean) =>
    `<label class="check"><input class="checkbox" type="checkbox" name="model-${index}-${field}" data-model-field="${field}" value="1"${checked ? " checked" : ""} /><span>${escapeHtml(label)}</span></label>`;
  return `<div class="model-row" data-model-row>
    <div class="model-row__head">
      <span class="label" data-model-title>${escapeHtml(labels.modelRow)} ${index + 1}</span>
      <button class="btn btn-ghost btn-sm" type="button" data-model-remove>${escapeHtml(labels.removeModel)}</button>
    </div>
    <div class="model-row__grid">
      ${textField("id", labels.modelId, values.id ?? "", labels.modelIdPlaceholder)}
      ${textField("name", labels.modelName, values.name ?? "", labels.modelNamePlaceholder)}
      ${textField("context", labels.contextWindow, values.context ?? "", labels.contextWindowPlaceholder, "number")}
      ${textField("output", labels.outputLimit, values.output ?? "", labels.outputLimitPlaceholder, "number")}
      ${textField("input", labels.inputLimit, values.input ?? "", labels.inputLimitPlaceholder, "number")}
      <span class="label model-row__section">${escapeHtml(labels.cost)}</span>
      ${textField("costInput", labels.costInput, values.costInput ?? "", labels.costPlaceholder, "number")}
      ${textField("costOutput", labels.costOutput, values.costOutput ?? "", labels.costPlaceholder, "number")}
    </div>
    <span class="label">${escapeHtml(labels.capabilities)}</span>
    <div class="cluster">
      ${checkbox("attachment", labels.attachments, values.attachment === true)}
      ${checkbox("reasoning", labels.reasoning, values.reasoning === true)}
      ${checkbox("toolCall", labels.toolCalls, values.toolCall !== false)}
      ${checkbox("temperature", labels.temperature, values.temperature === true)}
    </div>
  </div>`;
}

function modelRowsBlock(
  prefix: string,
  models: readonly ModelProviderModel[],
  labels: ModelProviderLabels,
): string {
  const rows =
    models.length === 0
      ? modelRowFields(0, prefix, { toolCall: true }, labels)
      : models
          .map((model, index) => modelRowFields(index, prefix, modelRowValues(model), labels))
          .join("");
  return `<div class="model-list" data-model-list data-model-prefix="${escapeHtml(prefix)}" data-model-title-label="${escapeHtml(labels.modelRow)}">${rows}</div>
    <template data-model-template>${modelRowFields(0, prefix, { toolCall: true }, labels, false)}</template>
    <div class="setting-row__actions">
      <button class="btn btn-ghost btn-sm" type="button" data-model-add>${escapeHtml(labels.addModel)}</button>
    </div>`;
}

function customProvidersBlock(props: SettingsProps): string {
  const block = props.modelProviders;
  const labels = props.labels.modelProviders;
  if (props.scope.scope !== "global") {
    return `<p class="hint">${escapeHtml(labels.globalHint)} <a href="${escapeHtml(block.manageHref)}">${escapeHtml(labels.manage)}</a>.</p>`;
  }
  const rows =
    block.providers.length === 0
      ? `<p class="hint">${escapeHtml(labels.empty)}</p>`
      : block.providers
          .map((provider, index) =>
            settingRow({
              id: provider.rowId,
              title: `${provider.name} (${provider.id})`,
              summaryNote: "Edit",
              effectiveText: provider.baseUrl,
              source: "Global",
              state: providerPill(provider.key.status),
              warnings: provider.warnings,
              body: `<p class="hint">Key: <a href="#provider-${encodeURIComponent(provider.id)}">${escapeHtml(provider.key.label)}</a> · ${plural(provider.models.length, "model")}</p>
              <form class="setting-row__form" method="post" action="${escapeHtml(block.add.action)}" data-settings-form data-no-busy data-success-notice="Provider saved.">
                <input type="hidden" name="action" value="update" />
                <input type="hidden" name="id" value="${escapeHtml(provider.id)}" />
                <input type="hidden" name="return_to" value="${escapeHtml(block.add.returnTo)}" />
                ${fieldErrorSlot(provider.errorId)}
                <div class="field">
                  <label class="label" for="${escapeHtml(provider.nameInputId)}">${escapeHtml(labels.name)}</label>
                  <input class="input" id="${escapeHtml(provider.nameInputId)}" name="name" type="text" value="${escapeHtml(provider.name)}" autocomplete="off" />
                </div>
                <div class="field">
                  <label class="label" for="${escapeHtml(provider.urlInputId)}">${escapeHtml(labels.baseUrl)}</label>
                  <input class="input" id="${escapeHtml(provider.urlInputId)}" name="baseUrl" type="text" value="${escapeHtml(provider.baseUrl)}" required autocomplete="off" />
                </div>
                <div class="field">
                  <span class="label">${escapeHtml(labels.models)}</span>
                  <p class="hint">${escapeHtml(labels.modelsHint)}</p>
                </div>
                ${modelRowsBlock(`custom-provider-model-${index}`, provider.models, labels)}
                <div class="setting-row__actions">
                  <button class="btn btn-primary btn-sm" type="submit">Save</button>
                  <button class="btn btn-danger btn-sm" type="submit" name="delete" value="1" data-confirm="Delete provider ${escapeHtml(provider.id)}?">Delete</button>
                </div>
              </form>`,
            }),
          )
          .join("");
  const add = `<details class="disclosure provider-add">
    <summary>${escapeHtml(labels.addTitle)}${icon("chevron-down", "disclosure__chevron")}</summary>
    <form class="setting-row__form provider-add__form" method="post" action="${escapeHtml(block.add.action)}" data-settings-form data-no-busy data-success-notice="Provider saved.">
      <input type="hidden" name="action" value="create" />
      <input type="hidden" name="return_to" value="${escapeHtml(block.add.returnTo)}" />
      ${fieldErrorSlot(block.add.errorId)}
      <div class="field">
        <label class="label" for="custom-provider-new-id">${escapeHtml(labels.providerId)}</label>
        <input class="input" id="custom-provider-new-id" name="id" type="text" placeholder="${escapeHtml(labels.providerIdPlaceholder)}" required autocomplete="off" />
      </div>
      <div class="field">
        <label class="label" for="custom-provider-new-name">${escapeHtml(labels.name)}</label>
        <input class="input" id="custom-provider-new-name" name="name" type="text" placeholder="${escapeHtml(labels.namePlaceholder)}" autocomplete="off" />
      </div>
      <div class="field">
        <label class="label" for="custom-provider-new-url">${escapeHtml(labels.baseUrl)}</label>
        <input class="input" id="custom-provider-new-url" name="baseUrl" type="text" placeholder="${escapeHtml(labels.baseUrlPlaceholder)}" required autocomplete="off" />
        <p class="hint">Resolved inside the app container: use the host LAN address, not 127.0.0.1 or localhost.</p>
      </div>
      <div class="field">
        <span class="label">${escapeHtml(labels.models)}</span>
        <p class="hint">${escapeHtml(labels.modelsHint)}</p>
      </div>
      ${modelRowsBlock("custom-provider-model-new", [], labels)}
      <div class="setting-row__actions">
        <button class="btn btn-primary btn-sm" type="submit">Save</button>
      </div>
    </form>
  </details>`;
  return `<div class="providers" id="custom-providers" aria-labelledby="custom-providers-title">
    <div class="providers__head">
      <h3 class="card__title" id="custom-providers-title">${escapeHtml(labels.title)}</h3>
      <span class="badge">${plural(block.count, "provider")}</span>
    </div>
    <p class="hint providers__hint">${escapeHtml(labels.hint)}</p>
    ${rows}${add}
  </div>`;
}

function pendingSection(restart: SettingsProps["restart"]): string {
  const rows =
    restart.pending.length === 0
      ? '<p class="hint">No running agents are waiting for a restart.</p>'
      : `<div class="stack--tight">${restart.pending
          .map(
            (entry) => `<div class="cluster" id="pending-${escapeHtml(entry.appId)}">
              <span class="status" data-state="awaiting_approval">${icon("stamp")}Restart required</span>
              <a class="small" href="${escapeHtml(entry.href)}">${escapeHtml(entry.appKey)}</a>
              <span class="small">${escapeHtml(entry.reasonLabels.join(", "))}</span>
              <form method="post" action="${escapeHtml(entry.restartAction)}">
                <input type="hidden" name="return_to" value="${escapeHtml(entry.returnTo)}" />
                <button class="btn btn-primary btn-sm" type="submit">${icon("refresh")}Restart agent</button>
              </form>
            </div>`,
          )
          .join("")}</div>`;
  return `<section class="card settings-section" id="settings-restart" aria-labelledby="restart-pending-title">
    <div class="card__head">
      <h2 class="card__title" id="restart-pending-title">Restart &amp; pending</h2>
      <span class="badge">${restart.pending.length}</span>
    </div>
    <div class="card__body" id="restart-pending">
      <p class="hint">Settings changes apply only on an explicit restart. A restart interrupts an active turn; sessions are kept.</p>
      ${rows}
    </div>
    ${profileWarningsSection(restart.profileWarnings)}
  </section>`;
}

function warningsSection(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return `<section class="settings-warning" aria-labelledby="settings-warnings-title">
    <p class="settings-warning__title" id="settings-warnings-title">${icon("alert-triangle")}Warnings</p>
    <div class="stack--tight">${warningList(warnings)}</div>
  </section>`;
}

function profileWarningsSection(warnings: readonly string[]): string {
  if (warnings.length === 0) {
    return "";
  }
  return `<div class="settings-warning settings-warning--profile" aria-labelledby="profile-warnings-title">
    <p class="settings-warning__title" id="profile-warnings-title">${icon("alert-triangle")}OMO profile warnings</p>
    <div class="stack--tight">${warningList(warnings)}</div>
  </div>`;
}

function gitAuthPill(status: SettingsGitCredentialProps["status"]): string {
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

function gitAuthDetails(credential: SettingsGitCredentialProps): string {
  if (credential.status.state === "set" && credential.status.kind === "ssh") {
    return `<div class="stack--tight">
      <span class="overline">Public key</span>
      <span class="mono small" id="git-ssh-public-key">${escapeHtml(credential.details.publicKey ?? "")}</span>
      <span class="overline">Fingerprint</span>
      <span class="mono small" id="git-ssh-fingerprint">${escapeHtml(credential.details.fingerprint ?? "")}</span>
      <span class="overline">known_hosts</span>
      <span class="small">${credential.details.hasKnownHosts === true ? "Set — strict host checking." : "Not set — accept-new (TOFU) on first connection."}</span>
    </div>`;
  }
  if (credential.status.state === "set" && credential.status.kind === "https") {
    return `<div class="stack--tight">
      <span class="overline">Allowed hosts</span>
      <span class="mono small" id="git-https-allowed-hosts">${escapeHtml((credential.details.hosts ?? []).join(", "))}</span>
      <span class="overline">Username</span>
      <span class="mono small" id="git-https-username-value">${escapeHtml(credential.details.username ?? "")}</span>
    </div>`;
  }
  if (credential.status.state === "error") {
    return `<p class="field-error" role="alert">${icon("alert-triangle")}${escapeHtml(credential.details.error ?? "")}</p>`;
  }
  if (credential.status.state === "cleared") {
    return '<p class="hint">A tombstone at this scope suppresses wider credentials; nothing is materialized for the app.</p>';
  }
  return '<p class="hint">No credential is set or inherited; git operations that need a remote credential fail closed.</p>';
}

function gitAuthForm(credential: SettingsGitCredentialProps): string {
  const prefix = `git-${credential.kind}`;
  const fields =
    credential.kind === "ssh"
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
  const testFields = credential.allowTest
    ? `<div class="field">
          <label class="label" for="${prefix}-test-remote">Remote (optional)</label>
          <input class="input" id="${prefix}-test-remote" name="testRemote" type="text" autocomplete="off" spellcheck="false" placeholder="Defaults to origin" />
        </div>`
    : "";
  const testButton = credential.allowTest
    ? '<button class="btn btn-secondary btn-sm" type="submit" data-git-test>Test connection</button>'
    : "";
  const inheritButton =
    credential.form.hidden.scope === "global"
      ? ""
      : `<button class="btn btn-secondary btn-sm" type="submit" name="action" value="inherit" formnovalidate data-settings-inherit${credential.inheritReason === null ? "" : " disabled"}>Inherit</button>`;
  const clearButton = `<button class="btn btn-danger btn-sm" type="submit" name="action" value="clear" formnovalidate${credential.clearReason === null ? "" : " disabled"}>Clear</button>`;
  return `<form class="stack--tight" data-git-auth data-no-busy method="post" action="${escapeHtml(credential.actions.action)}">
    ${hiddenTarget(credential.form)}
    <input type="hidden" name="kind" value="${escapeHtml(credential.kind)}" />
    ${fields}
    ${testFields}
    <div class="setting-row__actions">
      <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
      ${inheritButton}
      ${clearButton}
      ${testButton}
    </div>
    ${credential.inheritReason === null ? "" : `<p class="hint setting-row__reason">${escapeHtml(credential.inheritReason)}</p>`}
    ${credential.clearReason === null ? "" : `<p class="hint setting-row__reason">${escapeHtml(credential.clearReason)}</p>`}
    ${
      credential.allowTest
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

function gitCredentialRow(credential: SettingsGitCredentialProps): string {
  return settingRow({
    id: `setting-git-${credential.kind}`,
    title: credential.title,
    effectiveText: credential.effectiveText,
    source: credential.sourceLine,
    state: gitAuthPill(credential.status),
    body: `<div class="stack--tight" id="git-${credential.kind}">
      ${gitAuthDetails(credential)}
      ${gitAuthForm(credential)}
    </div>`,
    details: scopeDetailsHtml(credential.scopeDetails),
  });
}

function gitIdentityRow(row: SettingsRowProps, title: string): string {
  const text = row.text;
  if (text === null) {
    return "";
  }
  const identityId = row.key === "git.user.name" ? "git-identity-name" : "git-identity-email";
  const inputId = row.key === "git.user.name" ? "git-user-name" : "git-user-email";
  const form = `<div id="${identityId}">
    <form class="setting-row__form" method="post" action="${escapeHtml(row.form.action)}" data-settings-form data-no-busy data-success-notice="${escapeHtml(row.form.successNotice)}">
      ${hiddenTarget(row.form)}
      <input type="hidden" name="key" value="${escapeHtml(row.key)}" />
      <div class="field">
        <label class="label" for="${inputId}">${escapeHtml(title)}</label>
        <input class="input" id="${inputId}" name="value" type="text" autocomplete="off" placeholder="${escapeHtml(text.placeholder)}" value="${escapeHtml(text.value)}" />
      </div>
      ${actionButtons(row.actions)}
    </form>
  </div>`;
  return settingRow({
    id: row.id,
    title,
    effectiveText: row.effectiveText,
    source: row.sourceLine,
    body: `${fieldErrorSlot(row.errorSlotId)}${form}`,
    details: scopeDetailsHtml(row.scopeDetails),
  });
}

function gitSection(props: SettingsProps): string {
  const credentials = [gitCredentialRow(props.git.ssh), gitCredentialRow(props.git.https)].join("");
  const testNote =
    props.scope.scope === "app"
      ? `<p class="hint">${escapeHtml(props.git.testCheck.hint)}</p>`
      : `<div class="stack--tight">
        <span class="overline">Credential check</span>
        <p class="hint">${escapeHtml(props.git.testCheck.hint)}</p>
        ${
          props.git.testCheck.href === null
            ? ""
            : `<a class="btn btn-ghost btn-sm" href="${escapeHtml(props.git.testCheck.href)}">Application settings</a>`
        }
      </div>`;
  return `<section class="card settings-section" id="settings-git" aria-labelledby="git-title">
    <div class="card__head">
      <h2 class="card__title" id="git-title">Git</h2>
      <span class="badge">Identity and credentials</span>
    </div>
    <div class="card__body card__body--flush" id="git">
      <noscript><p class="hint settings-noscript">Git credential changes require JavaScript.</p></noscript>
      ${gitIdentityRow(props.rows.gitName, "User name")}
      ${gitIdentityRow(props.rows.gitEmail, "User email")}
      ${credentials}
      <div class="stack--tight git-notes">
        ${testNote}
        <span class="overline">Security notes</span>
        <p class="hint">Passphrase-protected SSH keys are not supported in v1; use an unencrypted deploy key. Without known_hosts, SSH uses accept-new (TOFU) on first connection. HTTPS hosts are mandatory and matched exactly; remote URLs with a different host fail closed. Use scoped deploy keys or fine-grained tokens with the least privilege — the agent can read its own materialized credentials.</p>
      </div>
    </div>
  </section>`;
}

function settingsNav(props: SettingsProps): string {
  const scope = props.scope;
  const globalLink = `<a class="settings-nav__link" href="${escapeHtml(scope.nav.globalHref)}">Global</a>`;
  const projectHref = scope.nav.projectHref;
  const appHref = scope.nav.appHref;
  const current = (label: string, short?: string): string =>
    short === undefined
      ? `<span class="settings-nav__link" aria-current="page">${icon("check")}${escapeHtml(label)}</span>`
      : `<span class="settings-nav__link" aria-current="page">${icon("check")}<span class="settings-nav__scope-full">${escapeHtml(label)}</span><span class="settings-nav__scope-short">${escapeHtml(short)}</span></span>`;
  const scopes =
    scope.scope === "global"
      ? ""
      : `<div class="settings-nav__scopes" role="group" aria-label="Settings scope">
        ${globalLink}
        ${
          scope.scope === "project"
            ? current("Project")
            : `<a class="settings-nav__link" href="${escapeHtml(projectHref ?? "/settings")}">Project</a>`
        }
        ${
          scope.scope === "app"
            ? current("Application", "App")
            : appHref === null
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

function clearDialog(dialogs: SettingsProps["dialogs"]): string {
  const clear = dialogs.clear;
  return `<dialog class="dialog" id="${clear.id}" aria-labelledby="${clear.titleId}">
    <div class="dialog__frame">
      <form class="dialog__form" method="post" action="${escapeHtml(clear.action)}" id="${clear.formId}" data-no-busy>
        <input type="hidden" name="action" value="clear" />
        <div class="dialog__head">
          <h2 class="dialog__title" id="${clear.titleId}">Clear setting at this scope?</h2>
          <p class="dialog__meta" id="${clear.metaId}"></p>
        </div>
        <div class="dialog__body">
          <p id="${clear.bodyId}">Wider scopes will no longer apply. The setting stays disabled until you set it again.</p>
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

function settingsRowCard(row: SettingsRowProps, body: string): string {
  return settingRow({
    id: row.id,
    title: row.title,
    hint: row.hint ?? undefined,
    effectiveText: row.effectiveText,
    source: row.sourceLine,
    warnings: row.warnings,
    body: `${fieldErrorSlot(row.errorSlotId)}${body}`,
    details: scopeDetailsHtml(row.scopeDetails),
  });
}

export function settingsSections(props: SettingsProps): SettingsSections {
  const agentRows = `${settingsRowCard(props.rows.model, modelControls(props.rows.model))}${providerSection(props)}${customProvidersBlock(props)}`;
  const webRows = `${settingsRowCard(props.rows.webSearch, webControls(props.rows.webSearch))}${settingsRowCard(props.rows.webFetch, webControls(props.rows.webFetch))}`;
  const contextRows = `${settingsRowCard(props.rows.contextEnabled, contextEnabledControls(props.rows.contextEnabled))}${settingsRowCard(props.rows.contextPercent, contextPercentControls(props.rows.contextPercent))}`;

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
    git: gitSection(props),
    restart: pendingSection(props.restart),
    warnings: warningsSection(props.warnings),
  };
}

function renderSettingsPage(options: {
  props: SettingsProps;
  site: SiteModel;
  chrome: PageChrome;
  path: string;
}): string {
  const props = options.props;
  const sections = settingsSections(props);
  const body = `${settingsNav(props)}
    <div id="settings-warnings">${sections.warnings}</div>
    <div class="settings-sections">
      ${sections.agent}
      ${sections.web}
      ${sections.context}
      ${sections.git}
      ${sections.restart}
    </div>
    ${clearDialog(props.dialogs)}`;

  const header = pageHeader({
    overline: "Settings",
    title: props.scope.title,
    description: props.scope.description,
  });

  return appShell({
    title: props.scope.title,
    active: "settings",
    ...(props.scope.projectId === null ? {} : { activeProjectId: props.scope.projectId }),
    settingsHref: options.path,
    skillsHref: props.scope.skillsHref,
    breadcrumb: [...props.scope.breadcrumb],
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
