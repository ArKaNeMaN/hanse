import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from "node:http";
import type { Duplex } from "node:stream";
import {
  type ReconcileResponse,
  type RuntimeAppState,
  type RuntimeAppStatus,
  type RuntimeErrorBody,
  type RuntimeHealth,
  type RuntimeLogs,
  stoppedStatus,
} from "../agent/protocol.js";
import { isValidAppId } from "../agent/spec.js";
import { ConfigError } from "../config/load.js";
import { VERSION } from "../version.js";
import {
  type DockerContainerInspect,
  DockerError,
  type DockerExecRuntime,
  type DockerExecSize,
  type DockerExecStream,
  type DockerRuntime,
} from "./docker.js";
import { validateGitRequest } from "./git.js";
import { appContainerName, appNetworkName } from "./names.js";
import {
  hostPathForSpecEnv,
  RUNNER_APP_PORT,
  type RunnerConfig,
  type RunnerSpec,
  validateRunnerSpec,
} from "./validate.js";
import { acceptWebSocket, websocketHandshakeError } from "./ws.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECONCILE_APPS = 1000;
const DEFAULT_LOG_TAIL = 500;
const RUNNER_ENTRYPOINT = "/usr/local/bin/hanse-agent-entrypoint";
const EXEC_SHELL = "if [ -x /bin/bash ]; then exec /bin/bash -l; fi; exec /bin/sh -l";
const MAX_EXEC_DIMENSION = 1000;

class RunnerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RunnerError";
    this.status = status;
  }
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

function writeSocketResponse(socket: Duplex, status: number, body: unknown): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  socket.write(
    [
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}`,
      "content-type: application/json; charset=utf-8",
      `content-length: ${Buffer.byteLength(payload)}`,
      "cache-control: no-store",
      "connection: close",
      "",
      payload,
    ].join("\r\n"),
  );
  socket.end();
}

function parseResizeControl(data: Buffer, type: "text" | "binary"): DockerExecSize | undefined {
  if (type !== "text") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as { type?: unknown; rows?: unknown; cols?: unknown };
  if (candidate.type !== "resize") return undefined;
  if (!Number.isInteger(candidate.rows) || !Number.isInteger(candidate.cols)) return undefined;
  const rows = candidate.rows as number;
  const cols = candidate.cols as number;
  if (rows < 1 || cols < 1 || rows > MAX_EXEC_DIMENSION || cols > MAX_EXEC_DIMENSION) {
    return undefined;
  }
  return { rows, cols };
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
    throw new RunnerError(413, "request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RunnerError(413, "request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.trim().length === 0) {
    throw new RunnerError(400, "request body is required");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RunnerError(400, "request body must be valid JSON");
  }
}

function errorBody(error: unknown): RuntimeErrorBody {
  if (error instanceof ConfigError) {
    return { error: error.message, code: error.code };
  }
  if (error instanceof RunnerError) {
    return { error: error.message };
  }
  if (error instanceof DockerError) {
    return { error: error.message, code: "docker_error" };
  }
  return { error: "internal error" };
}

function statusFor(error: unknown): number {
  if (error instanceof RunnerError) return error.status;
  if (error instanceof ConfigError) return 400;
  if (error instanceof DockerError) return error.status >= 500 ? 502 : 400;
  return 500;
}

function appIdFromContainer(summary: { Labels?: Record<string, string> }): string | undefined {
  return summary.Labels?.["hanse.app.id"];
}

function containerState(inspect: DockerContainerInspect): RuntimeAppState {
  if (inspect.State?.Running === true) return "running";
  const status = inspect.State?.Status;
  if (status === "created" || status === "restarting") return "starting";
  if (
    inspect.State?.Error !== undefined ||
    (inspect.State?.ExitCode !== undefined && inspect.State.ExitCode !== 0)
  ) {
    return "error";
  }
  return "stopped";
}

function statusFromInspect(
  appId: string,
  containerName: string,
  inspect: DockerContainerInspect,
): RuntimeAppStatus {
  const state = containerState(inspect);
  const specHash = inspect.Config?.Labels?.["hanse.spec.hash"] ?? null;
  return {
    appId,
    endpoint:
      state === "running" || state === "starting"
        ? `http://${containerName}:${RUNNER_APP_PORT}`
        : null,
    state,
    specHash,
    version: null,
    containerId: inspect.Id,
    containerName,
    ...(inspect.State?.Error === undefined ? {} : { error: inspect.State.Error }),
  };
}

