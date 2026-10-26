import { randomUUID } from "node:crypto";
import { isMasterApp } from "../master/constants.js";
import {
  COMMAND_RUN_TIMEOUT_MS,
  listCommands,
  type OpencodeCommand,
  OpencodeHttpError,
  runSessionCommand,
} from "../opencode/client.js";
import {
  type CommandEntry,
  type CommandList,
  type CommandSourceStatus,
  type CommandWarning,
  type CommandWarningCode,
  capMergedResponse,
  containsShellBlock,
  detectShell,
  HANSE_COMMANDS,
  isValidCommandName,
  MERGED_RESPONSE_MAX_BYTES,
  mergeCommands,
  shellRequiresConfirmation,
  WARNINGS_MAX,
  whitelistOpencodeCommands,
} from "../opencode/commands.js";
import { DeletionPendingError } from "../opencode/manager.js";
import { type FoundApp, findApp, toManagedApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import { lifecycleErrorResponse } from "./errors.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

const LIST_PATH = /^\/api\/apps\/([^/]+)\/commands$/;
const SEND_PATH = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/commands$/;
const SUMMARY_CACHE_TTL_MS = 5_000;
const EARLY_WINDOW_MS = 750;
const MAX_ARGUMENT_BYTES = 32 * 1024;

const MESSAGES = {
  invalid_json: "Invalid JSON body.",
  empty_command: "Choose a command.",
  invalid_command: "Invalid command name.",
  command_too_large: "Command arguments are too large.",
  shell_confirmation_required: "Confirm the shell command before running it.",
  sign_in_required: "Sign in required.",
  human_only: "Only a human principal may run commands.",
  cross_site: "Cross-site request rejected.",
  unknown_app: "Unknown application.",
  command_not_found: "Command not found; refresh the list.",
  method_not_allowed: "Method not allowed.",
  deletion_pending: "Application is pending deletion.",
  unsupported_media_type: "Content type must be application/json.",
  agent_unavailable: "Agent is unavailable.",
  commands_unavailable: "Commands are unavailable.",
  command_failed: "Command outcome unknown.",
  agent_runtime_unconfigured: "Agent runtime is not configured.",
} as const;

type MessageCode = keyof typeof MESSAGES;

const WARNING_MESSAGES: Record<CommandWarningCode, string> = {
  agent_stopped: "Application commands load when the agent starts.",
  agent_runtime_unconfigured: "No agent runtime is configured; Hanse commands still work.",
  commands_unavailable: "Application commands are unavailable; Hanse commands still work.",
  command_shadowed: "Command is provided by the application.",
  command_dropped: "Some application commands were skipped.",
  command_cap_reached: "Some application commands were omitted because the list is too large.",
};

interface SummaryCacheEntry {
  expiresAt: number;
  result: ReturnType<typeof whitelistOpencodeCommands>;
}

const summaryCache = new Map<string, SummaryCacheEntry>();

/** Matches both command routes regardless of method so a wrong method becomes a 405. */
export function isCommandsRoute(_method: string, path: string): boolean {
  return LIST_PATH.test(path) || SEND_PATH.test(path);
}

export async function handleCommands(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const listMatch = LIST_PATH.exec(request.path);
  const sendMatch = SEND_PATH.exec(request.path);
  if (listMatch === null && sendMatch === null) {
    return json(404, { error: "not found" });
  }
  const isSend = sendMatch !== null;

  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return reject(deps, isSend, 401, "sign_in_required", MESSAGES.sign_in_required, {
      phase: "validate",
    });
  }
  if (principal.kind !== "human") {
    return reject(deps, isSend, 403, "human_only", MESSAGES.human_only, { phase: "validate" });
  }
  if (isSend && isCrossSite(request)) {
    return reject(deps, true, 403, "cross_site", MESSAGES.cross_site, { phase: "validate" });
  }
  if ((isSend && request.method !== "POST") || (!isSend && request.method !== "GET")) {
    return reject(deps, isSend, 405, "method_not_allowed", MESSAGES.method_not_allowed, {
      phase: "validate",
    });
  }
  if (isSend && !isJsonContentType(request.headers["content-type"])) {
    return reject(deps, true, 415, "unsupported_media_type", MESSAGES.unsupported_media_type, {
      phase: "validate",
    });
  }

  const appKey = safeDecode((listMatch ?? sendMatch)?.[1] ?? "");
  const sessionId = safeDecode(sendMatch?.[2] ?? "");
  const found = findApp(deps, projectParam(request), appKey);
  if (found === undefined) {
    return reject(deps, isSend, 404, "unknown_app", MESSAGES.unknown_app, {
      ...(sessionId.length === 0 ? {} : { sessionID: sessionId }),
      phase: "validate",
    });
  }
  if (found.app.deleting === true || found.project.deleting === true) {
    return reject(deps, isSend, 409, "deletion_pending", MESSAGES.deletion_pending, {
      appId: found.app.id,
      ...(sessionId.length === 0 ? {} : { sessionID: sessionId }),
      phase: "validate",
    });
  }

  return isSend ? handleSend(deps, request, found, sessionId) : handleList(deps, found);
}

