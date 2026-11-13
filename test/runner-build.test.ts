import { Buffer } from "node:buffer";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BuildRecordStore,
  MAX_BUILD_RECORD_LOG_BYTES,
  MAX_BUILD_RECORDS,
} from "../src/runner/build-records.js";
import type {
  DockerBuildOptions,
  DockerBuildResult,
  DockerBuildRuntime,
  DockerContainerCreateOptions,
  DockerContainerInspect,
  DockerContainerSummary,
  DockerImageInspect,
  DockerImageUsage,
  DockerLogs,
  DockerNetworkSpec,
  DockerRuntime,
  DockerSystemDf,
} from "../src/runner/docker.js";
import {
  ImageBuildService,
  MAX_BUILD_LOG_BYTES,
  type RunnerImageRecord,
} from "../src/runner/images.js";
import { appContainerName, appNetworkName } from "../src/runner/names.js";
import { RunnerService } from "../src/runner/server.js";
import { RUNNER_APP_PORT, type RunnerConfig } from "../src/runner/validate.js";
import { RECORD_VERSION } from "../src/runner/versions.js";
import { BUILD_SPEC_HASH_VERSION } from "../src/runtime/build-spec.js";

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
  images: DockerImageUsage[] = [];
  readonly inspected = new Map<string, DockerImageInspect>();
  readonly removed: string[] = [];

  async version(): Promise<string> {
    return "1.44";
  }

  async ensureNetwork(_spec: DockerNetworkSpec): Promise<void> {}

  async removeNetwork(_name: string): Promise<void> {}

  async connectNetwork(_network: string, _container: string, _aliases: string[]): Promise<void> {}

  async disconnectNetwork(_network: string, _container: string): Promise<void> {}

  async systemDf(): Promise<DockerSystemDf> {
    return { Images: this.images, BuildCache: [], LayersSize: 0 };
  }

  async removeImage(referenceOrId: string): Promise<void> {
    this.removed.push(referenceOrId);
  }

  async inspectImage(reference: string): Promise<DockerImageInspect | undefined> {
    return this.inspected.get(reference);
  }

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

async function waitForRecord(
  service: ImageBuildService,
  appId: string,
  predicate: (record: RunnerImageRecord) => boolean,
): Promise<RunnerImageRecord> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const record = service.get(appId);
    if (predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for image record");
}

function storedRecord(overrides: Partial<RunnerImageRecord> = {}): RunnerImageRecord {
  return {
    appId: "project:app",
    status: "ready",
    imageRef: null,
    imageId: null,
    buildId: "build-1",
    logs: "",
    error: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    targetRef: null,
    specHash: null,
    specHashVersion: null,
    hashVersion: null,
    baseKind: null,
    baseRef: null,
    baseDigest: null,
    ...overrides,
  };
}

function recordsDir(f: Fixture, name = "records"): string {
  return path.join(f.base, name);
}

