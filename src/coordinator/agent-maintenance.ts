import type { TerminalSessionRegistry } from "../http/terminal.js";
import type { ImagePullReport, ImageService } from "../images/service.js";
import type { Logger } from "../logging/logger.js";
import { isMasterApp as isMasterApplication } from "../master/constants.js";
import type { AgentActivityService } from "../opencode/activity.js";
import type { LaunchSnapshot } from "../opencode/launch.js";
import type { ManagedApp } from "../opencode/manager.js";
import { recordEvent } from "../store/events.js";
import type { SqliteDatabase } from "../store/index.js";
import { readAppliedLaunchHash } from "../store/process.js";
import type { DeploymentLock } from "./deployment-lock.js";

export interface MaintenanceConfig {
  /** Idle threshold for auto-stop; `0` disables it. */
  autoStopMs: number;
  /** Idle threshold for auto-update; `0` disables it. */
  autoUpdateMs: number;
  /** Idle scheduler tick, clamped to {@link MIN_MAINTENANCE_INTERVAL_MS}. */
  intervalMs: number;
  /** Default/base image pull interval; `0` disables it. */
  autoPullMs: number;
}

export const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  autoStopMs: 172_800_000,
  autoUpdateMs: 10_800_000,
  intervalMs: 300_000,
  autoPullMs: 900_000,
};

export const MIN_MAINTENANCE_INTERVAL_MS = 30_000;
export const MAINTENANCE_MAX_CONCURRENT_APPS = 4;
export const MAINTENANCE_PASS_DEADLINE_MS = 60_000;
export const MAINTENANCE_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
export const MAINTENANCE_SKIP_LOG_INTERVAL_MS = 60 * 60 * 1000;
export const MAINTENANCE_PULL_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

interface MaintenanceConfigWarning {
  variable: string;
  value: string;
  fallback: number;
}

type MaintenanceWarn = (message: string, fields?: Record<string, unknown>) => void;

function defaultWarn(message: string, fields?: Record<string, unknown>): void {
  const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
  console.warn(`[maintenance] ${message}${suffix}`);
}

function positiveDuration(
  env: NodeJS.ProcessEnv,
  variable: string,
  fallback: number,
  warn: MaintenanceWarn,
): number {
  const raw = env[variable]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    warn("agent_maintenance_invalid_config", {
      variable,
      value: raw,
      fallback,
    } satisfies MaintenanceConfigWarning);
    return fallback;
  }
  return parsed;
}

/**
 * Validate and clamp the environment-driven idle-maintenance configuration.
 *
 * Invalid values fall back to the documented default and emit exactly one warning per variable.
 */
export function resolveMaintenanceConfig(
  env: NodeJS.ProcessEnv = process.env,
  warn: MaintenanceWarn = defaultWarn,
): MaintenanceConfig {
  const autoStopMs = positiveDuration(
    env,
    "HANSE_AGENT_AUTO_STOP_MS",
    DEFAULT_MAINTENANCE_CONFIG.autoStopMs,
    warn,
  );
  const autoUpdateMs = positiveDuration(
    env,
    "HANSE_AGENT_AUTO_UPDATE_MS",
    DEFAULT_MAINTENANCE_CONFIG.autoUpdateMs,
    warn,
  );
  const autoPullMs = positiveDuration(
    env,
    "HANSE_AGENT_AUTO_PULL_MS",
    DEFAULT_MAINTENANCE_CONFIG.autoPullMs,
    warn,
  );
  const interval = positiveDuration(
    env,
    "HANSE_AGENT_MAINTENANCE_INTERVAL_MS",
    DEFAULT_MAINTENANCE_CONFIG.intervalMs,
    warn,
  );
  return {
    autoStopMs,
    autoUpdateMs,
    intervalMs: Math.max(MIN_MAINTENANCE_INTERVAL_MS, interval),
    autoPullMs,
  };
}

