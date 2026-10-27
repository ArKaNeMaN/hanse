import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentLock } from "../src/coordinator/deployment-lock.js";
import { getHandoff, type HandoffState } from "../src/coordinator/handoff.js";
import { LifecycleActivity } from "../src/coordinator/lifecycle-activity.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { isStartRoute } from "../src/http/chat.js";
import {
  type HttpDeps,
  type HttpRequest,
  handleRequest,
  provisioningDeps,
} from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { safeLocalPath } from "../src/http/ui.js";
import { createPrincipal, upsertPrincipalWithToken } from "../src/identity/principals.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed by an individual test
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
  service: CoordinatorService;
  handoffId: string;
  workspace: string;
  projectRoot: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-http-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace");
  const projectRoot = path.join(workspace, "p");
  mkdirSync(path.join(projectRoot, ".hanse"), { recursive: true });
  writeFileSync(
    path.join(projectRoot, ".hanse", "project.yaml"),
    "id: p\nname: P\nbase_branch: main\napps: []\n",
    "utf8",
  );
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','P','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:a','p','a','apps/a','AGENTS.md',?)",
  ).run(now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,contract,created_at) VALUES ('p:b','p','b','apps/b','AGENTS.md',?)",
  ).run(now);
  const service = new CoordinatorService(db, "p");
  const { handoffId } = service.requestSiblingChange({
    fromAppKey: "a",
    toAppKey: "b",
    summary: "need X",
    spec: "do X",
    requiresApproval: true,
  });
  return { db, service, handoffId, workspace, projectRoot };
}

