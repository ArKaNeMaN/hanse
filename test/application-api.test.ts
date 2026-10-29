import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { createHttpServer } from "../src/http/server.js";
import { handleAppUiApi, handleUiApi, maybeServeSpa } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { mintAgentToken } from "../src/mcp/agent-tokens.js";
import type { InstanceManager } from "../src/opencode/manager.js";
import { SettingsService } from "../src/settings/index.js";
import { ROUTES } from "../src/shared/routes.js";
import type { SshService } from "../src/ssh/service.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const servers: Server[] = [];
const originalLegacy = process.env.HANSE_UI_LEGACY;
const originalAllowlist = process.env.HANSE_UI_SPA_ROUTES;
const originalDevUrl = process.env.HANSE_UI_DEV_URL;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalLegacy === undefined) delete process.env.HANSE_UI_LEGACY;
  else process.env.HANSE_UI_LEGACY = originalLegacy;
  if (originalAllowlist === undefined) delete process.env.HANSE_UI_SPA_ROUTES;
  else process.env.HANSE_UI_SPA_ROUTES = originalAllowlist;
  if (originalDevUrl === undefined) delete process.env.HANSE_UI_DEV_URL;
  else process.env.HANSE_UI_DEV_URL = originalDevUrl;
});

interface Fixture {
  root: string;
  db: SqliteDatabase;
  deps: HttpDeps;
  settings: SettingsService;
  humanToken: string;
  agentBearerToken: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-app-api-"));
  dirs.push(root);
  const projectRoot = path.join(root, "p");
  mkdirSync(path.join(projectRoot, "apps", "web"), { recursive: true });
  const db = openDatabase(path.join(root, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Alpha','main',?,?,?)",
  ).run(projectRoot, now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:web','p','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  const service = new CoordinatorService(db, "p");
  const settings = new SettingsService({ db, secretKey: randomBytes(32) });
  const human = createPrincipal(db, { kind: "human", name: "alice" });
  const agentBearerToken = mintAgentToken(db, "p:web");
  const ssh = {
    listAllHosts: () => [{ host: { id: "h1", name: "deploy" } }],
    listGrants: () => [],
    listPending: () => [],
    listAudit: () => [],
  } as unknown as SshService;
  const manager = {
    pendingRestart: () => ({ pending: false, reasons: [] }),
    profileWarnings: () => ["profile_not_applied"],
  } as unknown as InstanceManager;
  const deps: HttpDeps = {
    db,
    workspaceRoot: root,
    git: new GitService({ workspaceRoot: root }),
    settings,
    ssh,
    manager,
    getProjects: () => [
      {
        id: "p",
        name: "Alpha",
        rootPath: projectRoot,
        workspaceRoot: root,
        service,
      },
    ],
  };
  return { root, db, deps, settings, humanToken: human.token, agentBearerToken };
}

function cookie(token: string): Record<string, string> {
  return { cookie: `hanse_token=${encodeURIComponent(token)}` };
}

function request(
  pathname: string,
  headers: Record<string, string>,
  query?: Record<string, string>,
): HttpRequest {
  return { method: "GET", path: pathname, headers, ...(query === undefined ? {} : { query }) };
}

interface AppApiPayload {
  identity: { projectId: string; appKey: string; master: boolean };
  runtime: { state: string; configured: boolean };
  settings: { state: string };
  image: { status: string };
  git: {
    apiBase: string;
    statusHref: string;
    summary: {
      loaded: boolean;
      state: string;
      branch: { name: string | null; head: string | null } | null;
      upstream: { name: string; ahead: number; behind: number } | null;
      dirty: boolean;
      conflicted: boolean;
      detached: boolean;
      lastCommit: { subject: string } | null;
    };
  };
  ssh: { available: boolean; hosts: number; pendingApprovals: number };
  links: Record<string, string>;
  restart: { available: boolean; action: string };
  delete: { action: string; confirmName: string; dialog: string };
  profileWarnings: readonly string[];
  chrome: { title: string; active: string; activeProjectId?: string };
}

function appGitStatus() {
  return {
    state: "ok" as const,
    branch: { name: "main", detached: false, head: "abcdef123456" },
    upstream: { name: "origin/main", ahead: 2, behind: 1 },
    clean: false,
    files: [{ path: "a.ts", code: "M", group: "unstaged" as const }],
    conflicted: false,
    lastCommit: {
      hash: "abcdef123456",
      shortHash: "abcdef1",
      subject: "feat: app panel",
      author: "Operator",
      committedAt: "2026-10-20T10:00:00.000Z",
    },
  };
}

function boot(body: string): { route: { id: string }; props: AppApiPayload } {
  const match = /<script id="hanse-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(body);
  return JSON.parse(match?.[1] ?? "{}") as { route: { id: string }; props: AppApiPayload };
}

describe("GET /api/ui/apps/:app", () => {
  it("requires a human cookie, rejects bearers, and never caches", async () => {
    const f = fixture();
    const pathname = "/api/ui/apps/web";

    const anonymous = await handleAppUiApi(f.deps, request(pathname, {}, { project: "p" }));
    expect(anonymous).toMatchObject({ status: 401 });
    expect(anonymous?.headers?.["cache-control"]).toBe("no-store");
    expect(JSON.parse(anonymous?.body ?? "{}")).toEqual({
      error: "sign in required",
      code: "unauthenticated",
    });

    const bearer = await handleAppUiApi(
      f.deps,
      request(pathname, { authorization: `Bearer ${f.humanToken}` }, { project: "p" }),
    );
    expect(bearer).toMatchObject({ status: 403 });
    expect(JSON.parse(bearer?.body ?? "{}")).toEqual({
      error: "cookie sign-in required",
      code: "cookie_required",
    });

    const agent = await handleAppUiApi(
      f.deps,
      request(
        pathname,
        {
          authorization: `Bearer ${f.agentBearerToken}`,
          ...cookie(f.humanToken),
        },
        { project: "p" },
      ),
    );
    expect(agent).toMatchObject({ status: 403 });
    expect(JSON.parse(agent?.body ?? "{}")).toEqual({
      error: "agent tokens may only call the MCP endpoint",
    });
  });

  it("404s an unknown app, project, or missing project query", async () => {
    const f = fixture();
    for (const target of [
      request("/api/ui/apps/missing", cookie(f.humanToken), { project: "p" }),
      request("/api/ui/apps/web", cookie(f.humanToken), { project: "missing" }),
      request("/api/ui/apps/web", cookie(f.humanToken)),
    ]) {
      const response = await handleAppUiApi(f.deps, target);
      expect(response).toMatchObject({ status: 404 });
      expect(response?.headers?.["cache-control"]).toBe("no-store");
    }
  });

  it("returns the app props aggregate with chrome and the live git read summary", async () => {
    const f = fixture();
    vi.spyOn(f.deps.git, "statusFor").mockResolvedValue(appGitStatus());
    const response = await handleAppUiApi(
      f.deps,
      request("/api/ui/apps/web", cookie(f.humanToken), { project: "p" }),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response?.body ?? "{}") as AppApiPayload;
    expect(payload.identity).toMatchObject({
      projectId: "p",
      appKey: "web",
      master: false,
    });
    expect(payload.runtime).toMatchObject({ state: "stopped", configured: true });
    expect(payload.settings.state).toBe("saved");
    expect(payload.image.status).toBe("default");
    expect(payload.git).toMatchObject({
      apiBase: "/api/projects/p/apps/web/git",
      statusHref: "/api/projects/p/apps/web/git/status",
      summary: {
        loaded: true,
        state: "ok",
        branch: { name: "main", head: "abcdef123456" },
        upstream: { name: "origin/main", ahead: 2, behind: 1 },
        dirty: true,
        conflicted: false,
        detached: false,
        lastCommit: { subject: "feat: app panel" },
      },
    });
    expect(payload.ssh).toMatchObject({ available: true, hosts: 0, pendingApprovals: 0 });
    expect(payload.links).toMatchObject({
      chat: "/chat?app=web&project=p",
      terminal: "/terminal?app=web&project=p",
      settings: "/projects/p/apps/web/settings",
      skills: "/projects/p/apps/web/skills",
      ssh: "/ssh?project=p&app=web",
    });
    expect(payload.restart).toMatchObject({
      available: false,
      action: "/api/apps/web/restart?project=p",
    });
    expect(payload.delete).toMatchObject({
      action: "/api/projects/p/apps/web/delete",
      confirmName: "web",
      dialog: "application",
    });
    expect(payload.profileWarnings).toEqual(["profile_not_applied"]);
    expect(payload.chrome).toMatchObject({
      title: "web",
      active: "project",
      activeProjectId: "p",
    });
  });

  it("is a read: it calls no git mutation and changes no rows", async () => {
    const f = fixture();
    const before = f.db.prepare("SELECT COUNT(*) AS count FROM apps").get() as { count: number };
    const status = vi.spyOn(f.deps.git, "statusFor").mockResolvedValue(appGitStatus());
    const fetchSpy = vi.spyOn(f.deps.git, "fetch");
    const updateSpy = vi.spyOn(f.deps.git, "update");
    const pushSpy = vi.spyOn(f.deps.git, "push");
    const commitSpy = vi.spyOn(f.deps.git, "commitAll");
    const switchSpy = vi.spyOn(f.deps.git, "switchBranch");

    const response = await handleAppUiApi(
      f.deps,
      request("/api/ui/apps/web", cookie(f.humanToken), { project: "p" }),
    );
    expect(response).toMatchObject({ status: 200 });
    expect(status).toHaveBeenCalledTimes(1);
    for (const spy of [fetchSpy, updateSpy, pushSpy, commitSpy, switchSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    const after = f.db.prepare("SELECT COUNT(*) AS count FROM apps").get() as { count: number };
    expect(after.count).toBe(before.count);
  });

  it("falls back to an unavailable git summary when status fails", async () => {
    const f = fixture();
    vi.spyOn(f.deps.git, "statusFor").mockRejectedValue(new Error("boom"));
    const response = await handleAppUiApi(
      f.deps,
      request("/api/ui/apps/web", cookie(f.humanToken), { project: "p" }),
    );
    expect(response).toMatchObject({ status: 200 });
    const payload = JSON.parse(response?.body ?? "{}") as AppApiPayload;
    expect(payload.git.summary).toMatchObject({
      loaded: false,
      state: "unavailable",
      message: "Repository status is unavailable.",
    });
  });

  it("never leaks seeded secrets through the endpoint, boot, or app route table entries", async () => {
    const f = fixture();
    const providerSecret = "sentinel-app-provider-key";
    const gitSecret = "sentinel-app-git-token";
    const settingSecret = "sentinel-app-setting-value";
    f.settings.setProviderKey("global", {}, "deepseek", providerSecret, "owner");
    f.settings.setGitAuth(
      "global",
      {},
      "https",
      { hosts: ["github.com"], username: "x-access-token", token: gitSecret },
      "owner",
    );
    f.settings.set("global", {}, "git.user.name", settingSecret, "owner");
    vi.spyOn(f.deps.git, "statusFor").mockResolvedValue(appGitStatus());

    const endpoint = await handleAppUiApi(
      f.deps,
      request("/api/ui/apps/web", cookie(f.humanToken), { project: "p" }),
    );
    expect(endpoint).toMatchObject({ status: 200 });
    for (const secret of [providerSecret, gitSecret, settingSecret]) {
      expect(endpoint?.body).not.toContain(secret);
    }

    delete process.env.HANSE_UI_LEGACY;
    process.env.HANSE_UI_SPA_ROUTES = "app";
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    const page = maybeServeSpa(
      f.deps,
      request("/projects/p/apps/web", { ...cookie(f.humanToken), accept: "text/html" }),
    );
    expect(page).toMatchObject({ status: 200 });
    const booted = boot(page?.body ?? "");
    expect(booted.route.id).toBe("app");
    expect(booted.props.identity).toMatchObject({ projectId: "p", appKey: "web" });
    for (const secret of [providerSecret, gitSecret, settingSecret]) {
      expect(page?.body).not.toContain(secret);
    }

    for (const route of ROUTES) {
      const pagePath = route.path.replace(":id", "p").replace(":app", "web");
      if (route.id === "app") {
        const props = await handleAppUiApi(
          f.deps,
          request("/api/ui/apps/web", cookie(f.humanToken), { project: "p" }),
        );
        expect(props?.status, route.id).toBe(200);
        expect(props?.body, route.id).not.toContain(providerSecret);
        expect(props?.body, route.id).not.toContain(gitSecret);
        continue;
      }
      const props = handleUiApi(
        f.deps,
        request("/api/ui/chrome", cookie(f.humanToken), { path: pagePath }),
      );
      if (props === undefined) continue;
      expect(props.body, route.id).not.toContain(providerSecret);
      expect(props.body, route.id).not.toContain(gitSecret);
    }
  });
});

describe("app detail endpoint over HTTP", () => {
  it("serves JSON with a human cookie and no-store through createHttpServer", async () => {
    const f = fixture();
    vi.spyOn(f.deps.git, "statusFor").mockResolvedValue(appGitStatus());
    const server = createHttpServer(f.deps);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ui/apps/web?project=p`, {
      headers: cookie(f.humanToken),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as AppApiPayload;
    expect(payload.identity).toMatchObject({ projectId: "p", appKey: "web" });
    expect(payload.git.summary.loaded).toBe(true);

    const anonymous = await fetch(`http://127.0.0.1:${address.port}/api/ui/apps/web?project=p`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
  });
});
