import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ConfigError } from "../config/load.js";
import { readRegularFileNoFollow } from "../opencode/password.js";
import { resolveWithinRoot } from "../runtime/app-path.js";
import { VERSION } from "../version.js";
import type { HostStatusPayload, RuntimeAppState } from "./protocol.js";
import {
  type AppRuntimeSpec,
  DEFAULT_AGENT_AGENTS_ROOT,
  parseAppRuntimeSpecJson,
  type SpecValidationOptions,
} from "./spec.js";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_VERSION_TIMEOUT_MS = 3000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;

export interface AgentHostOptions extends SpecValidationOptions {
  opencodeBin?: string;
  signal?: AbortSignal;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  versionTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export function hostStatusPath(stateDir: string): string {
  return path.join(stateDir, "runtime", "host-status.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the host status handshake written by {@link runAgentHost}. */
export function readHostStatus(stateDir: string): HostStatusPayload | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(hostStatusPath(stateDir), "utf8"));
    if (!isRecord(value)) return undefined;
    const { hanseVersion, opencodeVersion, specHash, state, pid, port, startedAt } = value;
    if (
      typeof hanseVersion !== "string" ||
      typeof specHash !== "string" ||
      typeof port !== "number" ||
      typeof startedAt !== "string"
    ) {
      return undefined;
    }
    if (opencodeVersion !== null && typeof opencodeVersion !== "string") return undefined;
    if (pid !== null && typeof pid !== "number") return undefined;
    if (state !== "starting" && state !== "running" && state !== "stopped" && state !== "error") {
      return undefined;
    }
    return {
      hanseVersion,
      opencodeVersion,
      specHash,
      state,
      pid,
      port,
      startedAt,
    };
  } catch {
    return undefined;
  }
}

