import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { deleteSessionAgentMedia } from "../agent-media/store.js";
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
  appStateRoot,
  attachmentRelPath,
  attachmentsHostRoot,
  attachmentTempRelPath,
} from "../attachments/paths.js";
import {
  createEventAttachmentResolver,
  createMessageProjector,
  type MessageProjector,
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
import { appQuotaLocks, sessionLockKey, sessionLocks } from "../chat/locks.js";
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
import { deriveTurn, hasVisibleAssistant, type TurnSnapshot } from "../chat/turn.js";
import { projectHandoffMessages } from "../coordinator/handoff-messages.js";
import {
  abortSession,
  createSession,
  deleteSession,
  getSession,
  isDefaultTitle,
  lastAssistant,
  listMessagePage,
  listMessages,
  listSessionStatusesStrict,
  listSessions,
  listSessionsBounded,
  MESSAGES_EMPTY_CHECK_MAX_BYTES,
  OpencodeHttpError,
  type OpencodeMessage,
  type OpencodeSessionStatus,
  patchSessionTitle,
  sendPrompt,
  sendPromptAsync,
  TURN_TAIL_MAX_BYTES,
} from "../opencode/client.js";
import { authorizationFor } from "../opencode/endpoint-auth.js";
import { APP_STREAM_MAX_FRAME_BYTES, createRawEventStream } from "../opencode/events.js";
import { DEFAULT_MODEL, DeletionPendingError } from "../opencode/manager.js";
import { SESSION_NOTICE_MAX_PAGE, SessionNoticeStore } from "../opencode/recovery.js";
import { setBounded } from "../shared/bounded-cache.js";
import { agentMediaServiceFor } from "./agent-media.js";
import { type FoundApp, findApp, toManagedApp } from "./apps.js";
import { principalFrom } from "./auth.js";
import type { PageChrome, SiteModel } from "./dashboard.js";
import { registerSseDrain } from "./deploy.js";
import { lifecycleErrorResponse } from "./errors.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";
import { appShell, emptyState, pageHeader } from "./ui.js";

function json(status: number, value: unknown): HttpResponse {
  return { status, contentType: "application/json; charset=utf-8", body: JSON.stringify(value) };
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

function noticePageLimit(value: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(value)) return undefined;
  const limit = Number(value);
  return limit <= SESSION_NOTICE_MAX_PAGE ? limit : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function noticeCursor(value: string): string | undefined {
  if (value.length === 0 || value.length > 256) return undefined;
  if (hasControlCharacter(value)) return undefined;
  return value;
}

function projectParam(request: HttpRequest): string | undefined {
  const project = request.query?.project?.trim();
  return project === undefined || project.length === 0 ? undefined : project;
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

export function renderNoApps(site: SiteModel, chrome: PageChrome): string {
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
    contentScript: false,
  });
}

/**
 * Legacy per-session event stream.
 *
 * @deprecated The app-scoped `/events` route carries the chat feed. This route is kept for
 * compatibility but is non-starting: a stopped app returns `agent_stopped` and no stream.
 */
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
  if (found.app.deleting || found.project.deleting) {
    response.writeHead(409, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({ error: "application is pending deletion", code: "deletion_pending" }),
    );
    return;
  }
  const endpoint = deps.manager.endpointFor?.(found.app.id);
  if (endpoint === undefined) {
    response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "agent is stopped", code: "agent_stopped" }));
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
  const unregisterDrain = registerSseDrain(deps, response);
  response.once("close", unregisterDrain);
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

function newAttachmentId(): string {
  return `att_${randomUUID().replaceAll("-", "")}`;
}

