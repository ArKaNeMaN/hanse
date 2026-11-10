import { GitCredentialValidationError } from "../git/credentials.js";
import {
  collisionWarnings,
  type ModelProvider,
  ModelProviderConflictError,
  ModelProviderInUseError,
  ModelProviderNotFoundError,
  ModelProviderValidationError,
  parseModelLines,
  providerBaseUrlWarnings,
} from "../model-providers/index.js";
import {
  DEFAULT_TELEGRAM_API_BASE_URL,
  type NotificationSecretField,
  type PendingRestart,
  type ResolvedSettings,
  type SettingsService,
  SettingsValidationError,
  TelegramSecretValidationError,
} from "../settings/index.js";
import type { SettingsScope, SettingsTarget } from "../settings/types.js";
import { findApp, toManagedApp } from "./apps.js";
import { humanFrom, principalFrom } from "./auth.js";
import { crossSiteMutation } from "./chat.js";
import { lifecycleErrorResponse } from "./errors.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import { parseSettingsTarget, settingsPagePath } from "./props/settings.js";
import { safeLocalPath } from "./ui.js";

const JSON_HEADERS = { "cache-control": "no-store" };

export interface TelegramTestMessage {
  botToken: string;
  chatId: string;
  apiBaseUrl: string;
  proxyUrl?: string;
}

export interface TelegramTestTransport {
  sendTest(message: TelegramTestMessage): Promise<void>;
}

let telegramTestTransport: TelegramTestTransport | undefined;

export function setTelegramTestTransport(transport: TelegramTestTransport | undefined): void {
  telegramTestTransport = transport;
}

const TELEGRAM_TEST_INTERVAL_MS = 5_000;
const telegramTestLastAt = new Map<string, number>();

export function resetTelegramTestRateLimit(): void {
  telegramTestLastAt.clear();
}

function consumeTelegramTest(key: string, now: number): boolean {
  for (const [candidate, at] of telegramTestLastAt) {
    if (now - at >= TELEGRAM_TEST_INTERVAL_MS) telegramTestLastAt.delete(candidate);
  }
  const last = telegramTestLastAt.get(key);
  if (last !== undefined && now - last < TELEGRAM_TEST_INTERVAL_MS) {
    return false;
  }
  telegramTestLastAt.set(key, now);
  return true;
}

function telegramScopeKey(scope: SettingsScope, target: SettingsTarget): string {
  if (scope === "global") {
    return "global";
  }
  if (scope === "project") {
    return `project:${target.projectId ?? ""}`;
  }
  return `app:${target.projectId ?? ""}:${target.appKey ?? ""}`;
}

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

function requireNotificationSecretField(value: unknown): NotificationSecretField {
  if (value === "bot_token" || value === "proxy_url") {
    return value;
  }
  throw new SettingsValidationError("field must be bot_token or proxy_url");
}

function telegramMutationError(error: unknown): HttpResponse {
  if (error instanceof TelegramSecretValidationError) {
    return json(400, {
      error: error.message,
      code: "invalid_telegram_secret",
      field: error.field,
    });
  }
  if (error instanceof SettingsValidationError || error instanceof BodyValidationError) {
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
  if (pathname === "/api/settings" || pathname === "/api/settings/provider") {
    return true;
  }
  if (pathname === "/api/settings/model-providers") {
    return true;
  }
  if (pathname === "/api/settings/git") {
    return method === "POST";
  }
  if (pathname === "/api/settings/telegram" || pathname === "/api/settings/telegram/test") {
    return method === "POST";
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
  const browser = wantsHtml(request);
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
    if (crossSiteMutation(request)) {
      return json(403, { error: "cross-site request rejected", code: "cross_site" });
    }
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
      return json(200, settingsResponse(settings, deps, scope, target));
    } catch (error) {
      return gitAuthMutationError(error);
    }
  }

  if (request.path === "/api/settings/telegram" && request.method === "POST") {
    if (crossSiteMutation(request)) {
      return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
    }
    try {
      if (!isJsonRequest(request)) {
        throw new BodyValidationError("Telegram secret requests must use a JSON body.");
      }
      const payload = parseObjectBody(request);
      const { scope, target } = parseTarget(payload);
      const field = requireNotificationSecretField(stringValue(payload.field));
      const action = stringValue(payload.action) ?? "";
      if (action === "set") {
        if (payload.value === undefined) {
          throw new SettingsValidationError("value is required for set");
        }
        settings.setNotificationSecret(scope, target, field, payload.value, actor);
      } else if (action === "clear" || action === "inherit") {
        if (payload.value !== undefined) {
          throw new SettingsValidationError("value is not allowed for clear or inherit");
        }
        if (action === "clear") {
          settings.clearNotificationSecret(scope, target, field, actor);
        } else {
          settings.inheritNotificationSecret(scope, target, field);
        }
      } else {
        throw new SettingsValidationError("action must be set, clear, or inherit");
      }
      return json(200, { ok: true, ...settingsResponse(settings, deps, scope, target) });
    } catch (error) {
      return telegramMutationError(error);
    }
  }

  if (request.path === "/api/settings/telegram/test" && request.method === "POST") {
    if (crossSiteMutation(request)) {
      return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
    }
    let scope: SettingsScope;
    let target: SettingsTarget;
    try {
      if (!isJsonRequest(request)) {
        throw new BodyValidationError("Telegram test requests must use a JSON body.");
      }
      const payload = parseObjectBody(request);
      ({ scope, target } = parseTarget(payload));
    } catch (error) {
      return telegramMutationError(error);
    }
    const resolved = settings.resolve(target);
    const chatId = resolved.effective.notifications.telegram.chatId.value;
    if (resolved.telegram.botToken.state !== "set" || chatId === null || chatId.length === 0) {
      return json(400, {
        error: "a bot token and chat id are required",
        code: "invalid_request",
      });
    }
    const config = settings.telegramConfig(target);
    if (config.botToken === undefined) {
      return json(400, { error: "a bot token is required", code: "invalid_request" });
    }
    if (!consumeTelegramTest(telegramScopeKey(scope, target), Date.now())) {
      return json(429, {
        error: "a test message was sent recently; wait 5 seconds",
        code: "rate_limited",
      });
    }
    const transport = telegramTestTransport;
    if (transport === undefined) {
      return json(502, {
        error: "Telegram transport is not configured.",
        code: "telegram_unavailable",
      });
    }
    try {
      await transport.sendTest({
        botToken: config.botToken,
        chatId,
        apiBaseUrl:
          resolved.effective.notifications.telegram.apiBaseUrl.value ??
          DEFAULT_TELEGRAM_API_BASE_URL,
        ...(config.proxyUrl === undefined ? {} : { proxyUrl: config.proxyUrl }),
      });
    } catch {
      return json(502, {
        error: "Telegram test failed. Check the bot token, chat id, proxy, and API base URL.",
        code: "telegram_unavailable",
      });
    }
    return json(200, { ok: true });
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

  return json(404, { error: "not found" });
}
