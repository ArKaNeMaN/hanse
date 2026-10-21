import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DeletionImages,
  type DeletionManager,
  DeletionService,
} from "../src/coordinator/deletion.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleDeletion, isDeletionRoute } from "../src/http/deletion.js";
import {
  type HttpDeps,
  type HttpRequest,
  type HttpResponse,
  handleRequest,
} from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { RunnerImageRecord } from "../src/images/client.js";
import { ImageServiceError } from "../src/images/service.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import type { ImageGcReport } from "../src/runner/image-gc.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_NAME = "Demo Project";
const APP_KEY = "web";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

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
});

function gcReport(overrides: Partial<ImageGcReport> = {}): ImageGcReport {
  return {
    ok: true,
    startedAt: "",
    finishedAt: "",
    durationMs: 0,
    protectedRefCount: 0,
    removedImageCount: 0,
    removedImageIds: [],
    removedRefs: [],
    estimatedReclaimedBytes: 0,
    buildCachePruned: false,
    buildCacheReclaimedBytes: 0,
    skipped: [],
    truncated: false,
    ...overrides,
  };
}

const EMPTY_RECORD: RunnerImageRecord = {
  appId: "",
  status: "missing",
  imageRef: null,
  imageId: null,
  buildId: null,
  logs: "",
  error: null,
  updatedAt: null,
};

class FakeManager implements DeletionManager {
  failOn: string | undefined;

  constructor(private readonly db: SqliteDatabase) {}

  async stopForDeletion(appId: string): Promise<boolean> {
    if (this.failOn === appId) {
      throw new Error("runtime unavailable");
    }
    this.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(appId);
    return true;
  }
}

class FakeImages implements DeletionImages {
  failAssertOn: string | undefined;
  report: ImageGcReport | undefined;

  async assertRunnerIdle(appId: string): Promise<RunnerImageRecord> {
    if (this.failAssertOn === appId) {
      throw new ImageServiceError(409, "an image build is running", "build_in_progress");
    }
    return { ...EMPTY_RECORD, appId };
  }

  reserveDelete(): void {}

  endDelete(): void {}

  async purgeApp(): Promise<ImageGcReport> {
    return this.report ?? gcReport();
  }

  forgetApp(): void {}
}

interface Fixture {
  base: string;
  workspace: string;
  projectRoot: string;
  agents: string;
  coordinator: string;
  db: SqliteDatabase;
  manager: FakeManager;
  images: FakeImages;
  service: DeletionService;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-deletion-http-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const projectRoot = path.join(workspace, "project");
  const agents = path.join(base, "agents");
  const coordinator = path.join(base, "state", "hanse");
  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  mkdirSync(path.join(projectRoot, "apps", APP_KEY), { recursive: true });
  mkdirSync(agents, { recursive: true });
  mkdirSync(coordinator, { recursive: true });
  writeFileSync(
    path.join(projectRoot, ".hanse", "project.yaml"),
    `id: ${PROJECT_ID}\nname: ${PROJECT_NAME}\nbase_branch: main\napps:\n  - path: apps/${APP_KEY}\n`,
    "utf8",
  );
  mkdirSync(path.join(agents, PROJECT_ID, APP_KEY), { recursive: true });

  const db = openDatabase(path.join(base, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  ).run(PROJECT_ID, PROJECT_NAME, "main", projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES (?,?,?,?,?,?)",
  ).run(`${PROJECT_ID}:${APP_KEY}`, PROJECT_ID, APP_KEY, `apps/${APP_KEY}`, "AGENTS.md", now);

  const manager = new FakeManager(db);
  const images = new FakeImages();
  const service = new DeletionService({
    db,
    workspaceRoot: workspace,
    agentsHome: agents,
    coordinatorStateDir: coordinator,
    manager,
    images,
  });
  return { base, workspace, projectRoot, agents, coordinator, db, manager, images, service };
}

function deps(f: Fixture, deletion: DeletionService | null = f.service): HttpDeps {
  return {
    db: f.db,
    workspaceRoot: f.workspace,
    git: new GitService({ workspaceRoot: f.workspace }),
    getProjects: () => {
      const rows = f.db.prepare("SELECT id, name, root_path, deleting FROM projects").all() as {
        id: string;
        name: string;
        root_path: string;
        deleting: number;
      }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        rootPath: row.root_path,
        workspaceRoot: f.workspace,
        deleting: row.deleting === 1,
        service: new CoordinatorService(f.db, row.id),
      }));
    },
    ...(deletion === null ? {} : { deletion }),
  };
}

