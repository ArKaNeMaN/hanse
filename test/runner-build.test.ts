import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DockerBuildOptions,
  DockerBuildResult,
  DockerBuildRuntime,
  DockerContainerCreateOptions,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerLogs,
  DockerNetworkSpec,
  DockerRuntime,
} from "../src/runner/docker.js";
import { MAX_BUILD_LOG_BYTES, type RunnerImageRecord } from "../src/runner/images.js";
import { RunnerService } from "../src/runner/server.js";
import type { RunnerConfig } from "../src/runner/validate.js";

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

class FakeDocker implements DockerRuntime {
  readonly creates: DockerContainerCreateOptions[] = [];

  async version(): Promise<string> {
    return "1.44";
  }

  async ensureNetwork(_spec: DockerNetworkSpec): Promise<void> {}

  async removeNetwork(_name: string): Promise<void> {}

  async connectNetwork(_network: string, _container: string, _aliases: string[]): Promise<void> {}

  async disconnectNetwork(_network: string, _container: string): Promise<void> {}

  async createContainer(options: DockerContainerCreateOptions): Promise<string> {
    this.creates.push(options);
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
  reject: (error: unknown) => void;
}

class FakeBuildRuntime implements DockerBuildRuntime {
  readonly calls: DockerBuildOptions[] = [];
  readonly pending: PendingBuild[] = [];

  buildImage(options: DockerBuildOptions): Promise<DockerBuildResult> {
    this.calls.push(options);
    return new Promise<DockerBuildResult>((resolve, reject) => {
      this.pending.push({ options, resolve, reject });
    });
  }

  succeed(imageId = "sha256:built", logs = "Successfully built\n"): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("no pending build");
    next.resolve({ imageId, logs, error: null });
  }

  fail(error: string, logs = ""): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("no pending build");
    next.resolve({ imageId: null, logs, error });
  }

  rejectWith(error: unknown): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("no pending build");
    next.reject(error);
  }
}

interface Fixture {
  base: string;
  workspace: string;
  agents: string;
  appDir: string;
}

function makeApp(f: Fixture, appKey = "app"): string {
  const appDir = path.join(f.workspace, "project", appKey);
  mkdirSync(path.join(appDir, ".hanse"), { recursive: true });
  mkdirSync(path.join(appDir, "src"), { recursive: true });
  writeFileSync(
    path.join(appDir, ".hanse", "Dockerfile"),
    `ARG HANSE_BASE\nFROM \${HANSE_BASE}\nRUN echo app\n`,
  );
  writeFileSync(path.join(appDir, "Dockerfile"), `FROM \${HANSE_BASE}\nCOPY . /app\n`);
  writeFileSync(path.join(appDir, "src", "index.js"), "console.log('app');\n");
  mkdirSync(path.join(appDir, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(appDir, "node_modules", "dep", "index.js"), "SHOULD_NOT_APPEAR\n");
  mkdirSync(path.join(appDir, "state"), { recursive: true });
  writeFileSync(path.join(appDir, "state", "opencode.db"), "SHOULD_NOT_APPEAR\n");
  mkdirSync(path.join(appDir, ".git"), { recursive: true });
  writeFileSync(path.join(appDir, ".git", "config"), "SHOULD_NOT_APPEAR\n");
  return appDir;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-runner-build-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const agents = path.join(base, "agents");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(agents, { recursive: true });
  const f: Fixture = { base, workspace, agents, appDir: "" };
  f.appDir = makeApp(f);
  return f;
}

function config(f: Fixture): RunnerConfig {
  return {
    token: "runtime-token",
    hostWorkspace: f.workspace,
    hostAgents: f.agents,
    allowedImages: new Set(["agent-default:test"]),
    defaultImage: "agent-default:test",
    coordinatorContainer: "hanse",
    dockerSocket: "/var/run/docker.sock",
    dockerApiVersion: "v1.41",
  };
}

function bodyFor(f: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: "project:app",
    appDir: f.appDir,
    baseImage: "agent-default:test",
    ...overrides,
  };
}

async function harness(overrides: Partial<RunnerConfig> = {}): Promise<{
  f: Fixture;
  docker: FakeDocker;
  build: FakeBuildRuntime;
  service: RunnerService;
  base: string;
}> {
  const f = fixture();
  const docker = new FakeDocker();
  const build = new FakeBuildRuntime();
  const service = new RunnerService({ config: { ...config(f), ...overrides }, docker, build });
  const server = service.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { f, docker, build, service, base: `http://127.0.0.1:${address.port}` };
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer runtime-token", "content-type": "application/json" };
}

