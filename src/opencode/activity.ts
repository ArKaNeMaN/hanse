import type { Logger } from "../logging/logger.js";
import type { SqliteDatabase } from "../store/index.js";
import { readLastAgentActivityAt, touchAgentActivity } from "../store/process.js";
import {
  listPermissionsStrict,
  listPermissionsV2Strict,
  listQuestionsStrict,
  listQuestionsV2Strict,
  listSessionStatusesStrict,
  OpencodeHttpError,
  type OpencodePermissionRequest,
  type OpencodePermissionV2Request,
  type OpencodeQuestionRequest,
  type OpencodeRequestOptions,
  type OpencodeSessionStatusMap,
} from "./client.js";

export type AgentActivityReason =
  | "prompt"
  | "status"
  | "waiting"
  | "answer"
  | "compact"
  | "handoff"
  | "resume"
  | "start"
  | "restart";

export type ActivityEndpoint =
  | { state: "not_running" }
  | { state: "running"; endpoint: string }
  | { state: "unprobeable"; reason: string };

export interface AgentActivityClient {
  listSessionStatusesStrict(
    endpoint: string,
    options?: OpencodeRequestOptions,
  ): Promise<OpencodeSessionStatusMap>;
  listQuestionsStrict(
    endpoint: string,
    options?: OpencodeRequestOptions,
  ): Promise<OpencodeQuestionRequest[]>;
  listPermissionsStrict(
    endpoint: string,
    options?: OpencodeRequestOptions,
  ): Promise<OpencodePermissionRequest[]>;
  listQuestionsV2Strict(
    endpoint: string,
    appDir: string,
    options?: OpencodeRequestOptions,
  ): Promise<OpencodeQuestionRequest[]>;
  listPermissionsV2Strict(
    endpoint: string,
    appDir: string,
    options?: OpencodeRequestOptions,
  ): Promise<OpencodePermissionV2Request[]>;
}

export interface AgentActivityServiceOptions {
  db: SqliteDatabase;
  activityEndpoint: (appId: string) => ActivityEndpoint | Promise<ActivityEndpoint>;
  appDirFor: (appId: string) => string | undefined;
  logger?: Logger;
  now?: () => number;
  timeoutMs?: number;
  statusCoalesceMs?: number;
  pendingSendWindowMs?: number;
  client?: Partial<AgentActivityClient>;
}

export const AGENT_ACTIVITY_TIMEOUT_MS = 5_000;
export const AGENT_ACTIVITY_STATUS_COALESCE_MS = 60_000;
export const AGENT_ACTIVITY_PENDING_SEND_WINDOW_MS = 15 * 60 * 1000;
export const AGENT_ACTIVITY_WARNING_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_CLIENT: AgentActivityClient = {
  listSessionStatusesStrict,
  listQuestionsStrict,
  listPermissionsStrict,
  listQuestionsV2Strict,
  listPermissionsV2Strict,
};

const TERMINAL_RESUME_STATES = [
  "completed",
  "failed",
  "ambiguous",
  "superseded",
  "skipped_stopped",
  "skipped_stale",
  "skipped_missing",
];

type PromptSource = "v1_questions" | "v1_permissions" | "v2_questions" | "v2_permissions";

export class AgentActivityService {
  readonly #db: SqliteDatabase;
  readonly #activityEndpoint: AgentActivityServiceOptions["activityEndpoint"];
  readonly #appDirFor: AgentActivityServiceOptions["appDirFor"];
  readonly #logger: Logger | undefined;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #statusCoalesceMs: number;
  readonly #pendingSendWindowMs: number;
  readonly #client: AgentActivityClient;
  readonly #lastStatusWrite = new Map<string, number>();
  readonly #warnings = new Map<string, number>();
  readonly #epochs = new Map<string, number>();
  readonly #capabilities = new Map<string, Set<PromptSource>>();

  constructor(options: AgentActivityServiceOptions) {
    this.#db = options.db;
    this.#activityEndpoint = options.activityEndpoint;
    this.#appDirFor = options.appDirFor;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? AGENT_ACTIVITY_TIMEOUT_MS;
    this.#statusCoalesceMs = options.statusCoalesceMs ?? AGENT_ACTIVITY_STATUS_COALESCE_MS;
    this.#pendingSendWindowMs =
      options.pendingSendWindowMs ?? AGENT_ACTIVITY_PENDING_SEND_WINDOW_MS;
    this.#client = { ...DEFAULT_CLIENT, ...options.client };
  }

