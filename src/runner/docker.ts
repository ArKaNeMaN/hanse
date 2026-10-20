import { Buffer } from "node:buffer";
import http from "node:http";
import type { Duplex } from "node:stream";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BUILD_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;

export interface DockerResponse {
  status: number;
  body: Buffer;
}

export interface DockerUpgradedConnection {
  socket: Duplex;
  head: Buffer;
}

export interface DockerRequestOptions {
  timeoutMs?: number;
}

export interface DockerBuildOptions {
  tag: string;
  dockerfile: string;
  tar: Buffer;
  baseImage: string;
  buildArgs: Record<string, string>;
  labels: Record<string, string>;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  buildkit?: boolean;
  timeoutMs?: number;
}

export interface DockerBuildResult {
  imageId: string | null;
  logs: string;
  error: string | null;
}

export interface DockerBuildRuntime {
  buildImage(options: DockerBuildOptions): Promise<DockerBuildResult>;
}

export interface DockerTransport {
  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    options?: DockerRequestOptions,
  ): Promise<DockerResponse>;
  build?(path: string, body: Buffer, options?: DockerRequestOptions): Promise<DockerResponse>;
  upgrade?(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<DockerUpgradedConnection>;
}

export class DockerError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "DockerError";
    this.status = status;
    this.body = body;
  }
}

export interface UnixDockerTransportOptions {
  socketPath: string;
  apiVersion?: string;
  timeoutMs?: number;
}

/** Minimal Docker Engine client over a unix socket, using only node:http. */
export class UnixDockerTransport implements DockerTransport {
  readonly #socketPath: string;
  readonly #apiVersion: string;
  readonly #timeoutMs: number;

  constructor(options: UnixDockerTransportOptions) {
    this.#socketPath = options.socketPath;
    this.#apiVersion = options.apiVersion ?? "v1.41";
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  request(
    method: "GET" | "POST" | "DELETE",
    requestPath: string,
    body?: unknown,
    options?: DockerRequestOptions,
  ): Promise<DockerResponse> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return this.#send(
      method,
      requestPath,
      payload,
      payload === undefined ? undefined : "application/json",
      options,
      MAX_RESPONSE_BYTES,
    );
  }

  build(
    requestPath: string,
    body: Buffer,
    options?: DockerRequestOptions,
  ): Promise<DockerResponse> {
    return this.#send(
      "POST",
      requestPath,
      body,
      "application/x-tar",
      { timeoutMs: options?.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS },
      MAX_BUILD_RESPONSE_BYTES,
    );
  }

  #send(
    method: "GET" | "POST" | "DELETE",
    requestPath: string,
    payload: Buffer | undefined,
    contentType: string | undefined,
    options: DockerRequestOptions | undefined,
    maxResponseBytes: number,
  ): Promise<DockerResponse> {
    const path = requestPath.startsWith("/v") ? requestPath : `/${this.#apiVersion}${requestPath}`;

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.#socketPath,
          path,
          method,
          headers: {
            accept: "application/json",
            ...(payload === undefined || contentType === undefined
              ? {}
              : {
                  "content-type": contentType,
                  "content-length": String(payload.length),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              request.destroy(new DockerError(413, "docker response too large"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks),
            });
          });
          response.on("error", reject);
        },
      );
      request.setTimeout(options?.timeoutMs ?? this.#timeoutMs, () => {
        request.destroy(new DockerError(0, "docker request timed out"));
      });
      request.on("error", (error) => {
        reject(
          error instanceof DockerError
            ? error
            : new DockerError(0, `docker request failed: ${error.message}`),
        );
      });
      if (payload !== undefined) {
        request.write(payload);
      }
      request.end();
    });
  }

  upgrade(
    method: "GET" | "POST" | "DELETE",
    requestPath: string,
    body?: unknown,
  ): Promise<DockerUpgradedConnection> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const path = requestPath.startsWith("/v") ? requestPath : `/${this.#apiVersion}${requestPath}`;

    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.#socketPath,
        path,
        method,
        headers: {
          accept: "*/*",
          connection: "Upgrade",
          upgrade: "tcp",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }),
        },
      });
      request.on("upgrade", (_response, socket, head) => {
        resolve({ socket, head });
      });
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const detail = Buffer.concat(chunks).toString("utf8").trim().slice(0, 500);
          reject(
            new DockerError(
              response.statusCode ?? 0,
              `docker exec upgrade failed with HTTP ${response.statusCode ?? 0}${
                detail.length > 0 ? `: ${detail}` : ""
              }`,
              detail,
            ),
          );
        });
        response.on("error", reject);
      });
      request.on("error", (error) => {
        reject(
          error instanceof DockerError
            ? error
            : new DockerError(0, `docker exec upgrade failed: ${error.message}`),
        );
      });
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }
}

