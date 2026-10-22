import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeploymentInProgressError, DeploymentLock } from "../src/coordinator/deployment-lock.js";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handleImages } from "../src/http/images.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { ImageBuildInput, RunnerImageRecord } from "../src/images/client.js";
import { RunnerImageClient } from "../src/images/client.js";
import { type ImageRunnerClient, ImageService } from "../src/images/service.js";
import { InstanceManager } from "../src/opencode/manager.js";
import { discoverProject, registerProject } from "../src/registry/index.js";
import type { ImageGcReport, ImageUsageReport } from "../src/runner/image-gc.js";
import { defaultImageReference } from "../src/runtime/build-spec.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";
import { FakeAgentRuntime } from "./fixtures/fake-runtime.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const previousImage = process.env.HANSE_AGENT_IMAGE;
const previousDigest = process.env.HANSE_AGENT_IMAGE_DIGEST;

beforeEach(() => {
  process.env.HANSE_AGENT_IMAGE = "agent-default:test";
  delete process.env.HANSE_AGENT_IMAGE_DIGEST;
});

afterEach(() => {
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

const DOCKERFILE = `ARG HANSE_BASE\nFROM \${HANSE_BASE}\nRUN echo web\n`;
const APP_YAML = "name: web\nkind: service\nbuild:\n  dockerfile: Dockerfile\n";

function emptyGcReport(protectedRefCount: number): ImageGcReport {
  return {
    ok: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 0,
    protectedRefCount,
    removedImageCount: 0,
    removedImageIds: [],
    removedRefs: [],
    estimatedReclaimedBytes: 0,
    buildCachePruned: false,
    buildCacheReclaimedBytes: 0,
    skipped: [],
    truncated: false,
  };
}

class FakeImageRunner implements ImageRunnerClient {
  readonly records = new Map<string, RunnerImageRecord>();
  readonly builds = new Map<string, RunnerImageRecord>();
  readonly purgeCalls: string[] = [];
  gcRefs: string[] | undefined;
  nextBuild = 1;

  async build(
    input: ImageBuildInput,
  ): Promise<{ buildId: string; appId: string; status: "building" }> {
    const buildId = `build-${this.nextBuild}`;
    this.nextBuild += 1;
    const record: RunnerImageRecord = {
      appId: input.appId,
      status: "building",
      imageRef: this.records.get(input.appId)?.imageRef ?? null,
      imageId: this.records.get(input.appId)?.imageId ?? null,
      buildId,
      logs: "",
      error: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    this.records.set(input.appId, record);
    this.builds.set(buildId, record);
    return { buildId, appId: input.appId, status: "building" };
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

  async usage(): Promise<ImageUsageReport> {
    return {
      level: "ok",
      disk: null,
      docker: null,
      errors: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async gc(protectedRefs: string[]): Promise<ImageGcReport> {
    this.gcRefs = protectedRefs;
    return emptyGcReport(protectedRefs.length);
  }

  async purgeApp(appId: string): Promise<ImageGcReport> {
    this.purgeCalls.push(appId);
    return emptyGcReport(0);
  }

  set(appId: string, patch: Partial<RunnerImageRecord>): void {
    const current = this.records.get(appId);
    if (current === undefined) throw new Error("no record to patch");
    const next = { ...current, ...patch };
    this.records.set(appId, next);
    if (next.buildId !== null) this.builds.set(next.buildId, next);
  }
}

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  projectId: string;
  appId: string;
  workspace: string;
  projectRoot: string;
  appDir: string;
  token: string;
  agentToken: string;
  runner: FakeImageRunner;
  service: ImageService;
}

async function fixture(
  options: { deploymentLock?: DeploymentLock; lifecycleActivity?: LifecycleActivity } = {},
): Promise<Fixture> {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-image-lifecycle-"));
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
  writeFileSync(path.join(appDir, ".hanse", "app.yaml"), APP_YAML, "utf8");
  writeFileSync(path.join(appDir, "Dockerfile"), DOCKERFILE, "utf8");

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
    ...(options.deploymentLock === undefined ? {} : { deploymentLock: options.deploymentLock }),
    ...(options.lifecycleActivity === undefined
      ? {}
      : { lifecycleActivity: options.lifecycleActivity }),
  });
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "agent" }).token;
  const appId = `${projectId}:web`;
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
    deploymentLock: options.deploymentLock,
    lifecycleActivity: options.lifecycleActivity,
  };
  return {
    db,
    deps,
    projectId,
    appId,
    workspace,
    projectRoot,
    appDir,
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

function rollbackRequest(f: Fixture, token = f.token): HttpRequest {
  return {
    method: "POST",
    path: "/api/apps/web/image/rollback",
    headers: auth(token, { "content-type": "application/json" }),
    query: { project: f.projectId },
    body: "{}",
  };
}

function imageRef(f: Fixture): string | null {
  return (
    f.db.prepare("SELECT image_ref FROM apps WHERE id = ?").get(f.appId) as {
      image_ref: string | null;
    }
  ).image_ref;
}

function versions(f: Fixture): string[] {
  return (
    f.db
      .prepare(
        "SELECT image_ref FROM app_image_versions WHERE app_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(f.appId) as { image_ref: string }[]
  ).map((row) => row.image_ref);
}

async function readyBuild(f: Fixture, imageRefValue: string, imageId: string, builtAt: string) {
  const build = await handleImages(f.deps, buildRequest(f));
  expect(build.status).toBe(202);
  f.runner.set(f.appId, {
    status: "ready",
    imageRef: imageRefValue,
    imageId,
    updatedAt: builtAt,
  });
  const status = await handleImages(f.deps, imageRequest(f));
  expect(status.status).toBe(200);
  return status;
}

describe("app image lifecycle", () => {
  it("records ready versions and prunes to the current and previous image", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    expect(versions(f)).toEqual(["hanse-app-p:web:one"]);

    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");
    expect(versions(f)).toEqual(["hanse-app-p:web:two", "hanse-app-p:web:one"]);

    await readyBuild(f, "hanse-app-p:web:three", "sha256:three", "2026-01-03T00:00:00.000Z");
    expect(versions(f)).toEqual(["hanse-app-p:web:three", "hanse-app-p:web:two"]);
    expect(imageRef(f)).toBe("hanse-app-p:web:three");
  });

  it("keeps the running image even when it falls outside the two newest versions", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    f.db
      .prepare(
        "INSERT INTO instances (id, app_id, state, image_ref, updated_at) VALUES (?, ?, 'running', ?, ?)",
      )
      .run(f.appId, f.appId, "hanse-app-p:web:one", new Date().toISOString());

    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:three", "sha256:three", "2026-01-03T00:00:00.000Z");
    expect(versions(f)).toEqual([
      "hanse-app-p:web:three",
      "hanse-app-p:web:two",
      "hanse-app-p:web:one",
    ]);

    f.db
      .prepare("UPDATE instances SET state = 'stopped', updated_at = ? WHERE app_id = ?")
      .run(new Date().toISOString(), f.appId);
    await readyBuild(f, "hanse-app-p:web:three", "sha256:three", "2026-01-03T00:00:00.000Z");
    expect(versions(f)).toEqual(["hanse-app-p:web:three", "hanse-app-p:web:two"]);
  });

  it("rolls back between the two retained versions without a status refresh undoing it", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:three", "sha256:three", "2026-01-03T00:00:00.000Z");

    const back = await handleImages(f.deps, rollbackRequest(f));
    expect(back.status).toBe(200);
    const backBody = JSON.parse(back.body) as { imageRef: string; previousImageRef: string };
    expect(backBody.imageRef).toBe("hanse-app-p:web:two");
    expect(backBody.previousImageRef).toBe("hanse-app-p:web:three");
    expect(imageRef(f)).toBe("hanse-app-p:web:two");

    const refreshed = await handleImages(f.deps, imageRequest(f));
    const refreshedBody = JSON.parse(refreshed.body) as {
      imageRef: string;
      previousImageRef: string;
    };
    expect(refreshedBody.imageRef).toBe("hanse-app-p:web:two");
    expect(refreshedBody.previousImageRef).toBe("hanse-app-p:web:three");
    expect(imageRef(f)).toBe("hanse-app-p:web:two");

    const forward = await handleImages(f.deps, rollbackRequest(f));
    expect(forward.status).toBe(200);
    expect((JSON.parse(forward.body) as { imageRef: string }).imageRef).toBe(
      "hanse-app-p:web:three",
    );
    expect(imageRef(f)).toBe("hanse-app-p:web:three");
  });

  it("rejects a non-human rollback without changing the selected image", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");

    const forbidden = await handleImages(f.deps, rollbackRequest(f, f.agentToken));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toContain("forbidden");
    expect(imageRef(f)).toBe("hanse-app-p:web:two");
  });

  it("serves rollback through the HTTP dispatch and restarts a running app", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");
    const row = f.db
      .prepare("SELECT image_status, image_ref FROM apps WHERE id = ?")
      .get(f.appId) as { image_status: "ready" | "stale"; image_ref: string | null };
    mkdirSync(path.join(f.workspace, "agents"), { recursive: true });
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4200");
    const manager = new InstanceManager(f.db, path.join(f.workspace, "agents"), {
      runtime,
      verify: async () => [],
      workspaceRoot: f.workspace,
    });
    await manager.ensure({
      id: f.appId,
      projectId: f.projectId,
      appKey: "web",
      appDir: f.appDir,
      imageStatus: row.image_status,
      imageRef: row.image_ref,
    });

    const server = createHttpServer({ ...f.deps, manager });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server has no port");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/apps/web/image/rollback?project=${encodeURIComponent(f.projectId)}`,
        {
          method: "POST",
          headers: auth(f.token, { "content-type": "application/json" }),
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        imageRef: string;
        restarted: boolean;
      };
      expect(body).toMatchObject({
        imageRef: "hanse-app-p:web:one",
        restarted: true,
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
    expect(runtime.ensured).toHaveLength(2);
    expect(runtime.deleted).toHaveLength(1);
    expect(runtime.ensured[1]?.image).toBe("hanse-app-p:web:one");
  });

  it("preserves the browser form redirect and notice for rollback", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");

    const response = await handleImages(f.deps, {
      method: "POST",
      path: "/api/apps/web/image/rollback",
      headers: auth(f.token, {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      }),
      query: { project: f.projectId },
      body: new URLSearchParams({ project: f.projectId }).toString(),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("notice=Image+rolled+back");
    expect(response.headers?.location).toContain("tone=success");
    expect(imageRef(f)).toBe("hanse-app-p:web:one");
  });

  it("returns 409 restart_in_progress when a rollback restart claim is already held", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");
    const row = f.db
      .prepare("SELECT image_status, image_ref FROM apps WHERE id = ?")
      .get(f.appId) as { image_status: "ready" | "stale"; image_ref: string | null };
    const runtime = new FakeAgentRuntime(() => "http://127.0.0.1:4210");
    const manager = new InstanceManager(f.db, path.join(f.workspace, "agents"), {
      runtime,
      verify: async () => [],
      workspaceRoot: f.workspace,
    });
    const app = {
      id: f.appId,
      projectId: f.projectId,
      appKey: "web",
      appDir: f.appDir,
      imageStatus: row.image_status,
      imageRef: row.image_ref,
    };
    await manager.ensure(app);
    f.deps.manager = manager;

    const claim = manager.beginRestart(app);
    expect(claim.accepted).toBe(true);
    const response = await handleImages(f.deps, rollbackRequest(f));
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: "restart_in_progress" });
    expect(imageRef(f)).toBe("hanse-app-p:web:two");
    await claim.completion;
    expect(manager.isRestarting(f.appId)).toBe(false);
  });

  it("renders the current and rollback references on the application page", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");

    const page = await f.deps.getProjects()[0]?.service.listApps();
    expect(page?.[0]?.imageRef).toBe("hanse-app-p:web:two");
    expect(page?.[0]?.imageRollbackRef).toBe("hanse-app-p:web:one");
  });

  it("sends the durable current, rollback, and running refs to the runner gc", async () => {
    const f = await fixture();
    await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
    await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");
    f.db
      .prepare(
        "INSERT INTO instances (id, app_id, state, image_ref, updated_at) VALUES (?, ?, 'running', ?, ?)",
      )
      .run(f.appId, f.appId, "hanse-app-p:web:running", new Date().toISOString());

    const usage = await handleImages(f.deps, {
      method: "GET",
      path: "/api/images/usage",
      headers: auth(f.token),
    });
    expect(usage.status).toBe(200);
    expect((JSON.parse(usage.body) as { level: string }).level).toBe("ok");

    const gc = await handleImages(f.deps, {
      method: "POST",
      path: "/api/images/gc",
      headers: auth(f.token, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(gc.status).toBe(200);
    expect(f.runner.gcRefs).toEqual([
      "hanse-app-p:web:one",
      "hanse-app-p:web:running",
      "hanse-app-p:web:two",
    ]);

    f.db
      .prepare("UPDATE instances SET state = 'stopped', updated_at = ? WHERE app_id = ?")
      .run(new Date().toISOString(), f.appId);
    const again = await handleImages(f.deps, {
      method: "POST",
      path: "/api/images/gc",
      headers: auth(f.token, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(again.status).toBe(200);
    expect(f.runner.gcRefs).toEqual(["hanse-app-p:web:one", "hanse-app-p:web:two"]);
  });
});

describe("app image deletion coordination", () => {
  function caught(run: () => void): unknown {
    try {
      run();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it("fails reserveDelete in the window between the runner check and a pending build", async () => {
    const f = await fixture();
    const observed = await f.service.assertRunnerIdle(f.appId);

    const building = f.service.build(f.appId);
    expect(caught(() => f.service.reserveDelete(f.appId, observed))).toMatchObject({
      status: 409,
      code: "build_in_progress",
    });
    await expect(f.service.build(f.appId)).rejects.toMatchObject({ code: "build_in_progress" });

    await building;
  });

  it("reconciles a concrete stale build id but never a pending build", async () => {
    const f = await fixture();
    await f.service.build(f.appId);
    f.runner.set(f.appId, { status: "ready", imageRef: "hanse-app-p:web:one" });
    const observed = await f.service.assertRunnerIdle(f.appId);

    f.service.reserveDelete(f.appId, observed);
    await expect(f.service.build(f.appId)).rejects.toMatchObject({
      status: 409,
      code: "deletion_pending",
    });

    f.service.endDelete(f.appId);
    await expect(f.service.build(f.appId)).resolves.toMatchObject({ status: "building" });
  });

  it("refuses a build while the app or its project is marked deleting", async () => {
    const f = await fixture();
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(f.appId);
    await expect(f.service.build(f.appId)).rejects.toMatchObject({
      status: 409,
      code: "deletion_pending",
    });

    f.db.prepare("UPDATE apps SET deleting = 0 WHERE id = ?").run(f.appId);
    f.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(f.projectId);
    await expect(f.service.build(f.appId)).rejects.toMatchObject({
      status: 409,
      code: "deletion_pending",
    });
  });

  it("writes nothing when a delayed status refresh resumes after the app row is gone", async () => {
    const f = await fixture();
    await f.service.build(f.appId);
    f.runner.set(f.appId, {
      status: "ready",
      imageRef: "hanse-app-p:web:one",
      imageId: "sha256:one",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const originalGet = f.runner.get.bind(f.runner);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runner.get = async (appId) => {
      await gate;
      return originalGet(appId);
    };

    const pending = f.service.status(f.appId);
    f.db.prepare("DELETE FROM apps WHERE id = ?").run(f.appId);
    release?.();

    const view = await pending;
    expect(view).toMatchObject({
      appId: f.appId,
      buildId: "build-1",
      runnerAvailable: true,
    });
    expect(versions(f)).toEqual([]);
  });

  it("purges by id after the app row is gone without reading it back", async () => {
    const f = await fixture();
    await f.service.build(f.appId);
    f.db.prepare("DELETE FROM apps WHERE id = ?").run(f.appId);

    const report = await f.service.purgeApp(f.appId);
    expect(f.runner.purgeCalls).toEqual([f.appId]);
    expect(report.ok).toBe(true);
    await expect(f.service.build(f.appId)).rejects.toMatchObject({ status: 404 });
  });

  it("forgetApp clears the in-flight guard for the app", async () => {
    const f = await fixture();
    await f.service.build(f.appId);

    f.service.forgetApp(f.appId);
    await expect(f.service.build(f.appId)).resolves.toMatchObject({ status: "building" });
  });
});

describe("RunnerImageClient purge", () => {
  it("sends DELETE by app id and parses the gc report", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new RunnerImageClient({
      baseUrl: "http://runner:8790/",
      token: "runtime-token",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            ...emptyGcReport(0),
            removedImageCount: 1,
            removedImageIds: ["sha256:one"],
            removedRefs: ["hanse-app-p:web:one"],
          }),
          { status: 200 },
        );
      },
    });

    const report = await client.purgeApp("project:web");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://runner:8790/v1/images/project%3Aweb");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(report).toMatchObject({
      ok: true,
      removedImageCount: 1,
      removedImageIds: ["sha256:one"],
      removedRefs: ["hanse-app-p:web:one"],
    });
  });

  describe("app image deployment lock", () => {
    function writeActiveLock(file: string): void {
      const now = new Date();
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          id: "lock-1",
          phase: "switching",
          startedAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
        "utf8",
      );
    }

    function lockFilePath(): string {
      const dir = mkdtempSync(path.join(tmpdir(), "hanse-image-lock-"));
      dirs.push(dir);
      return path.join(dir, "deploy.lock");
    }

    it("blocks a build before it reaches the runner", async () => {
      const lockPath = lockFilePath();
      const activity = new LifecycleActivity();
      const f = await fixture({
        deploymentLock: new DeploymentLock(lockPath),
        lifecycleActivity: activity,
      });
      writeActiveLock(lockPath);

      await expect(f.service.build(f.appId, "web")).rejects.toBeInstanceOf(
        DeploymentInProgressError,
      );
      expect(f.runner.builds.size).toBe(0);
      const row = f.db.prepare("SELECT image_status FROM apps WHERE id = ?").get(f.appId) as {
        image_status: string;
      };
      expect(row.image_status).toBe("missing");
      expect(activity.count).toBe(0);
    });

    it("returns the shared 409 body for a locked build route", async () => {
      const lockPath = lockFilePath();
      const f = await fixture({ deploymentLock: new DeploymentLock(lockPath) });
      writeActiveLock(lockPath);

      const response = await handleImages(f.deps, buildRequest(f));
      expect(response.status).toBe(409);
      expect(response.headers?.["retry-after"]).toBe("30");
      expect(JSON.parse(response.body)).toEqual({
        error: "deployment_in_progress",
        message: "deployment in progress: switching",
        retryAfter: 30,
      });
      expect(f.runner.builds.size).toBe(0);
    });

    it("blocks a rollback without changing the selected image", async () => {
      const lockPath = lockFilePath();
      const f = await fixture({ deploymentLock: new DeploymentLock(lockPath) });
      await readyBuild(f, "hanse-app-p:web:one", "sha256:one", "2026-01-01T00:00:00.000Z");
      await readyBuild(f, "hanse-app-p:web:two", "sha256:two", "2026-01-02T00:00:00.000Z");
      const before = imageRef(f);
      writeActiveLock(lockPath);

      const response = await handleImages(f.deps, rollbackRequest(f));
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({ error: "deployment_in_progress" });
      expect(imageRef(f)).toBe(before);
    });
  });
});
