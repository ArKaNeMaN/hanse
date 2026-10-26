import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import path from "node:path";
import { ConfigError } from "../config/load.js";
import { VERSION } from "../version.js";
import { readHostStatus } from "./host.js";
import {
  type ReconcileResponse,
  type RuntimeAppState,
  type RuntimeAppStatus,
  type RuntimeErrorBody,
  type RuntimeHealth,
  type RuntimeLogs,
  type RuntimeVersion,
  stoppedStatus,
} from "./protocol.js";
import {
  type AppRuntimeSpec,
  DEFAULT_AGENT_AGENTS_ROOT,
  DEFAULT_AGENT_WORKSPACE_ROOT,
  isValidAppId,
  validateAppRuntimeSpec,
} from "./spec.js";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_PORT_BASE = 4100;
const DEFAULT_PORT_COUNT = 100;
const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_MAX_LOG_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

export interface AgentSupervisorOptions {
  token: string;
  workspaceRoot?: string;
  agentsRoot?: string;
  agentHostname?: string;
  hostCommand?: string[];
  portBase?: number;
  portCount?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxLogBytes?: number;
}

export interface RunAgentSupervisorOptions extends AgentSupervisorOptions {
  hostname: string;
  port: number;
  onListening?: (address: string) => void;
}

interface SupervisorEntry {
  spec: AppRuntimeSpec;
  port: number;
  child: ChildProcess;
  logs: LogRing;
  state: RuntimeAppState;
  version: RuntimeVersion | null;
  error?: string;
  startedAt: string;
}

class SupervisorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SupervisorError";
  }
}

class LogRing {
  readonly #maxBytes: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  append(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (buffer.length === 0) return;
    this.#chunks.push(buffer);
    this.#bytes += buffer.length;
    while (this.#bytes > this.#maxBytes) {
      const first = this.#chunks[0];
      if (first === undefined) break;
      const excess = this.#bytes - this.#maxBytes;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#bytes -= excess;
      }
      this.#truncated = true;
    }
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }

  get truncated(): boolean {
    return this.#truncated;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function isAlive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (!isAlive(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "0.0.0.0");
  });
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function errorBody(error: unknown): RuntimeErrorBody {
  if (error instanceof ConfigError) {
    return { error: error.message, code: error.code };
  }
  if (error instanceof SupervisorError) {
    return { error: error.message };
  }
  return { error: "internal error" };
}

function statusFor(status: number, error: unknown): number {
  if (error instanceof SupervisorError) return error.status;
  if (error instanceof ConfigError) return 400;
  return status;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function tokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new SupervisorError(413, "request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new SupervisorError(413, "request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.trim().length === 0) {
    throw new SupervisorError(400, "request body is required");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new SupervisorError(400, "request body must be valid JSON");
  }
}

