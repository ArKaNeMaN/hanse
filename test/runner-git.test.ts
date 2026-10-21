import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
import { appContainerName, appNetworkName } from "../src/runner/names.js";
import { RunnerService, sweepStaleGitTestDirs } from "../src/runner/server.js";
import { RUNNER_APP_PORT, type RunnerConfig } from "../src/runner/validate.js";

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

it("sweeps stale git test credential directories and leaves recent ones", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-git-test-sweep-"));
  dirs.push(root);
  const stale = path.join(root, "git-test-stale");
  const recent = path.join(root, "git-test-recent");
  const other = path.join(root, "not-a-test");
  mkdirSync(stale);
  mkdirSync(recent);
  mkdirSync(other);
  const now = Date.now();
  utimesSync(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
  sweepStaleGitTestDirs(root, now);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(other)).toBe(true);
});

interface Fixture {
  base: string;
  workspace: string;
  agents: string;
  runnerTmp: string;
  appDir: string;
  agentsRoot: string;
  credentialDir: string;
}

function fixture(options: { credentials?: boolean } = {}): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-runner-git-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const agents = path.join(base, "agents");
  const runnerTmp = path.join(base, "runner-tmp");
  const appDir = path.join(workspace, "project", "a");
  const agentsRoot = path.join(agents, "project", "a");
  const credentialDir = path.join(agentsRoot, "home", ".config", "hanse", "git");
  for (const dir of [appDir, path.join(agentsRoot, "state"), credentialDir, runnerTmp]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of ["config", "ssh", "askpass"]) {
    writeFileSync(path.join(credentialDir, file), "managed\n", { mode: 0o600 });
  }
  if (options.credentials !== false) {
    writeFileSync(path.join(credentialDir, "id"), "private-key\n", { mode: 0o600 });
    writeFileSync(path.join(credentialDir, "token"), "token\n", { mode: 0o600 });
  }
  return { base, workspace, agents, runnerTmp, appDir, agentsRoot, credentialDir };
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
    hostRunnerTmp: f.runnerTmp,
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
          "hanse.agents.root": agentsRoot,
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
  docker.addApp("project:a", f.appDir, f.agentsRoot, options.running ?? true);
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
      `${f.credentialDir}:/run/hanse/git/app:ro`,
    ]);
    expect(options.binds.join("\n")).not.toContain("/data/state");
    expect(options.binds.join("\n")).not.toContain("docker.sock");
    expect(options.labels?.["hanse.managed"]).toBeUndefined();
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(options.env.HANSE_RUNTIME_TOKEN).toBeUndefined();
    expect(options.env.HANSE_OPERATOR_TOKEN).toBeUndefined();
    expect(options.env.GIT_CONFIG_GLOBAL).toBe("/run/hanse/git/app/config");
    expect(options.env.GIT_SSH_COMMAND).toBe("'/run/hanse/git/app/ssh'");
    expect(options.env.GIT_ASKPASS).toBe("/run/hanse/git/app/askpass");
    expect(options.env.GIT_ASKPASS_REQUIRE).toBe("force");
    expect(options.env.HANSE_CREDENTIALS_DIR).toBe("/run/hanse/git/app");
    expect(options.env.HANSE_CREDENTIALS_READONLY).toBe("1");
    expect(options.env.HANSE_GIT_APP_DIR).toBe("/data/workspace/project/a");
    expect(options.env.HANSE_GIT_OP).toBe("status");
    const operationKeys = new Set([
      "HANSE_GIT_OP",
      "HANSE_GIT_APP_DIR",
      "HANSE_GIT_BRANCH",
      "HANSE_GIT_MESSAGE",
    ]);
    expect(
      Object.keys(options.env).some(
        (key) => key.startsWith("HANSE_GIT_") && !operationKeys.has(key),
      ),
    ).toBe(false);
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
      code: "not_running",
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
    const f = fixture({ credentials: false });
    const docker = new FakeDocker();
    docker.addApp("project:a", f.appDir, f.agentsRoot);
    const service = new RunnerService({ config: config(f), docker });
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