function writeStatusFile(stateDir: string, payload: HostStatusPayload): void {
  const target = hostStatusPath(stateDir);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.host-status.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function hostError(message: string): ConfigError {
  return new ConfigError("VALIDATION_FAILED", message);
}

function requireAgentPath(value: string, agentsRoot: string, label: string): string {
  const resolved = resolveWithinRoot({ target: value, root: agentsRoot, label });
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    throw hostError(`${label} does not exist: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw hostError(`${label} is not a regular file: ${resolved}`);
  }
  return resolved;
}

/**
 * Build the minimal environment for `opencode serve`.
 *
 * Only the validated spec env and PATH are passed; `HANSE_RUNTIME_TOKEN` and coordinator state are
 * never inherited. The password file is read here and replaced with `OPENCODE_SERVER_PASSWORD`.
 */
export function buildOpencodeEnv(
  spec: AppRuntimeSpec,
  baseEnv: NodeJS.ProcessEnv,
  agentsRoot = DEFAULT_AGENT_AGENTS_ROOT,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: baseEnv.PATH ?? DEFAULT_PATH,
    ...spec.env,
  };

  const authFile = spec.env.HANSE_OPENCODE_AUTH_FILE;
  if (authFile !== undefined && authFile.length > 0) {
    env.HANSE_OPENCODE_AUTH_FILE = requireAgentPath(
      authFile,
      agentsRoot,
      "HANSE_OPENCODE_AUTH_FILE",
    );
  }

  const passwordFile = spec.env.HANSE_OPENCODE_PASSWORD_FILE;
  if (passwordFile !== undefined && passwordFile.length > 0) {
    const resolved = requireAgentPath(passwordFile, agentsRoot, "HANSE_OPENCODE_PASSWORD_FILE");
    const password = (readRegularFileNoFollow(resolved) ?? "").trim();
    if (password.length === 0) {
      throw hostError(`opencode password file is empty: ${resolved}`);
    }
    env.OPENCODE_SERVER_PASSWORD = password;
  }
  delete env.HANSE_OPENCODE_PASSWORD_FILE;

  const profile = spec.env.OMO_PROFILE;
  if (profile !== undefined && profile.length > 0) {
    const home = spec.env.HOME;
    if (home === undefined || home.length === 0) {
      throw hostError("OMO_PROFILE requires HOME in the runtime spec env");
    }
    const profileFile = path.join(home, ".omo", "omo.jsonc");
    if (!existsSync(profileFile) || !statSync(profileFile).isFile()) {
      throw hostError(`OMO profile file does not exist: ${profileFile}`);
    }
  }

  return env;
}

function ensureDirectories(spec: AppRuntimeSpec): void {
  const env = spec.env;
  const directories = [
    spec.stateDir,
    env.HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.TMPDIR,
    env.MISE_DATA_DIR,
    env.OPENCODE_DB === undefined ? undefined : path.dirname(env.OPENCODE_DB),
  ];
  for (const directory of directories) {
    if (directory !== undefined && directory.length > 0) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }
}

function readOpencodeVersion(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["--version"],
      { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const first = String(stdout).trim().split(/\r?\n/, 1)[0];
        resolve(first === undefined || first.length === 0 ? null : first);
      },
    );
  });
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (!isAlive(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

async function terminate(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isAlive(child)) return;
  const exited = waitForExit(child);
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(timeoutMs).then(() => true),
  ]);
  if (!timedOut || !isAlive(child)) return;
  const killed = waitForExit(child);
  child.kill("SIGKILL");
  await Promise.race([killed, delay(timeoutMs)]);
}

/** Load and validate a spec file for a single-app host. */
export function loadAgentHostSpec(
  specFile: string,
  options: SpecValidationOptions = {},
): AppRuntimeSpec {
  let raw: string;
  try {
    raw = readFileSync(specFile, "utf8");
  } catch (error) {
    throw new ConfigError("READ_FAILED", `cannot read runtime spec: ${specFile}`, {
      path: specFile,
      issues: [error instanceof Error ? error.message : String(error)],
    });
  }
  const spec = parseAppRuntimeSpecJson(raw, options);
  if (spec.port === undefined) {
    throw hostError("agent-host requires an assigned port in the runtime spec");
  }
  if (!existsSync(spec.appDir) || !statSync(spec.appDir).isDirectory()) {
    throw hostError(`appDir does not exist or is not a directory: ${spec.appDir}`);
  }
  return spec;
}

/**
 * Run one agent host: prepare the per-app environment, start `opencode serve`, proxy its output, and
 * exit with the child. Aborting the signal (SIGTERM/SIGINT in the CLI) stops only this child.
 */
export async function runAgentHost(
  specFile: string,
  options: AgentHostOptions = {},
): Promise<number> {
  const spec = loadAgentHostSpec(specFile, options);
  if (spec.port === undefined) {
    throw hostError("agent-host requires an assigned port in the runtime spec");
  }
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENT_AGENTS_ROOT;
  const bin = options.opencodeBin ?? (process.env.HANSE_OPENCODE_BIN?.trim() || "opencode");
  const env = buildOpencodeEnv(spec, process.env, agentsRoot);
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const startedAt = new Date().toISOString();
  const versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  ensureDirectories(spec);
  writeStatusFile(spec.stateDir, {
    hanseVersion: VERSION,
    opencodeVersion: null,
    specHash: spec.specHash,
    state: "starting",
    pid: null,
    port: spec.port,
    startedAt,
  });

  const opencodeVersion = await readOpencodeVersion(bin, env, versionTimeoutMs);
  const child = spawn(bin, ["serve", "--hostname", "0.0.0.0", "--port", String(spec.port)], {
    cwd: spec.appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  stdout(`agent-host: starting ${spec.appId} on port ${spec.port}\n`);
  child.stdout?.on("data", (chunk: Buffer) => stdout(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => stderr(chunk.toString("utf8")));

  const running = (): HostStatusPayload => ({
    hanseVersion: VERSION,
    opencodeVersion,
    specHash: spec.specHash,
    state: "running",
    pid: child.pid ?? null,
    port: spec.port as number,
    startedAt,
  });

  let spawned = false;
  child.once("spawn", () => {
    spawned = true;
    writeStatusFile(spec.stateDir, running());
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: 1, signal: null }));
    },
  );

  let aborted = false;
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<"abort">((resolve) => {
    if (options.signal === undefined) return;
    if (options.signal.aborted) {
      resolve("abort");
      return;
    }
    onAbort = () => resolve("abort");
    options.signal.addEventListener("abort", onAbort, { once: true });
  });

  const first = await Promise.race([exitPromise.then(() => "exit" as const), abortPromise]);
  if (first === "abort") {
    aborted = true;
    await terminate(child, stopTimeoutMs);
  }
  if (onAbort !== undefined) {
    options.signal?.removeEventListener("abort", onAbort);
  }
  const result = await exitPromise;
  const state: RuntimeAppState = aborted || result.code === 0 ? "stopped" : "error";
  writeStatusFile(spec.stateDir, {
    ...running(),
    state,
    pid: null,
    opencodeVersion,
  });
  stdout(
    `agent-host: ${spec.appId} ${
      aborted ? "stopped" : `exited with code ${result.code ?? result.signal ?? "unknown"}`
    }\n`,
  );
  if (!spawned) {
    return 1;
  }
  if (aborted) {
    return 0;
  }
  return result.code ?? (result.signal === null ? 0 : 1);
}
