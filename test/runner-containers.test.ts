import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DockerContainerCreateOptions,
  type DockerContainerInspect,
  type DockerContainerSummary,
  DockerError,
  type DockerImageInspect,
  type DockerLogs,
  type DockerNetworkInspect,
  type DockerNetworkSpec,
  type DockerRuntime,
} from "../src/runner/docker.js";
import { appContainerName, appNetworkName } from "../src/runner/names.js";
import { RunnerService } from "../src/runner/server.js";
import { RUNNER_APP_PORT, type RunnerConfig } from "../src/runner/validate.js";

const dirs: string[] = [];
const servers: Server[] = [];

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
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  base: string;
  workspace: string;
  agents: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-runner-service-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const agents = path.join(base, "agents");
  return { base, workspace, agents };
}

function config(f: Fixture): RunnerConfig {
  return {
    token: "runtime-token",
    hostWorkspace: f.workspace,
    hostAgents: f.agents,
    allowedImages: new Set(["agent-default:test"]),
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
  };
}

function rawSpec(f: Fixture, appKey: string, overrides: Record<string, unknown> = {}) {
  const appId = `project:${appKey}`;
  const appDir = path.join(f.workspace, "project", appKey);
  const agentsRoot = path.join(f.agents, "project", appKey);
  const stateDir = path.join(agentsRoot, "state");
  for (const dir of [appDir, stateDir, path.join(agentsRoot, "home")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(stateDir, "opencode-password"), "password\n");
  return {
    appId,
    image: "agent-default:test",
    pathMode: "host",
    appDir,
    stateDir,
    networkName: appNetworkName(appId),
    port: RUNNER_APP_PORT,
    env: {
      HOME: `/data/agents/project/${appKey}/home`,
      XDG_DATA_HOME: `/data/agents/project/${appKey}/data`,
      XDG_STATE_HOME: `/data/agents/project/${appKey}/state`,
      XDG_CONFIG_HOME: `/data/agents/project/${appKey}/config`,
      XDG_CACHE_HOME: `/data/agents/project/${appKey}/cache`,
      OPENCODE_DB: `/data/agents/project/${appKey}/state/opencode.db`,
      TMPDIR: `/data/agents/project/${appKey}/tmp`,
      MISE_DATA_DIR: `/data/agents/project/${appKey}/mise`,
      HANSE_OPENCODE_PASSWORD_FILE: `/data/agents/project/${appKey}/state/opencode-password`,
    },
    resources: { memoryBytes: 1024, nanoCpus: 1, pidsLimit: 128 },
    labels: { "hanse.managed": "true" },
    ...overrides,
  };
}

class FakeDocker implements DockerRuntime {
  readonly containers = new Map<string, DockerContainerInspect>();
  readonly images = new Map<string, DockerImageInspect>();
  readonly networks = new Map<string, DockerNetworkSpec>();
  readonly networkContainers = new Map<string, Set<string>>();
  readonly creates: DockerContainerCreateOptions[] = [];
  readonly connects: { network: string; container: string; aliases: string[] }[] = [];
  readonly disconnects: { network: string; container: string }[] = [];
  networkRemoveError: Error | undefined;
  createErrorAfterContainer: Error | undefined;
  startError: Error | undefined;
  #next = 1;

  async version(): Promise<string> {
    return "1.44";
  }

  async ensureNetwork(spec: DockerNetworkSpec): Promise<void> {
    this.networks.set(spec.name, spec);
  }

  async removeNetwork(name: string): Promise<void> {
    if (this.networkRemoveError !== undefined) throw this.networkRemoveError;
    this.networks.delete(name);
    this.networkContainers.delete(name);
  }

  async inspectNetwork(name: string): Promise<DockerNetworkInspect | undefined> {
    const network = this.networks.get(name);
    if (network === undefined) return undefined;
    const members = this.networkContainers.get(name);
    return {
      Name: network.name,
      Labels: network.labels,
      Containers:
        members === undefined
          ? {}
          : Object.fromEntries([...members].map((container) => [container, { Name: container }])),
    };
  }

  async connectNetwork(network: string, container: string, aliases: string[]): Promise<void> {
    const members = this.networkContainers.get(network) ?? new Set<string>();
    members.add(container);
    this.networkContainers.set(network, members);
    this.connects.push({ network, container, aliases });
  }

  async disconnectNetwork(network: string, container: string): Promise<void> {
    this.disconnects.push({ network, container });
    this.networkContainers.get(network)?.delete(container);
  }

  async createContainer(options: DockerContainerCreateOptions): Promise<string> {
    this.creates.push(options);
    const id = `container-${this.#next++}`;
    const inspect: DockerContainerInspect = {
      Id: id,
      Name: `/${options.name}`,
      Image: this.images.get(options.image)?.Id ?? options.image,
      Config: {
        Image: options.image,
        Labels: options.labels,
        Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
        Entrypoint: options.entrypoint,
        Cmd: options.cmd,
        User: options.user,
      },
      State: { Status: "created", Running: false, ExitCode: 0 },
      HostConfig: {
        Binds: options.binds,
        NetworkMode: options.networkName,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        Memory: options.memoryBytes,
        NanoCpus: options.nanoCpus,
        PidsLimit: options.pidsLimit,
      },
      NetworkSettings: { Networks: { [options.networkName]: {} } },
    };
    this.containers.set(id, inspect);
    if (this.createErrorAfterContainer !== undefined) throw this.createErrorAfterContainer;
    return id;
  }

  async startContainer(id: string): Promise<void> {
    if (this.startError !== undefined) throw this.startError;
    const container = this.#byId(id);
    container.State = { Status: "running", Running: true, ExitCode: 0 };
  }

  async stopContainer(id: string): Promise<void> {
    const container = this.#byId(id);
    container.State = { Status: "exited", Running: false, ExitCode: 0 };
  }

  async removeContainer(id: string): Promise<void> {
    this.containers.delete(id);
  }

  async inspectContainer(idOrName: string): Promise<DockerContainerInspect | undefined> {
    const direct = this.containers.get(idOrName);
    if (direct !== undefined) return direct;
    return [...this.containers.values()].find((container) => container.Name === `/${idOrName}`);
  }

  async inspectImage(reference: string): Promise<DockerImageInspect | undefined> {
    return this.images.get(reference);
  }

  async listContainers(label?: string): Promise<DockerContainerSummary[]> {
    const [labelKey, labelValue] = label?.split("=", 2) ?? [];
    return [...this.containers.values()]
      .filter(
        (container) =>
          label === undefined ||
          (labelKey !== undefined &&
            labelValue !== undefined &&
            container.Config?.Labels?.[labelKey] === labelValue),
      )
      .map((container) => ({
        Id: container.Id,
        Names: [container.Name],
        Image: container.Config?.Image ?? "",
        State: container.State?.Status ?? "unknown",
        Status: container.State?.Status ?? "unknown",
        Labels: container.Config?.Labels,
      }));
  }

  async logs(id: string): Promise<DockerLogs> {
    return { logs: `logs:${id}`, truncated: false };
  }

  async waitContainer(_id: string): Promise<{ StatusCode?: number }> {
    return { StatusCode: 0 };
  }

  #byId(id: string): DockerContainerInspect {
    const container = this.containers.get(id);
    if (container === undefined) throw new Error(`unknown container ${id}`);
    return container;
  }
}

