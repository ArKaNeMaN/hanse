import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type DeleteResult,
  DeletionError,
  type DeletionImages,
  type DeletionManager,
  DeletionService,
} from "../src/coordinator/deletion.js";
import type { RunnerImageRecord } from "../src/images/client.js";
import { ImageServiceError } from "../src/images/service.js";
import { sanitizeAppKey } from "../src/opencode/instance.js";
import { registerProject } from "../src/registry/index.js";
import type { ImageGcReport } from "../src/runner/image-gc.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";

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
  readonly entered: string[] = [];
  readonly stops: string[] = [];
  failOn: string | undefined;
  gate: Promise<void> | undefined;
  onStop: ((appId: string) => void) | undefined;

  constructor(private readonly db: SqliteDatabase) {}

  async stopForDeletion(appId: string): Promise<boolean> {
    this.entered.push(appId);
    if (this.gate !== undefined) {
      await this.gate;
    }
    this.onStop?.(appId);
    if (this.failOn === appId) {
      throw new Error("runtime unavailable");
    }
    this.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(appId);
    this.stops.push(appId);
    return true;
  }
}

class FakeImages implements DeletionImages {
  readonly reserved = new Set<string>();
  readonly ended: string[] = [];
  readonly purged: string[] = [];
  readonly forgotten: string[] = [];
  failAssertOn: string | undefined;
  failPurgeOn: string | undefined;
  report: ImageGcReport | undefined;
  onPurge: ((appId: string) => void) | undefined;

  async assertRunnerIdle(appId: string): Promise<RunnerImageRecord> {
    if (this.failAssertOn === appId) {
      throw new ImageServiceError(409, "an image build is running", "build_in_progress");
    }
    return { ...EMPTY_RECORD, appId };
  }

  reserveDelete(appId: string): void {
    this.reserved.add(appId);
  }

  endDelete(appId: string): void {
    this.ended.push(appId);
    this.reserved.delete(appId);
  }

  async purgeApp(appId: string): Promise<ImageGcReport> {
    this.purged.push(appId);
    this.onPurge?.(appId);
    if (this.failPurgeOn === appId) {
      throw new Error("image is in use");
    }
    return this.report ?? gcReport();
  }

  forgetApp(appId: string): void {
    this.forgotten.push(appId);
  }
}

interface Fixture {
  base: string;
  workspace: string;
  projectRoot: string;
  agents: string;
  coordinator: string;
  db: SqliteDatabase;
  projectId: string;
  projectName: string;
  appKeys: string[];
  manifestPath: string;
  manager: FakeManager;
  images: FakeImages;
  service: DeletionService;
}

interface FixtureOptions {
  apps?: string[];
  name?: string;
  projectId?: string;
  manifest?: string;
  agentsUnderWorkspace?: boolean;
}

function projectManifest(
  id: string,
  name: string,
  appKeys: string[],
  shared: string[] = ["shared/AGENTS.md"],
): string {
  return stringifyYaml({
    id,
    name,
    base_branch: "main",
    ...(shared.length === 0 ? {} : { shared }),
    apps: appKeys.map((appKey) => ({ path: `apps/${appKey}`, kind: "web" })),
  });
}

function fixture(options: FixtureOptions = {}): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "hanse-deletion-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  mkdirSync(workspace, { recursive: true });
  const projectRoot = path.join(workspace, "project");
  const agents =
    options.agentsUnderWorkspace === true
      ? path.join(workspace, "agents")
      : path.join(base, "agents");
  const coordinator = path.join(base, "state", "hanse");
  const appKeys = options.apps ?? ["web", "api"];
  const projectId = options.projectId ?? PROJECT_ID;
  const projectName = options.name ?? "Demo Project";

  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  mkdirSync(agents, { recursive: true });
  mkdirSync(coordinator, { recursive: true });
  for (const appKey of appKeys) {
    mkdirSync(path.join(projectRoot, "apps", appKey), { recursive: true });
  }
  const manifestPath = path.join(projectRoot, ".hanse", "project.yaml");
  writeFileSync(
    manifestPath,
    options.manifest ?? projectManifest(projectId, projectName, appKeys),
    "utf8",
  );

  const db = openDatabase(path.join(base, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  registerProject(
    db,
    {
      id: projectId,
      name: projectName,
      base_branch: "main",
      apps: appKeys.map((appKey) => ({ path: `apps/${appKey}`, kind: "web" })),
    },
    projectRoot,
    workspace,
  );

  for (const appKey of appKeys) {
    const state = path.join(agents, sanitizeAppKey(projectId), sanitizeAppKey(appKey));
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, "marker"), appKey, "utf8");
  }

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
  return {
    base,
    workspace,
    projectRoot,
    agents,
    coordinator,
    db,
    projectId,
    projectName,
    appKeys,
    manifestPath,
    manager,
    images,
    service,
  };
}

function appId(projectId: string, appKey: string): string {
  return `${projectId}:${appKey}`;
}

function stateDir(f: Fixture, projectId: string, appKey: string): string {
  return path.join(f.agents, sanitizeAppKey(projectId), sanitizeAppKey(appKey));
}

