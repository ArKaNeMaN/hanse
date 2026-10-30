/**
 * Pure chat send/draft/abort helpers shared by the composer composable and its tests.
 *
 * The module owns endpoint construction, prompt delivery classification, and the legacy
 * intentional-abort predicate. It performs no store, DOM, timer, or storage mutation.
 */

import { ApiError, type ApiRequestOptions, apiMutation } from "../api.js";

export type SendDelivery = "idle" | "sending" | "accepted" | "queued" | "unknown" | "failed";

export type SendFailureKind = "auth" | "session_gone" | "unknown" | "failed";

export interface SendFailure {
  readonly kind: SendFailureKind;
  readonly message: string;
  readonly messageID: string | null;
  readonly asyncUnavailable: boolean;
}

export interface PromptTransportOptions extends ApiRequestOptions {}

export interface ChatUrlScope {
  readonly app: string;
  readonly project: string;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function chatApiBase(app: string): string {
  return `/api/apps/${encoded(app)}`;
}

export function withProject(path: string, project: string): string {
  return project.length === 0 ? path : `${path}?project=${encoded(project)}`;
}

export function sessionsUrl(scope: ChatUrlScope): string {
  return withProject(`${chatApiBase(scope.app)}/sessions`, scope.project);
}

export function draftUrl(scope: ChatUrlScope, sessionID: string): string {
  return withProject(
    `${chatApiBase(scope.app)}/sessions/${encoded(sessionID)}/draft`,
    scope.project,
  );
}

export function messagesUrl(scope: ChatUrlScope, sessionID: string, async: boolean): string {
  const base = withProject(
    `${chatApiBase(scope.app)}/sessions/${encoded(sessionID)}/messages`,
    scope.project,
  );
  return `${base}${base.includes("?") ? "&" : "?"}async=${async ? "1" : "0"}`;
}

export function abortUrl(scope: ChatUrlScope, sessionID: string): string {
  return withProject(
    `${chatApiBase(scope.app)}/sessions/${encoded(sessionID)}/abort`,
    scope.project,
  );
}

export function deleteIfEmptyUrl(scope: ChatUrlScope, sessionID: string): string {
  return withProject(
    `${chatApiBase(scope.app)}/sessions/${encoded(sessionID)}/delete-if-empty`,
    scope.project,
  );
}

export function pendingUrl(scope: ChatUrlScope, sessionID: string, pendingID: string): string {
  return withProject(
    `${chatApiBase(scope.app)}/sessions/${encoded(sessionID)}/pending/${encoded(pendingID)}`,
    scope.project,
  );
}

export function pendingRetryUrl(scope: ChatUrlScope, sessionID: string, pendingID: string): string {
  return withProject(
    `${chatApiBase(scope.app)}/sessions/${encoded(sessionID)}/pending/${encoded(pendingID)}/retry`,
    scope.project,
  );
}

export function attachmentsUrl(scope: ChatUrlScope, sessionID: string): string {
  const base = withProject(`${chatApiBase(scope.app)}/attachments`, scope.project);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}session=${encoded(sessionID)}`;
}

export function attachmentUrl(scope: ChatUrlScope, attachmentID: string): string {
  return withProject(
    `${chatApiBase(scope.app)}/attachments/${encoded(attachmentID)}`,
    scope.project,
  );
}

export function commandListUrl(scope: ChatUrlScope): string {
  return withProject(`${chatApiBase(scope.app)}/commands`, scope.project);
}

export function commandSendUrl(scope: ChatUrlScope, sessionID: string): string {
  return withProject(
    `${chatApiBase(scope.app)}/sessions/${encoded(sessionID)}/commands`,
    scope.project,
  );
}

export async function postPrompt(
  url: string,
  text: string,
  options: PromptTransportOptions = {},
  attachments?: readonly { readonly id: string; readonly mode?: "inline" | "file" }[],
): Promise<unknown> {
  const body =
    attachments === undefined || attachments.length === 0 ? { text } : { text, attachments };
  return apiMutation(url, { json: body }, options);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseAcceptedMessageID(payload: unknown): string | null {
  const body = record(payload);
  if (body === null) {
    return null;
  }
  for (const key of ["userMessageID", "messageID"]) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  const info = record(body.info);
  if (info !== null && typeof info.id === "string" && info.id.length > 0) {
    return info.id;
  }
  return null;
}

export function isAsyncUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 405 ||
      error.code === "async_unavailable" ||
      error.code === "async_unavailable_route")
  );
}

export function isSessionGone(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 410 || error.code === "session_not_found" || error.code === "session_gone")
  );
}

export function isAuthExpired(error: unknown): boolean {
  return (
    (error instanceof ApiError && (error.status === 401 || error.code === "unauthenticated")) ||
    (error instanceof Error && error.message === "sign in required")
  );
}

export function classifySendError(error: unknown): SendFailure {
  const messageID =
    error instanceof ApiError && record(error.payload) !== null
      ? parseAcceptedMessageID(error.payload)
      : null;
  if (isAuthExpired(error)) {
    return { kind: "auth", message: "sign in required", messageID, asyncUnavailable: false };
  }
  if (isSessionGone(error)) {
    return {
      kind: "session_gone",
      message: "This session no longer exists.",
      messageID,
      asyncUnavailable: false,
    };
  }
  const asyncUnavailable = isAsyncUnavailable(error);
  if (error instanceof ApiError) {
    const unknown =
      error.outcome === "unknown" ||
      (error.outcome === undefined && error.status >= 500 && error.status !== 505);
    return {
      kind: unknown ? "unknown" : "failed",
      message: sendFailureMessage(error),
      messageID,
      asyncUnavailable,
    };
  }
  if (error instanceof TypeError) {
    return { kind: "unknown", message: sendFailureMessage(error), messageID, asyncUnavailable };
  }
  return { kind: "failed", message: sendFailureMessage(error), messageID, asyncUnavailable };
}

export function sendFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "deletion_pending":
        return "This application is pending deletion.";
      case "agent_stopped":
      case "agent_not_running":
      case "agent_unavailable":
        return "The agent is not running.";
      case "session_not_found":
      case "session_gone":
        return "This session no longer exists.";
      case "empty_message":
        return "Write a message before sending.";
      case "message_too_large":
        return "This message is too large.";
      default:
        return error.message.trim().length > 0 ? error.message : "Could not send the message.";
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not send the message.";
}

const ABORT_NETWORK_MARKERS = [
  "unreachable",
  "upstream",
  "econn",
  "socket hang up",
  "network",
  "fetch failed",
  "timed out",
  "timeout",
  "gateway",
  "502",
  "503",
  "504",
];

const ABORT_MESSAGE_MARKERS = [
  "operation was aborted",
  "aborted by user",
  "interrupted by user",
  "cancelled by user",
  "canceled by user",
  "request was cancelled",
  "request was canceled",
  "aborterror",
];

export function isIntentionalAbortEvent(payload: {
  readonly name?: unknown;
  readonly message?: unknown;
}): boolean {
  if (payload.name === "MessageAbortedError") {
    return true;
  }
  if (typeof payload.message !== "string") {
    return false;
  }
  const message = payload.message.trim().toLowerCase();
  if (message.length === 0) {
    return false;
  }
  if (ABORT_NETWORK_MARKERS.some((marker) => message.includes(marker))) {
    return false;
  }
  return ABORT_MESSAGE_MARKERS.some((marker) => message.includes(marker));
}

export function localMessageID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local_${crypto.randomUUID()}`;
  }
  return `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function isPendingResolved(
  pending: { readonly messageID: string | null },
  hasMessage: (id: string) => boolean,
): boolean {
  return pending.messageID !== null && hasMessage(pending.messageID);
}
