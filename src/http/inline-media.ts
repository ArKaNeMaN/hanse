import type { IncomingMessage, ServerResponse } from "node:http";
import { historyReadBudget } from "../attachments/budget.js";
import { INLINE_MAX_BYTES } from "../attachments/inline.js";
import {
  decodeInlineDataUrl,
  INLINE_READ_BUDGET_WAIT_MS,
  parseInlineDataUrl,
} from "../attachments/inline-media.js";
import { isInlineSafeMime, sniffMime } from "../attachments/mime.js";
import { encodeContentDisposition, safeOriginalName } from "../attachments/names.js";
import { readDeliveryByPartId } from "../attachments/store.js";
import {
  getMessage,
  MESSAGES_HISTORY_MAX_BYTES,
  MESSAGES_RESPONSE_TIMEOUT_MS,
  OpencodeHttpError,
} from "../opencode/client.js";
import { findApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import type { HttpDeps, HttpRequest } from "./handler.js";

const ROUTE =
  /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/messages\/([^/]+)\/parts\/([^/]+)\/inline$/;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(headers ?? {}),
  });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  json(response, 404, { error: "inline media not found", code: "inline_media_not_found" });
}

function projectParam(request: HttpRequest): string | undefined {
  const value = request.query?.project;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findPart(parts: unknown, partId: string): Record<string, unknown> | undefined {
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (part !== null && typeof part === "object" && !Array.isArray(part)) {
      const record = part as Record<string, unknown>;
      if (record.id === partId) return record;
    }
  }
  return undefined;
}

interface Failure {
  status: number;
  code: string;
  message: string;
}

/** Map a message-read failure without ever exposing the upstream body. */
function messageReadFailure(error: unknown): Failure {
  if (error instanceof OpencodeHttpError) {
    if (error.code === "messages_too_large") {
      return {
        status: 413,
        code: "inline_media_too_large",
        message: "inline media message exceeds the read cap",
      };
    }
    if (error.status === 404 || error.status === 410) {
      return {
        status: 404,
        code: "inline_media_not_found",
        message: "inline media not found",
      };
    }
  }
  return { status: 502, code: "agent_unavailable", message: "agent is unavailable" };
}

/**
 * Human-only, read-only delivery of one inline image part. The bytes come from the persisted
 * opencode message, never from a filesystem path in the request; no state is written.
 */
export async function handleInlineMediaDownload(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const match = ROUTE.exec(url.pathname);
  if (match === null) {
    json(response, 404, { error: "not found" });
    return;
  }
  const httpRequest: HttpRequest = {
    method: request.method ?? "GET",
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: {
      authorization: headerValue(request.headers.authorization),
      cookie: headerValue(request.headers.cookie),
    },
    host: headerValue(request.headers.host),
  };
  const project = projectParam(httpRequest);
  if (project === undefined) {
    json(response, 400, { error: "project is required", code: "project_required" });
    return;
  }
  const principal = principalFrom(deps, httpRequest);
  if (principal === undefined) {
    json(response, 401, { error: "sign in required", code: "sign_in_required" });
    return;
  }
  if (principal.kind !== "human") {
    json(response, 403, {
      error: "only a human principal may read inline media",
      code: "human_only",
    });
    return;
  }
  const found = findApp(deps, project, decode(match[1] ?? ""));
  if (found === undefined) {
    notFound(response);
    return;
  }
  if (found.app.deleting === true || found.project.deleting === true) {
    json(response, 409, {
      error: "application is pending deletion",
      code: "deletion_pending",
    });
    return;
  }
  const endpoint = deps.manager?.endpointFor?.(found.app.id);
  if (endpoint === undefined) {
    json(response, 503, { error: "agent is stopped", code: "agent_stopped" });
    return;
  }
  const sessionID = decode(match[2] ?? "");
  const messageID = decode(match[3] ?? "");
  const partID = decode(match[4] ?? "");
  if (readDeliveryByPartId(deps.db, found.app.id, partID) !== undefined) {
    notFound(response);
    return;
  }
  const release = await historyReadBudget.acquire(
    MESSAGES_HISTORY_MAX_BYTES * 4,
    INLINE_READ_BUDGET_WAIT_MS,
  );
  if (release === undefined) {
    json(
      response,
      503,
      { error: "inline media is busy", code: "inline_busy" },
      { "retry-after": "1" },
    );
    return;
  }
  try {
    let message: Awaited<ReturnType<typeof getMessage>>;
    try {
      message = await getMessage(endpoint, sessionID, messageID, {
        maxBytes: MESSAGES_HISTORY_MAX_BYTES,
        timeoutMs: MESSAGES_RESPONSE_TIMEOUT_MS,
        overflowCode: "messages_too_large",
      });
    } catch (error) {
      const failure = messageReadFailure(error);
      json(response, failure.status, { error: failure.message, code: failure.code });
      return;
    }
    const part = findPart(message.parts, partID);
    if (part === undefined || part.type !== "file") {
      notFound(response);
      return;
    }
    if (
      (part.sessionID !== undefined && part.sessionID !== sessionID) ||
      (part.messageID !== undefined && part.messageID !== messageID)
    ) {
      notFound(response);
      return;
    }
    const parsed = parseInlineDataUrl(part.url);
    if (parsed === null) {
      notFound(response);
      return;
    }
    if (parsed.size > INLINE_MAX_BYTES) {
      json(response, 413, {
        error: "inline media is too large",
        code: "inline_media_too_large",
      });
      return;
    }
    const filename =
      safeOriginalName(typeof part.filename === "string" ? part.filename : "") || "image";
    const isHead = request.method === "HEAD";
    const bytes = isHead ? decodeInlineDataUrl(parsed, 512) : decodeInlineDataUrl(parsed);
    const sniffed = sniffMime(bytes.subarray(0, 512), filename);
    if (!isInlineSafeMime(sniffed.mime) || sniffed.kind !== "image") {
      json(response, 415, {
        error: "inline media type is not supported",
        code: "inline_media_unsupported",
      });
      return;
    }
    response.writeHead(200, {
      "content-type": sniffed.mime,
      "content-length": String(isHead ? parsed.size : bytes.length),
      "content-disposition": encodeContentDisposition("inline", filename),
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=3600",
    });
    if (isHead) response.end();
    else response.end(bytes);
  } finally {
    release();
  }
}