describe("ImageBuildService reservations", () => {
  it("reserves the raw app id before any await and reports building", async () => {
    const f = fixture();
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({ config: config(f), build });

    const started = service.start(bodyFor(f));
    const early = service.get("project:app");
    expect(early.status).toBe("building");
    expect(early.buildId).toBeTruthy();
    expect(() => service.forget("project:app")).toThrow(/in progress/);
    expect(() => service.beginDelete("project:app")).toThrow(/in progress/);
    await expect(service.start(bodyFor(f))).rejects.toMatchObject({
      status: 409,
      code: "build_in_progress",
    });

    const accepted = await started;
    expect(accepted.status).toBe("building");
    expect(() => service.forget("project:app")).toThrow(/in progress/);
    await waitForCalls(build, 1);
    build.succeed("sha256:one");
    await waitForRecord(service, "project:app", (record) => record.status === "ready");

    service.forget("project:app");
    expect(service.get("project:app").status).toBe("missing");
    expect(service.getBuild(accepted.buildId)).toBeUndefined();
  });

  it("protects a non-terminal build tag only until the build ends", async () => {
    const f = fixture();
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({ config: config(f), build });

    const started = await service.start(bodyFor(f));
    expect(service.protectedBuildTags()).toEqual([started.targetRef]);
    await waitForCalls(build, 1);
    build.succeed("sha256:done");
    await waitForRecord(service, "project:app", (record) => record.status === "ready");

    expect(service.protectedBuildTags()).toEqual([]);
  });

  it("blocks start while an image purge reservation exists", async () => {
    const f = fixture();
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({ config: config(f), build });

    service.beginDelete("project:app");
    await expect(service.start(bodyFor(f))).rejects.toMatchObject({
      status: 409,
      code: "build_in_progress",
    });
    service.endDelete("project:app");

    const started = service.start(bodyFor(f));
    await waitForCalls(build, 1);
    build.succeed();
    await waitForRecord(service, "project:app", (record) => record.status === "ready");
    await started;
  });

  it("forgets every build record for the app", async () => {
    const f = fixture();
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({ config: config(f), build });

    const first = await service.start(bodyFor(f));
    await waitForCalls(build, 1);
    build.succeed("sha256:first");
    await waitForRecord(service, "project:app", (record) => record.status === "ready");

    const second = await service.start(bodyFor(f));
    await waitForCalls(build, 2);
    build.succeed("sha256:second");
    await waitForRecord(
      service,
      "project:app",
      (record) => record.status === "ready" && record.buildId === second.buildId,
    );

    service.forget("project:app");
    expect(service.getBuild(first.buildId)).toBeUndefined();
    expect(service.getBuild(second.buildId)).toBeUndefined();
  });
});

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
      targetRef: string;
    };
    expect(accepted.appId).toBe("project:app");
    expect(accepted.status).toBe("building");
    expect(accepted.buildId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accepted.targetRef).toBe(`${appContainerName("project:app")}:${accepted.buildId}`);

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
    expect(call.tag).toBe(`${appContainerName("project:app")}:${accepted.buildId}`);
    expect(call.buildArgs).toEqual({
      EXTRA_PACKAGES: "curl jq",
      HANSE_BASE: "agent-default:test",
    });
    expect(call.labels).toEqual({
      "hanse.app.id": "project:app",
      "hanse.image.version": "a".repeat(64),
      "hanse.base.kind": "default",
      "hanse.base.ref": "agent-default:test",
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
    expect(ready.targetRef).toBe(call.tag);
    expect(ready.specHash).toBe("a".repeat(64));
    expect(ready.specHashVersion).toBe(2);
    expect(ready.hashVersion).toBe(2);
    expect(ready.baseKind).toBe("default");
    expect(ready.baseRef).toBe("agent-default:test");
    expect(ready.baseDigest).toBeNull();

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

    const pullDuringBuild = await fetch(`${base}/v1/images/pull`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ reference: "agent-default:test" }),
    });
    expect(pullDuringBuild.status).toBe(409);
    expect(await pullDuringBuild.json()).toMatchObject({ code: "image_mutation_in_progress" });

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

  it("keeps reserved image route names and refuses a purge during a build", async () => {
    const { f, base, build, docker } = await harness();
    const reserved: Array<[string, string]> = [
      ["/v1/images/usage", "GET"],
      ["/v1/images/gc", "POST"],
      ["/v1/images/build", "POST"],
      ["/v1/images/pull", "POST"],
      ["/v1/images/builds/unknown", "GET"],
    ];
    for (const [pathname, allow] of reserved) {
      const response = await fetch(`${base}${pathname}`, {
        method: "DELETE",
        headers: { authorization: "Bearer runtime-token" },
      });
      expect(response.status, pathname).toBe(405);
      expect(response.headers.get("allow"), pathname).toBe(allow);
    }

    await postBuild(base, bodyFor(f));
    await waitForCalls(build, 1);
    const inFlight = await fetch(`${base}/v1/images/project%3Aapp`, {
      method: "DELETE",
      headers: { authorization: "Bearer runtime-token" },
    });
    expect(inFlight.status).toBe(409);
    expect(await inFlight.json()).toMatchObject({ code: "build_in_progress" });
    expect(docker.removed).toEqual([]);

    build.succeed();
    await waitForImage(base, "project:app", (record) => record.status === "ready");
  });

  it("purges one app's images over DELETE and forgets the build record", async () => {
    const { f, base, build, docker } = await harness();
    const accepted = (await (await postBuild(base, bodyFor(f))).json()) as { buildId: string };
    await waitForCalls(build, 1);
    build.succeed("sha256:ready");
    await waitForImage(base, "project:app", (record) => record.status === "ready");

    const tag = `${appContainerName("project:app")}:${accepted.buildId}`;
    docker.images = [
      {
        Id: "sha256:ready",
        RepoTags: [tag],
        Size: 100,
        Created: 1,
        Labels: { "hanse.app.id": "project:app" },
      },
    ];

    const response = await fetch(`${base}/v1/images/project%3Aapp`, {
      method: "DELETE",
      headers: { authorization: "Bearer runtime-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      removedImageCount: 1,
      removedRefs: [tag],
      buildCachePruned: false,
    });
    expect(docker.removed).toEqual([tag]);
    expect(await (await getJson(base, "/v1/images/project%3Aapp")).json()).toMatchObject({
      status: "missing",
    });
    expect((await getJson(base, `/v1/images/builds/${accepted.buildId}`)).status).toBe(404);
  });
});