export class AgentSupervisor {
  readonly #token: string;
  readonly #workspaceRoot: string;
  readonly #agentsRoot: string;
  readonly #agentHostname: string;
  readonly #hostCommand: string[];
  readonly #portBase: number;
  readonly #portCount: number;
  readonly #startTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #maxLogBytes: number;
  readonly #entries = new Map<string, SupervisorEntry>();
  #nextPortIndex = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: AgentSupervisorOptions) {
    if (options.token.trim().length === 0) {
      throw new Error("HANSE_RUNTIME_TOKEN is required");
    }
    this.#token = options.token;
    this.#workspaceRoot = options.workspaceRoot ?? DEFAULT_AGENT_WORKSPACE_ROOT;
    this.#agentsRoot = options.agentsRoot ?? DEFAULT_AGENT_AGENTS_ROOT;
    this.#agentHostname = options.agentHostname ?? "agents";
    this.#hostCommand = options.hostCommand ?? [
      process.execPath,
      process.argv[1] ?? "",
      "agent-host",
    ];
    this.#portBase = options.portBase ?? DEFAULT_PORT_BASE;
    this.#portCount = options.portCount ?? DEFAULT_PORT_COUNT;
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.#maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  }

  /** Ensure one app host. Idempotent by specHash; a changed spec recreates that host only. */
  ensure(raw: unknown, expectedAppId?: string): Promise<RuntimeAppStatus> {
    return this.#mutate(async () => {
      const spec = validateAppRuntimeSpec(raw, this.#specOptions());
      if (expectedAppId !== undefined && spec.appId !== expectedAppId) {
        throw new SupervisorError(400, "appId in the path does not match the spec");
      }

      const existing = this.#entries.get(spec.appId);
      if (
        existing !== undefined &&
        isAlive(existing.child) &&
        existing.spec.specHash === spec.specHash
      ) {
        existing.logs.append(`supervisor: ensure ${spec.appId} is already running\n`);
        return this.#status(existing);
      }

      const logs = existing?.logs ?? new LogRing(this.#maxLogBytes);
      if (existing !== undefined) {
        await this.#stopEntry(existing, "spec changed", "stopped");
        this.#entries.delete(spec.appId);
        logs.append(`supervisor: recreating ${spec.appId} after a spec change\n`);
      }

      const port = spec.port ?? (await this.#allocatePort());
      if (spec.port !== undefined) {
        for (const entry of this.#entries.values()) {
          if (entry.port === port) {
            throw new SupervisorError(
              409,
              `port ${port} is already assigned to ${entry.spec.appId}`,
            );
          }
        }
      }
      const effectiveSpec: AppRuntimeSpec = { ...spec, port };
      const specFile = this.#writeSpecFile(effectiveSpec);
      const entry = this.#spawnHost(effectiveSpec, specFile, logs);
      this.#entries.set(spec.appId, entry);

      try {
        await this.#waitForPort(entry);
        if (!isAlive(entry.child)) {
          throw new Error("agent host exited after listening");
        }
        const hostStatus = readHostStatus(effectiveSpec.stateDir);
        entry.version =
          hostStatus !== undefined &&
          hostStatus.specHash === spec.specHash &&
          hostStatus.port === port &&
          hostStatus.state === "running"
            ? {
                hanseVersion: hostStatus.hanseVersion,
                opencodeVersion: hostStatus.opencodeVersion,
                specHash: hostStatus.specHash,
              }
            : { hanseVersion: VERSION, opencodeVersion: null, specHash: spec.specHash };
        entry.state = "running";
        entry.logs.append(`supervisor: ${spec.appId} running on port ${port}\n`);
        return this.#status(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry.state = "error";
        entry.error = message;
        entry.logs.append(`supervisor: ${spec.appId} failed to start: ${message}\n`);
        await this.#stopEntry(entry, "start failed", "error");
        entry.state = "error";
        entry.error = message;
        throw new SupervisorError(502, `agent host failed to start: ${message}`);
      }
    });
  }

  /** Stop only this app's host; per-app state under the agents root is kept. */
  delete(appId: string): Promise<RuntimeAppStatus> {
    return this.#mutate(async () => {
      if (!isValidAppId(appId)) {
        throw new SupervisorError(400, "invalid app id");
      }
      const entry = this.#entries.get(appId);
      if (entry === undefined) {
        return stoppedStatus(appId);
      }
      await this.#stopEntry(entry, "delete", "stopped");
      this.#entries.delete(appId);
      return this.#status(entry);
    });
  }

  /** Status of one app, or undefined when it has never been started. */
  status(appId: string): RuntimeAppStatus | undefined {
    if (!isValidAppId(appId)) return undefined;
    const entry = this.#entries.get(appId);
    return entry === undefined ? undefined : this.#status(entry);
  }

  /** Bounded logs for one app, or undefined when it has never been started. */
  logs(appId: string): RuntimeLogs | undefined {
    if (!isValidAppId(appId)) return undefined;
    const entry = this.#entries.get(appId);
    if (entry === undefined) return undefined;
    return { appId, logs: entry.logs.text(), truncated: entry.logs.truncated };
  }

  /** Stop every host whose app id is not in the desired list. */
  reconcile(appIds: string[]): Promise<ReconcileResponse> {
    return this.#mutate(async () => {
      if (!Array.isArray(appIds) || appIds.some((appId) => !isValidAppId(appId))) {
        throw new SupervisorError(400, "appIds must be an array of valid app ids");
      }
      const desired = new Set(appIds);
      const stopped: string[] = [];
      for (const [appId, entry] of [...this.#entries]) {
        if (desired.has(appId)) continue;
        await this.#stopEntry(entry, "reconcile", "stopped");
        this.#entries.delete(appId);
        stopped.push(appId);
      }
      return {
        stopped,
        apps: [...this.#entries.values()].map((entry) => this.#status(entry)),
      };
    });
  }

  /** Stop every child and clear the registry. */
  async close(): Promise<void> {
    await this.#mutate(async () => {
      for (const [appId, entry] of [...this.#entries]) {
        await this.#stopEntry(entry, "shutdown", "stopped");
        this.#entries.delete(appId);
      }
    });
  }

  createServer(): Server {
    return createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.end();
          return;
        }
        process.stderr.write(
          `agent-supervisor: request failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        writeJson(response, 500, { error: "internal error" });
      });
    });
  }

  #specOptions(): { workspaceRoot: string; agentsRoot: string } {
    return { workspaceRoot: this.#workspaceRoot, agentsRoot: this.#agentsRoot };
  }

  #endpoint(port: number): string {
    return `http://${this.#agentHostname}:${port}`;
  }

  #status(entry: SupervisorEntry): RuntimeAppStatus {
    const endpoint =
      entry.state === "running" || entry.state === "starting" ? this.#endpoint(entry.port) : null;
    return {
      appId: entry.spec.appId,
      endpoint,
      state: entry.state,
      specHash: entry.spec.specHash,
      version: entry.version,
      imageId: null,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    };
  }

  #mutate<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #allocatePort(): Promise<number> {
    for (let offset = 0; offset < this.#portCount; offset += 1) {
      const index = (this.#nextPortIndex + offset) % this.#portCount;
      const port = this.#portBase + index;
      let used = false;
      for (const entry of this.#entries.values()) {
        if (entry.port === port) {
          used = true;
          break;
        }
      }
      if (used) continue;
      if (await isPortFree(port)) {
        this.#nextPortIndex = (index + 1) % this.#portCount;
        return port;
      }
    }
    throw new SupervisorError(503, "no free agent port in the configured pool");
  }

  #writeSpecFile(spec: AppRuntimeSpec): string {
    const directory = path.join(spec.stateDir, "runtime");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, "spec.json");
    const temp = path.join(directory, `.spec.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(spec), { mode: 0o600 });
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return target;
  }

  #spawnHost(spec: AppRuntimeSpec, specFile: string, logs: LogRing): SupervisorEntry {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? DEFAULT_PATH,
      ...spec.env,
    };
    const [bin, ...args] = this.#hostCommand;
    if (bin === undefined || bin.length === 0) {
      throw new SupervisorError(500, "agent host command is not configured");
    }
    logs.append(`supervisor: starting ${spec.appId} on port ${spec.port}\n`);
    const child = spawn(bin, [...args, "--spec", specFile], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entry: SupervisorEntry = {
      spec,
      port: spec.port as number,
      child,
      logs,
      state: "starting",
      version: null,
      startedAt: new Date().toISOString(),
    };
    child.stdout?.on("data", (chunk: Buffer) => logs.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => logs.append(chunk));
    child.once("error", (error) => {
      logs.append(`supervisor: agent host error: ${error.message}\n`);
      if (entry.state === "starting" || entry.state === "running") {
        entry.state = "error";
        entry.error = error.message;
      }
    });
    child.once("exit", (code, signal) => {
      logs.append(
        `supervisor: ${spec.appId} host exited with ${code === null ? (signal ?? "unknown") : code}\n`,
      );
      if (entry.state === "starting" || entry.state === "running") {
        entry.state = code === 0 ? "stopped" : "error";
        entry.error =
          code === 0 ? undefined : `agent host exited with ${code ?? signal ?? "unknown"}`;
      }
    });
    return entry;
  }

  #waitForPort(entry: SupervisorEntry): Promise<void> {
    const deadline = Date.now() + this.#startTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        entry.child.removeListener("exit", onExit);
        entry.child.removeListener("error", onError);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onExit = (): void => finish(new Error("agent host exited before listening"));
      const onError = (error: Error): void => finish(error);
      entry.child.once("exit", onExit);
      entry.child.once("error", onError);
      const attempt = (): void => {
        if (settled) return;
        if (!isAlive(entry.child)) {
          finish(new Error("agent host exited before listening"));
          return;
        }
        if (Date.now() > deadline) {
          finish(new Error(`agent host did not listen on port ${entry.port}`));
          return;
        }
        const socket = connect(entry.port, "127.0.0.1");
        socket.once("connect", () => {
          socket.destroy();
          finish();
        });
        socket.once("error", () => {
          socket.destroy();
          if (!settled) setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  async #stopEntry(
    entry: SupervisorEntry,
    reason: string,
    finalState: RuntimeAppState,
  ): Promise<void> {
    if (isAlive(entry.child)) {
      entry.logs.append(`supervisor: stopping ${entry.spec.appId} (${reason})\n`);
      const exited = waitForExit(entry.child);
      entry.child.kill("SIGTERM");
      const timedOut = await Promise.race([
        exited.then(() => false),
        delay(this.#stopTimeoutMs).then(() => true),
      ]);
      if (timedOut && isAlive(entry.child)) {
        const killed = waitForExit(entry.child);
        entry.child.kill("SIGKILL");
        await Promise.race([killed, delay(this.#stopTimeoutMs)]);
      }
    }
    entry.state = finalState;
    entry.error = finalState === "error" ? entry.error : undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (url.pathname === "/healthz") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      const health: RuntimeHealth = { ok: true, hanseVersion: VERSION, apps: this.#entries.size };
      writeJson(response, 200, health);
      return;
    }

    const provided = bearerToken(request);
    if (provided === undefined || !tokenMatches(provided, this.#token)) {
      writeJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }

    if (url.pathname === "/v1/reconcile") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      await this.#handleReconcile(request, response);
      return;
    }

    const match = /^\/v1\/apps\/([^/]+)(?:\/(ensure|logs))?$/.exec(url.pathname);
    if (match === null) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    const rawAppId = match[1];
    if (rawAppId === undefined) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    let appId: string;
    try {
      appId = decodeURIComponent(rawAppId);
    } catch {
      writeJson(response, 400, { error: "invalid app id" });
      return;
    }
    if (!isValidAppId(appId)) {
      writeJson(response, 400, { error: "invalid app id" });
      return;
    }
    const action = match[2];

    try {
      if (action === "ensure") {
        if (method !== "POST") {
          writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
          return;
        }
        const spec = await readJson(request);
        writeJson(response, 200, await this.ensure(spec, appId));
        return;
      }
      if (action === "logs") {
        if (method !== "GET") {
          writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
          return;
        }
        const logs = this.logs(appId);
        if (logs === undefined) {
          writeJson(response, 404, { error: "unknown app" });
          return;
        }
        writeJson(response, 200, logs);
        return;
      }
      if (method === "GET") {
        const status = this.status(appId);
        if (status === undefined) {
          writeJson(response, 404, { error: "unknown app" });
          return;
        }
        writeJson(response, 200, status);
        return;
      }
      if (method === "DELETE") {
        writeJson(response, 200, await this.delete(appId));
        return;
      }
      writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET, DELETE" });
    } catch (error) {
      const status = statusFor(500, error);
      if (status >= 500) {
        process.stderr.write(
          `agent-supervisor: ${method} ${url.pathname} failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
      writeJson(response, status, errorBody(error));
    }
  }

  async #handleReconcile(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readJson(request);
      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as { appIds?: unknown }).appIds)
      ) {
        throw new SupervisorError(400, 'body must be {"appIds": [...]}');
      }
      const appIds = (body as { appIds: unknown[] }).appIds;
      if (appIds.length > 1000) {
        throw new SupervisorError(400, "too many app ids");
      }
      const result = await this.reconcile(appIds as string[]);
      writeJson(response, 200, result);
    } catch (error) {
      const status = statusFor(500, error);
      if (status >= 500) {
        process.stderr.write(
          `agent-supervisor: reconcile failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
      writeJson(response, status, errorBody(error));
    }
  }
}

/** Start the supervisor HTTP server and wait for SIGTERM/SIGINT before stopping children. */
export async function runAgentSupervisor(options: RunAgentSupervisorOptions): Promise<number> {
  const supervisor = new AgentSupervisor(options);
  const server = supervisor.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.hostname);
  });
  options.onListening?.(`http://${options.hostname}:${options.port}`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      resolve();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });

  await supervisor.close();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return 0;
}