async function harness(): Promise<{ f: Fixture; docker: FakeDocker; service: RunnerService }> {
  const f = fixture();
  const docker = new FakeDocker();
  const service = new RunnerService({ config: config(f), docker });
  return { f, docker, service };
}

describe("RunnerService per-app containers", () => {
  it("creates isolated containers with only app and agents mounts", async () => {
    const { f, docker, service } = await harness();

    const a = await service.ensure(rawSpec(f, "a"), "project:a");
    const b = await service.ensure(rawSpec(f, "b"), "project:b");

    expect(a.state).toBe("running");
    expect(b.state).toBe("running");
    expect(docker.creates).toHaveLength(2);
    for (const options of docker.creates) {
      expect(options.user).toBe("1000:1000");
      expect(options.binds).toHaveLength(2);
      expect(options.binds.join("\n")).not.toContain("/data/state");
      expect(options.binds.join("\n")).not.toContain("docker.sock");
      expect(options.memoryBytes).toBe(1024);
      expect(options.nanoCpus).toBe(1);
      expect(options.pidsLimit).toBe(128);
      expect(options.networkName).toMatch(/^hanse-app-project-/);
    }
    expect(docker.creates[0]?.networkName).not.toBe(docker.creates[1]?.networkName);
    expect(docker.connects).toHaveLength(2);
    expect(docker.connects.every((call) => call.aliases.includes("hanse"))).toBe(true);
    expect(docker.creates[0]?.env.OPENCODE_SERVER_PASSWORD).toBe("password");
    expect(docker.creates[0]?.env.HANSE_OPENCODE_PASSWORD_FILE).toBeUndefined();
  });

  it("adds a nested read-only attachments bind and fails when its source is missing", async () => {
    const { f, docker, service } = await harness();
    mkdirSync(path.join(f.agents, "project", "a", "attachments"), { recursive: true });
    await service.ensure(rawSpec(f, "a", { attachmentsReadOnly: true }), "project:a");
    expect(docker.creates[0]?.binds).toEqual([
      `${path.join(f.workspace, "project", "a")}:/data/workspace/project/a:rw`,
      `${path.join(f.agents, "project", "a")}:/data/agents/project/a:rw`,
      `${path.join(f.agents, "project", "a", "attachments")}:/data/agents/project/a/attachments:ro`,
    ]);

    await expect(
      service.ensure(rawSpec(f, "b", { attachmentsReadOnly: true }), "project:b"),
    ).rejects.toMatchObject({ status: 409, code: "attachments_root_missing" });
  });

  it("allows only a validated per-app image carrying this app's build label", async () => {
    const { f, docker, service } = await harness();
    const image = "hanse-app-project-a:build-1";
    docker.images.set(image, {
      Id: "sha256:built",
      Config: { Labels: { "hanse.app.id": "project:a", "hanse.image.version": "hash-1" } },
    });

    const status = await service.ensure(rawSpec(f, "a", { image }), "project:a");
    expect(status.state).toBe("running");
    expect(docker.creates[0]?.image).toBe(image);

    const other = await service
      .ensure(rawSpec(f, "b", { image }), "project:b")
      .catch(() => "rejected");
    expect(other).toBe("rejected");
    expect(docker.creates).toHaveLength(1);
  });

  it("is idempotent for the same spec and recreates a changed spec", async () => {
    const { f, docker, service } = await harness();
    const spec = rawSpec(f, "a");

    await service.ensure(spec);
    await service.ensure(spec);
    expect(docker.creates).toHaveLength(1);

    await service.ensure(
      rawSpec(f, "a", { resources: { memoryBytes: 2048, nanoCpus: 2, pidsLimit: 256 } }),
    );
    expect(docker.creates).toHaveLength(2);
    expect(docker.creates[1]?.memoryBytes).toBe(2048);
  });

  it("adopts and starts a container left behind by a timed-out create", async () => {
    const { f, docker, service } = await harness();
    docker.createErrorAfterContainer = new DockerError(0, "docker request timed out");

    const status = await service.ensure(rawSpec(f, "a"), "project:a");

    expect(status.state).toBe("running");
    expect(docker.creates).toHaveLength(1);
    expect(docker.containers.size).toBe(1);
    expect([...docker.containers.values()][0]?.State?.Running).toBe(true);
  });

  it("removes the new container when start fails", async () => {
    const { f, docker, service } = await harness();
    docker.startError = new DockerError(0, "docker request timed out");

    await expect(service.ensure(rawSpec(f, "a"), "project:a")).rejects.toMatchObject({
      message: "docker request timed out",
    });
    expect(docker.containers.size).toBe(0);
  });

  it("deletes the container/network but keeps the host agents directory", async () => {
    const { f, docker, service } = await harness();
    const spec = rawSpec(f, "a");
    await service.ensure(spec);

    const status = await service.delete("project:a");
    expect(status.state).toBe("stopped");
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.size).toBe(0);
    expect(existsSync(path.join(f.agents, "project", "a"))).toBe(true);
    expect(await service.status("project:a")).toBeUndefined();
  });

  it("removes an orphan app network after disconnecting the coordinator", async () => {
    const { docker, service } = await harness();
    const network = appNetworkName("project:orphan");
    docker.networks.set(network, {
      name: network,
      labels: { "hanse.managed": "true", "hanse.app.id": "project:orphan" },
    });
    docker.networkContainers.set(network, new Set(["hanse"]));

    const status = await service.delete("project:orphan");

    expect(status.state).toBe("stopped");
    expect(docker.disconnects).toContainEqual({ network, container: "hanse" });
    expect(docker.networks.has(network)).toBe(false);
  });

  it("never removes an unmanaged network or an unmanaged container", async () => {
    const { docker, service } = await harness();
    const network = appNetworkName("project:a");
    docker.networks.set(network, {
      name: network,
      labels: { "hanse.managed": "false", "hanse.app.id": "project:a" },
    });
    docker.containers.set("foreign", {
      Id: "foreign",
      Name: `/${appContainerName("project:a")}`,
      Config: { Labels: { "hanse.app.id": "project:a" } },
      State: { Status: "running", Running: true },
    });

    const status = await service.delete("project:a");

    expect(status.state).toBe("stopped");
    expect(docker.containers.has("foreign")).toBe(true);
    expect(docker.networks.has(network)).toBe(true);
  });

  it("never removes a managed network that belongs to another app", async () => {
    const { docker, service } = await harness();
    const network = appNetworkName("project:a");
    docker.networks.set(network, {
      name: network,
      labels: { "hanse.managed": "true", "hanse.app.id": "project:other" },
    });

    await service.delete("project:a");

    expect(docker.networks.has(network)).toBe(true);
  });

  it("tolerates 404 and 409 when removing the network during reconcile", async () => {
    const { f, docker, service } = await harness();
    await service.ensure(rawSpec(f, "a"));
    docker.networkRemoveError = new DockerError(409, "network has active endpoints");

    const reconciled = await service.reconcile([]);
    expect(reconciled.stopped).toEqual(["project:a"]);
    expect(docker.containers.size).toBe(0);
    expect(docker.networks.has(appNetworkName("project:a"))).toBe(true);

    const orphan = appNetworkName("project:orphan");
    docker.networks.set(orphan, {
      name: orphan,
      labels: { "hanse.managed": "true", "hanse.app.id": "project:orphan" },
    });
    docker.networkRemoveError = new DockerError(404, "no such network");
    await expect(service.delete("project:orphan")).resolves.toMatchObject({ state: "stopped" });
  });

  it("reconciles and stops every managed container", async () => {
    const { f, docker, service } = await harness();
    await service.ensure(rawSpec(f, "a"));
    await service.ensure(rawSpec(f, "b"));

    const reconciled = await service.reconcile(["project:a"]);
    expect(reconciled.stopped).toEqual(["project:b"]);
    expect(docker.containers.size).toBe(1);

    const stopped = await service.stopAll();
    expect(stopped.stopped).toEqual(["project:a"]);
    expect(docker.containers.size).toBe(0);
  });

  it("exposes health and enforces the runtime token", async () => {
    const { f, service } = await harness();
    await service.ensure(rawSpec(f, "a"));
    const server = service.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, apps: 1 });

    const unauthorized = await fetch(`${base}/v1/apps/project%3Aa`, {
      method: "DELETE",
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${base}/v1/apps/project%3Aa`, {
      method: "DELETE",
      headers: { authorization: "Bearer runtime-token" },
    });
    expect(authorized.status).toBe(200);
  });
});

describe("runner launch identity", () => {
  it("reports the container image id and null after stop", async () => {
    const { f, docker, service } = await harness();
    docker.images.set("agent-default:test", { Id: "sha256:default" });

    const status = await service.ensure(rawSpec(f, "a"), "project:a");
    expect(status.imageId).toBe("sha256:default");

    const deleted = await service.delete("project:a");
    expect(deleted.imageId).toBeNull();
  });

  it("recreates a stopped container whose image id is not the inspected target", async () => {
    const { f, docker, service } = await harness();
    await service.ensure(rawSpec(f, "a"));
    const first = [...docker.containers.values()][0];
    if (first === undefined) throw new Error("missing container");
    docker.images.set("agent-default:test", { Id: "sha256:new-target" });
    await docker.stopContainer(first.Id);

    const status = await service.ensure(rawSpec(f, "a"));

    expect(docker.creates).toHaveLength(2);
    expect(docker.containers.size).toBe(1);
    expect(status.imageId).toBe("sha256:new-target");
  });

  it("reuses a running container even when the target image moved", async () => {
    const { f, docker, service } = await harness();
    await service.ensure(rawSpec(f, "a"));
    docker.images.set("agent-default:test", { Id: "sha256:new-target" });

    const status = await service.ensure(rawSpec(f, "a"));

    expect(docker.creates).toHaveLength(1);
    expect(status.state).toBe("running");
  });

  it("fails closed when a stopped container's target image cannot be inspected", async () => {
    const { f, docker, service } = await harness();
    await service.ensure(rawSpec(f, "a"));
    const first = [...docker.containers.values()][0];
    if (first === undefined) throw new Error("missing container");
    await docker.stopContainer(first.Id);
    docker.images.clear();

    await expect(service.ensure(rawSpec(f, "a"))).rejects.toMatchObject({
      status: 503,
      code: "image_unavailable",
    });
    expect(docker.creates).toHaveLength(1);
    expect(docker.containers.get(first.Id)?.State?.Running).toBe(false);
  });

  it("launches a digest-pinned default image outside the plain allowlist", async () => {
    const f = fixture();
    const docker = new FakeDocker();
    const pinned = `agent-default@sha256:${"a".repeat(64)}`;
    const service = new RunnerService({
      config: { ...config(f), defaultImage: pinned },
      docker,
    });

    const status = await service.ensure(rawSpec(f, "a", { image: pinned }), "project:a");

    expect(status.state).toBe("running");
    expect(docker.creates[0]?.image).toBe(pinned);
  });

  it("maps Docker StartedAt, RestartCount, ExitCode, OOMKilled, and FinishedAt", async () => {
    const { f, docker, service } = await harness();
    await service.ensure(rawSpec(f, "a"), "project:a");
    const container = [...docker.containers.values()][0];
    if (container === undefined) throw new Error("missing container");
    container.RestartCount = 3;
    container.State = {
      Status: "exited",
      Running: false,
      ExitCode: 137,
      OOMKilled: true,
      StartedAt: "2026-10-27T10:00:00.000Z",
      FinishedAt: "2026-10-27T10:05:00.000Z",
    };

    const status = await service.status("project:a");

    expect(status).toMatchObject({
      state: "error",
      startedAt: "2026-10-27T10:00:00.000Z",
      restartCount: 3,
      exitCode: 137,
      oomKilled: true,
      finishedAt: "2026-10-27T10:05:00.000Z",
    });
  });

  it("defaults unknown RestartCount and OOMKilled to zero and false", async () => {
    const { f, docker, service } = await harness();
    await service.ensure(rawSpec(f, "a"), "project:a");
    const container = [...docker.containers.values()][0];
    if (container === undefined) throw new Error("missing container");
    delete container.RestartCount;
    container.State = { Status: "running", Running: true, ExitCode: 0 };

    const status = await service.status("project:a");

    expect(status).toMatchObject({
      state: "running",
      restartCount: 0,
      exitCode: 0,
      oomKilled: false,
      startedAt: null,
      finishedAt: null,
    });
  });
});
