import { connect, createServer } from "node:net";
import path from "node:path";
import type { SqliteDatabase } from "../store/index.js";
import { resolveInstanceEnv } from "./instance.js";
import { type LaunchInput, launchInstance, type RunningInstance } from "./launcher.js";
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

interface Entry {
  run: RunningInstance;
  endpoint: string;
  policyWarnings: string[];
}

export interface InstanceManagerOptions {
  /** Injectable launcher for tests. */
  launch?: (db: SqliteDatabase, input: LaunchInput) => RunningInstance;
  /** Injectable policy verifier for tests. */
  verify?: (options: VerifyPolicyOptions) => Promise<string[]>;
  verificationTimeoutMs?: number;
  verificationRetries?: number;
  verificationRetryDelayMs?: number;
}

const PORT_BASE = 4100;
const PORT_COUNT = 100;

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
  #nextPort = PORT_BASE;

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
  }

  async ensure(app: ManagedApp): Promise<string> {
    const existing = this.#running.get(app.id);
    if (existing !== undefined && existing.run.process.exitCode === null) {
      return existing.endpoint;
    }
    const port = await this.#allocatePort();
    const runtimeRoot = path.join(this.#runtimeRoot, "projects", app.projectId);
    const baselinePlugins = resolveBaselinePlugins();
    const launch = this.#options.launch ?? launchInstance;
    const run = launch(this.#db, {
      appId: app.id,
      identity: { projectId: app.projectId, app: app.appKey },
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
      authSource: process.env.HANSE_AUTH_FILE,
    });
    const entry: Entry = { run, endpoint: run.endpoint, policyWarnings: [] };
    this.#running.set(app.id, entry);
    await waitForPort(port, 10000);
    entry.policyWarnings = await this.#verifyPolicy(
      app,
      runtimeRoot,
      baselinePlugins,
      run.endpoint,
    );
    return run.endpoint;
  }

  /** Policy warnings recorded for an app, or an empty list when it has not been verified. */
  policyWarnings(appId: string): string[] {
    return [...(this.#running.get(appId)?.policyWarnings ?? [])];
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
      const port = PORT_BASE + ((this.#nextPort - PORT_BASE + attempt) % PORT_COUNT);
      if (await portFree(port)) {
        this.#nextPort = port + 1;
        return port;
      }
    }
    throw new Error("no free port for an opencode instance");
  }
}