describe("runner image identity", () => {
  const digestA = `sha256:${"a".repeat(64)}`;
  const digestB = `sha256:${"b".repeat(64)}`;

  it("records the requested base kind, ref, hash version, and the resolved base digest", async () => {
    const { f, base, build, docker } = await harness({
      allowedImages: new Set(["agent-base:test"]),
      baseImage: "agent-base:test",
    });
    docker.inspected.set("agent-base:test", {
      Id: "sha256:base",
      RepoDigests: [`agent-base@${digestA}`],
    });

    const response = await postBuild(
      base,
      bodyFor(f, {
        baseImage: "agent-base:test",
        baseKind: "base",
        specHash: "c".repeat(64),
        hashVersion: 2,
      }),
    );
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { buildId: string; targetRef: string };
    expect(accepted.targetRef).toBe(`${appContainerName("project:app")}:${accepted.buildId}`);

    await waitForCalls(build, 1);
    const call = build.calls[0];
    if (call === undefined) throw new Error("missing build call");
    expect(call.labels).toMatchObject({
      "hanse.base.kind": "base",
      "hanse.base.ref": "agent-base:test",
      "hanse.base.digest": digestA,
      "hanse.image.version": "c".repeat(64),
    });

    build.succeed("sha256:ready");
    const ready = await waitForImage(base, "project:app", (record) => record.status === "ready");
    expect(ready.targetRef).toBe(accepted.targetRef);
    expect(ready.baseKind).toBe("base");
    expect(ready.baseRef).toBe("agent-base:test");
    expect(ready.baseDigest).toBe(digestA);
    expect(ready.specHash).toBe("c".repeat(64));
    expect(ready.specHashVersion).toBe(2);
    expect(ready.hashVersion).toBe(2);
  });

  it("uses an explicit digest without inspecting and nulls an unknown base ref", async () => {
    const pinned = `agent-base@${digestB}`;
    const { f, base, build } = await harness({
      baseImage: "agent-base:test",
      allowedImages: new Set(["agent-default:test", "agent-base:test", pinned]),
    });

    expect(
      (
        await postBuild(
          base,
          bodyFor(f, { baseImage: pinned, baseKind: "base", specHash: "d".repeat(64) }),
        )
      ).status,
    ).toBe(202);
    await waitForCalls(build, 1);
    expect(build.calls[0]?.labels["hanse.base.digest"]).toBe(digestB);
    build.succeed();
    await waitForImage(base, "project:app", (record) => record.status === "ready");

    expect(
      (await postBuild(base, bodyFor(f, { baseKind: "unknown", specHash: "e".repeat(64) }))).status,
    ).toBe(202);
    await waitForCalls(build, 2);
    expect(build.calls[1]?.labels["hanse.base.kind"]).toBe("unknown");
    expect(build.calls[1]?.labels["hanse.base.ref"]).toBeUndefined();
    build.succeed();
    const unknown = await waitForImage(
      base,
      "project:app",
      (record) => record.status === "ready" && record.specHash === "e".repeat(64),
    );
    expect(unknown.baseKind).toBe("unknown");
    expect(unknown.baseRef).toBeNull();
    expect(unknown.baseDigest).toBeNull();
  });

  it("rejects an out-of-allowlist base and a malformed base kind", async () => {
    const { f, base } = await harness();
    expect((await postBuild(base, bodyFor(f, { baseImage: "evil:latest" }))).status).toBe(400);
    expect((await postBuild(base, bodyFor(f, { baseKind: "nope" }))).status).toBe(400);
    expect((await postBuild(base, bodyFor(f, { hashVersion: 4 }))).status).toBe(400);
  });

  it("accepts the current hash version", async () => {
    const { f, base, build } = await harness();
    const response = await postBuild(
      base,
      bodyFor(f, { specHash: "d".repeat(64), hashVersion: BUILD_SPEC_HASH_VERSION }),
    );
    expect(response.status).toBe(202);
    await waitForCalls(build, 1);
    build.succeed("sha256:ready");
    const ready = await waitForImage(base, "project:app", (record) => record.status === "ready");
    expect(ready.hashVersion).toBe(BUILD_SPEC_HASH_VERSION);
  });
});

