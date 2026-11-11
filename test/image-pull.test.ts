import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeploymentLock } from "../src/coordinator/deployment-lock.js";
import type {
  ImageBuildInput,
  RunnerImageInspect,
  RunnerImagePullResult,
  RunnerImageRecord,
} from "../src/images/client.js";
import { RunnerImageClient } from "../src/images/client.js";
import { type ImageRunnerClient, ImageService } from "../src/images/service.js";
import { discoverProject, registerProject } from "../src/registry/index.js";
import {
  type DockerBuildOptions,
  type DockerBuildResult,
  type DockerBuildRuntime,
  DockerClient,
  type DockerContainerCreateOptions,
  type DockerContainerInspect,
  type DockerContainerSummary,
  DockerError,
  type DockerImageInspect,
  type DockerLogs,
  type DockerNetworkSpec,
  type DockerPullOptions,
  type DockerPullResult,
  type DockerResponse,
  type DockerRuntime,
  type DockerSystemDf,
  type DockerTransport,
  UnixDockerTransport,
} from "../src/runner/docker.js";
import { ImageGcService } from "../src/runner/image-gc.js";
import { ImageMutationMutex } from "../src/runner/image-mutation.js";
import { ImagePullService, validatePullReference } from "../src/runner/image-pull.js";
import { RunnerService } from "../src/runner/server.js";
import type { RunnerConfig } from "../src/runner/validate.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const paths: string[] = [];
const servers: Server[] = [];
const databases: SqliteDatabase[] = [];
const previousImage = process.env.HANSE_AGENT_IMAGE;

beforeEach(() => {
  process.env.HANSE_AGENT_IMAGE = "agent-default:test";
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of paths.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (previousImage === undefined) delete process.env.HANSE_AGENT_IMAGE;
  else process.env.HANSE_AGENT_IMAGE = previousImage;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  paths.push(dir);
  return dir;
}

class FakePullDocker implements DockerRuntime {
  readonly inspected = new Map<string, DockerImageInspect>();
  readonly pulls: { reference: string; options?: DockerPullOptions }[] = [];
  pullImpl: (reference: string, options?: DockerPullOptions) => Promise<DockerPullResult> =
    async () => ({ imageId: "sha256:new", digest: null });
  systemDfResult: DockerSystemDf = { Images: [], BuildCache: [], LayersSize: 0 };

  async version(): Promise<string> {
    return "1.44";
  }

  async ensureNetwork(_spec: DockerNetworkSpec): Promise<void> {}

  async removeNetwork(_name: string): Promise<void> {}

  async connectNetwork(_network: string, _container: string, _aliases: string[]): Promise<void> {}

  async disconnectNetwork(_network: string, _container: string): Promise<void> {}

  async systemDf(): Promise<DockerSystemDf> {
    return this.systemDfResult;
  }

  async inspectImage(reference: string): Promise<DockerImageInspect | undefined> {
    return this.inspected.get(reference);
  }

  async pullImage(reference: string, options?: DockerPullOptions): Promise<DockerPullResult> {
    this.pulls.push({ reference, options });
    return this.pullImpl(reference, options);
  }

  async createContainer(_options: DockerContainerCreateOptions): Promise<string> {
    return "container-id";
  }

  async startContainer(_id: string): Promise<void> {}

  async stopContainer(_id: string, _timeoutSeconds?: number): Promise<void> {}

  async removeContainer(_id: string, _force?: boolean): Promise<void> {}

  async inspectContainer(_idOrName: string): Promise<DockerContainerInspect | undefined> {
    return undefined;
  }

  async listContainers(_label?: string): Promise<DockerContainerSummary[]> {
    return [];
  }

  async logs(_id: string, _tail?: number): Promise<DockerLogs> {
    return { logs: "", truncated: false };
  }

  async waitContainer(_id: string, _timeoutMs?: number): Promise<{ StatusCode?: number }> {
    return { StatusCode: 0 };
  }
}

interface PendingBuild {
  options: DockerBuildOptions;
  resolve: (result: DockerBuildResult) => void;
}

class FakeBuildRuntime implements DockerBuildRuntime {
  readonly calls: DockerBuildOptions[] = [];
  readonly pending: PendingBuild[] = [];

  buildImage(options: DockerBuildOptions): Promise<DockerBuildResult> {
    this.calls.push(options);
    return new Promise<DockerBuildResult>((resolve) => {
      this.pending.push({ options, resolve });
    });
  }

  succeed(imageId = "sha256:built"): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("no pending build");
    next.resolve({ imageId, logs: "", error: null });
  }
}

