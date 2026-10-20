import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
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
  token: string;
  settings: SettingsService;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-application-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p1','Alpha','main','/tmp/p1',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p1:storefront','p1','storefront','apps/storefront','service','AGENTS.md',?)",
  ).run(now);
  const token = createPrincipal(db, { kind: "human", name: "operator" }).token;
  const settings = new SettingsService({ db, secretKey: randomBytes(32) });
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/tmp",
    git: new GitService({ workspaceRoot: "/tmp" }),
    settings,
    getProjects: () => [
      {
        id: "p1",
        name: "Alpha",
        rootPath: "/tmp/p1",
        workspaceRoot: "/tmp",
        service: new CoordinatorService(db, "p1"),
      },
    ],
  };
  return { db, deps, token, settings };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function get(pathname: string, headers: Record<string, string> = {}): HttpRequest {
  return { method: "GET", path: pathname, headers };
}

describe("application page", () => {
  it("renders the page shell, git panel contract, and navigation", () => {
    const f = fixture();
    const response = handleRequest(f.deps, get("/projects/p1/apps/storefront", auth(f.token)));

    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain('class="app-shell"');
    expect(response.body).toContain('id="git-panel"');
    expect(response.body).toContain('data-project-id="p1"');
    expect(response.body).toContain('data-app-key="storefront"');
    expect(response.body).toContain('data-api-base="/api/projects/p1/apps/storefront/git"');
    expect(response.body).toContain(
      'id="git-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(response.body).toContain('id="repository-card"');
    expect(response.body).toContain('id="repository-title"');
    expect(response.body).toContain('id="git-refreshed"');
    expect(response.body).toContain('id="git-refresh"');
    expect(response.body).toContain('id="git-repository-body"');
    expect(response.body).toContain('id="changes-card"');
    expect(response.body).toContain('id="changes-title"');
    expect(response.body).toContain('id="git-change-counts"');
    expect(response.body).toContain('id="git-changes-body"');
    expect(response.body).toContain('id="git-remotes-body"');
    expect(response.body).toContain('id="git-last-commit-body"');
    expect(response.body).toContain('aria-busy="true"');
    expect(response.body).toContain("Loading repository status.");
    expect(response.body).toContain("/assets/git.js");
    expect(response.body).toContain("/assets/images.js");
    expect(response.body).toContain('id="image-panel"');
    expect(response.body).toContain('id="image-status" data-status="default"');
    expect(response.body).toContain("Default agent image");
    expect(response.body).toContain("shared default agent image");
    expect(response.body).not.toContain('id="image-build"');
    expect(response.body).not.toContain("Build image");
    expect(response.body).not.toContain('id="image-logs"');
    expect(response.body).not.toContain('id="image-rollback-form"');
    expect(response.body).toContain(
      "Git actions need JavaScript. Use the IDE for repository operations.",
    );
    expect(response.body).toContain(">Application</h2>");
    expect(response.body).toContain("service");
    expect(response.body).toContain("apps/storefront");
    expect(response.body).toContain('href="/projects/p1"');
    expect(response.body).toContain('href="/chat?app=storefront&amp;project=p1"');
    expect(response.body).toContain('href="/projects/p1/apps/storefront/settings"');
    expect(response.body).toContain("Application settings");
    expect(response.body).toContain("/ide/?folder=");
    expect(response.body).toContain('aria-current="page">storefront</span>');
  });

  it("keeps build controls for an app with a configured image build", () => {
    const f = fixture();
    f.db
      .prepare(
        "UPDATE apps SET image_status = 'missing', image_ref = NULL, image_hash = 'hash' WHERE id = 'p1:storefront'",
      )
      .run();

    const response = handleRequest(f.deps, get("/projects/p1/apps/storefront", auth(f.token)));

    expect(response.status).toBe(200);
    expect(response.body).toContain('id="image-build"');
    expect(response.body).toContain("Build image");
    expect(response.body).toContain('id="image-logs"');
    expect(response.body).toContain('id="image-rollback-form"');
    expect(response.body).toContain('id="image-status" data-status="missing"');
    expect(response.body).not.toContain("shared default agent image");
  });

  it("keeps the build panel visible for an invalid build configuration", () => {
    const f = fixture();
    f.db
      .prepare(
        "UPDATE apps SET image_status = 'error', image_error = 'build.dockerfile escapes the application directory' WHERE id = 'p1:storefront'",
      )
      .run();

    const response = handleRequest(f.deps, get("/projects/p1/apps/storefront", auth(f.token)));

    expect(response.status).toBe(200);
    expect(response.body).toContain('id="image-build"');
    expect(response.body).toContain("Retry build");
    expect(response.body).toContain('id="image-status" data-status="error"');
    expect(response.body).toContain("build.dockerfile escapes the application directory");
    expect(response.body).not.toContain("shared default agent image");
  });

  it("returns a styled 404 for an unknown project or application", () => {
    const f = fixture();
    for (const pathname of ["/projects/nope/apps/storefront", "/projects/p1/apps/nope"]) {
      const response = handleRequest(f.deps, get(pathname, auth(f.token)));
      expect(response.status).toBe(404);
      expect(response.contentType).toContain("text/html");
      expect(response.body).toContain("Page not found");
    }
  });

  it("shows the pending banner and restart form without leaking provider keys", () => {
    const f = fixture();
    f.settings.setProviderKey("global", {}, "deepseek", "sk-application-secret", "owner");
    f.deps.manager = {
      pendingRestart: (appId: string) =>
        appId === "p1:storefront"
          ? { pending: true, reasons: ["settings_changed"] }
          : { pending: false, reasons: [] },
    } as unknown as InstanceManager;

    const response = handleRequest(f.deps, get("/projects/p1/apps/storefront", auth(f.token)));
    expect(response.status).toBe(200);
    expect(response.body).toContain('id="settings-pending"');
    expect(response.body).toContain("Settings changed");
    expect(response.body).toContain("Restart required");
    expect(response.body).toContain('action="/api/apps/storefront/restart?project=p1"');
    expect(response.body).toContain('href="/projects/p1/apps/storefront/settings"');
    expect(response.body).not.toContain("sk-application-secret");
  });

  it("redirects unauthenticated and agent principals to login", () => {
    const f = fixture();
    const unauthenticated = handleRequest(f.deps, get("/projects/p1/apps/storefront"));
    expect(unauthenticated.status).toBe(303);
    expect(unauthenticated.headers?.location).toBe(
      "/login?next=%2Fprojects%2Fp1%2Fapps%2Fstorefront",
    );

    const agent = createPrincipal(f.db, { kind: "agent", name: "agent" });
    const agentResponse = handleRequest(
      f.deps,
      get("/projects/p1/apps/storefront", auth(agent.token)),
    );
    expect(agentResponse.status).toBe(303);
    expect(agentResponse.headers?.location).toBe(
      "/login?next=%2Fprojects%2Fp1%2Fapps%2Fstorefront",
    );
  });
});
