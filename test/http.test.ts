import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHandoff, type HandoffState } from "../src/coordinator/handoff.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { createPrincipal, upsertPrincipalWithToken } from "../src/identity/principals.js";
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
      const row = f.db.prepare("SELECT name, root_path FROM projects WHERE id = 'p'").get() as
        | { name: string; root_path: string }
        | undefined;
      return [
        {
          id: "p",
          name: row?.name ?? "P",
          rootPath: row?.root_path ?? f.projectRoot,
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

    const missing = handleRequest(deps(f), {
      method: "GET",
      path: "/assets/missing.js",
      headers: {},
    });
    expect(missing.status).toBe(404);
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