export interface DockerNetworkSpec {
  name: string;
  labels: Record<string, string>;
}

export interface DockerContainerCreateOptions {
  name: string;
  image: string;
  hostname: string;
  user: string;
  entrypoint: string[];
  cmd: string[];
  workingDir: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  binds: string[];
  tmpfs: Record<string, string>;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  networkName: string;
  networkAliases: string[];
  restartPolicy?: "no" | "unless-stopped";
  networkMode?: string;
}

export interface DockerContainerWait {
  StatusCode?: number;
  Error?: { Message?: string };
}

export interface DockerContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID?: string;
  State: string;
  Status: string;
  Labels?: Record<string, string>;
}

export interface DockerContainerInspect {
  Id: string;
  Name: string;
  Config?: {
    Image?: string;
    Labels?: Record<string, string>;
    Env?: string[];
    Entrypoint?: string[];
    Cmd?: string[];
    User?: string;
  };
  State?: {
    Status?: string;
    Running?: boolean;
    ExitCode?: number;
    Error?: string;
    StartedAt?: string;
    FinishedAt?: string;
  };
  HostConfig?: {
    Binds?: string[];
    NetworkMode?: string;
    ReadonlyRootfs?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    Privileged?: boolean;
    Memory?: number;
    NanoCpus?: number;
    PidsLimit?: number | null;
  };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
  };
}

/**
 * The image fields the runner inspects before deploying it. Docker returns more; only the fields
 * that affect the fixed app envelope or validation are typed here.
 */
export interface DockerImageInspect {
  Id?: string;
  RepoTags?: string[];
  Config?: {
    User?: string;
    Env?: string[];
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    Volumes?: Record<string, unknown> | null;
    WorkingDir?: string;
    Labels?: Record<string, string>;
  };
}

/** One image entry from `GET /system/df` (the fields GC needs; Docker returns more). */
export interface DockerImageUsage {
  Id: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Created?: number;
  Size?: number;
  SharedSize?: number;
  Containers?: number;
  Labels?: Record<string, string> | null;
}

/** One build-cache entry from `GET /system/df`. */
export interface DockerBuildCacheUsage {
  ID?: string;
  Type?: string;
  Size?: number;
  InUse?: boolean;
  Shared?: boolean;
  CreatedAt?: string;
  LastUsedAt?: string | null;
  UsageCount?: number;
}

export interface DockerSystemDf {
  LayersSize?: number;
  Images?: DockerImageUsage[] | null;
  Containers?: unknown[] | null;
  Volumes?: unknown[] | null;
  BuildCache?: DockerBuildCacheUsage[] | null;
}

export interface DockerImagePruneResult {
  ImagesDeleted?: Array<{ Untagged?: string; Deleted?: string }> | null;
  SpaceReclaimed?: number;
}

export interface DockerBuildPruneOptions {
  all?: boolean;
  keepStorageBytes?: number;
  filters?: Record<string, string[]>;
}

export interface DockerBuildPruneResult {
  CachesDeleted?: string[] | null;
  SpaceReclaimed?: number;
}

export interface DockerLogs {
  logs: string;
  truncated: boolean;
}

export interface DockerExecCreateOptions {
  cmd: string[];
  workingDir?: string;
  env?: Record<string, string>;
}

export interface DockerExecSize {
  rows: number;
  cols: number;
}

