import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentRuntimeClient } from "../agent/client.js";
import { stoppedStatus } from "../agent/protocol.js";
import {
  type AppRuntimeSpec,
  computeSpecHash,
  type SpecHashInput,
  validateAppRuntimeSpec,
} from "../agent/spec.js";
import { DeploymentInProgressError, type DeploymentLock } from "../coordinator/deployment-lock.js";
import type { LifecycleActivity } from "../coordinator/lifecycle-activity.js";
import { materializeGitCredentials } from "../git/materialize.js";
import type { AppImageRollbackResult } from "../images/service.js";
import type { Logger } from "../logging/logger.js";
import { ensureAgentToken, mcpTokenPath, revokeAgentToken } from "../mcp/agent-tokens.js";
import { type AppImageStatus, resolveAppBuild } from "../registry/index.js";
import { appNetworkName, mapToHostPath } from "../runner/names.js";
import { RUNNER_APP_PORT } from "../runner/validate.js";
import { hashValue } from "../settings/hash.js";
import { launchEffectiveSettings } from "../settings/service.js";
import type {
  EffectiveSettings,
  LaunchSettingsSnapshot,
  SettingsTarget,
} from "../settings/types.js";
import type { SkillApplyOptions, SkillMaterializeResult, SkillSource } from "../skills/index.js";
import type { SqliteDatabase } from "../store/index.js";
import { buildWebMcpConfig } from "../web/config.js";
import { writeAuthFile } from "./auth.js";
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
import {
  buildConfigOverlay,
  type IsolatedEnv,
  type McpLocalServer,
  resolveInstanceEnv,
  sanitizeAppKey,
} from "./instance.js";
import type { OmoProfileInput, OmoProfileResult } from "./omo-profile.js";
import { ensureOpencodePassword, opencodePasswordPath, readOpencodePassword } from "./password.js";
import {
  buildPermissionPolicy,
  type PermissionAction,
  resolvePermissionPaths,
  type VerifyPolicyOptions,
  verifyInstancePolicy,
  type WebPermissionOptions,
} from "./policy.js";

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

interface Entry {
  endpoint: string;
  projectId: string;
  appKey: string;
  policyWarnings: string[];
  settingsHash?: string;
  appliedProfile?: boolean;
  profileWarning?: string;
  modelWarnings?: string[];
}

interface ImageStateSnapshot {
  imageStatus: AppImageStatus;
  imageRef: string | null;
  imageHash: string | null;
  imageBaseDigest: string | null;
  imageBuiltAt: string | null;
  imageError: string | null;
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
  /** Injectable skill registry for per-instance materialization. */
  skills?: SkillSource;
  /** Optional structured logger; skill warnings are bounded and content-free. */
  logger?: Logger;
  /** Injectable model-propagation verifier for tests. */
  modelVerifier?: (endpoint: string, expected: string) => Promise<string[]>;
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
  /** Advisory external deployment lock; absent in unit fixtures that do not exercise it. */
  deploymentLock?: DeploymentLock;
  /** Process-local destructive-operation counter exposed through `/readyz`. */
  lifecycleActivity?: LifecycleActivity;
}

interface MonitorEntry {
  monitor: ContextMonitorLike;
  endpoint: string;
  generation: number;
}

