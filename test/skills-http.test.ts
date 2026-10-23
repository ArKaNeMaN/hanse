import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { handleSkills, isSkillsRoute } from "../src/http/skills.js";
import { absoluteTime } from "../src/http/ui.js";
import { createPrincipal } from "../src/identity/principals.js";
import { SkillService } from "../src/skills/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  skills: SkillService;
  token: string;
  agentToken: string;
  dir: string;
  projectRoot: string;
  appDir: string;
}

function fixture(options: { pending?: boolean } = {}): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skills-http-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  const projectRoot = path.join(workspace, "p1");
  const appDir = path.join(projectRoot, "apps", "web");
  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(path.join(projectRoot, "apps", "api"), { recursive: true });
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Alpha','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:web','p1','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:api','p1','api','apps/api','app','AGENTS.md',?)",
  ).run(now);
  const skills = new SkillService({ db });
  const token = createPrincipal(db, { kind: "human", name: "alice" }).token;
  const agentToken = createPrincipal(db, { kind: "agent", name: "bot" }).token;
  const deps: HttpDeps = {
    db,
    workspaceRoot: workspace,
    git: new GitService({ workspaceRoot: workspace }),
    skills,
    agentsHome: path.join(dir, "agents"),
    baselinePlugins: [],
    ...(options.pending === true
      ? { manager: { pendingRestart: () => ({ pending: true, reasons: ["skills"] }) } }
      : {}),
    getProjects: () => [
      {
        id: "p1",
        name: "Alpha",
        rootPath: projectRoot,
        workspaceRoot: workspace,
        service: new CoordinatorService(db, "p1"),
      },
    ],
  };
  return { db, deps, skills, token, agentToken, dir, projectRoot, appDir };
}

function auth(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

function htmlAuth(token: string): Record<string, string> {
  return auth(token, { accept: "text/html" });
}

function formRequest(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return auth(token, {
    "content-type": "application/x-www-form-urlencoded",
    ...extra,
  });
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", path: "/api/skills", headers: {}, query: {}, ...overrides };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function writeRepositorySkill(appDir: string, name: string, bodyName = name): void {
  const dir = path.join(appDir, ".opencode", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${bodyName}\ndescription: "repository copy"\n---\n\n# Repository copy\n`,
    "utf8",
  );
}

function writePluginSkill(pluginRoot: string, name: string): void {
  const dir = path.join(pluginRoot, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "plugin copy"\n---\n\n# Plugin copy\n`,
    "utf8",
  );
}

function withIgnoredChecks(f: Fixture, action: () => void): void {
  f.db.pragma("ignore_check_constraints = ON");
  try {
    action();
  } finally {
    f.db.pragma("ignore_check_constraints = OFF");
  }
}

function corruptMetadata(f: Fixture, id: number, raw = "{not json"): void {
  withIgnoredChecks(f, () => {
    f.db.prepare("UPDATE skills SET metadata_json = ? WHERE id = ?").run(raw, id);
  });
}

function insertInvalidName(
  f: Fixture,
  scope: "global" | "project" | "app",
  name: string,
  enabled: boolean,
): number {
  const projectId = scope === "global" ? "" : "p1";
  const appKey = scope === "app" ? "web" : "";
  const now = new Date().toISOString();
  let id = 0;
  withIgnoredChecks(f, () => {
    const result = f.db
      .prepare(
        `INSERT INTO skills
           (scope, project_id, app_key, name, description, content, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'forged', 'forged body', ?, ?, ?)`,
      )
      .run(scope, projectId, appKey, name, enabled ? 1 : 0, now, now);
    id = Number(result.lastInsertRowid);
  });
  return id;
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function bundleFromPage(body: string): Record<string, unknown> {
  const match = /name="bundle" value="([^"]*)"/.exec(body);
  if (match === null) {
    throw new Error("bundle snapshot not found");
  }
  return JSON.parse(decodeAttribute(match[1] ?? "")) as Record<string, unknown>;
}

async function page(
  f: Fixture,
  pathname: string,
  query: Record<string, string> = {},
): Promise<string> {
  const response = await handleSkills(
    f.deps,
    request({ path: pathname, query, headers: htmlAuth(f.token) }),
  );
  expect(response.status).toBe(200);
  return response.body;
}