function manifestApps(f: Fixture): Array<Record<string, unknown>> {
  const parsed = parseYaml(readFileSync(f.manifestPath, "utf8")) as {
    apps?: Array<Record<string, unknown>>;
  };
  return parsed.apps ?? [];
}

function insertSettings(
  db: SqliteDatabase,
  scope: "global" | "project" | "app",
  projectId = "",
  appKey = "",
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO settings (scope, project_id, app_key, key, value_json, updated_at) VALUES (?, ?, ?, 'k', '\"v\"', ?)",
  ).run(scope, projectId, appKey, now);
  db.prepare(
    "INSERT INTO provider_keys (scope, project_id, app_key, provider, cipher, nonce, cleared, updated_at) VALUES (?, ?, ?, 'deepseek', 'cipher', 'nonce', 0, ?)",
  ).run(scope, projectId, appKey, now);
  db.prepare(
    "INSERT INTO setting_secrets (scope, project_id, app_key, key, cipher, nonce, meta_json, cleared, updated_at) VALUES (?, ?, ?, 'git.ssh', 'cipher', 'nonce', '{}', 0, ?)",
  ).run(scope, projectId, appKey, now);
}

function insertSkill(
  db: SqliteDatabase,
  scope: "global" | "project" | "app",
  projectId: string,
  appKey: string,
  name: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO skills
       (scope, project_id, app_key, name, description, content, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'description', 'content', 1, ?, ?)`,
  ).run(scope, projectId, appKey, name, now, now);
}

function insertTask(db: SqliteDatabase, id: string, appIdValue: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO tasks (id, app_id, state, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
  ).run(id, appIdValue, now, now);
}

function insertHandoff(
  db: SqliteDatabase,
  input: {
    id: string;
    projectId: string;
    from: string;
    to: string;
    targetTaskId?: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO handoffs
       (id, project_id, from_app_id, to_app_id, state, summary, spec,
        idempotency_key, attempts, target_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 'summary', 'spec', ?, 0, ?, ?, ?)`,
  ).run(
    input.id,
    input.projectId,
    input.from,
    input.to,
    `idem-${input.id}`,
    input.targetTaskId ?? null,
    now,
    now,
  );
}

function addOtherProject(f: Fixture): { id: string; name: string; root: string; key: string } {
  const id = OTHER_PROJECT_ID;
  const name = "Other Project";
  const key = "svc";
  const root = path.join(f.workspace, "other");
  mkdirSync(path.join(root, ".hanse"), { recursive: true });
  mkdirSync(path.join(root, "apps", key), { recursive: true });
  writeFileSync(
    path.join(root, ".hanse", "project.yaml"),
    projectManifest(id, name, [key], []),
    "utf8",
  );
  registerProject(
    f.db,
    { id, name, base_branch: "main", apps: [{ path: `apps/${key}`, kind: "service" }] },
    root,
    f.workspace,
  );
  mkdirSync(stateDir(f, id, key), { recursive: true });
  writeFileSync(path.join(stateDir(f, id, key), "marker"), "other", "utf8");
  return { id, name, root, key };
}

function insertSshRows(f: Fixture): void {
  const now = new Date().toISOString();
  f.db
    .prepare(
      `INSERT INTO ssh_hosts (id, name, address, port, username, created_at, updated_at)
       VALUES ('h1', 'host-one', '127.0.0.1', 22, 'deploy', ?, ?)`,
    )
    .run(now, now);
  f.db
    .prepare(
      `INSERT INTO ssh_audit
         (app_id, project_id, app_key, host_id, host_name, address, username, action, started_at)
       VALUES (?, ?, 'web', 'h1', 'host-one', '127.0.0.1', 'deploy', 'exec', ?)`,
    )
    .run(appId(f.projectId, "web"), f.projectId, now);
}

function expectDeletionError(error: unknown, status: number, code: string): void {
  expect(error).toBeInstanceOf(DeletionError);
  expect((error as DeletionError).status).toBe(status);
  expect((error as DeletionError).code).toBe(code);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function count(db: SqliteDatabase, table: string, where: string, ...params: unknown[]): number {
  return (
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params) as {
      count: number;
    }
  ).count;
}

function expectAppDeleted(result: DeleteResult, projectId: string, appKey: string): void {
  expect(result.deleted).toBe(true);
  expect(result.kind).toBe("app");
  expect(result.projectId).toBe(projectId);
  expect(result.appKey).toBe(appKey);
}