async function handleList(deps: HttpDeps, found: FoundApp): Promise<HttpResponse> {
  const startedAt = Date.now();
  let entries: CommandEntry[] = [];
  let status: CommandSourceStatus;
  let warnings: CommandWarning[] = [];

  if (deps.manager === undefined) {
    status = "unconfigured";
    warnings = [{ code: "agent_runtime_unconfigured" }];
  } else if (!deps.manager.isRunning(found.app.id)) {
    status = "stopped";
    warnings = [{ code: "agent_stopped" }];
  } else {
    try {
      const endpoint = await deps.manager.ensure(toManagedApp(found));
      const whitelisted = await whitelistedSummaries(endpoint);
      entries = whitelisted.commands;
      warnings = whitelisted.warnings;
      status = "ok";
    } catch (error) {
      if (error instanceof DeletionPendingError) {
        return reject(deps, false, 409, "deletion_pending", MESSAGES.deletion_pending, {
          appId: found.app.id,
        });
      }
      const mapped = lifecycleErrorResponse(error);
      if (mapped !== undefined) {
        return mapped;
      }
      status = "unavailable";
      warnings = [{ code: "commands_unavailable" }];
    }
  }

  const built = buildGetResponse(found, entries, status, warnings);
  deps.logger?.info("commands.list", {
    appId: found.app.id,
    opencode: built.list.sources.opencode,
    count: built.list.commands.length,
    warningCodes: built.list.warnings.map((warning) => warning.code),
    dropped: built.dropped,
    durationMs: Date.now() - startedAt,
  });
  for (const warning of built.list.warnings) {
    if (warning.code === "command_shadowed") {
      deps.logger?.warn("commands.list.shadowed", {
        appId: found.app.id,
        command: warning.command,
        source: "opencode",
      });
    }
  }
  return built.response;
}

