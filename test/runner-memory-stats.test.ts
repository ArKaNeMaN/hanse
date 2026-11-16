import { Buffer } from "node:buffer";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DockerContainerCreateOptions,
  DockerContainerInspect,
  DockerContainerStats,
  DockerContainerSummary,
  DockerLogs,
  DockerNetworkSpec,
  DockerResponse,
  DockerRuntime,
  DockerStreamOptions,
  DockerTransport,
} from "../src/runner/docker.js";
import { DockerClient, DockerError } from "../src/runner/docker.js";
import { RunnerService } from "../src/runner/server.js";
import type { RunnerConfig } from "../src/runner/validate.js";

const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function json(status: number, body: unknown): DockerResponse {
  return { status, body: Buffer.from(JSON.stringify(body), "utf8") };
}

function dockerClient(handler: () => DockerResponse): {
  client: DockerClient;
  paths: string[];
} {
  const paths: string[] = [];
  const transport: DockerTransport = {
    async request(_method, path) {
      paths.push(path);
      return handler();
    },
  };
  return { client: new DockerClient(transport), paths };
}

const stat: DockerContainerStats = {
  usageBytes: 1_000,
  workingSetBytes: 700,
  limitBytes: 2_000,
  anonBytes: 500,
  fileBytes: 200,
};

function summary(
  id: string,
  appId: string | undefined,
  created: number,
  state = "running",
): DockerContainerSummary {
  return {
    Id: id,
    Names: [`/${id}`],
    Image: "agent-default:test",
    Created: created,
    State: state,
    Status: state,
    Labels: {
      "hanse.managed": "true",
      ...(appId === undefined ? {} : { "hanse.app.id": appId }),
    },
  };
}

class StatsDocker implements DockerRuntime {
  readonly containers: DockerContainerSummary[] = [];
  readonly stats = new Map<string, DockerContainerStats | Error>();
  readonly statsCalls: string[] = [];
  readonly hanging = new Set<string>();
  listError: Error | undefined;

  async version(): Promise<string> {
    return "1.44";
  }

  async ensureNetwork(_spec: DockerNetworkSpec): Promise<void> {}

  async removeNetwork(_name: string): Promise<void> {}

  async connectNetwork(_network: string, _container: string, _aliases: string[]): Promise<void> {}

  async disconnectNetwork(_network: string, _container: string): Promise<void> {}

  async createContainer(_options: DockerContainerCreateOptions): Promise<string> {
    throw new Error("not used");
  }

  async startContainer(_id: string): Promise<void> {}

  async stopContainer(_id: string): Promise<void> {}

  async removeContainer(_id: string): Promise<void> {}

  async inspectContainer(_idOrName: string): Promise<DockerContainerInspect | undefined> {
    return undefined;
  }

  async listContainers(_label?: string): Promise<DockerContainerSummary[]> {
    if (this.listError !== undefined) throw this.listError;
    return this.containers;
  }

  async logs(_id: string): Promise<DockerLogs> {
    return { logs: "", truncated: false };
  }

  async waitContainer(_id: string): Promise<{ StatusCode?: number }> {
    return { StatusCode: 0 };
  }

  async containerStats(id: string): Promise<DockerContainerStats> {
    this.statsCalls.push(id);
    if (this.hanging.has(id)) return new Promise<DockerContainerStats>(() => {});
    const value = this.stats.get(id);
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`no stats for ${id}`);
    return value;
  }
}

function config(): RunnerConfig {
  return {
    token: "runtime-token",
    hostWorkspace: "/tmp/workspace",
    hostAgents: "/tmp/agents",
    hostMounts: "/tmp/mounts",
    allowedImages: new Set(["agent-default:test"]),
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
  };
}

function serviceWith(docker: StatsDocker): RunnerService {
  return new RunnerService({ config: config(), docker });
}