interface RunnerFixture {
  workspace: string;
  agents: string;
  appDir: string;
  docker: FakePullDocker;
  build: FakeBuildRuntime;
  service: RunnerService;
  base: string;
}

function makeApp(workspace: string): string {
  const appDir = path.join(workspace, "project", "app");
  mkdirSync(path.join(appDir, ".hanse"), { recursive: true });
  writeFileSync(
    path.join(appDir, ".hanse", "Dockerfile"),
    ["ARG HANSE_BASE", `FROM ${"$"}{HANSE_BASE}`, "RUN echo app", ""].join("\n"),
  );
  return appDir;
}

function runnerConfig(workspace: string, agents: string): RunnerConfig {
  return {
    token: "runtime-token",
    hostWorkspace: workspace,
    hostAgents: agents,
    allowedImages: new Set(["agent-default:test", "agent-base:test"]),
    defaultImage: "agent-default:test",
    baseImage: "agent-base:test",
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
  };
}

async function runnerFixture(
  options: { imageGc?: ImageGcService; config?: Partial<RunnerConfig> } = {},
): Promise<RunnerFixture> {
  const dir = tempDir("hanse-image-pull-");
  const workspace = path.join(dir, "workspace");
  const agents = path.join(dir, "agents");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agents, { recursive: true });
  const appDir = makeApp(workspace);
  const docker = new FakePullDocker();
  const build = new FakeBuildRuntime();
  const mutex = new ImageMutationMutex();
  const imageGc =
    options.imageGc ??
    new ImageGcService({
      docker,
      diskPath: workspace,
      mutex,
      statfs: async () => diskStats(10),
    });
  const service = new RunnerService({
    config: { ...runnerConfig(workspace, agents), ...options.config },
    docker,
    build,
    imageGc,
    mutex,
  });
  const server = service.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    workspace,
    agents,
    appDir,
    docker,
    build,
    service,
    base: `http://127.0.0.1:${address.port}`,
  };
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer runtime-token", "content-type": "application/json" };
}

