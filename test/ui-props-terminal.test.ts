import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handleRequest } from "../src/http/handler.js";
import { handleUiApi } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { SettingsService } from "../src/settings/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

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
});

interface Fixture {
  deps: HttpDeps;
  token: string;
  recordOperatorHost: ReturnType<typeof vi.fn>;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-terminal-props-"));
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
  const recordOperatorHost = vi.fn();
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/workspace",
    git: new GitService({ workspaceRoot: "/workspace" }),
    settings: new SettingsService({ db, secretKey: randomBytes(32) }),
    previews: {
      recordOperatorHost,
      views: vi.fn(() => []),
    } as unknown as HttpDeps["previews"],
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
    deps,
    token: createPrincipal(db, { kind: "human", name: "alice" }).token,
    recordOperatorHost,
  };
}

function cookie(token: string): Record<string, string> {
  return { cookie: `hanse_token=${encodeURIComponent(token)}` };
}

function request(
  headers: Record<string, string>,
  query: Record<string, string> = {},
  host?: string,
): HttpRequest {
  return {
    method: "GET",
    path: "/api/ui/terminal",
    headers,
    query,
    ...(host === undefined ? {} : { host }),
  };
}

describe("/api/ui/terminal", () => {
  it("returns the terminal page frame and WS path for a human cookie", () => {
    const f = fixture();
    const response = handleUiApi(f.deps, request(cookie(f.token), { app: "web", project: "p" }));
    expect(response).toMatchObject({ status: 200 });
    expect(response?.headers?.["cache-control"]).toBe("no-store");
    const payload = JSON.parse(response?.body ?? "{}");
    expect(payload.app).toEqual({
      id: "p:web",
      projectId: "p",
      projectName: "Alpha",
      appKey: "web",
      href: "/projects/p/apps/web",
      folder: "/workspace/p/apps/web",
    });
    expect(payload.links).toEqual({
      app: "/projects/p/apps/web",
      chat: "/chat?app=web&project=p",
      ide: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Fweb",
    });
    expect(payload.runtime).toEqual({
      state: "stopped",
      wsPath: "/api/apps/web/terminal?project=p",
      runtimeUrl: "/api/apps/web/runtime?project=p",
    });
    expect(payload.deleting).toBe(false);
    expect(payload.breadcrumb).toEqual([
      { label: "Projects", href: "/projects" },
      { label: "Alpha", href: "/projects/p" },
      { label: "web", href: "/projects/p/apps/web" },
      { label: "Terminal" },
    ]);
    expect(payload.title).toBe("web terminal");
    expect(payload.topbar).toEqual({ ideHref: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Fweb" });
    expect(payload.chrome).toMatchObject({
      title: "web terminal",
      active: "project",
      activeProjectId: "p",
    });
    expect(payload.chrome.breadcrumb).toContain("Terminal");
  });

  it("never records the operator host from the terminal endpoint", () => {
    const f = fixture();
    handleUiApi(f.deps, request(cookie(f.token), { app: "web", project: "p" }, "operator.example"));
    expect(f.recordOperatorHost).not.toHaveBeenCalled();
  });

  it("404s a missing or unknown app", () => {
    const f = fixture();
    for (const query of [
      { project: "p", app: "missing" },
      { project: "missing", app: "web" },
      {},
    ]) {
      const response = handleUiApi(f.deps, request(cookie(f.token), query));
      expect(response, JSON.stringify(query)).toMatchObject({ status: 404 });
      expect(response?.headers?.["cache-control"]).toBe("no-store");
    }
  });
  it("characterizes the same page-frame values the legacy renderer emits", () => {
    const f = fixture();
    const response = handleUiApi(f.deps, request(cookie(f.token), { app: "web", project: "p" }));
    const props = JSON.parse(response?.body ?? "{}");
    const legacy = handleRequest(f.deps, {
      method: "GET",
      path: "/terminal",
      headers: { authorization: `Bearer ${f.token}` },
      query: { app: "web", project: "p" },
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body).toContain(`data-terminal-ws="${props.runtime.wsPath}"`);
    expect(legacy.body).toContain(`data-runtime-url="${props.runtime.runtimeUrl}"`);
    expect(legacy.body).toContain(`data-app-key="${props.app.appKey}"`);
    expect(legacy.body).toContain(`data-project-id="${props.app.projectId}"`);
  });
});