/** Shared mutation Origin check: absent is allowed; `null`, malformed, or a host mismatch is not. */
export function crossSiteMutation(request: HttpRequest): boolean {
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

const START_PATH = /^\/api\/apps\/([^/]+)\/start$/;

/** Explicit start-route matcher so the server can dispatch it before the `/api/apps/` catch-all. */
export function isStartRoute(method: string, pathname: string): boolean {
  return method === "POST" && START_PATH.test(pathname);
}

/** Human-only, project-scoped cold start. A running app is reconnected, never restarted. */
export async function handleStart(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const match = START_PATH.exec(request.path);
  if (match === null) {
    return json(404, { error: "not found" });
  }
  const principal = principalFrom(deps, request);
  if (principal === undefined) {
    return json(401, { error: "sign in required" });
  }
  if (principal.kind !== "human") {
    return json(403, { error: "only a human principal may start an agent" });
  }
  if (request.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }
  if (crossSiteMutation(request)) {
    return json(403, { error: "cross-site request rejected", code: "cross_site_request" });
  }
  const found = findApp(deps, projectParam(request), safeDecode(match[1] ?? ""));
  if (found === undefined) {
    return json(404, {
      error: `unknown application: ${safeDecode(match[1] ?? "")}`,
      code: "unknown_app",
    });
  }
  if (found.app.deleting || found.project.deleting) {
    return json(409, {
      error: "application is pending deletion",
      code: "deletion_pending",
    });
  }
  const manager = deps.manager;
  if (manager === undefined) {
    return json(503, { error: "agent runtime is not configured", code: "agent_unavailable" });
  }
  try {
    await manager.ensure(toManagedApp(found), { origin: "operator" });
  } catch (error) {
    if (error instanceof DeletionPendingError) {
      return json(409, { error: error.message, code: error.code });
    }
    const mapped = lifecycleErrorResponse(error);
    if (mapped !== undefined) {
      return mapped;
    }
    return json(502, { error: "agent failed to start", code: "agent_unavailable" });
  }
  return json(200, { appId: found.app.id, state: "running" });
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
  if (deps.agentsHome !== undefined) {
    deleteSessionAgentMedia(
      deps.db,
      appStateRoot(deps.agentsHome, found.project.id, found.app.appKey),
      found.app.id,
      sessionId,
    );
  }
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
        maxBytes: MESSAGES_EMPTY_CHECK_MAX_BYTES,
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
      ...(agentMediaServiceFor(deps, found) === undefined
        ? {}
        : { agentMedia: agentMediaServiceFor(deps, found) }),
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
    endpoint = await manager.ensure(toManagedApp(found), {
      origin: "system",
      reason: "attachment",
    });
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
    const prepared = await appQuotaLocks.run(found.app.id, () => {
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
      const quota = await appQuotaLocks.run(found.app.id, () => {
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

function isTransportFailure(error: unknown): boolean {
  if (error instanceof OpencodeHttpError) return error.status === 0;
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

/** Raised by read paths when no agent endpoint is attached; reads never start an app. */
export class AgentStoppedError extends Error {
  readonly code = "agent_stopped";

  constructor() {
    super("agent is stopped");
    this.name = "AgentStoppedError";
  }
}

/** The single response shape for a read attempt against a stopped app. */
export function agentStoppedResponse(): HttpResponse {
  return json(503, { error: "agent is stopped", code: "agent_stopped" });
}

/** Map read-path failures that have a stable HTTP response; `undefined` means "keep throwing". */
function readFailureResponse(error: unknown): HttpResponse | undefined {
  if (error instanceof AgentStoppedError) return agentStoppedResponse();
  if (isTransportFailure(error)) {
    return json(502, { error: "agent is unavailable", code: "agent_unavailable" });
  }
  return undefined;
}

/**
 * Attach read-only chat calls to an already running agent. This never inspects the runtime and
 * never starts a stopped app: with no attached endpoint it raises `AgentStoppedError`.
 */
async function withReadEndpoint<T>(
  deps: HttpDeps,
  found: FoundApp,
  run: (endpoint: string) => Promise<T>,
): Promise<T> {
  const manager = deps.manager;
  if (manager === undefined) {
    throw new Error("agent runtime is not configured");
  }
  const endpoint = manager.endpointFor?.(found.app.id);
  if (endpoint === undefined) throw new AgentStoppedError();
  return run(endpoint);
}

async function readSessionsResponse(deps: HttpDeps, found: FoundApp): Promise<HttpResponse> {
  try {
    return await withReadEndpoint(deps, found, async (endpoint) => {
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
    });
  } catch (error) {
    const mapped = readFailureResponse(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }
}

async function readMessagesResponse(
  deps: HttpDeps,
  found: FoundApp,
  sessionId: string,
  limit: number | undefined,
  before: string | undefined,
): Promise<HttpResponse> {
  try {
    return await withReadEndpoint(deps, found, async (endpoint) => {
      const project = createMessageProjector({
        db: deps.db,
        appId: found.app.id,
        appKey: found.app.appKey,
        projectId: found.project.id,
        ...(agentMediaServiceFor(deps, found) === undefined
          ? {}
          : { agentMedia: agentMediaServiceFor(deps, found) }),
      });
      const projectHistory = (messages: Parameters<typeof project>[0]): void => {
        project(messages);
        projectHandoffMessages(deps.db, sessionId, messages);
      };
      if (limit === undefined) {
        const messages = await listMessages(endpoint, sessionId, { project: projectHistory });
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
          before === undefined
            ? { limit, project: projectHistory }
            : { limit, before, project: projectHistory },
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
    });
  } catch (error) {
    const mapped = readFailureResponse(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }
}

const TURN_CACHE_TTL_MS = 300;
const MAX_TURN_CACHE_ENTRIES = 512;
const TURN_PAGE_LIMIT = 50;
const TURN_PAGE_BUDGET = 3;

interface TurnCacheEntry {
  expiresAt: number;
  snapshot: TurnSnapshot;
}

interface TurnTail {
  messages: OpencodeMessage[];
  truncated: boolean;
}

const turnSnapshotCache = new Map<string, TurnCacheEntry>();
const turnSnapshotInflight = new Map<string, Promise<TurnSnapshot>>();
let turnSnapshotEpoch = 0;

function turnCacheKey(appId: string, sessionId: string, endpoint: string): string {
  return `${appId}\u0000${sessionId}\u0000${endpoint}`;
}

/** Test isolation for the process-wide turn cache; production invalidation is send-driven. */
export function resetTurnSnapshotCacheForTests(): void {
  turnSnapshotCache.clear();
  turnSnapshotInflight.clear();
  turnSnapshotEpoch += 1;
}

function invalidateTurnSnapshotCache(appId: string, sessionId: string): void {
  turnSnapshotEpoch += 1;
  const prefix = `${appId}\u0000${sessionId}\u0000`;
  for (const key of turnSnapshotCache.keys()) {
    if (key.startsWith(prefix)) turnSnapshotCache.delete(key);
  }
  for (const key of turnSnapshotInflight.keys()) {
    if (key.startsWith(prefix)) turnSnapshotInflight.delete(key);
  }
}

function statusPhase(status: OpencodeSessionStatus | undefined): string {
  if (status === undefined) return "idle";
  if (status.type === "idle" || status.type === "busy" || status.type === "retry") {
    return status.type;
  }
  return "unknown";
}

async function sessionIsSubagent(endpoint: string, sessionId: string): Promise<boolean> {
  try {
    const sessions = await listSessionsBounded(endpoint);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    const parentID = session?.parentID;
    return typeof parentID === "string" && parentID.trim().length > 0 && parentID !== sessionId;
  } catch {
    // Best effort: an unreadable session list leaves the session treated as top-level.
    return false;
  }
}

async function readTurnTail(
  endpoint: string,
  sessionId: string,
  project: MessageProjector,
): Promise<TurnTail> {
  let messages: OpencodeMessage[] = [];
  let before: string | undefined;
  for (let pageIndex = 0; pageIndex < TURN_PAGE_BUDGET; pageIndex += 1) {
    const page = await listMessagePage(endpoint, sessionId, {
      limit: TURN_PAGE_LIMIT,
      ...(before === undefined ? {} : { before }),
      maxBytes: TURN_TAIL_MAX_BYTES,
      project,
    });
    messages = [...page.messages, ...messages];
    if (hasVisibleAssistant(messages)) return { messages, truncated: false };
    if (page.nextCursor === undefined) return { messages, truncated: false };
    if (pageIndex === TURN_PAGE_BUDGET - 1) break;
    before = page.nextCursor;
  }
  return { messages, truncated: true };
}

async function computeTurnSnapshot(
  deps: HttpDeps,
  found: FoundApp,
  endpoint: string,
  sessionId: string,
): Promise<TurnSnapshot> {
  const project = createMessageProjector({
    db: deps.db,
    appId: found.app.id,
    appKey: found.app.appKey,
    projectId: found.project.id,
    ...(agentMediaServiceFor(deps, found) === undefined
      ? {}
      : { agentMedia: agentMediaServiceFor(deps, found) }),
  });
  const projectHistory = (messages: Parameters<typeof project>[0]): void => {
    project(messages);
    projectHandoffMessages(deps.db, sessionId, messages);
  };

  let tail: TurnTail = { messages: [], truncated: false };
  let status: OpencodeSessionStatus | undefined;
  let settling = false;
  for (let attempt = 0; ; attempt += 1) {
    const before = await listSessionStatusesStrict(endpoint);
    tail = await readTurnTail(endpoint, sessionId, projectHistory);
    const after = await listSessionStatusesStrict(endpoint);
    const changed = statusPhase(before[sessionId]) !== statusPhase(after[sessionId]);
    status = after[sessionId];
    if (!changed || attempt >= 1) {
      settling = changed && statusPhase(status) === "idle";
      break;
    }
  }

  const isSubagent = status === undefined && (await sessionIsSubagent(endpoint, sessionId));
  return {
    ...deriveTurn(tail.messages, status, {
      isSubagent,
      settling,
      queuedTruncated: tail.truncated,
    }),
    sessionID: sessionId,
  };
}

async function turnSnapshotFor(
  deps: HttpDeps,
  found: FoundApp,
  endpoint: string,
  sessionId: string,
): Promise<TurnSnapshot> {
  const key = turnCacheKey(found.app.id, sessionId, endpoint);
  const cached = turnSnapshotCache.get(key);
  if (cached !== undefined) {
    if (cached.expiresAt > Date.now()) return cached.snapshot;
    turnSnapshotCache.delete(key);
  }
  const inflight = turnSnapshotInflight.get(key);
  if (inflight !== undefined) return inflight;

  const epoch = turnSnapshotEpoch;
  const work = computeTurnSnapshot(deps, found, endpoint, sessionId);
  turnSnapshotInflight.set(key, work);
  try {
    const snapshot = await work;
    if (epoch === turnSnapshotEpoch) {
      for (const [k, v] of turnSnapshotCache) {
        if (v.expiresAt <= Date.now()) turnSnapshotCache.delete(k);
      }
      setBounded(
        turnSnapshotCache,
        key,
        { expiresAt: Date.now() + TURN_CACHE_TTL_MS, snapshot },
        MAX_TURN_CACHE_ENTRIES,
      );
    }
    return snapshot;
  } finally {
    if (turnSnapshotInflight.get(key) === work) turnSnapshotInflight.delete(key);
  }
}

async function readTurnResponse(
  deps: HttpDeps,
  found: FoundApp,
  sessionId: string,
): Promise<HttpResponse> {
  if (deps.manager === undefined) return agentStoppedResponse();
  try {
    return await withReadEndpoint(deps, found, async (endpoint) =>
      json(200, await turnSnapshotFor(deps, found, endpoint, sessionId)),
    );
  } catch (error) {
    if (error instanceof AgentStoppedError) return agentStoppedResponse();
    if (error instanceof OpencodeHttpError) {
      if (error.status === 404 || error.status === 410) {
        return json(404, { error: "session not found", code: "session_not_found" });
      }
      if (error.code === "messages_too_large") {
        return json(502, { error: "turn history is too large", code: "messages_too_large" });
      }
      if (error.code === "history_busy") {
        return json(503, { error: "history is busy; retry shortly", code: "history_busy" });
      }
    }
    return json(502, { error: "turn state is unavailable", code: "turn_unavailable" });
  }
}

export async function handleChat(deps: HttpDeps, request: HttpRequest): Promise<HttpResponse> {
  const projectId = projectParam(request);

  if (START_PATH.test(request.path)) {
    return handleStart(deps, request);
  }

  const sessionsMatch = /^\/api\/apps\/([^/]+)\/sessions$/.exec(request.path);
  const sessionMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)$/.exec(request.path);
  const messagesMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/messages$/.exec(request.path);
  const turnMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/turn$/.exec(request.path);
  const noticesMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/notices$/.exec(request.path);
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
    turnMatch === null &&
    noticesMatch === null &&
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
  if (noticesMatch !== null && principal.kind !== "human") {
    return json(403, { error: "only a human principal may read session notices" });
  }
  if (noticesMatch !== null && request.method !== "GET") {
    return json(405, { error: "method not allowed" });
  }
  if (turnMatch !== null && principal.kind !== "human") {
    return json(403, { error: "only a human principal may read the turn state" });
  }
  if (turnMatch !== null && request.method !== "GET") {
    return json(405, { error: "method not allowed" });
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
      turnMatch ??
      noticesMatch ??
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
      attachmentMatch !== null ||
      noticesMatch !== null;
    return newRoutes
      ? appNotFound(appKey)
      : json(404, { error: `unknown application: ${appKey}`, code: "unknown_app" });
  }
  const sessionId = safeDecode(
    (sessionMatch ??
      messagesMatch ??
      turnMatch ??
      noticesMatch ??
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
      noticesMatch !== null ||
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
  if (noticesMatch !== null) {
    if (found.app.deleting || found.project.deleting) {
      return json(409, { error: "application is pending deletion", code: "deletion_pending" });
    }
    let limit: number | undefined;
    if (request.query?.limit !== undefined) {
      limit = noticePageLimit(request.query.limit);
      if (limit === undefined) {
        return json(400, { error: "invalid limit", code: "invalid_limit" });
      }
    }
    let before: string | undefined;
    if (request.query?.before !== undefined) {
      before = noticeCursor(request.query.before.trim());
      if (before === undefined) {
        return json(400, { error: "invalid notice cursor", code: "invalid_cursor" });
      }
    }
    const page = new SessionNoticeStore(deps.db).list(found.app.id, sessionId, {
      ...(limit === undefined ? {} : { limit }),
      ...(before === undefined ? {} : { before }),
    });
    return json(200, page);
  }
  if (turnMatch !== null) {
    if (found.app.deleting || found.project.deleting) {
      return json(409, { error: "application is pending deletion", code: "deletion_pending" });
    }
    return readTurnResponse(deps, found, sessionId);
  }
  if (deps.manager === undefined) {
    return json(503, { error: "agent runtime is not configured" });
  }
  if (abortMatch !== null) {
    if (found.app.deleting || found.project.deleting) {
      return json(409, { error: "application is pending deletion", code: "deletion_pending" });
    }
    const endpoint = deps.manager.endpointFor?.(found.app.id);
    if (endpoint === undefined) {
      return json(503, { error: "agent is not running", code: "agent_not_running" });
    }
    try {
      deps.manager.recordOperatorAbort?.(found.app.id, sessionId);
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
  if (sessionsMatch !== null && request.method === "GET") {
    if (found.app.deleting || found.project.deleting) {
      return json(409, { error: "application is pending deletion", code: "deletion_pending" });
    }
    return readSessionsResponse(deps, found);
  }
  if (messagesMatch !== null && request.method === "GET") {
    if (found.app.deleting || found.project.deleting) {
      return json(409, { error: "application is pending deletion", code: "deletion_pending" });
    }
    return readMessagesResponse(deps, found, sessionId, limit, before);
  }
  let endpoint: string;
  try {
    endpoint = await deps.manager.ensure(toManagedApp(found), {
      origin: "system",
      reason: "chat",
    });
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
    if (sessionsMatch !== null && request.method === "POST") {
      return handleSessionCreate(deps, found, endpoint, request);
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
      const sent = await dispatchTextSend(
        deps,
        found,
        endpoint,
        sessionId,
        text,
        asyncSend,
        requested,
        streamID,
      );
      if (sent.status === 200 || sent.status === 202) {
        invalidateTurnSnapshotCache(found.app.id, sessionId);
      }
      return sent;
    }
  } catch (error) {
    if (error instanceof DeletionPendingError) {
      return json(409, { error: error.message, code: error.code });
    }
    const mapped = lifecycleErrorResponse(error);
    if (mapped !== undefined) {
      return mapped;
    }
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