/** The manager surface the scheduler uses; all calls are lock-free. */
export interface MaintenanceManager {
  isRestarting(appId: string): boolean;
  isLaunching(appId: string): boolean;
  isBuilding(appId: string): Promise<boolean>;
  stopApp(
    appId: string,
    options: {
      source?: "system";
      reason?: "auto_stop";
      guard?: () => boolean | Promise<boolean>;
    },
  ): Promise<boolean>;
  restartIfRunning(
    app: ManagedApp,
    options: {
      source?: "system";
      reason?: "auto_update";
      guard?: () => boolean | Promise<boolean>;
      expectedLaunchFingerprint?: string;
      expectedImageId?: string;
    },
  ): Promise<boolean>;
  launchSnapshot(app: ManagedApp): LaunchSnapshot;
  launchFingerprint(snapshot: LaunchSnapshot): string;
  pendingRestart(appId: string): { pending: boolean; reasons: string[] };
}

export interface MaintenanceImageSource {
  imageState(appId: string): Promise<{
    state: string;
    targetImageId: string | null;
    appliedImageId: string | null;
  }>;
  pullConfigured(options?: {
    signal?: AbortSignal;
    isDraining?: () => boolean;
  }): Promise<ImagePullReport>;
}

export interface MaintenanceActivitySource {
  isActive(appId: string): Promise<boolean>;
  lastActivityAt(appId: string): number | null;
}

export interface AgentMaintenanceSchedulerOptions {
  db: SqliteDatabase;
  manager: MaintenanceManager;
  images?: Pick<ImageService, "imageState" | "pullConfigured"> | MaintenanceImageSource;
  activity: Pick<AgentActivityService, "isActive" | "lastActivityAt"> | MaintenanceActivitySource;
  logger?: Logger;
  deploymentLock?: Pick<DeploymentLock, "isActive">;
  drain: { isDraining(): boolean; isShuttingDown(): boolean };
  terminalSessions: Pick<TerminalSessionRegistry, "isActive">;
  managedAppFor: (appId: string) => ManagedApp | undefined;
  now?: () => number;
  config: MaintenanceConfig;
  isMasterApp?: (projectId: string, appKey: string) => boolean;
  /** Optional test hooks; production uses the documented defaults. */
  maxConcurrent?: number;
  deadlineMs?: number;
  failureCooldownMs?: number;
}

export interface MaintenanceReport {
  evaluated: number;
  stopped: string[];
  updated: string[];
  skipped: Array<{ appId: string; reason: string }>;
  pull?: ImagePullReport;
}

interface CandidateRow {
  id: string;
  projectId: string;
  appKey: string;
  lastActivityAt: string;
}

interface ActionState {
  lastActivityAt: string | null;
  appDeleting: number;
  projectDeleting: number;
  state: string | null;
  phase: string | null;
}

const IDLE_CANDIDATE_SQL = `
SELECT a.id AS id,
       a.project_id AS projectId,
       a.app_key AS appKey,
       MAX(
         COALESCE(a.last_agent_activity_at, a.created_at),
         COALESCE(i.started_at, a.created_at),
         a.created_at
       ) AS lastActivityAt
FROM instances i
JOIN apps a ON a.id = i.app_id
JOIN projects p ON p.id = a.project_id
WHERE COALESCE(i.runtime_state, i.state) = 'running'
  AND (i.process_phase IS NULL OR i.process_phase = 'ready')
  AND a.deleting = 0 AND p.deleting = 0
  AND MAX(
        COALESCE(a.last_agent_activity_at, a.created_at),
        COALESCE(i.started_at, a.created_at),
        a.created_at
      ) < ?
ORDER BY lastActivityAt`;

const ACTION_STATE_SQL = `
SELECT MAX(
         COALESCE(a.last_agent_activity_at, a.created_at),
         COALESCE(i.started_at, a.created_at),
         a.created_at
       ) AS lastActivityAt,
       a.deleting AS appDeleting,
       p.deleting AS projectDeleting,
       COALESCE(i.runtime_state, i.state) AS state,
       i.process_phase AS phase
FROM apps a
JOIN projects p ON p.id = a.project_id
LEFT JOIN instances i ON i.app_id = a.id
WHERE a.id = ?`;

