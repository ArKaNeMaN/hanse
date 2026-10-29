import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { humanFromCookie } from "../src/http/auth.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { handleUiApi, maybeServeSpa } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import { SettingsService } from "../src/settings/index.js";
import { ROUTES } from "../src/shared/routes.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const originalLegacy = process.env.HANSE_UI_LEGACY;
const originalAllowlist = process.env.HANSE_UI_SPA_ROUTES;
const originalDevUrl = process.env.HANSE_UI_DEV_URL;

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
  if (originalLegacy === undefined) {
    delete process.env.HANSE_UI_LEGACY;
  } else {
    process.env.HANSE_UI_LEGACY = originalLegacy;
  }
  if (originalAllowlist === undefined) {
    delete process.env.HANSE_UI_SPA_ROUTES;
  } else {
    process.env.HANSE_UI_SPA_ROUTES = originalAllowlist;
  }
  if (originalDevUrl === undefined) {
    delete process.env.HANSE_UI_DEV_URL;
  } else {
    process.env.HANSE_UI_DEV_URL = originalDevUrl;
  }
});

interface Fixture {
  db: SqliteDatabase;
  deps: HttpDeps;
  settings: SettingsService;
  humanToken: string;
  agentCookieToken: string;
  agentBearerToken: string;
  log: { warn: ReturnType<typeof vi.fn> };
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-ui-auth-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Alpha','main','/workspace/p',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:web','p','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  const service = new CoordinatorService(db, "p");
  const settings = new SettingsService({ db, secretKey: randomBytes(32) });
  const human = createPrincipal(db, { kind: "human", name: "alice" });
  const agentPrincipal = createPrincipal(db, { kind: "agent", name: "bot" });
  const agentBearerToken = mintAgentToken(db, "p:web");
  const log = { warn: vi.fn() };
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/workspace",
    git: new GitService({ workspaceRoot: "/workspace" }),
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: log.warn, error: vi.fn() },
    getProjects: () => [
      {
        id: "p",
        name: "Alpha",
        rootPath: "/workspace/p",
        workspaceRoot: "/workspace",
        service,
      },
    ],
  };
  return {
    db,
    deps,
    settings,
    humanToken: human.token,
    agentCookieToken: agentPrincipal.token,
    agentBearerToken,
    log,
  };
}

function cookie(token: string): Record<string, string> {
  return { cookie: `hanse_token=${encodeURIComponent(token)}` };
}

function addMaster(f: Fixture): void {
  const now = new Date().toISOString();
  f.db
    .prepare(
      "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('hanse-master','Hanse master','main','/workspace/.hanse-master',?,?)",
    )
    .run(now, now);
  f.db
    .prepare(
      "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('hanse-master:master','hanse-master','master','apps/master','app','AGENTS.md',?)",
    )
    .run(now);
  const service = new CoordinatorService(f.db, "hanse-master");
  const projects = f.deps.getProjects();
  f.deps.getProjects = () => [
    ...projects,
    {
      id: "hanse-master",
      name: "Hanse master",
      rootPath: "/workspace/.hanse-master",
      workspaceRoot: "/workspace",
      service,
    },
  ];
}

function request(
  pathname: string,
  headers: Record<string, string>,
  query?: Record<string, string>,
): HttpRequest {
  return { method: "GET", path: pathname, headers, ...(query === undefined ? {} : { query }) };
}

interface BootPayload {
  route: { id: string };
  props: {
    counts?: Record<string, number>;
    project?: { id?: string; name?: string };
  };
  chrome: { title?: string; active?: string; activeProjectId?: string };
}

function boot(body: string): BootPayload {
  const match = /<script id="hanse-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(body);
  return JSON.parse(match?.[1] ?? "{}") as BootPayload;
}

function enable(f: Fixture): void {
  delete process.env.HANSE_UI_LEGACY;
  process.env.HANSE_UI_SPA_ROUTES = ROUTES.map((route) => route.id).join(",");
  process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
  f.log.warn.mockClear();
}