async function postPull(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/v1/images/pull`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

async function postPullEventually(base: string, body: unknown): Promise<Response> {
  const deadline = Date.now() + 3000;
  let response = await postPull(base, body);
  while (response.status === 409 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    response = await postPull(base, body);
  }
  return response;
}

function diskStats(usedPercent: number) {
  const total = 100;
  const free = Math.max(0, Math.round(total - (total * usedPercent) / 100));
  return { blocks: total, bfree: free, bavail: free, bsize: 100 };
}

function diskUsage(usedPercent: 80 | 90) {
  return {
    totalBytes: 100,
    usedBytes: usedPercent,
    freeBytes: 100 - usedPercent,
    usedPercent,
    level: usedPercent >= 85 ? ("critical" as const) : ("warning" as const),
  };
}

function usageReport(level: "ok" | "warning" | "critical") {
  return {
    level,
    disk: level === "ok" ? null : diskUsage(level === "warning" ? 80 : 90),
    docker: null,
    errors: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
  } as const;
}

function buildBody(f: RunnerFixture): Record<string, unknown> {
  return {
    appId: "project:app",
    appDir: f.appDir,
    baseImage: "agent-default:test",
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("runner image pull reference validation", () => {
  const malformed = [
    {},
    { reference: 1 },
    { reference: "agent-default:test@sha256:abc" },
    { reference: "a@b@c" },
    { reference: "agent-default:" },
    { reference: "agent-default@sha256:nothex" },
    { reference: "agent-default:te\u0000st" },
    { reference: "Agent-Default:test/test" },
    { reference: "bad..registry/repo:test" },
    { reference: "registry:port/repo:test" },
    { reference: "/repo:test" },
    { reference: "repo//x:test" },
  ];

  it("rejects malformed bodies with 400 before touching Docker", async () => {
    const f = await runnerFixture();
    for (const body of malformed) {
      const response = await postPull(f.base, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(f.docker.pulls).toHaveLength(0);
  });

  it("rejects disallowed and app-built references with 403", async () => {
    const f = await runnerFixture();
    const disallowed = await postPull(f.base, { reference: "evil:latest" });
    expect(disallowed.status).toBe(403);
    expect(await disallowed.json()).toMatchObject({ code: "image_disallowed" });

    const managed = await postPull(f.base, {
      reference: "hanse-app-project-app:build-1",
    });
    expect(managed.status).toBe(403);
    expect(await managed.json()).toMatchObject({ code: "image_disallowed" });
    expect(f.docker.pulls).toHaveLength(0);
  });

  it("allows exact allowlist/default/base equality and a digest-pinned reference", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const pinned = `agent-default@${digest}`;
    const f = await runnerFixture();
    const config = runnerConfig(f.workspace, f.agents);
    const withPinned: RunnerConfig = {
      ...config,
      allowedImages: new Set([...config.allowedImages, pinned]),
    };

    expect(validatePullReference({ reference: "agent-default:test" }, config)).toBe(
      "agent-default:test",
    );
    expect(validatePullReference({ reference: "agent-base:test" }, config)).toBe("agent-base:test");
    expect(validatePullReference({ reference: pinned }, withPinned)).toBe(pinned);

    const pinnedService = await runnerFixture({ config: { allowedImages: new Set([pinned]) } });
    const pinnedHttp = await postPull(pinnedService.base, { reference: pinned });
    expect(pinnedHttp.status).toBe(200);
    expect(pinnedService.docker.pulls).toEqual([expect.objectContaining({ reference: pinned })]);
  });
});

describe("runner image pull endpoint", () => {
  it("returns previousImageId, imageId, changed, and the resolved digest", async () => {
    const f = await runnerFixture();
    const digest = `sha256:${"b".repeat(64)}`;
    f.docker.inspected.set("agent-default:test", { Id: "sha256:old" });
    f.docker.pullImpl = async () => ({ imageId: "sha256:new", digest });

    const response = await postPull(f.base, { reference: "agent-default:test" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reference: "agent-default:test",
      previousImageId: "sha256:old",
      imageId: "sha256:new",
      changed: true,
      digest,
    });

    f.docker.inspected.set("agent-default:test", { Id: "sha256:new" });
    f.docker.pullImpl = async () => ({ imageId: "sha256:new", digest });
    const unchanged = await postPull(f.base, { reference: "agent-default:test" });
    expect(await unchanged.json()).toMatchObject({
      previousImageId: "sha256:new",
      imageId: "sha256:new",
      changed: false,
    });
  });

  it("reads and validates the body before acquiring the mutation mutex", async () => {
    const f = await runnerFixture();
    const started = await fetch(`${f.base}/v1/images/build`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(buildBody(f)),
    });
    expect(started.status).toBe(202);
    await waitFor(() => f.build.calls.length === 1, "build start");

    const invalid = await postPull(f.base, { reference: 1 });
    expect(invalid.status).toBe(400);

    const conflict = await postPull(f.base, { reference: "agent-default:test" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "image_mutation_in_progress" });

    f.build.succeed();
    const after = await postPullEventually(f.base, { reference: "agent-default:test" });
    expect(after.status).toBe(200);
  });

  it("releases the mutex when the coordinator disconnects", async () => {
    const f = await runnerFixture();
    let first = true;
    f.docker.pullImpl = (_reference, options) => {
      if (!first) return Promise.resolve({ imageId: "sha256:new", digest: null });
      first = false;
      return new Promise<DockerPullResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DockerError(0, "aborted")), {
          once: true,
        });
      });
    };

    const controller = new AbortController();
    const pending = fetch(`${f.base}/v1/images/pull`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reference: "agent-default:test" }),
      signal: controller.signal,
    });
    await waitFor(() => f.docker.pulls.length === 1, "pull start");
    controller.abort();
    await expect(pending).rejects.toThrow();

    const retry = await postPull(f.base, { reference: "agent-default:test" });
    expect(retry.status).toBe(200);
  });

  it("sanitizes Docker pull failures and never echoes the raw stream", async () => {
    const f = await runnerFixture();
    f.docker.pullImpl = async () => {
      throw new DockerError(0, `registry exploded\u0000\u0007 ${"x".repeat(500)}`);
    };

    const response = await postPull(f.base, { reference: "agent-default:test" });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("pull_failed");
    const hasControl = [...body.error].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
    expect(hasControl).toBe(false);
    expect(body.error.length).toBeLessThanOrEqual(310);
  });
});

describe("runner image pull disk guard", () => {
  async function fixtureWithStats(statfs: () => Promise<ReturnType<typeof diskStats>>) {
    const dir = tempDir("hanse-image-pull-disk-");
    const workspace = path.join(dir, "workspace");
    const agents = path.join(dir, "agents");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(agents, { recursive: true });
    const appDir = makeApp(workspace);
    const docker = new FakePullDocker();
    const mutex = new ImageMutationMutex();
    const imageGc = new ImageGcService({ docker, diskPath: workspace, mutex, statfs });
    const service = new RunnerService({
      config: runnerConfig(workspace, agents),
      docker,
      imageGc,
      mutex,
    });
    const server = service.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    return { base: `http://127.0.0.1:${address.port}`, docker, appDir, workspace, agents };
  }

  it("rejects at warning and critical before the pull", async () => {
    for (const percent of [80, 90]) {
      const f = await fixtureWithStats(async () => diskStats(percent));
      const response = await postPull(f.base, { reference: "agent-default:test" });
      expect(response.status, String(percent)).toBe(507);
      expect(await response.json()).toMatchObject({ code: "disk_critical" });
      expect(f.docker.pulls).toHaveLength(0);
    }
  });

  it("fails closed when statfs is unavailable", async () => {
    const f = await fixtureWithStats(async () => {
      throw new Error("statfs unavailable");
    });
    const response = await postPull(f.base, { reference: "agent-default:test" });
    expect(response.status).toBe(507);
    expect(await response.json()).toMatchObject({ code: "disk_guard_unavailable" });
    expect(f.docker.pulls).toHaveLength(0);
  });

  it("aborts a running pull when the disk becomes critical", async () => {
    let calls = 0;
    const imageGc = {
      async usage() {
        calls += 1;
        if (calls === 1) {
          return { ...usageReport("ok"), disk: diskUsage(80) };
        }
        return usageReport("critical");
      },
    };
    const docker: {
      pullImage?: (reference: string, options?: DockerPullOptions) => Promise<DockerPullResult>;
    } = {
      pullImage: (_reference, options) =>
        new Promise<DockerPullResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DockerError(0, "aborted")), {
            once: true,
          });
        }),
    };
    const service = new ImagePullService({
      config: {
        ...runnerConfig("/tmp", "/tmp"),
      },
      docker,
      imageGc,
      mutex: new ImageMutationMutex(),
      diskPollMs: 5,
    });

    await expect(service.pull({ reference: "agent-default:test" })).rejects.toMatchObject({
      status: 507,
      code: "disk_critical",
    });
    await waitFor(() => calls >= 2, "during-pull disk check");
  });

  it("aborts a running pull when the disk guard becomes unavailable", async () => {
    let calls = 0;
    const imageGc = {
      async usage() {
        calls += 1;
        if (calls === 1) {
          return { ...usageReport("ok"), disk: diskUsage(80) };
        }
        return { ...usageReport("ok"), disk: null };
      },
    };
    const docker = {
      pullImage: (_reference: string, options?: DockerPullOptions) =>
        new Promise<DockerPullResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DockerError(0, "aborted")), {
            once: true,
          });
        }),
    };
    const service = new ImagePullService({
      config: runnerConfig("/tmp", "/tmp"),
      docker,
      imageGc,
      mutex: new ImageMutationMutex(),
      diskPollMs: 5,
    });

    await expect(service.pull({ reference: "agent-default:test" })).rejects.toMatchObject({
      status: 507,
      code: "disk_guard_unavailable",
    });
  });
});