function containerEnvironment(spec: RunnerSpec): Record<string, string> {
  const env: Record<string, string> = { ...spec.env };
  const passwordFile = hostPathForSpecEnv(spec, "HANSE_OPENCODE_PASSWORD_FILE");
  if (passwordFile !== undefined) {
    let password: string;
    try {
      password = readFileSync(passwordFile, "utf8").trim();
    } catch (error) {
      throw new RunnerError(
        400,
        `cannot read opencode password file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (password.length === 0) {
      throw new RunnerError(400, "opencode password file is empty");
    }
    env.OPENCODE_SERVER_PASSWORD = password;
  }
  delete env.HANSE_OPENCODE_PASSWORD_FILE;
  return env;
}

export interface RunnerServiceOptions {
  config: RunnerConfig;
  docker: DockerRuntime;
  exec?: DockerExecRuntime;
}

/** Per-app container runtime behind the same API shape as the B0 supervisor. */
export class RunnerService {
  readonly #config: RunnerConfig;
  readonly #docker: DockerRuntime;
  readonly #exec: DockerExecRuntime | undefined;

  constructor(options: RunnerServiceOptions) {
    this.#config = options.config;
    this.#docker = options.docker;
    this.#exec = options.exec;
  }

  async health(): Promise<RuntimeHealth> {
    const containers = await this.#docker.listContainers("hanse.managed=true");
    return { ok: true, hanseVersion: VERSION, apps: containers.length };
  }

  async ensure(raw: unknown, expectedAppId?: string): Promise<RuntimeAppStatus> {
    const spec = validateRunnerSpec(raw, this.#config);
    if (expectedAppId !== undefined && spec.appId !== expectedAppId) {
      throw new RunnerError(400, "appId in the path does not match the spec");
    }
    await this.#docker.ensureNetwork({
      name: spec.networkName,
      labels: {
        "hanse.managed": "true",
        "hanse.app.id": spec.appId,
      },
    });

    const existing = await this.#docker.inspectContainer(spec.containerName);
    if (existing !== undefined && existing.Config?.Labels?.["hanse.spec.hash"] === spec.specHash) {
      if (existing.State?.Running !== true) {
        await this.#docker.startContainer(existing.Id);
      }
      await this.#connectCoordinator(spec.networkName);
      const inspected = await this.#docker.inspectContainer(spec.containerName);
      if (inspected === undefined) {
        throw new RunnerError(502, "container disappeared after start");
      }
      return statusFromInspect(spec.appId, spec.containerName, inspected);
    }

    if (existing !== undefined) {
      await this.#docker.stopContainer(existing.Id);
      await this.#docker.removeContainer(existing.Id, true);
    }

    const id = await this.#docker.createContainer({
      name: spec.containerName,
      image: spec.image,
      hostname: spec.containerName,
      user: "1000:1000",
      entrypoint: [RUNNER_ENTRYPOINT],
      cmd: [],
      workingDir: spec.containerAppDir,
      env: containerEnvironment(spec),
      labels: {
        ...spec.labels,
        "hanse.managed": "true",
        "hanse.app.id": spec.appId,
        "hanse.image": spec.image,
        "hanse.spec.hash": spec.specHash,
        "hanse.network.name": spec.networkName,
      },
      binds: [
        `${spec.hostAppDir}:${spec.containerAppDir}:rw`,
        `${spec.hostAgentsRoot}:${spec.containerAgentsRoot}:rw`,
      ],
      tmpfs: {
        "/tmp": "rw,exec,nosuid,size=1g",
        "/run": "rw,nosuid,size=16m",
      },
      memoryBytes: spec.resources.memoryBytes,
      nanoCpus: spec.resources.nanoCpus,
      pidsLimit: spec.resources.pidsLimit,
      networkName: spec.networkName,
      networkAliases: [spec.containerName],
    });
    try {
      await this.#docker.startContainer(id);
      await this.#connectCoordinator(spec.networkName);
    } catch (error) {
      await this.#docker.removeContainer(id, true).catch(() => undefined);
      throw error;
    }
    const inspected = await this.#docker.inspectContainer(spec.containerName);
    if (inspected === undefined) {
      throw new RunnerError(502, "container disappeared after create");
    }
    return statusFromInspect(spec.appId, spec.containerName, inspected);
  }

  async delete(appId: string): Promise<RuntimeAppStatus> {
    const summary = await this.#findContainer(appId);
    if (summary === undefined) {
      return stoppedStatus(appId);
    }
    const inspect = await this.#docker.inspectContainer(summary.Id);
    const network = inspect?.Config?.Labels?.["hanse.network.name"] ?? appNetworkName(appId);
    await this.#docker.stopContainer(summary.Id);
    await this.#docker.removeContainer(summary.Id, true);
    await this.#docker
      .disconnectNetwork(network, this.#config.coordinatorContainer)
      .catch(() => undefined);
    await this.#docker.removeNetwork(network).catch(() => undefined);
    return {
      ...stoppedStatus(appId),
      specHash: inspect?.Config?.Labels?.["hanse.spec.hash"] ?? null,
    };
  }

  async status(appId: string): Promise<RuntimeAppStatus | undefined> {
    if (!isValidAppId(appId)) {
      throw new RunnerError(400, "invalid app id");
    }
    const containerName = appContainerName(appId);
    const inspect = await this.#docker.inspectContainer(containerName);
    if (inspect === undefined) return undefined;
    if (inspect.State?.Running === true) {
      const network = inspect.Config?.Labels?.["hanse.network.name"];
      if (network !== undefined) {
        await this.#connectCoordinator(network).catch(() => undefined);
      }
    }
    return statusFromInspect(appId, containerName, inspect);
  }

  async logs(appId: string): Promise<RuntimeLogs | undefined> {
    if (!isValidAppId(appId)) {
      throw new RunnerError(400, "invalid app id");
    }
    const containerName = appContainerName(appId);
    const inspect = await this.#docker.inspectContainer(containerName);
    if (inspect === undefined) return undefined;
    const logs = await this.#docker.logs(inspect.Id, DEFAULT_LOG_TAIL);
    return { appId, logs: logs.logs, truncated: logs.truncated };
  }

  async reconcile(appIds: unknown): Promise<ReconcileResponse> {
    if (!Array.isArray(appIds) || appIds.some((appId) => !isValidAppId(appId))) {
      throw new RunnerError(400, 'body must be {"appIds": [safe app ids]}');
    }
    if (appIds.length > MAX_RECONCILE_APPS) {
      throw new RunnerError(400, "too many app ids");
    }
    const desired = new Set(appIds);
    const containers = await this.#docker.listContainers("hanse.managed=true");
    const stopped: string[] = [];
    for (const container of containers) {
      const appId = appIdFromContainer(container);
      if (appId === undefined || desired.has(appId)) continue;
      await this.delete(appId);
      stopped.push(appId);
    }
    const apps: RuntimeAppStatus[] = [];
    for (const appId of appIds) {
      const status = await this.status(appId);
      if (status !== undefined) apps.push(status);
    }
    return { stopped, apps };
  }

  async stopAll(): Promise<ReconcileResponse> {
    return this.reconcile([]);
  }

  async git(raw: unknown): Promise<never> {
    validateGitRequest(raw);
    throw new RunnerError(501, "git execution is not enabled in B1.1");
  }

  createServer(): Server {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        const status = statusFor(error);
        if (status >= 500 && !(error instanceof DockerError)) {
          process.stderr.write(
            `hanse runner: ${request.method ?? "?"} ${request.url ?? "?"} failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
        if (!response.headersSent) {
          writeJson(response, status, errorBody(error));
        } else {
          response.destroy();
        }
      });
    });
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.#handleUpgrade(request, socket, head).catch((error: unknown) => {
        writeSocketResponse(socket, statusFor(error), errorBody(error));
      });
    });
    return server;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (url.pathname === "/healthz") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      try {
        writeJson(response, 200, await this.health());
      } catch (error) {
        writeJson(response, 503, {
          error: `docker unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    const provided = bearerToken(request);
    if (provided === undefined || !tokenMatches(provided, this.#config.token)) {
      writeJson(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }

    if (url.pathname === "/v1/reconcile" || url.pathname === "/v1/stop-all") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      if (url.pathname === "/v1/stop-all") {
        writeJson(response, 200, await this.stopAll());
        return;
      }
      const body = await readJson(request);
      if (
        typeof body !== "object" ||
        body === null ||
        !Array.isArray((body as { appIds?: unknown }).appIds)
      ) {
        throw new RunnerError(400, 'body must be {"appIds": [...]}');
      }
      writeJson(response, 200, await this.reconcile((body as { appIds: unknown[] }).appIds));
      return;
    }

    const match = /^\/v1\/apps\/([^/]+)(?:\/(ensure|logs|git|exec))?$/.exec(url.pathname);
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
      throw new RunnerError(400, "invalid app id");
    }
    if (!isValidAppId(appId)) {
      throw new RunnerError(400, "invalid app id");
    }
    const action = match[2];

    if (action === "ensure") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      writeJson(response, 200, await this.ensure(await readJson(request), appId));
      return;
    }
    if (action === "logs") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      const logs = await this.logs(appId);
      if (logs === undefined) {
        writeJson(response, 404, { error: "unknown app" });
        return;
      }
      writeJson(response, 200, logs);
      return;
    }
    if (action === "git") {
      if (method !== "POST") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "POST" });
        return;
      }
      await this.git(await readJson(request));
      return;
    }
    if (action === "exec") {
      if (method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" }, { Allow: "GET" });
        return;
      }
      throw new RunnerError(426, "websocket upgrade required");
    }
    if (method === "GET") {
      const status = await this.status(appId);
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
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/v1\/apps\/([^/]+)\/exec$/.exec(url.pathname);
    if (match === null) {
      writeSocketResponse(socket, 404, { error: "not found" });
      return;
    }
    if ((request.method ?? "GET") !== "GET") {
      writeSocketResponse(socket, 405, { error: "method not allowed" });
      return;
    }
    const provided = bearerToken(request);
    if (provided === undefined || !tokenMatches(provided, this.#config.token)) {
      writeSocketResponse(socket, 401, { error: "unauthorized" });
      return;
    }

    let appId: string;
    try {
      appId = decodeURIComponent(match[1] ?? "");
    } catch {
      writeSocketResponse(socket, 400, { error: "invalid app id" });
      return;
    }
    if (!isValidAppId(appId)) {
      writeSocketResponse(socket, 400, { error: "invalid app id" });
      return;
    }

    const inspect = await this.#docker.inspectContainer(appContainerName(appId));
    const labels = inspect?.Config?.Labels;
    if (
      inspect === undefined ||
      labels?.["hanse.managed"] !== "true" ||
      labels?.["hanse.app.id"] !== appId
    ) {
      writeSocketResponse(socket, 404, { error: "unknown app" });
      return;
    }
    if (inspect.State?.Running !== true) {
      writeSocketResponse(socket, 409, { error: "app is not running" });
      return;
    }

    const handshakeError = websocketHandshakeError(request);
    if (handshakeError !== undefined) {
      writeSocketResponse(socket, 400, { error: handshakeError });
      return;
    }
    if (this.#exec === undefined) {
      writeSocketResponse(socket, 501, { error: "exec is not enabled" });
      return;
    }

    const execId = await this.#exec.createExec(inspect.Id, {
      cmd: ["/bin/sh", "-lc", EXEC_SHELL],
    });
    const stream = await this.#exec.startExec(execId);
    if (!socket.writable) {
      stream.close();
      return;
    }
    const peer = acceptWebSocket(request, socket, head);
    this.#bridgeExec(this.#exec, execId, stream, peer);
  }

  #bridgeExec(
    exec: DockerExecRuntime,
    execId: string,
    stream: DockerExecStream,
    peer: ReturnType<typeof acceptWebSocket>,
  ): void {
    stream.onData((chunk) => {
      if (!peer.send(chunk)) {
        stream.pause();
        peer.onDrain(() => stream.resume());
      }
    });
    peer.onMessage((data, type) => {
      const resize = parseResizeControl(data, type);
      if (resize !== undefined) {
        void exec.resizeExec(execId, resize).catch(() => undefined);
        return;
      }
      stream.write(data);
    });
    stream.onEnd(() => peer.close(1000, "exec ended"));
    stream.onError(() => peer.close(1011, "exec failed"));
    peer.onClose(() => stream.close());
  }

  async #connectCoordinator(network: string): Promise<void> {
    await this.#docker.connectNetwork(network, this.#config.coordinatorContainer, ["hanse"]);
  }

  async #findContainer(appId: string) {
    const containers = await this.#docker.listContainers("hanse.managed=true");
    return containers.find((container) => appIdFromContainer(container) === appId);
  }
}

export interface RunRunnerOptions {
  config: RunnerConfig;
  docker: DockerRuntime;
  exec?: DockerExecRuntime;
  hostname: string;
  port: number;
  onListening?: (address: string) => void;
}

/** Start the runner HTTP server and close it on SIGTERM/SIGINT. */
export async function runRunner(options: RunRunnerOptions): Promise<number> {
  const service = new RunnerService({
    config: options.config,
    docker: options.docker,
    ...(options.exec === undefined ? {} : { exec: options.exec }),
  });
  const server = service.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      options.onListening?.(
        typeof address === "string"
          ? address
          : `${address?.address ?? options.hostname}:${address?.port ?? options.port}`,
      );
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.hostname);
  });

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      server.closeAllConnections();
      server.close(() => resolve(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}
