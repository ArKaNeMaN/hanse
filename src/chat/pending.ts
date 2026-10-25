import { failDeliveriesForMessage, markDeliveriesUnknownForMessage } from "../attachments/store.js";
import {
  getMessage,
  getSession,
  OpencodeHttpError,
  type OpencodeMessage,
  type OpencodeSession,
} from "../opencode/client.js";
import { authorizationFor } from "../opencode/endpoint-auth.js";
import {
  APP_STREAM_MAX_FRAME_BYTES,
  createEventStream,
  type HanseEvent,
} from "../opencode/events.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  confirmPendingByMessage,
  deleteSessionChatRows,
  markSessionHasMessages,
  nowIso,
  type PendingSendRow,
  readPendingByMessage,
  readPendingForApp,
  readPendingSends,
  removeSessionFolder,
  sessionFolder,
  setPendingState,
} from "./state.js";

export type MonitorState = "disabled" | "connecting" | "connected";
export type ConfirmOutcome = "found" | "absent" | "unknown" | "pending";

/** Bounded backoff read schedule from design §D6.5 (not a polling loop). */
export const PENDING_BACKOFF_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000] as const;
export const PENDING_ROUTE_DEADLINE_MS = 4_000;
export const PENDING_CONFIRMATION_STALE_MS = 15 * 60 * 1000;
const MESSAGE_READ_TIMEOUT_MS = 5_000;
const SESSION_READ_TIMEOUT_MS = 5_000;

export interface PendingRecoveryOptions {
  db: SqliteDatabase;
  endpointFor: (appId: string) => string | undefined;
  monitorState?: (appId: string) => MonitorState;
  agentsHome?: string;
  backoffMs?: readonly number[];
  routeDeadlineMs?: number;
  now?: () => string;
  readMessage?: (
    endpoint: string,
    sessionId: string,
    messageID: string,
  ) => Promise<OpencodeMessage>;
  readSession?: (endpoint: string, sessionId: string) => Promise<OpencodeSession>;
}

interface FallbackSubscription {
  controller: AbortController;
  stream: { close(): void } | undefined;
}

/**
 * Confirmation and recovery for text-only pending sends.
 *
 * The service is event-first: the manager forwards every projected app event here. When the context
 * monitor is unavailable it opens one shared fallback `/event` subscription per app, and a bounded
 * `GET /message/{id}` schedule resolves rows that never produced an event. It never resends a
 * prompt automatically.
 */
export class PendingRecovery {
  readonly #db: SqliteDatabase;
  readonly #endpointFor: (appId: string) => string | undefined;
  readonly #monitorState: (appId: string) => MonitorState;
  readonly #agentsHome: string | undefined;
  readonly #backoffMs: readonly number[];
  readonly #routeDeadlineMs: number;
  readonly #now: () => string;
  readonly #readMessage: NonNullable<PendingRecoveryOptions["readMessage"]>;
  readonly #readSession: NonNullable<PendingRecoveryOptions["readSession"]>;
  readonly #scheduled = new Set<string>();
  readonly #subscriptions = new Map<string, FallbackSubscription>();
  readonly #sleepers = new Set<ReturnType<typeof setTimeout>>();
  #disposed = false;

  constructor(options: PendingRecoveryOptions) {
    this.#db = options.db;
    this.#endpointFor = options.endpointFor;
    this.#monitorState = options.monitorState ?? (() => "disabled");
    this.#agentsHome = options.agentsHome;
    this.#backoffMs = options.backoffMs ?? PENDING_BACKOFF_MS;
    this.#routeDeadlineMs = options.routeDeadlineMs ?? PENDING_ROUTE_DEADLINE_MS;
    this.#now = options.now ?? nowIso;
    this.#readMessage =
      options.readMessage ??
      ((endpoint, sessionId, messageID) =>
        getMessage(endpoint, sessionId, messageID, {
          maxBytes: 8 * 1024 * 1024,
          timeoutMs: MESSAGE_READ_TIMEOUT_MS,
        }));
    this.#readSession =
      options.readSession ??
      ((endpoint, sessionId) =>
        getSession(endpoint, sessionId, { timeoutMs: SESSION_READ_TIMEOUT_MS }));
  }