function jsonResponse(status: number, body: unknown): DockerResponse {
  return { status, body: Buffer.from(JSON.stringify(body), "utf8") };
}

class FakeStreamTransport implements DockerTransport {
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  lines: string[] = [];
  streamError: DockerError | undefined;

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<DockerResponse> {
    this.requests.push({ method, path, body });
    return jsonResponse(500, { message: "unexpected" });
  }

  stream(_method: "GET" | "POST", path: string, body?: unknown): AsyncIterable<string> {
    this.requests.push({ method: "POST", path, body });
    const lines = this.lines;
    const error = this.streamError;
    return (async function* () {
      for (const line of lines) yield line;
      if (error !== undefined) throw error;
    })();
  }
}

describe("DockerClient.pullImage", () => {
  it("streams NDJSON and parses aux.ID plus the Docker API query", async () => {
    const transport = new FakeStreamTransport();
    transport.lines = [
      JSON.stringify({ status: "Pulling from library/agent-default" }),
      JSON.stringify({ aux: { ID: "sha256:pulled" } }),
    ];
    const client = new DockerClient(transport);

    const result = await client.pullImage("agent-base:test");

    expect(result).toEqual({ imageId: "sha256:pulled", digest: null });
    const requestPath = transport.requests[0]?.path ?? "";
    const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
    expect(query.get("fromImage")).toBe("agent-base");
    expect(query.get("tag")).toBe("test");
  });

  it("splits a digest reference into fromImage and tag", async () => {
    const transport = new FakeStreamTransport();
    transport.lines = [JSON.stringify({ aux: { ID: "sha256:pinned" } })];
    const client = new DockerClient(transport);
    const digest = `sha256:${"c".repeat(64)}`;

    await client.pullImage(`agent-default@${digest}`);

    const requestPath = transport.requests[0]?.path ?? "";
    const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
    expect(query.get("fromImage")).toBe("agent-default");
    expect(query.get("tag")).toBe(digest);
  });

  it("surfaces a streamed error and errorDetail message", async () => {
    const transport = new FakeStreamTransport();
    transport.lines = [
      JSON.stringify({ errorDetail: { message: "manifest unknown" }, error: "manifest unknown" }),
    ];
    const client = new DockerClient(transport);

    await expect(client.pullImage("agent-default:test")).rejects.toMatchObject({
      status: 0,
      message: "manifest unknown",
    });
  });
});