describe("runner image inspect route", () => {
  const digestA = `sha256:${"1".repeat(64)}`;
  const digestB = `sha256:${"2".repeat(64)}`;

  async function inspect(base: string, query: string, authorized = true): Promise<Response> {
    return fetch(`${base}/v1/images/inspect?${query}`, {
      headers: authorized ? { authorization: "Bearer runtime-token" } : {},
    });
  }

  it("rejects unauthorized, malformed, and disallowed references", async () => {
    const { base } = await harness();

    expect((await inspect(base, "ref=agent-default:test", false)).status).toBe(401);
    expect((await inspect(base, "ref=")).status).toBe(400);
    expect((await inspect(base, "ref=%20%20")).status).toBe(400);
    expect((await inspect(base, "ref=agent-default%3Atest%00")).status).toBe(400);
    expect((await inspect(base, "ref=evil:latest")).status).toBe(403);
    expect(
      (await inspect(base, `ref=${encodeURIComponent("agent-default:test")}&appId=..`)).status,
    ).toBe(400);
  });

  it("returns found false for an allowed image that is absent", async () => {
    const { base } = await harness();

    const response = await inspect(base, "ref=agent-default:test");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      found: false,
      imageId: null,
      repoDigests: [],
      resolvedDigest: null,
    });
  });

  it("resolves an explicit digest, then exactly one matching repository digest", async () => {
    const pinned = `agent-default@${digestA}`;
    const { base, docker } = await harness({ defaultImage: pinned });
    docker.inspected.set(pinned, {
      Id: "sha256:pinned",
      RepoDigests: [`agent-default@${digestB}`],
    });

    const explicit = await inspect(base, `ref=${encodeURIComponent(pinned)}`);
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({
      found: true,
      imageId: "sha256:pinned",
      resolvedDigest: digestA,
    });

    docker.inspected.set("agent-default:test", {
      Id: "sha256:default",
      RepoDigests: [`agent-default@${digestB}`, `other@sha256:${"3".repeat(64)}`],
    });
    const single = await inspect(base, "ref=agent-default:test");
    expect(await single.json()).toMatchObject({
      found: true,
      imageId: "sha256:default",
      resolvedDigest: digestB,
    });

    docker.inspected.set("agent-default:test", {
      Id: "sha256:ambiguous",
      RepoDigests: [`agent-default@${digestA}`, `agent-default@${digestB}`],
    });
    expect(
      (await (await inspect(base, "ref=agent-default:test")).json()).resolvedDigest,
    ).toBeNull();
  });

  it("bounds the digest list and accepts an app-scoped built ref only with its label", async () => {
    const { base, docker } = await harness();
    const built = "hanse-app-project-app:build-1";
    docker.inspected.set(built, {
      Id: "sha256:built",
      RepoDigests: Array.from(
        { length: 20 },
        (_value, index) => `hanse-app-project-app@sha256:${String(index).padStart(64, "0")}`,
      ),
      Config: { Labels: { "hanse.app.id": "project:app", "hanse.image.version": "hash" } },
    });

    const response = await inspect(base, `ref=${encodeURIComponent(built)}&appId=project%3Aapp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      found: boolean;
      imageId: string;
      repoDigests: string[];
      resolvedDigest: string | null;
    };
    expect(body.found).toBe(true);
    expect(body.imageId).toBe("sha256:built");
    expect(body.repoDigests).toHaveLength(16);
    expect(body.resolvedDigest).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(8 * 1024);

    expect((await inspect(base, `ref=${encodeURIComponent(built)}`)).status).toBe(403);
    expect(
      (await inspect(base, `ref=${encodeURIComponent(built)}&appId=project%3Aother`)).status,
    ).toBe(403);
  });
});

describe("runner pinned image ensure", () => {
  const pinned = `sha256:${"a".repeat(64)}`;
  const other = `sha256:${"b".repeat(64)}`;

  class ContainerDocker extends FakeDocker {
    readonly containers = new Map<string, DockerContainerInspect>();
    readonly started: string[] = [];
    readonly removedContainers: string[] = [];
    createErrorAfterContainer: Error | undefined;
    forcedImage: string | undefined;
    #next = 1;

    override async createContainer(options: DockerContainerCreateOptions): Promise<string> {
      this.creates.push(options);
      const id = `container-${this.#next++}`;
      const inspect: DockerContainerInspect = {
        Id: id,
        Name: `/${options.name}`,
        Image: this.forcedImage ?? this.inspected.get(options.image)?.Id ?? options.image,
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
          Init: options.init ?? true,
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

    override async startContainer(id: string): Promise<void> {
      this.started.push(id);
      const container = this.containers.get(id);
      if (container !== undefined) {
        container.State = { Status: "running", Running: true, ExitCode: 0 };
      }
    }

    override async stopContainer(id: string): Promise<void> {
      const container = this.containers.get(id);
      if (container !== undefined) {
        container.State = { Status: "exited", Running: false, ExitCode: 0 };
      }
    }

    override async removeContainer(id: string): Promise<void> {
      this.removedContainers.push(id);
      this.containers.delete(id);
    }

    override async inspectContainer(idOrName: string): Promise<DockerContainerInspect | undefined> {
      const direct = this.containers.get(idOrName);
      if (direct !== undefined) return direct;
      return [...this.containers.values()].find(
        (container) => container.Name === `/${idOrName}` || container.Id === idOrName,
      );
    }

    override async listContainers(label?: string): Promise<DockerContainerSummary[]> {
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
  }

  function ensureBody(
    f: Fixture,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const agentsRoot = path.join(f.agents, "project", "app");
    const stateDir = path.join(agentsRoot, "state");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(path.join(agentsRoot, "home"), { recursive: true });
    writeFileSync(path.join(stateDir, "opencode-password"), "password\n");
    return {
      appId: "project:app",
      image: "agent-default:test",
      pathMode: "host",
      appDir: f.appDir,
      stateDir,
      networkName: appNetworkName("project:app"),
      port: RUNNER_APP_PORT,
      env: {
        HOME: "/data/agents/project/app/home",
        XDG_DATA_HOME: "/data/agents/project/app/data",
        XDG_STATE_HOME: "/data/agents/project/app/state",
        XDG_CONFIG_HOME: "/data/agents/project/app/config",
        XDG_CACHE_HOME: "/data/agents/project/app/cache",
        OPENCODE_DB: "/data/agents/project/app/state/opencode.db",
        TMPDIR: "/data/agents/project/app/tmp",
        MISE_DATA_DIR: "/data/agents/project/app/mise",
        HANSE_OPENCODE_PASSWORD_FILE: "/data/agents/project/app/state/opencode-password",
      },
      resources: { memoryBytes: 1024, nanoCpus: 1, pidsLimit: 128 },
      labels: { "hanse.managed": "true" },
      ...overrides,
    };
  }

  function serviceFor(f: Fixture, docker: ContainerDocker): RunnerService {
    return new RunnerService({ config: config(f), docker });
  }

  it("creates the container from the pinned image ID and verifies it", async () => {
    const f = fixture();
    const docker = new ContainerDocker();
    docker.inspected.set("agent-default:test", { Id: pinned });
    const service = serviceFor(f, docker);

    const status = await service.ensure(ensureBody(f, { expectedImageId: pinned }), "project:app");

    expect(docker.creates).toHaveLength(1);
    expect(docker.creates[0]?.image).toBe(pinned);
    expect(status.imageId).toBe(pinned);
    expect(docker.started).toEqual(["container-1"]);
  });

  it("rejects a reference that no longer resolves to the pinned ID before create", async () => {
    const f = fixture();
    const docker = new ContainerDocker();
    docker.inspected.set("agent-default:test", { Id: other });
    const service = serviceFor(f, docker);

    await expect(
      service.ensure(ensureBody(f, { expectedImageId: pinned }), "project:app"),
    ).rejects.toMatchObject({ status: 409, code: "image_changed" });
    expect(docker.creates).toHaveLength(0);
    expect(docker.started).toEqual([]);
  });

  it("removes a created container whose image ID does not match before start", async () => {
    const f = fixture();
    const docker = new ContainerDocker();
    docker.inspected.set("agent-default:test", { Id: pinned });
    docker.forcedImage = other;
    const service = serviceFor(f, docker);

    await expect(
      service.ensure(ensureBody(f, { expectedImageId: pinned }), "project:app"),
    ).rejects.toMatchObject({ status: 409, code: "image_changed" });
    expect(docker.removedContainers).toEqual(["container-1"]);
    expect(docker.started).toEqual([]);
    expect(docker.containers.size).toBe(0);
  });

  it("reuses a running container only when its image ID matches the pinned ID", async () => {
    const f = fixture();
    const docker = new ContainerDocker();
    docker.inspected.set("agent-default:test", { Id: pinned });
    const service = serviceFor(f, docker);

    await service.ensure(ensureBody(f), "project:app");
    const reused = await service.ensure(ensureBody(f, { expectedImageId: pinned }), "project:app");
    expect(reused.state).toBe("running");
    expect(docker.creates).toHaveLength(1);

    docker.inspected.set("agent-default:test", { Id: other });
    await expect(
      service.ensure(ensureBody(f, { expectedImageId: other }), "project:app"),
    ).rejects.toMatchObject({ status: 409, code: "image_changed" });
    expect(docker.creates).toHaveLength(1);
  });

  it("removes an adopted container whose image ID does not match", async () => {
    const f = fixture();
    const docker = new ContainerDocker();
    docker.inspected.set("agent-default:test", { Id: pinned });
    docker.forcedImage = other;
    docker.createErrorAfterContainer = new Error("create timed out after creating");
    const service = serviceFor(f, docker);

    await expect(
      service.ensure(ensureBody(f, { expectedImageId: pinned }), "project:app"),
    ).rejects.toMatchObject({ status: 409, code: "image_changed" });
    expect(docker.removedContainers).toEqual(["container-1"]);
    expect(docker.started).toEqual([]);
  });

  it("fails closed when image inspection is unavailable and an ID is pinned", async () => {
    const f = fixture();
    const docker = new ContainerDocker();
    (docker as unknown as { inspectImage?: unknown }).inspectImage = undefined;
    const service = serviceFor(f, docker);

    await expect(
      service.ensure(ensureBody(f, { expectedImageId: pinned }), "project:app"),
    ).rejects.toMatchObject({ status: 409, code: "image_changed" });
    expect(docker.creates).toHaveLength(0);
  });
});

describe("runner image gc build protection", () => {
  it("protects the in-flight build target until the build ends", async () => {
    const { f, base, build, docker } = await harness();
    const accepted = (await (await postBuild(base, bodyFor(f))).json()) as {
      buildId: string;
      targetRef: string;
    };
    await waitForCalls(build, 1);
    docker.images = [
      {
        Id: "sha256:target",
        RepoTags: [accepted.targetRef],
        Size: 100,
        Created: 1,
        Labels: { "hanse.app.id": "project:app" },
      },
    ];

    const inFlight = await fetch(`${base}/v1/images/gc`, {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    expect(inFlight.status).toBe(409);
    expect(await inFlight.json()).toMatchObject({ code: "image_mutation_in_progress" });
    expect(docker.removed).toEqual([]);

    build.succeed("sha256:target");
    await waitForImage(base, "project:app", (record) => record.status === "ready");

    const after = await fetch(`${base}/v1/images/gc`, {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      removedImageCount: 1,
      removedRefs: [accepted.targetRef],
    });
    expect(docker.removed).toEqual([accepted.targetRef]);
  });
});

describe("durable build record store", () => {
  it("writes a 0600 record atomically under a 0700 directory", () => {
    const f = fixture();
    const dir = recordsDir(f);
    const store = new BuildRecordStore({ dir });

    store.save(storedRecord({ buildId: "build-atomic", status: "ready" }));

    const file = path.join(dir, "build-atomic.json");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version: number; status: string };
    expect(raw.version).toBe(RECORD_VERSION);
    expect(raw.status).toBe("ready");
  });

  it("does not chmod an existing directory owned by the host user", () => {
    const f = fixture();
    const dir = recordsDir(f);
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const warnings: string[] = [];
    const store = new BuildRecordStore({ dir, warn: (message) => warnings.push(message) });

    store.save(storedRecord({ buildId: "build-existing", status: "ready" }));

    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(warnings.some((message) => message.includes("permissions are broader"))).toBe(true);
    expect(statSync(path.join(dir, "build-existing.json")).mode & 0o777).toBe(0o600);
  });

  it("bounds the persisted log tail to 128 KiB", () => {
    const f = fixture();
    const dir = recordsDir(f);
    const store = new BuildRecordStore({ dir });
    const tail = "LAST-LINES";
    store.save(
      storedRecord({
        buildId: "build-logs",
        updatedAt: new Date().toISOString(),
        logs: `${"A".repeat(MAX_BUILD_RECORD_LOG_BYTES + 4096)}${tail}`,
      }),
    );

    const loaded = new BuildRecordStore({ dir }).load();
    expect(loaded).toHaveLength(1);
    const logs = loaded[0]?.logs ?? "";
    expect(Buffer.byteLength(logs)).toBeLessThanOrEqual(MAX_BUILD_RECORD_LOG_BYTES + 32);
    expect(logs.endsWith(tail)).toBe(true);
    expect(logs.startsWith("[logs truncated]")).toBe(true);
  });

  it("prunes records beyond the count cap", () => {
    const f = fixture();
    const dir = recordsDir(f);
    mkdirSync(dir, { recursive: true });
    const now = Date.parse("2026-11-12T00:00:00.000Z");

    for (let index = 0; index < MAX_BUILD_RECORDS + 5; index += 1) {
      const record = storedRecord({
        buildId: `build-${index}`,
        updatedAt: new Date(now - (MAX_BUILD_RECORDS + 5 - index) * 1000).toISOString(),
      });
      writeFileSync(
        path.join(dir, `build-${index}.json`),
        JSON.stringify({ version: RECORD_VERSION, ...record }),
      );
    }

    const loaded = new BuildRecordStore({ dir, now: () => now }).load();
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    expect(loaded).toHaveLength(MAX_BUILD_RECORDS);
    expect(files).toHaveLength(MAX_BUILD_RECORDS);
    expect(files).toContain("build-204.json");
    expect(files).not.toContain("build-0.json");
  });

  it("prunes records older than seven days on load", () => {
    const f = fixture();
    const dir = recordsDir(f);
    mkdirSync(dir, { recursive: true });
    const now = Date.parse("2026-01-10T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const old = storedRecord({
      buildId: "build-old",
      updatedAt: new Date(now - 8 * day).toISOString(),
    });
    const recent = storedRecord({
      buildId: "build-recent",
      updatedAt: new Date(now - day).toISOString(),
    });
    writeFileSync(
      path.join(dir, "build-old.json"),
      JSON.stringify({ version: RECORD_VERSION, ...old }),
    );
    writeFileSync(
      path.join(dir, "build-recent.json"),
      JSON.stringify({ version: RECORD_VERSION, ...recent }),
    );
    const oldSeconds = (now - 8 * day) / 1000;
    utimesSync(path.join(dir, "build-old.json"), oldSeconds, oldSeconds);

    const loaded = new BuildRecordStore({ dir, now: () => now }).load();
    expect(loaded.map((record) => record.buildId)).toEqual(["build-recent"]);
    expect(readdirSync(dir)).not.toContain("build-old.json");
  });

  it("skips unknown, older, and invalid persisted versions", () => {
    const f = fixture();
    const dir = recordsDir(f);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "build-newer.json"),
      JSON.stringify({ version: RECORD_VERSION + 1, ...storedRecord({ buildId: "build-newer" }) }),
    );
    writeFileSync(
      path.join(dir, "build-older.json"),
      JSON.stringify({ version: 0, ...storedRecord({ buildId: "build-older" }) }),
    );
    writeFileSync(path.join(dir, "build-invalid.json"), "{not json");

    expect(new BuildRecordStore({ dir }).load()).toEqual([]);
  });

  it("turns a persisted building record into interrupted and preserves its logs", () => {
    const f = fixture();
    const dir = recordsDir(f);
    const now = Date.parse("2026-01-10T00:00:00.000Z");
    new BuildRecordStore({ dir, now: () => now }).save(
      storedRecord({
        buildId: "build-restart",
        status: "building",
        logs: "partial build output\n",
        updatedAt: new Date(now - 60_000).toISOString(),
      }),
    );

    const loaded = new BuildRecordStore({ dir, now: () => now }).load();
    expect(loaded[0]).toMatchObject({
      buildId: "build-restart",
      status: "interrupted",
      error: "runner restarted during image build",
      logs: "partial build output\n",
    });
    const persisted = JSON.parse(readFileSync(path.join(dir, "build-restart.json"), "utf8")) as {
      status: string;
    };
    expect(persisted.status).toBe("interrupted");
  });

  it("keeps running when the records path cannot be read or written", () => {
    const f = fixture();
    const filePath = path.join(f.base, "not-a-directory");
    writeFileSync(filePath, "x");
    const warnings: string[] = [];
    const store = new BuildRecordStore({
      dir: filePath,
      warn: (message) => warnings.push(message),
    });

    expect(store.load()).toEqual([]);
    expect(() => store.save(storedRecord())).not.toThrow();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("ImageBuildService durable records", () => {
  it("persists building and then ready", async () => {
    const f = fixture();
    const dir = recordsDir(f);
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({
      config: { ...config(f), buildRecordsDir: dir },
      build,
    });

    const started = await service.start(bodyFor(f));
    await waitForCalls(build, 1);
    const building = JSON.parse(
      readFileSync(path.join(dir, `${started.buildId}.json`), "utf8"),
    ) as { status: string; version: number };
    expect(building.status).toBe("building");
    expect(building.version).toBe(RECORD_VERSION);

    build.succeed("sha256:ready", "done\n");
    await waitForRecord(service, "project:app", (record) => record.status === "ready");
    const loaded = new BuildRecordStore({ dir }).load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      buildId: started.buildId,
      status: "ready",
      imageId: "sha256:ready",
    });
  });

  it("persists a failed build", async () => {
    const f = fixture();
    const dir = recordsDir(f);
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({
      config: { ...config(f), buildRecordsDir: dir },
      build,
    });

    const started = await service.start(bodyFor(f));
    await waitForCalls(build, 1);
    build.fail("cannot install package");
    await waitForRecord(service, "project:app", (record) => record.status === "error");

    const loaded = new BuildRecordStore({ dir }).load();
    expect(loaded[0]).toMatchObject({ buildId: started.buildId, status: "error" });
    expect(loaded[0]?.error).toContain("cannot install package");
  });

  it("cancels the active build, persists cancelled, and keeps leases until it settles", async () => {
    const f = fixture();
    const dir = recordsDir(f);
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({
      config: { ...config(f), buildRecordsDir: dir },
      build,
    });

    const started = await service.start(bodyFor(f));
    await waitForCalls(build, 1);
    const cancelled = service.cancel(started.buildId);

    expect(cancelled).toMatchObject({
      buildId: started.buildId,
      status: "cancelled",
      error: "image build cancelled",
    });
    expect(build.calls[0]?.signal?.aborted).toBe(true);
    await expect(service.start(bodyFor(f))).rejects.toMatchObject({
      status: 409,
      code: "build_in_progress",
    });
    expect(service.getBuild(started.buildId)?.status).toBe("cancelled");
    expect(new BuildRecordStore({ dir }).load()[0]).toMatchObject({
      buildId: started.buildId,
      status: "cancelled",
    });

    build.rejectWith(new Error("docker request aborted"));
    await waitForRecord(service, "project:app", (record) => record.status === "cancelled");
    await expect(service.start(bodyFor(f))).resolves.toMatchObject({ status: "building" });
    await waitForCalls(build, 2);
    build.succeed();
    await waitForRecord(service, "project:app", (record) => record.status === "ready");
  });

  it("rejects cancelling an unknown or already terminal build", async () => {
    const f = fixture();
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({ config: config(f), build });

    try {
      service.cancel("missing-build");
      throw new Error("expected cancel to fail");
    } catch (error) {
      expect(error).toMatchObject({ status: 404, code: "build_not_found" });
    }

    const started = await service.start(bodyFor(f));
    await waitForCalls(build, 1);
    build.succeed();
    await waitForRecord(service, "project:app", (record) => record.status === "ready");
    try {
      service.cancel(started.buildId);
      throw new Error("expected cancel to fail");
    } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "build_not_running" });
    }
  });

  it("hydrates interrupted records into getBuild and get on restart", () => {
    const f = fixture();
    const dir = recordsDir(f);
    new BuildRecordStore({ dir }).save(
      storedRecord({
        buildId: "build-restart",
        status: "building",
        logs: "partial build output\n",
        targetRef: "hanse-app-project-app:build-restart",
        updatedAt: new Date().toISOString(),
      }),
    );

    const service = new ImageBuildService({
      config: { ...config(f), buildRecordsDir: dir },
      build: new FakeBuildRuntime(),
    });

    expect(service.getBuild("build-restart")).toMatchObject({
      buildId: "build-restart",
      status: "interrupted",
      error: "runner restarted during image build",
      logs: "partial build output\n",
    });
    expect(service.get("project:app")).toMatchObject({
      buildId: "build-restart",
      status: "interrupted",
    });
  });

  it("forgets persisted records for an app", async () => {
    const f = fixture();
    const dir = recordsDir(f);
    const build = new FakeBuildRuntime();
    const service = new ImageBuildService({
      config: { ...config(f), buildRecordsDir: dir },
      build,
    });

    await service.start(bodyFor(f));
    await waitForCalls(build, 1);
    build.succeed();
    await waitForRecord(service, "project:app", (record) => record.status === "ready");

    service.forget("project:app");
    expect(new BuildRecordStore({ dir }).load()).toEqual([]);
  });
});

describe("runner image build cancel API", () => {
  it("requires the runtime bearer token and rejects an invalid build id", async () => {
    const { f, base, build } = await harness();
    const accepted = (await (await postBuild(base, bodyFor(f))).json()) as { buildId: string };
    await waitForCalls(build, 1);

    const unauthorized = await fetch(`${base}/v1/images/builds/${accepted.buildId}/cancel`, {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await fetch(`${base}/v1/images/builds/bad_id/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(invalid.status).toBe(400);

    const cancelled = await fetch(`${base}/v1/images/builds/${accepted.buildId}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toEqual({
      buildId: accepted.buildId,
      status: "cancelled",
    });
    expect(build.calls[0]?.signal?.aborted).toBe(true);

    const again = await fetch(`${base}/v1/images/builds/${accepted.buildId}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "build_not_running" });

    const unknown = await fetch(`${base}/v1/images/builds/missing-build/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "build_not_found" });

    build.rejectWith(new Error("docker request aborted"));
  });
});