async function listen(f: Fixture): Promise<number> {
  const server = createHttpServer(f.deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

describe("skills routes", () => {
  it("matches every page and API shape, with /skills/new before numeric ids", () => {
    for (const pathname of [
      "/skills",
      "/skills/new",
      "/skills/12",
      "/projects/p1/skills",
      "/projects/p1/apps/web/skills",
      "/api/skills",
      "/api/skills/12",
      "/api/skills/12/delete",
    ]) {
      expect(isSkillsRoute(pathname.endsWith("/delete") ? "POST" : "GET", pathname)).toBe(true);
    }
    expect(isSkillsRoute("POST", "/api/skills")).toBe(true);
    expect(isSkillsRoute("DELETE", "/api/skills/12")).toBe(true);
    expect(isSkillsRoute("POST", "/skills")).toBe(false);
    expect(isSkillsRoute("POST", "/skills/new")).toBe(false);
    expect(isSkillsRoute("POST", "/skills/12")).toBe(false);
    expect(isSkillsRoute("GET", "/skills/not-a-number")).toBe(false);
    expect(isSkillsRoute("GET", "/api/skills/12/delete")).toBe(false);
  });

  it("returns 401 for anonymous JSON and redirects anonymous browsers", async () => {
    const f = fixture();
    const api = await handleSkills(f.deps, request());
    expect(api.status).toBe(401);
    expect(api.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(api.body)).toMatchObject({ code: "unauthorized" });

    for (const pathname of ["/skills", "/skills/new"]) {
      const pageResponse = await handleSkills(
        f.deps,
        request({ path: pathname, headers: htmlAuth("") }),
      );
      expect(pageResponse.status).toBe(303);
      expect(pageResponse.headers?.location).toBe(`/login?next=${encodeURIComponent(pathname)}`);
    }
  });

  it("returns 403 for agent principals on pages, APIs, and the workspace", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "one", description: "One", content: "body" },
      "owner",
    );
    for (const requestOverride of [
      request({ headers: auth(f.agentToken) }),
      request({ path: "/skills", headers: htmlAuth(f.agentToken) }),
      request({ path: "/skills/new", headers: htmlAuth(f.agentToken) }),
      request({ path: `/skills/${row.id}`, headers: htmlAuth(f.agentToken) }),
      request({
        method: "POST",
        path: "/api/skills",
        headers: auth(f.agentToken),
        body: form({ action: "create", scope: "global" }),
      }),
    ]) {
      const response = await handleSkills(f.deps, requestOverride);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).code).toBe("human_only");
    }
  });

  it("rejects cross-site and null origins on mutations", async () => {
    const f = fixture();
    for (const origin of ["https://evil.example", "null"]) {
      const response = await handleSkills(
        f.deps,
        request({
          method: "POST",
          path: "/api/skills",
          headers: formRequest(f.token),
          body: form({
            action: "create",
            scope: "global",
            name: "blocked",
            description: "blocked",
            content: "blocked",
          }),
          origin,
          host: "app.example",
        }),
      );
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).code).toBe("cross_origin");
    }

    const sameOrigin = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "create",
          scope: "global",
          name: "allowed",
          description: "allowed",
          content: "allowed",
        }),
        origin: "https://app.example",
        host: "app.example",
      }),
    );
    expect(sameOrigin.status).toBe(200);
  });

  it("validates return_to and never redirects off-site", async () => {
    const f = fixture();
    for (const [index, returnTo] of [
      "//evil.example",
      "/\\evil.example",
      "/login",
      "https://evil.example",
    ].entries()) {
      const response = await handleSkills(
        f.deps,
        request({
          method: "POST",
          path: "/api/skills",
          headers: htmlAuth(f.token),
          body: form({
            action: "create",
            scope: "global",
            name: `escape-${index}`,
            description: "description",
            content: "content",
            return_to: returnTo,
          }),
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers?.location?.startsWith("/skills/")).toBe(true);
      expect(response.headers?.location).not.toContain("evil.example");
    }
  });

  it("ignores from contexts that are unsafe or wider than the row", async () => {
    const f = fixture();
    const row = f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "alpha", description: "Alpha", content: "body" },
      "owner",
    );
    const response = await handleSkills(
      f.deps,
      request({
        path: `/skills/${row.id}`,
        query: { from: "/skills" },
        headers: htmlAuth(f.token),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain("data-skill-form");
    expect(response.body).toContain("Save changes");

    const unsafe = await handleSkills(
      f.deps,
      request({
        path: `/skills/${row.id}`,
        query: { from: "//evil.example/skills" },
        headers: htmlAuth(f.token),
      }),
    );
    expect(unsafe.status).toBe(200);
    expect(unsafe.body).toContain("Save changes");
  });
});

describe("skills inventory", () => {
  function seedHierarchy(f: Fixture): void {
    f.skills.create(
      "global",
      {},
      { name: "shared", description: "Global shared", content: "global body" },
      "owner",
    );
    f.skills.create(
      "global",
      {},
      { name: "global-only", description: "Global only", content: "global only body" },
      "owner",
    );
    f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "project-only", description: "Project only", content: "project body" },
      "owner",
    );
    f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "shared", description: "Project tombstone", content: "tombstone", enabled: false },
      "owner",
    );
    f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      { name: "app-only", description: "App only", content: "app body" },
      "owner",
    );
  }

  it("renders one inventory table with scope nav, search, filters, and no editor", async () => {
    const f = fixture();
    seedHierarchy(f);
    for (const pathname of ["/skills", "/projects/p1/skills", "/projects/p1/apps/web/skills"]) {
      const response = await handleSkills(
        f.deps,
        request({ path: pathname, headers: htmlAuth(f.token) }),
      );
      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/html");
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(response.body).toContain(">Skills</h1>");
      expect(response.body).toContain("data-skill-inventory");
      expect(response.body).toContain('class="settings-nav"');
      expect(response.body).toContain('id="skill-search"');
      expect(response.body).toContain(">Defined here</a>");
      expect(response.body).toContain(">Inherited</a>");
      expect(response.body).toContain(">Disabled</a>");
      expect(response.body).toContain(">Invalid</a>");
      expect(response.body).toContain("/skills/new?");
      expect(response.body).not.toContain('id="skills-surface"');
      expect(response.body).not.toContain("/assets/skills.js");
      expect(response.body).not.toContain("data-skill-form");
      expect(response.body).not.toContain('name="content"');
      expect(response.body).toContain("Scope &amp; inheritance");
    }

    const project = await page(f, "/projects/p1/skills");
    expect(project).toContain("project-only");
    expect(project).toContain("global-only");
    expect(project).toContain("shared");
    expect(project).toContain("Inherited from Global");
    expect(project).toContain("Disabled here");
    expect(project).toContain('data-skill-name="shared"');
    expect(project).toContain("/skills/");

    const app = await page(f, "/projects/p1/apps/web/skills");
    expect(app).toContain("app-only");
    expect(app).toContain("Inherited from Global");
  });

  it("renders the winning row's Updated value for inherited inventory rows", async () => {
    const f = fixture();
    const global = f.skills.create(
      "global",
      {},
      { name: "global-only", description: "Global only", content: "global body" },
      "owner",
    );

    const body = await page(f, "/projects/p1/skills");
    const start = body.indexOf('data-skill-name="global-only"');
    expect(start).toBeGreaterThanOrEqual(0);
    const rowHtml = body.slice(start, body.indexOf("</tr>", start));
    expect(rowHtml).toContain('data-skill-state="inherited"');
    expect(rowHtml).toContain(`title="${global.updatedAt}"`);
    expect(rowHtml).toContain(`>${absoluteTime(global.updatedAt)}<`);
    expect(rowHtml).not.toContain("&mdash;");
  });

  it("merges an effective wider row and an invalid scoped row into Invalid local override", async () => {
    const f = fixture();
    const global = f.skills.create(
      "global",
      {},
      { name: "alpha", description: "Global alpha", content: "global" },
      "owner",
    );
    const scoped = f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "alpha", description: "Project alpha", content: "project" },
      "owner",
    );
    corruptMetadata(f, scoped.id);

    const body = await page(f, "/projects/p1/skills");
    expect(body).toContain("Invalid local override");
    expect(body).toContain("Effective source: Global");
    expect(body).toContain(`href="/skills/${scoped.id}?from=`);
    expect(body).toContain(`href="/skills/${global.id}?from=`);
    expect(body).toContain("data-skill-effective-link");
    expect(body.match(/data-skill-name="alpha"/g)?.length).toBe(1);

    const invalid = await page(f, "/projects/p1/skills", { filter: "invalid" });
    expect(invalid).toContain("Invalid local override");

    const inherited = await page(f, "/projects/p1/skills", { filter: "inherited" });
    expect(inherited).not.toContain("Invalid local override");
    expect(inherited).not.toContain('data-skill-name="alpha"');
  });

  it("shows an invalid-name tombstone as Invalid here, not Disabled here", async () => {
    const f = fixture();
    f.skills.create("global", {}, { name: "safe", description: "Safe", content: "safe" }, "owner");
    const forged = insertInvalidName(f, "global", "../hidden", false);
    const body = await page(f, "/skills");
    expect(body).toContain(`href="/skills/${forged}?from=`);
    expect(body).toContain("Invalid here");
    expect(body).not.toContain("Disabled here");
    const disabled = await page(f, "/skills", { filter: "disabled" });
    expect(disabled).not.toContain("../hidden");
  });

  it("supports search, filter-empty, and all-empty states", async () => {
    const f = fixture();
    const empty = await page(f, "/skills");
    expect(empty).toContain("No skills here yet");
    expect(empty).toContain("Create the first skill");

    f.skills.create(
      "global",
      {},
      { name: "alpha", description: "Alpha skill", content: "body" },
      "owner",
    );
    f.skills.create(
      "global",
      {},
      { name: "beta", description: "Beta skill", content: "body" },
      "owner",
    );
    const found = await page(f, "/skills", { q: "alph" });
    expect(found).toContain("alpha");
    expect(found).not.toContain(">beta</a>");

    const missing = await page(f, "/skills", { q: "nothing" });
    expect(missing).toContain("No skills match your search");
    expect(missing).toContain("Clear search");

    const filtered = await page(f, "/skills", { filter: "disabled" });
    expect(filtered).toContain("No skills match this filter");
    expect(filtered).toContain("Show all skills");
  });

  it("renders the restart rail when running apps are stale", async () => {
    const f = fixture({ pending: true });
    f.skills.create(
      "global",
      {},
      { name: "alpha", description: "Alpha", content: "body" },
      "owner",
    );
    const body = await page(f, "/skills");
    expect(body).toContain("Restart required");
    expect(body).toContain("Restart agent");
    expect(body).toContain("data-skill-restart-rail");
  });

  it("surfaces repository and plugin collision warnings on the application page", async () => {
    const f = fixture();
    f.skills.create(
      "global",
      {},
      { name: "repo-skill", description: "Repo collision", content: "body" },
      "owner",
    );
    f.skills.create(
      "global",
      {},
      { name: "plugin-skill", description: "Plugin collision", content: "body" },
      "owner",
    );
    writeRepositorySkill(f.appDir, "repo-skill");
    const pluginRoot = path.join(f.dir, "plugin");
    writePluginSkill(pluginRoot, "plugin-skill");
    f.deps.baselinePlugins = [pathToFileURL(pluginRoot).href];

    const app = await page(f, "/projects/p1/apps/web/skills");
    expect(app).toContain("repo-skill");
    expect(app).toContain("plugin-skill");
    expect(app).toMatch(/also exists at/);
    expect(app).toContain("Skill root warnings");
    expect(existsSync(f.deps.agentsHome ?? "")).toBe(false);

    const global = await page(f, "/skills");
    expect(global).not.toContain("also exists at");
  });
});

