import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DockerBuildCacheUsage,
  type DockerBuildPruneOptions,
  type DockerBuildPruneResult,
  type DockerContainerCreateOptions,
  type DockerContainerInspect,
  type DockerContainerSummary,
  DockerError,
  type DockerImageUsage,
  type DockerLogs,
  type DockerNetworkSpec,
  type DockerRuntime,
  type DockerSystemDf,
} from "../src/runner/docker.js";
import {
  DISK_CRITICAL_PERCENT,
  DISK_WARNING_PERCENT,
  ImageGcService,
  usageLevel,
} from "../src/runner/image-gc.js";
import { appContainerName } from "../src/runner/names.js";
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
  images: DockerImageUsage[] = [];
  buildCache: DockerBuildCacheUsage[] = [];
  containers: DockerContainerSummary[] = [];
  removed: string[] = [];
  pruneCalls = 0;
  systemDfFailure: Error | undefined;
  removeFailure: string | undefined;
  readonly removeFailures = new Map<string, Error>();
  removeGate: Promise<void> | undefined;
  onRemove: (() => void) | undefined;

  async version(): Promise<string> {
    return "1.44";
  }

  async systemDf(): Promise<DockerSystemDf> {
    if (this.systemDfFailure !== undefined) throw this.systemDfFailure;
    return { Images: this.images, BuildCache: this.buildCache, LayersSize: 0 };
  }

  async removeImage(referenceOrId: string): Promise<void> {
    this.onRemove?.();
    if (this.removeGate !== undefined) await this.removeGate;
    const failure = this.removeFailures.get(referenceOrId);
    if (failure !== undefined) throw failure;
    if (this.removeFailure === referenceOrId) {
      throw new Error("image is being used by a container");
    }
    this.removed.push(referenceOrId);
  }

  async pruneBuildCache(_options?: DockerBuildPruneOptions): Promise<DockerBuildPruneResult> {
    this.pruneCalls += 1;
    return { SpaceReclaimed: 4096, CachesDeleted: ["cache-1"] };
  }

  async ensureNetwork(_spec: DockerNetworkSpec): Promise<void> {}

  async removeNetwork(_name: string): Promise<void> {}

  async connectNetwork(_network: string, _container: string, _aliases: string[]): Promise<void> {}

  async disconnectNetwork(_network: string, _container: string): Promise<void> {}

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
    return this.containers;
  }

  async logs(_id: string, _tail?: number): Promise<DockerLogs> {
    return { logs: "", truncated: false };
  }

  async waitContainer(_id: string, _timeoutMs?: number): Promise<{ StatusCode?: number }> {
    return { StatusCode: 0 };
  }
}

function usageService(percent: number, docker = new FakeDocker()): ImageGcService {
  const usedBlocks = Math.round((percent / 100) * 1000);
  return new ImageGcService({
    docker,
    diskPath: "/workspace",
    statfs: async () => ({
      blocks: 1000,
      bfree: 1000 - usedBlocks,
      bavail: 1000 - usedBlocks,
      bsize: 1000,
    }),
  });
}

function image(
  id: string,
  tag: string | undefined,
  size: number,
  created: number,
  labels: Record<string, string> | null = { "hanse.app.id": "project:web" },
): DockerImageUsage {
  return {
    Id: id,
    RepoTags: tag === undefined ? [] : [tag],
    Size: size,
    Created: created,
    Labels: labels,
  };
}

function gcService(docker: FakeDocker): ImageGcService {
  return new ImageGcService({ docker, diskPath: "/workspace" });
}