export interface DockerExecStream {
  write(chunk: Buffer): boolean;
  close(): void;
  pause(): void;
  resume(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onEnd(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface DockerExecRuntime {
  createExec(containerId: string, options: DockerExecCreateOptions): Promise<string>;
  startExec(execId: string): Promise<DockerExecStream>;
  resizeExec(execId: string, size: DockerExecSize): Promise<void>;
}

const MAX_PENDING_EXEC_BYTES = 1024 * 1024;

class DockerSocketExecStream implements DockerExecStream {
  readonly #socket: Duplex;
  #head: Buffer;
  readonly #dataListeners: Array<(chunk: Buffer) => void> = [];
  readonly #endListeners: Array<() => void> = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];
  readonly #pending: Buffer[] = [];
  #pendingBytes = 0;
  #ended = false;
  #closed = false;

  constructor(socket: Duplex, head: Buffer) {
    this.#socket = socket;
    this.#head = head;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("end", () => this.#onEnd());
    socket.on("close", () => this.#onEnd());
    socket.on("error", (error: Error) => {
      if (this.#closed) return;
      for (const listener of this.#errorListeners) listener(error);
      this.#onEnd();
    });
  }

  write(chunk: Buffer): boolean {
    if (this.#closed || !this.#socket.writable) return false;
    return this.#socket.write(chunk);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
  }

  pause(): void {
    this.#socket.pause();
  }

  resume(): void {
    this.#socket.resume();
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.#dataListeners.push(listener);
    if (this.#head.length > 0) {
      const head = this.#head;
      this.#head = Buffer.alloc(0);
      listener(head);
    }
    for (const chunk of this.#pending.splice(0)) {
      listener(chunk);
    }
    this.#pendingBytes = 0;
  }

  onEnd(listener: () => void): void {
    if (this.#ended) {
      listener();
      return;
    }
    this.#endListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.push(listener);
  }

  #onData(chunk: Buffer): void {
    if (this.#dataListeners.length === 0) {
      if (this.#pendingBytes + chunk.length > MAX_PENDING_EXEC_BYTES) return;
      this.#pending.push(chunk);
      this.#pendingBytes += chunk.length;
      return;
    }
    for (const listener of this.#dataListeners) listener(chunk);
  }

  #onEnd(): void {
    if (this.#ended || this.#closed) return;
    this.#ended = true;
    for (const listener of this.#endListeners) listener();
  }
}

function decodeJson<T>(response: DockerResponse, operation: string): T {
  if (response.body.length === 0) {
    throw new DockerError(response.status, `${operation} returned an empty response`);
  }
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw new DockerError(response.status, `${operation} returned invalid JSON`);
  }
}

function responseText(response: DockerResponse): string {
  return response.body.toString("utf8").trim().slice(0, 500);
}

/** Demultiplex Docker's 8-byte-framed stdout/stderr stream. */
export function demuxDockerStream(buffer: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  let framed = false;
  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    if (stream !== 0 && stream !== 1 && stream !== 2) {
      return buffer.toString("utf8");
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (size < 0 || offset + 8 + size > buffer.length) {
      return buffer.toString("utf8");
    }
    chunks.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
    framed = true;
  }
  return framed && offset === buffer.length
    ? Buffer.concat(chunks).toString("utf8")
    : buffer.toString("utf8");
}

interface ParsedBuildOutput {
  logs: string;
  imageId: string | null;
  error: string | null;
}

function parseBuildOutput(body: Buffer): ParsedBuildOutput {
  const text = body.toString("utf8");
  const logs: string[] = [];
  let imageId: string | null = null;
  let error: string | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      logs.push(rawLine);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logs.push(rawLine);
      continue;
    }
    const event = parsed as {
      stream?: unknown;
      status?: unknown;
      error?: unknown;
      errorDetail?: unknown;
      aux?: unknown;
    };
    if (typeof event.errorDetail === "object" && event.errorDetail !== null) {
      const detail = event.errorDetail as { message?: unknown };
      if (typeof detail.message === "string" && detail.message.length > 0) {
        error = detail.message;
      }
    }
    if (typeof event.error === "string" && event.error.length > 0) {
      error = event.error;
    }
    if (typeof event.stream === "string") {
      logs.push(event.stream);
    } else if (typeof event.status === "string") {
      logs.push(`${event.status}\n`);
    }
    if (typeof event.aux === "object" && event.aux !== null) {
      const aux = event.aux as { ID?: unknown };
      if (typeof aux.ID === "string" && aux.ID.length > 0) {
        imageId = aux.ID;
      }
    }
  }

  return { logs: logs.join(""), imageId, error };
}

function apiVersionAtLeast(version: string, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const actualMajor = Number.parseInt(match[1] ?? "", 10);
  const actualMinor = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(actualMajor) || !Number.isFinite(actualMinor)) return false;
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

/** Typed Docker Engine API facade used by the runner. */
export class DockerClient {
  readonly #transport: DockerTransport;

  constructor(transport: DockerTransport) {
    this.#transport = transport;
  }

  static unixSocket(socketPath: string, apiVersion = "v1.41"): DockerClient {
    return new DockerClient(new UnixDockerTransport({ socketPath, apiVersion }));
  }

  async version(): Promise<string> {
    const response = await this.#transport.request("GET", "/version");
    this.#check(response, "docker version");
    const body = decodeJson<{ ApiVersion?: string; Version?: string }>(response, "docker version");
    return body.ApiVersion ?? body.Version ?? "unknown";
  }

  async inspectImage(reference: string): Promise<DockerImageInspect | undefined> {
    const response = await this.#transport.request(
      "GET",
      `/images/${encodeURIComponent(reference)}/json`,
    );
    if (response.status === 404) return undefined;
    this.#check(response, `inspect image ${reference}`);
    return decodeJson<DockerImageInspect>(response, `inspect image ${reference}`);
  }

  async systemDf(): Promise<DockerSystemDf> {
    const response = await this.#transport.request("GET", "/system/df");
    this.#check(response, "docker system df");
    return decodeJson<DockerSystemDf>(response, "docker system df");
  }

  async removeImage(referenceOrId: string, force = false): Promise<void> {
    const response = await this.#transport.request(
      "DELETE",
      `/images/${encodeURIComponent(referenceOrId)}?force=${force ? "1" : "0"}&noprune=1`,
    );
    if (response.status === 404) return;
    this.#check(response, `remove image ${referenceOrId}`);
  }

  async pruneImages(filters: Record<string, string[]> = {}): Promise<DockerImagePruneResult> {
    const query =
      Object.keys(filters).length === 0
        ? ""
        : `?filters=${encodeURIComponent(JSON.stringify(filters))}`;
    const response = await this.#transport.request("POST", `/images/prune${query}`);
    this.#check(response, "prune images");
    return decodeJson<DockerImagePruneResult>(response, "prune images");
  }

  async pruneBuildCache(options: DockerBuildPruneOptions = {}): Promise<DockerBuildPruneResult> {
    const query = new URLSearchParams();
    if (options.all !== undefined) {
      query.set("all", options.all ? "1" : "0");
    }
    if (options.keepStorageBytes !== undefined) {
      query.set("keep-storage", String(options.keepStorageBytes));
    }
    if (options.filters !== undefined) {
      query.set("filters", JSON.stringify(options.filters));
    }
    const response = await this.#transport.request(
      "POST",
      `/build/prune${query.size === 0 ? "" : `?${query.toString()}`}`,
      undefined,
      { timeoutMs: 120_000 },
    );
    this.#check(response, "prune build cache");
    return decodeJson<DockerBuildPruneResult>(response, "prune build cache");
  }

  async buildImage(options: DockerBuildOptions): Promise<DockerBuildResult> {
    if (this.#transport.build === undefined) {
      throw new DockerError(0, "docker transport does not support image builds");
    }
    const buildkit = options.buildkit ?? (await this.#supportsBuildKit());
    const buildArgs = { ...options.buildArgs, HANSE_BASE: options.baseImage };
    const cpuPeriod = 100_000;
    const cpuQuota = Math.max(1, Math.round((options.nanoCpus / 1_000_000_000) * cpuPeriod));
    const query = new URLSearchParams({
      t: options.tag,
      dockerfile: options.dockerfile,
      buildargs: JSON.stringify(buildArgs),
      labels: JSON.stringify(options.labels),
      memory: String(options.memoryBytes),
      memswap: String(options.memoryBytes),
      cpuperiod: String(cpuPeriod),
      cpuquota: String(cpuQuota),
      pidslimit: String(options.pidsLimit),
    });
    if (buildkit) {
      query.set("version", "2");
    }

    const response = await this.#transport.build(
      `/build?${query.toString()}`,
      options.tar,
      options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs },
    );
    const parsed = parseBuildOutput(response.body);
    const logs = parsed.logs;

    if (response.status < 200 || response.status >= 300) {
      const detail = logs.trim() || responseText(response);
      return {
        imageId: null,
        logs,
        error:
          detail.length > 0
            ? detail.slice(0, 1000)
            : `docker build failed with HTTP ${response.status}`,
      };
    }
    if (parsed.error !== null) {
      return { imageId: null, logs, error: parsed.error };
    }

    let imageId = parsed.imageId;
    if (imageId === null) {
      const inspected = await this.inspectImage(options.tag).catch(() => undefined);
      imageId = inspected?.Id ?? null;
    }
    if (imageId === null) {
      return { imageId: null, logs, error: "docker build completed without an image id" };
    }
    return { imageId, logs, error: null };
  }

  async #supportsBuildKit(): Promise<boolean> {
    const version = await this.version().catch(() => "unknown");
    return apiVersionAtLeast(version, 1, 39);
  }

  async ensureNetwork(spec: DockerNetworkSpec): Promise<void> {
    const response = await this.#transport.request("POST", "/networks/create", {
      Name: spec.name,
      Driver: "bridge",
      CheckDuplicate: true,
      Labels: spec.labels,
    });
    if (response.status === 409) return;
    this.#check(response, `create network ${spec.name}`);
  }

  async removeNetwork(name: string): Promise<void> {
    const response = await this.#transport.request(
      "DELETE",
      `/networks/${encodeURIComponent(name)}`,
    );
    if (response.status === 404) return;
    this.#check(response, `remove network ${name}`);
  }

  async connectNetwork(network: string, container: string, aliases: string[]): Promise<void> {
    const response = await this.#transport.request(
      "POST",
      `/networks/${encodeURIComponent(network)}/connect`,
      { Container: container, EndpointConfig: { Aliases: aliases } },
    );
    if (
      response.status === 403 &&
      /already exists|already connected/i.test(responseText(response))
    ) {
      return;
    }
    this.#check(response, `connect ${container} to ${network}`);
  }

  async disconnectNetwork(network: string, container: string): Promise<void> {
    const response = await this.#transport.request(
      "POST",
      `/networks/${encodeURIComponent(network)}/disconnect`,
      { Container: container, Force: true },
    );
    if (response.status === 404) return;
    if (response.status === 403 && /not connected|is not connected/i.test(responseText(response))) {
      return;
    }
    this.#check(response, `disconnect ${container} from ${network}`);
  }

  async createContainer(options: DockerContainerCreateOptions): Promise<string> {
    const networkMode = options.networkMode ?? options.networkName;
    const response = await this.#transport.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(options.name)}`,
      {
        Image: options.image,
        Hostname: options.hostname,
        User: options.user,
        Entrypoint: options.entrypoint,
        Cmd: options.cmd,
        WorkingDir: options.workingDir,
        Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
        Labels: options.labels,
        HostConfig: {
          Binds: options.binds,
          NetworkMode: networkMode,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Privileged: false,
          Tmpfs: options.tmpfs,
          Memory: options.memoryBytes,
          NanoCpus: options.nanoCpus,
          PidsLimit: options.pidsLimit,
          RestartPolicy: {
            Name: options.restartPolicy ?? "unless-stopped",
            MaximumRetryCount: 0,
          },
          LogConfig: {
            Type: "json-file",
            Config: { "max-size": "10m", "max-file": "3" },
          },
        },
        ...(networkMode === "none"
          ? {}
          : {
              NetworkingConfig: {
                EndpointsConfig: {
                  [networkMode]: { Aliases: options.networkAliases },
                },
              },
            }),
      },
    );
    this.#check(response, `create container ${options.name}`);
    const body = decodeJson<{ Id?: string }>(response, `create container ${options.name}`);
    if (body.Id === undefined || body.Id.length === 0) {
      throw new DockerError(0, `create container ${options.name} returned no id`);
    }
    return body.Id;
  }

  async startContainer(id: string): Promise<void> {
    const response = await this.#transport.request(
      "POST",
      `/containers/${encodeURIComponent(id)}/start`,
    );
    if (response.status === 304) return;
    this.#check(response, `start container ${id}`);
  }

  async stopContainer(id: string, timeoutSeconds = 10): Promise<void> {
    const response = await this.#transport.request(
      "POST",
      `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`,
      undefined,
      { timeoutMs: Math.max(30_000, (timeoutSeconds + 15) * 1000) },
    );
    if (response.status === 304 || response.status === 404) return;
    this.#check(response, `stop container ${id}`);
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const response = await this.#transport.request(
      "DELETE",
      `/containers/${encodeURIComponent(id)}?force=${force ? "1" : "0"}&v=0`,
      undefined,
      { timeoutMs: 30_000 },
    );
    if (response.status === 404) return;
    this.#check(response, `remove container ${id}`);
  }

  async inspectContainer(idOrName: string): Promise<DockerContainerInspect | undefined> {
    const response = await this.#transport.request(
      "GET",
      `/containers/${encodeURIComponent(idOrName)}/json`,
    );
    if (response.status === 404) return undefined;
    this.#check(response, `inspect container ${idOrName}`);
    return decodeJson<DockerContainerInspect>(response, `inspect container ${idOrName}`);
  }

  async listContainers(label?: string): Promise<DockerContainerSummary[]> {
    const filters = label === undefined ? undefined : { label: [label] };
    const query =
      filters === undefined
        ? "all=1"
        : `all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`;
    const response = await this.#transport.request("GET", `/containers/json?${query}`);
    this.#check(response, "list containers");
    const body = decodeJson<DockerContainerSummary[]>(response, "list containers");
    return Array.isArray(body) ? body : [];
  }

  async logs(id: string, tail = 500): Promise<DockerLogs> {
    const response = await this.#transport.request(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=0&tail=${tail}`,
    );
    this.#check(response, `logs for container ${id}`);
    return { logs: demuxDockerStream(response.body), truncated: false };
  }

  async waitContainer(id: string, timeoutMs = 180_000): Promise<DockerContainerWait> {
    const response = await this.#transport.request(
      "POST",
      `/containers/${encodeURIComponent(id)}/wait?condition=not-running`,
      undefined,
      { timeoutMs },
    );
    this.#check(response, `wait for container ${id}`);
    return decodeJson<DockerContainerWait>(response, `wait for container ${id}`);
  }

  async createExec(containerId: string, options: DockerExecCreateOptions): Promise<string> {
    const response = await this.#transport.request(
      "POST",
      `/containers/${encodeURIComponent(containerId)}/exec`,
      {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: options.cmd,
        ...(options.workingDir === undefined ? {} : { WorkingDir: options.workingDir }),
        ...(options.env === undefined
          ? {}
          : { Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`) }),
      },
    );
    this.#check(response, `create exec in container ${containerId}`);
    const body = decodeJson<{ Id?: string }>(response, `create exec in container ${containerId}`);
    if (body.Id === undefined || body.Id.length === 0) {
      throw new DockerError(0, `create exec in container ${containerId} returned no id`);
    }
    return body.Id;
  }

  async startExec(execId: string): Promise<DockerExecStream> {
    if (this.#transport.upgrade === undefined) {
      throw new DockerError(0, "docker transport does not support exec streams");
    }
    const connection = await this.#transport.upgrade(
      "POST",
      `/exec/${encodeURIComponent(execId)}/start`,
      { Detach: false, Tty: true },
    );
    return new DockerSocketExecStream(connection.socket, connection.head);
  }

  async resizeExec(execId: string, size: DockerExecSize): Promise<void> {
    const response = await this.#transport.request(
      "POST",
      `/exec/${encodeURIComponent(execId)}/resize?h=${size.rows}&w=${size.cols}`,
    );
    this.#check(response, `resize exec ${execId}`);
  }

  #check(response: DockerResponse, operation: string): void {
    if (response.status >= 200 && response.status < 300) return;
    const detail = responseText(response);
    throw new DockerError(
      response.status,
      `${operation} failed with HTTP ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
      detail,
    );
  }
}

/** Narrow runtime interface used by the runner server; tests inject a fake. */
export interface DockerRuntime {
  version(): Promise<string>;
  ensureNetwork(spec: DockerNetworkSpec): Promise<void>;
  removeNetwork(name: string): Promise<void>;
  connectNetwork(network: string, container: string, aliases: string[]): Promise<void>;
  disconnectNetwork(network: string, container: string): Promise<void>;
  createContainer(options: DockerContainerCreateOptions): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(id: string, force?: boolean): Promise<void>;
  inspectContainer(idOrName: string): Promise<DockerContainerInspect | undefined>;
  inspectImage?(reference: string): Promise<DockerImageInspect | undefined>;
  systemDf?(): Promise<DockerSystemDf>;
  removeImage?(referenceOrId: string, force?: boolean): Promise<void>;
  pruneImages?(filters?: Record<string, string[]>): Promise<DockerImagePruneResult>;
  pruneBuildCache?(options?: DockerBuildPruneOptions): Promise<DockerBuildPruneResult>;
  listContainers(label?: string): Promise<DockerContainerSummary[]>;
  logs(id: string, tail?: number): Promise<DockerLogs>;
  waitContainer(id: string, timeoutMs?: number): Promise<DockerContainerWait>;
}
