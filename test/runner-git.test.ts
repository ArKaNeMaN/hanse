import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/load.js";
import type {
  DockerContainerCreateOptions,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerLogs,
  DockerNetworkSpec,
  DockerRuntime,
} from "../src/runner/docker.js";
import { validateGitRequest } from "../src/runner/git.js";
import { appContainerName } from "../src/runner/names.js";
import { RunnerService } from "../src/runner/server.js";
import type { RunnerConfig } from "../src/runner/validate.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function expectConfigError(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return;
  }
  throw new Error("expected ConfigError");
}

interface Fixture {
  base: string;
  workspace: string;
  agents: string;
  gitDir: string;
  appDir: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-runner-git-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const agents = path.join(base, "agents");
  const gitDir = path.join(base, "git");
  const appDir = path.join(workspace, "project", "a");
  for (const dir of [appDir, path.join(agents, "project", "a", "state"), gitDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return { base, workspace, agents, gitDir, appDir };
}

function config(f: Fixture, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    token: "runtime-token",
    hostWorkspace: f.workspace,
    hostAgents: f.agents,
    allowedImages: new Set(["agent-default:test"]),
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
    hostGitDir: f.gitDir,
    gitEnv: { HANSE_GIT_TOKEN: "runner-token", HANSE_GIT_AUTHOR_NAME: "Runner" },
    ...overrides,
  };
}

class FakeDocker implements DockerRuntime {
  readonly containers = new Map<string, DockerContainerInspect>();
  readonly creates: DockerContainerCreateOptions[] = [];
  readonly removed: string[] = [];
  exitCode = 0;
  logOutput = "";
  #next = 1;

  addApp(appId: string, appDir: string, agentsRoot: string, running = true): void {
    const name = appContainerName(appId);
    this.containers.set(name, {
      Id: `app-${this.#next++}`,
      Name: `/${name}`,
      Config: {
        Image: "agent-default:test",
        Labels: {
          "hanse.managed": "true",
          "hanse.app.id": appId,
          "hanse.network.name": `hanse-app-${appId.replace(":", "-")}`,
        },
        Env: ["OPENCODE_SERVER_PASSWORD=app-secret"],
      },
      State: { Status: running ? "running" : "exited", Running: running, ExitCode: 0 },
      HostConfig: {
        Binds: [
          `${appDir}:/data/workspace/project/a:rw`,
          `${agentsRoot}:/data/agents/project/a:rw`,
        ],
      },
    });
  }

  async version(): Promise<string> {
    return "1.44";
  }

  async ensureNetwork(_spec: DockerNetworkSpec): Promise<void> {}

  async removeNetwork(_name: string): Promise<void> {}

  async connectNetwork(_network: string, _container: string, _aliases: string[]): Promise<void> {}

  async disconnectNetwork(_network: string, _container: string): Promise<void> {}

  async createContainer(options: DockerContainerCreateOptions): Promise<string> {
    this.creates.push(options);
    const id = `git-${this.#next++}`;
    this.containers.set(id, {
      Id: id,
      Name: `/${options.name}`,
      Config: {
        Image: options.image,
        Labels: options.labels,
        Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
      },
      State: { Status: "created", Running: false, ExitCode: 0 },
      HostConfig: {
        Binds: options.binds,
        NetworkMode: options.networkMode ?? options.networkName,
      },
    });
    return id;
  }

  async startContainer(id: string): Promise<void> {
    const container = this.containers.get(id);
    if (container === undefined) throw new Error(`unknown container ${id}`);
    container.State = { Status: "running", Running: true, ExitCode: 0 };
  }

  async stopContainer(_id: string): Promise<void> {}

  async removeContainer(id: string): Promise<void> {
    this.removed.push(id);
    this.containers.delete(id);
  }

  async inspectContainer(idOrName: string): Promise<DockerContainerInspect | undefined> {
    const direct = this.containers.get(idOrName);
    if (direct !== undefined) return direct;
    return [...this.containers.values()].find((container) => container.Name === `/${idOrName}`);
  }