describe("DockerClient.containerStats", () => {
  it("requests a one-shot sample and parses cgroup v2 inactive_file", async () => {
    const f = dockerClient(() =>
      json(200, {
        memory_stats: {
          usage: 1_000,
          limit: 2_000,
          stats: { inactive_file: 300, anon: 500, file: 200 },
        },
      }),
    );

    await expect(f.client.containerStats("abc")).resolves.toEqual({
      usageBytes: 1_000,
      workingSetBytes: 700,
      limitBytes: 2_000,
      anonBytes: 500,
      fileBytes: 200,
    });
    expect(f.paths).toEqual(["/containers/abc/stats?stream=false&one-shot=true"]);
  });

  it("parses cgroup v1 total_inactive_file and clamps the working set at zero", async () => {
    const f = dockerClient(() =>
      json(200, {
        memory_stats: { usage: 100, limit: 2_000, stats: { total_inactive_file: 300 } },
      }),
    );

    await expect(f.client.containerStats("v1")).resolves.toEqual({
      usageBytes: 100,
      workingSetBytes: 0,
      limitBytes: 2_000,
      anonBytes: null,
      fileBytes: null,
    });
  });

  it("encodes the event filter and disables the idle timeout", async () => {
    const paths: string[] = [];
    const options: (DockerStreamOptions | undefined)[] = [];
    const transport: DockerTransport = {
      async request() {
        throw new Error("not used");
      },
      stream(_method, path, _body, streamOptions) {
        paths.push(path);
        options.push(streamOptions);
        return (async function* () {})();
      },
    };
    const client = new DockerClient(transport);
    const signal = new AbortController().signal;
    const filter = { type: ["container"], event: ["oom"], label: ["hanse.managed=true"] };

    await client.streamEvents(filter, signal)[Symbol.asyncIterator]().next();

    expect(paths).toEqual([`/events?filters=${encodeURIComponent(JSON.stringify(filter))}`]);
    expect(options[0]?.timeoutMs).toBe(0);
    expect(options[0]?.signal).toBe(signal);
  });

  it("rejects an invalid payload instead of guessing values", async () => {
    const f = dockerClient(() => json(200, { memory_stats: { usage: -1, limit: 2_000 } }));

    await expect(f.client.containerStats("bad")).rejects.toBeInstanceOf(DockerError);
  });
});

describe("GET /v1/app-stats", () => {
  it("returns running managed containers deduped by app id, newest Created wins, sorted", async () => {
    const docker = new StatsDocker();
    docker.containers.push(
      summary("b-old", "project:b", 100),
      summary("b-new", "project:b", 200),
      summary("a", "project:a", 50),
      summary("stopped", "project:c", 999, "exited"),
      summary("unlabelled", undefined, 999),
    );
    docker.stats.set("b-new", { ...stat, usageBytes: 2_000, workingSetBytes: 2_000 });
    docker.stats.set("a", { ...stat, usageBytes: 1_000, workingSetBytes: 1_000 });

    const result = await serviceWith(docker).appStats();

    expect(docker.statsCalls).toEqual(["a", "b-new"]);
    expect(result).toEqual({
      apps: [
        { appId: "project:a", ...docker.stats.get("a") },
        { appId: "project:b", ...docker.stats.get("b-new") },
      ],
    });
  });

  it("isolates a failed container and logs the omission count", async () => {
    const docker = new StatsDocker();
    docker.containers.push(summary("a", "project:a", 1), summary("b", "project:b", 1));
    docker.stats.set("a", new DockerError(500, "stats failed"));
    docker.stats.set("b", stat);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await serviceWith(docker).appStats();

    expect(result).toEqual({ apps: [{ appId: "project:b", ...stat }] });
    expect(warn).toHaveBeenCalledWith("[runner] app-stats omitted 1 container(s)");
  });

  it("enforces the per-call timeout", async () => {
    vi.useFakeTimers();
    const docker = new StatsDocker();
    docker.containers.push(summary("a", "project:a", 1));
    docker.hanging.add("a");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = serviceWith(docker);

    const pending = service.appStats();
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(pending).resolves.toEqual({ apps: [] });
    expect(warn).toHaveBeenCalledWith("[runner] app-stats omitted 1 container(s)");
  });

  it("stops scheduling calls at the batch deadline", async () => {
    vi.useFakeTimers();
    const docker = new StatsDocker();
    for (let index = 0; index < 10; index += 1) {
      const id = `c${index}`;
      docker.containers.push(summary(id, `project:${index}`, index));
      docker.hanging.add(id);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = serviceWith(docker);

    const pending = service.appStats();
    await vi.advanceTimersByTimeAsync(15_001);

    await expect(pending).resolves.toEqual({ apps: [] });
    expect(docker.statsCalls).toHaveLength(10);
    expect(warn).toHaveBeenCalledWith("[runner] app-stats omitted 10 container(s)");
  });

  it("serves the authenticated endpoint and rejects other methods", async () => {
    const docker = new StatsDocker();
    docker.containers.push(summary("a", "project:a", 1));
    docker.stats.set("a", stat);
    const service = serviceWith(docker);
    const server = service.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${base}/v1/app-stats`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${base}/v1/app-stats`, {
      headers: { authorization: "Bearer runtime-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apps: [{ appId: "project:a", ...stat }] });

    const wrongMethod = await fetch(`${base}/v1/app-stats`, {
      method: "POST",
      headers: { authorization: "Bearer runtime-token" },
    });
    expect(wrongMethod.status).toBe(405);
  });
});