describe("humanFromCookie", () => {
  it("accepts a human session cookie", () => {
    const f = fixture();
    expect(humanFromCookie(f.deps, request("/projects", cookie(f.humanToken)))?.name).toBe("alice");
  });

  it("rejects a human bearer token without a cookie", () => {
    const f = fixture();
    expect(
      humanFromCookie(f.deps, request("/projects", { authorization: `Bearer ${f.humanToken}` })),
    ).toBeUndefined();
  });

  it("rejects an agent cookie", () => {
    const f = fixture();
    expect(
      humanFromCookie(f.deps, request("/projects", cookie(f.agentCookieToken))),
    ).toBeUndefined();
  });

  it("rejects a malformed or empty cookie", () => {
    const f = fixture();
    expect(
      humanFromCookie(f.deps, request("/projects", { cookie: "hanse_token=%E0%A4%A" })),
    ).toBeUndefined();
    expect(
      humanFromCookie(f.deps, request("/projects", { cookie: "hanse_token=" })),
    ).toBeUndefined();
    expect(humanFromCookie(f.deps, request("/projects", {}))).toBeUndefined();
  });
});

describe("/api/ui auth and props", () => {
  it("returns 401 without credentials", () => {
    const f = fixture();
    const response = handleUiApi(f.deps, request("/api/ui/projects", {}));
    expect(response).toMatchObject({ status: 401 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(response?.body ?? "{}")).toEqual({
      error: "sign in required",
      code: "unauthenticated",
    });
  });

  it("returns 403 cookie_required for a human bearer without a cookie", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/projects", { authorization: `Bearer ${f.humanToken}` }),
    );
    expect(response).toMatchObject({ status: 403 });
    expect(JSON.parse(response?.body ?? "{}")).toEqual({
      error: "cookie sign-in required",
      code: "cookie_required",
    });
  });

  it("returns 403 for an agent bearer token before the cookie_required check", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/projects", {
        authorization: `Bearer ${f.agentBearerToken}`,
        cookie: `hanse_token=${encodeURIComponent(f.humanToken)}`,
      }),
    );
    expect(response).toMatchObject({ status: 403 });
    expect(JSON.parse(response?.body ?? "{}")).toEqual({
      error: "agent tokens may only call the MCP endpoint",
    });
  });

  it("applies the cookie-only auth envelope to every read endpoint", () => {
    const f = fixture();
    for (const pathname of ["/api/ui/overview", "/api/ui/projects/p"]) {
      const anonymous = handleUiApi(f.deps, request(pathname, {}));
      expect(anonymous?.status, pathname).toBe(401);
      expect(anonymous?.headers?.["cache-control"], pathname).toBe("no-store");
      expect(JSON.parse(anonymous?.body ?? "{}"), pathname).toEqual({
        error: "sign in required",
        code: "unauthenticated",
      });

      const bearer = handleUiApi(
        f.deps,
        request(pathname, { authorization: `Bearer ${f.humanToken}` }),
      );
      expect(bearer?.status, pathname).toBe(403);
      expect(JSON.parse(bearer?.body ?? "{}"), pathname).toEqual({
        error: "cookie sign-in required",
        code: "cookie_required",
      });

      const agent = handleUiApi(
        f.deps,
        request(pathname, {
          authorization: `Bearer ${f.agentBearerToken}`,
          cookie: `hanse_token=${encodeURIComponent(f.humanToken)}`,
        }),
      );
      expect(agent?.status, pathname).toBe(403);
      expect(JSON.parse(agent?.body ?? "{}"), pathname).toEqual({
        error: "agent tokens may only call the MCP endpoint",
      });
    }
  });

  it("returns projects props plus chrome for a valid human cookie", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/projects", cookie(f.humanToken), { q: "alp" }),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response?.body ?? "{}");
    expect(payload.rows).toEqual([
      expect.objectContaining({ id: "p", name: "Alpha", appCount: 1 }),
    ]);
    expect(payload.query).toBe("alp");
    expect(payload.chrome).toMatchObject({
      title: "Projects",
      active: "projects",
      pendingCount: 0,
      sshPendingCount: 0,
    });
    expect(payload.chrome.sidebarNav).not.toContain("<nav");
    expect(payload.chrome.breadcrumb).not.toContain("<nav");
  });

  it("returns overview props plus chrome for a valid human cookie", () => {
    const f = fixture();
    const response = handleUiApi(f.deps, request("/api/ui/overview", cookie(f.humanToken)));
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response?.body ?? "{}");
    expect(payload.counts).toMatchObject({
      projects: 1,
      applications: 1,
      stopped: 1,
      handoffsWaiting: 0,
      handoffsTotal: 0,
    });
    expect(payload.projects).toEqual([
      expect.objectContaining({
        id: "p",
        name: "Alpha",
        rootPath: "/workspace/p",
        appCount: 1,
        waitingCount: 0,
        deleting: false,
      }),
    ]);
    expect(payload.recentHandoffs).toEqual([]);
    expect(payload.waitingHandoffs).toEqual([]);
    expect(payload.chrome).toMatchObject({
      title: "Fleet overview",
      active: "overview",
      pendingCount: 0,
      sshPendingCount: 0,
    });
    expect(payload.chrome.activeProjectId).toBeUndefined();
  });

  it("returns project props and scoped chrome for a valid human cookie", () => {
    const f = fixture();
    const response = handleUiApi(f.deps, request("/api/ui/projects/p", cookie(f.humanToken)));
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response?.body ?? "{}");
    expect(payload.project).toMatchObject({
      id: "p",
      name: "Alpha",
      rootPath: "/workspace/p",
      baseBranch: "main",
      deleting: false,
    });
    expect(payload.apps).toEqual([
      expect.objectContaining({
        appKey: "web",
        path: "apps/web",
        kind: "app",
        runtime: "stopped",
        href: "/projects/p/apps/web",
        chatHref: "/chat?app=web&project=p",
        settingsHref: "/projects/p/apps/web/settings",
        skillsHref: "/projects/p/apps/web/skills",
      }),
    ]);
    expect(payload.handoffs).toEqual([]);
    expect(payload.waitingHandoffs).toEqual([]);
    expect(payload.policy).toMatchObject({ appOptions: ["web"], wildcard: "*" });
    expect(payload.deletion).toMatchObject({
      deleting: false,
      projectName: "Alpha",
      action: "/api/projects/p/delete",
      returnTo: "/projects/p",
    });
    expect(payload.dialogs.addApp).toMatchObject({ action: "/api/projects/p/apps" });
    expect(payload.dialogs.newHandoff).toMatchObject({ fromKey: "web", toKey: "web" });
    expect(payload.master).toBe(false);
    expect(payload.masterSummary).toBeNull();
    expect(payload.chrome).toMatchObject({
      title: "Alpha",
      active: "project",
      activeProjectId: "p",
    });
    expect(payload.chrome.sidebarNav).toContain('data-project-id="p"');
    expect(payload.chrome.sidebarNav).toContain('href="/projects/p/settings"');
    expect(payload.chrome.sidebarNav).toContain('href="/projects/p/skills"');
    expect(payload.chrome.breadcrumb).toContain("Alpha");
  });

  it("returns the master project variant read-only", () => {
    const f = fixture();
    addMaster(f);
    const response = handleUiApi(
      f.deps,
      request("/api/ui/projects/hanse-master", cookie(f.humanToken)),
    );
    expect(response).toMatchObject({ status: 200 });
    const payload = JSON.parse(response?.body ?? "{}");
    expect(payload.master).toBe(true);
    expect(payload.masterSummary).toEqual({
      runtime: "stopped",
      kind: "app",
      path: "apps/master",
      chatHref: "/chat?app=master&project=hanse-master",
      settingsHref: "/projects/hanse-master/apps/master/settings",
      skillsHref: "/projects/hanse-master/apps/master/skills",
    });
    expect(payload.chrome).toMatchObject({
      title: "Hanse master",
      active: "project",
      activeProjectId: "hanse-master",
    });
  });

  it("404s an unknown project and an invalid project path", () => {
    const f = fixture();
    const missing = handleUiApi(f.deps, request("/api/ui/projects/missing", cookie(f.humanToken)));
    expect(missing).toMatchObject({ status: 404 });
    expect(missing?.headers?.["cache-control"]).toBe("no-store");

    const invalidPath = handleUiApi(f.deps, request("/api/ui/projects/", cookie(f.humanToken)));
    expect(invalidPath).toBeUndefined();

    const throughHandler = handleRequest(f.deps, {
      method: "GET",
      path: "/api/ui/projects/",
      headers: cookie(f.humanToken),
    });
    expect(throughHandler).toMatchObject({ status: 404 });
  });

  it("returns server-rendered chrome fragments for a path", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/chrome", cookie(f.humanToken), { path: "/projects/p/apps/web" }),
    );
    expect(response).toMatchObject({ status: 200 });
    const payload = JSON.parse(response?.body ?? "{}");
    expect(payload).toMatchObject({ title: "web", active: "project" });
    expect(payload.sidebarNav).toContain("Alpha");
    expect(payload.breadcrumb).toContain("web");
    expect(payload.breadcrumb).toContain("Alpha");
    expect(payload.sidebarNav).not.toContain("<nav");
    expect(payload.breadcrumb).not.toContain("<nav");
  });

  it("does not scope sidebar links from a skill id", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/chrome", cookie(f.humanToken), { path: "/skills/7" }),
    );
    expect(response).toMatchObject({ status: 200 });
    const payload = JSON.parse(response?.body ?? "{}");
    expect(payload).toMatchObject({ active: "skills" });
    expect(payload.sidebarNav).toContain('href="/settings"');
    expect(payload.sidebarNav).toContain('href="/skills"');
    expect(payload.sidebarNav).not.toContain("/projects/7/");
    expect(payload.sidebarNav).not.toContain('data-project-id="7"');
  });

  it("404s an unknown chrome path", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/chrome", cookie(f.humanToken), { path: "/api/projects" }),
    );
    expect(response).toMatchObject({ status: 404 });
  });

  it("never leaks seeded secrets through the props, chrome, or boot", () => {
    const f = fixture();
    const providerSecret = "sentinel-provider-key";
    const gitSecret = "sentinel-git-token";
    const settingSecret = "sentinel-setting-value";
    f.settings.setProviderKey("global", {}, "deepseek", providerSecret, "owner");
    f.settings.setGitAuth(
      "global",
      {},
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: gitSecret },
      "owner",
    );
    f.settings.set("global", {}, "git.user.name", settingSecret, "owner");

    for (const route of ROUTES) {
      const pathname = route.path.replace(":id", "p").replace(":app", "web");
      const chrome = handleUiApi(
        f.deps,
        request("/api/ui/chrome", cookie(f.humanToken), { path: pathname }),
      );
      expect(chrome?.body, route.id).not.toContain(providerSecret);
      expect(chrome?.body, route.id).not.toContain(gitSecret);
      expect(chrome?.body, route.id).not.toContain(settingSecret);
    }

    for (const pathname of ["/api/ui/overview", "/api/ui/projects/p"]) {
      const props = handleUiApi(f.deps, request(pathname, cookie(f.humanToken)));
      expect(props?.status, pathname).toBe(200);
      expect(props?.body, pathname).not.toContain(providerSecret);
      expect(props?.body, pathname).not.toContain(gitSecret);
      expect(props?.body, pathname).not.toContain(settingSecret);
    }

    enable(f);
    for (const route of ROUTES) {
      const pathname = route.path.replace(":id", "p").replace(":app", "web");
      const page = maybeServeSpa(
        f.deps,
        request(pathname, { ...cookie(f.humanToken), accept: "text/html" }),
      );
      expect(page?.status, route.id).toBe(200);
      expect(page?.body, route.id).not.toContain(providerSecret);
      expect(page?.body, route.id).not.toContain(gitSecret);
      expect(page?.body, route.id).not.toContain(settingSecret);
    }
  });
});

