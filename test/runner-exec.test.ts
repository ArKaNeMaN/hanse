import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DockerContainerCreateOptions,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerExecCreateOptions,
  DockerExecRuntime,
  DockerExecSize,
  DockerExecStream,
  DockerLogs,
  DockerNetworkSpec,
  DockerRuntime,
} from "../src/runner/docker.js";
import { appContainerName } from "../src/runner/names.js";
import { RunnerService } from "../src/runner/server.js";
import type { RunnerConfig } from "../src/runner/validate.js";
import { requestUpgrade, WsClient } from "./ws-client.js";

const servers: Server[] = [];
const upgrades: Duplex[] = [];

afterEach(async () => {
  for (const socket of upgrades.splice(0)) socket.destroy();
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

function config(): RunnerConfig {
  return {
    token: "runtime-token",
    hostWorkspace: "/tmp/hanse-exec-workspace",
    hostAgents: "/tmp/hanse-exec-agents",
    allowedImages: new Set(["agent-default:test"]),
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
  };
}

class FakeDocker implements DockerRuntime {
  readonly containers = new Map<string, DockerContainerInspect>();
  readonly stopped: string[] = [];
  readonly removed: string[] = [];

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

  async stopContainer(id: string): Promise<void> {
    this.stopped.push(id);
  }

  async removeContainer(id: string, _force?: boolean): Promise<void> {
    this.removed.push(id);
  }

  async inspectContainer(idOrName: string): Promise<DockerContainerInspect | undefined> {
    return this.containers.get(idOrName);
  }

  async listContainers(_label?: string): Promise<DockerContainerSummary[]> {
    return [];
  }

  async logs(_id: string, _tail?: number): Promise<DockerLogs> {
    return { logs: "", truncated: false };
  }

  async waitContainer(_id: string): Promise<{ StatusCode?: number }> {
    return { StatusCode: 0 };
  }
}

class FakeExecStream implements DockerExecStream {
  readonly writes: Buffer[] = [];
  closed = false;
  paused = false;
  #dataListeners: Array<(chunk: Buffer) => void> = [];
  #endListeners: Array<() => void> = [];
  #errorListeners: Array<(error: Error) => void> = [];

  write(chunk: Buffer): boolean {
    this.writes.push(chunk);
    return true;
  }

  close(): void {
    this.closed = true;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.#dataListeners.push(listener);
  }

  onEnd(listener: () => void): void {
    this.#endListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.push(listener);
  }

  emitData(text: string): void {
    for (const listener of this.#dataListeners) listener(Buffer.from(text));
  }

  emitEnd(): void {
    for (const listener of this.#endListeners) listener();
  }

  emitError(error: Error): void {
    for (const listener of this.#errorListeners) listener(error);
  }
}

class FakeExec implements DockerExecRuntime {
  readonly created: Array<{ containerId: string; options: DockerExecCreateOptions }> = [];
  readonly started: string[] = [];
  readonly resizes: Array<{ execId: string; size: DockerExecSize }> = [];
  readonly stream = new FakeExecStream();

  async createExec(containerId: string, options: DockerExecCreateOptions): Promise<string> {
    this.created.push({ containerId, options });
    return "exec-1";
  }

  async startExec(execId: string): Promise<DockerExecStream> {
    this.started.push(execId);
    return this.stream;
  }

  async resizeExec(execId: string, size: DockerExecSize): Promise<void> {
    this.resizes.push({ execId, size });
  }
}

function container(appId: string, running = true): DockerContainerInspect {
  return {
    Id: "container-1",
    Name: `/${appContainerName(appId)}`,
    Config: {
      Labels: { "hanse.managed": "true", "hanse.app.id": appId },
    },
    State: {
      Status: running ? "running" : "exited",
      Running: running,
      ExitCode: running ? 0 : 1,
    },
  };
}

async function harness(): Promise<{
  docker: FakeDocker;
  exec: FakeExec;
  port: number;
  server: Server;
}> {
  const docker = new FakeDocker();
  const exec = new FakeExec();
  const service = new RunnerService({ config: config(), docker, exec });
  const server = service.createServer();
  server.on("upgrade", (_request, socket) => upgrades.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { docker, exec, port: address.port, server };
}

function execPath(appId: string): string {
  return `/v1/apps/${encodeURIComponent(appId)}/exec`;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runner operator terminal exec", () => {
  it("rejects missing and invalid runtime tokens before creating an exec", async () => {
    const { docker, exec, port } = await harness();
    docker.containers.set(appContainerName("project:a"), container("project:a"));

    const missing = await requestUpgrade({ port, path: execPath("project:a") });
    expect(missing.status).toBe(401);
    expect(missing.socket).toBeUndefined();

    const invalid = await requestUpgrade({
      port,
      path: execPath("project:a"),
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(invalid.status).toBe(401);
    expect(exec.created).toHaveLength(0);
  });

  it("rejects invalid, unknown, stopped, and unmanaged app containers", async () => {
    const { docker, exec, port } = await harness();
    const authorization = "Bearer runtime-token";

    const invalid = await requestUpgrade({
      port,
      path: execPath("bad id"),
      headers: { authorization },
    });
    expect(invalid.status).toBe(400);

    const unknown = await requestUpgrade({
      port,
      path: execPath("project:missing"),
      headers: { authorization },
    });
    expect(unknown.status).toBe(404);

    docker.containers.set(appContainerName("project:stopped"), container("project:stopped", false));
    const stopped = await requestUpgrade({
      port,
      path: execPath("project:stopped"),
      headers: { authorization },
    });
    expect(stopped.status).toBe(409);

    const containerName = appContainerName("project:other");
    docker.containers.set(containerName, {
      ...container("project:other"),
      Config: { Labels: { "hanse.managed": "true", "hanse.app.id": "project:different" } },
    });
    const mismatched = await requestUpgrade({
      port,
      path: execPath("project:other"),
      headers: { authorization },
    });
    expect(mismatched.status).toBe(404);
    expect(exec.created).toHaveLength(0);
  });

  it("bridges input, output, resize, and closes only the exec stream", async () => {
    const { docker, exec, port } = await harness();
    const appId = "project:a";
    const inspected = container(appId);
    docker.containers.set(appContainerName(appId), inspected);

    const client = await WsClient.connect({
      port,
      path: execPath(appId),
      headers: { authorization: "Bearer runtime-token" },
    });

    expect(exec.created).toHaveLength(1);
    expect(exec.created[0]?.containerId).toBe("container-1");
    expect(exec.created[0]?.options.cmd[0]).toBe("/bin/sh");
    expect(exec.created[0]?.options.cmd.join(" ")).toContain("exec /bin/bash -l");
    expect(exec.created[0]?.options.env).toEqual({
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
    });
    expect(exec.started).toEqual(["exec-1"]);

    client.send("echo hi\r");
    await waitFor(() => exec.stream.writes.length === 1);
    expect(exec.stream.writes[0]?.toString("utf8")).toBe("echo hi\r");

    client.send(Buffer.from([0, 1, 2]), "binary");
    await waitFor(() => exec.stream.writes.length === 2);
    expect(exec.stream.writes[1]).toEqual(Buffer.from([0, 1, 2]));

    client.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
    await waitFor(() => exec.resizes.length === 1);
    expect(exec.resizes[0]?.size).toEqual({ cols: 100, rows: 40 });
    expect(exec.stream.writes).toHaveLength(2);

    exec.stream.emitData("hello from the shell\r\n");
    const message = await client.nextMessage();
    expect(message.opcode).toBe(0x2);
    expect(message.payload.toString("utf8")).toBe("hello from the shell\r\n");

    client.close();
    await waitFor(() => exec.stream.closed);

    expect(docker.stopped).toEqual([]);
    expect(docker.removed).toEqual([]);
    expect(inspected.State?.Running).toBe(true);
  });

  it("closes the exec when the websocket drops without stopping the app", async () => {
    const { docker, exec, port } = await harness();
    const appId = "project:a";
    const inspected = container(appId);
    docker.containers.set(appContainerName(appId), inspected);

    const client = await WsClient.connect({
      port,
      path: execPath(appId),
      headers: { authorization: "Bearer runtime-token" },
    });
    client.destroy();
    await waitFor(() => exec.stream.closed);
    expect(docker.stopped).toEqual([]);
    expect(inspected.State?.Running).toBe(true);
  });

  it("ends the websocket when the exec stream ends", async () => {
    const { docker, exec, port } = await harness();
    const appId = "project:a";
    docker.containers.set(appContainerName(appId), container(appId));

    const client = await WsClient.connect({
      port,
      path: execPath(appId),
      headers: { authorization: "Bearer runtime-token" },
    });
    exec.stream.emitEnd();
    const closeFrame = await client.nextMessage();
    expect(closeFrame.opcode).toBe(0x8);
    client.destroy();
  });
});