describe("skill workspace", () => {
  function seedStates(f: Fixture): {
    sharedGlobal: number;
    sharedProject: number;
    tombGlobal: number;
    tombProject: number;
    onlyGlobal: number;
    offGlobal: number;
    badApp: number;
  } {
    const sharedGlobal = f.skills.create(
      "global",
      {},
      { name: "shared", description: "Global shared", content: "global body" },
      "owner",
    ).id;
    const sharedProject = f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "shared", description: "Project shared", content: "project body" },
      "owner",
    ).id;
    const tombGlobal = f.skills.create(
      "global",
      {},
      { name: "tomb", description: "Global tomb", content: "global tomb body" },
      "owner",
    ).id;
    const tombProject = f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "tomb", description: "Project tomb", content: "project tomb", enabled: false },
      "owner",
    ).id;
    const onlyGlobal = f.skills.create(
      "global",
      {},
      { name: "only", description: "Only", content: "only body" },
      "owner",
    ).id;
    const offGlobal = f.skills.create(
      "global",
      {},
      { name: "off", description: "Off", content: "off body", enabled: false },
      "owner",
    ).id;
    const badApp = f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      { name: "bad", description: "Bad app", content: "bad body" },
      "owner",
    ).id;
    corruptMetadata(f, badApp);
    return { sharedGlobal, sharedProject, tombGlobal, tombProject, onlyGlobal, offGlobal, badApp };
  }

  it("selects D5 states from the viewing context", async () => {
    const f = fixture();
    const ids = seedStates(f);
    const appFrom = "/projects/p1/apps/web/skills";
    const projectFrom = "/projects/p1/skills";

    const shadowed = await page(f, `/skills/${ids.sharedGlobal}`, { from: appFrom });
    expect(shadowed).toContain("Shadowed");
    expect(shadowed).toContain("Edit at source");
    expect(shadowed).toContain("Open effective source");
    expect(shadowed).not.toContain("data-skill-override");
    expect(shadowed).not.toContain('name="content"');

    const hidden = await page(f, `/skills/${ids.tombGlobal}`, { from: projectFrom });
    expect(hidden).toContain("Hidden at this context");
    expect(hidden).toContain("Open tombstone");
    expect(hidden).toContain("Revert to inherited");
    expect(hidden).toContain(`href="/skills/${ids.tombProject}?from=`);

    const inherited = await page(f, `/skills/${ids.onlyGlobal}`, { from: appFrom });
    expect(inherited).toContain("Inherited");
    expect(inherited).toContain("data-skill-override");
    expect(inherited).toContain("Disable here");
    expect(inherited).toContain("Edit at source");
    expect(inherited).toContain("<pre");
    expect(inherited).not.toContain('name="content"');

    const bad = await page(f, `/skills/${ids.badApp}`, { from: appFrom });
    expect(bad).toContain("Invalid here");
    expect(bad).toContain("Issues");
    expect(bad).toContain("data-skill-metadata-raw");
    expect(bad).toContain("Raw metadata JSON");
    expect(bad).toContain("Save changes");

    const notEffective = await page(f, `/skills/${ids.offGlobal}`, { from: appFrom });
    expect(notEffective).toContain("Not effective here");
    expect(notEffective).toContain("Open source");
    expect(notEffective).not.toContain("data-skill-override");
  });

  it("offers delete and re-create for an invalid-name row", async () => {
    const f = fixture();
    const forged = insertInvalidName(f, "global", "../hidden", true);
    const body = await page(f, `/skills/${forged}`);
    expect(body).toContain("The stored name is invalid");
    expect(body).toContain("Delete and re-create");
    expect(body).toContain(`action="/api/skills/${forged}/delete"`);
    expect(body).toContain('name="confirm_name"');
  });

  it("renders the editable workspace with details, bundle form, source, preview, and danger zone", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      {
        name: "workspace-skill",
        description: "Workspace description",
        content: "# Body\n\nText.",
        license: "MIT",
        compatibility: "Node >= 20",
        metadata: { author: "owner", version: "1.2.3", domain: "engineering" },
        references: [
          { path: "references/guide.md", content: "Guide body" },
          { path: "references/second.md", content: "Second body" },
        ],
      },
      "owner",
    );
    const body = await page(f, `/skills/${row.id}`);
    expect(body).toContain("Identity");
    expect(body).toContain("Classification");
    expect(body).toContain("Discovery");
    expect(body).toContain("Version and license");
    expect(body).toContain("Custom metadata");
    expect(body).toContain("Operating scope");
    expect(body).toContain("Compatibility");
    expect(body).toContain("data-skill-preview");
    expect(body).toContain("data-skill-editbar");
    expect(body).toContain("data-skill-danger");
    expect(body).toContain("References");
    expect(body).toContain("references/guide.md");
    expect(body).toContain("references/second.md");
    expect(body).toContain("data-skill-add-reference");
    expect(body).toContain("data-skill-reference-template");
    expect(body).toContain("data-skill-metadata-template");
    expect(body.match(/data-skill-form/g)?.length).toBe(1);
    expect(body).toContain('<script type="module" src="/assets/skill-detail.js"></script>');
    expect(body).toContain("Save changes");
    expect(body).toContain("Discard changes");
    expect(body).toContain("Enabled here");
    expect(body).toContain("Back to skills");

    const bundle = bundleFromPage(body);
    expect(bundle).toMatchObject({
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "owner", version: "1.2.3", domain: "engineering" },
      references: [
        { path: "references/guide.md", content: "Guide body" },
        { path: "references/second.md", content: "Second body" },
      ],
    });
    expect(Object.keys(bundle)).not.toContain("metadataRaw");
  });

  it("renders metadata, license, compatibility, and reference controls disabled and unnamed", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      {
        name: "nojs-skill",
        description: "No JS",
        content: "Body",
        license: "MIT",
        compatibility: "any",
        metadata: { role: "engineer" },
        references: [{ path: "references/guide.md", content: "Guide" }],
      },
      "owner",
    );
    const body = await page(f, `/skills/${row.id}`);
    expect(body).not.toContain('name="metadata"');
    expect(body).not.toContain('name="license"');
    expect(body).not.toContain('name="compatibility"');
    expect(body).not.toContain('name="references"');
    expect(body).toContain('id="skill-license"');
    expect(body).toMatch(/id="skill-license"[^>]*disabled/);
    expect(body).toMatch(/id="skill-metadata-role"[^>]*disabled/);
    expect(body).toMatch(/<textarea[^>]*disabled[^>]*data-skill-reference-content/);
    expect(body.match(/data-skill-file-path=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain('name="bundle"');
    expect(body).toContain('name="content"');
  });

  it("preserves the hidden bundle snapshot when a no-JS body/description save is posted", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      {
        name: "snapshot-skill",
        description: "Before",
        content: "Before body",
        license: "MIT",
        compatibility: "Node >= 20",
        metadata: { author: "owner", version: "1.0.0" },
        references: [{ path: "references/guide.md", content: "Guide body" }],
      },
      "owner",
    );
    const body = await page(f, `/skills/${row.id}`);
    const bundle = bundleFromPage(body);
    const response = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${row.id}`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "update",
          description: "After",
          content: "After body",
          enabled: "1",
          bundle: JSON.stringify(bundle),
          return_to: `/skills/${row.id}`,
        }),
      }),
    );
    expect(response.status).toBe(303);

    const detail = await handleSkills(
      f.deps,
      request({ path: `/api/skills/${row.id}`, headers: auth(f.token) }),
    );
    const payload = JSON.parse(detail.body) as {
      skill: {
        description: string;
        content: string;
        license: string | null;
        compatibility: string | null;
        metadata: Record<string, string>;
        references: Array<{ path: string; content: string }>;
      };
    };
    expect(payload.skill).toMatchObject({
      description: "After",
      content: "After body",
      license: "MIT",
      compatibility: "Node >= 20",
      metadata: { author: "owner", version: "1.0.0" },
      references: [{ path: "references/guide.md", content: "Guide body" }],
    });
  });

  it("preserves invalid metadata raw JSON on a no-JS body save and exposes repair", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "corrupt", description: "Before", content: "Before body" },
      "owner",
    );
    corruptMetadata(f, row.id, '{"author":');
    const body = await page(f, `/skills/${row.id}`);
    expect(body).toContain("Issues");
    expect(body).toContain("&quot;author&quot;:");
    expect(body).toContain("Repair");
    const bundle = bundleFromPage(body);
    expect(bundle.metadataRaw).toBe('{"author":');

    const response = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${row.id}`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "update",
          description: "After",
          content: "After body",
          enabled: "1",
          bundle: JSON.stringify(bundle),
        }),
      }),
    );
    expect(response.status).toBe(303);
    const stored = f.skills.get(row.id);
    expect(stored?.metadataRaw).toBe('{"author":');
    expect(stored?.description).toBe("After");
  });

  it("preserves an invalid stored reference on a no-JS body save", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      {
        name: "bad-reference",
        description: "Before",
        content: "Before body",
        references: [{ path: "references/good.md", content: "good" }],
      },
      "owner",
    );
    withIgnoredChecks(f, () => {
      f.db
        .prepare("UPDATE skill_references SET path = ? WHERE skill_id = ?")
        .run("references/bad name.md", row.id);
    });
    const body = await page(f, `/skills/${row.id}`);
    expect(body).toContain("Issues");
    const bundle = bundleFromPage(body);
    expect(bundle.preserveInvalid).toBe(true);
    expect(bundle.references).toEqual([{ path: "references/bad name.md", content: "good" }]);

    const response = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${row.id}`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "update",
          description: "After",
          content: "After body",
          enabled: "1",
          bundle: JSON.stringify(bundle),
        }),
      }),
    );
    expect(response.status).toBe(303);
    const stored = f.skills.get(row.id);
    expect(stored?.description).toBe("After");
    expect(stored?.references[0]?.path).toBe("references/bad name.md");
  });

  it("re-renders the workspace with submitted values on 422 validation", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "validation", description: "Before", content: "Before body" },
      "owner",
    );
    const bundle = bundleFromPage(await page(f, `/skills/${row.id}`));
    const response = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${row.id}`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "update",
          description: "Submitted description",
          content: "",
          enabled: "1",
          bundle: JSON.stringify(bundle),
        }),
      }),
    );
    expect(response.status).toBe(422);
    expect(response.body).toContain("Submitted description");
    expect(response.body).toContain("content must not be empty");
    expect(response.body).toContain('aria-describedby="skill-content-error"');
  });

  it("runs no-JS override, disable, enable, revert, discard, and delete actions", async () => {
    const f = fixture();
    const global = f.skills.create(
      "global",
      {},
      { name: "shared", description: "Global shared", content: "global body" },
      "owner",
    );
    const inherited = await page(f, `/skills/${global.id}`, {
      from: "/projects/p1/skills",
    });
    expect(inherited).toContain("data-skill-override");

    const override = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "override",
          scope: "project",
          project: "p1",
          from_id: String(global.id),
          enabled: "1",
          return_to: "/projects/p1/skills",
        }),
      }),
    );
    expect(override.status).toBe(303);
    expect(f.skills.resolve({ projectId: "p1" }).effective[0]?.source).toBe("project");

    const projectRow = f.skills.resolve({ projectId: "p1" }).rows[0];
    expect(projectRow).toBeDefined();
    const disable = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${projectRow?.id}`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "update",
          enabled: "0",
          return_to: "/projects/p1/skills",
        }),
      }),
    );
    expect(disable.status).toBe(303);
    expect(f.skills.resolve({ projectId: "p1" }).effective).toHaveLength(0);
    expect(f.skills.resolve({ projectId: "p1" }).disabled[0]?.name).toBe("shared");

    const tombstone = f.skills.resolve({ projectId: "p1" }).disabled[0];
    expect(tombstone).toBeDefined();
    const enable = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${tombstone?.id}`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "update",
          enabled: "1",
          return_to: "/projects/p1/skills",
        }),
      }),
    );
    expect(enable.status).toBe(303);
    expect(f.skills.resolve({ projectId: "p1" }).effective[0]?.source).toBe("project");

    const discard = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${tombstone?.id}`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "discard",
          description: "Ignored",
          content: "Ignored",
          return_to: "/projects/p1/skills",
        }),
      }),
    );
    expect(discard.status).toBe(303);
    expect(f.skills.get(tombstone?.id ?? 0)?.description).toBe("Global shared");

    const mismatch = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${tombstone?.id}/delete`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({ confirm_name: "wrong-name", return_to: "/projects/p1/skills" }),
      }),
    );
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toContain("does not match");
    expect(f.skills.get(tombstone?.id ?? 0)).toBeDefined();

    const revert = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${tombstone?.id}/delete`,
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({ confirm_name: "shared", return_to: "/projects/p1/skills" }),
      }),
    );
    expect(revert.status).toBe(303);
    expect(f.skills.get(tombstone?.id ?? 0)).toBeUndefined();
    expect(f.skills.resolve({ projectId: "p1" }).effective[0]?.source).toBe("global");
  });
});

describe("create page", () => {
  it("renders the create workspace for each target", async () => {
    const f = fixture();
    const global = await page(f, "/skills/new", { scope: "global" });
    expect(global).toContain("New skill");
    expect(global).toContain('name="name"');
    expect(global).toContain("Create skill");
    expect(global).toContain("Back to skills");
    expect(global).toContain("data-skill-editbar");
    expect(global).not.toContain("data-skill-file-list");
    expect(global).not.toContain("data-skill-danger");
    expect(global).toContain('<script type="module" src="/assets/skill-detail.js"></script>');
    const bundle = bundleFromPage(global);
    expect(bundle).toEqual({
      license: null,
      compatibility: null,
      metadata: {},
      references: [],
    });

    const project = await page(f, "/skills/new", { scope: "project", project: "p1" });
    expect(project).toContain("New skill");
    expect(project).toContain('name="project" value="p1"');

    const app = await page(f, "/skills/new", {
      scope: "app",
      project: "p1",
      app: "web",
    });
    expect(app).toContain('name="app" value="web"');
  });

  it("returns 404 for missing or unknown targets", async () => {
    const f = fixture();
    for (const query of [
      { scope: "project" },
      { scope: "app", project: "p1" },
      { scope: "project", project: "nope" },
      { scope: "app", project: "p1", app: "nope" },
    ]) {
      const response = await handleSkills(
        f.deps,
        request({ path: "/skills/new", query, headers: htmlAuth(f.token) }),
      );
      expect(response.status).toBe(404);
      expect(response.body).toContain("Page not found");
    }
  });

  it("creates, confirms a 409 conflict page, and re-renders 422 values", async () => {
    const f = fixture();
    const created = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "create",
          scope: "global",
          name: "created",
          description: "Created",
          content: "Created body",
          return_to: "/skills",
        }),
      }),
    );
    expect(created.status).toBe(303);
    expect(created.headers?.location?.startsWith("/skills/")).toBe(true);
    expect(created.headers?.location).toContain("notice=Skill+created.");

    const conflict = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "create",
          scope: "global",
          name: "created",
          description: "Duplicate",
          content: "Duplicate body",
        }),
      }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toContain("already exists");
    expect(conflict.body).toContain("Open the existing skill");

    const validation = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token, { accept: "text/html" }),
        body: form({
          action: "create",
          scope: "global",
          name: "incomplete",
          description: "Submitted description",
          content: "",
        }),
      }),
    );
    expect(validation.status).toBe(422);
    expect(validation.body).toContain("Submitted description");
    expect(validation.body).toContain('value="incomplete"');
    expect(validation.body).toContain("content must not be empty");
  });

  it("returns a JSON 409 and a JSON 400 validation envelope", async () => {
    const f = fixture();
    const body = {
      action: "create",
      scope: "global",
      name: "duplicate",
      description: "Duplicate",
      content: "Body",
    };
    const first = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form(body),
      }),
    );
    expect(first.status).toBe(200);
    const conflict = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form(body),
      }),
    );
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({ code: "skill_exists" });

    const invalid = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "create",
          scope: "global",
          name: "bad",
          description: "Bad",
          content: "",
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({
      code: "VALIDATION",
      field: "content",
    });
  });
});

describe("skills API", () => {
  it("reads resolution projections and a full SkillDetail", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      {
        name: "root",
        description: "Root skill",
        content: "root body",
        license: "MIT",
        compatibility: "any",
        metadata: { author: "owner" },
        references: [{ path: "references/guide.md", content: "guide" }],
      },
      "owner",
    );
    const global = await handleSkills(f.deps, request({ headers: auth(f.token) }));
    expect(global.status).toBe(200);
    const resolved = JSON.parse(global.body) as {
      scope: string;
      effective: Array<{ name: string; source: string }>;
      rows: Array<{ name: string; references: Array<{ path: string; size: number }> }>;
    };
    expect(resolved).toMatchObject({
      scope: "global",
      effective: [{ name: "root", source: "global" }],
    });
    expect(resolved.rows[0]?.references).toEqual([{ path: "references/guide.md", size: 5 }]);
    expect(JSON.stringify(resolved.rows[0])).not.toContain('"content":"guide"');

    const detail = await handleSkills(
      f.deps,
      request({ path: `/api/skills/${row.id}`, headers: auth(f.token) }),
    );
    expect(detail.status).toBe(200);
    expect(JSON.parse(detail.body)).toMatchObject({
      skill: {
        id: row.id,
        name: "root",
        license: "MIT",
        compatibility: "any",
        metadata: { author: "owner" },
        metadataRaw: null,
        references: [{ path: "references/guide.md", content: "guide", size: 5 }],
      },
    });

    const missing = await handleSkills(
      f.deps,
      request({ path: "/api/skills/9999", headers: auth(f.token) }),
    );
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body)).toMatchObject({ code: "not_found" });
  });

  it("creates and updates bundles with full metadata and reference replacement", async () => {
    const f = fixture();
    const created = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          action: "create",
          scope: "global",
          name: "bundle-skill",
          description: "Bundle",
          content: "Body",
          license: "MIT",
          compatibility: "Node >= 20",
          metadata: { author: "owner", version: "1.0.0" },
          references: [{ path: "references/one.md", content: "One" }],
        }),
      }),
    );
    expect(created.status).toBe(200);
    const id = (JSON.parse(created.body) as { skill: { id: number } }).skill.id;

    const updated = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${id}`,
        headers: formRequest(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({
          action: "update",
          metadata: { role: "engineer" },
          references: [
            { path: "references/two.md", content: "Two" },
            { path: "references/one.md", content: "One changed" },
          ],
        }),
      }),
    );
    expect(updated.status).toBe(200);
    const updatedSkill = (
      JSON.parse(updated.body) as {
        skill: {
          license: string | null;
          metadata: Record<string, string>;
          references: Array<{ path: string; content: string }>;
        };
      }
    ).skill;
    expect(updatedSkill.license).toBe("MIT");
    expect(updatedSkill.metadata).toEqual({ role: "engineer" });
    expect(
      updatedSkill.references.map((reference) => ({
        path: reference.path,
        content: reference.content,
      })),
    ).toEqual([
      { path: "references/one.md", content: "One changed" },
      { path: "references/two.md", content: "Two" },
    ]);

    const partial = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${id}`,
        headers: formRequest(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({ action: "update", description: "Partial" }),
      }),
    );
    expect(partial.status).toBe(200);
    const partialSkill = (
      JSON.parse(partial.body) as {
        skill: {
          description: string;
          metadata: Record<string, string>;
          references: Array<{ path: string; content: string }>;
        };
      }
    ).skill;
    expect(partialSkill.description).toBe("Partial");
    expect(partialSkill.metadata).toEqual({ role: "engineer" });
    expect(
      partialSkill.references.map((reference) => ({
        path: reference.path,
        content: reference.content,
      })),
    ).toEqual([
      { path: "references/one.md", content: "One changed" },
      { path: "references/two.md", content: "Two" },
    ]);

    const cleared = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${id}`,
        headers: formRequest(f.token, { "content-type": "application/json" }),
        body: JSON.stringify({ action: "update", metadata: {}, references: [] }),
      }),
    );
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body)).toMatchObject({
      skill: { metadata: {}, references: [] },
    });
  });

  it("returns the error envelope, keeps action=delete, and ignores the old fragment header", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "delete-me", description: "Delete", content: "Body" },
      "owner",
    );
    const malformed = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toMatchObject({ code: "invalid_body" });

    const legacy = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token, { "x-hanse-fragment": "skills" }),
        body: form({
          action: "create",
          scope: "global",
          name: "fragment-skill",
          description: "Fragment",
          content: "Body",
        }),
      }),
    );
    expect(legacy.status).toBe(200);
    const legacyPayload = JSON.parse(legacy.body) as Record<string, unknown>;
    expect(legacyPayload.skill).toBeDefined();
    expect(legacyPayload.surface).toBeUndefined();
    expect(legacyPayload.ok).toBeUndefined();

    const deleted = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${row.id}`,
        headers: formRequest(f.token),
        body: form({ action: "delete" }),
      }),
    );
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({ deleted: true });
    expect(f.skills.get(row.id)).toBeUndefined();
  });

  it("escapes skill text and the bundle snapshot", async () => {
    const f = fixture();
    const description = '<script>alert("description")</script>';
    const content = '"quoted" <b>bold</b> <script>alert(1)</script>';
    const created = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "create",
          scope: "global",
          name: "escaped",
          description,
          content,
        }),
      }),
    );
    expect(created.status).toBe(200);
    const id = (JSON.parse(created.body) as { skill: { id: number } }).skill.id;

    const inventory = await page(f, "/skills");
    expect(inventory).not.toContain("<script>alert");
    expect(inventory).not.toContain("<b>bold</b>");
    expect(inventory).toContain("&lt;script&gt;alert");

    const workspace = await page(f, `/skills/${id}`);
    expect(workspace).not.toContain("<script>alert");
    expect(workspace).toContain("&lt;script&gt;alert");
    const bundle = bundleFromPage(workspace);
    expect(bundle.references).toEqual([]);

    const invalidName = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "create",
          scope: "global",
          name: "<script>",
          description: "d",
          content: "c",
        }),
      }),
    );
    expect(invalidName.status).toBe(400);
    expect(JSON.parse(invalidName.body).field).toBe("name");
  });

  it("accepts a 4 MiB skills body and rejects one above the bound", async () => {
    const f = fixture();
    const port = await listen(f);
    const padding = "x".repeat(1024 * 1024);
    const accepted = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      method: "POST",
      headers: {
        ...auth(f.token),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({
        action: "create",
        scope: "global",
        name: "large",
        description: "Large",
        content: "Body",
        padding,
      }),
    });
    expect(accepted.status).toBe(200);

    const rejected = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      method: "POST",
      headers: {
        ...auth(f.token),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `padding=${"x".repeat(5 * 1024 * 1024)}`,
    });
    expect(rejected.status).toBe(413);
    expect(JSON.parse(await rejected.text())).toMatchObject({ code: "payload_too_large" });

    const general = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: {
        ...auth(f.token),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `padding=${"x".repeat(70 * 1024)}`,
    });
    expect(general.status).toBe(413);
  });

  it("serves the workspace and create pages through the HTTP server", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "over-http", description: "Over HTTP", content: "body" },
      "owner",
    );
    const port = await listen(f);
    const pages = [
      { pathname: "/skills", title: ">Skills</h1>" },
      { pathname: "/skills/new", title: ">New skill</h1>" },
      { pathname: `/skills/${row.id}`, title: ">over-http</h1>" },
    ];
    for (const entry of pages) {
      const response = await fetch(`http://127.0.0.1:${port}${entry.pathname}`, {
        headers: htmlAuth(f.token),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(entry.title);
      expect(body).not.toContain("skills-surface");
    }
    const workspace = await fetch(`http://127.0.0.1:${port}/skills/${row.id}`, {
      headers: htmlAuth(f.token),
    });
    expect(await workspace.text()).toContain("skill-detail.js");
  });
});