describe("image usage", () => {
  it("maps disk percentage to ok, warning, and critical at the documented thresholds", () => {
    expect(DISK_WARNING_PERCENT).toBe(75);
    expect(DISK_CRITICAL_PERCENT).toBe(85);
    expect(usageLevel(0)).toBe("ok");
    expect(usageLevel(74.9)).toBe("ok");
    expect(usageLevel(75)).toBe("warning");
    expect(usageLevel(84.9)).toBe("warning");
    expect(usageLevel(85)).toBe("critical");
    expect(usageLevel(100)).toBe("critical");
  });

  it("reports host disk and Docker image/build-cache totals", async () => {
    const docker = new FakeDocker();
    docker.images = [image("sha256:one", "a:1", 100, 1), image("sha256:two", "b:1", 200, 2)];
    docker.buildCache = [
      { ID: "c1", Size: 50, InUse: true },
      { ID: "c2", Size: 30, InUse: false },
    ];
    const report = await usageService(85, docker).usage();

    expect(report.level).toBe("critical");
    expect(report.disk).toMatchObject({
      totalBytes: 1_000_000,
      usedBytes: 850_000,
      freeBytes: 150_000,
      usedPercent: 85,
      level: "critical",
    });
    expect(report.docker).toMatchObject({
      imageCount: 2,
      imageBytes: 300,
      buildCacheCount: 2,
      buildCacheBytes: 80,
      buildCacheInUseBytes: 50,
    });
    expect(report.errors).toEqual([]);
  });

  it("keeps disk usage and a safe error when the Docker daemon is unavailable", async () => {
    const docker = new FakeDocker();
    docker.systemDfFailure = new Error(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    );
    const report = await usageService(50, docker).usage();

    expect(report.level).toBe("ok");
    expect(report.disk?.usedPercent).toBe(50);
    expect(report.docker).toBeNull();
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("docker usage unavailable");
    expect(report.errors[0]).not.toContain("runtime-token");
  });

  it("fails closed when Docker cannot be read during gc", async () => {
    const docker = new FakeDocker();
    docker.systemDfFailure = new Error("daemon unavailable");

    await expect(gcService(docker).gc({ protectedRefs: [] })).rejects.toMatchObject({
      status: 502,
      code: "docker_error",
    });
    expect(docker.removed).toEqual([]);
  });
});

describe("image gc", () => {
  it("removes only Hanse app images and protects current, rollback, and running images", async () => {
    const docker = new FakeDocker();
    docker.images = [
      image("sha256:current", "hanse-app-project:web:current", 100, 1),
      image("sha256:rollback", "hanse-app-project:web:rollback", 200, 2),
      image("sha256:running", "hanse-app-project:web:running", 400, 3),
      image("sha256:stale", "hanse-app-project:web:stale", 300, 4),
      image("sha256:label-only", undefined, 50, 5),
      image("sha256:nginx", "nginx:latest", 999, 6, null),
      {
        Id: "sha256:mixed",
        RepoTags: ["hanse-app-project:web:mixed", "other:latest"],
        Size: 70,
        Created: 7,
        Labels: { "hanse.app.id": "project:web" },
      },
    ];
    docker.containers = [
      {
        Id: "container-1",
        Names: ["/hanse-app-project-web"],
        Image: "hanse-app-project:web:running",
        ImageID: "sha256:running",
        State: "running",
        Status: "Up 1 minute",
      },
    ];

    const report = await gcService(docker).gc({
      protectedRefs: ["hanse-app-project:web:current", "hanse-app-project:web:rollback"],
    });

    expect(docker.removed).toEqual(["hanse-app-project:web:stale", "sha256:label-only"]);
    expect(report.removedImageCount).toBe(2);
    expect(report.removedRefs).toEqual(["hanse-app-project:web:stale", "sha256:label-only"]);
    expect(report.estimatedReclaimedBytes).toBe(350);
    expect(report.buildCachePruned).toBe(true);
    expect(report.buildCacheReclaimedBytes).toBe(4096);
    expect(docker.pruneCalls).toBe(1);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { ref: "hanse-app-project:web:current", reason: "protected" },
        { ref: "hanse-app-project:web:rollback", reason: "protected" },
        { ref: "hanse-app-project:web:running", reason: "protected" },
        { ref: "hanse-app-project:web:mixed", reason: "shared_tag" },
      ]),
    );
  });

  it("never removes an image shared with an unrelated tag or an unlabelled image", async () => {
    const docker = new FakeDocker();
    docker.images = [
      image("sha256:managed", "hanse-app-p:web:one", 100, 1),
      {
        Id: "sha256:shared",
        RepoTags: ["hanse-app-p:web:two", "docker.io/library/custom:latest"],
        Size: 200,
        Created: 2,
        Labels: { "hanse.app.id": "p:web" },
      },
      image("sha256:plain", "custom:latest", 300, 3, null),
    ];

    const report = await gcService(docker).gc({});

    expect(docker.removed).toEqual(["hanse-app-p:web:one"]);
    expect(report.skipped).toContainEqual({
      ref: "hanse-app-p:web:two",
      reason: "shared_tag",
    });
  });

  it("serializes gc and rejects a concurrent run with 409", async () => {
    const docker = new FakeDocker();
    docker.images = [image("sha256:stale", "hanse-app-p:web:stale", 100, 1)];
    let release: () => void = () => {};
    docker.removeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const reachedRemoval = new Promise<void>((resolve) => {
      started = resolve;
    });
    docker.onRemove = () => started();
    const service = gcService(docker);

    const first = service.gc({});
    await reachedRemoval;
    await expect(service.gc({})).rejects.toMatchObject({
      status: 409,
      code: "gc_in_progress",
    });
    release();
    const report = await first;
    expect(report.removedImageCount).toBe(1);
  });

  it("stops after the first Docker removal error instead of deleting more images", async () => {
    const docker = new FakeDocker();
    docker.images = [
      image("sha256:one", "hanse-app-p:web:one", 100, 1),
      image("sha256:two", "hanse-app-p:web:two", 100, 2),
      image("sha256:three", "hanse-app-p:web:three", 100, 3),
    ];
    docker.removeFailure = "hanse-app-p:web:two";

    await expect(gcService(docker).gc({})).rejects.toMatchObject({
      status: 502,
      code: "docker_error",
    });
    expect(docker.removed).toEqual(["hanse-app-p:web:one"]);
  });

  it("rejects malformed protected refs without touching Docker", async () => {
    const docker = new FakeDocker();
    await expect(
      gcService(docker).gc({ protectedRefs: ["../../etc/passwd\n"] }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(gcService(docker).gc({ protectedRefs: "not-an-array" })).rejects.toMatchObject({
      status: 400,
      code: "invalid_input",
    });
    expect(docker.removed).toEqual([]);
  });
});