async function handleSend(
  deps: HttpDeps,
  request: HttpRequest,
  found: FoundApp,
  sessionId: string,
): Promise<HttpResponse> {
  const parsed = parseSendBody(request.body);
  if ("error" in parsed) {
    return reject(deps, true, 400, parsed.error, MESSAGES[parsed.error], {
      appId: found.app.id,
      sessionID: sessionId,
      phase: "validate",
    });
  }

  if (deps.manager === undefined) {
    return reject(
      deps,
      true,
      503,
      "agent_runtime_unconfigured",
      MESSAGES.agent_runtime_unconfigured,
      {
        appId: found.app.id,
        sessionID: sessionId,
        phase: "dispatch",
      },
    );
  }

  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure(toManagedApp(found));
  } catch (error) {
    if (error instanceof DeletionPendingError) {
      return reject(deps, true, 409, "deletion_pending", MESSAGES.deletion_pending, {
        appId: found.app.id,
        sessionID: sessionId,
        phase: "dispatch",
      });
    }
    const mapped = lifecycleErrorResponse(error);
    if (mapped !== undefined) {
      return mapped;
    }
    return reject(deps, true, 502, "agent_unavailable", MESSAGES.agent_unavailable, {
      appId: found.app.id,
      sessionID: sessionId,
      name: parsed.name,
      phase: "dispatch",
    });
  }

  const prevalidationStartedAt = Date.now();
  const fresh = await freshCommandEntry(deps, endpoint, found, sessionId, parsed.name);
  if (fresh.kind === "error") {
    return fresh.response;
  }
  const entry = fresh.entry;

  const templateShell = detectShell(entry.template);
  const effectiveShell =
    templateShell === "unknown"
      ? "unknown"
      : containsShellBlock(parsed.arguments)
        ? "present"
        : templateShell;
  if (shellRequiresConfirmation(effectiveShell) && !parsed.confirmShell) {
    return reject(
      deps,
      true,
      400,
      "shell_confirmation_required",
      MESSAGES.shell_confirmation_required,
      {
        appId: found.app.id,
        sessionID: sessionId,
        name: parsed.name,
        phase: "prevalidate",
      },
    );
  }

  const messageID = `msg_${randomUUID().replaceAll("-", "")}`;
  const dispatchStartedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const backgroundTimer = setTimeout(() => {
    timedOut = true;
    deps.logger?.warn("commands.send.timeout", {
      appId: found.app.id,
      sessionID: sessionId,
      name: parsed.name,
      messageID,
      durationMs: Date.now() - dispatchStartedAt,
    });
    controller.abort();
  }, COMMAND_RUN_TIMEOUT_MS);
  backgroundTimer.unref?.();

  const run = runSessionCommand(endpoint, sessionId, parsed.name, parsed.arguments, messageID, {
    signal: controller.signal,
  });
  const window = await settleWithin(run, EARLY_WINDOW_MS);

  if (window.kind === "rejected") {
    clearTimeout(backgroundTimer);
    deps.logger?.warn("commands.send.early_failed", {
      appId: found.app.id,
      sessionID: sessionId,
      name: parsed.name,
      messageID,
      status: errorStatus(window.error),
      code: errorCode(window.error),
      durationMs: Date.now() - dispatchStartedAt,
    });
    return json(502, {
      error: MESSAGES.command_failed,
      code: "command_failed",
      outcome: "unknown",
      messageID,
      sessionID: sessionId,
      name: parsed.name,
    });
  }

  if (window.kind === "settled") {
    clearTimeout(backgroundTimer);
  } else {
    void run.then(
      () => {
        clearTimeout(backgroundTimer);
      },
      (error: unknown) => {
        clearTimeout(backgroundTimer);
        if (!timedOut) {
          deps.logger?.warn("commands.send.failed", {
            appId: found.app.id,
            sessionID: sessionId,
            name: parsed.name,
            messageID,
            status: errorStatus(error),
            code: errorCode(error),
            durationMs: Date.now() - dispatchStartedAt,
          });
        }
      },
    );
  }

  deps.logger?.info("commands.send.accepted", {
    appId: found.app.id,
    sessionID: sessionId,
    name: parsed.name,
    messageID,
    argumentBytes: Buffer.byteLength(parsed.arguments, "utf8"),
    prevalidationDurationMs: dispatchStartedAt - prevalidationStartedAt,
    earlyWindow: window.kind === "settled" ? "ok" : "window",
  });
  return json(202, {
    accepted: true,
    sessionID: sessionId,
    name: parsed.name,
    messageID,
  });
}

type FreshCommand =
  | { kind: "entry"; entry: OpencodeCommand }
  | { kind: "error"; response: HttpResponse };

async function freshCommandEntry(
  deps: HttpDeps,
  endpoint: string,
  found: FoundApp,
  sessionId: string,
  name: string,
): Promise<FreshCommand> {
  const rejectFresh = (): { kind: "error"; response: HttpResponse } => ({
    kind: "error",
    response: reject(deps, true, 502, "commands_unavailable", MESSAGES.commands_unavailable, {
      appId: found.app.id,
      sessionID: sessionId,
      name,
      phase: "prevalidate",
    }),
  });

  let first: OpencodeCommand[];
  try {
    first = await listCommands(endpoint);
  } catch {
    return rejectFresh();
  }
  const hit = first.find((candidate) => candidate.name === name);
  if (hit !== undefined) {
    return { kind: "entry", entry: hit };
  }

  let second: OpencodeCommand[];
  try {
    second = await listCommands(endpoint);
  } catch {
    return rejectFresh();
  }
  const retry = second.find((candidate) => candidate.name === name);
  if (retry !== undefined) {
    return { kind: "entry", entry: retry };
  }

  return {
    kind: "error",
    response: reject(deps, true, 404, "command_not_found", MESSAGES.command_not_found, {
      appId: found.app.id,
      sessionID: sessionId,
      name,
      phase: "prevalidate",
    }),
  };
}

interface ParsedSend {
  name: string;
  arguments: string;
  confirmShell: boolean;
}