function deps(f: Fixture): HttpDeps {
  return {
    db: f.db,
    workspaceRoot: f.workspace,
    git: new GitService({ workspaceRoot: f.workspace }),
    getProjects: () => {
      const row = f.db
        .prepare("SELECT name, root_path, deleting FROM projects WHERE id = 'p'")
        .get() as { name: string; root_path: string; deleting: number } | undefined;
      return [
        {
          id: "p",
          name: row?.name ?? "P",
          rootPath: row?.root_path ?? f.projectRoot,
          workspaceRoot: f.workspace,
          deleting: row?.deleting === 1,
          service: f.service,
        },
      ];
    },
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

function seedStates(db: SqliteDatabase): void {
  const states: HandoffState[] = [
    "queued",
    "dispatching",
    "in_progress",
    "delivered",
    "rejected",
    "failed",
    "expired",
    "cancelled",
  ];
  const insert = db.prepare(
    `INSERT INTO handoffs
      (id, project_id, from_app_id, to_app_id, state, summary, spec, idempotency_key, attempts, result, error, created_at, updated_at)
     VALUES (?, 'p', 'p:a', 'p:b', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  states.forEach((state, index) => {
    const stamp = new Date(Date.now() - index * 60_000).toISOString();
    insert.run(
      `extra-${state}`,
      state,
      `Summary ${state}`,
      `Spec for ${state}`,
      `key-${state}`,
      state === "delivered" ? "Delivered result" : null,
      state === "failed" ? "Target repository unavailable." : null,
      stamp,
      stamp,
    );
  });
}

describe("http auth and login", () => {
  it("redirects an unauthenticated HTML page to login with next", () => {
    const f = fixture();
    const response = handleRequest(deps(f), { method: "GET", path: "/projects", headers: {} });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login?next=%2Fprojects");
  });

  it("redirects an agent principal away from HTML pages", () => {
    const f = fixture();
    const { token } = createPrincipal(f.db, { kind: "agent", name: "web" });
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/",
      headers: auth(token),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login?next=%2F");
  });

  it("renders the login plate", () => {
    const f = fixture();
    const response = handleRequest(deps(f), { method: "GET", path: "/login", headers: {} });
    expect(response.status).toBe(200);
    expect(response.body).toContain('class="cover chart-ground"');
    expect(response.body).toContain('class="login-plate"');
    expect(response.body).toContain('autocomplete="current-password"');
    expect(response.body).toContain("Operator token");
  });

  it("rejects an invalid token without setting a cookie", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/login",
      headers: {},
      body: form({ token: "wrong", next: "/" }),
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain("Token rejected");
    expect(response.headers?.["set-cookie"]).toBeUndefined();
  });

  it("rejects an agent token on the human login form", () => {
    const f = fixture();
    const { token } = createPrincipal(f.db, { kind: "agent", name: "web" });
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/login",
      headers: {},
      body: form({ token, next: "/" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers?.["set-cookie"]).toBeUndefined();
  });

  it("sets the session cookie and redirects to a validated next path", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/login",
      headers: {},
      body: form({ token, next: "/handoffs?filter=waiting" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/handoffs?filter=waiting");
    const setCookie = response.headers?.["set-cookie"] ?? "";
    expect(setCookie).toContain("hanse_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000");
  });

  it("blocks open redirects through next", () => {
    const f = fixture();
    const token = humanToken(f.db);
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
      const response = handleRequest(deps(f), {
        method: "POST",
        path: "/login",
        headers: {},
        body: form({ token, next }),
      });
      expect(response.status).toBe(303);
      expect(response.headers?.location).toBe("/");
    }
  });

  it("round-trips a token containing cookie-significant characters", () => {
    const f = fixture();
    const token = "eq=token/+value";
    upsertPrincipalWithToken(f.db, { kind: "human", name: "operator", token });
    const login = handleRequest(deps(f), {
      method: "POST",
      path: "/login",
      headers: {},
      body: form({ token, next: "/" }),
    });
    expect(login.status).toBe(303);
    const setCookie = login.headers?.["set-cookie"] ?? "";
    const cookiePair = setCookie.split(";")[0] ?? "";
    expect(cookiePair.startsWith("hanse_token=")).toBe(true);
    const page = handleRequest(deps(f), {
      method: "GET",
      path: "/",
      headers: { cookie: cookiePair },
    });
    expect(page.status).toBe(200);
  });

  it("clears the cookie on logout", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/logout",
      headers: {},
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login");
    expect(response.headers?.["set-cookie"]).toContain("Max-Age=0");
  });
});

describe("http pages", () => {
  it("renders the fleet overview for a human", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/",
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("Fleet overview");
    expect(response.body).toContain("Project ledger");
    expect(response.body).toContain("Awaiting approval");
    expect(response.body).toContain(f.handoffId.slice(0, 8));
    expect(response.body).toContain('href="/handoffs"');
    expect(response.body).not.toContain('{"error"');
  });

  it("renders the projects index and filters by query", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const all = handleRequest(deps(f), {
      method: "GET",
      path: "/projects",
      headers: auth(token),
    });
    expect(all.status).toBe(200);
    expect(all.body).toContain("Project ledger");
    expect(all.body).toContain('name="q"');
    expect(all.body).toContain(">P</a>");

    const none = handleRequest(deps(f), {
      method: "GET",
      path: "/projects",
      query: { q: "nothing" },
      headers: auth(token),
    });
    expect(none.status).toBe(200);
    expect(none.body).toContain("No matching projects");
    expect(none.body).toContain("Clear search");
  });

  it("renders project detail with apps, dialogs, and the manifest", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/projects/p",
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("Applications");
    expect(response.body).toContain("apps/a");
    expect(response.body).toContain('id="add-app"');
    expect(response.body).toContain('id="new-handoff"');
    expect(response.body).toContain('data-dialog-open="h-');
    expect(response.body).toContain(".hanse/project.yaml");
    expect(response.body).toContain("Waiting for approval");
    expect(response.body).toContain('href="/projects/p/apps/a"');
    expect(response.body).toContain('aria-label="Open a application"');
    expect(response.body).toContain('href="/projects/p/settings"');
    expect(response.body).toContain('class="nav-item" href="/projects/p/settings"');
    expect(response.body).toContain('id="danger-zone"');
    expect(response.body).toContain("Danger zone");
    expect(response.body).toContain('id="project-delete-dialog"');
    expect(response.body).toContain('data-dialog-open="project-delete-dialog"');
    expect(response.body).toContain('action="/api/projects/p/delete"');
    expect(response.body).toContain('name="confirm" required');
    expect(response.body).toContain("Type P to confirm (required)");
    expect(response.body).toContain('name="deleteFiles" value="true"');
    expect(response.body).toContain('name="return_to" value="/projects/p"');
    expect(response.body).toContain('class="btn btn-danger" type="submit">Delete project</button>');
    expect(response.body).toContain("#i-trash");
    expect(response.body).toContain("sessions, handoffs, credentials, and managed images");
  });

  it("marks a deleting project as incomplete in the ledgers and on its page", () => {
    const f = fixture();
    f.db.prepare("UPDATE projects SET deleting = 1 WHERE id = 'p'").run();
    const token = humanToken(f.db);

    const overview = handleRequest(deps(f), {
      method: "GET",
      path: "/",
      headers: auth(token),
    });
    expect(overview.status).toBe(200);
    expect(overview.body).toContain("Deletion incomplete");

    const index = handleRequest(deps(f), {
      method: "GET",
      path: "/projects",
      headers: auth(token),
    });
    expect(index.status).toBe(200);
    expect(index.body).toContain("Deletion incomplete");

    const detail = handleRequest(deps(f), {
      method: "GET",
      path: "/projects/p",
      headers: auth(token),
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toContain("Deletion incomplete");
    expect(detail.body).toContain("Retry deletion");
    expect(detail.body).toContain('data-dialog-open="project-delete-dialog"');
    expect(detail.body).toContain("Retry project deletion?");
    expect(detail.body).toContain("Type P to confirm (required)");
    expect(detail.body).toContain('action="/api/projects/p/delete"');
  });

  it("marks a deleting application row in the project table", () => {
    const f = fixture();
    f.db.prepare("UPDATE apps SET deleting = 1 WHERE id = 'p:a'").run();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/projects/p",
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("Deletion incomplete");
    expect(response.body).not.toContain("Retry deletion");
    expect(response.body).toContain('aria-label="Open a application"');
    expect(response.body).not.toContain('href="/chat?app=a&amp;project=p"');
    expect(response.body).toContain('href="/chat?app=b&amp;project=p"');
  });

  it("returns a styled 404 for an unknown project", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/projects/missing",
      headers: auth(token),
    });
    expect(response.status).toBe(404);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("Page not found");
    expect(response.body).toContain("Open overview");
  });

  it("renders all nine handoff states with filters and dialogs", () => {
    const f = fixture();
    seedStates(f.db);
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/handoffs",
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    for (const label of [
      "Queued",
      "Awaiting approval",
      "Dispatching",
      "In progress",
      "Delivered",
      "Rejected",
      "Failed",
      "Expired",
      "Cancelled",
    ]) {
      expect(response.body).toContain(label);
    }
    expect(response.body).toContain('All <span class="mono">9</span>');
    expect(response.body).toContain('Waiting <span class="mono">1</span>');
    expect(response.body).toContain('Active <span class="mono">3</span>');
    expect(response.body).toContain('Closed <span class="mono">5</span>');
    expect(response.body).toContain('name="decision" value="approved"');
    expect(response.body).toContain('name="decision" value="rejected"');
    expect(response.body).toContain("Spec for failed");
    expect(response.body).toContain(f.handoffId);
  });

  it("filters handoffs by group and search", () => {
    const f = fixture();
    seedStates(f.db);
    const token = humanToken(f.db);
    const waiting = handleRequest(deps(f), {
      method: "GET",
      path: "/handoffs",
      query: { filter: "waiting" },
      headers: auth(token),
    });
    expect(waiting.status).toBe(200);
    expect(waiting.body).toContain("Waiting for approval");
    expect(waiting.body).not.toContain("Summary delivered");

    const search = handleRequest(deps(f), {
      method: "GET",
      path: "/handoffs",
      query: { q: "extra-failed" },
      headers: auth(token),
    });
    expect(search.status).toBe(200);
    expect(search.body).toContain("Summary failed");
    expect(search.body).not.toContain("Summary delivered");

    const none = handleRequest(deps(f), {
      method: "GET",
      path: "/handoffs",
      query: { filter: "closed", q: "zzz" },
      headers: auth(token),
    });
    expect(none.status).toBe(200);
    expect(none.body).toContain("No matching handoffs");
    expect(none.body).toContain("Clear search");
  });

  it("renders notices as a toast", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/projects",
      query: { notice: "Application added.", tone: "success" },
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('class="toast" data-tone="success"');
    expect(response.body).toContain("Application added.");
    expect(response.body).toContain('data-autodismiss="6000"');
  });

  it("escapes dynamic project content", () => {
    const f = fixture();
    f.db.prepare("UPDATE projects SET name = ? WHERE id = 'p'").run('<script>alert("x")</script>');
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/",
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(response.body).not.toContain("<script>alert");
    expect(response.body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});

describe("http decisions and form mutations", () => {
  it("decides an approval through the shared decision endpoint", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: auth(token, { accept: "text/html" }),
      body: form({
        decision: "approved",
        reason: "looks good",
        return_to: "/handoffs?filter=waiting",
      }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("/handoffs?filter=waiting");
    expect(response.headers?.location).toContain("tone=success");
    expect(getHandoff(f.db, f.handoffId)?.state).toBe("dispatching");
    const approval = f.db
      .prepare("SELECT reason FROM approvals WHERE handoff_id = ?")
      .get(f.handoffId) as { reason: string };
    expect(approval.reason).toBe("looks good");
  });

  it("rejects a decision with no pending approval", () => {
    const f = fixture();
    const token = humanToken(f.db);
    handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: auth(token),
      body: form({ decision: "approved" }),
    });
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: auth(token),
      body: form({ decision: "approved" }),
    });
    expect(response.status).toBe(409);
  });

  it("keeps the legacy approve endpoint working with a reason", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/approve`,
      headers: auth(token, { accept: "text/html" }),
      body: form({ reason: "legacy ok", return_to: "/" }),
    });
    expect(response.status).toBe(303);
    expect(getHandoff(f.db, f.handoffId)?.state).toBe("dispatching");
    const approval = f.db
      .prepare("SELECT reason FROM approvals WHERE handoff_id = ?")
      .get(f.handoffId) as { reason: string };
    expect(approval.reason).toBe("legacy ok");
  });

  it("redirects a browser form mutation to its return path with a notice", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/handoffs",
      headers: auth(token, { accept: "text/html" }),
      body: form({
        project: "p",
        from: "a",
        to: "b",
        summary: "new route",
        spec: "spec",
        return_to: "/projects/p",
      }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("/projects/p");
    expect(response.headers?.location).toContain("notice=Handoff+created.");
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number }).c).toBe(2);
  });

  it("shows a validation notice instead of JSON for an empty browser handoff", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/handoffs",
      headers: auth(token, { accept: "text/html" }),
      body: form({ project: "p", from: "a", to: "b", summary: "", return_to: "/projects/p" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("tone=error");
    expect(response.headers?.location).toContain("Summary+is+required");
  });

  it("creates a project through the browser form and redirects to it", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/projects",
      headers: auth(token, { accept: "text/html" }),
      body: form({ name: "New Project" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toMatch(/^\/projects\/[^?]+\?notice=Project\+created/);
    const row = f.db.prepare("SELECT name FROM projects WHERE name = 'New Project'").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("New Project");
  });

  it("adds an application through the browser form", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/projects/p/apps",
      headers: auth(token, { accept: "text/html" }),
      body: form({ name: "c", path: "apps/c", return_to: "/projects/p" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toContain("Application+added.");
    const row = f.db
      .prepare("SELECT app_key FROM apps WHERE project_id = 'p' AND app_key = 'c'")
      .get() as { app_key: string } | undefined;
    expect(row?.app_key).toBe("c");
  });

  it("rejects an application path that escapes the project", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/projects/p/apps",
      headers: auth(token),
      body: form({ name: "evil", path: "../../evil" }),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: "INVALID_APP_PATH" });
    const row = f.db
      .prepare("SELECT app_key FROM apps WHERE project_id = 'p' AND app_key = 'evil'")
      .get() as { app_key: string } | undefined;
    expect(row).toBeUndefined();
  });

  it("redirects an unauthenticated browser decision to login", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/decision`,
      headers: { accept: "text/html" },
      body: form({ decision: "approved", return_to: "/handoffs" }),
    });
    expect(response.status).toBe(303);
    expect(response.headers?.location).toBe("/login?next=%2Fhandoffs");
  });
});

describe("http API and assets", () => {
  it("lists projects as JSON", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/api/projects",
      headers: {},
    });
    const projects = (JSON.parse(response.body) as { projects: { apps: unknown[] }[] }).projects;
    expect(projects[0]?.apps).toHaveLength(2);
  });

  it("rejects an unauthenticated mutation with 401", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/approve`,
      headers: {},
    });
    expect(response.status).toBe(401);
  });

  it("forbids an agent principal with 403", () => {
    const f = fixture();
    const { token } = createPrincipal(f.db, { kind: "agent", name: "web" });
    const response = handleRequest(deps(f), {
      method: "POST",
      path: `/api/handoffs/${f.handoffId}/approve`,
      headers: auth(token),
    });
    expect(response.status).toBe(403);
  });

  it("creates a handoff through the API as a human", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "POST",
      path: "/api/handoffs",
      headers: auth(token, { "content-type": "application/x-www-form-urlencoded" }),
      body: form({ project: "p", from: "a", to: "b", summary: "s", spec: "x" }),
    });
    expect(response.status).toBe(303);
    expect((f.db.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number }).c).toBe(2);
  });

  it("serves runtime status with a normalized legacy state and image ref", () => {
    const f = fixture();
    const token = humanToken(f.db);
    f.db
      .prepare(
        "INSERT INTO instances (id, app_id, endpoint, state, runtime_state, image_ref, updated_at) VALUES ('p:a','p:a','http://127.0.0.1:4100','failed','failed','sha256:app-image',?)",
      )
      .run(new Date().toISOString());

    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/api/apps/a/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      appId: "p:a",
      state: "error",
      endpoint: "http://127.0.0.1:4100",
      imageRef: "sha256:app-image",
    });

    const absent = handleRequest(deps(f), {
      method: "GET",
      path: "/api/apps/b/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(absent.status).toBe(200);
    expect(JSON.parse(absent.body)).toMatchObject({ state: "stopped", imageRef: null });
  });

  it("reports an in-memory restart claim on the runtime route without mutating state", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const d = deps(f);
    d.manager = {
      isRestarting: (appId: string) => appId === "p:a",
    } as unknown as NonNullable<HttpDeps["manager"]>;

    const running = handleRequest(d, {
      method: "GET",
      path: "/api/apps/a/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(running.status).toBe(200);
    expect(JSON.parse(running.body)).toMatchObject({ appId: "p:a", restarting: true });

    const idle = handleRequest(d, {
      method: "GET",
      path: "/api/apps/b/runtime",
      query: { project: "p" },
      headers: auth(token),
    });
    expect(idle.status).toBe(200);
    expect(JSON.parse(idle.body)).toMatchObject({ appId: "p:b", restarting: false });
  });

  it("serves the readiness contract without auth and without mutating state", () => {
    const f = fixture();
    const d = deps(f);
    d.deploymentLock = new DeploymentLock(path.join(f.workspace, "deploy.lock"));
    d.lifecycleActivity = new LifecycleActivity();
    const previousRevision = process.env.HANSE_REVISION;
    delete process.env.HANSE_REVISION;
    try {
      const before = f.db.prepare("SELECT COUNT(*) AS count FROM instances").get() as {
        count: number;
      };
      const response = handleRequest(d, { method: "GET", path: "/readyz", headers: {} });
      expect(response.status).toBe(200);
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(JSON.parse(response.body)).toEqual({
        status: "ok",
        version: expect.any(String),
        revision: "unknown",
        schemaVersion: 19,
        deploying: false,
        inFlightLifecycle: 0,
      });
      const after = f.db.prepare("SELECT COUNT(*) AS count FROM instances").get() as {
        count: number;
      };
      expect(after).toEqual(before);
    } finally {
      if (previousRevision === undefined) delete process.env.HANSE_REVISION;
      else process.env.HANSE_REVISION = previousRevision;
    }
  });

  it("reports the revision, an active lock, and in-flight lifecycle work", () => {
    const f = fixture();
    const d = deps(f);
    const lockFile = path.join(f.workspace, "deploy.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        version: 1,
        id: "lock-1",
        phase: "switching",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8",
    );
    d.deploymentLock = new DeploymentLock(lockFile);
    d.lifecycleActivity = new LifecycleActivity();
    const end = d.lifecycleActivity.begin("ensure");
    const previousRevision = process.env.HANSE_REVISION;
    process.env.HANSE_REVISION = "abc123";
    try {
      const response = handleRequest(d, { method: "GET", path: "/readyz", headers: {} });
      expect(JSON.parse(response.body)).toMatchObject({
        status: "ok",
        revision: "abc123",
        deploying: true,
        inFlightLifecycle: 1,
      });
      end();
      const after = handleRequest(d, { method: "GET", path: "/readyz", headers: {} });
      expect(JSON.parse(after.body)).toMatchObject({ inFlightLifecycle: 0 });
    } finally {
      if (previousRevision === undefined) delete process.env.HANSE_REVISION;
      else process.env.HANSE_REVISION = previousRevision;
    }
  });

  it("treats an empty revision as unknown", () => {
    const f = fixture();
    const previousRevision = process.env.HANSE_REVISION;
    process.env.HANSE_REVISION = "";
    try {
      const response = handleRequest(deps(f), { method: "GET", path: "/readyz", headers: {} });
      expect(JSON.parse(response.body)).toMatchObject({ revision: "unknown" });
    } finally {
      if (previousRevision === undefined) delete process.env.HANSE_REVISION;
      else process.env.HANSE_REVISION = previousRevision;
    }
  });

  it("returns 503 when the readiness schema query fails", () => {
    const f = fixture();
    f.db.exec("DROP TABLE schema_migrations");
    const response = handleRequest(deps(f), { method: "GET", path: "/readyz", headers: {} });
    expect(response.status).toBe(503);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({
      status: "error",
      error: "database_unavailable",
    });
  });

  it("supports the two-poll quiescence handshake", () => {
    const f = fixture();
    const d = deps(f);
    const lockFile = path.join(f.workspace, "deploy.lock");
    writeFileSync(
      lockFile,
      JSON.stringify({
        version: 1,
        id: "lock-1",
        phase: "switching",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf8",
    );
    d.deploymentLock = new DeploymentLock(lockFile);
    d.lifecycleActivity = new LifecycleActivity();
    const end = d.lifecycleActivity.begin("delete_app");

    const first = JSON.parse(
      handleRequest(d, { method: "GET", path: "/readyz", headers: {} }).body,
    ) as { deploying: boolean; inFlightLifecycle: number };
    expect(first).toMatchObject({ deploying: true, inFlightLifecycle: 1 });

    end();
    const second = JSON.parse(
      handleRequest(d, { method: "GET", path: "/readyz", headers: {} }).body,
    ) as { deploying: boolean; inFlightLifecycle: number };
    const third = JSON.parse(
      handleRequest(d, { method: "GET", path: "/readyz", headers: {} }).body,
    ) as { deploying: boolean; inFlightLifecycle: number };
    expect(second).toMatchObject({ deploying: true, inFlightLifecycle: 0 });
    expect(third).toMatchObject({ deploying: true, inFlightLifecycle: 0 });
  });

  it("serves an unauthenticated health check", () => {
    const f = fixture();
    const response = handleRequest(deps(f), { method: "GET", path: "/healthz", headers: {} });
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });

  it("serves the allowlisted assets without auth", () => {
    const f = fixture();
    const request: HttpRequest = { method: "GET", path: "/assets/app.js", headers: {} };
    const response = handleRequest(deps(f), request);
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/javascript");
    expect(response.body).toContain("data-dialog-open");

    const favicon = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/favicon.svg",
      headers: {},
    });
    expect(favicon.status).toBe(200);
    expect(favicon.contentType).toBe("image/svg+xml");

    const settingsJs = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/settings.js",
      headers: {},
    });
    expect(settingsJs.status).toBe(200);
    expect(settingsJs.contentType).toContain("text/javascript");
    expect(settingsJs.body).toContain("data-settings-driver");
    expect(settingsJs.body).toContain("data-driver-fields");

    const markdownJs = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/markdown.js",
      headers: {},
    });
    expect(markdownJs.status).toBe(200);
    expect(markdownJs.contentType).toContain("text/javascript");
    expect(markdownJs.body).toContain("renderMarkdown");

    const removedSkillsJs = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/skills.js",
      headers: {},
    });
    expect(removedSkillsJs.status).toBe(404);

    const missing = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/missing.js",
      headers: {},
    });
    expect(missing.status).toBe(404);
  });

  it("serves the diff and highlight assets and rejects unknown worker paths", () => {
    const f = fixture();
    const paths = [
      "/assets/chat-diff.js",
      "/assets/chat-highlight.js",
      "/assets/chat-highlight-worker.js",
    ];
    for (const assetPath of paths) {
      const response = handleRequest(deps(f), {
        method: "GET",
        path: assetPath,
        headers: {},
      });
      expect(response.status).toBe(200);
      expect(response.contentType).toBe("text/javascript; charset=utf-8");
      expect(response.body.length).toBeGreaterThan(0);
    }

    const missing = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/chat-highlight-missing.js",
      headers: {},
    });
    expect(missing.status).toBe(404);
  });

  it("serves the vendored Prism bundle and rejects unknown vendor paths", () => {
    const f = fixture();
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/vendor/prism/prism-1.30.0.min.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/javascript; charset=utf-8");
    expect(response.body).toContain("export default Prism;");

    const missing = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/vendor/prism/prism-9.9.9.min.js",
      headers: {},
    });
    expect(missing.status).toBe(404);
  });

  it("serves the vendored xterm assets and rejects unknown xterm paths", () => {
    const f = fixture();
    const assets = [
      {
        path: "/assets/vendor/xterm/xterm-6.0.0.css",
        contentType: "text/css; charset=utf-8",
        marker: ".xterm",
      },
      {
        path: "/assets/vendor/xterm/xterm-6.0.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "Terminal",
      },
      {
        path: "/assets/vendor/xterm/addon-fit-0.11.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "FitAddon",
      },
      {
        path: "/assets/vendor/xterm/addon-unicode11-0.9.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "Unicode11Addon",
      },
      {
        path: "/assets/vendor/xterm/addon-unicode-graphemes-0.4.0.js",
        contentType: "text/javascript; charset=utf-8",
        marker: "UnicodeGraphemesAddon",
      },
    ];
    for (const asset of assets) {
      const response = handleRequest(deps(f), {
        method: "GET",
        path: asset.path,
        headers: {},
      });
      expect(response.status).toBe(200);
      expect(response.contentType).toBe(asset.contentType);
      expect(response.body).toContain(asset.marker);
    }

    for (const assetPath of [
      "/assets/vendor/xterm/xterm-9.9.9.js",
      "/assets/vendor/xterm/addon-fit-9.9.9.js",
      "/assets/vendor/xterm/addon-unicode11-9.9.9.js",
      "/assets/vendor/xterm/addon-unicode-graphemes-9.9.9.js",
      "/assets/vendor/xterm/unknown.css",
    ]) {
      const missing = handleRequest(deps(f), {
        method: "GET",
        path: assetPath,
        headers: {},
      });
      expect(missing.status).toBe(404);
    }
  });

  it("dispatches settings routes before the chat fallback", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    const settings = new SettingsService({ db: f.db, secretKey: randomBytes(32) });
    const server = createHttpServer({ ...deps(f), settings });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const api = await fetch(`http://127.0.0.1:${port}/api/settings?scope=global`, {
        headers: auth(token),
      });
      expect(api.status).toBe(200);
      expect(api.headers.get("cache-control")).toBe("no-store");
      const payload = (await api.json()) as {
        effective: { llm: { model: { value: string } } };
        pendingRestart: unknown[];
      };
      expect(payload.effective.llm.model.value).toBe("deepseek/deepseek-flash");
      expect(payload.pendingRestart).toEqual([]);

      const page = await fetch(`http://127.0.0.1:${port}/settings`, {
        headers: { ...auth(token), accept: "text/html" },
      });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(">Settings</h1>");

      const restart = await fetch(`http://127.0.0.1:${port}/api/apps/a/restart?project=p`, {
        method: "POST",
        headers: auth(token),
      });
      expect(restart.status).toBe(503);

      const unknown = await fetch(`http://127.0.0.1:${port}/settings/nope`, {
        headers: auth(token),
      });
      expect(unknown.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("dispatches the start route explicitly before the chat fallback", async () => {
    const f = fixture();
    const token = humanToken(f.db);
    expect(isStartRoute("POST", "/api/apps/a/start")).toBe(true);
    expect(isStartRoute("GET", "/api/apps/a/start")).toBe(false);

    const calls: string[] = [];
    const depsWithManager = {
      ...deps(f),
      manager: {
        ensure: async (app: { id: string }) => {
          calls.push(app.id);
          return "http://127.0.0.1:1";
        },
      } as unknown as HttpDeps["manager"],
    };
    const server = createHttpServer(depsWithManager);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const start = await fetch(`http://127.0.0.1:${port}/api/apps/a/start?project=p`, {
        method: "POST",
        headers: auth(token),
      });
      expect(start.status).toBe(200);
      expect(await start.json()).toEqual({ appId: "p:a", state: "running" });
      expect(calls).toEqual(["p:a"]);

      const restart = await fetch(`http://127.0.0.1:${port}/api/apps/a/restart?project=p`, {
        method: "POST",
        headers: auth(token),
      });
      expect(restart.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns a styled 404 for an unknown HTML route", () => {
    const f = fixture();
    const token = humanToken(f.db);
    const response = handleRequest(deps(f), {
      method: "GET",
      path: "/nope",
      headers: auth(token),
    });
    expect(response.status).toBe(404);
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("Page not found");
  });
});

describe("provisioning deps", () => {
  it("wires the project git auth resolver when settings are present", () => {
    const f = fixture();
    const plain = provisioningDeps(deps(f));
    expect(plain.resolveGitAuth).toBeUndefined();

    const settings = new SettingsService({ db: f.db, secretKey: randomBytes(32) });
    const spy = vi.spyOn(settings, "projectGitAuth");
    const wired = provisioningDeps({ ...deps(f), settings });
    expect(wired.resolveGitAuth).toBeDefined();
    wired.resolveGitAuth?.("p");
    expect(spy).toHaveBeenCalledWith("p");
  });
});

describe("safeLocalPath", () => {
  it("rejects control characters and protocol-relative redirects", () => {
    expect(safeLocalPath("/settings")).toBe("/settings");
    expect(safeLocalPath("/\t/evil.example")).toBe("/");
    expect(safeLocalPath("//evil.example")).toBe("/");
    expect(safeLocalPath("/\\evil.example")).toBe("/");
  });
});
