import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import type { AgentRuntimeClient } from "../agent/client.js";
import { stoppedStatus } from "../agent/protocol.js";
import {
  type AppRuntimeSpec,
  computeSpecHash,
  DEFAULT_AGENT_AGENTS_ROOT,
  type SpecHashInput,
  validateAppRuntimeSpec,
} from "../agent/spec.js";
import {
  type AttachmentPathMode,
  attachmentVisibleRoot as resolveAttachmentVisibleRoot,
} from "../attachments/paths.js";
import { activeUploadIds } from "../attachments/quota.js";
import { runAttachmentMaintenance } from "../attachments/reconcile.js";
import {
  type MonitorState,
  PENDING_CONFIRMATION_STALE_MS,
  PendingRecovery,
} from "../chat/pending.js";
import { ChatSweep } from "../chat/sweep.js";
import { DeploymentInProgressError, type DeploymentLock } from "../coordinator/deployment-lock.js";
import type { LifecycleActivity } from "../coordinator/lifecycle-activity.js";
import { materializeGitCredentials } from "../git/materialize.js";
import {
  type AppImageRollbackResult,
  DefaultImageUnavailableError,
  ImageNotReadyError,
  type ImageStateView,
} from "../images/service.js";
import type { Logger } from "../logging/logger.js";
import { ensureAgentToken, mcpTokenPath, revokeAgentToken } from "../mcp/agent-tokens.js";
import type { ModelProviderSnapshot } from "../model-providers/types.js";
import type { PreviewCleanup } from "../preview/types.js";
import { type AppImageStatus, resolveAppBuild } from "../registry/index.js";
import { appNetworkName, mapToHostPath } from "../runner/names.js";
import { RUNNER_APP_PORT } from "../runner/validate.js";
import { defaultImageReference } from "../runtime/build-spec.js";
import { hashValue } from "../settings/hash.js";
import { launchEffectiveSettings } from "../settings/service.js";
import type {
  EffectiveSettings,
  LaunchSettingsSnapshot,
  SettingsTarget,
} from "../settings/types.js";
import type {
  SkillApplyOptions,
  SkillCapture,
  SkillMaterializeResult,
  SkillSource,
} from "../skills/index.js";
import {
  claimPersistedRestart,
  releasePersistedRestart,
  type SqliteDatabase,
} from "../store/index.js";
import {
  type ProcessEvent,
  type ProcessPhase,
  type ProcessSource,
  type ProcessState,
  pruneAllProcessEvents,
  pruneProcessEvents,
  readProcess,
} from "../store/process.js";
import { buildWebMcpConfig } from "../web/config.js";
import { writeAuthFile } from "./auth.js";
import {
  listMessagePage,
  listMessages,
  listSessionStatuses,
  listSessionsBounded,
  type OpencodePart,
  type OpencodeRequestOptions,
  type OpencodeSessionStatusMap,
  sendPromptAsync,
} from "./client.js";
import {
  AgentNotRunningError,
  ContextMonitor,
  type ContextMonitorLike,
  type ContextMonitorOptions,
  type ContextPolicy,
  type ContextSnapshot,
} from "./context.js";
import {
  authorizationFor,
  clearEndpointAuthorization,
  OPENCODE_BASIC_USERNAME,
  setEndpointAuthorization,
} from "./endpoint-auth.js";
import type { HanseEvent } from "./events.js";
import {
  assertOverlayBytes,
  BASH_DEFAULT_TIMEOUT_ENV,
  buildConfigOverlay,
  type IsolatedEnv,
  type McpLocalServer,
  resolveInstanceEnv,
  sanitizeAppKey,
} from "./instance.js";
import { NON_INTERACTIVE_SHELL_ENV } from "./non-interactive-env.js";
import type { OmoProfileInput, OmoProfileResult } from "./omo-profile.js";
import { ensureOpencodePassword, opencodePasswordPath, readOpencodePassword } from "./password.js";
import {
  ATTACHMENTS_POLICY_VERSION,
  BASH_DENY_PROBES,
  buildPermissionPolicy,
  credentialDenyPatterns,
  type PermissionAction,
  resolvePermissionPaths,
  type VerifyPolicyOptions,
  verifyInstancePolicy,
  type WebPermissionOptions,
} from "./policy.js";
import { type ProcessErrorCode, processErrorCode, sanitizeProcessError } from "./process-errors.js";
import { processEvents } from "./process-events.js";
import {
  PROCESS_RULE_HASH,
  PROCESS_RULE_TEXT,
  processRulePath,
  restoreAppliedRule,
  writeAppliedRule,
  writeProcessRule,
} from "./process-rules.js";
import {
  ProcessRecovery,
  type RuntimeObservation,
  type SessionNoticeView,
  type StopIntentReason,
} from "./recovery.js";
import { materializeSharedInstructions } from "./shared-instructions.js";

/**
 * Thrown by {@link InstanceManager.ensure} when the application or its project is marked for
 * deletion. Callers map this to HTTP 409 with the `deletion_pending` code.
 */
export class DeletionPendingError extends Error {
  readonly status = 409;
  readonly code = "deletion_pending";

  constructor(appId: string) {
    super(`application ${appId} is pending deletion`);
    this.name = "DeletionPendingError";
  }
}

/**
 * Thrown when an already-running app's MCP token cannot be reconciled in place. HTTP callers map it
 * to 500 `agent_token_reconcile_failed`; the container is left untouched.
 */
export class AgentTokenReconcileError extends Error {
  readonly code = "agent_token_reconcile_failed";
  readonly status = 500;
  readonly appId: string;

  constructor(appId: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : undefined;
    super(
      `agent token reconciliation failed for ${appId}${detail === undefined ? "" : `: ${detail}`}`,
    );
    this.name = "AgentTokenReconcileError";
    this.appId = appId;
  }
}

/** Thrown when an app already has an in-flight restart claim. HTTP callers map it to 409. */
export class RestartInProgressError extends Error {
  readonly code = "restart_in_progress";
  readonly status = 409;
  readonly appId: string;

  constructor(appId: string) {
    super(`restart already in progress for ${appId}`);
    this.name = "RestartInProgressError";
    this.appId = appId;
  }
}

/** Thrown when a started container never answers opencode HTTP; HTTP callers map it to 503. */
export class AgentStartingError extends Error {
  readonly code = "agent_starting";
  readonly status = 503;
  readonly appId: string;

  constructor(appId: string) {
    super(`agent ${appId} did not become ready`);
    this.name = "AgentStartingError";
    this.appId = appId;
  }
}

/** Thrown when an image rollback restarted the app but the restart failed; all image fields were restored. */
export class ImageRollbackIncompleteError extends Error {
  readonly code = "image_rollback_incomplete";
  readonly status = 502;
  readonly appId: string;

  constructor(appId: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : undefined;
    super(
      `image rollback for ${appId} did not restart the agent${detail === undefined ? "" : `: ${detail}`}`,
    );
    this.name = "ImageRollbackIncompleteError";
    this.appId = appId;
  }
}

/** Thrown when restoring the pre-rollback image row also failed; the database may be inconsistent. */
export class ImageRollbackRestoreError extends Error {
  readonly code = "image_rollback_restore_failed";
  readonly status = 500;
  readonly appId: string;