describe("maybeServeSpa", () => {
  it("is a no-op when every route is disabled", () => {
    const f = fixture();
    process.env.HANSE_UI_LEGACY = "1";
    expect(
      maybeServeSpa(f.deps, request("/projects", { ...cookie(f.humanToken), accept: "text/html" })),
    ).toBeUndefined();

    delete process.env.HANSE_UI_LEGACY;
    process.env.HANSE_UI_SPA_ROUTES = "";
    expect(
      maybeServeSpa(f.deps, request("/projects", { ...cookie(f.humanToken), accept: "text/html" })),
    ).toBeUndefined();
  });

  it("treats an empty allowlist and ?legacy=1 as legacy", () => {
    const f = fixture();
    delete process.env.HANSE_UI_LEGACY;
    process.env.HANSE_UI_SPA_ROUTES = "";
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    expect(
      maybeServeSpa(f.deps, request("/projects", { ...cookie(f.humanToken), accept: "text/html" })),
    ).toBeUndefined();

    process.env.HANSE_UI_SPA_ROUTES = "projects";
    expect(
      maybeServeSpa(
        f.deps,
        request("/projects", { ...cookie(f.humanToken), accept: "text/html" }, { legacy: "1" }),
      ),
    ).toBeUndefined();
  });

  it("serves the SPA only for GET/HEAD HTML requests", () => {
    const f = fixture();
    enable(f);
    expect(
      maybeServeSpa(f.deps, {
        method: "POST",
        path: "/projects",
        headers: { ...cookie(f.humanToken), accept: "text/html" },
      }),
    ).toBeUndefined();
    expect(
      maybeServeSpa(
        f.deps,
        request("/projects", { ...cookie(f.humanToken), accept: "application/json" }),
      ),
    ).toBeUndefined();
  });

  it("rejects an agent token before auth", () => {
    const f = fixture();
    enable(f);
    const response = maybeServeSpa(
      f.deps,
      request("/projects", {
        authorization: `Bearer ${f.agentBearerToken}`,
        cookie: `hanse_token=${encodeURIComponent(f.humanToken)}`,
        accept: "text/html",
      }),
    );
    expect(response).toMatchObject({ status: 403 });
    expect(JSON.parse(response?.body ?? "{}")).toEqual({
      error: "agent tokens may only call the MCP endpoint",
    });
  });

  it("redirects a human bearer without a cookie to login", () => {
    const f = fixture();
    enable(f);
    const response = maybeServeSpa(
      f.deps,
      request("/projects", {
        authorization: `Bearer ${f.humanToken}`,
        accept: "text/html",
      }),
    );
    expect(response).toMatchObject({ status: 302 });
    expect(response?.headers?.location).toBe("/login?next=%2Fprojects");
  });

  it("serves the SPA document for a human cookie", () => {
    const f = fixture();
    enable(f);
    const response = maybeServeSpa(
      f.deps,
      request("/projects", { ...cookie(f.humanToken), accept: "text/html" }),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    expect(response?.body).toContain('<script id="hanse-boot" type="application/json">');
    expect(response?.body).toContain("/assets/ui/@vite/client");
    expect(response?.body).not.toContain("/assets/app-content.js");
  });

  it("boots overview and project props for enabled routes", () => {
    const f = fixture();
    enable(f);
    const overview = maybeServeSpa(
      f.deps,
      request("/", { ...cookie(f.humanToken), accept: "text/html" }),
    );
    const overviewBoot = boot(overview?.body ?? "");
    expect(overviewBoot.route.id).toBe("overview");
    expect(overviewBoot.props.counts).toMatchObject({ projects: 1, applications: 1 });
    expect(overviewBoot.chrome).toMatchObject({ title: "Fleet overview", active: "overview" });

    const project = maybeServeSpa(
      f.deps,
      request("/projects/p", { ...cookie(f.humanToken), accept: "text/html" }),
    );
    const projectBoot = boot(project?.body ?? "");
    expect(projectBoot.route.id).toBe("project");
    expect(projectBoot.props.project).toMatchObject({ id: "p", name: "Alpha" });
    expect(projectBoot.chrome).toMatchObject({
      title: "Alpha",
      active: "project",
      activeProjectId: "p",
    });
  });

  it("logs unknown allowlist ids and keeps them legacy", () => {
    const f = fixture();
    delete process.env.HANSE_UI_LEGACY;
    process.env.HANSE_UI_SPA_ROUTES = "projects,not-a-route";
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    maybeServeSpa(f.deps, request("/projects", { ...cookie(f.humanToken), accept: "text/html" }));
    expect(f.log.warn).toHaveBeenCalledWith("ui.unknown_route", { id: "not-a-route" });
  });
});
