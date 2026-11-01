import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../../src/coordinator/service.js";
import { GitService } from "../../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../../src/http/handler.js";
import { maybeServeSpa } from "../../src/http/spa.js";
import { createPrincipal } from "../../src/identity/principals.js";
import { isLegacyRetired, routeById } from "../../src/shared/routes.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const env = {
  HANSE_UI_LEGACY: process.env.HANSE_UI_LEGACY,
  HANSE_UI_SPA_ROUTES: process.env.HANSE_UI_SPA_ROUTES,
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

describe("retired chat and terminal routes", () => {
  it("marks both routes as retired", () => {
    expect(routeById("chat")).toMatchObject({ spa: true, legacyRetired: true });
    expect(routeById("terminal")).toMatchObject({ spa: true, legacyRetired: true });
    expect(isLegacyRetired("chat")).toBe(true);
    expect(isLegacyRetired("terminal")).toBe(true);
  });

  it("serves SPA despite legacy env, query, and allowlist inputs", () => {
    const f = fixture();
    const headers = { accept: "text/html", cookie: `hanse_token=${encodeURIComponent(f.token)}` };
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    process.env.HANSE_UI_LEGACY = "1";
    process.env.HANSE_UI_SPA_ROUTES = "";
    for (const pathname of ["/chat", "/terminal"]) {
      const response = maybeServeSpa(
        f.deps,
        request(pathname, f.token, { app: "web", project: "p", legacy: "1" }),
      );
      expect(response?.status, pathname).toBe(200);
      expect(response?.body, pathname).toContain('id="hanse-boot"');
      expect(response?.body, pathname).not.toContain("/assets/chat.js");
      expect(response?.body, pathname).not.toContain("/assets/terminal.js");
      expect(headers.accept).toBe("text/html");
    }
  });

  it("returns an explicit 503 instead of a deleted legacy page when the UI build is missing", () => {
    const f = fixture();
    delete process.env.HANSE_UI_DEV_URL;
    delete process.env.HANSE_UI_LEGACY;
    process.env.HANSE_ASSETS = path.join(f.root, "empty-assets");
    for (const pathname of ["/chat", "/terminal"]) {
      const response = maybeServeSpa(
        f.deps,
        request(pathname, f.token, { app: "web", project: "p" }),
      );
      expect(response?.status, pathname).toBe(503);
      expect(response?.body, pathname).toContain("Interface build missing");
      expect(response?.body, pathname).not.toContain("/assets/app-content.js");
      expect(response?.body, pathname).not.toContain("/assets/chat.js");
      expect(response?.body, pathname).not.toContain("/assets/terminal.js");
    }
  });

  it("keeps the chat entry semantics inside the SPA dispatcher", () => {
    const f = fixture();
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    const noApp = maybeServeSpa(f.deps, request("/chat", f.token));
    expect(noApp?.status).toBe(302);
    expect(noApp?.headers?.location).toBe("/chat?app=web&project=p");

    const unknown = maybeServeSpa(
      f.deps,
      request("/chat", f.token, { app: "missing", project: "p" }),
    );
    expect(unknown?.status).toBe(404);
    expect(unknown?.body).toContain("Nothing is moored here");
    expect(unknown?.body).not.toContain("/assets/app-content.js");
  });

  it("renders the shell-only no-apps entry page and terminal 404", () => {
    const empty = fixture(false);
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    const noApps = maybeServeSpa(empty.deps, request("/chat", empty.token));
    expect(noApps?.status).toBe(200);
    expect(noApps?.body).toContain("No applications yet");
    expect(noApps?.body).not.toContain("/assets/app-content.js");

    const terminal = maybeServeSpa(
      empty.deps,
      request("/terminal", empty.token, { app: "web", project: "p" }),
    );
    expect(terminal?.status).toBe(404);
    expect(terminal?.body).not.toContain("/assets/app-content.js");
  });
});
