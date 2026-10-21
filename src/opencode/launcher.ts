import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import type { EffectiveSettings } from "../settings/types.js";
import type { SqliteDatabase } from "../store/index.js";
import { writeAuthFile } from "./auth.js";
import {
  buildConfigOverlay,
  type InstanceIdentity,
  type McpLocalServer,
  resolveInstanceEnv,
} from "./instance.js";
import {
  buildPermissionPolicy,
  type PermissionAction,
  resolvePermissionPaths,
  scrubInstanceEnv,
  type WebPermissionOptions,
} from "./policy.js";

export interface LaunchInput {
  appId: string;
  identity: InstanceIdentity;
  appDir: string;
  runtimeRoot: string;
  port: number;
  coordinatorCommand: string[];
  coordinatorEnvironment?: Record<string, string>;
  codegraphCommand?: string[];
  instructions?: string[];
  baselinePlugins?: string[];
  command?: string[];
  baseEnv?: NodeJS.ProcessEnv;
  model?: string;
  auth?: Record<string, unknown>;
  omoProfile?: string;
  mcpServers?: Record<string, McpLocalServer>;
  web?: EffectiveSettings["web"];
}

export interface RunningInstance {
  id: string;
  appId: string;
  endpoint: string;
  pid: number | undefined;
  bootId: string;
  process: ChildProcess;
}

export function endpointFor(hostname: string, port: number): string {
  return `http://${hostname}:${port}`;
}

function realParentDir(appDir: string): string {
  try {
    return path.dirname(realpathSync(appDir));
  } catch {
    return path.dirname(path.resolve(appDir));
  }
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

/** Compose the isolated environment for one instance, including the config overlay. */
export function buildInstanceEnv(input: LaunchInput): NodeJS.ProcessEnv {
  const isolated = resolveInstanceEnv(input.runtimeRoot, input.identity);
  const permission = buildPermissionPolicy(
    resolvePermissionPaths({
      home: isolated.HOME,
      xdgDataHome: isolated.XDG_DATA_HOME,
      xdgConfigHome: isolated.XDG_CONFIG_HOME,
      xdgCacheHome: isolated.XDG_CACHE_HOME,
      tmpdir: isolated.TMPDIR,
      baselinePlugins: input.baselinePlugins,
    }),
    webPermissionOptions(input.web),
  );
  const overlay = buildConfigOverlay({
    coordinatorCommand: input.coordinatorCommand,
    codegraphCommand: input.codegraphCommand,
    environment: input.coordinatorEnvironment,
    instructions: input.instructions,
    plugins: input.baselinePlugins,
    permission,
    model: input.model,
    mcpServers: input.mcpServers,
  });
  const env = scrubInstanceEnv({
    ...process.env,
    ...input.baseEnv,
    ...isolated,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay),
  });
  env.GIT_CEILING_DIRECTORIES = realParentDir(input.appDir);
  if (input.omoProfile !== undefined) {
    env.OMO_PROFILE = input.omoProfile;
  }
  return env;
}

function recordInstance(
  db: SqliteDatabase,
  instance: {
    id: string;
    appId: string;
    endpoint: string;
    pid: number | null;
    bootId: string;
    state: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO instances (id, app_id, endpoint, pid, boot_id, state, started_at, heartbeat_at, updated_at)
     VALUES (@id, @app_id, @endpoint, @pid, @boot_id, @state, @started_at, @heartbeat_at, @updated_at)
     ON CONFLICT(app_id) DO UPDATE SET
       id = excluded.id, endpoint = excluded.endpoint, pid = excluded.pid, boot_id = excluded.boot_id,
       state = excluded.state, started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at,
       updated_at = excluded.updated_at`,
  ).run({
    id: instance.id,
    app_id: instance.appId,
    endpoint: instance.endpoint,
    pid: instance.pid,
    boot_id: instance.bootId,
    state: instance.state,
    started_at: now,
    heartbeat_at: now,
    updated_at: now,
  });
}

/** Start an `opencode serve` instance for a (project, app) and record it. */
export function launchInstance(db: SqliteDatabase, input: LaunchInput): RunningInstance {
  const hostname = "127.0.0.1";
  const endpoint = endpointFor(hostname, input.port);
  const command = input.command ?? [
    "opencode",
    "serve",
    "--hostname",
    hostname,
    "--port",
    String(input.port),
  ];
  const [bin, ...args] = command;
  if (bin === undefined) {
    throw new Error("launch command must not be empty");
  }

  const id = randomUUID();
  const bootId = randomUUID();
  const env = buildInstanceEnv(input);
  if (input.auth !== undefined) {
    writeAuthFile(path.join(String(env.XDG_DATA_HOME), "opencode", "auth.json"), input.auth);
  }
  const isolated = resolveInstanceEnv(input.runtimeRoot, input.identity);
  for (const directory of [
    isolated.HOME,
    isolated.XDG_DATA_HOME,
    isolated.XDG_STATE_HOME,
    isolated.XDG_CONFIG_HOME,
    isolated.XDG_CACHE_HOME,
    isolated.TMPDIR,
    isolated.MISE_DATA_DIR,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(path.join(isolated.XDG_DATA_HOME, "opencode"), { recursive: true });
  mkdirSync(input.appDir, { recursive: true });
  const child = spawn(bin, args, {
    cwd: input.appDir,
    env,
    stdio: "ignore",
  });
  const pid = child.pid ?? null;
  recordInstance(db, { id, appId: input.appId, endpoint, pid, bootId, state: "running" });

  child.on("error", () => {
    try {
      recordInstance(db, { id, appId: input.appId, endpoint, pid: null, bootId, state: "failed" });
    } catch {
      return;
    }
  });

  child.on("exit", () => {
    try {
      recordInstance(db, { id, appId: input.appId, endpoint, pid: null, bootId, state: "stopped" });
    } catch {
      // The database may already be closed during teardown; ignore.
    }
  });

  return { id, appId: input.appId, endpoint, pid: child.pid, bootId, process: child };
}

export interface StopInstanceOptions {
  /** How long to wait after SIGTERM before sending SIGKILL. Defaults to 5000 ms. */
  timeoutMs?: number;
}

function isAlive(process: ChildProcess): boolean {
  return process.exitCode === null && process.signalCode === null;
}

function waitForExit(process: ChildProcess): Promise<void> {
  if (!isAlive(process)) return Promise.resolve();
  return new Promise((resolve) => {
    process.once("exit", () => resolve());
  });
}

/** Stop a running instance and mark it stopped. */
export async function stopInstance(
  db: SqliteDatabase,
  instance: RunningInstance,
  options: StopInstanceOptions = {},
): Promise<void> {
  const process = instance.process;
  if (isAlive(process)) {
    const exited = waitForExit(process);
    process.kill("SIGTERM");
    const timeoutMs = options.timeoutMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut && isAlive(process)) {
      const killed = waitForExit(process);
      process.kill("SIGKILL");
      let killTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        killed,
        new Promise<void>((resolve) => {
          killTimer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (killTimer !== undefined) clearTimeout(killTimer);
    }
  }
  recordInstance(db, {
    id: instance.id,
    appId: instance.appId,
    endpoint: instance.endpoint,
    pid: null,
    bootId: instance.bootId,
    state: "stopped",
  });
}
