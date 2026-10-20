import { Buffer } from "node:buffer";
import http from "node:http";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface DockerResponse {
  status: number;
  body: Buffer;
}

export interface DockerTransport {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<DockerResponse>;
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
  ): Promise<DockerResponse> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const path = requestPath.startsWith("/v") ? requestPath : `/${this.#apiVersion}${requestPath}`;

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.#socketPath,
          path,
          method,
          headers: {
            accept: "application/json",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": String(payload.length),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
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
      request.setTimeout(this.#timeoutMs, () => {
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
}

export interface DockerContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
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

export interface DockerLogs {
  logs: string;
  truncated: boolean;
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
          NetworkMode: options.networkName,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Privileged: false,
          Tmpfs: options.tmpfs,
          Memory: options.memoryBytes,
          NanoCpus: options.nanoCpus,
          PidsLimit: options.pidsLimit,
          RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
          LogConfig: {
            Type: "json-file",
            Config: { "max-size": "10m", "max-file": "3" },
          },
        },
        NetworkingConfig: {
          EndpointsConfig: {
            [options.networkName]: { Aliases: options.networkAliases },
          },
        },
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
    );
    if (response.status === 304 || response.status === 404) return;
    this.#check(response, `stop container ${id}`);
  }

  async removeContainer(id: string, force = false): Promise<void> {
    const response = await this.#transport.request(
      "DELETE",
      `/containers/${encodeURIComponent(id)}?force=${force ? "1" : "0"}&v=0`,
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
  listContainers(label?: string): Promise<DockerContainerSummary[]>;
  logs(id: string, tail?: number): Promise<DockerLogs>;
}