  touch(appId: string, reason: AgentActivityReason, at?: number): void {
    try {
      const timestamp = at ?? this.#now();
      if (reason === "status") {
        const previous = this.#lastStatusWrite.get(appId);
        if (previous !== undefined && timestamp - previous < this.#statusCoalesceMs) {
          return;
        }
        this.#lastStatusWrite.set(appId, timestamp);
      }
      if (reason === "start" || reason === "restart") {
        const previousKey = this.#capabilityKey(appId);
        this.#epochs.set(appId, (this.#epochs.get(appId) ?? 0) + 1);
        this.#capabilities.delete(previousKey);
      }
      touchAgentActivity(this.#db, appId, new Date(timestamp).toISOString());
    } catch (error) {
      this.#warn(appId, "agent_activity_touch_failed", error);
    }
  }

  lastActivityAt(appId: string): number | null {
    try {
      const value = readLastAgentActivityAt(this.#db, appId);
      if (value === null) return null;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
      this.#warn(appId, "agent_activity_read_failed", error);
      return null;
    }
  }

  async isActive(appId: string): Promise<boolean> {
    try {
      return await this.#isActive(appId);
    } catch (error) {
      this.#warn(appId, "agent_activity_check_failed", error);
      return true;
    }
  }

  async #isActive(appId: string): Promise<boolean> {
    const endpoint = await this.#withTimeout(
      Promise.resolve(this.#activityEndpoint(appId)),
      "activity endpoint",
    );
    if (endpoint.state === "not_running") return false;
    if (endpoint.state === "unprobeable") return true;

    let statuses: OpencodeSessionStatusMap;
    try {
      statuses = await this.#withTimeout(
        this.#client.listSessionStatusesStrict(endpoint.endpoint),
        "session status",
      );
    } catch {
      return true;
    }
    if (
      Object.values(statuses).some((status) => status.type === "busy" || status.type === "retry")
    ) {
      return true;
    }

    if (this.#hasActiveResume(appId)) return true;
    if (await this.#hasPendingPrompt(appId, endpoint.endpoint)) return true;
    if (this.#hasRecentPendingSend(appId)) return true;
    if (this.#hasActiveHandoff(appId)) return true;
    return false;
  }

  #hasActiveResume(appId: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT 1 AS active FROM session_resume
         WHERE app_id = ? AND observed_status IN ('busy','retry')
           AND resume_state NOT IN (${TERMINAL_RESUME_STATES.map(() => "?").join(",")})
         LIMIT 1`,
      )
      .get(appId, ...TERMINAL_RESUME_STATES) as { active: number } | undefined;
    return row !== undefined;
  }

  async #hasPendingPrompt(appId: string, endpoint: string): Promise<boolean> {
    const appDir = this.#appDirFor(appId);
    if (appDir === undefined) {
      this.#warn(appId, "agent_activity_app_dir_missing");
      return true;
    }
    const sources: Array<{ name: PromptSource; call: () => Promise<unknown[]> }> = [
      { name: "v1_questions", call: () => this.#client.listQuestionsStrict(endpoint) },
      { name: "v1_permissions", call: () => this.#client.listPermissionsStrict(endpoint) },
      { name: "v2_questions", call: () => this.#client.listQuestionsV2Strict(endpoint, appDir) },
      {
        name: "v2_permissions",
        call: () => this.#client.listPermissionsV2Strict(endpoint, appDir),
      },
    ];
    const results = await Promise.allSettled(
      sources.map((source) => this.#withTimeout(source.call(), source.name)),
    );
    for (const [index, result] of results.entries()) {
      const source = sources[index];
      if (source === undefined) continue;
      if (result.status === "fulfilled") {
        this.#markCapable(appId, source.name);
        if (result.value.length > 0) return true;
        continue;
      }
      if (this.#isUnsupported(result.reason) && !this.#isCapable(appId, source.name)) {
        continue;
      }
      return true;
    }
    return false;
  }

  #hasRecentPendingSend(appId: string): boolean {
    const cutoff = new Date(this.#now() - this.#pendingSendWindowMs).toISOString();
    const row = this.#db
      .prepare(
        `SELECT 1 AS active FROM pending_sends
         WHERE app_id = ? AND state IN ('sending','unknown') AND updated_at >= ?
         LIMIT 1`,
      )
      .get(appId, cutoff) as { active: number } | undefined;
    return row !== undefined;
  }

  #hasActiveHandoff(appId: string): boolean {
    const oneShotSource = this.#db
      .prepare(
        `SELECT 1 AS active FROM handoffs
         WHERE from_app_id = ? AND mode = 'one_shot'
           AND state IN ('awaiting_approval','dispatching','in_progress')
         LIMIT 1`,
      )
      .get(appId) as { active: number } | undefined;
    if (oneShotSource !== undefined) return true;
    const oneShotTarget = this.#db
      .prepare(
        `SELECT 1 AS active FROM handoffs
         WHERE to_app_id = ? AND mode = 'one_shot'
           AND state IN ('awaiting_approval','dispatching','in_progress')
         LIMIT 1`,
      )
      .get(appId) as { active: number } | undefined;
    if (oneShotTarget !== undefined) return true;
    const threadMessage = this.#db
      .prepare(
        `SELECT 1 AS active FROM handoff_messages m
         JOIN handoffs h ON h.id = m.handoff_id
         WHERE h.mode = 'thread' AND m.state IN ('dispatching','waiting_operator')
           AND (h.from_app_id = ? OR h.to_app_id = ?)
         LIMIT 1`,
      )
      .get(appId, appId) as { active: number } | undefined;
    return threadMessage !== undefined;
  }

  #capabilityKey(appId: string): string {
    return `${appId}#${this.#epochs.get(appId) ?? 0}`;
  }

  #markCapable(appId: string, source: PromptSource): void {
    const key = this.#capabilityKey(appId);
    let sources = this.#capabilities.get(key);
    if (sources === undefined) {
      sources = new Set();
      this.#capabilities.set(key, sources);
    }
    sources.add(source);
  }

  #isCapable(appId: string, source: PromptSource): boolean {
    return this.#capabilities.get(this.#capabilityKey(appId))?.has(source) === true;
  }

  #isUnsupported(error: unknown): boolean {
    return error instanceof OpencodeHttpError && (error.status === 404 || error.status === 405);
  }

  async #withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${this.#timeoutMs}ms`)),
        this.#timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #warn(appId: string, message: string, error?: unknown): void {
    const now = this.#now();
    const previous = this.#warnings.get(appId);
    if (previous !== undefined && now - previous < AGENT_ACTIVITY_WARNING_INTERVAL_MS) {
      return;
    }
    this.#warnings.set(appId, now);
    const detail = error instanceof Error ? error.message : undefined;
    this.#logger?.warn(message, {
      appId,
      ...(detail === undefined ? {} : { error: detail.slice(0, 300) }),
    });
  }
}
