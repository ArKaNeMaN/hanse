/**
 * Notification router (Phase D): the completion predicate, debounce, channel/mode gate, watermark
 * and dedupe rules, completion enqueue, and the boot/reconnect catch-up entry point.
 *
 * Phase F public API:
 *   - `NotificationRouterDeps { db, manager, settings, now? }`
 *   - `new NotificationRouter(deps)`
 *   - `start()` / `stop()`
 *   - `handleAgentEvent(appId, event)` for `session.status` idle, prompt answers, and `stream.ready`
 *   - `handleNotificationSignal(signal)` (currently only `handoff_reply_delivered`)
 *   - `sweep()` after `handoffDispatcher.ready()` resolves
 *
 * Phase F attention rules are deliberately not implemented here. `handleNotificationSignal` has a
 * marked switch for the remaining signals, and `#handleNoticeCandidates` is the hook that enqueues
 * the candidates returned by `scanMissedNotices` before the notice scan marker advances.
 */
import path from "node:path";
import { defaultMessageProjector } from "../attachments/projection.js";
import { collectSessionSubtreeIDs } from "../chat/session-tree.js";
import { currentTurnPrompt, readTurnSnapshot } from "../chat/turn.js";
import { projectHandoffMessages } from "../coordinator/handoff-messages.js";
import {
  listPermissions,
  listPermissionsV2,
  listQuestions,
  listQuestionsV2,
  listSessionStatusesStrict,
  listSessionsBounded,
  type OpencodeSession,
} from "../opencode/client.js";
import type { SessionActivitySnapshot } from "../opencode/context.js";
import type {
  BoundedPermissionRequest,
  BoundedQuestionRequest,
  HanseEvent,
} from "../opencode/events.js";
import type { EffectiveValue, NotificationMode, SettingsTarget } from "../settings/types.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  decideWatermark,
  NOTIFICATION_META_KEYS,
  type NoticeCandidate,
  noticeReasonNotifies,
  readNotificationMetaState,
  scanMissedNotices,
  writeNoticeScanMarker,
} from "./catch-up.js";
import {
  type HandoffApprovalNotification,
  type HandoffFailedNotification,
  type HandoffWaitingOperatorNotification,
  type NotificationSignal,
  notificationEvents,
  type SshApprovalNotification,
  type ThreadMessageWaitingNotification,
} from "./events.js";
import {
  getNotificationWatermark,
  insertNotificationGroup,
  type NotificationChunkInput,
  type NotificationScope,
  writeNotificationMeta,
  writeNotificationWatermark,
} from "./outbox.js";
import {
  type FormatMessageInput,
  formatTelegramMessage,
  type NotificationBodyInput,
  type NotificationKind,
} from "./telegram/format.js";

export const NOTIFY_SETTLE_MS = 2_500;
export const NOTIFY_SWEEP_INTERVAL_MS = 60_000;
export const NOTIFY_UNBOUND_GRACE_MS = 60_000;
export const NOTIFY_DEFER_TTL_MS = 30 * 60 * 1000;
export const NOTIFY_MAX_SUBTREE_IDS = 500;
export const NOTIFY_OCCURRENCE_BUCKET_MS = 5 * 60 * 1000;

const SESSION_CACHE_MS = 10_000;

export interface NotificationEffectiveSettings {
  notifications: {
    mode: EffectiveValue<NotificationMode>;
    telegram: {
      enabled: EffectiveValue<boolean>;
      chatId: EffectiveValue<string>;
      apiBaseUrl: EffectiveValue<string>;
    };
    publicBaseUrl: EffectiveValue<string>;
    includeAnswer: EffectiveValue<boolean>;
  };
}

export interface NotificationSettingsSource {
  resolve(target: SettingsTarget): { effective: NotificationEffectiveSettings };
}

export interface NotificationManagerSource {
  endpointFor(appId: string): string | undefined;
  sessionActivity(appId: string, sessionId: string): Promise<SessionActivitySnapshot>;
}

export interface NotificationRouterDeps {
  db: SqliteDatabase;
  manager: NotificationManagerSource;
  settings: NotificationSettingsSource;
  now?: () => number;
}

interface AppRecord {
  id: string;
  projectId: string;
  appKey: string;
  path: string;
  projectName: string;
  projectRoot: string;
}

interface ChannelGate {
  enabled: boolean;
  mode: NotificationMode;
  completion: boolean;
  attention: boolean;
  firstSweepAt?: string;
  enabledAt?: string;
  publicBaseUrl: string | null;
  includeAnswer: boolean;
}

