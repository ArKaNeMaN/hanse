import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentRuntimeClient } from "../agent/client.js";
import {
  type AppRuntimeSpec,
  computeSpecHash,
  type SpecHashInput,
  validateAppRuntimeSpec,
} from "../agent/spec.js";
import {
  agentTokenMatches,
  ensureAgentToken,
  mcpTokenPath,
  revokeAgentToken,
} from "../mcp/agent-tokens.js";
import { type AppImageStatus, resolveAppBuild } from "../registry/index.js";
import { appNetworkName, mapToHostPath } from "../runner/names.js";
import { RUNNER_APP_PORT } from "../runner/validate.js";
import { hashValue } from "../settings/hash.js";
import type {
  EffectiveSettings,
  LaunchSettingsSnapshot,
  SettingsTarget,
} from "../settings/types.js";
import type { SqliteDatabase } from "../store/index.js";
import { buildWebMcpConfig } from "../web/config.js";
import { writeAuthFile } from "./auth.js";
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

export interface ManagedApp {
  id: string;
  projectId: string;
  appKey: string;
  appDir: string;
  imageStatus?: AppImageStatus;
  imageRef?: string | null;
}

/** Injectable subset of `SettingsService` used for launch snapshots. */
export interface SettingsSource {
  snapshot(target: SettingsTarget): LaunchSettingsSnapshot;
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

function settingsHashFor(snapshot: LaunchSettingsSnapshot, profile: string): string {
  return hashValue({
    effective: snapshot.resolved.effective,
    providerKeys: snapshot.resolved.providerKeys,
    authHash: snapshot.authHash,
    profile,
  });
}

function resolveBaselinePlugins(): string[] {
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
  readonly #locks = new Map<string, Promise<unknown>>();

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
      const identity = { projectId: app.projectId, app: app.appKey };
      const tokenFile = mcpTokenPath(this.#runtimeRoot, identity);
      const isolated = resolveInstanceEnv(this.#runtimeRoot, identity);
      const passwordFile = opencodePasswordPath(isolated.XDG_STATE_HOME);
      const existing = this.#running.get(app.id);
      const current = await this.#options.runtime.status(app.id);
      const running =
        current !== undefined && (current.state === "running" || current.state === "starting");
      const existingPassword = readOpencodePassword(passwordFile);
      if (
        running &&
        existingPassword !== undefined &&
        agentTokenMatches(this.#db, app.id, tokenFile)
      ) {
        // Reconnect after a coordinator restart or a caller retry. Settings/spec changes stay
        // "restart required" until an explicit stop and restart.
        const endpoint = current.endpoint ?? existing?.endpoint;
        if (endpoint !== undefined && endpoint !== null) {
          setEndpointAuthorization(endpoint, OPENCODE_BASIC_USERNAME, existingPassword);
          if (existing === undefined) {
            this.#running.set(app.id, {
              endpoint,
              projectId: app.projectId,
              appKey: app.appKey,
              policyWarnings: [],
              settingsHash: this.#currentSettingsHash(app),
              appliedProfile: true,
            });
          } else {
            if (existing.endpoint !== endpoint) {
              clearEndpointAuthorization(existing.endpoint);
            }
            existing.endpoint = endpoint;
          }
          return endpoint;
        }
      }
      const image = resolveAgentImage(app);
      if (existing !== undefined) {
        clearEndpointAuthorization(existing.endpoint);
        this.#running.delete(app.id);
        await this.#options.runtime.delete(app.id);
      } else if (current !== undefined) {
        await this.#options.runtime.delete(app.id);
      }

      const baselinePlugins = resolveBaselinePlugins();
      let model: string | undefined;
      let auth: Record<string, unknown> | undefined;
      let omoProfile: string | undefined;
      let mcpServers: Record<string, McpLocalServer> | undefined;
      let web: EffectiveSettings["web"] | undefined;
      let settingsHash: string | undefined;
      let appliedProfile = true;
      let profileWarning: string | undefined;

      const settings = this.#options.settings;
      const omoProfiles = this.#options.omoProfiles;
      if (settings !== undefined && omoProfiles !== undefined) {
        const snapshot = settings.snapshot({ projectId: app.projectId, appKey: app.appKey });
        web = snapshot.resolved.effective.web;
        model = snapshot.resolved.effective.llm.model.value ?? DEFAULT_MODEL;
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
        settingsHash = settingsHashFor(snapshot, profile.contentHash);
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
      this.#recordStatus(app, status, image);
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
      entry.policyWarnings = await this.#verifyPolicy(app, isolated, baselinePlugins, endpoint);
      if (model !== undefined) {
        const verifyModel = this.#options.modelVerifier ?? verifyAgentModels;
        entry.modelWarnings = await verifyModel(endpoint, model);
      }
      return endpoint;
    });
  }