function emptyReport(): MaintenanceReport {
  return { evaluated: 0, stopped: [], updated: [], skipped: [] };
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Periodic idle-lifecycle scheduler.
 *
 * Two unref'ed timers run the idle (stop/update) and pull passes. Both passes share one
 * single-flight guard, so a pull can never overlap an idle action. Every rejection is caught
 * locally; a timer callback never becomes an unhandled rejection.
 */
export class AgentMaintenanceScheduler {
  readonly #db: SqliteDatabase;
  readonly #manager: MaintenanceManager;
  readonly #images: AgentMaintenanceSchedulerOptions["images"];
  readonly #activity: AgentMaintenanceSchedulerOptions["activity"];
  readonly #logger: Logger | undefined;
  readonly #deploymentLock: Pick<DeploymentLock, "isActive"> | undefined;
  readonly #drain: AgentMaintenanceSchedulerOptions["drain"];
  readonly #terminalSessions: Pick<TerminalSessionRegistry, "isActive">;
  readonly #managedAppFor: (appId: string) => ManagedApp | undefined;
  readonly #now: () => number;
  readonly #config: MaintenanceConfig;
  readonly #isMasterApp: (projectId: string, appKey: string) => boolean;
  readonly #maxConcurrent: number;
  readonly #deadlineMs: number;
  readonly #failureCooldownMs: number;
  readonly #cooldowns = new Map<string, number>();
  readonly #skipLogAt = new Map<string, number>();
  #idleTimer: NodeJS.Timeout | undefined;
  #pullTimer: NodeJS.Timeout | undefined;
  #pullAbort: AbortController | undefined;
  #pullCooldownUntil = 0;
  #pullFailures = 0;
  #busy = false;

  constructor(options: AgentMaintenanceSchedulerOptions) {
    this.#db = options.db;
    this.#manager = options.manager;
    this.#images = options.images;
    this.#activity = options.activity;
    this.#logger = options.logger;
    this.#deploymentLock = options.deploymentLock;
    this.#drain = options.drain;
    this.#terminalSessions = options.terminalSessions;
    this.#managedAppFor = options.managedAppFor;
    this.#now = options.now ?? Date.now;
    this.#config = options.config;
    this.#isMasterApp = options.isMasterApp ?? isMasterApplication;
    this.#maxConcurrent = Math.max(
      1,
      Math.floor(options.maxConcurrent ?? MAINTENANCE_MAX_CONCURRENT_APPS),
    );
    this.#deadlineMs = Math.max(1, Math.floor(options.deadlineMs ?? MAINTENANCE_PASS_DEADLINE_MS));
    this.#failureCooldownMs = Math.max(
      1,
      Math.floor(options.failureCooldownMs ?? MAINTENANCE_FAILURE_COOLDOWN_MS),
    );
  }

  /** Create the unref'ed idle/pull timers. Safe to call more than once. */
  start(): void {
    if (this.#idleTimer === undefined) {
      this.#idleTimer = setInterval(() => {
        void this.runOnce().catch((error: unknown) => {
          this.#logPassError("idle", error);
        });
      }, this.#config.intervalMs);
      this.#idleTimer.unref?.();
    }
    if (this.#config.autoPullMs > 0 && this.#pullTimer === undefined) {
      this.#pullTimer = setInterval(() => {
        void this.runPullOnce().catch((error: unknown) => {
          this.#logPassError("pull", error);
        });
      }, this.#config.autoPullMs);
      this.#pullTimer.unref?.();
    }
  }

  /** Clear the timers and abort an in-flight pull. Idempotent. */
  stop(): void {
    if (this.#idleTimer !== undefined) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (this.#pullTimer !== undefined) {
      clearInterval(this.#pullTimer);
      this.#pullTimer = undefined;
    }
    this.#pullAbort?.abort();
    this.#pullAbort = undefined;
  }

  /** One idle pass. Overlapping calls return an empty report instead of running concurrently. */
  async runOnce(): Promise<MaintenanceReport> {
    if (this.#busy) {
      return emptyReport();
    }
    if (this.#drain.isDraining() || this.#drain.isShuttingDown()) {
      return emptyReport();
    }
    return this.#withSingleFlight(async () => this.#runIdlePass());
  }

  /** One pull pass. Returns `undefined` when disabled, draining, or another pass is running. */
  async runPullOnce(): Promise<ImagePullReport | undefined> {
    if (this.#images === undefined || this.#config.autoPullMs === 0) {
      return undefined;
    }
    if (this.#busy) {
      return undefined;
    }
    if (this.#drain.isDraining() || this.#drain.isShuttingDown()) {
      return undefined;
    }
    if (this.#now() < this.#pullCooldownUntil) {
      return undefined;
    }
    return this.#withSingleFlight(async () => this.#runPullPass());
  }

  async #withSingleFlight<T>(work: () => Promise<T>): Promise<T> {
    this.#busy = true;
    try {
      return await work();
    } finally {
      this.#busy = false;
    }
  }

  async #runIdlePass(): Promise<MaintenanceReport> {
    const report = emptyReport();
    const thresholds: number[] = [];
    if (this.#config.autoStopMs > 0) thresholds.push(this.#config.autoStopMs);
    if (this.#config.autoUpdateMs > 0) thresholds.push(this.#config.autoUpdateMs);
    if (thresholds.length === 0) {
      return report;
    }
    const now = this.#now();
    const cutoff = new Date(now - Math.min(...thresholds)).toISOString();
    let rows: CandidateRow[];
    try {
      rows = this.#db.prepare(IDLE_CANDIDATE_SQL).all(cutoff) as CandidateRow[];
    } catch (error) {
      this.#logPassError("idle_query", error);
      return report;
    }
    report.evaluated = rows.length;
    if (rows.length === 0) {
      return report;
    }
    const deadline = now + this.#deadlineMs;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(this.#maxConcurrent, rows.length) },
      async (): Promise<void> => {
        for (;;) {
          const index = next;
          next += 1;
          const row = rows[index];
          if (row === undefined) {
            return;
          }
          if (this.#now() >= deadline) {
            report.skipped.push({ appId: row.id, reason: "deadline" });
            continue;
          }
          try {
            const outcome = await this.#withDeadline(
              this.#evaluate(row, report, deadline),
              deadline,
            );
            if (outcome.timedOut) {
              this.#skip(row.id, "deadline", report);
            }
          } catch (error) {
            this.#cooldowns.set(row.id, this.#now() + this.#failureCooldownMs);
            this.#logger?.error("agent_auto_maintenance_error", {
              appId: row.id,
              error: errorMessage(error),
            });
            report.skipped.push({ appId: row.id, reason: "error" });
          }
        }
      },
    );
    await Promise.all(workers);
    return report;
  }

  async #runPullPass(): Promise<ImagePullReport | undefined> {
    const images = this.#images;
    if (images === undefined) {
      return undefined;
    }
    const abort = new AbortController();
    this.#pullAbort = abort;
    try {
      const report = await images.pullConfigured({
        signal: abort.signal,
        isDraining: () => this.#drain.isDraining() || this.#drain.isShuttingDown(),
      });
      if (!report.ok) {
        this.#pullFailures += 1;
        if (this.#pullFailures >= 2) {
          this.#pullCooldownUntil = this.#now() + MAINTENANCE_PULL_FAILURE_COOLDOWN_MS;
        }
        this.#logger?.warn("agent_auto_pull_failed", {
          attempts: report.attempts.filter((attempt) => attempt.outcome === "failed").length,
          consecutiveFailures: this.#pullFailures,
          cooldownMs: this.#pullFailures >= 2 ? MAINTENANCE_PULL_FAILURE_COOLDOWN_MS : 0,
        });
      } else {
        this.#pullFailures = 0;
        this.#logger?.info("agent_auto_pull", {
          attempts: report.attempts.length,
          changed: report.attempts.some((attempt) => attempt.changed),
        });
      }
      return report;
    } catch (error) {
      this.#pullFailures += 1;
      if (this.#pullFailures >= 2) {
        this.#pullCooldownUntil = this.#now() + MAINTENANCE_PULL_FAILURE_COOLDOWN_MS;
      }
      this.#logger?.warn("agent_auto_pull_failed", {
        error: errorMessage(error),
        consecutiveFailures: this.#pullFailures,
      });
      return undefined;
    } finally {
      if (this.#pullAbort === abort) {
        this.#pullAbort = undefined;
      }
    }
  }

  async #evaluate(row: CandidateRow, report: MaintenanceReport, deadline: number): Promise<void> {
    const appId = row.id;
    const lastActivity = parseTime(row.lastActivityAt);
    if (lastActivity === null) {
      this.#skip(appId, "unknown", report);
      return;
    }
    const cooldownUntil = this.#cooldowns.get(appId) ?? 0;
    if (this.#now() < cooldownUntil) {
      this.#skip(appId, "cooldown", report);
      return;
    }
    if (this.#isMasterApp(row.projectId, row.appKey)) {
      this.#skip(appId, "master", report);
      return;
    }
    if (this.#deploymentLock?.isActive() === true) {
      this.#skip(appId, "deployment_locked", report);
      return;
    }
    if (this.#drain.isDraining() || this.#drain.isShuttingDown()) {
      this.#skip(appId, "draining", report);
      return;
    }
    if (this.#manager.isRestarting(appId) || this.#manager.isLaunching(appId)) {
      this.#skip(appId, "transitioning", report);
      return;
    }
    if (await this.#manager.isBuilding(appId)) {
      this.#skip(appId, "building", report);
      return;
    }
    const state = this.#actionState(appId);
    if (
      state === undefined ||
      state.appDeleting !== 0 ||
      state.projectDeleting !== 0 ||
      state.state !== "running" ||
      (state.phase !== null && state.phase !== "ready")
    ) {
      this.#skip(appId, state === undefined ? "unknown" : "transitioning", report);
      return;
    }
    const currentActivity = parseTime(state.lastActivityAt);
    if (currentActivity === null) {
      this.#skip(appId, "unknown", report);
      return;
    }
    const currentIdleMs = this.#now() - currentActivity;
    if (this.#config.autoStopMs > 0 && currentIdleMs >= this.#config.autoStopMs) {
      await this.#autoStop(row, currentIdleMs, report, deadline);
      return;
    }
    if (this.#config.autoUpdateMs > 0 && currentIdleMs >= this.#config.autoUpdateMs) {
      await this.#autoUpdate(row, currentIdleMs, report, deadline);
    }
  }

  async #autoStop(
    row: CandidateRow,
    idleMs: number,
    report: MaintenanceReport,
    deadline: number,
  ): Promise<void> {
    const appId = row.id;
    if (this.#terminalSessions.isActive(appId)) {
      this.#skip(appId, "terminal", report);
      return;
    }
    if (await this.#activity.isActive(appId)) {
      this.#skip(appId, "active", report);
      return;
    }
    const pending = this.#manager.pendingRestart(appId);
    const guard = async (): Promise<boolean> => {
      if (this.#deadlinePassed(deadline)) return false;
      if (this.#deploymentLock?.isActive() === true) return false;
      if (this.#drain.isDraining() || this.#drain.isShuttingDown()) return false;
      if (this.#terminalSessions.isActive(appId)) return false;
      const state = this.#actionState(appId);
      if (
        state === undefined ||
        state.appDeleting !== 0 ||
        state.projectDeleting !== 0 ||
        state.state !== "running" ||
        (state.phase !== null && state.phase !== "ready")
      ) {
        return false;
      }
      const last = parseTime(state.lastActivityAt);
      if (last === null || this.#now() - last < this.#config.autoStopMs) return false;
      return !(await this.#activity.isActive(appId));
    };
    const stopped = await this.#manager.stopApp(appId, {
      source: "system",
      reason: "auto_stop",
      guard,
    });
    if (!stopped) {
      this.#skip(appId, "guard", report);
      return;
    }
    report.stopped.push(appId);
    recordEvent(this.#db, appId, "app.auto_stopped", {
      appId,
      projectId: row.projectId,
      appKey: row.appKey,
      idleMs,
      lastActivityAt: row.lastActivityAt,
      pendingRestartReasons: pending.reasons,
    });
    this.#logger?.info("agent_auto_stopped", { appId, idleMs });
  }

  async #autoUpdate(
    row: CandidateRow,
    idleMs: number,
    report: MaintenanceReport,
    deadline: number,
  ): Promise<void> {
    const appId = row.id;
    const images = this.#images;
    if (images === undefined) {
      this.#skip(appId, "images_unavailable", report);
      return;
    }
    const app = this.#managedAppFor(appId);
    if (app === undefined) {
      this.#skip(appId, "unknown", report);
      return;
    }
    if (this.#terminalSessions.isActive(appId)) {
      this.#skip(appId, "terminal", report);
      return;
    }
    if (await this.#activity.isActive(appId)) {
      this.#skip(appId, "active", report);
      return;
    }
    const view = await images.imageState(appId);
    if (view.state !== "restart_required") {
      this.#skip(appId, view.state, report);
      return;
    }
    if (view.targetImageId === null) {
      this.#skip(appId, "image_changed", report);
      return;
    }
    if (this.#manager.pendingRestart(appId).pending) {
      this.#skip(appId, "configuration_changed", report);
      return;
    }
    const snapshot = this.#manager.launchSnapshot(app);
    const expectedLaunchFingerprint = this.#manager.launchFingerprint(snapshot);
    if (readAppliedLaunchHash(this.#db, appId) !== expectedLaunchFingerprint) {
      this.#skip(appId, "configuration_changed", report);
      return;
    }
    const expectedImageId = view.targetImageId;
    const guard = async (): Promise<boolean> => {
      if (this.#deadlinePassed(deadline)) return false;
      if (this.#deploymentLock?.isActive() === true) return false;
      if (this.#drain.isDraining() || this.#drain.isShuttingDown()) return false;
      if (this.#terminalSessions.isActive(appId)) return false;
      const state = this.#actionState(appId);
      if (
        state === undefined ||
        state.appDeleting !== 0 ||
        state.projectDeleting !== 0 ||
        state.state !== "running" ||
        (state.phase !== null && state.phase !== "ready")
      ) {
        return false;
      }
      const last = parseTime(state.lastActivityAt);
      if (last === null || this.#now() - last < this.#config.autoUpdateMs) return false;
      if (await this.#activity.isActive(appId)) return false;
      const current = await images.imageState(appId);
      if (current.state !== "restart_required" || current.targetImageId !== expectedImageId) {
        return false;
      }
      if (this.#manager.pendingRestart(appId).pending) return false;
      if (readAppliedLaunchHash(this.#db, appId) !== expectedLaunchFingerprint) return false;
      const fresh = this.#manager.launchSnapshot(app);
      return this.#manager.launchFingerprint(fresh) === expectedLaunchFingerprint;
    };
    const restarted = await this.#manager.restartIfRunning(app, {
      source: "system",
      reason: "auto_update",
      guard,
      expectedLaunchFingerprint,
      expectedImageId,
    });
    if (!restarted) {
      this.#skip(appId, "guard", report);
      return;
    }
    report.updated.push(appId);
    recordEvent(this.#db, appId, "app.auto_updated", {
      appId,
      projectId: row.projectId,
      appKey: row.appKey,
      idleMs,
      previousImageId: view.appliedImageId,
      imageId: view.targetImageId,
      appliedImageId: view.targetImageId,
      targetImageId: view.targetImageId,
    });
    this.#logger?.info("agent_auto_updated", {
      appId,
      previousImageId: view.appliedImageId,
      imageId: view.targetImageId,
      idleMs,
    });
  }

  async #withDeadline<T>(
    work: Promise<T>,
    deadline: number,
  ): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
    const remaining = Math.max(0, deadline - this.#now());
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), remaining);
      timer.unref?.();
    });
    const settled = work.then(
      (value) => ({ timedOut: false as const, value }),
      (error: unknown) => ({ timedOut: false as const, error }),
    );
    try {
      const outcome = await Promise.race([settled, timeout]);
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #deadlinePassed(deadline: number): boolean {
    return this.#now() >= deadline;
  }

  #actionState(appId: string): ActionState | undefined {
    try {
      return this.#db.prepare(ACTION_STATE_SQL).get(appId) as ActionState | undefined;
    } catch (error) {
      this.#logger?.error("agent_auto_maintenance_error", {
        appId,
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  #skip(appId: string, reason: string, report: MaintenanceReport): void {
    report.skipped.push({ appId, reason });
    const key = `${appId}:${reason}`;
    const now = this.#now();
    const previous = this.#skipLogAt.get(key) ?? 0;
    if (now - previous < MAINTENANCE_SKIP_LOG_INTERVAL_MS) {
      return;
    }
    this.#skipLogAt.set(key, now);
    if (this.#skipLogAt.size > 2_000) {
      const oldest = this.#skipLogAt.keys().next().value;
      if (oldest !== undefined) this.#skipLogAt.delete(oldest);
    }
    this.#logger?.info("agent_auto_update_skipped", { appId, reason });
  }

  #logPassError(pass: string, error: unknown): void {
    this.#logger?.error("agent_auto_maintenance_error", {
      pass,
      error: errorMessage(error),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
