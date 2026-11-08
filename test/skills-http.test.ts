import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
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

function _writeRepositorySkill(appDir: string, name: string, bodyName = name): void {
  const dir = path.join(appDir, ".opencode", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${bodyName}\ndescription: "repository copy"\n---\n\n# Repository copy\n`,
    "utf8",
  );
}

function _writePluginSkill(pluginRoot: string, name: string): void {
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

function _corruptMetadata(f: Fixture, id: number, raw = "{not json"): void {
  withIgnoredChecks(f, () => {
    f.db.prepare("UPDATE skills SET metadata_json = ? WHERE id = ?").run(raw, id);
  });
}

function _insertInvalidName(
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

function _bundleFromPage(body: string): Record<string, unknown> {
  const match = /name="bundle" value="([^"]*)"/.exec(body);
  if (match === null) {
    throw new Error("bundle snapshot not found");
  }
  return JSON.parse(decodeAttribute(match[1] ?? "")) as Record<string, unknown>;
}

async function _page(
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
  it("matches API shapes only", () => {
    for (const pathname of ["/api/skills", "/api/skills/12", "/api/skills/12/delete"]) {
      expect(isSkillsRoute(pathname.endsWith("/delete") ? "POST" : "GET", pathname)).toBe(true);
    }
    expect(isSkillsRoute("POST", "/api/skills")).toBe(true);
    expect(isSkillsRoute("DELETE", "/api/skills/12")).toBe(true);
    for (const pathname of ["/skills", "/skills/new", "/skills/12", "/projects/p1/skills"]) {
      expect(isSkillsRoute("GET", pathname), pathname).toBe(false);
    }
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
});

describe("create page", () => {
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

  it("accepts a 5 MiB skills body and rejects one above the 16 MiB bound", async () => {
    const f = fixture();
    const port = await listen(f);
    const padding = "x".repeat(5 * 1024 * 1024);
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
      body: `padding=${"x".repeat(17 * 1024 * 1024)}`,
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
});