describe("image purge", () => {
  const appId = "project:web";
  const tagPrefix = `${appContainerName(appId)}:`;

  it("removes only exact app-labelled images with only this app's tags", async () => {
    const docker = new FakeDocker();
    const collision = "p:web:api";
    const collisionSibling = "p:web-api";
    expect(appContainerName(collision)).toBe(appContainerName(collisionSibling));
    const tag = `${tagPrefix}one`;
    const collisionTag = `${appContainerName(collision)}:target`;
    const siblingTag = `${appContainerName(collisionSibling)}:sibling`;
    docker.images = [
      image("sha256:target", tag, 100, 1),
      image("sha256:sibling", siblingTag, 200, 2, { "hanse.app.id": collisionSibling }),
      image("sha256:collision", collisionTag, 300, 3, { "hanse.app.id": collision }),
      image("sha256:unlabelled", `${tagPrefix}unlabelled`, 400, 4, null),
      {
        Id: "sha256:shared",
        RepoTags: [`${tagPrefix}shared`, "web:api", "web-api"],
        Size: 500,
        Created: 5,
        Labels: { "hanse.app.id": appId },
      },
    ];

    const report = await gcService(docker).purgeApp(appId);

    expect(docker.removed).toEqual([tag]);
    expect(report.removedRefs).toEqual([tag]);
    expect(report.removedImageCount).toBe(1);
    expect(report.skipped).toContainEqual({
      ref: `${tagPrefix}shared`,
      reason: "shared_tag",
    });

    const collisionReport = await gcService(docker).purgeApp(collision);
    expect(collisionReport.removedRefs).toEqual([collisionTag]);
    expect(docker.removed).not.toContain(siblingTag);
  });

  it("protects images used by any container and removes tagless images by id", async () => {
    const docker = new FakeDocker();
    const usedTag = `${tagPrefix}used`;
    const staleTag = `${tagPrefix}stale`;
    docker.images = [
      image("sha256:used", usedTag, 100, 1),
      image("sha256:stale", staleTag, 200, 2),
      {
        Id: "sha256:tagless",
        RepoTags: [],
        Size: 300,
        Created: 3,
        Labels: { "hanse.app.id": appId },
      },
    ];
    docker.containers = [
      {
        Id: "container-1",
        Names: ["/hanse-app-project-web"],
        Image: usedTag,
        ImageID: "sha256:used",
        State: "running",
        Status: "Up",
      },
    ];

    const report = await gcService(docker).purgeApp(appId);

    expect(docker.removed).toEqual([staleTag, "sha256:tagless"]);
    expect(report.skipped).toContainEqual({ ref: usedTag, reason: "protected" });
    expect(report.removedRefs).toEqual([staleTag, "sha256:tagless"]);
    expect(report.estimatedReclaimedBytes).toBe(500);
  });

  it("treats an in-use removal 409 as a warning and never prunes the build cache", async () => {
    const docker = new FakeDocker();
    const tag = `${tagPrefix}in-use`;
    docker.images = [image("sha256:in-use", tag, 100, 1)];
    docker.buildCache = [{ ID: "c1", Size: 50, InUse: false }];
    docker.removeFailures.set(tag, new DockerError(409, "image is being used by container"));

    const report = await gcService(docker).purgeApp(appId);

    expect(report.removedImageCount).toBe(0);
    expect(report.skipped).toContainEqual({ ref: tag, reason: "protected" });
    expect(report.buildCachePruned).toBe(false);
    expect(report.buildCacheReclaimedBytes).toBe(0);
    expect(docker.pruneCalls).toBe(0);
    expect(docker.removed).toEqual([]);
  });

  it("shares the gc lock with a concurrent global run", async () => {
    const docker = new FakeDocker();
    docker.images = [image("sha256:stale", `${tagPrefix}stale`, 100, 1)];
    let release: () => void = () => {};
    docker.removeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const reachedRemoval = new Promise<void>((resolve) => {
      started = resolve;
    });
    docker.onRemove = () => started();
    const service = gcService(docker);

    const purge = service.purgeApp(appId);
    await reachedRemoval;
    await expect(service.gc({})).rejects.toMatchObject({ status: 409, code: "gc_in_progress" });
    release();
    await expect(purge).resolves.toMatchObject({ removedImageCount: 1 });
  });
});