  async listContainers(_label?: string): Promise<DockerContainerSummary[]> {
    return [];
  }

  async logs(_id: string): Promise<DockerLogs> {
    return { logs: this.logOutput, truncated: false };
  }

  async waitContainer(_id: string): Promise<{ StatusCode?: number }> {
    return { StatusCode: this.exitCode };
  }
}

function statusPayload(root = "/data/workspace/project/a"): string {
  return JSON.stringify({
    status: {
      state: "ok",
      root,
      branch: { name: "main", detached: false, head: "abc" },
      upstream: null,
      clean: true,
      files: [],
      branches: ["main"],
      remotes: [],
      lastCommit: null,
      operation: null,
      conflicted: false,
      identity: { configured: true },
    },
  });
}

function harness(f: Fixture, options: { running?: boolean } = {}) {
  const docker = new FakeDocker();
  docker.addApp(
    "project:a",
    f.appDir,
    path.join(f.agents, "project", "a"),
    options.running ?? true,
  );
  const service = new RunnerService({ config: config(f), docker });
  return { docker, service };
}

describe("runner git request validation", () => {
  it("accepts the fixed operation set with only their arguments", () => {
    expect(validateGitRequest({ operation: "status" })).toEqual({ operation: "status" });
    expect(validateGitRequest({ operation: "fetch" })).toEqual({ operation: "fetch" });
    expect(validateGitRequest({ operation: "update" })).toEqual({ operation: "update" });
    expect(validateGitRequest({ operation: "push" })).toEqual({ operation: "push" });
    expect(validateGitRequest({ operation: "switch", branch: "feature/agent-runtime" })).toEqual({
      operation: "switch",
      branch: "feature/agent-runtime",
    });
    expect(validateGitRequest({ operation: "commit", message: "  test commit  " })).toEqual({
      operation: "commit",
      message: "test commit",
    });
  });

  it("rejects unknown operations, fields, and misplaced arguments", () => {
    expectConfigError(() => validateGitRequest({ operation: "rm" }));
    expectConfigError(() => validateGitRequest({ operation: "status", branch: "main" }));
    expectConfigError(() => validateGitRequest({ operation: "status", extra: true }));
    expectConfigError(() => validateGitRequest({ operation: "fetch", message: "x" }));
    expectConfigError(() => validateGitRequest({ operation: "switch" }));
    expectConfigError(() => validateGitRequest({ operation: "commit" }));
  });

  it("rejects traversal, option-looking, and malformed branch names", () => {
    for (const branch of ["../main", "-x", "a..b", "a b", "main\0"]) {
      expectConfigError(() => validateGitRequest({ operation: "switch", branch }));
    }
  });

  it("rejects empty and overlong commit messages", () => {
    expectConfigError(() => validateGitRequest({ operation: "commit", message: "   " }));
    expectConfigError(() => validateGitRequest({ operation: "commit", message: "x".repeat(4001) }));
  });
});

describe("RunnerService git one-shot execution", () => {
  it("runs local operations with no network and only app plus read-only git mounts", async () => {
    const f = fixture();
    const { docker, service } = harness(f);
    docker.logOutput = statusPayload();

    const payload = await service.git("project:a", { operation: "status" });

    expect(payload.status).toMatchObject({ state: "ok" });
    expect(payload.status?.root).toBe(f.appDir);
    expect(docker.creates).toHaveLength(1);
    const options = docker.creates[0];
    if (options === undefined) throw new Error("no create recorded");
    expect(options.user).toBe("1000:1000");
    expect(options.networkMode).toBe("none");
    expect(options.restartPolicy).toBe("no");
    expect(options.entrypoint).toEqual(["/usr/local/bin/hanse"]);
    expect(options.cmd).toEqual(["git-op"]);
    expect(options.binds).toEqual([
      `${f.appDir}:/data/workspace/project/a:rw`,
      `${f.gitDir}:/run/hanse/git:ro`,
    ]);
    expect(options.binds.join("\n")).not.toContain("/data/state");
    expect(options.binds.join("\n")).not.toContain("docker.sock");
    expect(options.labels?.["hanse.managed"]).toBeUndefined();
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(options.env.HANSE_RUNTIME_TOKEN).toBeUndefined();
    expect(options.env.HANSE_OPERATOR_TOKEN).toBeUndefined();
    expect(options.env.HANSE_GIT_TOKEN).toBe("runner-token");
    expect(options.env.HANSE_GIT_APP_DIR).toBe("/data/workspace/project/a");
    expect(options.env.HANSE_GIT_OP).toBe("status");
    expect(docker.removed).toHaveLength(1);
  });

  it("uses the app network only for fetch, update, and push", async () => {
    const f = fixture();
    const { docker, service } = harness(f);
    docker.logOutput = JSON.stringify({ result: { status: null, message: "ok" } });

    await service.git("project:a", { operation: "fetch" });
    await service.git("project:a", { operation: "update" });
    await service.git("project:a", { operation: "push" });
    await service.git("project:a", { operation: "switch", branch: "feature" });
    await service.git("project:a", { operation: "commit", message: "test commit" });

    const networks = docker.creates.map((options) => options.networkMode ?? options.networkName);
    expect(networks).toEqual([
      "hanse-app-project-a",
      "hanse-app-project-a",
      "hanse-app-project-a",
      "none",
      "none",
    ]);
  });

  it("rejects unknown, unmanaged, and stopped app containers", async () => {
    const f = fixture();
    const { docker, service } = harness(f, { running: false });

    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      status: 409,
    });

    docker.containers.clear();
    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      status: 404,
    });

