import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { maybeServeSpa } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { routeById } from "../src/shared/routes.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const env = {
  HANSE_UI_DEV_URL: process.env.HANSE_UI_DEV_URL,
  HANSE_ASSETS: process.env.HANSE_ASSETS,
};

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Fixture {
  deps: HttpDeps;
  token: string;
  root: string;
}

function fixture(withApp = true): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-retired-"));
  dirs.push(root);
  const db = openDatabase(path.join(root, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Alpha','main','/workspace/project',?,?)",
  ).run(now, now);
  if (withApp) {
    db.prepare(
      "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:web','p','web','apps/web','app','AGENTS.md',?)",
    ).run(now);
  }
  const service = new CoordinatorService(db, "p");
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/workspace",
    git: new GitService({ workspaceRoot: "/workspace" }),
    getProjects: () => [
      {
        id: "p",
        name: "Alpha",
        rootPath: "/workspace/project",
        workspaceRoot: "/workspace",
        service,
      },
    ],
  };
  return {
    deps,
    token: createPrincipal(db, { kind: "human", name: "operator" }).token,
    root,
  };
}

function request(pathname: string, token: string, query: Record<string, string> = {}): HttpRequest {
  return {
    method: "GET",
    path: pathname,
    headers: {
      accept: "text/html",
      cookie: `hanse_token=${encodeURIComponent(token)}`,
    },
    query,
  };
}

function boot(body: string): Record<string, unknown> {
  const match = /<script id="hanse-boot" type="application\/json">(.*?)<\/script>/s.exec(body);
  if (match === null) throw new Error("missing boot payload");
  return JSON.parse(match[1] ?? "") as Record<string, unknown>;
}

describe("chat and terminal routes", () => {
  it("keeps both routes in the shared registry", () => {
    expect(routeById("chat")).toMatchObject({ path: "/chat", nav: "none" });
    expect(routeById("terminal")).toMatchObject({ path: "/terminal", nav: "project" });
  });

  it("serves SPA despite a stale legacy query", () => {
    const f = fixture();
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    for (const pathname of ["/chat", "/terminal"]) {
      const response = maybeServeSpa(
        f.deps,
        request(pathname, f.token, { app: "web", project: "p", legacy: "1" }),
      );
      expect(response?.status, pathname).toBe(200);
      expect(response?.body, pathname).toContain('id="hanse-boot"');
      expect(response?.body, pathname).not.toContain("/assets/app.js");
      expect(response?.body, pathname).not.toContain("/assets/app-content.js");
    }
  });

  it("returns a self-contained 503 when the UI build is missing", () => {
    const f = fixture();
    delete process.env.HANSE_UI_DEV_URL;
    process.env.HANSE_ASSETS = path.join(f.root, "empty-assets");
    for (const pathname of ["/chat", "/terminal"]) {
      const response = maybeServeSpa(
        f.deps,
        request(pathname, f.token, { app: "web", project: "p" }),
      );
      expect(response?.status, pathname).toBe(503);
      expect(response?.body, pathname).toContain("Interface unavailable");
      expect(response?.body, pathname).not.toContain("/assets/app.css");
      expect(response?.body, pathname).not.toContain("/assets/app.js");
    }
  });

  it("redirects chat with no app to the first operator app", () => {
    const f = fixture();
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    const noApp = maybeServeSpa(f.deps, request("/chat", f.token));
    expect(noApp?.status).toBe(302);
    expect(noApp?.headers?.location).toBe("/chat?app=web&project=p");
  });

  it("serves a Vue 404 boot for an unknown app", () => {
    const f = fixture();
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    const unknown = maybeServeSpa(
      f.deps,
      request("/chat", f.token, { app: "missing", project: "p" }),
    );
    expect(unknown?.status).toBe(404);
    expect(boot(unknown?.body ?? "")).toMatchObject({
      route: { id: "not-found", params: {} },
      override: "not-found",
    });
    expect(unknown?.body).not.toContain("/assets/app-content.js");
  });

  it("serves the Vue no-apps boot when there are no operator applications", () => {
    const empty = fixture(false);
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    const noApps = maybeServeSpa(empty.deps, request("/chat", empty.token));
    expect(noApps?.status).toBe(200);
    expect(boot(noApps?.body ?? "")).toMatchObject({
      route: { id: "chat", params: {} },
      props: { noApps: true },
      override: "chat-no-apps",
    });
    expect(noApps?.body).not.toContain("/assets/app-content.js");
  });

  it("serves a Vue 404 boot for terminal without a valid app", () => {
    const empty = fixture(false);
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    const terminal = maybeServeSpa(
      empty.deps,
      request("/terminal", empty.token, { app: "web", project: "p" }),
    );
    expect(terminal?.status).toBe(404);
    expect(boot(terminal?.body ?? "")).toMatchObject({ override: "not-found" });
  });
});