describe("RunnerService managed git credentials", () => {
  it("rejects a container without the agents-root label as restart_required", async () => {
    const f = fixture();
    const { docker, service } = harness(f);
    const container = docker.containers.get(appContainerName("project:a"));
    if (container?.Config?.Labels !== undefined) {
      delete container.Config.Labels["hanse.agents.root"];
    }
    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      status: 409,
      code: "restart_required",
    });
  });

  it("rejects a missing credential directory as restart_required", async () => {
    const f = fixture();
    const { service } = harness(f);
    rmSync(f.credentialDir, { recursive: true, force: true });
    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      status: 409,
      code: "restart_required",
    });
  });

  it("rejects a symlinked home or managed component", async () => {
    const f = fixture();
    const home = path.join(f.agentsRoot, "home");
    const elsewhere = path.join(f.base, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    rmSync(home, { recursive: true, force: true });
    symlinkSync(elsewhere, home);
    const { service } = harness(f);
    await expect(service.git("project:a", { operation: "status" })).rejects.toMatchObject({
      status: 409,
      code: "restart_required",
    });

    const second = fixture();
    const configDir = path.join(second.agentsRoot, "home", ".config");
    const realConfig = path.join(second.base, "real-config");
    mkdirSync(realConfig, { recursive: true });
    rmSync(configDir, { recursive: true, force: true });
    symlinkSync(realConfig, configDir);
    const secondHarness = harness(second);
    await expect(
      secondHarness.service.git("project:a", { operation: "status" }),
    ).rejects.toMatchObject({ status: 409, code: "restart_required" });
  });

  it("runs Test connection from an ephemeral draft dir and never touches the managed dir", async () => {
    const f = fixture();
    const { docker, service } = harness(f);
    const managedBefore = readdirSync(f.credentialDir).sort();
    docker.logOutput = JSON.stringify({
      test: {
        ok: true,
        kind: "ssh",
        remote: "ssh://git@example.com/repo.git",
        refs: 3,
        head: "abc123",
        warnings: ["No known_hosts was supplied"],
      },
    });

    const result = await service.test("project:a", {
      kind: "ssh",
      remote: "ssh://git@example.com/repo.git",
      ssh: {
        privateKey:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-body\n-----END OPENSSH PRIVATE KEY-----\n",
      },
    });

    expect(result.test).toMatchObject({ ok: true, kind: "ssh", refs: 3, head: "abc123" });
    expect(docker.creates).toHaveLength(1);
    const options = docker.creates[0];
    if (options === undefined) throw new Error("no create recorded");
    const bind = options.binds[1] ?? "";
    expect(bind.startsWith(`${f.runnerTmp}${path.sep}git-test-`)).toBe(true);
    expect(bind.endsWith(":/run/hanse/git/app:ro")).toBe(true);
    expect(bind).not.toContain(f.credentialDir);
    expect(options.binds[0]).toBe(`${f.appDir}:/data/workspace/project/a:ro`);
    expect(options.networkMode).toBe("hanse-app-project-a");
    expect(options.env.HANSE_GIT_OP).toBe("test");
    expect(options.env.HANSE_TEST_KIND).toBe("ssh");
    expect(options.env.HANSE_TEST_REMOTE).toBe("ssh://git@example.com/repo.git");
    expect(options.env.HANSE_CREDENTIALS_DIR).toBe("/run/hanse/git/app");
    expect(
      Object.keys(options.env).some(
        (key) =>
          key.startsWith("HANSE_GIT_") &&
          !["HANSE_GIT_OP", "HANSE_GIT_APP_DIR", "HANSE_GIT_TEST_KIND"].includes(key),
      ),
    ).toBe(false);
    expect(JSON.stringify(options.env)).not.toContain("secret-body");
    expect(docker.removed).toHaveLength(1);
    expect(readdirSync(f.runnerTmp)).toEqual([]);
    expect(readdirSync(f.credentialDir).sort()).toEqual(managedBefore);
  });

  it("omits HANSE_TEST_REMOTE and keeps HTTPS tokens out of the container env", async () => {
    const f = fixture();
    const { docker, service } = harness(f);
    docker.logOutput = JSON.stringify({
      test: {
        ok: true,
        kind: "https",
        remote: "https://github.com/acme/repo.git",
        refs: 1,
        warnings: [],
      },
    });

    await service.test("project:a", {
      kind: "https",
      https: { hosts: ["github.com"], username: "x-access-token", token: "secret-token" },
    });

    const options = docker.creates[0];
    if (options === undefined) throw new Error("no create recorded");
    expect(options.env.HANSE_TEST_KIND).toBe("https");
    expect(options.env.HANSE_TEST_REMOTE).toBeUndefined();
    expect(JSON.stringify(options.env)).not.toContain("secret-token");
  });

  it("serves the Test connection route at /v1/apps/:id/git/test", async () => {
    const f = fixture();
    const { docker, service } = harness(f);
    docker.logOutput = JSON.stringify({
      test: {
        ok: true,
        kind: "https",
        remote: "https://github.com/acme/repo.git",
        refs: 1,
        warnings: [],
      },
    });
    const server = service.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server did not bind to a port");
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/apps/project%3Aa/git/test`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer runtime-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "https",
            https: { hosts: ["github.com"], username: "u", token: "t" },
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        test: { ok: true, kind: "https", refs: 1 },
      });

      const invalid = await fetch(`http://127.0.0.1:${address.port}/v1/apps/project%3Aa/git/test`, {
        method: "POST",
        headers: {
          authorization: "Bearer runtime-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "https" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "invalid_input" });

      const stops = await fetch(`http://127.0.0.1:${address.port}/v1/apps/project%3Aa/git/test`, {
        method: "GET",
        headers: { authorization: "Bearer runtime-token" },
      });
      expect(stops.status).toBe(405);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("labels created app containers with the per-app agents root", async () => {
    const f = fixture();
    const docker = new FakeDocker();
    const service = new RunnerService({ config: config(f), docker });
    const raw = {
      appId: "project:a",
      image: "agent-default:test",
      pathMode: "host",
      appDir: f.appDir,
      stateDir: path.join(f.agentsRoot, "state"),
      networkName: appNetworkName("project:a"),
      port: RUNNER_APP_PORT,
      env: {},
      resources: { memoryBytes: 1024, nanoCpus: 1, pidsLimit: 128 },
      labels: { "hanse.managed": "true" },
    };

    await service.ensure(raw);

    const options = docker.creates[0];
    if (options === undefined) throw new Error("no create recorded");
    expect(options.labels["hanse.agents.root"]).toBe(f.agentsRoot);
  });
});