function parseSendBody(body: string | undefined): ParsedSend | { error: MessageCode } {
  let value: unknown;
  try {
    value = JSON.parse(body ?? "");
  } catch {
    return { error: "invalid_json" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "invalid_json" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    return { error: "empty_command" };
  }
  if (!isValidCommandName(record.name)) {
    return { error: "invalid_command" };
  }
  if (record.arguments !== undefined && typeof record.arguments !== "string") {
    return { error: "invalid_json" };
  }
  const argumentText = typeof record.arguments === "string" ? record.arguments : "";
  if (Buffer.byteLength(argumentText, "utf8") > MAX_ARGUMENT_BYTES) {
    return { error: "command_too_large" };
  }
  return {
    name: record.name,
    arguments: argumentText,
    confirmShell: record.confirmShell === true,
  };
}

async function whitelistedSummaries(
  endpoint: string,
): Promise<ReturnType<typeof whitelistOpencodeCommands>> {
  const now = Date.now();
  const cached = summaryCache.get(endpoint);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.result;
  }
  const result = whitelistOpencodeCommands(await listCommands(endpoint));
  const fetchedAt = Date.now();
  for (const [key, entry] of summaryCache) {
    if (entry.expiresAt <= fetchedAt) {
      summaryCache.delete(key);
    }
  }
  summaryCache.set(endpoint, { expiresAt: fetchedAt + SUMMARY_CACHE_TTL_MS, result });
  return result;
}

interface BuiltList {
  response: HttpResponse;
  list: CommandList;
  dropped: number;
}

function buildGetResponse(
  found: FoundApp,
  entries: readonly CommandEntry[],
  status: CommandSourceStatus,
  warnings: readonly CommandWarning[],
): BuiltList {
  const merged = mergeCommands(HANSE_COMMANDS, entries, {
    master: isMasterApp(found.project.id, found.app.appKey),
    opencodeStatus: status,
    warnings: normalizeWarnings(warnings),
  });
  const capped = capMergedResponse(merged);
  let commands = capped.commands;
  let finalWarnings = normalizeWarnings(capped.warnings);
  let body = { commands, sources: capped.sources, warnings: finalWarnings };

  // The fixed cap message can be a few bytes longer than the cap helper's placeholder, so re-check
  // the exact serialized body and keep the 1 MiB promise even at the boundary.
  while (Buffer.byteLength(JSON.stringify(body), "utf8") > MERGED_RESPONSE_MAX_BYTES) {
    const last = commands[commands.length - 1];
    if (last === undefined || last.source !== "opencode") {
      break;
    }
    commands = commands.slice(0, -1);
    finalWarnings = [
      ...finalWarnings
        .filter((warning) => warning.code !== "command_cap_reached")
        .slice(0, WARNINGS_MAX - 1),
      { code: "command_cap_reached", message: WARNING_MESSAGES.command_cap_reached },
    ];
    body = { commands, sources: capped.sources, warnings: finalWarnings };
  }

  return {
    response: json(200, body, { "cache-control": "no-store" }),
    list: { commands, sources: capped.sources, warnings: finalWarnings },
    dropped: merged.commands.length - commands.length,
  };
}

function normalizeWarnings(warnings: readonly CommandWarning[]): CommandWarning[] {
  return warnings.slice(0, WARNINGS_MAX).map((warning) => ({
    ...warning,
    message:
      warning.code === "command_shadowed"
        ? `/${warning.command ?? ""} is provided by the application.`
        : WARNING_MESSAGES[warning.code],
  }));
}

function reject(
  deps: HttpDeps,
  post: boolean,
  status: number,
  code: string,
  message: string,
  context: {
    appId?: string;
    sessionID?: string;
    name?: string;
    phase?: "validate" | "prevalidate" | "dispatch";
  } = {},
): HttpResponse {
  if (post) {
    deps.logger?.info("commands.send.rejected", { ...context, status, code });
  }
  return json(
    status,
    post ? { error: message, code, outcome: "not_sent" } : { error: message, code },
  );
}

function json(status: number, value: unknown, headers?: Record<string, string>): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    ...(headers === undefined ? {} : { headers }),
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function projectParam(request: HttpRequest): string | undefined {
  const project = request.query?.project?.trim();
  return project === undefined || project.length === 0 ? undefined : project;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return value.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function isCrossSite(request: HttpRequest): boolean {
  if (request.origin === undefined) {
    return false;
  }
  let originHost: string;
  try {
    originHost = new URL(request.origin).host;
  } catch {
    return true;
  }
  return request.host === undefined || originHost !== request.host;
}

function errorStatus(error: unknown): number | undefined {
  return error instanceof OpencodeHttpError ? error.status : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof OpencodeHttpError ? error.code : undefined;
}

type WindowResult<T> =
  | { kind: "settled"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "window" };

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<WindowResult<T>> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ kind: "window" });
      }
    }, ms);
    promise.then(
      (value) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ kind: "settled", value });
        }
      },
      (error: unknown) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ kind: "rejected", error });
        }
      },
    );
  });
}
