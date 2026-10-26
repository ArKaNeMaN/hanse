import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { handleImages } from "../src/http/images.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type {
  ImageBuildInput,
  RunnerImageInspect,
  RunnerImageRecord,
} from "../src/images/client.js";
import { ImageNotReadyError, type ImageRunnerClient, ImageService } from "../src/images/service.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { discoverProject, registerProject } from "../src/registry/index.js";
import { computeBuildSpecHash, defaultImageReference } from "../src/runtime/build-spec.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { imageStateView } from "./fixtures/image-state.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];
const previousImage = process.env.HANSE_AGENT_IMAGE;
const previousDigest = process.env.HANSE_AGENT_IMAGE_DIGEST;

beforeEach(() => {
  process.env.HANSE_AGENT_IMAGE = "agent-default:test";
  delete process.env.HANSE_AGENT_IMAGE_DIGEST;
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
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (previousImage === undefined) delete process.env.HANSE_AGENT_IMAGE;
  else process.env.HANSE_AGENT_IMAGE = previousImage;
  if (previousDigest === undefined) delete process.env.HANSE_AGENT_IMAGE_DIGEST;
  else process.env.HANSE_AGENT_IMAGE_DIGEST = previousDigest;
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile variable syntax is intentional
const DOCKERFILE = "ARG HANSE_BASE\nFROM ${HANSE_BASE}\nRUN echo web\n";
const APP_YAML = [
  "name: web",
  "kind: service",
  "build:",
  "  dockerfile: Dockerfile",
  "  args:",
  "    NODE_VERSION: '22'",
  "",
].join("\n");

class FakeImageRunner implements ImageRunnerClient {
  readonly inputs: ImageBuildInput[] = [];
  readonly records = new Map<string, RunnerImageRecord>();
  readonly builds = new Map<string, RunnerImageRecord>();
  readonly inspections = new Map<string, RunnerImageInspect>();
  nextBuild = 1;
  buildFailure: Error | undefined;

  async build(
    input: ImageBuildInput,
  ): Promise<{ buildId: string; appId: string; status: "building"; targetRef: string }> {
    if (this.buildFailure !== undefined) {
      throw this.buildFailure;
    }
    this.inputs.push(input);
    const buildId = `build-${this.nextBuild}`;
    this.nextBuild += 1;
    const targetRef = `hanse-app-p:${buildId}`;
    const record: RunnerImageRecord = {
      appId: input.appId,
      status: "building",
      imageRef: this.records.get(input.appId)?.imageRef ?? null,
      imageId: this.records.get(input.appId)?.imageId ?? null,
      buildId,
      logs: "",
      error: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      targetRef,
      specHash: input.specHash ?? null,
      hashVersion: input.hashVersion ?? null,
      baseKind: input.baseKind ?? null,
      baseRef: input.baseImage,
      baseDigest: null,
    };
    this.records.set(input.appId, record);
    this.builds.set(buildId, record);
    return { buildId, appId: input.appId, status: "building", targetRef };
  }

  async inspect(reference: string): Promise<RunnerImageInspect> {
    return (
      this.inspections.get(reference) ?? {
        found: true,
        imageId: null,
        repoDigests: [],
        resolvedDigest: null,
      }
    );
  }

  async get(appId: string): Promise<RunnerImageRecord> {
    return (
      this.records.get(appId) ?? {
        appId,
        status: "missing",
        imageRef: null,
        imageId: null,
        buildId: null,
        logs: "",
        error: null,
        updatedAt: null,
      }
    );
  }

  async getBuild(buildId: string): Promise<RunnerImageRecord | undefined> {
    return this.builds.get(buildId);
  }

  set(appId: string, patch: Partial<RunnerImageRecord>): void {
    const current = this.records.get(appId);
    if (current === undefined) {
      throw new Error("no record to patch");
    }
    const next = { ...current, ...patch };
    this.records.set(appId, next);
    if (next.buildId !== null) {
      this.builds.set(next.buildId, next);
    }
  }
}

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  workspace: string;
  projectRoot: string;
  appDir: string;
  hostWorkspace: string;
  projectId: string;
  appId: string;
  token: string;
  agentToken: string;
  runner: FakeImageRunner;
  service: ImageService;
}

async function fixture(options: { build?: boolean } = {}): Promise<Fixture> {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-app-image-"));
  dirs.push(base);
  const workspacePath = path.join(base, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = realpathSync(workspacePath);
  const projectRoot = path.join(workspace, "project");
  const appDir = path.join(projectRoot, "apps", "web");
  const hostWorkspace = path.join(base, "host-workspace");
  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  mkdirSync(path.join(appDir, ".hanse"), { recursive: true });
  const projectId = randomUUID();
  writeFileSync(
    path.join(projectRoot, ".hanse", "project.yaml"),
    `id: ${projectId}\nname: Alpha\nbase_branch: main\napps:\n  - path: apps/web\n`,
    "utf8",
  );
  if (options.build !== false) {
    writeFileSync(path.join(appDir, ".hanse", "app.yaml"), APP_YAML, "utf8");
    writeFileSync(path.join(appDir, "Dockerfile"), DOCKERFILE, "utf8");
  }

  const db = openDatabase(path.join(base, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const { project, rootPath } = await discoverProject(projectRoot);
  registerProject(db, project, rootPath, workspace);

  const runner = new FakeImageRunner();
  const service = new ImageService({
    db,
    workspaceRoot: workspace,
    hostWorkspace,
    defaultImage: defaultImageReference(),
    runner,
  });
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "agent" }).token;
  const appKey = "web";
  const appId = `${projectId}:${appKey}`;
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    git: new GitService({ workspaceRoot: workspace }),
    images: service,
    getProjects: () => [
      {
        id: projectId,
        name: "Alpha",
        rootPath: projectRoot,
        workspaceRoot: workspace,
        service: new CoordinatorService(db, projectId),
      },
    ],
  };
  return {
    db,
    deps,
    workspace,
    projectRoot,
    appDir,
    hostWorkspace,
    projectId,
    appId,
    token,
    agentToken,
    runner,
    service,
  };
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function buildRequest(f: Fixture, token = f.token): HttpRequest {
  return {
    method: "POST",
    path: "/api/apps/web/build",
    headers: auth(token, { "content-type": "application/json" }),
    query: { project: f.projectId },
    body: "{}",
  };
}

function imageRequest(f: Fixture, token = f.token): HttpRequest {
  return {
    method: "GET",
    path: "/api/apps/web/image",
    headers: auth(token),
    query: { project: f.projectId },
  };
}

function checkRequest(f: Fixture, token = f.token): HttpRequest {
  return {
    method: "POST",
    path: "/api/apps/web/image/check",
    headers: auth(token),
    query: { project: f.projectId },
  };
}

function row(f: Fixture): {
  image_status: string;
  image_ref: string | null;
  image_hash: string | null;
  image_base_digest: string | null;
  image_built_at: string | null;
  image_error: string | null;
} {
  return f.db
    .prepare(
      `SELECT image_status, image_ref, image_hash, image_base_digest, image_built_at, image_error
       FROM apps WHERE id = ?`,
    )
    .get(f.appId) as {
    image_status: string;
    image_ref: string | null;
    image_hash: string | null;
    image_base_digest: string | null;
    image_built_at: string | null;
    image_error: string | null;
  };
}

function markReady(f: Fixture, imageRef = "hanse-app-p:old"): void {
  const current = row(f);
  f.db
    .prepare(
      `UPDATE apps SET image_status = 'ready', image_ref = ?, image_hash = ?,
         image_base_digest = 'sha256:old', image_built_at = '2026-01-01T00:00:00.000Z'
       WHERE id = ?`,
    )
    .run(imageRef, current.image_hash, f.appId);
}

describe("app image API", () => {
  it("is human-only and returns 404 for an unknown app", async () => {
    const f = await fixture();

    const anonymous = await handleImages(f.deps, {
      method: "GET",
      path: "/api/apps/web/image",
      headers: {},
      query: { project: f.projectId },
    });
    expect(anonymous.status).toBe(401);

    const agent = await handleImages(f.deps, imageRequest(f, f.agentToken));
    expect(agent.status).toBe(403);
    expect(agent.body).toContain("forbidden");

    const unknown = await handleImages(f.deps, {
      method: "GET",
      path: "/api/apps/missing/image",
      headers: auth(f.token),
      query: { project: f.projectId },
    });
    expect(unknown.status).toBe(404);
    expect(f.runner.inputs).toHaveLength(0);
  });

  it("delegates the live manifest build spec to the runner and marks the row building", async () => {
    const f = await fixture();
    expect(row(f).image_status).toBe("missing");
    expect(f.runner.inputs).toHaveLength(0);

    const response = await handleImages(f.deps, buildRequest(f));
    expect(response.status).toBe(202);
    const result = JSON.parse(response.body) as {
      buildId: string;
      status: string;
      targetRef: string;
    };
    expect(result).toMatchObject({
      buildId: "build-1",
      status: "building",
      targetRef: "hanse-app-p:build-1",
    });

    expect(f.runner.inputs).toHaveLength(1);
    const input = f.runner.inputs[0] as ImageBuildInput;
    const expectedHash = computeBuildSpecHash({
      dockerfile: DOCKERFILE,
      baseKind: "default",
      buildArgs: { NODE_VERSION: "22" },
    });
    expect(input).toEqual({
      appId: f.appId,
      appDir: path.join(f.hostWorkspace, "project", "apps", "web"),
      dockerfile: "Dockerfile",
      baseImage: "agent-default:test",
      buildArgs: { NODE_VERSION: "22" },
      specHash: expectedHash,
      baseKind: "default",
      hashVersion: 2,
    });
    expect(row(f).image_status).toBe("building");
    expect(row(f).image_error).toBeNull();
  });

  it("persists ready and preserved-error status updates from the runner", async () => {
    const f = await fixture();
    await handleImages(f.deps, buildRequest(f));
    f.runner.set(f.appId, {
      status: "ready",
      imageRef: "hanse-app-p:build-1",
      imageId: "sha256:image-one",
      updatedAt: "2026-02-02T03:04:05.000Z",
    });
    const ready = await handleImages(f.deps, imageRequest(f));
    expect(ready.status).toBe(200);
    const readyView = JSON.parse(ready.body) as Record<string, unknown>;
    expect(readyView).toMatchObject({
      appId: f.appId,
      status: "ready",
      imageRef: "hanse-app-p:build-1",
      imageId: "sha256:image-one",
    });
    expect(row(f)).toMatchObject({
      image_status: "ready",
      image_ref: "hanse-app-p:build-1",
      image_built_at: "2026-02-02T03:04:05.000Z",
      image_error: null,
    });
    const builtHash = row(f).image_hash;

    await handleImages(f.deps, buildRequest(f));
    f.runner.set(f.appId, {
      status: "error",
      error: "docker build failed\nlayer two",
      updatedAt: "2026-02-03T00:00:00.000Z",
    });
    const failed = await handleImages(f.deps, imageRequest(f));
    const failedView = JSON.parse(failed.body) as Record<string, unknown>;
    expect(failedView.status).toBe("error");
    expect(failedView.error).toBe("docker build failed layer two");
    expect(String(failedView.error).length).toBeLessThanOrEqual(400);
    expect(row(f)).toMatchObject({
      image_status: "error",
      image_ref: "hanse-app-p:build-1",
      image_hash: builtHash,
      image_error: "docker build failed layer two",
    });
  });

  it("returns a redacted, bounded log tail", async () => {
    const f = await fixture();
    await handleImages(f.deps, buildRequest(f));
    f.runner.set(f.appId, {
      logs: `step one\nworkspace: ${f.hostWorkspace}/project/apps/web\nAuthorization: Bearer supersecret\n`,
    });

    const response = await handleImages(f.deps, {
      method: "GET",
      path: "/api/apps/web/image/logs",
      headers: auth(f.token),
      query: { project: f.projectId },
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { logs: string; buildId: string };
    expect(body.buildId).toBe("build-1");
    expect(body.logs).toContain("step one");
    expect(body.logs).toContain("<workspace>");
    expect(body.logs).not.toContain(f.hostWorkspace);
    expect(body.logs).not.toContain("supersecret");
  });

  it("serves build and status routes through the HTTP server dispatch", async () => {
    const f = await fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no port");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/apps/web/build?project=${encodeURIComponent(f.projectId)}`,
      {
        method: "POST",
        headers: auth(f.token, { "content-type": "application/json" }),
        body: "{}",
      },
    );
    expect(response.status).toBe(202);
    expect(f.runner.inputs).toHaveLength(1);
  });

  it("renders image component markers, the asset, and does not auto-build", async () => {
    const f = await fixture();
    const page = handleRequest(f.deps, {
      method: "GET",
      path: `/projects/${f.projectId}/apps/web`,
      headers: auth(f.token),
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="image-panel"');
    expect(page.body).toContain('data-status="missing"');
    expect(page.body).toContain('id="image-status"');
    expect(page.body).toContain('id="image-build"');
    expect(page.body).toContain('id="image-logs"');
    expect(page.body).toContain('id="image-refresh"');
    expect(page.body).toContain("/assets/images.js");
    expect(page.body).toContain(
      `action="/api/apps/web/build?project=${encodeURIComponent(f.projectId)}"`,
    );
    expect(f.runner.inputs).toHaveLength(0);

    const asset = handleRequest(f.deps, {
      method: "GET",
      path: "/assets/images.js",
      headers: {},
    });
    expect(asset.status).toBe(200);
    expect(asset.contentType).toContain("text/javascript");
    expect(asset.body).toContain("image-panel");
  });
});

describe("app image stale detection", () => {
  it("marks a ready image stale after a Dockerfile change without building", async () => {
    const f = await fixture();
    markReady(f);
    const before = row(f);
    const imageRef = before.image_ref;
    const builtHash = before.image_hash;

    writeFileSync(path.join(f.appDir, "Dockerfile"), `${DOCKERFILE}RUN true\n`, "utf8");
    const { project, rootPath } = await discoverProject(f.projectRoot);
    const updated = registerProject(f.db, project, rootPath, f.workspace).apps.find(
      (app) => app.appKey === "web",
    );

    expect(updated?.imageStatus).toBe("stale");
    expect(updated?.buildSpecHash).not.toBe(builtHash);
    expect(row(f)).toMatchObject({
      image_status: "stale",
      image_ref: imageRef,
      image_hash: builtHash,
    });
    expect(f.runner.inputs).toHaveLength(0);
  });

  it("does not mark a ready image stale when only the default reference moves", async () => {
    const f = await fixture();
    markReady(f);
    const builtHash = row(f).image_hash;

    process.env.HANSE_AGENT_IMAGE = "agent-default:next";
    const { project, rootPath } = await discoverProject(f.projectRoot);
    const updated = registerProject(f.db, project, rootPath, f.workspace).apps.find(
      (app) => app.appKey === "web",
    );

    // Version 2 excludes the base reference; base drift is compared separately by manifest digest.
    expect(updated?.imageStatus).toBe("ready");
    expect(updated?.buildSpecHash).toBe(builtHash);
    expect(row(f).image_status).toBe("ready");
    expect(f.runner.inputs).toHaveLength(0);
  });
});

describe("app image check", () => {
  it("detects a newly added Dockerfile and enables build controls without a restart", async () => {
    const f = await fixture({ build: false });
    expect(row(f)).toMatchObject({ image_status: "missing", image_ref: null, image_hash: null });

    writeFileSync(path.join(f.appDir, ".hanse", "app.yaml"), APP_YAML, "utf8");
    writeFileSync(path.join(f.appDir, "Dockerfile"), DOCKERFILE, "utf8");

    const response = await handleImages(f.deps, checkRequest(f));
    expect(response.status).toBe(200);
    const result = JSON.parse(response.body) as {
      status: string;
      buildConfigured: boolean;
      notice: string;
    };
    expect(result.status).toBe("missing");
    expect(result.buildConfigured).toBe(true);
    expect(result.notice).toMatch(/build configuration detected/i);
    expect(row(f)).toMatchObject({ image_status: "missing", image_ref: null });
    expect(row(f).image_hash).not.toBeNull();
    expect(f.runner.inputs).toHaveLength(0);

    const page = handleRequest(f.deps, {
      method: "GET",
      path: `/projects/${f.projectId}/apps/web`,
      headers: auth(f.token),
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="image-build"');
    expect(page.body).not.toContain('id="image-check"');
  });

  it("reports the default image when no Dockerfile is configured", async () => {
    const f = await fixture({ build: false });

    const response = await handleImages(f.deps, checkRequest(f));
    expect(response.status).toBe(200);
    const result = JSON.parse(response.body) as {
      status: string;
      buildConfigured: boolean;
      notice: string;
    };
    expect(result.status).toBe("missing");
    expect(result.buildConfigured).toBe(false);
    expect(result.notice).toMatch(/No application image build configured/i);
    expect(row(f)).toMatchObject({ image_status: "missing", image_ref: null, image_hash: null });
  });

  it("marks a ready image stale after a Dockerfile change without a build", async () => {
    const f = await fixture();
    markReady(f);
    const builtHash = row(f).image_hash;
    writeFileSync(path.join(f.appDir, "Dockerfile"), `${DOCKERFILE}RUN true\n`, "utf8");

    const response = await handleImages(f.deps, checkRequest(f));
    expect(response.status).toBe(200);
    const result = JSON.parse(response.body) as {
      status: string;
      buildConfigured: boolean;
      notice: string;
    };
    expect(result.status).toBe("stale");
    expect(result.buildConfigured).toBe(true);
    expect(result.notice).toMatch(/out of date/i);
    expect(row(f)).toMatchObject({
      image_status: "stale",
      image_ref: "hanse-app-p:old",
      image_hash: builtHash,
    });
    expect(f.runner.inputs).toHaveLength(0);
  });

  it("is human-only and refuses while a build is in progress", async () => {
    const f = await fixture({ build: false });

    const agent = await handleImages(f.deps, checkRequest(f, f.agentToken));
    expect(agent.status).toBe(403);

    f.db.prepare("UPDATE apps SET image_status = 'building' WHERE id = ?").run(f.appId);
    const building = await handleImages(f.deps, checkRequest(f));
    expect(building.status).toBe(409);
    expect(building.body).toContain("build_in_progress");
  });

  it("redirects the app-page form to the app with a notice", async () => {
    const f = await fixture({ build: false });
    writeFileSync(path.join(f.appDir, ".hanse", "app.yaml"), APP_YAML, "utf8");
    writeFileSync(path.join(f.appDir, "Dockerfile"), DOCKERFILE, "utf8");

    const response = await handleImages(f.deps, {
      ...checkRequest(f),
      headers: auth(f.token, {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: "",
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain(`/projects/${f.projectId}/apps/web`);
    expect(response.headers?.location).toContain("notice=");
  });

  it("serves the check route through the HTTP server dispatch", async () => {
    const f = await fixture({ build: false });
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("server has no port");
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/apps/web/image/check?project=${encodeURIComponent(f.projectId)}`,
      { method: "POST", headers: auth(f.token) },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as { buildConfigured: boolean };
    expect(result.buildConfigured).toBe(false);
  });
});

describe("app image HTTP view", () => {
  it("exposes every shared-state field with durable and diagnostic build identities separated", async () => {
    const f = await fixture();
    await handleImages(f.deps, buildRequest(f));
    f.runner.set(f.appId, {
      status: "building",
      buildId: "build-9",
      imageId: "sha256:latest-runner",
      imageRef: null,
      targetRef: "hanse-app-p:build-9",
    });

    const response = await handleImages(f.deps, imageRequest(f));
    expect(response.status).toBe(200);
    const view = JSON.parse(response.body) as Record<string, unknown>;
    expect(view).toMatchObject({
      appId: f.appId,
      buildConfigured: true,
      state: "building",
      running: false,
      imageBuildId: "build-1",
      buildId: "build-9",
      latestBuildImageId: "sha256:latest-runner",
      hashVersion: 2,
    });
    for (const key of [
      "usableImageRef",
      "targetImageId",
      "appliedImageId",
      "currentBaseDigest",
      "baseKind",
      "baseRef",
      "baseDigest",
      "baseDrift",
      "hashDrift",
      "blocked",
      "selectedImage",
      "previousImageRef",
      "previousImageBuiltAt",
    ]) {
      expect(view).toHaveProperty(key);
    }
  });

  it("probes a persisted row once before deriving the view and forwards refresh", async () => {
    const f = await fixture();
    const order: string[] = [];
    const originalStatus = f.service.status.bind(f.service);
    const statusSpy = vi.spyOn(f.service, "status").mockImplementation(async (appId, options) => {
      order.push("status");
      return originalStatus(appId, options);
    });
    const probe = vi.fn(async () => {
      order.push("probe");
      return true;
    });
    f.deps.manager = { probeStatus: probe } as unknown as InstanceManager;

    const response = await handleImages(f.deps, {
      ...imageRequest(f),
      query: { project: f.projectId, refresh: "1" },
    });

    expect(response.status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(f.appId);
    expect(order).toEqual(["probe", "status"]);
    expect(statusSpy).toHaveBeenCalledWith(f.appId, { refresh: true });
  });

  it("maps a typed rollback image failure before the rollback-incomplete response", async () => {
    const f = await fixture();
    const view = imageStateView({ appId: f.appId, state: "not_ready" });
    f.deps.manager = {
      rollbackImage: async () => {
        throw new ImageNotReadyError(view);
      },
    } as unknown as InstanceManager;

    const response = await handleImages(f.deps, {
      method: "POST",
      path: "/api/apps/web/image/rollback",
      headers: auth(f.token),
      query: { project: f.projectId },
    });

    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: "image_not_ready",
      code: "image_not_ready",
      message: "application image is not ready (not_ready)",
      appId: f.appId,
      state: "not_ready",
      imageStatus: "missing",
      buildConfigured: true,
    });
  });
});