async function postBuild(
  base: string,
  body: Record<string, unknown>,
  authorized = true,
): Promise<Response> {
  return fetch(`${base}/v1/images/build`, {
    method: "POST",
    headers: authorized ? authHeaders() : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(base: string, pathname: string, authorized = true): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    headers: authorized ? { authorization: "Bearer runtime-token" } : {},
  });
}

async function waitForImage(
  base: string,
  appId: string,
  predicate: (record: RunnerImageRecord) => boolean,
): Promise<RunnerImageRecord> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const response = await getJson(base, `/v1/images/${encodeURIComponent(appId)}`);
    expect(response.status).toBe(200);
    const record = (await response.json()) as RunnerImageRecord;
    if (predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for image record");
}

async function waitForCalls(build: FakeBuildRuntime, count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (build.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${count} build call(s)`);
}

describe("runner image build API", () => {
  it("requires the runtime bearer token", async () => {
    const { f, base, build } = await harness();

    expect((await postBuild(base, bodyFor(f), false)).status).toBe(401);
    expect((await getJson(base, "/v1/images/project%3Aapp", false)).status).toBe(401);
    expect(build.calls).toHaveLength(0);
  });

  it("validates appId, appDir containment, base image, dockerfile, build args, spec hash", async () => {
    const { f, base, build } = await harness();
    const outside = path.join(f.base, "outside");
    mkdirSync(outside, { recursive: true });

    const invalid: Record<string, unknown>[] = [
      { appId: ".." },
      { appDir: "relative/app" },
      { appDir: outside },
      { baseImage: "evil:latest" },
      { dockerfile: "../Dockerfile" },
      { dockerfile: "/etc/passwd" },
      { buildArgs: { HANSE_BASE: "evil:latest" } },
      { buildArgs: { "BAD KEY": "x" } },
      { buildArgs: { SAFE: "line\nbreak" } },
      { buildArgs: { SAFE: 1 } },
      { specHash: "abc" },
      { privileged: true },
    ];
    for (const override of invalid) {
      const response = await postBuild(base, bodyFor(f, override));
      expect(response.status, JSON.stringify(override)).toBe(400);
    }

    expect(build.calls).toHaveLength(0);
    const record = (await (
      await getJson(base, "/v1/images/project%3Aapp")
    ).json()) as RunnerImageRecord;
    expect(record.status).toBe("missing");
  });

  it("accepts the configured default agent image when it is not in the allowlist", async () => {
    const { f, base, build } = await harness({ allowedImages: new Set(["other:1"]) });

    const response = await postBuild(base, bodyFor(f));

    expect(response.status).toBe(202);
    await waitForCalls(build, 1);
    expect(build.calls[0]?.baseImage).toBe("agent-default:test");
    build.succeed();
    await waitForImage(base, "project:app", (record) => record.status === "ready");
  });

  it("rejects a symlink in the build context without starting a build", async () => {
    const { f, base, build } = await harness();
    symlinkSync("/etc/passwd", path.join(f.appDir, "leak"));

    const response = await postBuild(base, bodyFor(f));

    expect(response.status).toBe(400);
    expect(build.calls).toHaveLength(0);
  });

  it("returns 202 and reports building, then ready with labels, args, and bounded limits", async () => {
    const { f, base, build } = await harness();
    const response = await postBuild(
      base,
      bodyFor(f, { buildArgs: { EXTRA_PACKAGES: "curl jq" }, specHash: "a".repeat(64) }),
    );

    expect(response.status).toBe(202);
    const accepted = (await response.json()) as {
      buildId: string;
      appId: string;
      status: string;
    };
    expect(accepted.appId).toBe("project:app");
    expect(accepted.status).toBe("building");
    expect(accepted.buildId).toMatch(/^[0-9a-f-]{36}$/);

    const building = await waitForImage(
      base,
      "project:app",
      (record) => record.status === "building",
    );
    expect(building.buildId).toBe(accepted.buildId);
    expect(building.logs).toBe("");

    await waitForCalls(build, 1);
    const call = build.calls[0];
    if (call === undefined) throw new Error("missing build call");
    expect(call.dockerfile).toBe(".hanse/Dockerfile");
    expect(call.baseImage).toBe("agent-default:test");
    expect(call.tag).toBe(`hanse-app-project-app:${accepted.buildId}`);
    expect(call.buildArgs).toEqual({
      EXTRA_PACKAGES: "curl jq",
      HANSE_BASE: "agent-default:test",
    });
    expect(call.labels).toEqual({
      "hanse.app.id": "project:app",
      "hanse.image.version": "a".repeat(64),
      "hanse.base.digest": "agent-default:test",
      "hanse.default.digest": "agent-default:test",
    });
    expect(call.memoryBytes).toBeGreaterThan(0);
    expect(call.nanoCpus).toBeGreaterThan(0);
    expect(call.pidsLimit).toBeGreaterThan(0);

    const tarText = call.tar.toString("utf8");
    expect(tarText).toContain(".hanse/Dockerfile");
    expect(tarText).toContain("src/index.js");
    expect(tarText).not.toContain("SHOULD_NOT_APPEAR");
    const serialized = JSON.stringify(call);
    expect(serialized).not.toContain("/data/state");
    expect(serialized).not.toContain("docker.sock");
    expect(serialized).not.toContain("privileged");

    build.succeed("sha256:ready", "Step 1/2\nSuccessfully built\n");
    const ready = await waitForImage(base, "project:app", (record) => record.status === "ready");
    expect(ready.imageRef).toBe(call.tag);
    expect(ready.imageId).toBe("sha256:ready");
    expect(ready.error).toBeNull();
    expect(ready.logs).toContain("Successfully built");

    const byBuild = await getJson(base, `/v1/images/builds/${accepted.buildId}`);
    expect(byBuild.status).toBe(200);
    expect(await byBuild.json()).toMatchObject({
      appId: "project:app",
      buildId: accepted.buildId,
      status: "ready",
    });
    expect((await getJson(base, "/v1/images/builds/unknown-build")).status).toBe(404);
  });

  it("keeps the previous image record and true logs when a rebuild fails", async () => {
    const { f, base, build, docker } = await harness();

    await postBuild(base, bodyFor(f));
    await waitForCalls(build, 1);
    build.succeed("sha256:first", "first build\n");
    const first = await waitForImage(base, "project:app", (record) => record.status === "ready");

    const tail = "TAIL";
    const longLogs = `${"A".repeat(MAX_BUILD_LOG_BYTES + 100)}${tail}`;
    await postBuild(base, bodyFor(f, { buildArgs: { RETRY: "1" } }));
    await waitForCalls(build, 2);
    build.fail("cannot install package", longLogs);
    const failed = await waitForImage(base, "project:app", (record) => record.status === "error");

    expect(failed.error).toContain("cannot install package");
    expect(failed.imageRef).toBe(first.imageRef);
    expect(failed.imageId).toBe("sha256:first");
    expect(failed.buildId).not.toBe(first.buildId);
    expect(Buffer.byteLength(failed.logs)).toBeLessThanOrEqual(MAX_BUILD_LOG_BYTES + 20);
    expect(failed.logs.endsWith(tail)).toBe(true);
    expect(docker.creates).toHaveLength(0);
  });

  it("allows one build at a time and rejects a concurrent request with build_in_progress", async () => {
    const { f, base, build } = await harness();
    mkdirSync(path.join(f.workspace, "project", "other", ".hanse"), { recursive: true });
    writeFileSync(
      path.join(f.workspace, "project", "other", ".hanse", "Dockerfile"),
      `FROM \${HANSE_BASE}\n`,
    );

    expect((await postBuild(base, bodyFor(f))).status).toBe(202);
    const concurrent = await postBuild(
      base,
      bodyFor(f, { appId: "project:other", appDir: path.join(f.workspace, "project", "other") }),
    );
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toMatchObject({ code: "build_in_progress" });

    const sameApp = await postBuild(base, bodyFor(f));
    expect(sameApp.status).toBe(409);

    await waitForCalls(build, 1);
    build.succeed();
    await waitForImage(base, "project:app", (record) => record.status === "ready");

    const next = await postBuild(
      base,
      bodyFor(f, { appId: "project:other", appDir: path.join(f.workspace, "project", "other") }),
    );
    expect(next.status).toBe(202);
  });

  it("records a rejected build runtime as an error without touching containers", async () => {
    const { f, base, build, docker } = await harness();

    await postBuild(base, bodyFor(f));
    await waitForCalls(build, 1);
    build.rejectWith(new Error("docker socket exploded"));
    const failed = await waitForImage(base, "project:app", (record) => record.status === "error");

    expect(failed.error).toContain("docker socket exploded");
    expect(docker.creates).toHaveLength(0);
  });
});