function humanToken(db: SqliteDatabase): string {
  return createPrincipal(db, { kind: "human", name: "alice" }).token;
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function jsonRequest(token: string): Record<string, string> {
  return auth(token, {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
}

function responseJson(response: HttpResponse | undefined): Record<string, unknown> {
  expect(response).toBeDefined();
  return JSON.parse(response?.body ?? "{}") as Record<string, unknown>;
}

function projectRequest(
  token: string,
  method: "POST" | "DELETE",
  extra: Partial<HttpRequest> = {},
): HttpRequest {
  return {
    method,
    path: `/api/projects/${PROJECT_ID}${method === "POST" ? "/delete" : ""}`,
    headers: jsonRequest(token),
    ...(method === "POST"
      ? { body: form({ confirm: PROJECT_NAME }) }
      : { query: { confirm: PROJECT_NAME } }),
    ...extra,
  };
}

describe("deletion route matching", () => {
  it("claims only the documented routes", () => {
    expect(isDeletionRoute("POST", `/api/projects/${PROJECT_ID}/delete`)).toBe(true);
    expect(isDeletionRoute("POST", `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`)).toBe(
      true,
    );
    expect(isDeletionRoute("DELETE", `/api/projects/${PROJECT_ID}`)).toBe(true);
    expect(isDeletionRoute("DELETE", `/api/projects/${PROJECT_ID}/apps/${APP_KEY}`)).toBe(true);
    expect(isDeletionRoute("GET", `/api/projects/${PROJECT_ID}`)).toBe(false);
    expect(isDeletionRoute("DELETE", "/api/projects")).toBe(false);
    expect(isDeletionRoute("POST", `/api/projects/${PROJECT_ID}/apps`)).toBe(false);
  });
});

describe("deletion HTTP handler", () => {
  it("returns 503 when the deletion service is not configured", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = await handleDeletion(deps(f, null), projectRequest(token, "DELETE"));
    expect(response?.status).toBe(503);
    expect(responseJson(response)).toMatchObject({ code: "deletion_unavailable" });
    expect(f.db.prepare("SELECT id FROM projects WHERE id = ?").get(PROJECT_ID)).toBeDefined();
  });

  it("deletes a project from a browser form and redirects with a success notice", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = await handleDeletion(deps(f), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/delete`,
      headers: auth(token, {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: form({ confirm: PROJECT_NAME, deleteFiles: "false", return_to: "/projects/old" }),
    });
    expect(response?.status).toBe(303);
    const location = response?.headers?.location ?? "";
    expect(location.startsWith("/projects?")).toBe(true);
    expect(location).toContain("notice=Project+deleted.");
    expect(location).toContain("tone=success");
    expect(f.db.prepare("SELECT id FROM projects WHERE id = ?").get(PROJECT_ID)).toBeUndefined();
  });

  it("deletes an application from a browser form and redirects to the project with a notice", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = await handleDeletion(deps(f), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
      headers: auth(token, {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: form({ confirm: APP_KEY, deleteFiles: "on" }),
    });
    expect(response?.status).toBe(303);
    const location = response?.headers?.location ?? "";
    expect(location.startsWith(`/projects/${PROJECT_ID}?`)).toBe(true);
    expect(location).toContain("notice=Application+deleted.");
    expect(location).toContain("tone=success");
    expect(existsSync(path.join(f.projectRoot, "apps", APP_KEY))).toBe(false);

    const failed = fixture();
    const failedToken = humanToken(failed.db);
    const errorResponse = await handleDeletion(deps(failed), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
      headers: auth(failedToken, {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: form({ confirm: "wrong" }),
    });
    expect(errorResponse?.status).toBe(303);
    expect(errorResponse?.headers?.location).toContain("tone=error");
  });

  it("reports image purge warnings in the browser notice with the error tone", async () => {
    const f = fixture();
    f.images.report = gcReport({
      skipped: [{ ref: "hanse-app-web:1", reason: "protected" }],
    });
    const token = humanToken(f.db);
    const response = await handleDeletion(deps(f), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
      headers: auth(token, {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: form({ confirm: APP_KEY }),
    });
    expect(response?.status).toBe(303);
    const location = response?.headers?.location ?? "";
    expect(location).toContain("tone=error");
    expect(location).toContain("1+warning");
  });

  it("deletes an application with a form-encoded JSON POST", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = await handleDeletion(deps(f), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
      headers: jsonRequest(token),
      body: form({ confirm: APP_KEY }),
    });
    expect(response?.status).toBe(200);
    expect(responseJson(response)).toMatchObject({
      deleted: true,
      kind: "app",
      projectId: PROJECT_ID,
      appKey: APP_KEY,
      warnings: [],
    });
    expect(
      f.db.prepare("SELECT id FROM apps WHERE id = ?").get(`${PROJECT_ID}:${APP_KEY}`),
    ).toBeUndefined();
  });

  it("deletes a project with the DELETE JSON alias", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = await handleDeletion(deps(f), projectRequest(token, "DELETE"));
    expect(response?.status).toBe(200);
    expect(responseJson(response)).toMatchObject({
      deleted: true,
      kind: "project",
      projectId: PROJECT_ID,
      warnings: [],
    });
  });

  it("requires authentication and redirects browser callers to login", async () => {
    const f = fixture();
    const anonymous = await handleDeletion(deps(f), {
      method: "DELETE",
      path: `/api/projects/${PROJECT_ID}`,
      headers: { accept: "application/json" },
      query: { confirm: PROJECT_NAME },
    });
    expect(anonymous?.status).toBe(401);

    const browser = await handleDeletion(deps(f), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/delete`,
      headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      body: form({ confirm: PROJECT_NAME, return_to: "/projects/old" }),
    });
    expect(browser?.status).toBe(303);
    expect(browser?.headers?.location).toBe("/login?next=%2Fprojects%2Fold");
  });

  it("rejects agent principals and MCP agent tokens", async () => {
    const f = fixture();
    const agent = createPrincipal(f.db, { kind: "agent", name: "web" }).token;
    const principal = await handleDeletion(
      deps(f),
      projectRequest(agent, "DELETE", { headers: jsonRequest(agent) }),
    );
    expect(principal?.status).toBe(403);

    const mcpToken = mintAgentToken(f.db, `${PROJECT_ID}:${APP_KEY}`);
    const tokenResponse = await handleDeletion(
      deps(f),
      projectRequest(mcpToken, "DELETE", { headers: jsonRequest(mcpToken) }),
    );
    expect(tokenResponse?.status).toBe(403);
    expect(responseJson(tokenResponse)).toMatchObject({ code: "forbidden" });
    expect(f.db.prepare("SELECT id FROM projects WHERE id = ?").get(PROJECT_ID)).toBeDefined();
  });

  it("maps confirmation, unknown target, and service failures", async () => {
    const wrong = fixture();
    const token = humanToken(wrong.db);
    const badConfirm = await handleDeletion(deps(wrong), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
      headers: jsonRequest(token),
      body: form({ confirm: "wrong" }),
    });
    expect(badConfirm?.status).toBe(400);
    expect(responseJson(badConfirm)).toMatchObject({ code: "confirmation_mismatch" });

    const unknown = fixture();
    const unknownToken = humanToken(unknown.db);
    const missing = await handleDeletion(deps(unknown), {
      method: "DELETE",
      path: "/api/projects/missing",
      headers: jsonRequest(unknownToken),
      query: { confirm: "missing" },
    });
    expect(missing?.status).toBe(404);
    expect(responseJson(missing)).toMatchObject({ code: "project_not_found" });

    const busy = fixture();
    const busyToken = humanToken(busy.db);
    busy.images.failAssertOn = `${PROJECT_ID}:${APP_KEY}`;
    const conflict = await handleDeletion(deps(busy), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
      headers: jsonRequest(busyToken),
      body: form({ confirm: APP_KEY }),
    });
    expect(conflict?.status).toBe(409);
    expect(responseJson(conflict)).toMatchObject({ code: "build_in_progress" });

    const failed = fixture();
    const failedToken = humanToken(failed.db);
    failed.manager.failOn = `${PROJECT_ID}:${APP_KEY}`;
    const runtimeError = await handleDeletion(deps(failed), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
      headers: jsonRequest(failedToken),
      body: form({ confirm: APP_KEY }),
    });
    expect(runtimeError?.status).toBe(502);
    expect(responseJson(runtimeError)).toMatchObject({ code: "runtime_stop_failed" });
  });

  it("rejects a cross-site Origin and allows same-origin or no Origin", async () => {
    const crossSite = fixture();
    const crossToken = humanToken(crossSite.db);
    const rejected = await handleDeletion(
      deps(crossSite),
      projectRequest(crossToken, "DELETE", {
        origin: "http://evil.example",
        host: "127.0.0.1:8787",
      }),
    );
    expect(rejected?.status).toBe(403);
    expect(responseJson(rejected)).toMatchObject({ code: "cross_site_request" });
    expect(
      crossSite.db.prepare("SELECT id FROM projects WHERE id = ?").get(PROJECT_ID),
    ).toBeDefined();

    const same = fixture();
    const sameToken = humanToken(same.db);
    const allowed = await handleDeletion(
      deps(same),
      projectRequest(sameToken, "DELETE", {
        origin: "http://127.0.0.1:8787",
        host: "127.0.0.1:8787",
      }),
    );
    expect(allowed?.status).toBe(200);

    const absent = fixture();
    const absentToken = humanToken(absent.db);
    const noOrigin = await handleDeletion(deps(absent), projectRequest(absentToken, "DELETE"));
    expect(noOrigin?.status).toBe(200);
  });

  it("is dispatched by the HTTP server before the chat fallback", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const server = createHttpServer(deps(f));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/projects/${PROJECT_ID}/apps/${APP_KEY}/delete`,
        {
          method: "POST",
          headers: jsonRequest(token),
          body: form({ confirm: APP_KEY }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ deleted: true, kind: "app", appKey: APP_KEY });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("add-app and create-project deletion guards", () => {
  it("refuses to add an app while the project is marked deleting", () => {
    const f = fixture();
    const token = humanToken(f.db);
    f.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(PROJECT_ID);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps`,
      headers: jsonRequest(token),
      body: form({ name: "New App", path: "apps/new" }),
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: "deletion_incomplete" });
    expect(existsSync(path.join(f.projectRoot, "apps", "new"))).toBe(false);
  });

  it("refuses to re-add an app whose row is marked deleting", () => {
    const f = fixture();
    const token = humanToken(f.db);
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(`${PROJECT_ID}:${APP_KEY}`);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps`,
      headers: jsonRequest(token),
      body: form({ name: "Web", path: `apps/${APP_KEY}` }),
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: "deletion_incomplete" });
  });

  it("refuses to add an app while a deletion reservation is active", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const stub: DeletionService = {
      isActive: () => false,
      isDeletingProject: () => true,
      isDeletingApp: () => false,
      isDeletingAppState: () => false,
      isDeletingPath: () => false,
    } as unknown as DeletionService;
    const response = handleRequest(deps(f, stub), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps`,
      headers: jsonRequest(token),
      body: form({ name: "New App", path: "apps/new" }),
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: "deletion_in_progress" });
    expect(existsSync(path.join(f.projectRoot, "apps", "new"))).toBe(false);
  });

  it("refuses to add an app while its state path is reserved", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const stub: DeletionService = {
      isActive: () => false,
      isDeletingProject: () => false,
      isDeletingApp: () => false,
      isDeletingAppState: (projectId: string, appKey: string) =>
        projectId === PROJECT_ID && appKey === "new",
      isDeletingPath: () => false,
    } as unknown as DeletionService;
    const response = handleRequest(deps(f, stub), {
      method: "POST",
      path: `/api/projects/${PROJECT_ID}/apps`,
      headers: jsonRequest(token),
      body: form({ name: "New App", path: "apps/new" }),
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ code: "deletion_in_progress" });
    expect(existsSync(path.join(f.projectRoot, "apps", "new"))).toBe(false);
  });

  it("refuses to create a project while a deletion is active or reserves its root", () => {
    const active = fixture();
    const activeToken = humanToken(active.db);
    const activeStub: DeletionService = {
      isActive: () => true,
      isDeletingProject: () => false,
      isDeletingApp: () => false,
      isDeletingAppState: () => false,
      isDeletingPath: () => false,
    } as unknown as DeletionService;
    const activeResponse = handleRequest(deps(active, activeStub), {
      method: "POST",
      path: "/api/projects",
      headers: jsonRequest(activeToken),
      body: form({ name: "New Project" }),
    });
    expect(activeResponse.status).toBe(409);
    expect(JSON.parse(activeResponse.body)).toMatchObject({ code: "deletion_in_progress" });
    expect(existsSync(path.join(active.workspace, "new-project"))).toBe(false);

    const reserved = fixture();
    const reservedToken = humanToken(reserved.db);
    const reservedStub: DeletionService = {
      isActive: () => false,
      isDeletingProject: () => false,
      isDeletingApp: () => false,
      isDeletingAppState: () => false,
      isDeletingPath: (target: string) =>
        path.resolve(target) === path.resolve(path.join(reserved.workspace, "new-project")),
    } as unknown as DeletionService;
    const reservedResponse = handleRequest(deps(reserved, reservedStub), {
      method: "POST",
      path: "/api/projects",
      headers: jsonRequest(reservedToken),
      body: form({ name: "New Project" }),
    });
    expect(reservedResponse.status).toBe(409);
    expect(JSON.parse(reservedResponse.body)).toMatchObject({ code: "deletion_in_progress" });
    expect(existsSync(path.join(reserved.workspace, "new-project"))).toBe(false);
  });
});