  constructor(appId: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : undefined;
    super(`image rollback restore failed for ${appId}${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "ImageRollbackRestoreError";
    this.appId = appId;
  }
}

/** Result of one restart claim; `completion` resolves with whether an agent was restarted. */
export interface RestartClaim {
  accepted: boolean;
  completion?: Promise<boolean>;
}

/** Result of a manager-owned image rollback. */
export interface ImageRollbackOutcome {
  result: AppImageRollbackResult;
  restarted: boolean;
}

export interface ManagedApp {
  id: string;
  projectId: string;
  appKey: string;
  appDir: string;
  imageStatus?: AppImageStatus;
  imageRef?: string | null;
  /** Extra opencode instruction files for this instance. */
  instructions?: string[];
  /** Project-shared instruction sources materialized into the app state at launch. */
  sharedInstructions?: string[];
  /** Set false to skip git credential materialization for this instance. */
  gitCredentials?: boolean;
  /** Mount the application directory read-only inside the agent container. */
  appDirReadOnly?: boolean;
  /** Durable image ID of the selected version, when the row has one. */
  imageId?: string | null;
}

/** Caller identity for an ensure: explicit starts are `operator`, lazy starts are `system`. */
export interface EnsureOptions {
  origin?: "operator" | "system";
  /** Names the lazy caller (`prompt`, `context`, `command`, `handoff`, `master`, ...). */
  reason?: string;
}

type RuntimeStatus = Awaited<ReturnType<AgentRuntimeClient["ensure"]>>;

/** Attempt context carried from a restart preparation into the start half. */
interface ProcessAttemptContext {
  attemptId: string;
  source: ProcessSource;
  reason: string;
}

/** Start-half context; an absent attempt id means this call opens a new attempt. */
interface EnsureAttemptContext {
  attemptId?: string;
  source: ProcessSource;
  reason: string;
}

/** One locked process transition; the caller must already hold the app lock. */
interface ProcessTransitionInput {
  attemptId: string;
  state: ProcessState | "failed";
  phase: ProcessPhase | null;
  source: ProcessSource;
  reason?: string | null;
  errorCode?: string | null;
  /** Raw error or message; sanitized before it reaches the row. */
  message?: unknown;
  clearError?: boolean;
  /** Runtime status snapshot when this transition reflects a runtime observation. */
  status?: RuntimeStatus;
  image?: string;
  settingsHash?: string;
  appliedProfile?: boolean;
  appliedSkillsHash?: string;
  appliedRuleHash?: string;
  /** Append the history row (default true). */
  emitEvent?: boolean;
  /** Queue the runtime observation after commit (default: whenever `status` is present). */
  queueObservation?: boolean;
  secrets?: Iterable<string | null | undefined>;
}

interface InstanceProcessRow {
  endpoint: string | null;
  pid: number | null;
  specHash: string | null;
  containerId: string | null;
  containerName: string | null;
  imageRef: string | null;
  appliedImageId: string | null;
  appliedSettingsHash: string | null;
  appliedProfile: number | null;
  appliedSkillsHash: string | null;
  appliedRuleHash: string | null;
  startedAt: string | null;
  runtimeStartedAt: string | null;
  runtimeRestartCount: number | null;
  lastExitCode: number | null;
  lastOomKilled: number | null;
  lastStopReason: string | null;
  lastStopAt: string | null;
  state: string;
  processAttemptId: string | null;
  processPhase: string | null;
  processStartedAt: string | null;
  processErrorCode: string | null;
  processErrorMessage: string | null;
  processErrorAt: string | null;
}

const PROCESS_STALE_MS = 90_000;

function newAttemptId(): string {
  return randomUUID();
}

function normalizeProcessState(state: ProcessState | "failed"): ProcessState {
  return state === "failed" ? "error" : state;
}

function processPhaseForState(state: ProcessState): ProcessPhase {
  switch (state) {
    case "running":
      return "ready";
    case "stopped":
      return "stopped";
    case "error":
      return "failed";
    case "starting":
      return "waiting_ready";
  }
}

function validPhaseStatePair(state: ProcessState, phase: ProcessPhase | null): boolean {
  if (phase === null) return true;
  switch (phase) {
    case "ready":
      return state === "running";
    case "stopped":
      return state === "stopped";
    case "failed":
    case "interrupted":
      return state === "error";
    case "requested":
    case "preparing":
    case "creating":
    case "waiting_ready":
    case "stopping":
      return state === "starting";
  }
}

/** Injectable subset of `SettingsService` used for launch snapshots and live context policy. */
export interface SettingsSource {
  snapshot(target: SettingsTarget): LaunchSettingsSnapshot;
  contextPolicy?(target: SettingsTarget): ContextPolicy;
}

/** Injectable subset of `OmoProfileStore` used for profile application and hashing. */
export interface OmoProfileSource {
  ensure(input: OmoProfileInput, writePath?: string): Promise<OmoProfileResult>;
  preview(input: OmoProfileInput): OmoProfileResult;
}

/** Injectable subset of the global custom-provider registry used at launch. */
export interface ModelProviderSource {
  snapshot(): ModelProviderSnapshot;
}

interface Entry {
  endpoint: string;
  projectId: string;
  appKey: string;
  policyWarnings: string[];
  settingsHash?: string;
  appliedProfile?: boolean;
  appliedSkillsHash?: string;
  profileWarning?: string;
  modelWarnings?: string[];
}

interface ImageStateSnapshot {
  imageStatus: AppImageStatus;
  imageRef: string | null;
  imageHash: string | null;
  imageBaseDigest: string | null;
  imageBaseRef: string | null;
  imageBaseKind: string | null;
  imageHashVersion: number;
  imageBuiltAt: string | null;
  imageError: string | null;
  imageBuildId: string | null;
  imageBuildRef: string | null;
  imageBuildStartedAt: string | null;
  imageBuildRejectedRef: string | null;
}

/** The image dependency the manager needs for start/restart preflight and rollback recovery. */
export interface InstanceImageSource {
  imageState(appId: string): Promise<ImageStateView>;
  adoptBuild(appId: string): Promise<boolean>;
  invalidateCache?(): void;
}

export interface InstanceManagerOptions {
  /** Runtime transport. Production uses the B0.4 supervisor client; tests inject a fake. */
  runtime: AgentRuntimeClient;
  /** Injectable policy verifier for tests. */
  verify?: (options: VerifyPolicyOptions) => Promise<string[]>;
  verificationTimeoutMs?: number;
  verificationRetries?: number;
  verificationRetryDelayMs?: number;
  settings?: SettingsSource;
  omoProfiles?: OmoProfileSource;
  /** Global custom model-provider registry projected into each instance config. */
  modelProviders?: ModelProviderSource;
  /** Injectable skill registry for per-instance materialization. */
  skills?: SkillSource;
  /** Optional structured logger; skill warnings are bounded and content-free. */
  logger?: Logger;
  /** Injectable model-propagation verifier for tests. */
  modelVerifier?: (endpoint: string, expected: string) => Promise<string[]>;
  /**
   * Wait until the fresh instance answers opencode HTTP before {@link ensure} returns. Production
   * passes a bounded poll; tests omit it because their runtime is in-memory and has no HTTP server.
   */
  waitForReady?: (appId: string, endpoint: string) => Promise<void>;
  /** Injectable `prompt_async` dispatch for resume tests; production uses the opencode client. */
  sendPromptAsync?: (
    endpoint: string,
    sessionId: string,
    text: string,
    messageID: string,
    options?: OpencodeRequestOptions,
    model?: string,
    parts?: OpencodePart[],
  ) => Promise<void>;
  /** Root used to validate `appDir`. Defaults to the application's parent directory. */
  workspaceRoot?: string;
  /** Agents root used to validate `stateDir`. Defaults to the manager runtime root. */
  agentsRoot?: string;
  /** Absolute host workspace path for the B1 runner. Enables host-path specs. */
  hostWorkspace?: string;
  /** Absolute host agents path for the B1 runner. Enables host-path specs. */
  hostAgents?: string;
  /** Injectable monitor factory; production constructs a `ContextMonitor`. */
  monitorFactory?: (options: ContextMonitorOptions) => ContextMonitorLike;
  /** Set false to disable background context monitors regardless of settings support. */
  enableContextMonitors?: boolean;
  /** Observe every projected app event while an instance monitor is running. */
  onEvent?: (app: { id: string; projectId: string; appKey: string }, event: HanseEvent) => void;
  /** Advisory external deployment lock; absent in unit fixtures that do not exercise it. */
  deploymentLock?: DeploymentLock;
  /** Process-local destructive-operation counter exposed through `/readyz`. */
  lifecycleActivity?: LifecycleActivity;
  /** Optional preview registry cleared whenever an app is stopped, recreated, or forgotten. */
  previews?: PreviewCleanup;
  /**
   * Image state/adoption dependency for start/restart preflight. Unit fixtures may omit it, in
   * which case the manager falls back to the static build inspection without a preflight.
   */
  images?: InstanceImageSource;
}

interface MonitorEntry {
  monitor: ContextMonitorLike;
  endpoint: string;
  generation: number;
}

export const DEFAULT_MODEL = "deepseek/deepseek-flash";
const DEFAULT_AGENT_API_BASE = "http://127.0.0.1:8787";
const DEFAULT_MEMORY_MB = 2048;
const DEFAULT_CPUS = 2;
const DEFAULT_PIDS = 512;

function disableWebsearch(web: EffectiveSettings["web"]): boolean {
  return web.search.value === null || web.search.value.driver === "deepseek";
}

export function settingsHashFor(
  snapshot: LaunchSettingsSnapshot,
  profile: string,
  skillsHash?: string,
  providersHash?: string,
  ruleHash?: string,
): string {
  return hashValue({
    effective: launchEffectiveSettings(snapshot.resolved.effective),
    providerKeys: snapshot.resolved.providerKeys,
    authHash: snapshot.authHash,
    gitAuthHash: snapshot.gitAuthHash,
    profile,
    ...(providersHash === undefined ? {} : { providers: providersHash }),
    policyVersion: ATTACHMENTS_POLICY_VERSION,
    ...(skillsHash === undefined ? {} : { skills: skillsHash }),
    ...(ruleHash === undefined ? {} : { ruleHash }),
  });
}

function materializeFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : "unknown error";
  return new Error(`git_credentials_materialize_failed: ${detail.slice(0, 300)}`);
}

function skillsMaterializeFailure(error: unknown): Error {
  const raw = error instanceof Error ? error.message : "unknown error";
  const prefix = "skills_materialize_failed:";
  const detail = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
  return new Error(`${prefix} ${detail.slice(0, 300)}`);
}

export function resolveBaselinePlugins(): string[] {
  return (process.env.HANSE_OMO_PLUGIN ?? "")
    .split(",")
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0);
}

function resolveAgentImage(app: ManagedApp): string {
  const inspection = resolveAppBuild(app.appDir);
  const buildConfigured =
    inspection.buildConfigured ?? (inspection.status === "error" || inspection.dockerfile !== null);
  const imageRef = app.imageRef?.trim();
  if (!buildConfigured) {
    return defaultImageReference();
  }
  if (imageRef !== undefined && imageRef.length > 0) {
    return imageRef;
  }
  throw new Error(
    `application ${app.id} requires a built image (status: ${app.imageStatus ?? "unknown"}); build the image before starting the agent`,
  );
}

function resolveCodegraphCommand(): string[] | undefined {
  const bin = process.env.HANSE_CODEGRAPH_BIN?.trim();
  if (bin === undefined || bin.length === 0) return undefined;
  return [process.execPath, bin, "serve", "--mcp", "--no-watch"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelString(value: unknown): string | undefined {
  if (isRecord(value)) {
    const provider = value.providerID;
    const model = value.modelID;
    if (typeof provider === "string" && typeof model === "string") {
      return `${provider}/${model}`;
    }
  }
  return typeof value === "string" && value.includes("/") ? value : undefined;
}

function webPermissionOptions(web: EffectiveSettings["web"] | undefined): WebPermissionOptions {
  if (web === undefined) return {};
  const search = web.search.value;
  const fetch = web.fetch.value;
  const managedSearch = search !== null && search.driver === "deepseek";
  const managedFetch = fetch !== null && fetch.driver === "deepseek";
  return {
    websearch: managedSearch || search === null ? ("deny" as PermissionAction) : "allow",
    webfetch: managedFetch || fetch === null ? ("deny" as PermissionAction) : "allow",
    managedSearch,
    managedFetch,
  };
}

function realParentDir(appDir: string): string {
  try {
    return path.dirname(realpathSync(appDir));
  } catch {
    return path.dirname(path.resolve(appDir));
  }
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Build supervisor resources from the documented environment defaults. */
export function resolveRuntimeResources(env: NodeJS.ProcessEnv = process.env): {
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
} {
  const memoryMb = positiveNumber(env.HANSE_APP_MEMORY_MB, DEFAULT_MEMORY_MB);
  const cpus = positiveNumber(env.HANSE_APP_CPUS, DEFAULT_CPUS);
  const pids = Math.floor(positiveNumber(env.HANSE_APP_PIDS, DEFAULT_PIDS));
  return {
    memoryBytes: Math.round(memoryMb * 1024 * 1024),
    nanoCpus: Math.round(cpus * 1_000_000_000),
    pidsLimit: pids,
  };
}

/**
 * Compare the models reported by `/agent` with the selected model. This is
 * warning-only: a project `.omo` layer or a future OMO change may win, but the
 * operator must see the mismatch instead of assuming the setting applied.
 */
export async function verifyAgentModels(
  endpoint: string,
  expected: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const authorization = authorizationFor(endpoint);
    const response = await fetchImpl(`${endpoint}/agent`, {
      headers: authorization === undefined ? {} : { authorization },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return [];
    const mismatches = new Map<string, string>();
    for (const item of data) {
      if (!isRecord(item) || typeof item.name !== "string") continue;
      const actual = modelString(item.model);
      if (actual === undefined || actual === expected) continue;
      mismatches.set(item.name, actual);
    }
    return [...mismatches].map(
      ([name, actual]) => `model_mismatch: agent "${name}" uses ${actual}, expected ${expected}`,
    );
  } catch {
    return [];
  }
}

export class InstanceManager {
  readonly #db: SqliteDatabase;
  readonly #runtimeRoot: string;
  readonly #options: InstanceManagerOptions;
  readonly #running = new Map<string, Entry>();
  readonly #monitors = new Map<string, MonitorEntry>();
  readonly #contextListeners = new Map<string, Set<(snapshot: ContextSnapshot) => void>>();
  readonly #noticeListeners = new Map<string, Set<(notice: SessionNoticeView) => void>>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #restartClaims = new Map<string, () => void>();
  readonly #launches = new Map<string, Promise<string>>();
  readonly #launchKinds = new Map<string, "ensure" | "restart">();
  readonly #preparedRestarts = new Map<string, string>();
  readonly #pending: PendingRecovery;
  readonly #sweep: ChatSweep;
  readonly #recovery: ProcessRecovery;
  #maintenanceStarted = false;
  #monitorGeneration = 0;
  #statusReconcile: Promise<void> | undefined;
  #statusTimer: ReturnType<typeof setInterval> | undefined;
  #observations: Array<{
    appId: string;
    previous: RuntimeObservation | null | undefined;
    current: RuntimeObservation;
  }> = [];

  constructor(db: SqliteDatabase, runtimeRoot: string, options: InstanceManagerOptions) {
    this.#db = db;
    this.#runtimeRoot = runtimeRoot;
    this.#options = options;
    this.#pending = new PendingRecovery({
      db,
      endpointFor: (appId) => this.endpointFor(appId),
      monitorState: (appId) => this.monitorState(appId),
      agentsHome: runtimeRoot,
    });
    this.#sweep = new ChatSweep({
      db,
      agentsHome: runtimeRoot,
      endpointFor: (appId) => this.endpointFor(appId),
    });
    this.#recovery = new ProcessRecovery({
      db,
      runtimeStatus: (appId) => this.#options.runtime.status(appId),
      endpointFor: (appId) => this.endpointFor(appId),
      listSessionsBounded,
      listSessionStatuses,
      listMessages,
      listMessagePage,
      sendPromptAsync: this.#options.sendPromptAsync ?? sendPromptAsync,
      waitForReady: (appId, endpoint) => this.#awaitReady(appId, endpoint),
      isRestarting: (appId) => this.isRestarting(appId),
      isDeploymentLocked: () => this.#options.deploymentLock?.isActive() ?? false,
      now: () => Date.now(),
      ...(this.#options.logger === undefined ? {} : { logger: this.#options.logger }),
      onNotice: (appId, notice) => this.#emitNotice(appId, notice),
    });
  }

  /** Whether the agent runs behind the runner (container-visible paths) or a host supervisor. */
  attachmentsPathMode(): AttachmentPathMode {
    return this.#options.hostWorkspace !== undefined && this.#options.hostAgents !== undefined
      ? "host"
      : "container";
  }

  /** Fixed container agents root used by the runner mapping. */
  containerAgentsRoot(): string {
    return DEFAULT_AGENT_AGENTS_ROOT;
  }

  /** The single model-visible attachments root (manifest + policy). */
  attachmentVisibleRoot(app: { projectId: string; appKey: string }): string {
    return resolveAttachmentVisibleRoot({
      agentsHome: this.#runtimeRoot,
      projectId: app.projectId,
      appKey: app.appKey,
      pathMode: this.attachmentsPathMode(),
    });
  }

  /** Pending-send confirmation state machine shared by the HTTP routes and the event monitor. */
  get pendingRecovery(): PendingRecovery {
    return this.#pending;
  }

  /**
   * Whether an app has a connected event monitor. `disabled` also covers a stopped app, so a send
   * opens the fallback subscription before dispatch.
   */
  monitorState(appId: string): MonitorState {
    if (!this.#monitorsEnabled()) return "disabled";
    const entry = this.#monitors.get(appId);
    if (entry === undefined) return "disabled";
    return entry.monitor.state?.() ?? "connecting";
  }

  armPendingConfirmation(appId: string): void {
    this.#pending.arm(appId);
  }

  /** Attach the shared fallback subscription before a dispatch when the monitor is not connected. */
  preparePendingConfirmation(appId: string): Promise<void> {
    return this.#pending.ensureFallback(appId);
  }

  /** Coordinator startup: settle abandoned sends, arm recovery, and start the daily sweep. */
  startChatMaintenance(): void {
    if (this.#maintenanceStarted) return;
    this.#maintenanceStarted = true;
    try {
      runAttachmentMaintenance(this.#db, this.#runtimeRoot, {
        startup: true,
        activeIds: activeUploadIds,
      });
    } catch {
      // A missing/unmigrated table must never block coordinator startup.
    }
    try {
      this.#pending.transitionStaleSending(PENDING_CONFIRMATION_STALE_MS);
      const rows = this.#db
        .prepare("SELECT DISTINCT app_id AS appId FROM pending_sends")
        .all() as Array<{ appId: string }>;
      for (const row of rows) {
        this.#pending.arm(row.appId);
      }
    } catch {
      // A missing/unmigrated table must never block coordinator startup.
    }
    this.#sweep.start();
  }

  ensure(app: ManagedApp, options: EnsureOptions = {}): Promise<string> {
    if (!path.isAbsolute(app.appDir)) {
      return Promise.reject(
        new Error(`application directory must be an absolute resolved path: ${app.appDir}`),
      );
    }
    const inFlight = this.#launches.get(app.id);
    if (inFlight !== undefined) {
      if (this.#launchKinds.get(app.id) === "ensure") {
        return inFlight;
      }
      return inFlight.then((endpoint) =>
        endpoint.length > 0 ? endpoint : this.#startEnsure(app, options),
      );
    }
    return this.#startEnsure(app, options);
  }

  #startEnsure(app: ManagedApp, options: EnsureOptions): Promise<string> {
    return this.#registerLaunch(
      app.id,
      () => this.#withAppLock(app.id, () => this.#ensureAppLocked(app, options)),
      "ensure",
    );
  }

  async #ensureAppLocked(app: ManagedApp, options: EnsureOptions): Promise<string> {
    // The durable marker, not the caller's snapshot, decides whether starting is allowed.
    const marker = this.#db
      .prepare(
        `SELECT a.deleting AS appDeleting, p.deleting AS projectDeleting
         FROM apps a
         JOIN projects p ON p.id = a.project_id
         WHERE a.id = ?`,
      )
      .get(app.id) as { appDeleting: number; projectDeleting: number } | undefined;
    if (marker !== undefined && (marker.appDeleting === 1 || marker.projectDeleting === 1)) {
      throw new DeletionPendingError(app.id);
    }
    this.#assertNoStateCollision(app);
    const identity = { projectId: app.projectId, app: app.appKey };
    const tokenFile = mcpTokenPath(this.#runtimeRoot, identity);
    const isolated = resolveInstanceEnv(this.#runtimeRoot, identity);
    mkdirSync(path.dirname(isolated.HOME), { recursive: true, mode: 0o700 });
    mkdirSync(isolated.HOME, { recursive: true, mode: 0o700 });
    const passwordFile = opencodePasswordPath(isolated.XDG_STATE_HOME);
    const existing = this.#running.get(app.id);
    const current = await this.#options.runtime.status(app.id);
    // The runner reports a merely created container as "starting"; reconnecting to that endpoint
    // would leave it unstarted forever, so only a genuinely running container is reusable.
    const running = current !== undefined && current.state === "running";
    const existingPassword = readOpencodePassword(passwordFile);
    const source: ProcessSource =
      (options.origin ?? "operator") === "operator" ? "operator" : "system";
    const reason = options.reason ?? (source === "operator" ? "start" : "lazy_start");
    if (running && existingPassword !== undefined) {
      const persisted = readProcess(this.#db, app.id);
      const reconnectAttemptId = persisted.attemptId ?? this.#syntheticAttemptId(app.id);
      if (persisted.state !== "running") {
        this.#transitionProcess(app.id, {
          attemptId: reconnectAttemptId,
          state: "starting",
          phase: "waiting_ready",
          source: "system",
          reason: "reconnect",
        });
      }
      // A running container's token is reconciled in place; a failure must never fall through to
      // delete/recreate because that would destroy an in-flight turn and cannot fix a file error.
      try {
        ensureAgentToken(this.#db, app.id, tokenFile);
      } catch (error) {
        this.#assertDeploymentUnlocked("ensure");
        this.#transitionProcess(app.id, {
          attemptId: reconnectAttemptId,
          state: "error",
          phase: "failed",
          source: "system",
          reason: "reconnect",
          errorCode: "token_reconcile_failed",
          message: error,
        });
        throw new AgentTokenReconcileError(app.id, error);
      }
      // Reconnect after a coordinator restart or a caller retry. Settings/spec changes stay
      // "restart required" until an explicit stop and restart.
      this.#recordAppliedImageId(app.id, current.imageId);
      const persistedSettings = this.#db
        .prepare(
          `SELECT applied_settings_hash AS appliedSettingsHash,
                  applied_profile AS appliedProfile,
                  applied_skills_hash AS appliedSkillsHash,
                  applied_rule_hash AS appliedRuleHash
           FROM instances WHERE app_id = ?`,
        )
        .get(app.id) as
        | {
            appliedSettingsHash: string | null;
            appliedProfile: number | null;
            appliedSkillsHash: string | null;
            appliedRuleHash: string | null;
          }
        | undefined;
      this.#restoreProcessRuleOnReconnect(
        app.id,
        isolated,
        persistedSettings?.appliedRuleHash ?? null,
      );
      const endpoint = current.endpoint ?? existing?.endpoint;
      if (endpoint !== undefined && endpoint !== null) {
        setEndpointAuthorization(endpoint, OPENCODE_BASIC_USERNAME, existingPassword);
        const shouldVerify = existing === undefined || existing.endpoint !== endpoint;
        if (shouldVerify) {
          try {
            await this.#awaitReady(app.id, endpoint);
          } catch (error) {
            this.#transitionProcess(app.id, {
              attemptId: reconnectAttemptId,
              state: "error",
              phase: "failed",
              source: "system",
              reason: "reconnect",
              errorCode: "readiness_timeout",
              message: error,
              status: current,
            });
            throw error;
          }
          this.#transitionProcess(app.id, {
            attemptId: reconnectAttemptId,
            state: "running",
            phase: "ready",
            source: "system",
            reason: "reconnect",
            status: current,
            clearError: true,
          });
        }
        if (existing === undefined) {
          const entry: Entry = {
            endpoint,
            projectId: app.projectId,
            appKey: app.appKey,
            policyWarnings: [],
            settingsHash: persistedSettings?.appliedSettingsHash ?? undefined,
            appliedProfile:
              persistedSettings?.appliedProfile === null ||
              persistedSettings?.appliedProfile === undefined
                ? undefined
                : persistedSettings.appliedProfile !== 0,
            appliedSkillsHash: persistedSettings?.appliedSkillsHash ?? undefined,
          };
          this.#running.set(app.id, entry);
          this.#startMonitor(app, entry);
        } else {
          if (existing.endpoint !== endpoint) {
            this.#stopMonitor(app.id);
            clearEndpointAuthorization(existing.endpoint);
            existing.endpoint = endpoint;
          }
          this.#startMonitor(app, existing);
        }
        this.armPendingConfirmation(app.id);
        return endpoint;
      }
      // Running/starting without an endpoint is not reconnectable; under a lock it must throw
      // before any delete, which the destructive path's guard enforces.
    }
    const end = this.#beginLifecycle("ensure");
    try {
      this.#assertDeploymentUnlocked("ensure");
      return await this.#ensureLocked(app, { source, reason });
    } finally {
      end();
    }
  }

  /** Destructive start/recreate path. Callers hold the app lock and the deployment guard. */
  async #ensureLocked(app: ManagedApp, context?: EnsureAttemptContext): Promise<string> {
    const marker = this.#db
      .prepare(
        `SELECT a.deleting AS appDeleting, p.deleting AS projectDeleting
         FROM apps a
         JOIN projects p ON p.id = a.project_id
         WHERE a.id = ?`,
      )
      .get(app.id) as { appDeleting: number; projectDeleting: number } | undefined;
    if (marker !== undefined && (marker.appDeleting === 1 || marker.projectDeleting === 1)) {
      throw new DeletionPendingError(app.id);
    }
    // Launch authority comes from the current row, not the caller's display snapshot.
    app = this.#authoritativeApp(app);
    this.#assertNoStateCollision(app);
    const attempt: ProcessAttemptContext = {
      attemptId: context?.attemptId ?? newAttemptId(),
      source: context?.source ?? "system",
      reason: context?.reason ?? "start",
    };
    if (context?.attemptId === undefined) {
      this.#transitionProcess(app.id, {
        attemptId: attempt.attemptId,
        state: "starting",
        phase: "requested",
        source: attempt.source,
        reason: attempt.reason,
        clearError: true,
      });
    }
    let lastStatus: RuntimeStatus | undefined;
    try {
      await this.#preflightImage(app);
      // Adoption can select a new image ref; resolve the launch image from the adopted row.
      app = this.#authoritativeApp(app);
      this.#transitionProcess(app.id, {
        attemptId: attempt.attemptId,
        state: "starting",
        phase: "preparing",
        source: attempt.source,
        reason: attempt.reason,
      });
      const identity = { projectId: app.projectId, app: app.appKey };
      const tokenFile = mcpTokenPath(this.#runtimeRoot, identity);
      const isolated = resolveInstanceEnv(this.#runtimeRoot, identity);
      mkdirSync(path.dirname(isolated.HOME), { recursive: true, mode: 0o700 });
      mkdirSync(isolated.HOME, { recursive: true, mode: 0o700 });
      this.#ensureAttachmentsRoot(isolated.HOME);
      writeAppliedRule(isolated, PROCESS_RULE_TEXT);
      writeProcessRule(isolated, PROCESS_RULE_TEXT);
      const passwordFile = opencodePasswordPath(isolated.XDG_STATE_HOME);
      const existing = this.#running.get(app.id);
      const current = await this.#options.runtime.status(app.id);
      const baselinePlugins = resolveBaselinePlugins();
      const skills = this.#options.skills;
      const skillsTarget = { projectId: app.projectId, appKey: app.appKey };
      const skillOptions: SkillApplyOptions = {
        appRoot: path.dirname(isolated.HOME),
        home: isolated.HOME,
        xdgCacheHome: isolated.XDG_CACHE_HOME,
        appDir: app.appDir,
        baselinePlugins,
      };
      let skillsHash: string | undefined;
      let skillCapture: SkillCapture | undefined;
      if (skills !== undefined) {
        try {
          skillCapture = skills.capture(skillsTarget);
          const probed = skills.probe(
            skillsTarget,
            isolated.XDG_CONFIG_HOME,
            skillOptions,
            skillCapture,
          );
          skillsHash = skillCapture.hash ?? probed.hash;
          this.#logSkillWarnings(app.id, "probe", probed);
        } catch (error) {
          throw skillsMaterializeFailure(error);
        }
      }

      const image = resolveAgentImage(app);
      if (existing !== undefined || current !== undefined) {
        this.#options.previews?.clearApp(app.id);
      }
      if (existing !== undefined) {
        this.#stopMonitor(app.id);
        clearEndpointAuthorization(existing.endpoint);
        this.#running.delete(app.id);
        await this.#options.runtime.delete(app.id);
      } else if (current !== undefined) {
        await this.#options.runtime.delete(app.id);
      }

      if (skills !== undefined) {
        try {
          const applied = skills.apply(
            skillsTarget,
            isolated.XDG_CONFIG_HOME,
            skillOptions,
            skillCapture,
          );
          skillsHash = skillCapture?.hash ?? applied.hash;
          this.#logSkillWarnings(app.id, "apply", applied);
        } catch (error) {
          const failure = skillsMaterializeFailure(error);
          this.#recordSkillsError(app.id, failure);
          throw failure;
        }
      }

      let model: string | undefined;
      let auth: Record<string, unknown> | undefined;
      let omoProfile: string | undefined;
      let mcpServers: Record<string, McpLocalServer> | undefined;
      let web: EffectiveSettings["web"] | undefined;
      let gitEnv: Record<string, string> = {};
      let settingsHash: string | undefined;
      let appliedProfile = true;
      let profileWarning: string | undefined;

      const settings = this.#options.settings;
      const omoProfiles = this.#options.omoProfiles;
      const modelProviderSnapshot = this.#options.modelProviders?.snapshot();
      if (settings !== undefined && omoProfiles !== undefined) {
        const snapshot = settings.snapshot({ projectId: app.projectId, appKey: app.appKey });
        web = snapshot.resolved.effective.web;
        model = snapshot.resolved.effective.llm.model.value ?? DEFAULT_MODEL;
        if (app.gitCredentials !== false) {
          try {
            gitEnv = materializeGitCredentials({
              agentsRoot: this.#runtimeRoot,
              appRoot: path.dirname(isolated.HOME),
              home: isolated.HOME,
              projectId: app.projectId,
              appKey: app.appKey,
              identity: {
                name: snapshot.resolved.effective.git.user.name.value,
                email: snapshot.resolved.effective.git.user.email.value,
              },
              auth: snapshot.gitAuth,
            });
          } catch (error) {
            throw materializeFailure(error);
          }
        }
        const profile = await omoProfiles.ensure(
          {
            appId: app.id,
            model,
            disableWebsearch: disableWebsearch(web),
          },
          path.join(isolated.HOME, ".omo", "omo.jsonc"),
        );
        auth = snapshot.mergedAuth;
        omoProfile = profile.applied ? profile.name : undefined;
        appliedProfile = profile.applied;
        profileWarning = profile.warning;
        settingsHash = settingsHashFor(
          snapshot,
          profile.contentHash,
          skillsHash,
          modelProviderSnapshot?.hash,
          PROCESS_RULE_HASH,
        );
        const webConfig = buildWebMcpConfig(web);
        if (webConfig !== undefined) {
          mcpServers = {
            hanse_web: {
              type: "local",
              command: [process.execPath, process.argv[1] ?? "", "web-mcp"],
              enabled: true,
              environment: {
                HANSE_WEB_CONFIG: JSON.stringify(webConfig),
                HANSE_OPENCODE_AUTH_FILE: path.join(
                  isolated.XDG_DATA_HOME,
                  "opencode",
                  "auth.json",
                ),
              },
            },
          };
        }
      }

      const authFile = path.join(isolated.XDG_DATA_HOME, "opencode", "auth.json");
      if (auth !== undefined) {
        writeAuthFile(authFile, auth);
      }

      ensureAgentToken(this.#db, app.id, tokenFile);
      const password = ensureOpencodePassword(passwordFile);

      const agentApiBase = process.env.HANSE_AGENT_API_BASE?.trim();
      const coordinatorEnvironment = {
        HANSE_MCP_API_BASE:
          agentApiBase !== undefined && agentApiBase.length > 0
            ? agentApiBase
            : DEFAULT_AGENT_API_BASE,
        HANSE_AGENT_TOKEN_FILE: tokenFile,
      };
      const permission = buildPermissionPolicy(
        resolvePermissionPaths({
          home: isolated.HOME,
          xdgDataHome: isolated.XDG_DATA_HOME,
          xdgConfigHome: isolated.XDG_CONFIG_HOME,
          xdgCacheHome: isolated.XDG_CACHE_HOME,
          tmpdir: isolated.TMPDIR,
          attachmentsRoot: this.attachmentVisibleRoot(app),
          baselinePlugins,
        }),
        {
          ...webPermissionOptions(web),
          denyPatterns: credentialDenyPatterns({
            appRoot: path.dirname(isolated.HOME),
            home: isolated.HOME,
            xdgDataHome: isolated.XDG_DATA_HOME,
            passwordFile,
          }),
        },
      );
      const sharedInstructions = materializeSharedInstructions(
        isolated,
        app.sharedInstructions ?? [],
      );
      const overlay = buildConfigOverlay({
        coordinatorCommand: [process.execPath, process.argv[1] ?? "", "mcp"],
        codegraphCommand: resolveCodegraphCommand(),
        environment: coordinatorEnvironment,
        instructions: [
          ...sharedInstructions,
          ...(app.instructions ?? []),
          processRulePath(isolated),
        ],
        plugins: baselinePlugins,
        permission,
        model,
        providers: modelProviderSnapshot?.overlay,
        mcpServers,
      });
      assertOverlayBytes(overlay);
      const env: Record<string, string> = {
        HOME: isolated.HOME,
        XDG_DATA_HOME: isolated.XDG_DATA_HOME,
        XDG_STATE_HOME: isolated.XDG_STATE_HOME,
        XDG_CONFIG_HOME: isolated.XDG_CONFIG_HOME,
        XDG_CACHE_HOME: isolated.XDG_CACHE_HOME,
        OPENCODE_DB: isolated.OPENCODE_DB,
        TMPDIR: isolated.TMPDIR,
        MISE_DATA_DIR: isolated.MISE_DATA_DIR,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay),
        GIT_CEILING_DIRECTORIES: realParentDir(app.appDir),
        HANSE_OPENCODE_PASSWORD_FILE: passwordFile,
        ...NON_INTERACTIVE_SHELL_ENV,
        ...BASH_DEFAULT_TIMEOUT_ENV,
        ...gitEnv,
        ...(omoProfile === undefined ? {} : { OMO_PROFILE: omoProfile }),
        ...(existsSync(authFile) ? { HANSE_OPENCODE_AUTH_FILE: authFile } : {}),
      };
      const workspaceRoot = this.#options.workspaceRoot ?? path.dirname(path.resolve(app.appDir));
      const agentsRoot = this.#options.agentsRoot ?? this.#runtimeRoot;
      const hostWorkspace = this.#options.hostWorkspace;
      const hostAgents = this.#options.hostAgents;
      const hostPaths = hostWorkspace !== undefined && hostAgents !== undefined;
      const specAppDir = hostPaths
        ? mapToHostPath(workspaceRoot, app.appDir, hostWorkspace, "appDir")
        : app.appDir;
      const specStateDir = hostPaths
        ? mapToHostPath(agentsRoot, isolated.XDG_STATE_HOME, hostAgents, "stateDir")
        : isolated.XDG_STATE_HOME;
      const specNetworkName = hostPaths ? appNetworkName(app.id) : "agents";
      const specPort = hostPaths ? RUNNER_APP_PORT : undefined;
      const hashInput: SpecHashInput = {
        appId: app.id,
        image,
        pathMode: hostPaths ? "host" : "container",
        appDir: specAppDir,
        ...(app.appDirReadOnly === true ? { appDirReadOnly: true } : {}),
        ...(hostPaths ? { attachmentsReadOnly: true } : {}),
        stateDir: specStateDir,
        networkName: specNetworkName,
        ...(specPort === undefined ? {} : { port: specPort }),
        env,
        resources: resolveRuntimeResources(),
        labels: {
          "hanse.managed": "true",
          "hanse.app.id": app.id,
          ...(hostPaths ? { "hanse.agents.root": path.dirname(specStateDir) } : {}),
        },
      };
      const spec: AppRuntimeSpec = validateAppRuntimeSpec(
        { ...hashInput, specHash: computeSpecHash(hashInput) },
        {
          workspaceRoot: hostPaths ? hostWorkspace : workspaceRoot,
          agentsRoot: hostPaths ? hostAgents : agentsRoot,
        },
      );

      this.#transitionProcess(app.id, {
        attemptId: attempt.attemptId,
        state: "starting",
        phase: "creating",
        source: attempt.source,
        reason: attempt.reason,
        image,
        settingsHash,
        appliedProfile,
        appliedSkillsHash: skillsHash,
        appliedRuleHash: PROCESS_RULE_HASH,
      });
      const status = await this.#options.runtime.ensure(spec);
      lastStatus = status;
      if ((status.state !== "running" && status.state !== "starting") || status.endpoint === null) {
        throw new Error(`agent runtime did not start ${app.id}: ${status.error ?? status.state}`);
      }
      this.#transitionProcess(app.id, {
        attemptId: attempt.attemptId,
        state: "starting",
        phase: "waiting_ready",
        source: attempt.source,
        reason: attempt.reason,
        status,
        image,
        settingsHash,
        appliedProfile,
        appliedSkillsHash: skillsHash,
        appliedRuleHash: PROCESS_RULE_HASH,
      });
      const endpoint = status.endpoint;
      setEndpointAuthorization(endpoint, OPENCODE_BASIC_USERNAME, password);
      try {
        await this.#awaitReady(app.id, endpoint);
      } catch (error) {
        this.#transitionProcess(app.id, {
          attemptId: attempt.attemptId,
          state: "error",
          phase: "failed",
          source: attempt.source,
          reason: attempt.reason,
          errorCode: "readiness_timeout",
          message: error,
          status,
        });
        throw error;
      }
      await this.#recordStatus(
        app,
        status,
        image,
        settingsHash,
        appliedProfile,
        PROCESS_RULE_HASH,
        skillsHash,
      );

      const entry: Entry = {
        endpoint,
        projectId: app.projectId,
        appKey: app.appKey,
        policyWarnings: [],
        settingsHash,
        appliedProfile,
        appliedSkillsHash: skillsHash,
        profileWarning,
      };
      this.#running.set(app.id, entry);
      this.#startMonitor(app, entry);
      this.armPendingConfirmation(app.id);
      entry.policyWarnings = await this.#verifyPolicy(app, isolated, endpoint);
      const policyDiagnostics = entry.policyWarnings.filter((warning) =>
        warning.trim().startsWith("policy_unverified:"),
      );
      if (policyDiagnostics.length > 0) {
        this.#options.logger?.warn("policy_verification_failed", {
          appId: app.id,
          warnings: policyDiagnostics.slice(0, 5).map((warning) => warning.slice(0, 300)),
        });
      }
      if (model !== undefined) {
        const verifyModel = this.#options.modelVerifier ?? verifyAgentModels;
        entry.modelWarnings = await verifyModel(endpoint, model);
      }
      return endpoint;
    } catch (error) {
      try {
        this.#transitionProcess(app.id, {
          attemptId: attempt.attemptId,
          state: "error",
          phase: "failed",
          source: attempt.source,
          reason: attempt.reason,
          errorCode: processErrorCode(error),
          message: error,
          ...(lastStatus === undefined ? {} : { status: lastStatus }),
        });
      } catch {
        // A failed status write must not mask the original start failure.
      }
      throw error;
    }
  }

  async #awaitReady(appId: string, endpoint: string): Promise<void> {
    if (this.#options.waitForReady !== undefined) {
      await this.#options.waitForReady(appId, endpoint);
    }
  }

  /**
   * Pre-create the attachments root next to the existing app-root/HOME directories. The runner's
   * host-agents mount is read-only, so the coordinator owns creation; uid 1000 matches the agent
   * container user where the coordinator has the privilege to set it.
   */
  #ensureAttachmentsRoot(home: string): void {
    const root = path.join(path.dirname(home), "attachments");
    const existing = lstatSync(root, { throwIfNoEntry: false });
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw new Error("attachment root is not a safe directory");
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const created = lstatSync(root, { throwIfNoEntry: false });
    if (created === undefined || created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("attachment root is not a safe directory");
    }
    try {
      chmodSync(root, 0o700);
    } catch {
      // Existing permissions are still validated by the storage layer.
    }
    try {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        chownSync(root, 1000, 1000);
      }
    } catch {
      // Non-root coordinators rely on the pre-existing agents-volume ownership.
    }
  }

  /** Re-read the image fields that decide which image a destructive start may launch. */
  #authoritativeApp(app: ManagedApp): ManagedApp {
    const row = this.#db
      .prepare(
        `SELECT a.project_id AS projectId, a.app_key AS appKey,
                a.image_ref AS imageRef, a.image_status AS imageStatus,
                v.image_id AS imageId
         FROM apps a
         LEFT JOIN app_image_versions v
           ON v.app_id = a.id AND v.image_ref = a.image_ref
         WHERE a.id = ?`,
      )
      .get(app.id) as
      | {
          projectId: string;
          appKey: string;
          imageRef: string | null;
          imageStatus: AppImageStatus;
          imageId: string | null;
        }
      | undefined;
    if (row === undefined) {
      return app;
    }
    return {
      ...app,
      projectId: row.projectId,
      appKey: row.appKey,
      imageRef: row.imageRef,
      imageStatus: row.imageStatus,
      imageId: row.imageId,
    };
  }

  #assertNoStateCollision(app: ManagedApp): void {
    const projectSegment = sanitizeAppKey(app.projectId);
    const appSegment = sanitizeAppKey(app.appKey);
    const sibling = this.#db
      .prepare("SELECT id, project_id AS projectId, app_key AS appKey FROM apps WHERE id <> ?")
      .all(app.id) as Array<{ id: string; projectId: string; appKey: string }>;
    const collision = sibling.find(
      (candidate) =>
        sanitizeAppKey(candidate.projectId) === projectSegment &&
        sanitizeAppKey(candidate.appKey) === appSegment,
    );
    if (collision !== undefined) {
      throw new Error(
        `state_path_collision: application ${app.appKey} shares its state path with ${collision.appKey}`,
      );
    }
  }

  isRunning(appId: string): boolean {
    return this.#running.has(appId);
  }

  #recordAppliedImageId(appId: string, imageId: string | null | undefined): void {
    if (imageId === null || imageId === undefined || imageId.length === 0) {
      return;
    }
    this.#db
      .prepare("UPDATE instances SET applied_image_id = ? WHERE app_id = ?")
      .run(imageId, appId);
  }

  /**
   * Adopt a durable build, then reject a start/restart whose target image is unusable.
   *
   * Runs before any destructive runtime call so an image failure leaves a live container untouched.
   */
  async #preflightImage(app: ManagedApp): Promise<void> {
    const images = this.#options.images;
    if (images === undefined) {
      return;
    }
    await images.adoptBuild(app.id);
    const view = await images.imageState(app.id);
    if (view.buildConfigured) {
      if (view.usableImageRef === null) {
        throw new ImageNotReadyError(view);
      }
    } else if (view.targetImageId === null) {
      throw new DefaultImageUnavailableError(view);
    }
  }

  /**
   * Image preflight for the synchronous restart route, before any claim or 202.
   *
   * A running app gets a `requested` attempt before the image check; a stopped app is never
   * preflighted, started, or given an attempt.
   */
  async preflightRestart(app: ManagedApp): Promise<boolean> {
    return this.#withAppLock(app.id, async () => {
      const status = await this.#options.runtime.status(app.id);
      if (status === undefined || (status.state !== "running" && status.state !== "starting")) {
        this.#preparedRestarts.delete(app.id);
        return false;
      }
      const attemptId = newAttemptId();
      await this.#transitionProcess(app.id, {
        attemptId,
        state: "starting",
        phase: "requested",
        source: "operator",
        reason: "restart",
        clearError: true,
      });
      try {
        await this.#preflightImage(app);
      } catch (error) {
        this.#preparedRestarts.delete(app.id);
        try {
          this.#transitionProcess(app.id, {
            attemptId,
            state: "error",
            phase: "failed",
            source: "operator",
            reason: "restart",
            errorCode: processErrorCode(error),
            message: error,
          });
        } catch {
          // The original typed image error is the caller's contract.
        }
        throw error;
      }
      this.#preparedRestarts.set(app.id, attemptId);
      return true;
    });
  }

  pendingRestart(appId: string): { pending: boolean; reasons: string[] } {
    const settings = this.#options.settings;
    const omoProfiles = this.#options.omoProfiles;
    if (settings === undefined || omoProfiles === undefined) {
      return { pending: false, reasons: [] };
    }
    const entry = this.#running.get(appId);
    if (entry !== undefined) {
      return this.#pendingRestartFor(
        {
          appId,
          projectId: entry.projectId,
          appKey: entry.appKey,
          settingsHash: entry.settingsHash,
          appliedProfile: entry.appliedProfile,
          appliedSkillsHash: entry.appliedSkillsHash,
        },
        settings,
        omoProfiles,
      );
    }
    const row = this.#db
      .prepare(
        `SELECT a.project_id AS projectId,
                a.app_key AS appKey,
                COALESCE(i.runtime_state, i.state) AS state,
                i.applied_settings_hash AS appliedSettingsHash,
                i.applied_profile AS appliedProfile,
                i.applied_skills_hash AS appliedSkillsHash
         FROM instances i
         JOIN apps a ON a.id = i.app_id
         WHERE i.app_id = ?`,
      )
      .get(appId) as
      | {
          projectId: string;
          appKey: string;
          state: string;
          appliedSettingsHash: string | null;
          appliedProfile: number | null;
          appliedSkillsHash: string | null;
        }
      | undefined;
    if (row === undefined || (row.state !== "running" && row.state !== "starting")) {
      return { pending: false, reasons: [] };
    }
    return this.#pendingRestartFor(
      {
        appId,
        projectId: row.projectId,
        appKey: row.appKey,
        settingsHash: row.appliedSettingsHash ?? undefined,
        appliedProfile: row.appliedProfile === null ? undefined : row.appliedProfile !== 0,
        appliedSkillsHash: row.appliedSkillsHash ?? undefined,
      },
      settings,
      omoProfiles,
    );
  }

  #pendingRestartFor(
    target: {
      appId: string;
      projectId: string;
      appKey: string;
      settingsHash?: string;
      appliedProfile?: boolean;
      appliedSkillsHash?: string;
    },
    settings: SettingsSource,
    omoProfiles: OmoProfileSource,
  ): { pending: boolean; reasons: string[] } {
    if (
      target.appliedProfile === undefined ||
      (target.settingsHash === undefined && target.appliedSkillsHash === undefined)
    ) {
      return { pending: true, reasons: ["applied_state_unknown"] };
    }
    const reasons: string[] = [];
    if (target.appliedProfile === false) {
      reasons.push("profile_not_applied");
    }
    try {
      const snapshot = settings.snapshot({
        projectId: target.projectId,
        appKey: target.appKey,
      });
      const effective = snapshot.resolved.effective;
      const model = effective.llm.model.value ?? DEFAULT_MODEL;
      const preview = omoProfiles.preview({
        appId: target.appId,
        model,
        disableWebsearch: disableWebsearch(effective.web),
      });
      const currentSkillsHash = this.#options.skills?.hash({
        projectId: target.projectId,
        appKey: target.appKey,
      });
      if (target.appliedSkillsHash === undefined) {
        if (
          settingsHashFor(
            snapshot,
            preview.contentHash,
            currentSkillsHash,
            this.#options.modelProviders?.snapshot().hash,
            PROCESS_RULE_HASH,
          ) !== target.settingsHash
        ) {
          reasons.push("settings_changed");
        }
      } else {
        const settingsWithApplied = settingsHashFor(
          snapshot,
          preview.contentHash,
          target.appliedSkillsHash,
          this.#options.modelProviders?.snapshot().hash,
          PROCESS_RULE_HASH,
        );
        if (settingsWithApplied !== target.settingsHash) {
          reasons.push("settings_changed");
        } else if (target.appliedSkillsHash !== currentSkillsHash) {
          reasons.push("skills_changed");
        }
      }
    } catch {
      reasons.push("settings_changed");
    }
    return { pending: reasons.length > 0, reasons };
  }

  async stopApp(appId: string): Promise<boolean> {
    return this.#withAppLock(appId, async () => {
      const end = this.#beginLifecycle("stop");
      try {
        this.#assertDeploymentUnlocked("stop");
        return await this.#stopLocked(appId, "stop");
      } finally {
        end();
      }
    });
  }

  /**
   * Stop an application and durably mark it deleting in the same per-app lock body.
   *
   * A queued `ensure` therefore either runs before the stop (and is stopped) or after the marker is
   * committed (and is refused). Existing markers on the target are ignored so a retry works. Only
   * `ensure` throws {@link DeletionPendingError}. A caller that already took the deployment guard
   * and opened its activity span passes `{ lockChecked: true }` so the nested stop does not recheck.
   */
  async stopForDeletion(appId: string, options: { lockChecked?: boolean } = {}): Promise<boolean> {
    return this.#withAppLock(appId, async () => {
      if (options.lockChecked === true) {
        return this.#stopForDeletionLocked(appId);
      }
      const end = this.#beginLifecycle("stop_for_deletion");
      try {
        this.#assertDeploymentUnlocked("stop_for_deletion");
        return await this.#stopForDeletionLocked(appId);
      } finally {
        end();
      }
    });
  }

  async #stopForDeletionLocked(appId: string): Promise<boolean> {
    const stopped = await this.#stopLocked(appId, "delete");
    this.#db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(appId);
    return stopped;
  }

  async #stopLocked(
    appId: string,
    reason: StopIntentReason,
    options: { terminal?: boolean; attemptId?: string } = {},
  ): Promise<boolean> {
    const terminal = options.terminal ?? true;
    const entry = this.#running.get(appId);
    let status: Awaited<ReturnType<AgentRuntimeClient["status"]>>;
    try {
      status = await this.#options.runtime.status(appId);
    } catch {
      status = undefined;
    }
    const wasRunning =
      entry !== undefined ||
      (status !== undefined && (status.state === "running" || status.state === "starting"));
    const endpoint = entry?.endpoint ?? status?.endpoint ?? undefined;
    const persisted = readProcess(this.#db, appId);
    const attemptId = options.attemptId ?? persisted.attemptId ?? this.#syntheticAttemptId(appId);
    const source: ProcessSource = reason === "delete" ? "system" : "operator";
    await this.#recovery.recordStopIntent(appId, reason);
    const stoppedAt = new Date().toISOString();
    this.#db
      .prepare("UPDATE instances SET last_stop_reason = ?, last_stop_at = ? WHERE app_id = ?")
      .run(reason, stoppedAt, appId);
    this.#transitionProcess(appId, {
      attemptId,
      state: "starting",
      phase: "stopping",
      source,
      reason,
    });
    let finalStatus: Awaited<ReturnType<AgentRuntimeClient["delete"]>>;
    try {
      finalStatus = await this.#options.runtime.delete(appId);
    } catch (error) {
      // The runtime may have stopped the container before failing; re-read the truth best-effort.
      // Keep the in-memory entry and endpoint auth so a retry and the running UI stay truthful.
      await this.#options.runtime.status(appId).catch(() => undefined);
      this.#transitionProcess(appId, {
        attemptId,
        state: "error",
        phase: "failed",
        source: "runtime",
        reason,
        errorCode: "runtime_unavailable",
        message: error,
      });
      throw error;
    }
    this.#options.previews?.clearApp(appId);
    this.#stopMonitor(appId);
    this.#running.delete(appId);
    if (endpoint !== undefined && endpoint !== null) {
      clearEndpointAuthorization(endpoint);
    }
    if (terminal) {
      await this.#recordStatusById(appId, finalStatus, {
        attemptId,
        source,
        reason,
        clearError: true,
      });
    }
    this.#revokeAgentToken(appId, entry);
    return wasRunning;
  }

  /**
   * Reconcile persisted `instances` state with the runtime after a coordinator restart or an
   * out-of-band container stop. Only rows that still claim to be running/starting are probed;
   * transport failures leave the last known state untouched so a temporarily unavailable runner
   * cannot turn a live agent into a stopped one.
   */
  reconcileStatuses(): Promise<void> {
    if (this.#statusReconcile !== undefined) {
      return this.#statusReconcile;
    }
    const run = this.#reconcileStatuses().finally(() => {
      this.#statusReconcile = undefined;
    });
    this.#statusReconcile = run;
    return run;
  }

  /** Start the best-effort background reconciler; safe to call more than once. */
  startStatusReconciler(intervalMs = 15_000): void {
    if (this.#statusTimer !== undefined) {
      return;
    }
    this.#recovery.start();
    const tick = (): void => {
      void this.reconcileStatuses().catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    this.#statusTimer = timer;
  }

  stopStatusReconciler(): void {
    this.#recovery.stop();
    if (this.#statusTimer === undefined) {
      return;
    }
    clearInterval(this.#statusTimer);
    this.#statusTimer = undefined;
  }

  /**
   * Claim a restart synchronously and run it on the next tick.
   *
   * A duplicate claim returns `{ accepted: false }` without a completion promise. The claim is
   * persisted before the caller can answer `202`, so a coordinator exit mid-restart is repaired by
   * the next startup's restart-claim recovery pass. Errors are logged, reflected in the instance
   * row, and rejected only to sync callers.
   */
  beginRestart(app: ManagedApp): RestartClaim {
    const release = this.#acquireRestartClaim(app.id);
    if (release === undefined) {
      return { accepted: false };
    }
    const preparedAttemptId = this.#preparedRestarts.get(app.id);
    this.#preparedRestarts.delete(app.id);
    let resolveCompletion!: (restarted: boolean) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<boolean>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const launch = this.#registerLaunch(app.id, async () => {
      try {
        const restarted = await this.#runRestartClaimed(app, preparedAttemptId);
        resolveCompletion(restarted);
        return restarted ? (this.endpointFor(app.id) ?? "") : "";
      } catch (error) {
        await this.#handleRestartFailure(app.id, error, preparedAttemptId);
        rejectCompletion(error);
        throw error;
      } finally {
        release();
      }
    });
    // Async callers never await the completion; this keeps a rejection from becoming unhandled.
    void launch.catch(() => undefined);
    void completion.catch(() => undefined);
    return { accepted: true, completion };
  }

  async restartIfRunning(app: ManagedApp): Promise<boolean> {
    const release = this.#acquireRestartClaim(app.id);
    if (release === undefined) {
      throw new RestartInProgressError(app.id);
    }
    const preparedAttemptId = this.#preparedRestarts.get(app.id);
    this.#preparedRestarts.delete(app.id);
    let restarted = false;
    try {
      await this.#registerLaunch(app.id, async () => {
        restarted = await this.#runRestartClaimed(app, preparedAttemptId);
        return restarted ? (this.endpointFor(app.id) ?? "") : "";
      });
      return restarted;
    } catch (error) {
      await this.#handleRestartFailure(app.id, error, preparedAttemptId);
      throw error;
    } finally {
      release();
    }
  }

  /** True while a sync, async, or image-rollback restart holds the app's claim. */
  isRestarting(appId: string): boolean {
    return this.#restartClaims.has(appId);
  }

  /**
   * One bounded runtime probe for a persisted stopped row, used by the image route.
   *
   * Persists the observed state and applied image ID and never starts, stops, or restarts anything.
   */
  async probeStatus(appId: string): Promise<boolean> {
    return this.#withAppLock(appId, async () => {
      const row = this.#db
        .prepare("SELECT COALESCE(runtime_state, state) AS state FROM instances WHERE app_id = ?")
        .get(appId) as { state: string } | undefined;
      if (row === undefined || row.state !== "stopped") {
        return false;
      }
      const status = await this.#options.runtime.status(appId);
      await this.#recordStatusById(appId, status ?? stoppedStatus(appId), {
        source: "reconciler",
        reason: "status_probe",
        emitEvent: status !== undefined,
      });
      await this.#flushObservations();
      return true;
    });
  }

  #acquireRestartClaim(appId: string): (() => void) | undefined {
    if (this.#restartClaims.has(appId)) {
      return undefined;
    }
    let persistedClaimId: string | undefined;
    try {
      persistedClaimId = claimPersistedRestart(this.#db, appId);
    } catch {
      persistedClaimId = "__memory__";
    }
    if (persistedClaimId === undefined) {
      return undefined;
    }
    const persisted = persistedClaimId !== "__memory__";
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      if (this.#restartClaims.get(appId) === release) {
        this.#restartClaims.delete(appId);
      }
      if (persisted) {
        try {
          releasePersistedRestart(this.#db, appId, persistedClaimId);
        } catch {
          // A lost claim row is repaired by the next startup recovery pass.
        }
      }
    };
    this.#restartClaims.set(appId, release);
    return release;
  }

  async #runRestartClaimed(app: ManagedApp, attemptId?: string): Promise<boolean> {
    return this.#withAppLock(app.id, async () => {
      const end = this.#beginLifecycle("restart");
      try {
        this.#assertDeploymentUnlocked("restart");
        return await this.#restartLocked(app, attemptId);
      } finally {
        end();
      }
    });
  }

  async #handleRestartFailure(appId: string, error: unknown, attemptId?: string): Promise<void> {
    const detail = error instanceof Error ? error.message : "unknown error";
    this.#options.logger?.warn("restart_failed", { appId, error: detail.slice(0, 300) });
    if (error instanceof DeploymentInProgressError) {
      return;
    }
    try {
      await this.#withAppLock(appId, async () => {
        const persisted = readProcess(this.#db, appId);
        this.#transitionProcess(appId, {
          attemptId: attemptId ?? persisted.attemptId ?? this.#syntheticAttemptId(appId),
          state: "error",
          phase: "failed",
          source: "operator",
          reason: "restart",
          errorCode: processErrorCode(error),
          message: error,
        });
      });
    } catch {
      // A failed status write must not mask the restart failure reported to the caller.
    }
  }

  async #restartLocked(app: ManagedApp, attemptId?: string): Promise<boolean> {
    const status = await this.#options.runtime.status(app.id);
    const running = status?.state === "running" || status?.state === "starting";
    if (!running) {
      this.#forgetRunning(app.id);
      const persisted = readProcess(this.#db, app.id);
      if (persisted.state === "running" || persisted.state === "starting") {
        this.#transitionProcess(app.id, {
          attemptId: attemptId ?? persisted.attemptId ?? this.#syntheticAttemptId(app.id),
          state: "stopped",
          phase: "stopped",
          source: "reconciler",
          reason: "not_running",
          status: status ?? stoppedStatus(app.id),
          emitEvent: false,
        });
      }
      return false;
    }
    const attempt = attemptId ?? newAttemptId();
    if (attemptId === undefined) {
      this.#transitionProcess(app.id, {
        attemptId: attempt,
        state: "starting",
        phase: "requested",
        source: "operator",
        reason: "restart",
        clearError: true,
      });
    }
    try {
      await this.#preflightImage(app);
    } catch (error) {
      try {
        this.#transitionProcess(app.id, {
          attemptId: attempt,
          state: "error",
          phase: "failed",
          source: "operator",
          reason: "restart",
          errorCode: processErrorCode(error),
          message: error,
        });
      } catch {
        // The original typed image error is the caller's contract.
      }
      throw error;
    }
    await this.#stopLocked(app.id, "restart", { terminal: false, attemptId: attempt });
    await this.#ensureLocked(app, {
      attemptId: attempt,
      source: "operator",
      reason: "restart",
    });
    return true;
  }

  /**
   * Run one claimed image rollback: DB update plus an in-place restart when the app is running.
   *
   * The deployment guard runs before the claim, and the claim is released in `finally` on every
   * exit. A failed restart restores every image field from the snapshot; a failed restore surfaces
   * `500 image_rollback_restore_failed` instead of claiming success.
   */
  async rollbackImage(
    app: ManagedApp,
    rollback: () => Promise<AppImageRollbackResult>,
  ): Promise<ImageRollbackOutcome> {
    if (this.#restartClaims.has(app.id)) {
      throw new RestartInProgressError(app.id);
    }
    const end = this.#beginLifecycle("image_rollback");
    let outcome: ImageRollbackOutcome | undefined;
    try {
      const launch = this.#registerLaunch(app.id, async () => {
        outcome = await this.#withAppLock(app.id, async () => {
          const status = await this.#options.runtime.status(app.id).catch(() => undefined);
          const running = status?.state === "running" || status?.state === "starting";
          this.#assertDeploymentUnlocked("image_rollback");
          if (!running) {
            return { result: await rollback(), restarted: false };
          }
          const release = this.#acquireRestartClaim(app.id);
          if (release === undefined) {
            throw new RestartInProgressError(app.id);
          }
          try {
            const snapshot = this.#snapshotImageState(app.id);
            const result = await rollback();
            const selected = this.#authoritativeApp(app);
            const attemptId = newAttemptId();
            this.#transitionProcess(app.id, {
              attemptId,
              state: "starting",
              phase: "requested",
              source: "operator",
              reason: "image_rollback",
              clearError: true,
            });
            try {
              const restarted = await this.#restartLocked(selected, attemptId);
              return { result, restarted };
            } catch (error) {
              try {
                this.#restoreImageState(app.id, snapshot);
              } catch (restoreError) {
                throw new ImageRollbackRestoreError(app.id, restoreError);
              }
              if (
                error instanceof ImageNotReadyError ||
                error instanceof DefaultImageUnavailableError
              ) {
                const images = this.#options.images;
                if (images === undefined) {
                  throw error;
                }
                images.invalidateCache?.();
                const view = await images.imageState(app.id);
                throw error instanceof ImageNotReadyError
                  ? new ImageNotReadyError(view)
                  : new DefaultImageUnavailableError(view);
              }
              throw new ImageRollbackIncompleteError(app.id, error);
            }
          } finally {
            release();
          }
        });
        return this.endpointFor(app.id) ?? "";
      });
      await launch;
      if (outcome === undefined) {
        throw new Error(`image rollback did not complete for ${app.id}`);
      }
      return outcome;
    } finally {
      end();
    }
  }

  #snapshotImageState(appId: string): ImageStateSnapshot {
    const row = this.#db
      .prepare(
        `SELECT image_status AS imageStatus, image_ref AS imageRef, image_hash AS imageHash,
                image_base_digest AS imageBaseDigest, image_base_ref AS imageBaseRef,
                image_base_kind AS imageBaseKind, image_hash_version AS imageHashVersion,
                image_built_at AS imageBuiltAt, image_error AS imageError,
                image_build_id AS imageBuildId, image_build_ref AS imageBuildRef,
                image_build_started_at AS imageBuildStartedAt,
                image_build_rejected_ref AS imageBuildRejectedRef
         FROM apps WHERE id = ?`,
      )
      .get(appId) as ImageStateSnapshot | undefined;
    if (row === undefined) {
      throw new Error(`application ${appId} not found`);
    }
    return row;
  }

  #restoreImageState(appId: string, snapshot: ImageStateSnapshot): void {
    this.#db
      .prepare(
        `UPDATE apps SET
           image_status = @imageStatus,
           image_ref = @imageRef,
           image_hash = @imageHash,
           image_base_digest = @imageBaseDigest,
           image_base_ref = @imageBaseRef,
           image_base_kind = @imageBaseKind,
           image_hash_version = @imageHashVersion,
           image_built_at = @imageBuiltAt,
           image_error = @imageError,
           image_build_id = @imageBuildId,
           image_build_ref = @imageBuildRef,
           image_build_started_at = @imageBuildStartedAt,
           image_build_rejected_ref = @imageBuildRejectedRef
         WHERE id = @id`,
      )
      .run({ id: appId, ...snapshot });
  }

  /** Policy warnings recorded for an app, or an empty list when it has not been verified. */
  policyWarnings(appId: string): string[] {
    return [...(this.#running.get(appId)?.policyWarnings ?? [])];
  }

  /** OMO profile/model warnings recorded for an app, or an empty list when none was recorded. */
  profileWarnings(appId: string): string[] {
    const entry = this.#running.get(appId);
    if (entry === undefined) return [];
    return [
      ...(entry.profileWarning === undefined ? [] : [entry.profileWarning]),
      ...(entry.modelWarnings ?? []),
    ];
  }

  /**
   * Explicitly stop every host and revoke every active agent token.
   *
   * Coordinator shutdown must use {@link detach}, not this method: healthy agents keep running across
   * a coordinator restart.
   */
  async stopAll(): Promise<void> {
    const end = this.#beginLifecycle("stop_all");
    try {
      this.#assertDeploymentUnlocked("stop_all");
      this.#stopAllMonitors();
      this.#pending.dispose();
      this.#sweep.stop();
      this.#recovery.stop();
      await this.#options.runtime.reconcile([]);
      const appIds = new Set(this.#running.keys());
      const active = this.#db
        .prepare("SELECT DISTINCT app_id AS appId FROM agent_tokens WHERE revoked_at IS NULL")
        .all() as { appId: string }[];
      for (const row of active) {
        appIds.add(row.appId);
      }
      for (const [appId, entry] of this.#running) {
        clearEndpointAuthorization(entry.endpoint);
        this.#revokeAgentToken(appId, entry);
      }
      for (const appId of appIds) {
        if (!this.#running.has(appId)) {
          this.#revokeAgentToken(appId);
        }
      }
      this.#running.clear();
    } finally {
      end();
    }
  }

  /**
   * Drop coordinator-side state without stopping hosts or revoking tokens.
   *
   * This is the coordinator-shutdown path: agents stay healthy and the next coordinator attaches to
   * them through the same token files and per-app password.
   */
  detach(): void {
    this.#stopAllMonitors();
    this.#pending.dispose();
    this.#sweep.stop();
    this.#recovery.stop();
    this.stopStatusReconciler();
    for (const entry of this.#running.values()) {
      clearEndpointAuthorization(entry.endpoint);
    }
    this.#running.clear();
  }

  /**
   * Best-effort reattachment after a coordinator restart.
   *
   * Only instances the runtime already reports as `running`/`starting` are attached; stopped apps
   * are never started, and every failure is isolated to its app.
   */
  async resumeRunning(
    apps: Array<{ id: string; projectId: string; appKey: string }>,
  ): Promise<void> {
    for (const app of apps) {
      try {
        await this.#withAppLock(app.id, () => this.#resumeOne(app));
      } catch {
        process.stderr.write(`hanse: context monitor resume failed for ${app.id}\n`);
      }
    }
    this.#recovery.start();
    await this.#sampleSessionStatuses();
    try {
      await this.#recovery.startupCatchUp();
    } catch {
      process.stderr.write("hanse: process recovery catch-up failed\n");
    }
  }

  async #resumeOne(app: { id: string; projectId: string; appKey: string }): Promise<void> {
    const marker = this.#db
      .prepare(
        `SELECT a.deleting AS appDeleting, p.deleting AS projectDeleting
         FROM apps a
         JOIN projects p ON p.id = a.project_id
         WHERE a.id = ?`,
      )
      .get(app.id) as { appDeleting: number; projectDeleting: number } | undefined;
    if (marker === undefined || marker.appDeleting === 1 || marker.projectDeleting === 1) return;
    const status = await this.#options.runtime.status(app.id);
    if (status === undefined || (status.state !== "running" && status.state !== "starting")) {
      return;
    }
    this.#recordAppliedImageId(app.id, status.imageId);
    const identity = { projectId: app.projectId, app: app.appKey };
    const isolated = resolveInstanceEnv(this.#runtimeRoot, identity);
    const password = readOpencodePassword(opencodePasswordPath(isolated.XDG_STATE_HOME));
    if (password === undefined) return;
    const tokenFile = mcpTokenPath(this.#runtimeRoot, identity);
    try {
      ensureAgentToken(this.#db, app.id, tokenFile);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      process.stderr.write(
        `hanse: agent token reconciliation failed for ${app.id}: ${detail.slice(0, 200)}\n`,
      );
      return;
    }
    this.armPendingConfirmation(app.id);
    if (!this.#monitorsEnabled()) return;
    if (status.endpoint === undefined || status.endpoint === null) return;
    const endpoint = status.endpoint;
    setEndpointAuthorization(endpoint, OPENCODE_BASIC_USERNAME, password);
    const existing = this.#running.get(app.id);
    if (existing !== undefined) {
      if (existing.endpoint !== endpoint) {
        this.#stopMonitor(app.id);
        clearEndpointAuthorization(existing.endpoint);
        existing.endpoint = endpoint;
      }
      this.#startMonitor(app, existing);
      return;
    }
    const persisted = this.#db
      .prepare(
        `SELECT applied_settings_hash AS appliedSettingsHash,
                applied_profile AS appliedProfile
         FROM instances WHERE app_id = ?`,
      )
      .get(app.id) as
      | { appliedSettingsHash: string | null; appliedProfile: number | null }
      | undefined;
    const entry: Entry = {
      endpoint,
      projectId: app.projectId,
      appKey: app.appKey,
      policyWarnings: [],
      settingsHash: persisted?.appliedSettingsHash ?? undefined,
      appliedProfile:
        persisted?.appliedProfile === null || persisted?.appliedProfile === undefined
          ? undefined
          : persisted.appliedProfile !== 0,
    };
    this.#running.set(app.id, entry);
    this.#startMonitor(app, entry);
  }

  /** Endpoint of a currently attached instance without starting or probing anything. */
  endpointFor(appId: string): string | undefined {
    return this.#running.get(appId)?.endpoint;
  }

  /**
   * Subscribe to context snapshots emitted after each agent step. The route pushes them over the
   * browser's existing event stream, so live usage needs no extra request.
   */
  subscribeContext(appId: string, listener: (snapshot: ContextSnapshot) => void): () => void {
    let listeners = this.#contextListeners.get(appId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#contextListeners.set(appId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#contextListeners.get(appId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#contextListeners.delete(appId);
    };
  }

  #emitContext(appId: string, snapshot: ContextSnapshot): void {
    const listeners = this.#contextListeners.get(appId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // One closed browser stream must not affect the others or the monitor.
      }
    }
  }

  /** Subscribe to persisted notice writes for one app; mirrors {@link subscribeContext}. */
  subscribeNotices(appId: string, listener: (notice: SessionNoticeView) => void): () => void {
    let listeners = this.#noticeListeners.get(appId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#noticeListeners.set(appId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#noticeListeners.get(appId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#noticeListeners.delete(appId);
    };
  }

  #emitNotice(appId: string, notice: SessionNoticeView): void {
    const listeners = this.#noticeListeners.get(appId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(notice);
      } catch {
        // A closed browser stream must not affect detection or other listeners.
      }
    }
  }

  /** Record a server-side operator-abort tombstone before calling opencode. */
  recordOperatorAbort(appId: string, sessionId: string): void {
    this.#recovery.recordOperatorAbort(appId, sessionId);
  }

  /** Whether the external deployment lock currently forbids destructive operations. */
  isDeploymentLocked(): boolean {
    return this.#options.deploymentLock?.isActive() ?? false;
  }

  async contextSnapshot(appId: string, sessionId: string): Promise<ContextSnapshot> {
    const monitor = this.#running.has(appId) ? this.#monitors.get(appId)?.monitor : undefined;
    if (monitor === undefined) throw new AgentNotRunningError();
    return monitor.snapshot(sessionId);
  }

  async compactSession(appId: string, sessionId: string): Promise<{ accepted: true }> {
    const monitor = this.#running.has(appId) ? this.#monitors.get(appId)?.monitor : undefined;
    if (monitor === undefined) throw new AgentNotRunningError();
    return monitor.compact(sessionId);
  }

  #monitorsEnabled(): boolean {
    return (
      this.#options.enableContextMonitors !== false &&
      this.#options.settings?.contextPolicy !== undefined
    );
  }

  #startMonitor(app: { id: string; projectId: string; appKey: string }, entry: Entry): void {
    const settings = this.#options.settings;
    const contextPolicy = settings?.contextPolicy;
    if (this.#options.enableContextMonitors === false || contextPolicy === undefined) return;
    const existing = this.#monitors.get(app.id);
    if (existing !== undefined && existing.endpoint === entry.endpoint) return;
    if (existing !== undefined) {
      existing.monitor.stop();
      this.#monitors.delete(app.id);
    }
    const generation = this.#monitorGeneration + 1;
    this.#monitorGeneration = generation;
    const options: ContextMonitorOptions = {
      endpoint: entry.endpoint,
      appId: app.id,
      projectId: app.projectId,
      appKey: entry.appKey,
      isCurrent: () =>
        this.#monitors.get(app.id)?.generation === generation &&
        this.#running.get(app.id)?.endpoint === entry.endpoint,
      settings: { contextPolicy: (target) => contextPolicy.call(settings, target) },
      onEvent: (event: HanseEvent) => {
        this.#pending.observe(app.id, event);
        if (event.type === "session.status") {
          void this.#recovery
            .observeSessionStatus(app, {
              sessionID: event.sessionID,
              status: event.status,
            })
            .catch(() => undefined);
        } else if (event.type === "stream.ready") {
          void this.#sampleAppSessionStatuses(app.id, entry.endpoint).catch(() => undefined);
        } else if (event.type === "session.error") {
          void this.#recovery
            .observeSessionError(app, {
              sessionID: event.sessionID,
              ...(event.name === undefined ? {} : { name: event.name }),
              message: event.message,
            })
            .catch(() => undefined);
        }
        this.#options.onEvent?.(app, event);
      },
      onContextUpdate: (snapshot) => this.#emitContext(app.id, snapshot),
    };
    const monitor = this.#options.monitorFactory?.(options) ?? new ContextMonitor(options);
    this.#monitors.set(app.id, { monitor, endpoint: entry.endpoint, generation });
    monitor.start();
    this.armPendingConfirmation(app.id);
  }

  #stopMonitor(appId: string): void {
    const entry = this.#monitors.get(appId);
    if (entry === undefined) return;
    entry.monitor.stop();
    this.#monitors.delete(appId);
  }

  #stopAllMonitors(): void {
    for (const entry of this.#monitors.values()) entry.monitor.stop();
    this.#monitors.clear();
  }

  #forgetRunning(appId: string): void {
    this.#options.previews?.clearApp(appId);
    const entry = this.#running.get(appId);
    if (entry === undefined) {
      return;
    }
    this.#stopMonitor(appId);
    clearEndpointAuthorization(entry.endpoint);
    this.#running.delete(appId);
  }

  async #reconcileStatuses(): Promise<void> {
    try {
      pruneAllProcessEvents(this.#db, new Date().toISOString());
    } catch {
      // Retention is opportunistic and must not stop reconciliation.
    }
    const rows = this.#db
      .prepare(
        `SELECT app_id AS appId FROM instances
         WHERE COALESCE(runtime_state, state) <> 'stopped'`,
      )
      .all() as { appId: string }[];
    await Promise.all(
      rows.map(async ({ appId }) => {
        try {
          await this.#withAppLock(appId, () => this.#reconcileOne(appId));
        } catch {
          // A DB or lock failure must not stop the background reconciler.
        }
      }),
    );
    await this.#flushObservations();
    await this.#sampleSessionStatuses();
    try {
      await this.#recovery.reconcile();
    } catch {
      // A DB failure must not stop the background reconciler.
    }
  }

  async #reconcileOne(appId: string): Promise<void> {
    if (this.#launches.has(appId)) return;
    let status: RuntimeStatus | undefined;
    try {
      status = await this.#options.runtime.status(appId);
    } catch {
      return;
    }
    const persisted = readProcess(this.#db, appId);
    const previous = this.#readRuntimeRow(appId);
    const attemptId = persisted.attemptId ?? this.#syntheticAttemptId(appId);

    if (status === undefined) {
      if (persisted.state === "starting") {
        this.#transitionProcess(appId, {
          attemptId,
          state: "error",
          phase: "interrupted",
          source: "reconciler",
          reason: "stale_start",
          errorCode: "interrupted",
          message: "",
        });
        return;
      }
      if (persisted.state === "running") {
        this.#forgetRunning(appId);
        await this.#recordStatusById(appId, stoppedStatus(appId), {
          attemptId,
          source: "reconciler",
          reason: "out_of_band_stop",
          clearError: true,
        });
      }
      return;
    }

    const live = status.state === "running" || status.state === "starting";
    if (live) {
      if (persisted.state === "running") {
        const row = this.#readInstanceProcessRow(appId);
        const imageChanged =
          status.imageId !== null &&
          status.imageId !== undefined &&
          status.imageId !== row?.appliedImageId;
        const identityChanged = this.#runtimeIdentityChanged(previous, status);
        if (identityChanged || imageChanged) {
          this.#transitionProcess(appId, {
            attemptId: this.#runtimeObservationAttemptId(appId, status),
            state: status.state === "starting" ? "starting" : "running",
            phase: status.state === "starting" ? "waiting_ready" : "ready",
            source: "reconciler",
            reason: "external_restart",
            status,
            emitEvent: identityChanged,
          });
        }
        return;
      }
      if (persisted.state === "error") {
        if (await this.#probeReadiness(appId, status)) {
          this.#transitionProcess(appId, {
            attemptId,
            state: "running",
            phase: "ready",
            source: "reconciler",
            reason: "readiness_recovered",
            status,
            clearError: true,
          });
        }
        return;
      }
      if (persisted.state === "starting") {
        if (await this.#probeReadiness(appId, status)) {
          this.#transitionProcess(appId, {
            attemptId,
            state: "running",
            phase: "ready",
            source: "reconciler",
            reason: "readiness_recovered",
            status,
            clearError: true,
          });
          return;
        }
        const absent = status.state !== "running" && status.state !== "starting";
        if (absent || this.#processIsStale(persisted.updatedAt)) {
          this.#transitionProcess(appId, {
            attemptId,
            state: "error",
            phase: "interrupted",
            source: "reconciler",
            reason: "stale_start",
            errorCode: "interrupted",
            message: "",
            status,
          });
        }
        return;
      }
      return;
    }

    if (persisted.state === "running") {
      this.#forgetRunning(appId);
      const crashed =
        status.state === "error" || status.oomKilled === true || (status.exitCode ?? 0) !== 0;
      this.#transitionProcess(appId, {
        attemptId,
        state: crashed ? "error" : "stopped",
        phase: crashed ? "failed" : "stopped",
        source: "reconciler",
        reason: crashed
          ? status.oomKilled === true
            ? "oom_killed"
            : "crashed"
          : "out_of_band_stop",
        ...(crashed
          ? {
              errorCode: "runtime_unavailable",
              message: status.error ?? "The agent process exited unexpectedly.",
            }
          : { clearError: true }),
        status,
      });
      return;
    }
    if (persisted.state === "starting") {
      this.#transitionProcess(appId, {
        attemptId,
        state: "error",
        phase: "interrupted",
        source: "reconciler",
        reason: "stale_start",
        errorCode: "interrupted",
        message: "",
        status,
      });
    }
  }

  #runtimeIdentityChanged(
    previous: RuntimeObservation | undefined,
    status: RuntimeStatus,
  ): boolean {
    if (previous === undefined) return false;
    const next = this.#nextRuntimeFields(previous, status);
    return (
      previous.startedAt !== next.startedAt ||
      previous.restartCount !== next.restartCount ||
      previous.exitCode !== (status.exitCode ?? null) ||
      previous.oomKilled !== (status.oomKilled === true) ||
      previous.stopReason !== next.stopReason ||
      previous.stopAt !== next.stopAt
    );
  }

  #runtimeObservationAttemptId(appId: string, status: RuntimeStatus): string {
    const startedAt = status.startedAt ?? null;
    const restartCount = status.restartCount ?? null;
    if (startedAt === null && restartCount === null) {
      return this.#syntheticAttemptId(appId);
    }
    return `runtime:${appId}:${startedAt ?? "null"}#${restartCount ?? "null"}`.slice(0, 128);
  }

  #processIsStale(updatedAt: string | null): boolean {
    if (updatedAt === null) return true;
    const updated = Date.parse(updatedAt);
    return !Number.isFinite(updated) || Date.now() - updated >= PROCESS_STALE_MS;
  }

