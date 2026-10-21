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

function fixture(): Fixture {
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

describe("skills routes", () => {
  it("matches every page and API shape", () => {
    for (const pathname of [
      "/skills",
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
    expect(isSkillsRoute("GET", "/api/skills/12/delete")).toBe(false);
  });
});

describe("skills auth", () => {
  it("returns 401 for anonymous JSON and redirects anonymous browsers", async () => {
    const f = fixture();
    const api = await handleSkills(f.deps, request());
    expect(api.status).toBe(401);
    expect(api.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(api.body)).toEqual({ error: "sign in required" });

    const page = await handleSkills(f.deps, request({ path: "/skills", headers: htmlAuth("") }));
    expect(page.status).toBe(303);
    expect(page.headers?.location).toBe("/login?next=%2Fskills");

    const fragment = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: { "x-hanse-fragment": "skills" },
        body: form({ action: "create", scope: "global" }),
      }),
    );
    expect(fragment.status).toBe(401);
    expect(fragment.contentType).toContain("application/json");
  });

  it("returns 403 for agent principals on pages, API, and fragments", async () => {
    const f = fixture();
    for (const requestOverride of [
      request({ headers: auth(f.agentToken) }),
      request({ path: "/skills", headers: htmlAuth(f.agentToken) }),
      request({
        method: "POST",
        path: "/api/skills",
        headers: auth(f.agentToken, { "x-hanse-fragment": "skills" }),
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
      expect(response.headers?.location?.startsWith("/skills?")).toBe(true);
      expect(response.headers?.location).not.toContain("evil.example");
    }
  });
});

describe("skills pages", () => {
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

  it("renders all three scopes with the scope-aware shell nav", async () => {
    const f = fixture();
    seedHierarchy(f);
    const pages = [
      { path: "/skills", nav: "/skills" },
      { path: "/projects/p1/skills", nav: "/projects/p1/skills" },
      { path: "/projects/p1/apps/web/skills", nav: "/projects/p1/apps/web/skills" },
    ];
    for (const page of pages) {
      const response = await handleSkills(
        f.deps,
        request({ path: page.path, headers: htmlAuth(f.token) }),
      );
      expect(response.status).toBe(200);
      expect(response.contentType).toContain("text/html");
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(response.body).toContain('id="skills-surface"');
      expect(response.body).toContain(">Skills</h1>");
      expect(response.body).toContain('src="/assets/skills.js"');
      expect(response.body).toContain(
        `<a class="nav-item is-active" href="${page.nav}" aria-current="page">`,
      );
      expect(response.body).toContain('class="settings-nav"');
      expect(response.body).toContain('href="#skills-effective"');
      expect(response.body).toContain('href="#skills-defined"');
      expect(response.body).toContain('href="#skills-disabled"');
      expect(response.body).toContain('data-dialog-open="skill-new-dialog"');
      expect(response.body).toContain('id="skill-delete-dialog"');
      expect(response.body).toContain("How it works");
      expect(response.body).toContain("effective");
      expect(response.body).toContain("defined here");
    }

    const project = await handleSkills(
      f.deps,
      request({ path: "/projects/p1/skills", headers: htmlAuth(f.token) }),
    );
    expect(project.body).toContain('href="/skills">Global</a>');
    expect(project.body).toContain(">Project</span>");
    expect(project.body).toContain("global-only");
    expect(project.body).toContain("Override here");
    expect(project.body).toContain("project-only");
    expect(project.body).toContain("Edit here");
    expect(project.body).toContain("shared");
    expect(project.body).toContain("Disabled at this scope");
    expect(project.body).toContain("Enable here");
    expect(project.body).toContain("Revert to inherited");
    expect(project.body).toContain("outside this hierarchy");

    const app = await handleSkills(
      f.deps,
      request({ path: "/projects/p1/apps/web/skills", headers: htmlAuth(f.token) }),
    );
    expect(app.body).toContain('href="/projects/p1/skills">Project</a>');
    expect(app.body).toContain(">Application</span>");
    expect(app.body).toContain("app-only");
    expect(app.body).toContain("global-only");
    expect(app.body).toContain("collisions");
  });

  it("returns a styled 404 for unknown project and app scopes", async () => {
    const f = fixture();
    for (const pathname of ["/projects/nope/skills", "/projects/p1/apps/nope/skills"]) {
      const response = await handleSkills(
        f.deps,
        request({ path: pathname, headers: htmlAuth(f.token) }),
      );
      expect(response.status).toBe(404);
      expect(response.body).toContain("Page not found");
    }
  });
});

describe("skills API and fragments", () => {
  it("reads the resolution for each scope", async () => {
    const f = fixture();
    f.skills.create(
      "global",
      {},
      { name: "root", description: "Root skill", content: "root body" },
      "owner",
    );
    const global = await handleSkills(f.deps, request({ headers: auth(f.token) }));
    expect(global.status).toBe(200);
    expect(JSON.parse(global.body)).toMatchObject({
      scope: "global",
      effective: [{ name: "root", source: "global" }],
    });

    const project = await handleSkills(
      f.deps,
      request({ headers: auth(f.token), query: { project: "p1" } }),
    );
    expect(JSON.parse(project.body)).toMatchObject({ scope: "project" });

    const app = await handleSkills(
      f.deps,
      request({ headers: auth(f.token), query: { project: "p1", app: "web" } }),
    );
    expect(JSON.parse(app.body)).toMatchObject({ scope: "app" });

    const invalid = await handleSkills(
      f.deps,
      request({ headers: auth(f.token), query: { app: "web" } }),
    );
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body).code).toBe("invalid_scope_target");

    const missing = await handleSkills(
      f.deps,
      request({ headers: auth(f.token), query: { project: "p1", app: "nope" } }),
    );
    expect(missing.status).toBe(404);
  });

  it("returns one row and 404 for an unknown id", async () => {
    const f = fixture();
    const row = f.skills.create(
      "global",
      {},
      { name: "one", description: "One", content: "one body" },
      "owner",
    );
    const found = await handleSkills(
      f.deps,
      request({ path: `/api/skills/${row.id}`, headers: auth(f.token) }),
    );
    expect(found.status).toBe(200);
    expect(JSON.parse(found.body)).toMatchObject({ skill: { id: row.id, name: "one" } });

    const missing = await handleSkills(
      f.deps,
      request({ path: "/api/skills/9999", headers: auth(f.token) }),
    );
    expect(missing.status).toBe(404);
    const invalid = await handleSkills(
      f.deps,
      request({ path: "/api/skills/not-a-number", headers: auth(f.token) }),
    );
    expect(invalid.status).toBe(404);
  });

  it("creates, updates, toggles, overrides, and deletes", async () => {
    const f = fixture();
    const created = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "create",
          scope: "global",
          name: "release-checklist",
          description: "Use for releases",
          content: "# Release\n\nRun the gates.",
        }),
      }),
    );
    expect(created.status).toBe(200);
    const createdPayload = JSON.parse(created.body) as { skill: { id: number; enabled: boolean } };
    expect(createdPayload.skill.enabled).toBe(true);
    const id = createdPayload.skill.id;

    const updated = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${id}`,
        headers: formRequest(f.token),
        body: form({
          action: "update",
          description: "Updated description",
          content: "Updated body",
        }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(JSON.parse(updated.body)).toMatchObject({
      skill: { id, description: "Updated description", content: "Updated body" },
    });

    const disabled = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${id}`,
        headers: formRequest(f.token),
        body: form({ action: "update", enabled: "0" }),
      }),
    );
    expect(disabled.status).toBe(200);
    expect(JSON.parse(disabled.body)).toMatchObject({ skill: { enabled: false } });
    expect(f.skills.resolve({}).effective).toHaveLength(0);

    const enabled = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${id}`,
        headers: formRequest(f.token),
        body: form({ action: "update", enabled: "1" }),
      }),
    );
    expect(enabled.status).toBe(200);
    expect(f.skills.resolve({}).effective).toHaveLength(1);

    const override = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "override",
          scope: "project",
          project: "p1",
          from_id: String(id),
        }),
      }),
    );
    expect(override.status).toBe(200);
    const overridePayload = JSON.parse(override.body) as { skill: { id: number; scope: string } };
    expect(overridePayload.skill.scope).toBe("project");
    expect(
      f.skills
        .resolve({ projectId: "p1" })
        .effective.find((skill) => skill.name === "release-checklist")?.source,
    ).toBe("project");

    const tombstone = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "override",
          scope: "app",
          project: "p1",
          app: "web",
          from_id: String(id),
          enabled: "0",
        }),
      }),
    );
    expect(tombstone.status).toBe(200);
    expect(
      f.skills
        .resolve({ projectId: "p1", appKey: "web" })
        .disabled.find((entry) => entry.name === "release-checklist")?.id,
    ).toBeTypeOf("number");

    const deleted = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${overridePayload.skill.id}/delete`,
        headers: formRequest(f.token),
      }),
    );
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.body)).toEqual({ deleted: true });
    expect(f.skills.get(overridePayload.skill.id)).toBeUndefined();
    expect(f.skills.get(id)?.enabled).toBe(true);

    const deleteById = await handleSkills(
      f.deps,
      request({ method: "DELETE", path: `/api/skills/${id}`, headers: auth(f.token) }),
    );
    expect(deleteById.status).toBe(200);
    expect(JSON.parse(deleteById.body)).toEqual({ deleted: true });
    expect(f.skills.get(id)).toBeUndefined();
  });

  it("returns the exact fragment envelope and replaces the surface", async () => {
    const f = fixture();
    const response = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token, { "x-hanse-fragment": "skills" }),
        body: form({
          action: "create",
          scope: "global",
          name: "fragment-skill",
          description: "Fragment description",
          content: "Fragment body",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("application/json");
    expect(response.headers?.["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response.body) as {
      ok: boolean;
      surface: string;
      counts: { effective: number; defined: number };
    };
    expect(Object.keys(payload).sort()).toEqual(["counts", "ok", "surface"]);
    expect(payload.ok).toBe(true);
    expect(payload.counts).toEqual({ effective: 1, defined: 1 });
    expect(payload.surface.startsWith('<div id="skills-surface">')).toBe(true);
    expect(payload.surface.endsWith("</div>")).toBe(true);
    expect(payload.surface).toContain("fragment-skill");
    expect(payload.surface).not.toContain('id="skill-new-dialog"');
  });

  it("returns the initiating page surface when a wider tombstone is enabled from an app page", async () => {
    const f = fixture();
    f.skills.create(
      "global",
      {},
      { name: "shared", description: "Global shared", content: "global body" },
      "owner",
    );
    const tombstone = f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "shared", description: "Tombstone", content: "tombstone", enabled: false },
      "owner",
    );
    f.skills.create(
      "app",
      { projectId: "p1", appKey: "web" },
      { name: "app-only", description: "App only", content: "app body" },
      "owner",
    );

    const enabled = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${tombstone.id}`,
        headers: formRequest(f.token, { "x-hanse-fragment": "skills" }),
        body: form({
          action: "update",
          enabled: "1",
          return_to: "/projects/p1/apps/web/skills",
        }),
      }),
    );
    expect(enabled.status).toBe(200);
    const enabledPayload = JSON.parse(enabled.body) as { surface: string };
    expect(enabledPayload.surface).toContain("app-only");
    expect(enabledPayload.surface).toContain("shared");

    const reverted = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${tombstone.id}/delete`,
        headers: formRequest(f.token, { "x-hanse-fragment": "skills" }),
        body: form({ return_to: "/projects/p1/apps/web/skills" }),
      }),
    );
    expect(reverted.status).toBe(200);
    const revertedPayload = JSON.parse(reverted.body) as { surface: string };
    expect(revertedPayload.surface).toContain("app-only");
    expect(revertedPayload.surface).toContain("shared");
  });

  it("returns 409 on a create conflict and 400 for invalid actions", async () => {
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

    const bogus = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({ action: "bogus", scope: "global" }),
      }),
    );
    expect(bogus.status).toBe(400);
  });

  it("maps invalid scope targets and override sources", async () => {
    const f = fixture();
    const widened = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "create",
          scope: "global",
          project: "p1",
          name: "x",
          description: "d",
          content: "c",
        }),
      }),
    );
    expect(widened.status).toBe(400);
    expect(JSON.parse(widened.body).code).toBe("invalid_scope_target");

    const missingProject = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "create",
          scope: "project",
          name: "x",
          description: "d",
          content: "c",
        }),
      }),
    );
    expect(missingProject.status).toBe(400);
    expect(JSON.parse(missingProject.body).code).toBe("invalid_scope_target");

    const unknownSource = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({ action: "override", scope: "project", project: "p1", from_id: "9999" }),
      }),
    );
    expect(unknownSource.status).toBe(400);
    expect(JSON.parse(unknownSource.body).code).toBe("invalid_override_source");

    const disabledSource = f.skills.create(
      "global",
      {},
      { name: "off", description: "Off", content: "Off", enabled: false },
      "owner",
    );
    const disabledOverride = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: "/api/skills",
        headers: formRequest(f.token),
        body: form({
          action: "override",
          scope: "project",
          project: "p1",
          from_id: String(disabledSource.id),
        }),
      }),
    );
    expect(disabledOverride.status).toBe(400);
    expect(JSON.parse(disabledOverride.body).code).toBe("invalid_override_source");
  });

  it("escapes skill text in pages and fragments", async () => {
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

    const page = await handleSkills(
      f.deps,
      request({ path: "/skills", headers: htmlAuth(f.token) }),
    );
    expect(page.body).not.toContain("<script>alert");
    expect(page.body).not.toContain("<b>bold</b>");
    expect(page.body).toContain("&lt;script&gt;alert");
    expect(page.body).toContain("&lt;b&gt;bold&lt;/b&gt;");

    const createdPayload = JSON.parse(created.body) as { skill: { id: number } };
    const fragment = await handleSkills(
      f.deps,
      request({
        method: "POST",
        path: `/api/skills/${createdPayload.skill.id}`,
        headers: formRequest(f.token, { "x-hanse-fragment": "skills" }),
        body: form({ action: "update", description, content, enabled: "1" }),
      }),
    );
    expect(fragment.status).toBe(200);
    const fragmentPayload = JSON.parse(fragment.body) as { surface: string };
    expect(fragmentPayload.surface).not.toContain("<script>alert");
    expect(fragmentPayload.surface).toContain("&lt;script&gt;alert");

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
    f.skills.create(
      "global",
      {},
      { name: "disabled-skill", description: "Global disabled", content: "body" },
      "owner",
    );
    f.skills.create(
      "project",
      { projectId: "p1" },
      { name: "disabled-skill", description: "Tombstone", content: "tombstone", enabled: false },
      "owner",
    );
    writeRepositorySkill(f.appDir, "repo-skill");
    writeRepositorySkill(f.appDir, "disabled-skill");
    const pluginRoot = path.join(f.dir, "plugin");
    writePluginSkill(pluginRoot, "plugin-skill");
    f.deps.baselinePlugins = [pathToFileURL(pluginRoot).href];

    const app = await handleSkills(
      f.deps,
      request({ path: "/projects/p1/apps/web/skills", headers: htmlAuth(f.token) }),
    );
    expect(app.status).toBe(200);
    expect(app.body).toContain("repo-skill");
    expect(app.body).toContain("plugin-skill");
    expect(app.body).toMatch(/also exists at/);
    expect(app.body).toContain("is disabled here but also exists at");
    expect(app.body).toContain("disabled-skill");
    expect(app.body).toContain("Skill root warnings");
    expect(existsSync(f.deps.agentsHome ?? "")).toBe(false);

    const global = await handleSkills(
      f.deps,
      request({ path: "/skills", headers: htmlAuth(f.token) }),
    );
    expect(global.body).toContain("outside this hierarchy");
    expect(global.body).not.toContain("also exists at");
  });

  it("accepts a large non-ASCII skill body on the skills route only", async () => {
    const f = fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      method: "POST",
      headers: {
        ...auth(f.token),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({
        action: "create",
        scope: "global",
        name: "unicode-skill",
        description: "Unicode body",
        content: "Ю".repeat(24_000),
      }),
    });
    expect(response.status).toBe(200);
    const created = JSON.parse(await response.text()) as { skill: { content: string } };
    expect(created.skill.content.length).toBe(24_000);
  });

  it("serves the fragment through the HTTP server before the chat fallback", async () => {
    const f = fixture();
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/skills`, {
      method: "POST",
      headers: {
        ...auth(f.token),
        "content-type": "application/x-www-form-urlencoded",
        "x-hanse-fragment": "skills",
      },
      body: form({
        action: "create",
        scope: "global",
        name: "over-http",
        description: "Over HTTP",
        content: "body",
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; surface: string };
    expect(payload.ok).toBe(true);
    expect(payload.surface).toContain("over-http");

    const page = await fetch(`http://127.0.0.1:${port}/skills`, {
      headers: htmlAuth(f.token),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="skills-surface"');
  });
});
