import { activeUploadIds } from "../attachments/quota.js";
import { runAttachmentMaintenance } from "../attachments/reconcile.js";
import {
  deleteSession,
  getSession,
  listMessagePage,
  OpencodeHttpError,
} from "../opencode/client.js";
import { SessionNoticeStore, SessionResumeStore } from "../opencode/recovery.js";
import type { SqliteDatabase } from "../store/index.js";
import { sessionLockKey, sessionLocks } from "./locks.js";
import {
  deleteSessionChatRows,
  localSessionBlockReason,
  readSessionState,
  removeSessionFolder,
  sessionFolder,
} from "./state.js";

export const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SWEEP_EMPTY_CHECK_TIMEOUT_MS = 5_000;

export interface ChatSweepOptions {
  db: SqliteDatabase;
  agentsHome?: string;
  endpointFor: (appId: string) => string | undefined;
  intervalMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * Daily retention pass for empty, Hanse-created sessions (design §D6.9).
 *
 * Fail closed: only a definitive empty upstream message list (or an already-deleted session)
 * permits deletion. A stopped app is skipped, never started; a 5xx/transport/timeout keeps the
 * session for the next pass.
 */
export class ChatSweep {
  readonly #db: SqliteDatabase;
  readonly #agentsHome: string | undefined;
  readonly #endpointFor: (appId: string) => string | undefined;
  readonly #intervalMs: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: ChatSweepOptions) {
    this.#db = options.db;
    this.#agentsHome = options.agentsHome;
    this.#endpointFor = options.endpointFor;
    this.#intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
    this.#maxAgeMs = options.maxAgeMs ?? SWEEP_MAX_AGE_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.runOnce();
    }, this.#intervalMs);
    this.#timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    this.#running = this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #pass(): Promise<void> {
    try {
      runAttachmentMaintenance(this.#db, this.#agentsHome, {
        now: this.#now(),
        activeIds: activeUploadIds,
      });
    } catch (error) {
      this.#log(
        `sweep: attachment maintenance failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
      );
    }
    const cutoff = new Date(this.#now() - this.#maxAgeMs).toISOString();
    await this.#sweepNoticeOrphans(cutoff);
    let candidates: SweepCandidate[];
    try {
      candidates = this.#db
        .prepare(
          `SELECT ss.app_id AS appId, ss.session_id AS sessionId,
                  a.project_id AS projectId, a.app_key AS appKey
             FROM session_state ss
             JOIN apps a ON a.id = ss.app_id
             JOIN projects p ON p.id = a.project_id
            WHERE ss.has_messages = 0
              AND ss.last_activity_at < ?
              AND a.deleting = 0
              AND p.deleting = 0
            ORDER BY ss.last_activity_at
            LIMIT 500`,
        )
        .all(cutoff) as SweepCandidate[];
    } catch {
      return;
    }
    for (const candidate of candidates) {
      try {
        await this.#sweepOne(candidate, cutoff);
      } catch (error) {
        this.#log(
          `sweep: ${candidate.appId} failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
        );
      }
    }
  }

  async #sweepNoticeOrphans(cutoff: string): Promise<void> {
    let candidates: NoticeOrphanCandidate[];
    try {
      candidates = this.#db
        .prepare(
          `SELECT n.app_id AS appId, n.session_id AS sessionId,
                  MAX(n.observed_at) AS observedAt,
                  a.project_id AS projectId, a.app_key AS appKey
             FROM (
               SELECT app_id, session_id, created_at AS observed_at FROM session_notices
               UNION ALL
               SELECT app_id, session_id, updated_at AS observed_at FROM session_resume
             ) n
             JOIN apps a ON a.id = n.app_id
             JOIN projects p ON p.id = a.project_id
            WHERE a.deleting = 0
              AND p.deleting = 0
            GROUP BY n.app_id, n.session_id, a.project_id, a.app_key
           HAVING MAX(n.observed_at) < ?
            ORDER BY observedAt
            LIMIT 500`,
        )
        .all(cutoff) as NoticeOrphanCandidate[];
    } catch {
      return;
    }
    for (const candidate of candidates) {
      try {
        await this.#sweepNoticeOrphan(candidate);
      } catch (error) {
        this.#log(
          `sweep: notice orphan ${candidate.appId} failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
        );
      }
    }
  }

  async #sweepNoticeOrphan(candidate: NoticeOrphanCandidate): Promise<void> {
    const endpoint = this.#endpointFor(candidate.appId);
    if (endpoint === undefined) return;
    await sessionLocks.run(sessionLockKey(candidate.appId, candidate.sessionId), async () => {
      const marker = this.#db
        .prepare(
          `SELECT a.deleting AS appDeleting, p.deleting AS projectDeleting
             FROM apps a JOIN projects p ON p.id = a.project_id WHERE a.id = ?`,
        )
        .get(candidate.appId) as { appDeleting: number; projectDeleting: number } | undefined;
      if (marker === undefined || marker.appDeleting === 1 || marker.projectDeleting === 1) {
        return;
      }
      try {
        await getSession(endpoint, candidate.sessionId, {
          timeoutMs: SWEEP_EMPTY_CHECK_TIMEOUT_MS,
        });
        return;
      } catch (error) {
        if (
          !(error instanceof OpencodeHttpError && (error.status === 404 || error.status === 410))
        ) {
          return;
        }
      }
      new SessionNoticeStore(this.#db).deleteSessionRows(candidate.appId, candidate.sessionId);
      new SessionResumeStore(this.#db).deleteSessionRows(candidate.appId, candidate.sessionId);
      removeSessionFolder(
        sessionFolder(this.#agentsHome, candidate.projectId, candidate.appKey, candidate.sessionId),
      );
    });
  }

  async #sweepOne(candidate: SweepCandidate, cutoff: string): Promise<void> {
    const endpoint = this.#endpointFor(candidate.appId);
    if (endpoint === undefined) return;
    await sessionLocks.run(sessionLockKey(candidate.appId, candidate.sessionId), async () => {
      const state = readSessionState(this.#db, candidate.appId, candidate.sessionId);
      if (state === undefined || state.hasMessages !== 0) return;
      if (state.lastActivityAt >= cutoff) return;
      if (localSessionBlockReason(this.#db, candidate.appId, candidate.sessionId) !== undefined) {
        return;
      }
      const marker = this.#db
        .prepare(
          `SELECT a.deleting AS appDeleting, p.deleting AS projectDeleting
             FROM apps a JOIN projects p ON p.id = a.project_id WHERE a.id = ?`,
        )
        .get(candidate.appId) as { appDeleting: number; projectDeleting: number } | undefined;
      if (marker === undefined || marker.appDeleting === 1 || marker.projectDeleting === 1) {
        return;
      }
      let upstreamGone = false;
      try {
        const page = await listMessagePage(endpoint, candidate.sessionId, {
          limit: 1,
          timeoutMs: SWEEP_EMPTY_CHECK_TIMEOUT_MS,
        });
        if (page.messages.length > 0) return;
      } catch (error) {
        if (error instanceof OpencodeHttpError && error.status === 404) {
          upstreamGone = true;
        } else if (error instanceof OpencodeHttpError && error.code === "messages_too_large") {
          return;
        } else {
          return;
        }
      }
      if (!upstreamGone) {
        try {
          await deleteSession(endpoint, candidate.sessionId, {
            timeoutMs: SWEEP_EMPTY_CHECK_TIMEOUT_MS,
          });
        } catch (error) {
          if (!(error instanceof OpencodeHttpError && error.status === 404)) return;
        }
      }
      deleteSessionChatRows(this.#db, candidate.appId, candidate.sessionId);
      removeSessionFolder(
        sessionFolder(this.#agentsHome, candidate.projectId, candidate.appKey, candidate.sessionId),
      );
    });
  }
}

interface SweepCandidate {
  appId: string;
  sessionId: string;
  projectId: string;
  appKey: string;
}

interface NoticeOrphanCandidate {
  appId: string;
  sessionId: string;
  observedAt: string;
  projectId: string;
  appKey: string;
}
