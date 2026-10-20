import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handleImages } from "../src/http/images.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { ImageBuildInput, RunnerImageRecord } from "../src/images/client.js";
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

class FakeImageRunner implements ImageRunnerClient {
  readonly records = new Map<string, RunnerImageRecord>();
  readonly builds = new Map<string, RunnerImageRecord>();
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
    return {
      ok: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      protectedRefCount: protectedRefs.length,
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

async function fixture(): Promise<Fixture> {
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
        restartScheduled: boolean;
      };
      expect(body).toMatchObject({
        imageRef: "hanse-app-p:web:one",
        restarted: false,
        restartScheduled: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
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