  /** Startup transition: a `sending` row older than the grace was abandoned by its process. */
  transitionStaleSending(olderThanMs: number): number {
    const cutoff = new Date(Date.parse(this.#now()) - olderThanMs).toISOString();
    const result = this.#db
      .prepare(
        `UPDATE pending_sends
            SET state = 'unknown', error_code = 'confirmation_stale', updated_at = ?
          WHERE state = 'sending' AND updated_at < ?`,
      )
      .run(this.#now(), cutoff);
    return result.changes;
  }

  /** Arm every unresolved row for one app; safe to call repeatedly (idempotent per message id). */
  arm(appId: string): void {
    if (this.#disposed) return;
    for (const row of readPendingForApp(this.#db, appId)) {
      if (row.state !== "failed") this.#schedule(appId, row);
    }
  }

  /**
   * Open the shared fallback subscription before a dispatch when the monitor is not connected.
   * The fetch response is awaited so the subscription is attached before the prompt leaves.
   */
  async ensureFallback(appId: string): Promise<void> {
    if (this.#disposed || this.#monitorState(appId) === "connected") return;
    if (this.#subscriptions.has(appId)) return;
    const endpoint = this.#endpointFor(appId);
    if (endpoint === undefined) return;
    const controller = new AbortController();
    const record: FallbackSubscription = { controller, stream: undefined };
    this.#subscriptions.set(appId, record);
    try {
      const response = await fetch(`${endpoint}/event`, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          ...(authorizationFor(endpoint) === undefined
            ? {}
            : { authorization: authorizationFor(endpoint) }),
        },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        if (this.#subscriptions.get(appId) === record) this.#subscriptions.delete(appId);
        return;
      }
      const stream = createEventStream(response.body, {
        maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES,
        signal: controller.signal,
      });
      record.stream = stream;
      void this.#consume(appId, record, stream);
    } catch {
      if (this.#subscriptions.get(appId) === record) this.#subscriptions.delete(appId);
    }
  }

  /** Route a projected event into the pending state machine (no-op when nothing matches). */
  observe(appId: string, event: HanseEvent): void {
    if (this.#disposed) return;
    if (event.type === "message.updated" && event.role === "user") {
      this.#onUserMessage(appId, event.sessionID, event.messageID);
      return;
    }
    if (event.type === "session.error" && event.name !== "MessageAbortedError") {
      this.#onSessionError(appId, event.sessionID);
    }
  }

  /**
   * Bounded recheck for the retry/Dismiss routes. Returns `pending` when the short request deadline
   * elapsed; the schedule continues in the background and still resolves the row.
   */
  async recheck(
    appId: string,
    row: PendingSendRow,
    options: { deadlineMs?: number } = {},
  ): Promise<ConfirmOutcome> {
    const endpoint = this.#endpointFor(appId);
    if (endpoint === undefined) return "unknown";
    const deadlineMs = options.deadlineMs ?? this.#routeDeadlineMs;
    return this.#probe(appId, endpoint, row, Date.now() + deadlineMs);
  }

  /** Definite upstream session absence, used before a retry dispatch or a dismiss cleanup. */
  async sessionMissing(appId: string, sessionId: string): Promise<boolean> {
    return this.#sessionGone(appId, sessionId);
  }

  /** One confirming read used by a `failed` retry/dismiss (no backoff schedule). */
  async recheckOnce(appId: string, row: PendingSendRow): Promise<ConfirmOutcome> {
    const endpoint = this.#endpointFor(appId);
    if (endpoint === undefined) return "unknown";
    const outcome = await this.#readOnce(endpoint, row);
    if (outcome !== "pending") this.#applyOutcome(appId, row, outcome);
    return outcome;
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#sleepers) clearTimeout(timer);
    this.#sleepers.clear();
    for (const record of this.#subscriptions.values()) {
      record.stream?.close();
      record.controller.abort();
    }
    this.#subscriptions.clear();
    this.#scheduled.clear();
  }

  async #consume(
    appId: string,
    record: FallbackSubscription,
    stream: ReturnType<typeof createEventStream>,
  ): Promise<void> {
    try {
      for await (const event of stream.events) {
        if (this.#disposed) break;
        this.observe(appId, event);
      }
    } catch {
      // A dropped fallback stream is repaired by the next arm/dispatch; state stays unknown.
    } finally {
      stream.close();
      if (this.#subscriptions.get(appId) === record) this.#subscriptions.delete(appId);
    }
  }

  #onUserMessage(appId: string, sessionId: string, messageID: string): void {
    const now = this.#now();
    confirmPendingByMessage(this.#db, appId, sessionId, messageID, now);
    markSessionHasMessages(this.#db, appId, sessionId, now);
  }

  #onSessionError(appId: string, sessionId: string): void {
    const rows = readPendingSends(this.#db, appId, sessionId).filter(
      (row) => row.state === "sending",
    );
    for (const row of rows) {
      const now = this.#now();
      setPendingState(this.#db, row.id, "unknown", "session_error", now);
      markDeliveriesUnknownForMessage(
        this.#db,
        appId,
        sessionId,
        row.messageID,
        "session_error",
        now,
      );
      this.#schedule(appId, { ...row, state: "unknown" });
    }
  }

  #schedule(appId: string, row: PendingSendRow): void {
    if (this.#disposed || this.#scheduled.has(row.messageID)) return;
    const endpoint = this.#endpointFor(appId);
    if (endpoint === undefined) return;
    this.#scheduled.add(row.messageID);
    void this.#probe(appId, endpoint, row, Number.POSITIVE_INFINITY)
      .catch(() => undefined)
      .finally(() => this.#scheduled.delete(row.messageID));
  }

  async #probe(
    appId: string,
    endpoint: string,
    row: PendingSendRow,
    deadline: number,
    startIndex = 0,
    prior: ConfirmOutcome = "unknown",
  ): Promise<ConfirmOutcome> {
    let last = prior;
    for (let index = startIndex; index < this.#backoffMs.length; index += 1) {
      if (this.#disposed) return last;
      const wait = this.#backoffMs[index] ?? 0;
      if (index > 0 && wait > 0) {
        if (Date.now() + wait > deadline) {
          void this.#continueLater(appId, endpoint, row, index, last);
          return "pending";
        }
        await this.#sleep(wait);
      }
      const current = this.#currentRow(appId, row.messageID);
      if (current === undefined || current.state === "failed") return last;
      const outcome = await this.#readOnce(endpoint, current);
      if (outcome === "found") {
        this.#applyOutcome(appId, current, "found");
        return "found";
      }
      last = outcome;
    }
    this.#applyOutcome(appId, row, last);
    return last;
  }

  async #continueLater(
    appId: string,
    endpoint: string,
    row: PendingSendRow,
    index: number,
    prior: ConfirmOutcome,
  ): Promise<void> {
    await this.#probe(appId, endpoint, row, Number.POSITIVE_INFINITY, index, prior).catch(
      () => undefined,
    );
  }

  async #readOnce(endpoint: string, row: PendingSendRow): Promise<ConfirmOutcome> {
    try {
      await this.#readMessage(endpoint, row.sessionId, row.messageID);
      return "found";
    } catch (error) {
      if (error instanceof OpencodeHttpError && (error.status === 404 || error.status === 410)) {
        return "absent";
      }
      return "unknown";
    }
  }

  #applyOutcome(appId: string, row: PendingSendRow, outcome: ConfirmOutcome): void {
    if (this.#disposed) return;
    if (outcome === "found") {
      confirmPendingByMessage(this.#db, appId, row.sessionId, row.messageID, this.#now());
      return;
    }
    const current = this.#currentRow(appId, row.messageID);
    if (current === undefined) return;
    if (outcome === "absent") {
      void this.#resolveAbsent(appId, current);
      return;
    }
    if (outcome === "unknown" && current.state !== "failed") {
      const now = this.#now();
      setPendingState(this.#db, current.id, "unknown", "confirmation_unknown", now);
      markDeliveriesUnknownForMessage(
        this.#db,
        appId,
        current.sessionId,
        current.messageID,
        "confirmation_unknown",
        now,
      );
    }
  }

  async #resolveAbsent(appId: string, row: PendingSendRow): Promise<void> {
    const gone = await this.#sessionGone(appId, row.sessionId);
    if (this.#disposed) return;
    if (gone) {
      const identity = this.#appIdentity(appId);
      deleteSessionChatRows(this.#db, appId, row.sessionId);
      if (identity !== undefined) {
        removeSessionFolder(
          sessionFolder(this.#agentsHome, identity.projectId, identity.appKey, row.sessionId),
        );
      }
      return;
    }
    const current = this.#currentRow(appId, row.messageID);
    if (current !== undefined) {
      const now = this.#now();
      setPendingState(this.#db, current.id, "failed", "message_absent", now);
      failDeliveriesForMessage(
        this.#db,
        appId,
        current.sessionId,
        current.messageID,
        "message_absent",
        now,
      );
    }
  }

  async #sessionGone(appId: string, sessionId: string): Promise<boolean> {
    const endpoint = this.#endpointFor(appId);
    if (endpoint === undefined) return false;
    try {
      await this.#readSession(endpoint, sessionId);
      return false;
    } catch (error) {
      return error instanceof OpencodeHttpError && (error.status === 404 || error.status === 410);
    }
  }

  #currentRow(appId: string, messageID: string): PendingSendRow | undefined {
    return readPendingByMessage(this.#db, appId, messageID);
  }

  #appIdentity(appId: string): { projectId: string; appKey: string } | undefined {
    return this.#db
      .prepare("SELECT project_id AS projectId, app_key AS appKey FROM apps WHERE id = ?")
      .get(appId) as { projectId: string; appKey: string } | undefined;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#sleepers.delete(timer);
        resolve();
      }, ms);
      timer.unref();
      this.#sleepers.add(timer);
    });
  }
}