const DEFAULT_MODEL = "deepseek/deepseek-flash";
const DEFAULT_AGENT_API_BASE = "http://127.0.0.1:8787";
const DEFAULT_AGENT_IMAGE = "agent-default";
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
): string {
  return hashValue({
    effective: launchEffectiveSettings(snapshot.resolved.effective),
    providerKeys: snapshot.resolved.providerKeys,
    authHash: snapshot.authHash,
    gitAuthHash: snapshot.gitAuthHash,
    profile,
    ...(skillsHash === undefined ? {} : { skills: skillsHash }),
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
  if (inspection.status === "error") {
    throw new Error(
      `application image configuration is invalid for ${app.id}: ${inspection.error ?? "unknown error"}`,
    );
  }
  if (inspection.dockerfile === null) {
    return process.env.HANSE_AGENT_IMAGE?.trim() || DEFAULT_AGENT_IMAGE;
  }
  const imageRef = app.imageRef?.trim();
  if (
    (app.imageStatus === "ready" || app.imageStatus === "stale") &&
    imageRef !== undefined &&
    imageRef.length > 0
  ) {
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
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #restartClaims = new Map<string, () => void>();
  #monitorGeneration = 0;
  #statusReconcile: Promise<void> | undefined;
  #statusTimer: ReturnType<typeof setInterval> | undefined;

  constructor(db: SqliteDatabase, runtimeRoot: string, options: InstanceManagerOptions) {
    this.#db = db;
    this.#runtimeRoot = runtimeRoot;
    this.#options = options;
  }

  async ensure(app: ManagedApp): Promise<string> {
    if (!path.isAbsolute(app.appDir)) {
      throw new Error(`application directory must be an absolute resolved path: ${app.appDir}`);
    }
    return this.#withAppLock(app.id, async () => {
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
      const running =
        current !== undefined && (current.state === "running" || current.state === "starting");
      const existingPassword = readOpencodePassword(passwordFile);
      if (running && existingPassword !== undefined) {
        // A running container's token is reconciled in place; a failure must never fall through to
        // delete/recreate because that would destroy an in-flight turn and cannot fix a file error.
        try {
          ensureAgentToken(this.#db, app.id, tokenFile);
        } catch (error) {
          this.#assertDeploymentUnlocked("ensure");
          throw new AgentTokenReconcileError(app.id, error);
        }
        // Reconnect after a coordinator restart or a caller retry. Settings/spec changes stay
        // "restart required" until an explicit stop and restart.
        const endpoint = current.endpoint ?? existing?.endpoint;
        if (endpoint !== undefined && endpoint !== null) {
          setEndpointAuthorization(endpoint, OPENCODE_BASIC_USERNAME, existingPassword);
          if (existing === undefined) {
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
          } else {
            if (existing.endpoint !== endpoint) {
              this.#stopMonitor(app.id);
              clearEndpointAuthorization(existing.endpoint);
              existing.endpoint = endpoint;
            }
            this.#startMonitor(app, existing);
          }
          return endpoint;
        }
        // Running/starting without an endpoint is not reconnectable; under a lock it must throw
        // before any delete, which the destructive path's guard enforces.
      }
      const end = this.#beginLifecycle("ensure");
      try {
        this.#assertDeploymentUnlocked("ensure");
        return await this.#ensureLocked(app);
      } finally {
        end();
      }
    });
  }

  /** Destructive start/recreate path. Callers hold the app lock and the deployment guard. */
  async #ensureLocked(app: ManagedApp): Promise<string> {
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
    const identity = { projectId: app.projectId, app: app.appKey };
    const tokenFile = mcpTokenPath(this.#runtimeRoot, identity);
    const isolated = resolveInstanceEnv(this.#runtimeRoot, identity);
    mkdirSync(path.dirname(isolated.HOME), { recursive: true, mode: 0o700 });
    mkdirSync(isolated.HOME, { recursive: true, mode: 0o700 });
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
    if (skills !== undefined) {
      try {
        const probed = skills.probe(skillsTarget, isolated.XDG_CONFIG_HOME, skillOptions);
        skillsHash = probed.hash;
        this.#logSkillWarnings(app.id, "probe", probed);
      } catch (error) {
        throw skillsMaterializeFailure(error);
      }
    }

    const image = resolveAgentImage(app);
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
        const applied = skills.apply(skillsTarget, isolated.XDG_CONFIG_HOME, skillOptions);
        skillsHash = applied.hash;
        this.#logSkillWarnings(app.id, "apply", applied);
      } catch (error) {
        this.#recordSkillsError(app.id);
        throw skillsMaterializeFailure(error);
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
    if (settings !== undefined && omoProfiles !== undefined) {
      const snapshot = settings.snapshot({ projectId: app.projectId, appKey: app.appKey });
      web = snapshot.resolved.effective.web;
      model = snapshot.resolved.effective.llm.model.value ?? DEFAULT_MODEL;
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
      settingsHash = settingsHashFor(snapshot, profile.contentHash, skillsHash);
      const webConfig = buildWebMcpConfig(web);
      if (webConfig !== undefined) {
        mcpServers = {
          hanse_web: {
            type: "local",
            command: [process.execPath, process.argv[1] ?? "", "web-mcp"],
            enabled: true,
            environment: {
              HANSE_WEB_CONFIG: JSON.stringify(webConfig),
              HANSE_OPENCODE_AUTH_FILE: path.join(isolated.XDG_DATA_HOME, "opencode", "auth.json"),
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
        baselinePlugins,
      }),
      webPermissionOptions(web),
    );
    const overlay = buildConfigOverlay({
      coordinatorCommand: [process.execPath, process.argv[1] ?? "", "mcp"],
      codegraphCommand: resolveCodegraphCommand(),
      environment: coordinatorEnvironment,
      plugins: baselinePlugins,
      permission,
      model,
      mcpServers,
    });
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

    const status = await this.#options.runtime.ensure(spec);
    this.#recordStatus(app, status, image, settingsHash, appliedProfile);
    if (status.state !== "running" || status.endpoint === null) {
      throw new Error(`agent runtime did not start ${app.id}: ${status.error ?? status.state}`);
    }
    const endpoint = status.endpoint;
    setEndpointAuthorization(endpoint, OPENCODE_BASIC_USERNAME, password);

    const entry: Entry = {
      endpoint,
      projectId: app.projectId,
      appKey: app.appKey,
      policyWarnings: [],
      settingsHash,
      appliedProfile,
      profileWarning,
    };
    this.#running.set(app.id, entry);
    this.#startMonitor(app, entry);
    entry.policyWarnings = await this.#verifyPolicy(app, isolated, baselinePlugins, endpoint);
    if (model !== undefined) {
      const verifyModel = this.#options.modelVerifier ?? verifyAgentModels;
      entry.modelWarnings = await verifyModel(endpoint, model);
    }
    return endpoint;
  }

  /** Re-read the image fields that decide which image a destructive start may launch. */
  #authoritativeApp(app: ManagedApp): ManagedApp {
    const row = this.#db
      .prepare(
        `SELECT project_id AS projectId, app_key AS appKey,
                image_ref AS imageRef, image_status AS imageStatus
         FROM apps WHERE id = ?`,
      )
      .get(app.id) as
      | { projectId: string; appKey: string; imageRef: string | null; imageStatus: AppImageStatus }
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
                i.applied_profile AS appliedProfile
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
    },
    settings: SettingsSource,
    omoProfiles: OmoProfileSource,
  ): { pending: boolean; reasons: string[] } {
    if (target.settingsHash === undefined || target.appliedProfile === undefined) {
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
      const skillsHash = this.#options.skills?.hash({
        projectId: target.projectId,
        appKey: target.appKey,
      });
      if (settingsHashFor(snapshot, preview.contentHash, skillsHash) !== target.settingsHash) {
        reasons.push("settings_changed");
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
        return await this.#stopLocked(appId);
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
    const stopped = await this.#stopLocked(appId);
    this.#db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(appId);
    return stopped;
  }

  /** Stop logic shared by {@link stopApp} and {@link stopForDeletion}; callers hold the app lock. */
  async #stopLocked(appId: string): Promise<boolean> {
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
    let finalStatus: Awaited<ReturnType<AgentRuntimeClient["delete"]>>;
    try {
      finalStatus = await this.#options.runtime.delete(appId);
    } catch (error) {
      // The runtime may have stopped the container before failing; re-read the truth best-effort.
      // Keep the in-memory entry and endpoint auth so a retry and the running UI stay truthful.
      await this.#options.runtime.status(appId).catch(() => undefined);
      throw error;
    }
    this.#stopMonitor(appId);
    this.#running.delete(appId);
    if (endpoint !== undefined && endpoint !== null) {
      clearEndpointAuthorization(endpoint);
    }
    this.#recordStatusById(appId, finalStatus);
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
    const tick = (): void => {
      void this.reconcileStatuses().catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    this.#statusTimer = timer;
  }

  stopStatusReconciler(): void {
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
   * in memory: if the coordinator exits after a 202 the app can remain stopped and the caller must
   * retry. Errors are logged, reflected in the instance row, and rejected only to sync callers.
   */
  beginRestart(app: ManagedApp): RestartClaim {
    const release = this.#acquireRestartClaim(app.id);
    if (release === undefined) {
      return { accepted: false };
    }
    const completion = new Promise<boolean>((resolve, reject) => {
      setTimeout(() => {
        void this.#runRestartClaimed(app).then(
          (restarted) => {
            release();
            resolve(restarted);
          },
          (error: unknown) => {
            release();
            this.#handleRestartFailure(app.id, error);
            reject(error);
          },
        );
      }, 0);
    });
    // Async callers never await the completion; this keeps a rejection from becoming unhandled.
    void completion.catch(() => undefined);
    return { accepted: true, completion };
  }

  async restartIfRunning(app: ManagedApp): Promise<boolean> {
    const release = this.#acquireRestartClaim(app.id);
    if (release === undefined) {
      throw new RestartInProgressError(app.id);
    }
    try {
      return await this.#runRestartClaimed(app);
    } finally {
      release();
    }
  }

  /** True while a sync, async, or image-rollback restart holds the app's claim. */
  isRestarting(appId: string): boolean {
    return this.#restartClaims.has(appId);
  }

  #acquireRestartClaim(appId: string): (() => void) | undefined {
    if (this.#restartClaims.has(appId)) {
      return undefined;
    }
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      if (this.#restartClaims.get(appId) === release) {
        this.#restartClaims.delete(appId);
      }
    };
    this.#restartClaims.set(appId, release);
    return release;
  }

  async #runRestartClaimed(app: ManagedApp): Promise<boolean> {
    return this.#withAppLock(app.id, async () => {
      const end = this.#beginLifecycle("restart");
      try {
        this.#assertDeploymentUnlocked("restart");
        return await this.#restartLocked(app);
      } finally {
        end();
      }
    });
  }

  #handleRestartFailure(appId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : "unknown error";
    this.#options.logger?.warn("restart_failed", { appId, error: detail.slice(0, 300) });
    if (error instanceof DeploymentInProgressError) {
      return;
    }
    try {
      this.#db
        .prepare(
          `UPDATE instances SET endpoint = NULL, state = 'error', runtime_state = 'error', updated_at = ?
           WHERE app_id = ?`,
        )
        .run(new Date().toISOString(), appId);
    } catch {
      // A failed status write must not mask the restart failure reported to the caller.
    }
  }

  async #restartLocked(app: ManagedApp): Promise<boolean> {
    const status = await this.#options.runtime.status(app.id);
    const running = status?.state === "running" || status?.state === "starting";
    if (!running) {
      this.#forgetRunning(app.id);
      this.#recordStatusById(app.id, status ?? stoppedStatus(app.id));
      return false;
    }
    await this.#stopLocked(app.id);
    await this.#ensureLocked(app);
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
    const end = this.#beginLifecycle("image_rollback");
    try {
      return await this.#withAppLock(app.id, async () => {
        const authoritative = this.#authoritativeApp(app);
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
          try {
            const restarted = await this.#restartLocked(authoritative);
            return { result, restarted };
          } catch (error) {
            try {
              this.#restoreImageState(app.id, snapshot);
            } catch (restoreError) {
              throw new ImageRollbackRestoreError(app.id, restoreError);
            }
            throw new ImageRollbackIncompleteError(app.id, error);
          }
        } finally {
          release();
        }
      });
    } finally {
      end();
    }
  }

  #snapshotImageState(appId: string): ImageStateSnapshot {
    const row = this.#db
      .prepare(
        `SELECT image_status AS imageStatus, image_ref AS imageRef, image_hash AS imageHash,
                image_base_digest AS imageBaseDigest, image_built_at AS imageBuiltAt,
                image_error AS imageError
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
           image_built_at = @imageBuiltAt,
           image_error = @imageError
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
    };
    const monitor = this.#options.monitorFactory?.(options) ?? new ContextMonitor(options);
    this.#monitors.set(app.id, { monitor, endpoint: entry.endpoint, generation });
    monitor.start();
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
    const entry = this.#running.get(appId);
    if (entry === undefined) {
      return;
    }
    this.#stopMonitor(appId);
    clearEndpointAuthorization(entry.endpoint);
    this.#running.delete(appId);
  }

  async #reconcileStatuses(): Promise<void> {
    const rows = this.#db
      .prepare(
        `SELECT app_id AS appId FROM instances
         WHERE COALESCE(runtime_state, state) <> 'stopped'`,
      )
      .all() as { appId: string }[];
    await Promise.all(
      rows.map(async ({ appId }) => {
        try {
          await this.#withAppLock(appId, async () => {
            let status: Awaited<ReturnType<AgentRuntimeClient["status"]>>;
            try {
              status = await this.#options.runtime.status(appId);
            } catch {
              return;
            }
            if (
              status === undefined ||
              (status.state !== "running" && status.state !== "starting")
            ) {
              this.#forgetRunning(appId);
            }
            this.#recordStatusById(appId, status ?? stoppedStatus(appId));
          });
        } catch {
          // A DB or lock failure must not stop the background reconciler.
        }
      }),
    );
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

  #recordSkillsError(appId: string): void {
    this.#db
      .prepare(
        `INSERT INTO instances (id, app_id, endpoint, pid, state, runtime_state, updated_at)
         VALUES (?, ?, NULL, NULL, 'error', 'error', ?)
         ON CONFLICT(app_id) DO UPDATE SET
           endpoint = NULL,
           pid = NULL,
           state = 'error',
           runtime_state = 'error',
           updated_at = excluded.updated_at`,
      )
      .run(appId, appId, new Date().toISOString());
  }

  #recordStatus(
    app: ManagedApp,
    status: Awaited<ReturnType<AgentRuntimeClient["ensure"]>>,
    image: string,
    settingsHash?: string,
    appliedProfile?: boolean,
  ): void {
    const now = new Date().toISOString();
    const startedAt = status.state === "running" ? now : null;
    this.#db
      .prepare(
        `INSERT INTO instances
           (id, app_id, endpoint, state, runtime_state, spec_hash, container_id, container_name, image_ref, started_at, updated_at, applied_settings_hash, applied_profile)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_id) DO UPDATE SET
           endpoint = excluded.endpoint,
           state = excluded.state,
           runtime_state = excluded.runtime_state,
           spec_hash = excluded.spec_hash,
           container_id = excluded.container_id,
           container_name = excluded.container_name,
           image_ref = excluded.image_ref,
           started_at = CASE
             WHEN instances.state = 'running' THEN instances.started_at
             ELSE excluded.started_at
           END,
           updated_at = excluded.updated_at,
           applied_settings_hash = excluded.applied_settings_hash,
           applied_profile = excluded.applied_profile`,
      )
      .run(
        app.id,
        app.id,
        status.endpoint,
        status.state,
        status.state,
        status.specHash,
        status.containerId ?? null,
        status.containerName ?? null,
        image,
        startedAt,
        now,
        settingsHash ?? null,
        appliedProfile === undefined ? null : appliedProfile ? 1 : 0,
      );
  }

  #recordStatusById(
    appId: string,
    status: Awaited<ReturnType<AgentRuntimeClient["delete"]>>,
  ): void {
    this.#db
      .prepare(
        `UPDATE instances SET
           endpoint = ?,
           state = ?,
           runtime_state = ?,
           spec_hash = ?,
           container_id = ?,
           container_name = ?,
           updated_at = ?
         WHERE app_id = ?`,
      )
      .run(
        status.endpoint,
        status.state,
        status.state,
        status.specHash,
        status.containerId ?? null,
        status.containerName ?? null,
        new Date().toISOString(),
        appId,
      );
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
    return result;
  }

  async #verifyPolicy(
    app: ManagedApp,
    isolated: IsolatedEnv,
    baselinePlugins: string[],
    endpoint: string,
  ): Promise<string[]> {
    const verify = this.#options.verify ?? verifyInstancePolicy;
    const trustedRoots = resolvePermissionPaths({
      home: isolated.HOME,
      xdgDataHome: isolated.XDG_DATA_HOME,
      xdgConfigHome: isolated.XDG_CONFIG_HOME,
      xdgCacheHome: isolated.XDG_CACHE_HOME,
      tmpdir: isolated.TMPDIR,
      baselinePlugins,
    });
    try {
      return await verify({
        endpoint,
        appDir: app.appDir,
        trustedRoots,
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
