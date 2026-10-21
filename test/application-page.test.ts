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

function page(f: Fixture): string {
  const response = handleRequest(f.deps, get("/projects/p1/apps/storefront", auth(f.token)));
  expect(response.status).toBe(200);
  return response.body;
}

function setRuntime(f: Fixture, state: string): void {
  const now = new Date().toISOString();
  f.db
    .prepare(
      "INSERT OR REPLACE INTO instances (id, app_id, state, runtime_state, updated_at) VALUES ('p1:storefront','p1:storefront',?,?,?)",
    )
    .run(state, state, now);
}

function setImage(
  f: Fixture,
  values: {
    status: string;
    ref: string | null;
    hash: string | null;
    builtAt?: string | null;
    error?: string | null;
  },
): void {
  f.db
    .prepare(
      "UPDATE apps SET image_status = ?, image_ref = ?, image_hash = ?, image_built_at = ?, image_error = ? WHERE id = 'p1:storefront'",
    )
    .run(values.status, values.ref, values.hash, values.builtAt ?? null, values.error ?? null);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("application page", () => {
  it("renders the new hierarchy with the state strip before the git workbench", () => {
    const f = fixture();
    const body = page(f);

    expect(body).toContain('class="app-shell"');
    expect(body).toContain('id="app-state"');
    expect(body).toContain('id="runtime-state"');
    expect(body).toContain('id="settings-state"');
    expect(body.indexOf('id="app-state"')).toBeLessThan(body.indexOf('id="git-panel"'));
    expect(body).not.toContain('id="settings-pending"');
    expect(body).not.toContain('id="application-card-title"');
    expect(body).toContain("Repository state and lightweight git actions for this application.");
    expect(body).toContain('data-state="queued"');
    expect(body).toContain("Stopped");

    const actionsStart = body.indexOf('class="page-header__actions"');
    const actions = body.slice(actionsStart, body.indexOf("</header>", actionsStart));
    expect(actions).toContain('href="/chat?app=storefront&amp;project=p1"');
    expect(actions).toContain("Open chat");
    expect(actions).toContain('href="/terminal?app=storefront&amp;project=p1"');
    expect(actions).toContain("Terminal");
    expect(actions).toContain('<details class="menu">');
    expect(actions).toContain('aria-label="More actions"');
    expect(actions).toContain("Open IDE in this folder");
    expect(actions).toContain("Application settings");
    expect(actions).not.toContain("btn-primary");
    expect(actions).not.toContain(">Settings</a>");
  });

  it("renders the default image rail card without build controls", () => {
    const f = fixture();
    const body = page(f);

    expect(body).toContain('id="image-panel"');
    expect(body).toContain('id="image-status" data-status="default" data-state="cancelled"');
    expect(body).toContain("#i-layers");
    expect(body).toContain("Default image");
    expect(body).toContain("This application uses the shared default agent image.");
    expect(body).toContain("Add .hanse/Dockerfile to build a custom image for this application.");
    expect(body).toContain("Open application folder");
    expect(body).toContain('id="image-ref">Default agent image</p>');
    expect(body).not.toContain('id="image-build"');
    expect(body).not.toContain('id="image-refresh"');
    expect(body).not.toContain('id="image-logs"');
    expect(body).not.toContain('id="image-rollback-form"');
    expect(body).not.toContain('id="image-rollback-dialog"');
    expect(count(body, 'id="image-live"')).toBe(1);
  });

  it("keeps the git workbench contract and noscript fallback", () => {
    const f = fixture();
    const body = page(f);

    expect(body).toContain('id="git-panel"');
    expect(body).toContain('data-project-id="p1"');
    expect(body).toContain('data-app-key="storefront"');
    expect(body).toContain('data-api-base="/api/projects/p1/apps/storefront/git"');
    expect(body).toContain(
      'id="git-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"',
    );
    expect(body).toContain('id="repository-card"');
    expect(body).toContain('id="repository-title"');
    expect(body).toContain('id="git-refreshed"');
    expect(body).toContain('id="git-refresh"');
    expect(body).toContain('id="git-repository-body"');
    expect(body).toContain('id="changes-card"');
    expect(body).toContain('id="changes-title"');
    expect(body).toContain('id="git-change-counts"');
    expect(body).toContain('id="git-changes-body"');
    expect(body).toContain('id="git-remotes-body"');
    expect(body).toContain('id="git-last-commit-body"');
    expect(body).toContain('aria-busy="true"');
    expect(body).toContain("Loading repository status.");
    expect(body).toContain("/assets/git.js");
    expect(body).toContain("/assets/images.js");
    expect(body).toContain("Git actions need JavaScript. Use the IDE for repository operations.");
    expect(body).toContain("service");
    expect(body).toContain("apps/storefront");
    expect(body).toContain('href="/projects/p1"');
    expect(body).toContain('aria-current="page">storefront</span>');
  });

  it("keeps the rail as Image, SSH access, Remotes, and Last commit", () => {
    const f = fixture();
    const body = page(f);

    expect(body.indexOf('id="git-panel"')).toBeLessThan(body.indexOf('class="rail-stack"'));
    expect(body.indexOf('class="rail-stack"')).toBeLessThan(body.indexOf('id="image-panel"'));
    expect(body.indexOf('id="image-panel"')).toBeLessThan(body.indexOf('id="ssh-panel"'));
    expect(body.indexOf('id="ssh-panel"')).toBeLessThan(body.indexOf('id="remotes-title"'));
    expect(body.indexOf('id="remotes-title"')).toBeLessThan(body.indexOf('id="last-commit-title"'));
    expect(body).toContain('id="ssh-panel-title">SSH access</h2>');
    expect(body).toContain("/ssh?project=p1&amp;app=storefront");
  });

  it("renders a configured missing image with a status pill, build label, and closed details", () => {
    const f = fixture();
    setImage(f, { status: "missing", ref: null, hash: "hash" });
    const body = page(f);

    expect(body).toContain('id="image-build"');
    expect(body).toContain('<span class="btn__label">Build image</span>');
    expect(body).toContain("Build image");
    expect(body).toContain('id="image-status" data-status="missing" data-state="queued"');
    expect(body).toContain("#i-clock");
    expect(body).toContain("Not built");
    expect(body).toContain('id="image-details"');
    expect(body).toContain('id="image-logs-details"');
    expect(body.indexOf('id="image-details"')).toBeLessThan(body.indexOf('id="image-logs"'));
    expect(body).toContain('id="image-rollback-form" hidden');
    expect(body).not.toContain("shared default agent image");
    expect(body).not.toContain('id="image-logs-refresh"');
    expect(body).toContain('id="image-rollback-dialog"');
    expect(body).toContain('id="image-rollback-dialog-ref"');
  });

  it("renders a building image with a disabled busy build action", () => {
    const f = fixture();
    setImage(f, {
      status: "building",
      ref: "sha256:current",
      hash: "hash",
      builtAt: "2026-10-20T10:00:00.000Z",
    });
    const body = page(f);

    expect(body).toContain('id="image-status" data-status="building" data-state="in_progress"');
    expect(body).toContain("#i-loader");
    expect(body).toContain("Building");
    expect(body).toContain('id="image-build"');
    expect(body).toContain('disabled aria-busy="true"');
    expect(body).toContain('<span class="btn__label">Building…</span>');
    expect(body).toContain('id="image-rollback" data-dialog-open="image-rollback-dialog" disabled');
  });

  it("renders a build error as a field error with the failed status", () => {
    const f = fixture();
    setImage(f, {
      status: "error",
      ref: null,
      hash: null,
      error: "build.dockerfile escapes the application directory",
    });
    const body = page(f);

    expect(body).toContain('id="image-build"');
    expect(body).toContain("Retry build");
    expect(body).toContain('id="image-status" data-status="error" data-state="failed"');
    expect(body).toContain("#i-alert-triangle");
    expect(body).toContain("Build failed");
    expect(body).toContain("build.dockerfile escapes the application directory");
    expect(body).toContain('class="field-error" id="image-error" role="alert"');
    expect(body).not.toContain("shared default agent image");
  });

  it("shows the rollback trigger and dialog only when a previous image exists", () => {
    const f = fixture();
    setImage(f, {
      status: "ready",
      ref: "sha256:new",
      hash: "hash",
      builtAt: "2026-10-20T10:00:00.000Z",
    });
    const now = new Date().toISOString();
    f.db
      .prepare(
        "INSERT INTO app_image_versions (app_id,image_ref,built_at,created_at) VALUES ('p1:storefront','sha256:old',?,?)",
      )
      .run(now, now);
    const body = page(f);

    expect(body).toContain('id="image-status" data-status="ready" data-state="delivered"');
    expect(body).toContain("Built");
    expect(body).toContain("#i-check");
    expect(body).toContain(
      '<form method="post" action="/api/apps/storefront/image/rollback?project=p1" id="image-rollback-form">',
    );
    expect(body).toContain('id="image-rollback" data-dialog-open="image-rollback-dialog"');
    expect(body).toContain('type="button" id="image-rollback"');
    expect(body).toContain('id="image-rollback-dialog-ref">sha256:old</span>');
    expect(body).toContain("Roll back image");
    expect(body).not.toContain("Roll back and restart");
    expect(count(body, 'id="image-rollback-dialog"')).toBe(1);
  });

  it("labels rollback as a restart while the runtime is active", () => {
    const f = fixture();
    setRuntime(f, "running");
    setImage(f, {
      status: "ready",
      ref: "sha256:new",
      hash: "hash",
      builtAt: "2026-10-20T10:00:00.000Z",
    });
    const now = new Date().toISOString();
    f.db
      .prepare(
        "INSERT INTO app_image_versions (app_id,image_ref,built_at,created_at) VALUES ('p1:storefront','sha256:old',?,?)",
      )
      .run(now, now);
    const body = page(f);

    expect(body).toContain("Roll back and restart");
    expect(body).toContain("and restarts the agent. An active turn will be interrupted.");
  });

  it("shows exactly one pending statement and the restart dialog while running", () => {
    const f = fixture();
    setRuntime(f, "running");
    f.settings.setProviderKey("global", {}, "deepseek", "sk-application-secret", "owner");
    f.deps.manager = {
      pendingRestart: (appId: string) =>
        appId === "p1:storefront"
          ? { pending: true, reasons: ["settings_changed"] }
          : { pending: false, reasons: [] },
    } as unknown as InstanceManager;

    const body = page(f);
    expect(count(body, "Restart required")).toBe(1);
    expect(body).toContain("The agent is running with older settings.");
    expect(body).not.toContain("settings-pending");
    expect(body).toContain('id="runtime-restart"');
    expect(body).toContain("Restart agent");
    expect(body).toContain('id="app-restart-dialog"');
    expect(count(body, 'action="/api/apps/storefront/restart?project=p1"')).toBe(1);
    expect(body).toContain("An active turn will be interrupted. Sessions are kept.");
    expect(body).toContain('name="return_to" value="/projects/p1/apps/storefront"');
    expect(body).not.toContain("sk-application-secret");
  });

  it("renders the unknown pending copy when applied state cannot be confirmed", () => {
    const f = fixture();
    f.deps.manager = {
      pendingRestart: () => ({ pending: true, reasons: ["applied_state_unknown"] }),
    } as unknown as InstanceManager;

    const body = page(f);
    expect(count(body, "Restart required")).toBe(1);
    expect(body).toContain(
      "The coordinator cannot confirm which settings this running agent loaded.",
    );
    expect(body).not.toContain("The agent is running with older settings.");
  });

  it("renders Applied when a manager is configured and settings are current", () => {
    const f = fixture();
    f.deps.manager = {
      pendingRestart: () => ({ pending: false, reasons: [] }),
    } as unknown as InstanceManager;

    const body = page(f);
    expect(body).toContain('data-state="delivered"');
    expect(body).toContain("Applied");
    expect(body).toContain("Settings match the running agent.");
    expect(body).toContain("Review settings");
    expect(body).not.toContain("Unavailable");
    expect(body).not.toContain("Restart required");
  });

  it("renders Unavailable when the runtime is not configured", () => {
    const f = fixture();
    const body = page(f);

    expect(body).toContain('data-state="cancelled"');
    expect(body).toContain("Unavailable");
    expect(body).toContain("The agent runtime is not configured.");
    expect(body).toContain("Review settings");
    expect(body).not.toContain("Applied");
  });

  it("omits the restart control for stopped and error runtimes", () => {
    const f = fixture();
    const stopped = page(f);
    expect(stopped).not.toContain('id="runtime-restart"');
    expect(stopped).not.toContain('id="app-restart-dialog"');

    setRuntime(f, "error");
    const errored = page(f);
    expect(errored).toContain('data-state="failed"');
    expect(errored).toContain("Error");
    expect(errored).not.toContain('id="runtime-restart"');
    expect(errored).not.toContain('id="app-restart-dialog"');
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
