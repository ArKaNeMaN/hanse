import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../store/index.js";
import { buildConfigOverlay, type InstanceIdentity, resolveInstanceEnv } from "./instance.js";

export interface LaunchInput {
  appId: string;
  identity: InstanceIdentity;
  appDir: string;
  runtimeRoot: string;
  port: number;
  coordinatorCommand: string[];
  instructions?: string[];
  command?: string[];
  baseEnv?: NodeJS.ProcessEnv;
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

/** Compose the isolated environment for one instance, including the config overlay. */
export function buildInstanceEnv(input: LaunchInput): NodeJS.ProcessEnv {
  const isolated = resolveInstanceEnv(input.runtimeRoot, input.identity);
  const overlay = buildConfigOverlay({
    coordinatorCommand: input.coordinatorCommand,
    instructions: input.instructions,
  });
  return {
    ...input.baseEnv,
    ...isolated,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(overlay),
  };
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
  const child = spawn(bin, args, {
    cwd: input.appDir,
    env: buildInstanceEnv(input),
    stdio: "ignore",
  });
  const pid = child.pid ?? null;
  recordInstance(db, { id, appId: input.appId, endpoint, pid, bootId, state: "running" });

  child.on("exit", () => {
    try {
      recordInstance(db, { id, appId: input.appId, endpoint, pid: null, bootId, state: "stopped" });
    } catch {
      // The database may already be closed during teardown; ignore.
    }
  });

  return { id, appId: input.appId, endpoint, pid: child.pid, bootId, process: child };
}

/** Stop a running instance and mark it stopped. */
export async function stopInstance(db: SqliteDatabase, instance: RunningInstance): Promise<void> {
  if (instance.process.exitCode === null && instance.process.signalCode === null) {
    instance.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      instance.process.once("exit", () => resolve());
    });
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