describe("runner image usage/gc HTTP", () => {
  function fixture(): { workspace: string; docker: FakeDocker; service: RunnerService } {
    const base = mkdtempSync(path.join(tmpdir(), "hanse-image-gc-"));
    dirs.push(base);
    const workspace = path.join(base, "workspace");
    mkdirSync(workspace, { recursive: true });
    const docker = new FakeDocker();
    const config: RunnerConfig = {
      token: "runtime-token",
      hostWorkspace: workspace,
      hostAgents: path.join(base, "agents"),
      allowedImages: new Set(["agent-default:test"]),
      defaultImage: "agent-default:test",
      coordinatorContainer: "hanse",
      dockerSocket: "/var/run/docker.sock",
      dockerApiVersion: "v1.41",
    };
    const imageGc = usageService(50, docker);
    return { workspace, docker, service: new RunnerService({ config, docker, imageGc }) };
  }

  async function listen(service: RunnerService): Promise<string> {
    const server = service.createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no address");
    return `http://127.0.0.1:${address.port}`;
  }

  it("requires the runtime token and serves usage and gc", async () => {
    const f = fixture();
    f.docker.images = [image("sha256:stale", "hanse-app-p:web:stale", 100, 1)];
    const base = await listen(f.service);

    const unauthorized = await fetch(`${base}/v1/images/usage`);
    expect(unauthorized.status).toBe(401);

    const usage = await fetch(`${base}/v1/images/usage`, {
      headers: { authorization: "Bearer runtime-token" },
    });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ level: "ok", disk: { usedPercent: 50 } });

    const gc = await fetch(`${base}/v1/images/gc`, {
      method: "POST",
      headers: {
        authorization: "Bearer runtime-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ protectedRefs: [] }),
    });
    expect(gc.status).toBe(200);
    expect(await gc.json()).toMatchObject({ ok: true, removedImageCount: 1 });
    expect(f.docker.removed).toEqual(["hanse-app-p:web:stale"]);

    const invalid = await fetch(`${base}/v1/images/gc`, {
      method: "POST",
      headers: {
        authorization: "Bearer runtime-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ protectedRefs: ["bad ref"] }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe("image gc in-flight build protection", () => {
  it("unions the runner build-tag provider without changing candidate selection", async () => {
    const docker = new FakeDocker();
    const inflight = "hanse-app-project:web:inflight";
    docker.images = [
      image("sha256:inflight", inflight, 100, 1),
      image("sha256:stale", "hanse-app-project:web:stale", 100, 2),
      image("sha256:base", "ghcr.io/arkaneman/hanse-agent-base:latest", 100, 3, null),
      image("sha256:default", "ghcr.io/arkaneman/hanse-agent-default:latest", 100, 4, null),
    ];
    docker.containers = [
      {
        Id: "container-1",
        Names: ["/hanse-app-project-web"],
        Image: "ghcr.io/arkaneman/hanse-agent-base:latest",
        ImageID: "sha256:base",
        State: "running",
        Status: "Up",
      },
    ];
    const service = new ImageGcService({
      docker,
      diskPath: "/workspace",
      protectedRefs: () => [inflight],
    });

    const report = await service.gc({});

    expect(docker.removed).toEqual(["hanse-app-project:web:stale"]);
    expect(report.removedRefs).toEqual(["hanse-app-project:web:stale"]);
    expect(report.skipped).toContainEqual({ ref: inflight, reason: "protected" });
    expect(report.removedImageIds).not.toContain("sha256:base");
    expect(report.removedImageIds).not.toContain("sha256:default");
  });
});
