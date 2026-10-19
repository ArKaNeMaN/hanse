import { connect, createServer } from "node:net";
import path from "node:path";
import { hashValue } from "../settings/hash.js";
import type {
  EffectiveSettings,
  LaunchSettingsSnapshot,
  SettingsTarget,
} from "../settings/types.js";
import type { SqliteDatabase } from "../store/index.js";
import { buildWebMcpConfig } from "../web/config.js";
import { type McpLocalServer, resolveInstanceEnv } from "./instance.js";
import {
  type LaunchInput,
  launchInstance,
  type RunningInstance,
  stopInstance,
} from "./launcher.js";
import type { OmoProfileInput, OmoProfileResult } from "./omo-profile.js";
import {
  resolvePermissionPaths,
  type VerifyPolicyOptions,
  verifyInstancePolicy,
} from "./policy.js";

export interface ManagedApp {
  id: string;
  projectId: string;
  appKey: string;
  appDir: string;
}

/** Injectable subset of `SettingsService` used for launch snapshots. */
export interface SettingsSource {
  snapshot(target: SettingsTarget): LaunchSettingsSnapshot;
}

/** Injectable subset of `OmoProfileStore` used for profile application and hashing. */
export interface OmoProfileSource {
  ensure(input: OmoProfileInput): Promise<OmoProfileResult>;
  preview(input: OmoProfileInput): OmoProfileResult;
}

interface Entry {
  run: RunningInstance;
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
  /** Injectable launcher for tests. */
  launch?: (db: SqliteDatabase, input: LaunchInput) => RunningInstance;
  /** Injectable policy verifier for tests. */
  verify?: (options: VerifyPolicyOptions) => Promise<string[]>;
  verificationTimeoutMs?: number;
  verificationRetries?: number;
  verificationRetryDelayMs?: number;
  settings?: SettingsSource;
  omoProfiles?: OmoProfileSource;
  /** Injectable model-propagation verifier for tests. */
  modelVerifier?: (endpoint: string, expected: string) => Promise<string[]>;
  stopTimeoutMs?: number;
  /** First port probed for a launched instance. Defaults to 4100; tests inject a disjoint range. */
  portBase?: number;
}

const PORT_BASE = 4100;
const PORT_COUNT = 100;
const DEFAULT_MODEL = "deepseek/deepseek-flash";

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
    const response = await fetchImpl(`${endpoint}/agent`, {
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

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = (): void => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`opencode instance did not start on port ${port}`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

export class InstanceManager {
  readonly #db: SqliteDatabase;
  readonly #dbPath: string;
  readonly #runtimeRoot: string;
  readonly #options: InstanceManagerOptions;
  readonly #running = new Map<string, Entry>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #portBase: number;
  #nextPort: number;

  constructor(
    db: SqliteDatabase,
    dbPath: string,
    runtimeRoot: string,
    options: InstanceManagerOptions = {},
  ) {
    this.#db = db;
    this.#dbPath = dbPath;
    this.#runtimeRoot = runtimeRoot;
    this.#options = options;
    this.#portBase = options.portBase ?? PORT_BASE;
    this.#nextPort = this.#portBase;
  }

  async ensure(app: ManagedApp): Promise<string> {
    return this.#withAppLock(app.id, async () => {
      const existing = this.#running.get(app.id);
      if (existing !== undefined && this.#isRunningEntry(existing)) {
        return existing.endpoint;
      }
      const port = await this.#allocatePort();
      const runtimeRoot = path.join(this.#runtimeRoot, "projects", app.projectId);
      const baselinePlugins = resolveBaselinePlugins();
      const launch = this.#options.launch ?? launchInstance;
      const identity = { projectId: app.projectId, app: app.appKey };
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
        const profile = await omoProfiles.ensure({
          appId: app.id,
          model,
          disableWebsearch: disableWebsearch(web),
        });
        auth = snapshot.mergedAuth;
        omoProfile = profile.applied ? profile.name : undefined;
        appliedProfile = profile.applied;
        profileWarning = profile.warning;
        settingsHash = settingsHashFor(snapshot, profile.contentHash);
        const webConfig = buildWebMcpConfig(web);
        if (webConfig !== undefined) {
          const isolated = resolveInstanceEnv(runtimeRoot, identity);
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

      const run = launch(this.#db, {
        appId: app.id,
        identity,
        appDir: app.appDir,
        runtimeRoot,
        port,
        coordinatorCommand: [process.execPath, process.argv[1] ?? "", "mcp"],
        coordinatorEnvironment: {
          HANSE_DB: this.#dbPath,
          HANSE_PROJECT_ID: app.projectId,
          HANSE_APP_KEY: app.appKey,
        },
        baselinePlugins,
        codegraphCommand: resolveCodegraphCommand(),
        model,
        auth,
        omoProfile,
        mcpServers,
        web,
      });
      const entry: Entry = {
        run,
        endpoint: run.endpoint,
        projectId: app.projectId,
        appKey: app.appKey,
        policyWarnings: [],
        settingsHash,
        appliedProfile,
        profileWarning,
      };
      this.#running.set(app.id, entry);
      await waitForPort(port, 10000);
      entry.policyWarnings = await this.#verifyPolicy(
        app,
        runtimeRoot,
        baselinePlugins,
        run.endpoint,
      );
      if (model !== undefined) {
        const verifyModel = this.#options.modelVerifier ?? verifyAgentModels;
        entry.modelWarnings = await verifyModel(run.endpoint, model);
      }
      return run.endpoint;
    });
  }

  isRunning(appId: string): boolean {
    const entry = this.#running.get(appId);
    return entry !== undefined && this.#isRunningEntry(entry);
  }

  pendingRestart(appId: string): { pending: boolean; reasons: string[] } {
    const entry = this.#running.get(appId);
    const settings = this.#options.settings;
    const omoProfiles = this.#options.omoProfiles;
    if (
      entry === undefined ||
      !this.#isRunningEntry(entry) ||
      settings === undefined ||
      omoProfiles === undefined
    ) {
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
      if (entry === undefined) return false;
      const wasRunning = this.#isRunningEntry(entry);
      this.#running.delete(appId);
      await stopInstance(this.#db, entry.run, { timeoutMs: this.#options.stopTimeoutMs });
      return wasRunning;
    });
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

  #isRunningEntry(entry: Entry): boolean {
    return entry.run.process.exitCode === null && entry.run.process.signalCode === null;
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
    runtimeRoot: string,
    baselinePlugins: string[],
    endpoint: string,
  ): Promise<string[]> {
    const verify = this.#options.verify ?? verifyInstancePolicy;
    const isolated = resolveInstanceEnv(runtimeRoot, {
      projectId: app.projectId,
      app: app.appKey,
    });
    const trustedRoots = resolvePermissionPaths({
      xdgDataHome: isolated.XDG_DATA_HOME,
      xdgConfigHome: isolated.XDG_CONFIG_HOME,
      xdgCacheHome: isolated.XDG_CACHE_HOME,
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

  stopAll(): void {
    for (const entry of this.#running.values()) {
      entry.run.process.kill("SIGTERM");
    }
    this.#running.clear();
  }

  async #allocatePort(): Promise<number> {
    for (let attempt = 0; attempt < PORT_COUNT; attempt += 1) {
      const port = this.#portBase + ((this.#nextPort - this.#portBase + attempt) % PORT_COUNT);
      if (await portFree(port)) {
        this.#nextPort = port + 1;
        return port;
      }
    }
    throw new Error("no free port for an opencode instance");
  }
}