describe("UnixDockerTransport.stream", () => {
  function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void) {
    const dir = tempDir("hanse-image-pull-sock-");
    const socketPath = path.join(dir, "docker.sock");
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise<string>((resolve) => {
      server.listen(socketPath, () => resolve(socketPath));
    });
  }

  it("yields NDJSON lines without buffering the whole body", async () => {
    const socketPath = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"status":"one"}\n');
      response.end('{"aux":{"ID":"sha256:two"}}\n');
    });
    const transport = new UnixDockerTransport({ socketPath, apiVersion: "v1.41" });
    const lines: string[] = [];
    for await (const line of transport.stream("POST", "/images/create")) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"status":"one"}', '{"aux":{"ID":"sha256:two"}}']);
  });

  it("rejects an oversized line with a bounded budget", async () => {
    const socketPath = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${"x".repeat(64)}\n`);
    });
    const transport = new UnixDockerTransport({ socketPath, apiVersion: "v1.41" });
    const consume = async () => {
      for await (const _line of transport.stream("POST", "/images/create", undefined, {
        maxLineBytes: 16,
      })) {
        // consume
      }
    };
    await expect(consume()).rejects.toMatchObject({ status: 413 });
  });

  it("throws a sanitized DockerError for a non-2xx response", async () => {
    const socketPath = await listen((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "pull denied" }));
    });
    const transport = new UnixDockerTransport({ socketPath, apiVersion: "v1.41" });
    const consume = async () => {
      for await (const _line of transport.stream("POST", "/images/create")) {
        // consume
      }
    };
    await expect(consume()).rejects.toMatchObject({ status: 500 });
  });
});

describe("RunnerImageClient.pull benign skips", () => {
  const cases: Array<[number, unknown, string]> = [
    [409, { error: "busy", code: "image_mutation_in_progress" }, "mutation_in_progress"],
    [507, { error: "disk", code: "disk_critical" }, "disk_critical"],
    [507, { error: "disk", code: "disk_guard_unavailable" }, "disk_guard_unavailable"],
    [404, undefined, "unsupported"],
    [405, undefined, "unsupported"],
  ];

  it("maps conflict, disk guard, and old-runner statuses to typed skips", async () => {
    for (const [status, body, reason] of cases) {
      const client = new RunnerImageClient({
        baseUrl: "http://runner.example",
        token: "runtime-token",
        fetchImpl: async () =>
          new Response(body === undefined ? "" : JSON.stringify(body), { status }),
      });
      const result = await client.pull("agent-default:test");
      expect(result.skipped, String(status)).toBe(true);
      expect(result.skipReason).toBe(reason);
    }
  });
});

class FakePullRunner implements ImageRunnerClient {
  readonly pullCalls: string[] = [];
  readonly pullResults = new Map<string, RunnerImagePullResult>();
  readonly inspections = new Map<string, RunnerImageInspect>();
  usageReport: ReturnType<typeof usageReport> = usageReport("ok");
  inspectCalls = 0;

  async build(_input: ImageBuildInput): Promise<{
    buildId: string;
    appId: string;
    status: "building";
  }> {
    throw new Error("build is not used");
  }

  async get(appId: string): Promise<RunnerImageRecord> {
    return {
      appId,
      status: "missing",
      imageRef: null,
      imageId: null,
      buildId: null,
      logs: "",
      error: null,
      updatedAt: null,
    };
  }

  async getBuild(): Promise<RunnerImageRecord | undefined> {
    return undefined;
  }

  async inspect(reference: string): Promise<RunnerImageInspect> {
    this.inspectCalls += 1;
    return (
      this.inspections.get(reference) ?? {
        found: false,
        imageId: null,
        repoDigests: [],
        resolvedDigest: null,
      }
    );
  }

  async usage(): Promise<ReturnType<typeof usageReport>> {
    return this.usageReport;
  }

  async pull(reference: string): Promise<RunnerImagePullResult> {
    this.pullCalls.push(reference);
    return (
      this.pullResults.get(reference) ?? {
        reference,
        previousImageId: null,
        imageId: "sha256:new",
        changed: true,
        digest: null,
        skipped: false,
      }
    );
  }
}

interface CoordinatorFixture {
  db: SqliteDatabase;
  service: ImageService;
  runner: FakePullRunner;
  projectId: string;
  webId: string;
  apiId: string;
  workspace: string;
  projectRoot: string;
}

async function coordinatorFixture(
  options: { defaultImage?: string; baseImage?: string; deploymentLock?: DeploymentLock } = {},
): Promise<CoordinatorFixture> {
  const dir = tempDir("hanse-image-pull-coordinator-");
  const workspacePath = path.join(dir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = realpathSync(workspacePath);
  const projectRoot = path.join(workspace, "project");
  const webDir = path.join(projectRoot, "apps", "web");
  const apiDir = path.join(projectRoot, "apps", "api");
  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  mkdirSync(path.join(webDir, ".hanse"), { recursive: true });
  mkdirSync(path.join(apiDir, ".hanse"), { recursive: true });
  const projectId = randomUUID();
  writeFileSync(
    path.join(projectRoot, ".hanse", "project.yaml"),
    `id: ${projectId}\nname: Alpha\nbase_branch: main\napps:\n  - path: apps/web\n  - path: apps/api\n`,
    "utf8",
  );
  writeFileSync(
    path.join(apiDir, ".hanse", "app.yaml"),
    "name: api\nkind: service\nbuild:\n  dockerfile: Dockerfile\n",
    "utf8",
  );
  writeFileSync(
    path.join(apiDir, "Dockerfile"),
    ["ARG HANSE_BASE", `FROM ${"$"}{HANSE_BASE}`, ""].join("\n"),
    "utf8",
  );

  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const { project, rootPath } = await discoverProject(projectRoot);
  registerProject(db, project, rootPath, workspace);

  const defaultImage = options.defaultImage ?? "agent-default:test";
  const runner = new FakePullRunner();
  const service = new ImageService({
    db,
    workspaceRoot: workspace,
    hostWorkspace: path.join(dir, "host-workspace"),
    defaultImage,
    ...(options.baseImage === undefined ? {} : { baseImage: options.baseImage }),
    runner,
    ...(options.deploymentLock === undefined ? {} : { deploymentLock: options.deploymentLock }),
  });
  return {
    db,
    service,
    runner,
    projectId,
    webId: `${projectId}:web`,
    apiId: `${projectId}:api`,
    workspace,
    projectRoot,
  };
}

function events(db: SqliteDatabase): { scope: string; type: string; payload: unknown }[] {
  const rows = db.prepare("SELECT scope, type, payload FROM events ORDER BY id").all() as {
    scope: string;
    type: string;
    payload: string;
  }[];
  return rows.map((row) => ({
    scope: row.scope,
    type: row.type,
    payload: JSON.parse(row.payload),
  }));
}

describe("ImageService.pullConfigured", () => {
  const oldDefault = `sha256:${"d".repeat(64)}`;
  const newDefault = `sha256:${"e".repeat(64)}`;
  const oldBase = `sha256:${"f".repeat(64)}`;
  const newBase = `sha256:${"1".repeat(64)}`;

  it("pulls default then base once, invalidates the identity cache, and audits changes", async () => {
    const f = await coordinatorFixture({ baseImage: "agent-base:test" });
    f.db
      .prepare(
        `UPDATE apps SET build_configured = 1, image_base_kind = 'base',
           image_base_ref = 'agent-base:test', image_base_digest = @digest
         WHERE id = @id`,
      )
      .run({ id: f.apiId, digest: oldBase });
    f.runner.inspections.set("agent-default:test", {
      found: true,
      imageId: "sha256:old-default",
      repoDigests: [`agent-default@${oldDefault}`],
      resolvedDigest: oldDefault,
    });
    f.runner.inspections.set("agent-base:test", {
      found: true,
      imageId: "sha256:old-base",
      repoDigests: [`agent-base@${oldBase}`],
      resolvedDigest: oldBase,
    });
    f.runner.pullResults.set("agent-default:test", {
      reference: "agent-default:test",
      previousImageId: "sha256:old-default",
      imageId: "sha256:new-default",
      changed: true,
      digest: newDefault,
      skipped: false,
    });
    f.runner.pullResults.set("agent-base:test", {
      reference: "agent-base:test",
      previousImageId: "sha256:old-base",
      imageId: "sha256:new-base",
      changed: true,
      digest: newBase,
      skipped: false,
    });

    const report = await f.service.pullConfigured();

    expect(report.ok).toBe(true);
    expect(report.attempts.map((attempt) => attempt.reference)).toEqual([
      "agent-default:test",
      "agent-base:test",
    ]);
    expect(report.attempts.every((attempt) => attempt.outcome === "changed")).toBe(true);
    expect(f.runner.pullCalls).toEqual(["agent-default:test", "agent-base:test"]);

    const before = f.runner.inspectCalls;
    await f.service.imageState(f.webId);
    expect(f.runner.inspectCalls).toBeGreaterThan(before);

    const rows = events(f.db);
    const global = rows.filter((row) => row.type === "image.auto_pull");
    expect(global).toHaveLength(2);
    expect(global.map((row) => row.payload)).toEqual([
      expect.objectContaining({
        reference: "agent-default:test",
        previousImageId: "sha256:old-default",
        imageId: "sha256:new-default",
        digest: newDefault,
        changed: true,
        outcome: "changed",
      }),
      expect.objectContaining({
        reference: "agent-base:test",
        outcome: "changed",
      }),
    ]);
    expect(
      rows.filter((row) => row.type === "app.auto_pulled" && row.scope === f.webId),
    ).toHaveLength(1);
    const rebuild = rows.filter((row) => row.type === "app.rebuild_required");
    expect(rebuild).toHaveLength(1);
    expect(rebuild[0]?.scope).toBe(f.apiId);
    expect(rebuild[0]?.payload).toMatchObject({ reference: "agent-base:test", digest: newBase });
  });

  it("skips digest-pinned, draining, deployment-locked, and critical-disk references", async () => {
    const pinned = await coordinatorFixture({
      defaultImage: `agent-default@${oldDefault}`,
    });
    const pinnedReport = await pinned.service.pullConfigured();
    expect(pinnedReport.attempts[0]).toMatchObject({
      outcome: "skipped",
      reason: "digest_pinned",
    });
    expect(pinned.runner.pullCalls).toEqual([]);

    const draining = await coordinatorFixture();
    const drainingReport = await draining.service.pullConfigured({ isDraining: () => true });
    expect(drainingReport.attempts[0]).toMatchObject({
      outcome: "skipped",
      reason: "draining",
    });
    expect(draining.runner.pullCalls).toEqual([]);

    const locked = await coordinatorFixture({
      deploymentLock: {
        isActive: () => true,
        status: () => ({ active: true }),
        assertUnlocked: () => undefined,
      } as unknown as DeploymentLock,
    });
    const lockedReport = await locked.service.pullConfigured();
    expect(lockedReport.attempts[0]).toMatchObject({
      outcome: "skipped",
      reason: "deployment_locked",
    });
    expect(locked.runner.pullCalls).toEqual([]);

    const full = await coordinatorFixture();
    full.runner.usageReport = usageReport("critical");
    const fullReport = await full.service.pullConfigured();
    expect(fullReport.attempts[0]).toMatchObject({
      outcome: "skipped",
      reason: "disk_critical",
    });
    expect(full.runner.pullCalls).toEqual([]);
  });

  it("dedupes an identical default/base reference and skips an unused base", async () => {
    const unused = await coordinatorFixture({ baseImage: "agent-base:test" });
    const unusedReport = await unused.service.pullConfigured();
    expect(unusedReport.attempts.map((attempt) => attempt.reference)).toEqual([
      "agent-default:test",
    ]);

    const identical = await coordinatorFixture({ baseImage: "agent-default:test" });
    identical.db
      .prepare(
        `UPDATE apps SET build_configured = 1, image_base_kind = 'base',
           image_base_ref = 'agent-default:test', image_base_digest = @digest
         WHERE id = @id`,
      )
      .run({ id: identical.apiId, digest: oldDefault });
    const identicalReport = await identical.service.pullConfigured();
    expect(identicalReport.attempts.map((attempt) => attempt.reference)).toEqual([
      "agent-default:test",
    ]);
    expect(identical.runner.pullCalls).toEqual(["agent-default:test"]);
  });

  it("records a global skip for a runner-side conflict and a failure for a transport error", async () => {
    const conflict = await coordinatorFixture();
    conflict.runner.pull = async (reference) => {
      conflict.runner.pullCalls.push(reference);
      return {
        reference,
        previousImageId: null,
        imageId: null,
        changed: false,
        digest: null,
        skipped: true,
        skipReason: "mutation_in_progress",
      };
    };
    const conflictReport = await conflict.service.pullConfigured();
    expect(conflictReport.attempts[0]).toMatchObject({
      outcome: "skipped",
      reason: "mutation_in_progress",
    });
    expect(events(conflict.db).filter((row) => row.type === "image.auto_pull")).toHaveLength(1);

    const failed = await coordinatorFixture();
    failed.runner.pull = async () => {
      throw new Error("runner down");
    };
    const failedReport = await failed.service.pullConfigured();
    expect(failedReport.ok).toBe(false);
    expect(failedReport.attempts[0]).toMatchObject({ outcome: "failed" });
    expect(events(failed.db).filter((row) => row.type === "image.auto_pull")).toHaveLength(1);
  });
});