  async #probeReadiness(appId: string, status: RuntimeStatus): Promise<boolean> {
    if (status.state !== "running" && status.state !== "starting") return false;
    if (status.endpoint === null || status.endpoint === undefined) return false;
    if (this.#options.waitForReady === undefined) return true;
    try {
      await this.#options.waitForReady(appId, status.endpoint);
      return true;
    } catch {
      return false;
    }
  }

  async #sampleSessionStatuses(): Promise<void> {
    await Promise.all(
      [...this.#running.entries()].map(([appId, entry]) =>
        this.#sampleAppSessionStatuses(appId, entry.endpoint),
      ),
    );
  }

  async #sampleAppSessionStatuses(appId: string, endpoint: string): Promise<void> {
    let statuses: OpencodeSessionStatusMap;
    try {
      statuses = await listSessionStatuses(endpoint);
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const [sessionID, status] of Object.entries(statuses)) {
      seen.add(sessionID);
      try {
        await this.#recovery.observeSessionStatus({ id: appId }, { sessionID, status });
      } catch {
        // One bad session entry must not block the rest of the sample.
      }
    }
    const active = this.#recovery.listActiveSessions(appId);
    for (const row of active) {
      if (seen.has(row.sessionId)) continue;
      try {
        await this.#recovery.observeSessionStatus(
          { id: appId },
          { sessionID: row.sessionId, status: null },
        );
      } catch {
        // The next sample retries.
      }
    }
  }

  #logSkillWarnings(appId: string, phase: "probe" | "apply", result: SkillMaterializeResult): void {
    const logger = this.#options.logger;
    if (logger === undefined || result.warnings.length === 0) {
      return;
    }
    logger.warn("skills_materialize_warnings", {
      appId,
      phase,
      count: result.warnings.length,
      truncated: result.truncated ?? 0,
      warnings: result.warnings.slice(0, 5).map((warning) => ({
        code: warning.code,
        name: warning.name,
        root: warning.root,
      })),
    });
  }

  #recordSkillsError(appId: string, error?: unknown): void {
    try {
      const persisted = readProcess(this.#db, appId);
      this.#transitionProcess(appId, {
        attemptId: persisted.attemptId ?? this.#syntheticAttemptId(appId),
        state: "error",
        phase: "failed",
        source: "system",
        reason: "skills_materialize_failed",
        errorCode: "skills_materialize_failed",
        message: error ?? "Agent skills could not be materialized.",
      });
    } catch {
      // A failed status write must not mask the original skills failure.
    }
  }

  #syntheticAttemptId(appId: string): string {
    return `system:${appId}:${Date.now()}`.slice(0, 128);
  }

  #processSecrets(): string[] {
    return [process.env.HANSE_RUNTIME_TOKEN, process.env.HANSE_OPERATOR_TOKEN].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  #readInstanceProcessRow(appId: string): InstanceProcessRow | undefined {
    return this.#db
      .prepare(
        `SELECT endpoint,
                pid,
                spec_hash AS specHash,
                container_id AS containerId,
                container_name AS containerName,
                image_ref AS imageRef,
                applied_image_id AS appliedImageId,
                applied_settings_hash AS appliedSettingsHash,
                applied_profile AS appliedProfile,
                applied_skills_hash AS appliedSkillsHash,
                applied_rule_hash AS appliedRuleHash,
                started_at AS startedAt,
                runtime_started_at AS runtimeStartedAt,
                runtime_restart_count AS runtimeRestartCount,
                last_exit_code AS lastExitCode,
                last_oom_killed AS lastOomKilled,
                last_stop_reason AS lastStopReason,
                last_stop_at AS lastStopAt,
                COALESCE(runtime_state, state) AS state,
                process_attempt_id AS processAttemptId,
                process_phase AS processPhase,
                process_started_at AS processStartedAt,
                process_error_code AS processErrorCode,
                process_error_message AS processErrorMessage,
                process_error_at AS processErrorAt
           FROM instances WHERE app_id = ?`,
      )
      .get(appId) as InstanceProcessRow | undefined;
  }

  #transitionProcess(appId: string, input: ProcessTransitionInput): ProcessEvent | null {
    const state = normalizeProcessState(input.state);
    const phase = input.phase;
    if (!validPhaseStatePair(state, phase)) {
      throw new Error(`invalid process transition ${state}/${phase ?? "null"} for ${appId}`);
    }
    if (input.attemptId.length === 0 || input.attemptId.length > 128) {
      throw new Error(`invalid process attempt id for ${appId}`);
    }
    const now = new Date().toISOString();
    const previousObservation = this.#readRuntimeRow(appId);
    const previous = this.#readInstanceProcessRow(appId);
    const errorCode = input.errorCode ?? null;
    const hasErrorDetail = input.errorCode !== undefined || input.message !== undefined;
    const sanitizedMessage = hasErrorDetail
      ? sanitizeProcessError(input.message ?? "", {
          secrets: input.secrets ?? this.#processSecrets(),
          ...(errorCode === null ? {} : { code: errorCode as ProcessErrorCode }),
        })
      : null;
    if (
      state === "error" &&
      previous !== undefined &&
      previous.processAttemptId === input.attemptId &&
      previous.state === "error" &&
      previous.processPhase === phase &&
      previous.processErrorCode === errorCode
    ) {
      return null;
    }

    let nextErrorCode = previous?.processErrorCode ?? null;
    let nextErrorMessage = previous?.processErrorMessage ?? null;
    let nextErrorAt = previous?.processErrorAt ?? null;
    if (input.clearError === true) {
      nextErrorCode = null;
      nextErrorMessage = null;
      nextErrorAt = null;
    }
    if (hasErrorDetail) {
      nextErrorCode = errorCode;
      nextErrorMessage = sanitizedMessage;
      nextErrorAt = now;
    }

    const status = input.status;
    const endpoint =
      status !== undefined
        ? status.endpoint
        : state === "error"
          ? null
          : (previous?.endpoint ?? null);
    const pid = state === "error" && status === undefined ? null : (previous?.pid ?? null);
    const specHash = status?.specHash ?? previous?.specHash ?? null;
    const containerId =
      status === undefined ? (previous?.containerId ?? null) : (status.containerId ?? null);
    const containerName =
      status === undefined ? (previous?.containerName ?? null) : (status.containerName ?? null);
    const imageRef = input.image ?? previous?.imageRef ?? null;
    const appliedImageId = status?.imageId ?? previous?.appliedImageId ?? null;
    const appliedSettingsHash =
      input.settingsHash !== undefined
        ? input.settingsHash
        : (previous?.appliedSettingsHash ?? null);
    const appliedProfile =
      input.appliedProfile === undefined
        ? (previous?.appliedProfile ?? null)
        : input.appliedProfile
          ? 1
          : 0;
    const appliedSkillsHash =
      input.appliedSkillsHash !== undefined
        ? input.appliedSkillsHash
        : (previous?.appliedSkillsHash ?? null);
    const appliedRuleHash = input.appliedRuleHash ?? previous?.appliedRuleHash ?? null;
    const previousState =
      previous === undefined
        ? null
        : normalizeProcessState(previous.state as ProcessState | "failed");
    const startedAt =
      state === "running"
        ? previousState === "running"
          ? (previous?.startedAt ?? null)
          : now
        : previousState === "running"
          ? (previous?.startedAt ?? null)
          : null;

    let runtimeStartedAt = previous?.runtimeStartedAt ?? null;
    let runtimeRestartCount = previous?.runtimeRestartCount ?? null;
    let lastExitCode = previous?.lastExitCode ?? null;
    let lastOomKilled = previous?.lastOomKilled ?? null;
    let lastStopReason = previous?.lastStopReason ?? null;
    let lastStopAt = previous?.lastStopAt ?? null;
    if (status !== undefined) {
      const runtime = this.#nextRuntimeFields(previousObservation, status);
      runtimeStartedAt = runtime.startedAt;
      runtimeRestartCount = runtime.restartCount;
      lastStopReason = runtime.stopReason;
      lastStopAt = runtime.stopAt;
      lastExitCode = status.exitCode ?? null;
      lastOomKilled = status.oomKilled === true ? 1 : 0;
    }

    const isNewAttempt = previous === undefined || previous.processAttemptId !== input.attemptId;
    const processStartedAt =
      isNewAttempt || phase === "requested" ? now : (previous?.processStartedAt ?? now);
    const reason =
      input.reason === undefined || input.reason === null ? null : input.reason.slice(0, 200);
    const storedErrorCode = nextErrorCode === null ? null : nextErrorCode.slice(0, 200);

    const event = this.#db.transaction((): ProcessEvent | null => {
      this.#db
        .prepare(
          `INSERT INTO instances
             (id, app_id, endpoint, pid, state, runtime_state, spec_hash, container_id,
              container_name, image_ref, started_at, updated_at, applied_settings_hash,
              applied_profile, applied_skills_hash, applied_image_id, applied_rule_hash,
              runtime_started_at,
              runtime_restart_count, last_exit_code, last_oom_killed, last_stop_reason,
              last_stop_at, process_attempt_id, process_phase, process_started_at,
              process_error_code, process_error_message, process_error_at, process_updated_at)
           VALUES (@id, @appId, @endpoint, @pid, @state, @state, @specHash, @containerId,
             @containerName, @imageRef, @startedAt, @now, @appliedSettingsHash,
             @appliedProfile, @appliedSkillsHash, @appliedImageId, @appliedRuleHash,
             @runtimeStartedAt,
             @runtimeRestartCount, @lastExitCode, @lastOomKilled, @lastStopReason,
             @lastStopAt, @attemptId, @phase, @processStartedAt, @errorCode,
             @errorMessage, @errorAt, @now)
           ON CONFLICT(app_id) DO UPDATE SET
             endpoint = excluded.endpoint,
             pid = excluded.pid,
             state = excluded.state,
             runtime_state = excluded.runtime_state,
             spec_hash = excluded.spec_hash,
             container_id = excluded.container_id,
             container_name = excluded.container_name,
             image_ref = excluded.image_ref,
             started_at = excluded.started_at,
             updated_at = excluded.updated_at,
             applied_settings_hash = excluded.applied_settings_hash,
             applied_profile = excluded.applied_profile,
             applied_skills_hash = excluded.applied_skills_hash,
             applied_image_id = excluded.applied_image_id,
             applied_rule_hash = excluded.applied_rule_hash,
             runtime_started_at = excluded.runtime_started_at,
             runtime_restart_count = excluded.runtime_restart_count,
             last_exit_code = excluded.last_exit_code,
             last_oom_killed = excluded.last_oom_killed,
             last_stop_reason = excluded.last_stop_reason,
             last_stop_at = excluded.last_stop_at,
             process_attempt_id = excluded.process_attempt_id,
             process_phase = excluded.process_phase,
             process_started_at = excluded.process_started_at,
             process_error_code = excluded.process_error_code,
             process_error_message = excluded.process_error_message,
             process_error_at = excluded.process_error_at,
             process_updated_at = excluded.process_updated_at`,
        )
        .run({
          id: appId,
          appId,
          endpoint,
          pid,
          state,
          specHash,
          containerId,
          containerName,
          imageRef,
          startedAt,
          now,
          appliedSettingsHash,
          appliedProfile,
          appliedSkillsHash,
          appliedImageId,
          appliedRuleHash,
          runtimeStartedAt,
          runtimeRestartCount,
          lastExitCode,
          lastOomKilled,
          lastStopReason,
          lastStopAt,
          attemptId: input.attemptId,
          phase,
          processStartedAt,
          errorCode: storedErrorCode,
          errorMessage: nextErrorMessage,
          errorAt: nextErrorAt,
        });

      if (input.emitEvent === false) {
        pruneProcessEvents(this.#db, appId);
        return null;
      }
      const seqRow = this.#db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) + 1 AS seq
             FROM agent_run_events WHERE app_id = ? AND attempt_id = ?`,
        )
        .get(appId, input.attemptId) as { seq: number };
      const result = this.#db
        .prepare(
          `INSERT INTO agent_run_events
             (app_id, attempt_id, seq, state, phase, source, reason, error_code, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          appId,
          input.attemptId,
          seqRow.seq,
          state,
          phase,
          input.source,
          reason,
          storedErrorCode,
          nextErrorMessage,
          now,
        );
      pruneProcessEvents(this.#db, appId);
      return {
        id: Number(result.lastInsertRowid),
        attemptId: input.attemptId,
        seq: seqRow.seq,
        state,
        phase,
        source: input.source,
        reason,
        errorCode: storedErrorCode,
        message: nextErrorMessage,
        createdAt: now,
      };
    })();

    if (event !== null) {
      if (input.status !== undefined && (input.queueObservation ?? true)) {
        const runtime = this.#nextRuntimeFields(previousObservation, input.status);
        this.#queueObservation(
          appId,
          previousObservation,
          this.#observationFromStatus(
            input.status,
            runtime.startedAt,
            runtime.restartCount,
            runtime.stopReason,
            runtime.stopAt,
          ),
        );
      }
      processEvents.emit(appId, event);
    }
    return event;
  }

  #registerLaunch(
    appId: string,
    task: () => Promise<string>,
    kind: "ensure" | "restart" = "restart",
  ): Promise<string> {
    const previous = this.#launches.get(appId);
    const launch = (async () => {
      if (previous !== undefined) {
        try {
          await previous;
        } catch {
          // A failed previous launch must not block the chained one.
        }
      }
      return task();
    })();
    this.#launches.set(appId, launch);
    this.#launchKinds.set(appId, kind);
    const cleanup = (): void => {
      if (this.#launches.get(appId) === launch) {
        this.#launches.delete(appId);
        this.#launchKinds.delete(appId);
      }
    };
    launch.then(cleanup, cleanup);
    return launch;
  }

  #queueObservation(
    appId: string,
    previous: RuntimeObservation | null | undefined,
    current: RuntimeObservation,
  ): void {
    this.#observations.push({ appId, previous, current });
  }

  #scheduleObservationFlush(): void {
    if (this.#observations.length === 0) return;
    const timer = setTimeout(() => {
      void this.#flushObservations();
    }, 0);
    timer.unref?.();
  }

  async #flushObservations(): Promise<void> {
    const batch = this.#observations.splice(0);
    for (const observation of batch) {
      try {
        await this.#recovery.observeRuntime(
          observation.appId,
          observation.previous,
          observation.current,
        );
      } catch {
        // Detection is best-effort and must never break a stop/start caller.
      }
    }
  }

  #readRuntimeRow(appId: string): RuntimeObservation | undefined {
    const row = this.#db
      .prepare(
        `SELECT runtime_started_at AS startedAt,
                runtime_restart_count AS restartCount,
                COALESCE(runtime_state, state) AS state,
                last_exit_code AS exitCode,
                last_oom_killed AS oomKilled,
                last_stop_reason AS stopReason,
                last_stop_at AS stopAt
           FROM instances WHERE app_id = ?`,
      )
      .get(appId) as
      | {
          startedAt: string | null;
          restartCount: number | null;
          state: string;
          exitCode: number | null;
          oomKilled: number | null;
          stopReason: string | null;
          stopAt: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    return {
      startedAt: row.startedAt,
      restartCount: row.restartCount,
      state: row.state as RuntimeObservation["state"],
      exitCode: row.exitCode,
      oomKilled: row.oomKilled === 1,
      stopReason: row.stopReason,
      stopAt: row.stopAt,
    };
  }

  #observationFromStatus(
    status: Awaited<ReturnType<AgentRuntimeClient["ensure"]>>,
    startedAt: string | null,
    restartCount: number | null,
    stopReason: string | null,
    stopAt: string | null,
  ): RuntimeObservation {
    return {
      startedAt,
      restartCount,
      state: status.state,
      exitCode: status.exitCode ?? null,
      oomKilled: status.oomKilled === true,
      finishedAt: status.finishedAt ?? null,
      stopReason,
      stopAt,
    };
  }

  #nextRuntimeFields(
    previous: RuntimeObservation | undefined,
    status: Awaited<ReturnType<AgentRuntimeClient["ensure"]>>,
  ): {
    startedAt: string | null;
    restartCount: number | null;
    stopReason: string | null;
    stopAt: string | null;
  } {
    const startedAt = status.startedAt ?? previous?.startedAt ?? null;
    const restartCount = status.restartCount ?? previous?.restartCount ?? null;
    const changed =
      previous !== undefined &&
      (previous.startedAt !== startedAt || previous.restartCount !== restartCount);
    return {
      startedAt,
      restartCount,
      stopReason: changed ? null : (previous?.stopReason ?? null),
      stopAt: changed ? null : (previous?.stopAt ?? null),
    };
  }

  async #recordStatus(
    app: ManagedApp,
    status: RuntimeStatus,
    image: string,
    settingsHash?: string,
    appliedProfile?: boolean,
    appliedRuleHash?: string,
    appliedSkillsHash?: string,
  ): Promise<void> {
    const persisted = readProcess(this.#db, app.id);
    const state = normalizeProcessState(status.state);
    this.#transitionProcess(app.id, {
      attemptId: persisted.attemptId ?? this.#syntheticAttemptId(app.id),
      state,
      phase: processPhaseForState(state),
      source: "runtime",
      reason: `runtime_${state}`,
      status,
      image,
      ...(settingsHash === undefined ? {} : { settingsHash }),
      ...(appliedProfile === undefined ? {} : { appliedProfile }),
      ...(appliedRuleHash === undefined ? {} : { appliedRuleHash }),
      ...(appliedSkillsHash === undefined ? {} : { appliedSkillsHash }),
      clearError: state === "running",
    });
  }

  async #recordStatusById(
    appId: string,
    status: Awaited<ReturnType<AgentRuntimeClient["delete"]>>,
    options: {
      attemptId?: string;
      source?: ProcessSource;
      reason?: string;
      clearError?: boolean;
      emitEvent?: boolean;
    } = {},
  ): Promise<void> {
    const persisted = readProcess(this.#db, appId);
    const state = normalizeProcessState(status.state);
    this.#transitionProcess(appId, {
      attemptId: options.attemptId ?? persisted.attemptId ?? this.#syntheticAttemptId(appId),
      state,
      phase: processPhaseForState(state),
      source: options.source ?? "runtime",
      reason: options.reason ?? `runtime_${state}`,
      status,
      clearError: options.clearError ?? state === "running",
      ...(options.emitEvent === undefined ? {} : { emitEvent: options.emitEvent }),
    });
  }

  #restoreProcessRuleOnReconnect(
    appId: string,
    isolated: IsolatedEnv,
    appliedHash: string | null,
  ): void {
    const result = restoreAppliedRule(isolated, appliedHash);
    if (result.restored) return;
    this.#options.logger?.warn("process_rule_integrity_failed", {
      appId,
      reason: result.reason,
    });
    writeProcessRule(isolated, PROCESS_RULE_TEXT);
  }

  #beginLifecycle(operation: string): () => void {
    return this.#options.lifecycleActivity?.begin(operation) ?? (() => undefined);
  }

  #assertDeploymentUnlocked(operation: string): void {
    this.#options.deploymentLock?.assertUnlocked(operation);
  }

  #withAppLock<T>(appId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(appId) ?? Promise.resolve();
    const result = previous.then(run, run);
    this.#locks.set(appId, result);
    const cleanup = (): void => {
      if (this.#locks.get(appId) === result) {
        this.#locks.delete(appId);
      }
    };
    result.then(cleanup, cleanup);
    void result.then(
      () => this.#scheduleObservationFlush(),
      () => this.#scheduleObservationFlush(),
    );
    return result;
  }

  async #verifyPolicy(app: ManagedApp, isolated: IsolatedEnv, endpoint: string): Promise<string[]> {
    const verify = this.#options.verify ?? verifyInstancePolicy;
    const denyPatterns = credentialDenyPatterns({
      appRoot: path.dirname(isolated.HOME),
      home: isolated.HOME,
      xdgDataHome: isolated.XDG_DATA_HOME,
      passwordFile: opencodePasswordPath(isolated.XDG_STATE_HOME),
    });
    try {
      return await verify({
        endpoint,
        appDir: app.appDir,
        denyPatterns,
        bashProbes: BASH_DENY_PROBES,
        timeoutMs: this.#options.verificationTimeoutMs,
        retries: this.#options.verificationRetries,
        retryDelayMs: this.#options.verificationRetryDelayMs,
      });
    } catch {
      return ["policy_unverified: agent policy verification failed"];
    }
  }

  #revokeAgentToken(appId: string, identity?: { projectId: string; appKey: string }): void {
    revokeAgentToken(this.#db, appId);
    const resolved =
      identity ??
      (this.#db
        .prepare("SELECT project_id AS projectId, app_key AS appKey FROM apps WHERE id = ?")
        .get(appId) as { projectId: string; appKey: string } | undefined);
    if (resolved === undefined) {
      return;
    }
    rmSync(
      mcpTokenPath(this.#runtimeRoot, { projectId: resolved.projectId, app: resolved.appKey }),
      { force: true },
    );
  }
}