    docker.containers.set("/hanse-app-project-a", {
      Id: "manual",
      Name: "/hanse-app-project-a",
      Config: { Labels: { "hanse.app.id": "project:a" } },
      State: { Running: true },
      HostConfig: { Binds: [`${f.appDir}:/data/workspace/project/a:rw`] },
    });
    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("rejects an app container whose workspace bind escapes the host workspace", async () => {
    const f = fixture();
    const outside = mkdtempSync(path.join(tmpdir(), "hanse-runner-git-outside-"));
    dirs.push(outside);
    const { docker, service } = harness(f);
    const container = docker.containers.get(appContainerName("project:a"));
    if (container !== undefined) {
      container.HostConfig = { Binds: [`${outside}:/data/workspace/project/a:rw`] };
    }
    docker.logOutput = statusPayload();

    await expect(service.git("project:a", { operation: "status" })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("surfaces credential failures clearly and removes the one-shot container", async () => {
    const f = fixture();
    const docker = new FakeDocker();
    docker.addApp("project:a", f.appDir, path.join(f.agents, "project", "a"));
    const service = new RunnerService({
      config: config(f, { gitEnv: {} }),
      docker,
    });
    docker.exitCode = 1;
    docker.logOutput = JSON.stringify({
      error: "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
      code: "auth_failed",
    });

    await expect(service.git("project:a", { operation: "fetch" })).rejects.toMatchObject({
      code: "auth_failed",
      status: 502,
      message: expect.stringContaining("Git credentials are not configured"),
    });
    expect(docker.removed).toHaveLength(1);
  });

  it("maps unreadable and oversized sandbox output to git failures", async () => {
    const f = fixture();
    const { docker, service } = harness(f);

    docker.logOutput = "not json";
    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      code: "git_failed",
    });

    docker.logOutput = "x".repeat(4 * 1024 * 1024 + 1);
    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      code: "output_too_large",
    });
  });

  it("keeps the runner git credential env out of the long-lived app container", async () => {
    const f = fixture();
    const { docker, service } = harness(f);
    docker.logOutput = statusPayload();

    await service.git("project:a", { operation: "status" });

    const app = docker.containers.get(appContainerName("project:a"));
    const appEnv = app?.Config?.Env?.join("\n") ?? "";
    expect(appEnv).not.toContain("HANSE_GIT_");
    expect(appEnv).not.toContain("runner-token");
  });
});