describe("DeletionService application deletion", () => {
  it("removes the app, its rows, state and manifest entry while preserving siblings", async () => {
    const f = fixture();
    const webId = appId(f.projectId, "web");
    const apiId = appId(f.projectId, "api");
    insertSettings(f.db, "global");
    insertSettings(f.db, "project", f.projectId);
    insertSettings(f.db, "app", f.projectId, "web");
    insertSettings(f.db, "app", f.projectId, "api");
    insertTask(f.db, "task-web", webId);
    insertTask(f.db, "task-api", apiId);
    insertHandoff(f.db, {
      id: "h1",
      projectId: f.projectId,
      from: webId,
      to: apiId,
      targetTaskId: "task-web",
    });
    insertHandoff(f.db, {
      id: "h2",
      projectId: f.projectId,
      from: apiId,
      to: apiId,
      targetTaskId: "task-web",
    });
    insertHandoff(f.db, { id: "h3", projectId: f.projectId, from: apiId, to: apiId });

    const result = await f.service.deleteApp(f.projectId, "web", { confirm: "web" });

    expectAppDeleted(result, f.projectId, "web");
    expect(result.warnings).toEqual([]);
    expect(f.db.prepare("SELECT id FROM apps WHERE id = ?").get(webId)).toBeUndefined();
    expect(f.db.prepare("SELECT id FROM apps WHERE id = ?").get(apiId)).toBeDefined();
    expect(count(f.db, "settings", "scope = 'app' AND app_key = 'web'")).toBe(0);
    expect(count(f.db, "provider_keys", "scope = 'app' AND app_key = 'web'")).toBe(0);
    expect(count(f.db, "setting_secrets", "scope = 'app' AND app_key = 'web'")).toBe(0);
    expect(count(f.db, "settings", "scope = 'app' AND app_key = 'api'")).toBe(1);
    expect(count(f.db, "settings", "scope = 'project'")).toBe(1);
    expect(count(f.db, "settings", "scope = 'global'")).toBe(1);
    expect(count(f.db, "tasks", "app_id = ?", webId)).toBe(0);
    expect(count(f.db, "tasks", "app_id = ?", apiId)).toBe(1);
    expect(count(f.db, "handoffs", "id = 'h1'")).toBe(0);
    expect(count(f.db, "handoffs", "id IN ('h2','h3')")).toBe(2);
    const h2 = f.db.prepare("SELECT target_task_id FROM handoffs WHERE id = 'h2'").get() as {
      target_task_id: string | null;
    };
    expect(h2.target_task_id).toBeNull();

    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(false);
    expect(existsSync(stateDir(f, f.projectId, "api"))).toBe(true);
    expect(existsSync(path.join(f.projectRoot, "apps", "web"))).toBe(true);
    expect(manifestApps(f)).toEqual([{ path: "apps/api", kind: "web" }]);
    const manifest = parseYaml(readFileSync(f.manifestPath, "utf8")) as {
      name?: string;
      shared?: string[];
    };
    expect(manifest.name).toBe(f.projectName);
    expect(manifest.shared).toEqual(["shared/AGENTS.md"]);

    const event = f.db
      .prepare("SELECT payload FROM events WHERE scope = 'app' AND type = 'app.deleted'")
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({
      projectId: f.projectId,
      appId: webId,
      appKey: "web",
    });
    expect(f.manager.stops).toEqual([webId]);
    expect(f.images.purged).toEqual([webId]);
    expect(f.images.ended).toContain(webId);
  });

  it("removes only the app-scoped skill rows and starts a re-added key clean", async () => {
    const f = fixture();
    insertSkill(f.db, "global", "", "", "global-skill");
    insertSkill(f.db, "project", f.projectId, "", "project-skill");
    insertSkill(f.db, "app", f.projectId, "web", "web-skill");
    insertSkill(f.db, "app", f.projectId, "api", "api-skill");

    await f.service.deleteApp(f.projectId, "web", { confirm: "web" });

    expect(
      count(f.db, "skills", "scope = 'app' AND project_id = ? AND app_key = 'web'", f.projectId),
    ).toBe(0);
    expect(
      count(f.db, "skills", "scope = 'app' AND project_id = ? AND app_key = 'api'", f.projectId),
    ).toBe(1);
    expect(count(f.db, "skills", "scope = 'project' AND project_id = ?", f.projectId)).toBe(1);
    expect(count(f.db, "skills", "scope = 'global'")).toBe(1);

    insertAppRow(f, "web", "apps/web");
    expect(
      count(f.db, "skills", "scope = 'app' AND project_id = ? AND app_key = 'web'", f.projectId),
    ).toBe(0);
  });

  it("removes the app source only when deleteFiles is set", async () => {
    const f = fixture();
    const source = path.join(f.projectRoot, "apps", "web");

    const result = await f.service.deleteApp(f.projectId, "web", {
      confirm: "web",
      deleteFiles: true,
    });

    expectAppDeleted(result, f.projectId, "web");
    expect(result.warnings).toEqual([]);
    expect(existsSync(source)).toBe(false);
    expect(existsSync(path.join(f.projectRoot, "apps", "api"))).toBe(true);
    expect(existsSync(f.projectRoot)).toBe(true);
    expect(f.service.isDeletingPath(source)).toBe(false);
  });
});