interface EvaluationContext {
  app: AppRecord;
  sessions: OpencodeSession[];
  gate: ChannelGate;
}

type EvaluationOutcome = "enqueued" | "skipped" | "deferred";

interface HandoffBindingRow {
  appId: string;
  sourceSessionId: string | null;
  invokingSessionId: string | null;
}

interface HandoffAttentionRow {
  id: string;
  projectId: string;
  projectName: string;
  summary: string;
  state: string;
  replyState: string;
  replyError: string | null;
  error: string | null;
  fromKey: string | null;
  toKey: string | null;
}

interface ThreadMessageAttentionRow {
  projectId: string;
  projectName: string;
  summary: string;
  fromKey: string | null;
  toKey: string | null;
  errorCode: string | null;
}

interface AttentionEnqueueInput {
  kind: NotificationKind;
  dedupeBase: string;
  scope: NotificationScope;
  projectId?: string | null;
  projectName: string;
  appKey?: string | null;
  appName?: string | null;
  appId?: string | null;
  sessionId?: string | null;
  gate: ChannelGate;
  body: Omit<NotificationBodyInput, "kind" | "projectName" | "appName" | "sessionTitle">;
}

function toolName(tool: Record<string, unknown> | undefined): string | null {
  const name = tool?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function isAbortError(event: { name?: string; message?: string }): boolean {
  if (event.name === "MessageAbortedError") return true;
  return event.message?.toLowerCase().includes("aborted") === true;
}

function sessionKey(appId: string, sessionId: string): string {
  return `${appId}\u0000${sessionId}`;
}

function validParentID(session: OpencodeSession): string | undefined {
  const parentID = session.parentID;
  if (typeof parentID !== "string") return undefined;
  const trimmed = parentID.trim();
  if (trimmed.length === 0 || trimmed === session.id) return undefined;
  return parentID;
}

function isTopLevel(session: OpencodeSession): boolean {
  return validParentID(session) === undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function readApp(db: SqliteDatabase, appId: string): AppRecord | undefined {
  const row = db
    .prepare(
      `SELECT a.id AS id, a.project_id AS projectId, a.app_key AS appKey, a.path AS path,
              p.name AS projectName, p.root_path AS projectRoot
         FROM apps a JOIN projects p ON p.id = a.project_id
        WHERE a.id = ?`,
    )
    .get(appId) as AppRecord | undefined;
  return row;
}

function appDirectory(app: AppRecord): string {
  return path.isAbsolute(app.path) ? app.path : path.resolve(app.projectRoot, app.path);
}

export function hasInflightOneShotHandoff(db: SqliteDatabase, subtreeJson: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM handoffs
        WHERE mode = 'one_shot'
          AND (
            source_session_id IN (SELECT value FROM json_each(:subtreeJson))
            OR (source_session_id IS NULL
                AND source_invoking_session_id IN (SELECT value FROM json_each(:subtreeJson)))
          )
          AND (
            state IN ('queued','awaiting_approval','dispatching','in_progress')
            OR (state = 'delivered' AND reply_state IN ('pending','awaiting_approval'))
          )
        LIMIT 1`,
    )
    .get({ subtreeJson });
  return row !== undefined;
}

export function hasOutstandingThreadWork(
  db: SqliteDatabase,
  subtreeJson: string,
  sessionId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present
         FROM handoffs h
         JOIN handoff_messages m ON m.handoff_id = h.id
        WHERE h.mode = 'thread'
          AND h.state IN ('queued','awaiting_approval','dispatching','in_progress')
          AND (
            h.source_session_id IN (SELECT value FROM json_each(:subtreeJson))
            OR (h.source_session_id IS NULL
                AND h.source_invoking_session_id IN (SELECT value FROM json_each(:subtreeJson)))
          )
          AND (
            (m.delivery_session_id = :sessionId AND m.state IN ('binding','queued','dispatching'))
            OR (
              m.author_side = 'source'
              AND m.kind IN ('request','message')
              AND m.state IN ('binding','queued','dispatching','waiting_operator')
            )
            OR (
              m.author_side = 'source'
              AND m.kind IN ('request','message')
              AND m.state = 'delivered'
              AND NOT EXISTS (
                SELECT 1 FROM handoff_messages r
                 WHERE r.handoff_id = m.handoff_id
                   AND r.kind = 'reply'
                   AND r.reply_to_message_id = m.id
                   AND r.state IN ('delivered','waiting_operator','cancelled')
              )
            )
          )
        LIMIT 1`,
    )
    .get({ subtreeJson, sessionId });
  return row !== undefined;
}

export function hasUnboundHandoffInGrace(
  db: SqliteDatabase,
  appId: string,
  nowMs: number,
  graceMs = NOTIFY_UNBOUND_GRACE_MS,
): boolean {
  const cutoff = new Date(nowMs - graceMs).toISOString();
  const row = db
    .prepare(
      `SELECT 1 AS present FROM handoffs
        WHERE (from_app_id = :appId OR to_app_id = :appId)
          AND source_session_id IS NULL
          AND source_invoking_session_id IS NULL
          AND state IN ('queued','awaiting_approval','dispatching','in_progress')
          AND created_at > :cutoff
        LIMIT 1`,
    )
    .get({ appId, cutoff });
  return row !== undefined;
}

export class NotificationRouter {
  readonly #db: SqliteDatabase;
  readonly #manager: NotificationManagerSource;
  readonly #settings: NotificationSettingsSource;
  readonly #now: () => number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #deferred = new Map<string, number>();
  readonly #checking = new Set<string>();
  readonly #sessionsCache = new Map<string, { at: number; sessions: OpencodeSession[] }>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => void) | null = null;
  #started = false;
  #stopped = false;

  constructor(deps: NotificationRouterDeps) {
    this.#db = deps.db;
    this.#manager = deps.manager;
    this.#settings = deps.settings;
    this.#now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#unsubscribe = notificationEvents.subscribe((signal) =>
      this.handleNotificationSignal(signal),
    );
    const timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, NOTIFY_SWEEP_INTERVAL_MS);
    timer.unref?.();
    this.#sweepTimer = timer;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#deferred.clear();
    this.#checking.clear();
    this.#sessionsCache.clear();
  }

  handleAgentEvent(appId: string, event: HanseEvent): void {
    if (this.#stopped) return;
    switch (event.type) {
      case "stream.ready":
        void this.#sweepApp(appId).catch(() => undefined);
        return;
      case "session.status":
        if (event.status.type === "idle") {
          void this.#rescheduleIdle(appId, event.sessionID).catch(() => undefined);
        }
        return;
      case "question.asked":
        this.#handleQuestionAsked(appId, event.request);
        return;
      case "permission.asked":
        this.#handlePermissionAsked(appId, event.request);
        return;
      case "question.replied":
      case "permission.replied":
        void this.#rescheduleIdle(appId, event.sessionID).catch(() => undefined);
        return;
      case "session.error":
        this.#handleSessionError(appId, event);
        return;
      default:
        return;
    }
  }

  handleNotificationSignal(signal: NotificationSignal): void {
    if (this.#stopped) return;
    switch (signal.type) {
      case "handoff_reply_delivered": {
        const row = this.#db
          .prepare(
            `SELECT from_app_id AS appId, source_session_id AS sourceSessionId,
                    source_invoking_session_id AS invokingSessionId
               FROM handoffs WHERE id = ?`,
          )
          .get(signal.handoffId) as HandoffBindingRow | undefined;
        if (row !== undefined) {
          const sessionId = row.sourceSessionId ?? row.invokingSessionId;
          if (sessionId !== null) {
            void this.#rescheduleIdle(row.appId, sessionId).catch(() => undefined);
          }
        }
        return;
      }
      case "ssh_approval":
        this.#handleSshApproval(signal);
        return;
      case "handoff_approval":
        this.#handleHandoffApproval(signal);
        return;
      case "handoff_waiting_operator":
        this.#handleHandoffWaiting(signal);
        return;
      case "handoff_failed":
        this.#handleHandoffFailed(signal);
        return;
      case "thread_message_waiting":
        this.#handleThreadMessageWaiting(signal);
        return;
    }
  }

  #handleSshApproval(signal: SshApprovalNotification): void {
    const app = readApp(this.#db, signal.appId);
    if (app === undefined) return;
    const gate = this.#readGate(app);
    if (!gate.attention) return;
    const row = this.#db
      .prepare(
        `SELECT a.action AS action, h.name AS hostName
           FROM ssh_approvals a LEFT JOIN ssh_hosts h ON h.id = a.host_id
          WHERE a.id = ?`,
      )
      .get(signal.approvalId) as { action: string; hostName: string | null } | undefined;
    this.#enqueueAttention({
      kind: "ssh_approval",
      dedupeBase: `ssh-approval:${signal.approvalId}`,
      scope: "app",
      projectId: app.projectId,
      projectName: app.projectName,
      appKey: app.appKey,
      appName: app.appKey,
      appId: app.id,
      gate,
      body: {
        host: row?.hostName ?? signal.hostId,
        action: row?.action ?? "approval",
        commandPreview: signal.commandPreview,
        expiresAt: signal.expiresAt,
      },
    });
  }

  #handleHandoffApproval(signal: HandoffApprovalNotification): void {
    const handoff = this.#readHandoff(signal.handoffId);
    if (handoff === undefined) return;
    const gate = this.#resolveGate({ projectId: handoff.projectId });
    this.#enqueueAttention({
      kind: "handoff_approval",
      dedupeBase: `handoff-approval:${signal.approvalId}`,
      scope: "project",
      projectId: handoff.projectId,
      projectName: handoff.projectName,
      gate,
      body: {
        source: handoff.fromKey,
        target: handoff.toKey,
        summary: handoff.summary,
      },
    });
  }

  #handleHandoffWaiting(signal: HandoffWaitingOperatorNotification): void {
    const handoff = this.#readHandoff(signal.handoffId);
    if (handoff === undefined) return;
    const gate = this.#resolveGate({ projectId: handoff.projectId });
    this.#enqueueAttention({
      kind: "handoff_waiting_operator",
      dedupeBase: `handoff-waiting:${signal.handoffId}:${signal.transitionAt}`,
      scope: "project",
      projectId: handoff.projectId,
      projectName: handoff.projectName,
      gate,
      body: {
        source: handoff.fromKey,
        target: handoff.toKey,
        summary: handoff.summary,
      },
    });
  }

  #handleHandoffFailed(signal: HandoffFailedNotification): void {
    const handoff = this.#readHandoff(signal.handoffId);
    if (handoff === undefined) return;
    const gate = this.#resolveGate({ projectId: handoff.projectId });
    const terminal = signal.scope === "terminal";
    const state = terminal ? (signal.state ?? handoff.state) : "reply";
    const reason = terminal ? (handoff.error ?? handoff.replyError) : handoff.replyError;
    this.#enqueueAttention({
      kind: "handoff_failed",
      dedupeBase: terminal
        ? `handoff-terminal:${signal.handoffId}:${state}:${signal.transitionAt}`
        : `handoff-failed:${signal.handoffId}:${signal.transitionAt}`,
      scope: "project",
      projectId: handoff.projectId,
      projectName: handoff.projectName,
      gate,
      body: {
        source: handoff.fromKey,
        target: handoff.toKey,
        summary: handoff.summary,
        state,
        reason,
      },
    });
  }

  #handleThreadMessageWaiting(signal: ThreadMessageWaitingNotification): void {
    const row = this.#db
      .prepare(
        `SELECT h.project_id AS projectId, p.name AS projectName, h.summary AS summary,
                f.app_key AS fromKey, t.app_key AS toKey, m.error_code AS errorCode
           FROM handoff_messages m
           JOIN handoffs h ON h.id = m.handoff_id
           JOIN projects p ON p.id = h.project_id
           LEFT JOIN apps f ON f.id = h.from_app_id
           LEFT JOIN apps t ON t.id = h.to_app_id
          WHERE m.id = ?`,
      )
      .get(signal.messageId) as ThreadMessageAttentionRow | undefined;
    if (row === undefined) return;
    const gate = this.#resolveGate({ projectId: row.projectId });
    this.#enqueueAttention({
      kind: "thread_message_waiting",
      dedupeBase: `thread-message-waiting:${signal.messageId}:${signal.transitionAt}`,
      scope: "project",
      projectId: row.projectId,
      projectName: row.projectName,
      gate,
      body: {
        source: row.fromKey,
        target: row.toKey,
        summary: row.summary,
        message: row.errorCode,
      },
    });
  }

  #handleQuestionAsked(appId: string, request: BoundedQuestionRequest): void {
    if (this.#isThreadTargetSession(request.sessionID)) return;
    const app = readApp(this.#db, appId);
    if (app === undefined) return;
    const gate = this.#readGate(app);
    if (!gate.attention) return;
    const first = request.questions[0];
    const question = first?.question ?? request.summary ?? "";
    this.#enqueueAttention({
      kind: "question",
      dedupeBase: `question:${appId}:${request.id}`,
      scope: "app",
      projectId: app.projectId,
      projectName: app.projectName,
      appKey: app.appKey,
      appName: app.appKey,
      appId: app.id,
      sessionId: request.sessionID,
      gate,
      body: {
        questionHeader: first?.header ?? null,
        question,
        options: first?.options.map((option) => option.label) ?? [],
      },
    });
  }

  #handlePermissionAsked(appId: string, request: BoundedPermissionRequest): void {
    const app = readApp(this.#db, appId);
    if (app === undefined) return;
    const gate = this.#readGate(app);
    if (!gate.attention) return;
    const command = request.metadata.command;
    this.#enqueueAttention({
      kind: "permission",
      dedupeBase: `permission:${request.id}`,
      scope: "app",
      projectId: app.projectId,
      projectName: app.projectName,
      appKey: app.appKey,
      appName: app.appKey,
      appId: app.id,
      sessionId: request.sessionID,
      gate,
      body: {
        permission: request.permission,
        tool: toolName(request.tool),
        patterns: request.patterns,
        command: typeof command === "string" ? command : null,
      },
    });
  }

  #handleSessionError(
    appId: string,
    event: { sessionID: string; name?: string; message: string },
  ): void {
    if (isAbortError(event)) return;
    const app = readApp(this.#db, appId);
    if (app === undefined) return;
    const gate = this.#readGate(app);
    if (!gate.attention) return;
    this.#enqueueAttention({
      kind: "agent_interrupted",
      dedupeBase: `agent-error:${event.sessionID}:${new Date(this.#now()).toISOString()}`,
      scope: "app",
      projectId: app.projectId,
      projectName: app.projectName,
      appKey: app.appKey,
      appName: app.appKey,
      appId: app.id,
      sessionId: event.sessionID,
      gate,
      body: { message: event.message },
    });
  }

  #isThreadTargetSession(sessionId: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 AS present FROM handoffs
          WHERE mode = 'thread' AND state = 'in_progress' AND target_session_id = ?
          LIMIT 1`,
      )
      .get(sessionId);
    return row !== undefined;
  }

  #readHandoff(handoffId: string): HandoffAttentionRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT h.id AS id, h.project_id AS projectId, p.name AS projectName, h.summary AS summary,
                h.state AS state, h.reply_state AS replyState, h.reply_error AS replyError,
                h.error AS error, f.app_key AS fromKey, t.app_key AS toKey
           FROM handoffs h
           JOIN projects p ON p.id = h.project_id
           LEFT JOIN apps f ON f.id = h.from_app_id
           LEFT JOIN apps t ON t.id = h.to_app_id
          WHERE h.id = ?`,
      )
      .get(handoffId) as HandoffAttentionRow | undefined;
    return row;
  }

  #enqueueAttention(input: AttentionEnqueueInput): void {
    if (!input.gate.attention) return;
    const formatted = formatTelegramMessage({
      ...input.body,
      kind: input.kind,
      projectName: input.projectName,
      appName: input.appName ?? null,
      publicBaseUrl: input.gate.publicBaseUrl,
      projectId: input.projectId ?? null,
      appKey: input.appKey ?? null,
      sessionId: input.sessionId ?? null,
    } satisfies FormatMessageInput);
    const now = new Date(this.#now()).toISOString();
    const chunks: NotificationChunkInput[] = formatted.chunks.map((chunk, index) => {
      const last = index === formatted.chunks.length - 1;
      const payload = {
        text: chunk.text,
        ...(last && formatted.link !== undefined ? { link: formatted.link } : {}),
      };
      return {
        chunkIndex: index,
        dedupeKey: `${input.dedupeBase}:${index}`,
        kind: input.kind,
        format: chunk.format,
        scope: input.scope,
        projectId: input.projectId ?? null,
        appKey: input.appKey ?? null,
        appId: input.appId ?? null,
        sessionId: input.sessionId ?? null,
        payloadJson: JSON.stringify(payload),
        nextAttemptAt: now,
      };
    });
    insertNotificationGroup(this.#db, { chunks, createdAt: now });
  }

  async sweep(): Promise<void> {
    if (this.#stopped) return;
    const apps = this.#db.prepare("SELECT id FROM apps ORDER BY id").all() as Array<{ id: string }>;
    for (const app of apps) {
      if (this.#stopped) return;
      try {
        await this.#sweepApp(app.id);
      } catch {
        // One app's unreadable state must not stop the other apps' catch-up.
      }
    }
  }

  async #sweepApp(appId: string): Promise<void> {
    if (this.#stopped) return;
    const app = readApp(this.#db, appId);
    if (app === undefined) return;
    const gate = this.#readGate(app);
    if (this.#manager.endpointFor(appId) !== undefined) {
      let sessions: OpencodeSession[] = [];
      try {
        sessions = await this.#listSessions(appId, true);
      } catch {
        sessions = [];
      }
      const now = this.#now();
      for (const session of sessions) {
        if (!isTopLevel(session)) continue;
        const key = sessionKey(appId, session.id);
        const deadline = this.#deferred.get(key);
        if (deadline !== undefined && deadline <= now) {
          this.#deferred.delete(key);
          continue;
        }
        await this.#runEvaluation(appId, session.id, { app, sessions, gate });
      }
    }
    await this.#scanNotices(gate);
  }

  async #rescheduleIdle(appId: string, sessionId: string): Promise<void> {
    if (this.#stopped) return;
    let root = sessionId;
    try {
      const sessions = await this.#listSessions(appId);
      root = this.#rootOf(sessions, sessionId) ?? sessionId;
    } catch {
      // An unreadable session list leaves the event's session as the scheduling target.
    }
    this.#schedule(appId, root);
  }

  #schedule(appId: string, sessionId: string, delay = NOTIFY_SETTLE_MS): void {
    if (this.#stopped) return;
    const key = sessionKey(appId, sessionId);
    const existing = this.#timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      void this.#runEvaluation(appId, sessionId).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  async #runEvaluation(
    appId: string,
    sessionId: string,
    context?: EvaluationContext,
  ): Promise<EvaluationOutcome> {
    if (this.#stopped) return "skipped";
    const key = sessionKey(appId, sessionId);
    if (this.#checking.has(key)) return "skipped";
    this.#checking.add(key);
    try {
      const outcome = await this.#evaluate(appId, sessionId, context);
      if (outcome === "deferred") this.#markDeferred(key);
      else this.#deferred.delete(key);
      return outcome;
    } catch {
      this.#markDeferred(key);
      return "deferred";
    } finally {
      this.#checking.delete(key);
    }
  }

  #markDeferred(key: string): void {
    if (this.#deferred.has(key)) return;
    this.#deferred.set(key, this.#now() + NOTIFY_DEFER_TTL_MS);
  }

  async #evaluate(
    appId: string,
    sessionId: string,
    context?: EvaluationContext,
  ): Promise<EvaluationOutcome> {
    const app = context?.app ?? readApp(this.#db, appId);
    if (app === undefined) return "skipped";
    const endpoint = this.#manager.endpointFor(appId);
    if (endpoint === undefined) return "skipped";
    const gate = context?.gate ?? this.#readGate(app);

    const sessions = context?.sessions ?? (await this.#listSessions(appId));
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) return "skipped";
    if (!isTopLevel(session)) return "skipped";

    const statuses = await listSessionStatusesStrict(endpoint);
    const status = statuses[sessionId];
    if (status !== undefined && status.type !== "idle") return "skipped";

    const activity = await this.#manager.sessionActivity(appId, sessionId);
    if (!activity.known || activity.activeChildren || activity.pendingTask) return "deferred";

    const subtree = collectSessionSubtreeIDs(sessions, sessionId);
    if (subtree.length === 0 || subtree.length > NOTIFY_MAX_SUBTREE_IDS) return "deferred";
    const subtreeSet = new Set(subtree);
    const subtreeJson = JSON.stringify(subtree);

    const projector = (messages: Parameters<typeof defaultMessageProjector>[0]): void => {
      defaultMessageProjector(messages);
      projectHandoffMessages(this.#db, sessionId, messages);
    };
    const read = await readTurnSnapshot(endpoint, sessionId, {
      isSubagent: false,
      projector,
    });
    const snapshot = read.snapshot;
    if (snapshot.status.type !== "idle") return "skipped";
    if (snapshot.settling || snapshot.queuedTruncated) return "deferred";
    if (snapshot.activePromptID !== null || snapshot.queuedPromptIDs.length > 0) {
      return "deferred";
    }

    const pendingPrompt = await this.#pendingPromptInSubtree(
      endpoint,
      appDirectory(app),
      subtreeSet,
    );
    if (pendingPrompt === undefined || pendingPrompt) return "deferred";
    if (hasInflightOneShotHandoff(this.#db, subtreeJson)) return "deferred";
    if (hasOutstandingThreadWork(this.#db, subtreeJson, sessionId)) return "deferred";
    if (hasUnboundHandoffInGrace(this.#db, appId, this.#now())) return "deferred";

    const prompt = currentTurnPrompt(read.messages);
    const occurrenceId =
      read.answerMessageId ??
      this.#occurrenceId(prompt, session.time?.updated, session.time?.created);
    if (occurrenceId === null) return "skipped";

    const watermark = getNotificationWatermark(this.#db, appId, sessionId);
    const base = `turn:${appId}:${sessionId}:${occurrenceId}`;
    const action = decideWatermark({
      watermark: watermark === undefined ? undefined : watermark.lastNotifiedMessageId,
      currentId: occurrenceId,
      ...(session.time?.created === undefined ? {} : { sessionCreatedAt: session.time.created }),
      ...(gate.firstSweepAt === undefined ? {} : { firstSweepAt: gate.firstSweepAt }),
    });

    if (action === "skip") return "skipped";

    if (action === "initialize" || !gate.completion) {
      this.#writeWatermark(appId, sessionId, occurrenceId);
      return "skipped";
    }

    if (this.#hasOutboxBase(base)) {
      this.#writeWatermark(appId, sessionId, occurrenceId);
      return "skipped";
    }

    this.#enqueueCompletion(app, session, read.answerText, gate, base);
    this.#writeWatermark(appId, sessionId, occurrenceId);
    return "enqueued";
  }

  #occurrenceId(
    prompt: { id: string; createdAt?: number } | undefined,
    updatedAt: number | undefined,
    createdAt: number | undefined,
  ): string | null {
    if (prompt === undefined) return null;
    const anchor = prompt.createdAt ?? updatedAt ?? createdAt ?? this.#now();
    const bucket = Math.floor(anchor / NOTIFY_OCCURRENCE_BUCKET_MS);
    return `${prompt.id}:${bucket}`;
  }

  #writeWatermark(appId: string, sessionId: string, occurrenceId: string): void {
    writeNotificationWatermark(
      this.#db,
      appId,
      sessionId,
      occurrenceId,
      new Date(this.#now()).toISOString(),
    );
  }

  #hasOutboxBase(base: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 AS present FROM notification_outbox
          WHERE dedupe_key = ? OR dedupe_key LIKE ? ESCAPE '\\'
          LIMIT 1`,
      )
      .get(base, `${escapeLike(base)}:%`);
    return row !== undefined;
  }

  #enqueueCompletion(
    app: AppRecord,
    session: OpencodeSession,
    answerText: string,
    gate: ChannelGate,
    base: string,
  ): void {
    const formatted = formatTelegramMessage({
      kind: "turn_completed",
      projectName: app.projectName,
      appName: app.appKey,
      sessionTitle: session.title ?? null,
      answer: answerText,
      includeAnswer: gate.includeAnswer,
      publicBaseUrl: gate.publicBaseUrl,
      projectId: app.projectId,
      appKey: app.appKey,
      sessionId: session.id,
    });
    const now = new Date(this.#now()).toISOString();
    const chunks: NotificationChunkInput[] = formatted.chunks.map((chunk, index) => {
      const last = index === formatted.chunks.length - 1;
      const payload = {
        text: chunk.text,
        ...(last && formatted.link !== undefined ? { link: formatted.link } : {}),
        ...(gate.includeAnswer && answerText.trim().length > 0 ? { answer: true } : {}),
      };
      return {
        chunkIndex: index,
        dedupeKey: `${base}:${index}`,
        kind: "turn_completed",
        format: chunk.format,
        scope: "app",
        projectId: app.projectId,
        appKey: app.appKey,
        appId: app.id,
        sessionId: session.id,
        payloadJson: JSON.stringify(payload),
        nextAttemptAt: now,
      };
    });
    insertNotificationGroup(this.#db, { chunks, createdAt: now });
  }

  async #pendingPromptInSubtree(
    endpoint: string,
    appDir: string,
    subtree: ReadonlySet<string>,
  ): Promise<boolean | undefined> {
    const results = await Promise.allSettled([
      listQuestions(endpoint),
      listPermissions(endpoint),
      listQuestionsV2(endpoint, appDir),
      listPermissionsV2(endpoint, appDir),
    ]);
    for (const result of results) {
      if (result.status === "rejected") return undefined;
      const requests: unknown = result.value;
      if (!Array.isArray(requests)) continue;
      for (const request of requests) {
        if (typeof request !== "object" || request === null) continue;
        const sessionID = (request as { sessionID?: unknown }).sessionID;
        if (typeof sessionID === "string" && subtree.has(sessionID)) return true;
      }
    }
    return false;
  }

  #readGate(app: AppRecord): ChannelGate {
    return this.#resolveGate({ projectId: app.projectId, appKey: app.appKey });
  }

  #resolveGate(target: SettingsTarget): ChannelGate {
    const resolved = this.#settings.resolve(target);
    const notifications = resolved.effective.notifications;
    const enabled = notifications.telegram.enabled.value === true;
    const mode = notifications.mode.value ?? "all";
    const nowIso = new Date(this.#now()).toISOString();
    const meta = readNotificationMetaState(this.#db);

    let firstSweepAt = meta.firstSweepAt;
    let enabledAt = meta.enabledAt;
    if (enabled && meta.channelEnabled !== true) {
      enabledAt = nowIso;
      writeNotificationMeta(this.#db, NOTIFICATION_META_KEYS.enabledAt, nowIso, nowIso);
    }
    if (meta.channelEnabled !== enabled) {
      writeNotificationMeta(
        this.#db,
        NOTIFICATION_META_KEYS.channelEnabled,
        enabled ? "true" : "false",
        nowIso,
      );
    }
    if (enabled && firstSweepAt === undefined) {
      firstSweepAt = nowIso;
      writeNotificationMeta(this.#db, NOTIFICATION_META_KEYS.firstSweepAt, nowIso, nowIso);
    }
    if (enabled && meta.noticeScanAt === undefined && meta.enabledAt === undefined) {
      writeNoticeScanMarker(this.#db, nowIso, nowIso);
    }
    if (!enabled) {
      writeNoticeScanMarker(this.#db, nowIso, nowIso);
    }

    return {
      enabled,
      mode,
      completion: enabled && mode === "all",
      attention: enabled && mode !== "off",
      ...(firstSweepAt === undefined ? {} : { firstSweepAt }),
      ...(enabledAt === undefined ? {} : { enabledAt }),
      publicBaseUrl: notifications.publicBaseUrl.value,
      includeAnswer: notifications.includeAnswer.value !== false,
    };
  }

  async #scanNotices(gate: ChannelGate): Promise<NoticeCandidate[]> {
    const nowIso = new Date(this.#now()).toISOString();
    if (!gate.enabled) {
      writeNoticeScanMarker(this.#db, nowIso, nowIso);
      return [];
    }
    const meta = readNotificationMetaState(this.#db);
    const result = scanMissedNotices(this.#db, {
      now: this.#now(),
      ...(meta.noticeScanAt === undefined ? {} : { noticeScanAt: meta.noticeScanAt }),
      ...(meta.enabledAt === undefined ? {} : { enabledAt: meta.enabledAt }),
    });
    this.#handleNoticeCandidates(result.candidates);
    if (result.latestCreatedAt !== null) {
      writeNoticeScanMarker(this.#db, result.latestCreatedAt, nowIso);
    }
    return result.candidates;
  }

  #handleNoticeCandidates(candidates: NoticeCandidate[]): void {
    for (const candidate of candidates) this.#enqueueNotice(candidate);
  }

  #enqueueNotice(candidate: NoticeCandidate): void {
    if (!noticeReasonNotifies(candidate.kind, candidate.reason)) return;
    const app = readApp(this.#db, candidate.appId);
    if (app === undefined) return;
    const gate = this.#readGate(app);
    if (!gate.attention) return;
    const message = candidate.payload.message;
    this.#enqueueAttention({
      kind: "agent_interrupted",
      dedupeBase: candidate.dedupeKey,
      scope: "app",
      projectId: app.projectId,
      projectName: app.projectName,
      appKey: app.appKey,
      appName: app.appKey,
      appId: app.id,
      sessionId: candidate.sessionId,
      gate,
      body: {
        message: typeof message === "string" ? message : (candidate.reason ?? null),
      },
    });
  }

  async #listSessions(appId: string, fresh = false): Promise<OpencodeSession[]> {
    const now = this.#now();
    const cached = this.#sessionsCache.get(appId);
    if (!fresh && cached !== undefined && now - cached.at < SESSION_CACHE_MS) {
      return cached.sessions;
    }
    const endpoint = this.#manager.endpointFor(appId);
    if (endpoint === undefined) return [];
    const sessions = await listSessionsBounded(endpoint);
    this.#sessionsCache.set(appId, { at: now, sessions });
    return sessions;
  }

  #rootOf(sessions: OpencodeSession[], sessionId: string): string | undefined {
    const byId = new Map<string, OpencodeSession>();
    for (const session of sessions) byId.set(session.id, session);
    let current = sessionId;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return current;
      seen.add(current);
      const session = byId.get(current);
      if (session === undefined) return current;
      const parentID = validParentID(session);
      if (parentID === undefined || !byId.has(parentID)) return current;
      current = parentID;
    }
  }
}