  isRunning(appId: string): boolean {
    return this.#running.has(appId);
  }

  pendingRestart(appId: string): { pending: boolean; reasons: string[] } {
    const entry = this.#running.get(appId);
    const settings = this.#options.settings;
    const omoProfiles = this.#options.omoProfiles;
    if (entry === undefined || settings === undefined || omoProfiles === undefined) {
      return { pending: false, reasons: [] };
    }
    const reasons: string[] = [];
    if (entry.appliedProfile === false) {
      reasons.push("profile_not_applied");
    }
    try {
      const snapshot = settings.snapshot({ projectId: entry.projectId, appKey: entry.appKey });
      const effective = snapshot.resolved.effective;
      const model = effective.llm.model.value ?? DEFAULT_MODEL;
      const preview = omoProfiles.preview({
        appId,
        model,
        disableWebsearch: disableWebsearch(effective.web),
      });
      if (settingsHashFor(snapshot, preview.contentHash) !== entry.settingsHash) {
        reasons.push("settings_changed");
      }
    } catch {
      reasons.push("settings_changed");
    }
    return { pending: reasons.length > 0, reasons };
  }

  async stopApp(appId: string): Promise<boolean> {
    return this.#withAppLock(appId, async () => {
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
      this.#running.delete(appId);
      if (endpoint !== undefined && endpoint !== null) {
        clearEndpointAuthorization(endpoint);
      }
      const finalStatus = await this.#options.runtime.delete(appId);
      this.#recordStatusById(appId, finalStatus);
      this.#revokeAgentToken(appId, entry);
      return wasRunning;
    });
  }

  async restartIfRunning(app: ManagedApp): Promise<boolean> {
    let running = this.#running.has(app.id);
    if (!running) {
      const status = await this.#options.runtime.status(app.id).catch(() => undefined);
      running = status?.state === "running" || status?.state === "starting";
    }
    if (!running) {
      return false;
    }
    await this.stopApp(app.id);
    await this.ensure(app);
    return true;
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
  }

  /**
   * Drop coordinator-side state without stopping hosts or revoking tokens.
   *
   * This is the coordinator-shutdown path: agents stay healthy and the next coordinator attaches to
   * them through the same token files and per-app password.
   */
  detach(): void {
    for (const entry of this.#running.values()) {
      clearEndpointAuthorization(entry.endpoint);
    }
    this.#running.clear();
  }

  #recordStatus(
    app: ManagedApp,
    status: Awaited<ReturnType<AgentRuntimeClient["ensure"]>>,
    image: string,
  ): void {
    const now = new Date().toISOString();
    const startedAt = status.state === "running" ? now : null;
    this.#db
      .prepare(
        `INSERT INTO instances
           (id, app_id, endpoint, state, runtime_state, spec_hash, container_id, container_name, image_ref, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           updated_at = excluded.updated_at`,
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

  #currentSettingsHash(app: ManagedApp): string | undefined {
    const settings = this.#options.settings;
    const omoProfiles = this.#options.omoProfiles;
    if (settings === undefined || omoProfiles === undefined) return undefined;
    try {
      const snapshot = settings.snapshot({ projectId: app.projectId, appKey: app.appKey });
      const effective = snapshot.resolved.effective;
      const model = effective.llm.model.value ?? DEFAULT_MODEL;
      const preview = omoProfiles.preview({
        appId: app.id,
        model,
        disableWebsearch: disableWebsearch(effective.web),
      });
      return settingsHashFor(snapshot, preview.contentHash);
    } catch {
      return undefined;
    }
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