describe("DeletionService project deletion", () => {
  it("removes the project, all app rows, scoped data and state but preserves SSH audit and globals", async () => {
    const f = fixture();
    const other = addOtherProject(f);
    const webId = appId(f.projectId, "web");
    const apiId = appId(f.projectId, "api");
    insertSettings(f.db, "global");
    insertSettings(f.db, "project", f.projectId);
    insertSettings(f.db, "app", f.projectId, "web");
    insertSettings(f.db, "app", f.projectId, "api");
    insertSettings(f.db, "project", other.id);
    insertSettings(f.db, "app", other.id, other.key);
    insertSshRows(f);
    insertTask(f.db, "task-web", webId);
    insertHandoff(f.db, {
      id: "h1",
      projectId: f.projectId,
      from: webId,
      to: apiId,
      targetTaskId: "task-web",
    });

    const result = await f.service.deleteProject(f.projectId, { confirm: f.projectName });

    expect(result).toMatchObject({ deleted: true, kind: "project", projectId: f.projectId });
    expect(result.warnings).toEqual([]);
    expect(count(f.db, "projects", "id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "apps", "project_id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "projects", "id = ?", other.id)).toBe(1);
    expect(count(f.db, "apps", "project_id = ?", other.id)).toBe(1);
    expect(count(f.db, "handoffs", "project_id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "settings", "project_id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "provider_keys", "project_id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "setting_secrets", "project_id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "settings", "project_id = ?", other.id)).toBe(2);
    expect(count(f.db, "settings", "scope = 'global'")).toBe(1);
    expect(count(f.db, "ssh_hosts", "id = 'h1'")).toBe(1);
    expect(count(f.db, "ssh_audit", "app_id = ?", webId)).toBe(1);

    expect(existsSync(path.join(f.agents, sanitizeAppKey(f.projectId)))).toBe(false);
    expect(existsSync(stateDir(f, other.id, other.key))).toBe(true);
    expect(existsSync(f.manifestPath)).toBe(false);
    expect(existsSync(f.projectRoot)).toBe(true);
    expect(existsSync(other.root)).toBe(true);

    const event = f.db
      .prepare("SELECT payload FROM events WHERE scope = 'project' AND type = 'project.deleted'")
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({ projectId: f.projectId, apps: [apiId, webId] });
    expect(f.manager.stops.sort()).toEqual([apiId, webId]);
    expect(f.images.purged.sort()).toEqual([apiId, webId]);
  });

  it("removes project and app skill rows while preserving globals and other projects", async () => {
    const f = fixture();
    const other = addOtherProject(f);
    insertSkill(f.db, "global", "", "", "global-skill");
    insertSkill(f.db, "project", f.projectId, "", "project-skill");
    insertSkill(f.db, "app", f.projectId, "web", "web-skill");
    insertSkill(f.db, "app", f.projectId, "api", "api-skill");
    insertSkill(f.db, "project", other.id, "", "other-project-skill");
    insertSkill(f.db, "app", other.id, other.key, "other-app-skill");

    await f.service.deleteProject(f.projectId, { confirm: f.projectName });

    expect(count(f.db, "skills", "project_id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "skills", "scope = 'global'")).toBe(1);
    expect(count(f.db, "skills", "project_id = ?", other.id)).toBe(2);
  });

  it("removes the project source only when deleteFiles is set", async () => {
    const f = fixture({ apps: ["web"] });
    const other = addOtherProject(f);

    const result = await f.service.deleteProject(f.projectId, {
      confirm: f.projectName,
      deleteFiles: true,
    });

    expect(result.warnings).toEqual([]);
    expect(existsSync(f.projectRoot)).toBe(false);
    expect(existsSync(f.workspace)).toBe(true);
    expect(existsSync(other.root)).toBe(true);
  });

  it("keeps the project marker on a stop failure and succeeds on retry", async () => {
    const f = fixture();
    const webId = appId(f.projectId, "web");
    const apiId = appId(f.projectId, "api");
    f.manager.failOn = webId;

    let error: unknown;
    try {
      await f.service.deleteProject(f.projectId, { confirm: f.projectName });
    } catch (caught) {
      error = caught;
    }
    expectDeletionError(error, 502, "runtime_stop_failed");

    const project = f.db.prepare("SELECT deleting FROM projects WHERE id = ?").get(f.projectId) as {
      deleting: number;
    };
    expect(project.deleting).toBe(1);
    const web = f.db.prepare("SELECT deleting FROM apps WHERE id = ?").get(webId) as {
      deleting: number;
    };
    const api = f.db.prepare("SELECT deleting FROM apps WHERE id = ?").get(apiId) as {
      deleting: number;
    };
    expect(web.deleting).toBe(0);
    expect(api.deleting).toBe(1);
    expect(count(f.db, "projects", "id = ?", f.projectId)).toBe(1);
    expect(existsSync(f.manifestPath)).toBe(true);
    expect(f.service.isActive()).toBe(false);

    f.manager.failOn = undefined;
    f.manager.stops.length = 0;
    const retry = await f.service.deleteProject(f.projectId, { confirm: f.projectName });
    expect(retry.deleted).toBe(true);
    expect(count(f.db, "projects", "id = ?", f.projectId)).toBe(0);
    expect(f.manager.stops.sort()).toEqual([apiId, webId]);
  });
});

function insertAppRow(f: Fixture, appKey: string, appPath: string): string {
  const id = appId(f.projectId, appKey);
  f.db
    .prepare(
      "INSERT INTO apps (id, project_id, app_key, path, contract, created_at) VALUES (?, ?, ?, ?, 'AGENTS.md', ?)",
    )
    .run(id, f.projectId, appKey, appPath, new Date().toISOString());
  return id;
}

async function expectAppFailure(
  service: DeletionService,
  projectId: string,
  appKey: string,
  confirm: string,
  status: number,
  code: string,
  options: { deleteFiles?: boolean } = {},
): Promise<void> {
  let error: unknown;
  try {
    await service.deleteApp(projectId, appKey, { confirm, ...options });
  } catch (caught) {
    error = caught;
  }
  expectDeletionError(error, status, code);
}

describe("DeletionService validation and path guards", () => {
  it("rejects unknown rows, wrong confirmation and an app under a deleting project", async () => {
    const f = fixture();
    await expectAppFailure(f.service, f.projectId, "missing", "missing", 404, "app_not_found");

    let error: unknown;
    try {
      await f.service.deleteProject("ffffffff-ffff-4fff-8fff-ffffffffffff", { confirm: "x" });
    } catch (caught) {
      error = caught;
    }
    expectDeletionError(error, 404, "project_not_found");

    await expectAppFailure(f.service, f.projectId, "web", "not-web", 400, "confirmation_mismatch");

    f.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(f.projectId);
    await expectAppFailure(f.service, f.projectId, "web", "web", 409, "deletion_incomplete");
    expect(f.manager.entered).toEqual([]);
  });

  it("rejects an app key that is a dot segment", async () => {
    const f = fixture({ apps: ["web"] });
    const id = insertAppRow(f, "..", "apps/escape");
    await expectAppFailure(f.service, f.projectId, "..", "..", 409, "unsafe_state_path");
    expect(f.db.prepare("SELECT id FROM apps WHERE id = ?").get(id)).toBeDefined();
    expect(f.manager.entered).toEqual([]);
  });

  it("rejects two app keys that sanitize to the same state directory", async () => {
    const f = fixture({ apps: ["web:api", "web-api"] });
    await expectAppFailure(
      f.service,
      f.projectId,
      "web:api",
      "web:api",
      409,
      "state_path_collision",
    );
    await expectAppFailure(
      f.service,
      f.projectId,
      "web-api",
      "web-api",
      409,
      "state_path_collision",
    );
    expect(f.manager.entered).toEqual([]);
  });

  it("rejects a symlinked app state directory", async () => {
    const f = fixture({ apps: ["web"] });
    const target = path.join(f.base, "outside-state");
    mkdirSync(target, { recursive: true });
    const state = stateDir(f, f.projectId, "web");
    rmSync(state, { recursive: true, force: true });
    symlinkSync(target, state, "dir");

    await expectAppFailure(f.service, f.projectId, "web", "web", 409, "unsafe_state_path");
    expect(existsSync(target)).toBe(true);
  });

  it("rejects a symlinked app source directory", async () => {
    const f = fixture({ apps: ["web"] });
    const target = path.join(f.base, "outside-source");
    mkdirSync(target, { recursive: true });
    const source = path.join(f.projectRoot, "apps", "web");
    rmSync(source, { recursive: true, force: true });
    symlinkSync(target, source, "dir");

    await expectAppFailure(f.service, f.projectId, "web", "web", 409, "unsafe_app_dir");
    expect(existsSync(target)).toBe(true);
  });

  it("rejects an app whose path resolves to the project root", async () => {
    const f = fixture({ apps: ["web"] });
    insertAppRow(f, "rootapp", ".");
    await expectAppFailure(f.service, f.projectId, "rootapp", "rootapp", 409, "unsafe_app_dir");
  });

  it("rejects an app directory shared with another app", async () => {
    const f = fixture({ apps: ["web"] });
    insertAppRow(f, "alias", "apps/web");
    await expectAppFailure(f.service, f.projectId, "alias", "alias", 409, "shared_app_dir");
  });

  it("rejects a symlinked .hanse directory before stopping", async () => {
    const f = fixture({ apps: ["web"] });
    const outside = path.join(f.base, "outside-manifest");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      path.join(outside, "project.yaml"),
      projectManifest(f.projectId, f.projectName, ["web"]),
      "utf8",
    );
    rmSync(path.join(f.projectRoot, ".hanse"), { recursive: true, force: true });
    symlinkSync(outside, path.join(f.projectRoot, ".hanse"), "dir");

    await expectAppFailure(f.service, f.projectId, "web", "web", 409, "unsafe_manifest_path");
    expect(f.manager.entered).toEqual([]);
  });

  it("allows a source under a symlinked parent when deleteFiles is false", async () => {
    const f = fixture({ apps: ["web"] });
    const real = path.join(f.workspace, "real");
    mkdirSync(path.join(real, "apps", "linked"), { recursive: true });
    symlinkSync(real, path.join(f.workspace, "linked"), "dir");
    const appPath = path.join(f.workspace, "linked", "apps", "linked");
    insertAppRow(f, "linked", appPath);

    const result = await f.service.deleteApp(f.projectId, "linked", { confirm: "linked" });

    expectAppDeleted(result, f.projectId, "linked");
    expect(existsSync(appPath)).toBe(true);
    expect(f.manager.stops).toEqual([appId(f.projectId, "linked")]);
  });

  it("rejects a source under a symlinked parent when deleteFiles is true", async () => {
    const f = fixture({ apps: ["web"] });
    const real = path.join(f.workspace, "real");
    mkdirSync(path.join(real, "apps", "linked"), { recursive: true });
    symlinkSync(real, path.join(f.workspace, "linked"), "dir");
    const appPath = path.join(f.workspace, "linked", "apps", "linked");
    const linkedId = insertAppRow(f, "linked", appPath);

    await expectAppFailure(f.service, f.projectId, "linked", "linked", 409, "unsafe_app_dir", {
      deleteFiles: true,
    });
    expect(f.manager.entered).toEqual([]);
    expect(existsSync(appPath)).toBe(true);
    expect(f.db.prepare("SELECT id FROM apps WHERE id = ?").get(linkedId)).toBeDefined();
    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(true);
  });

  it("rejects a source inside the agents root when deleteFiles is true", async () => {
    const f = fixture({ apps: ["web"], agentsUnderWorkspace: true });
    const source = path.join(f.agents, "insider", "web");
    mkdirSync(source, { recursive: true });
    insertAppRow(f, "insider", source);

    let error: unknown;
    try {
      await f.service.deleteApp(f.projectId, "insider", {
        confirm: "insider",
        deleteFiles: true,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DeletionError);
    expect((error as DeletionError).status).toBe(409);
    expect(["unsafe_app_dir", "unsafe_state_path"]).toContain((error as DeletionError).code);
    expect(f.manager.entered).toEqual([]);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(true);
  });

  it("rejects a sibling that gains the same state directory while the app is stopping", async () => {
    const f = fixture({ apps: ["web:api"] });
    const targetId = appId(f.projectId, "web:api");
    f.manager.onStop = () => {
      insertAppRow(f, "web-api", "apps/web-api");
    };

    await expectAppFailure(
      f.service,
      f.projectId,
      "web:api",
      "web:api",
      409,
      "state_path_collision",
    );
    expect(f.db.prepare("SELECT id FROM apps WHERE id = ?").get(targetId)).toBeDefined();
    expect(existsSync(stateDir(f, f.projectId, "web:api"))).toBe(true);
    expect(existsSync(f.manifestPath)).toBe(true);
    expect(manifestApps(f)).toHaveLength(1);
  });
});

describe("DeletionService project manifest guards", () => {
  it("rejects a symlinked .hanse directory before stopping on project delete", async () => {
    const f = fixture({ apps: ["web"] });
    const outside = path.join(f.base, "outside-project-manifest");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      path.join(outside, "project.yaml"),
      projectManifest(f.projectId, f.projectName, ["web"]),
      "utf8",
    );
    rmSync(path.join(f.projectRoot, ".hanse"), { recursive: true, force: true });
    symlinkSync(outside, path.join(f.projectRoot, ".hanse"), "dir");

    let error: unknown;
    try {
      await f.service.deleteProject(f.projectId, { confirm: f.projectName });
    } catch (caught) {
      error = caught;
    }
    expectDeletionError(error, 409, "unsafe_manifest_path");
    expect(f.manager.entered).toEqual([]);
    const marker = f.db.prepare("SELECT deleting FROM projects WHERE id = ?").get(f.projectId) as {
      deleting: number;
    };
    expect(marker.deleting).toBe(0);
    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(true);
  });
});

describe("DeletionService concurrency", () => {
  it("rejects a second app deletion and exposes reservations while active", async () => {
    const f = fixture({ apps: ["web"] });
    const gate = deferred();
    f.manager.gate = gate.promise;
    const webId = appId(f.projectId, "web");
    const source = path.join(f.projectRoot, "apps", "web");

    const first = f.service.deleteApp(f.projectId, "web", {
      confirm: "web",
      deleteFiles: true,
    });
    await waitFor(() => f.manager.entered.length === 1);
    expect(f.service.isActive()).toBe(true);
    expect(f.service.isDeletingApp(webId)).toBe(true);
    expect(f.service.isDeletingAppState(f.projectId, "web")).toBe(true);
    expect(f.service.isDeletingPath(source)).toBe(true);

    await expectAppFailure(f.service, f.projectId, "web", "web", 409, "deletion_in_progress", {
      deleteFiles: true,
    });

    gate.resolve();
    await first;
    expect(f.service.isActive()).toBe(false);
    expect(f.service.isDeletingApp(webId)).toBe(false);
    expect(f.service.isDeletingAppState(f.projectId, "web")).toBe(false);
    expect(f.service.isDeletingPath(source)).toBe(false);
  });

  it("rejects a second project deletion and reserves the project root", async () => {
    const f = fixture({ apps: ["web"] });
    const gate = deferred();
    f.manager.gate = gate.promise;
    const projectState = path.join(f.agents, sanitizeAppKey(f.projectId));

    const first = f.service.deleteProject(f.projectId, { confirm: f.projectName });
    await waitFor(() => f.manager.entered.length === 1);
    expect(f.service.isActive()).toBe(true);
    expect(f.service.isDeletingProject(f.projectId)).toBe(true);
    expect(f.service.isDeletingPath(f.projectRoot)).toBe(true);
    expect(f.service.isDeletingPath(projectState)).toBe(true);

    let error: unknown;
    try {
      await f.service.deleteProject(f.projectId, { confirm: f.projectName });
    } catch (caught) {
      error = caught;
    }
    expectDeletionError(error, 409, "deletion_in_progress");

    gate.resolve();
    await first;
    expect(f.service.isActive()).toBe(false);
    expect(f.service.isDeletingProject(f.projectId)).toBe(false);
  });
});

describe("DeletionService failure paths", () => {
  it("leaves an app retryable when the runtime stop fails", async () => {
    const f = fixture({ apps: ["web"] });
    const webId = appId(f.projectId, "web");
    f.manager.failOn = webId;

    await expectAppFailure(f.service, f.projectId, "web", "web", 502, "runtime_stop_failed");

    const app = f.db.prepare("SELECT deleting FROM apps WHERE id = ?").get(webId) as {
      deleting: number;
    };
    expect(app.deleting).toBe(0);
    expect(existsSync(f.manifestPath)).toBe(true);
    expect(manifestApps(f)).toHaveLength(1);
    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(true);
    expect(f.images.ended).toContain(webId);
    expect(f.service.isActive()).toBe(false);

    f.manager.failOn = undefined;
    const retry = await f.service.deleteApp(f.projectId, "web", { confirm: "web" });
    expectAppDeleted(retry, f.projectId, "web");
    expect(count(f.db, "apps", "id = ?", webId)).toBe(0);
  });

  it("aborts before stopping when an image build is active", async () => {
    const f = fixture({ apps: ["web"] });
    const webId = appId(f.projectId, "web");
    f.images.failAssertOn = webId;

    await expectAppFailure(f.service, f.projectId, "web", "web", 409, "build_in_progress");

    expect(f.manager.entered).toEqual([]);
    expect(f.images.purged).toEqual([]);
    const app = f.db.prepare("SELECT deleting FROM apps WHERE id = ?").get(webId) as {
      deleting: number;
    };
    expect(app.deleting).toBe(0);
    expect(f.service.isActive()).toBe(false);
  });

  it("aborts before stopping on an invalid manifest", async () => {
    const f = fixture({ apps: ["web"] });
    writeFileSync(f.manifestPath, "apps: [", "utf8");

    await expectAppFailure(f.service, f.projectId, "web", "web", 409, "invalid_manifest");
    expect(f.manager.entered).toEqual([]);
    expect(count(f.db, "apps", "id = ?", appId(f.projectId, "web"))).toBe(1);
  });

  it("reports an image purge failure as a warning after the DB commit", async () => {
    const f = fixture({ apps: ["web"] });
    const webId = appId(f.projectId, "web");
    f.images.failPurgeOn = webId;

    const result = await f.service.deleteApp(f.projectId, "web", { confirm: "web" });

    expectAppDeleted(result, f.projectId, "web");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("image purge failed");
    expect(count(f.db, "apps", "id = ?", webId)).toBe(0);
    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(false);
    expect(f.images.ended).toContain(webId);
  });

  it("reports skipped and truncated image purge results as warnings", async () => {
    const f = fixture({ apps: ["web"] });
    f.images.report = gcReport({
      skipped: Array.from({ length: 7 }, (_, index) => ({
        ref: `hanse-app-web:${index}`,
        reason: "protected" as const,
      })),
      truncated: true,
    });

    const result = await f.service.deleteApp(f.projectId, "web", { confirm: "web" });

    expectAppDeleted(result, f.projectId, "web");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("image purge skipped 7 image(s)");
    expect(result.warnings[0]).toContain("and 2 more");
    expect(result.warnings[1]).toContain("truncated");
    expect(f.images.ended).toContain(appId(f.projectId, "web"));
  });

  it("skips source deletion when the app was re-added after the commit", async () => {
    const f = fixture({ apps: ["web"] });
    const webId = appId(f.projectId, "web");
    const source = path.join(f.projectRoot, "apps", "web");
    f.images.onPurge = () => {
      f.db
        .prepare(
          "INSERT INTO apps (id, project_id, app_key, path, contract, created_at) VALUES (?, ?, ?, ?, 'AGENTS.md', ?)",
        )
        .run(webId, f.projectId, "web", "apps/web", new Date().toISOString());
    };

    const result = await f.service.deleteApp(f.projectId, "web", {
      confirm: "web",
      deleteFiles: true,
    });

    expectAppDeleted(result, f.projectId, "web");
    expect(result.warnings.some((warning) => warning.includes("re-added"))).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(count(f.db, "apps", "id = ?", webId)).toBe(1);
  });

  it("treats a missing manifest entry and state directory as success on retry", async () => {
    const f = fixture({ apps: ["web"] });
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(appId(f.projectId, "web"));
    writeFileSync(
      f.manifestPath,
      stringifyYaml({
        id: f.projectId,
        name: f.projectName,
        base_branch: "main",
        apps: [],
      }),
      "utf8",
    );
    rmSync(stateDir(f, f.projectId, "web"), { recursive: true, force: true });

    const result = await f.service.deleteApp(f.projectId, "web", { confirm: "web" });
    expectAppDeleted(result, f.projectId, "web");
    expect(count(f.db, "apps", "id = ?", appId(f.projectId, "web"))).toBe(0);
  });

  it("treats a missing project manifest and state directory as success on retry", async () => {
    const f = fixture({ apps: ["web"] });
    f.db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(f.projectId);
    rmSync(f.manifestPath, { force: true });
    rmSync(path.join(f.agents, sanitizeAppKey(f.projectId)), { recursive: true, force: true });

    const result = await f.service.deleteProject(f.projectId, { confirm: f.projectName });
    expect(result.deleted).toBe(true);
    expect(count(f.db, "projects", "id = ?", f.projectId)).toBe(0);
  });

  it("never removes the workspace root as project source", async () => {
    const f = fixture({ apps: ["web"] });
    const now = new Date().toISOString();
    f.db
      .prepare(
        "INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at) VALUES (?, 'Workspace Root', 'main', ?, ?, ?)",
      )
      .run(OTHER_PROJECT_ID, f.workspace, now, now);

    const result = await f.service.deleteProject(OTHER_PROJECT_ID, {
      confirm: "Workspace Root",
      deleteFiles: true,
    });

    expect(result.warnings.some((warning) => warning.includes("source directory skipped"))).toBe(
      true,
    );
    expect(existsSync(f.workspace)).toBe(true);
    expect(existsSync(f.projectRoot)).toBe(true);
  });

  it("refuses a shared project root whose manifest belongs to the target", async () => {
    const f = fixture({ apps: ["web"] });
    const now = new Date().toISOString();
    f.db
      .prepare(
        "INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at) VALUES (?, 'Reused', 'main', ?, ?, ?)",
      )
      .run(OTHER_PROJECT_ID, f.projectRoot, now, now);

    let error: unknown;
    try {
      await f.service.deleteProject(f.projectId, { confirm: f.projectName });
    } catch (caught) {
      error = caught;
    }
    expectDeletionError(error, 409, "shared_project_root");
    expect(f.manager.entered).toEqual([]);
    expect(count(f.db, "projects", "id = ?", f.projectId)).toBe(1);
    expect(count(f.db, "projects", "id = ?", OTHER_PROJECT_ID)).toBe(1);
    const marker = f.db.prepare("SELECT deleting FROM projects WHERE id = ?").get(f.projectId) as {
      deleting: number;
    };
    expect(marker.deleting).toBe(0);
    expect(existsSync(f.manifestPath)).toBe(true);
    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(true);
  });

  it("skips the manifest when a shared root belongs to another project", async () => {
    const f = fixture({ apps: ["web"] });
    const now = new Date().toISOString();
    f.db
      .prepare(
        "INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at) VALUES (?, 'Reused', 'main', ?, ?, ?)",
      )
      .run(OTHER_PROJECT_ID, f.projectRoot, now, now);
    f.db
      .prepare(
        "INSERT INTO apps (id, project_id, app_key, path, contract, created_at) VALUES (?, ?, 'web', 'apps/web', 'AGENTS.md', ?)",
      )
      .run(appId(OTHER_PROJECT_ID, "web"), OTHER_PROJECT_ID, now);
    mkdirSync(stateDir(f, OTHER_PROJECT_ID, "web"), { recursive: true });
    writeFileSync(f.manifestPath, projectManifest(OTHER_PROJECT_ID, "Reused", ["web"], []), "utf8");

    const result = await f.service.deleteProject(f.projectId, {
      confirm: f.projectName,
      deleteFiles: true,
    });

    expect(result.deleted).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("project root"))).toBe(true);
    expect(count(f.db, "projects", "id = ?", f.projectId)).toBe(0);
    expect(count(f.db, "projects", "id = ?", OTHER_PROJECT_ID)).toBe(1);
    expect(count(f.db, "apps", "project_id = ?", OTHER_PROJECT_ID)).toBe(1);
    expect(existsSync(stateDir(f, f.projectId, "web"))).toBe(false);
    expect(existsSync(stateDir(f, OTHER_PROJECT_ID, "web"))).toBe(true);
    expect(existsSync(f.manifestPath)).toBe(true);
    const manifest = parseYaml(readFileSync(f.manifestPath, "utf8")) as { id?: string };
    expect(manifest.id).toBe(OTHER_PROJECT_ID);
    expect(existsSync(f.projectRoot)).toBe(true);
  });
});
