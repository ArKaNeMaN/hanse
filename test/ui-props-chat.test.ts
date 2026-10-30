import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleChat } from "../src/http/chat.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { handleUiApi } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import type { PreviewView } from "../src/preview/types.js";
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
  views: ReturnType<typeof vi.fn>;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-chat-props-"));
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
  const views = vi.fn((): PreviewView[] => []);
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/workspace",
    git: new GitService({ workspaceRoot: "/workspace" }),
    settings: new SettingsService({ db, secretKey: randomBytes(32) }),
    previews: { recordOperatorHost, views } as unknown as HttpDeps["previews"],
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
    views,
  };
}

function cookie(token: string): Record<string, string> {
  return { cookie: `hanse_token=${encodeURIComponent(token)}` };
}

function request(
  pathname: string,
  headers: Record<string, string>,
  query: Record<string, string> = {},
  host?: string,
): HttpRequest {
  return {
    method: "GET",
    path: pathname,
    headers,
    query,
    ...(host === undefined ? {} : { host }),
  };
}

describe("/api/ui/chat", () => {
  it("returns the chat page frame for a human cookie", () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/chat", cookie(f.token), { app: "web", project: "p" }),
    );
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
      master: false,
    });
    expect(payload.links).toEqual({
      app: "/projects/p/apps/web",
      ide: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Fweb",
      settings: "/projects/p/apps/web/settings",
      skills: "/projects/p/apps/web/skills",
      terminal: "/terminal?app=web&project=p",
      handoffs: "/handoffs?q=web",
    });
    expect(payload.runtime).toEqual({
      state: "stopped",
      runtimeUrl: "/api/apps/web/runtime?project=p",
    });
    expect(payload.appOptions).toEqual([
      {
        projectId: "p",
        projectName: "Alpha",
        apps: [{ appKey: "web", value: "p:web", projectId: "p", selected: true }],
      },
    ]);
    expect(payload.pendingRestart).toBe(false);
    expect(payload.handoffs).toEqual([]);
    expect(payload.previews).toEqual([]);
    expect(payload.deleting).toEqual({ app: false, project: false, pending: false });
    expect(payload.breadcrumb).toEqual([
      { label: "Projects", href: "/projects" },
      { label: "Alpha", href: "/projects/p" },
      { label: "web", href: "/projects/p/apps/web" },
      { label: "Chat" },
    ]);
    expect(payload.title).toBe("web chat");
    expect(payload.topbar).toEqual({
      ideHref: "/ide/?folder=%2Fworkspace%2Fp%2Fapps%2Fweb",
      needsInputCount: 0,
      policyVisible: false,
      contextToggle: true,
    });
    expect(payload.chrome).toMatchObject({
      title: "web chat",
      active: "none",
      activeProjectId: "p",
    });
    expect(payload.chrome.breadcrumb).toContain("Chat");
    expect(payload).not.toHaveProperty("initialSession");
    expect(payload).not.toHaveProperty("session");
  });

  it("records the operator host only when the request carries one", () => {
    const f = fixture();
    handleUiApi(f.deps, request("/api/ui/chat", cookie(f.token), { app: "web", project: "p" }));
    expect(f.recordOperatorHost).not.toHaveBeenCalled();

    handleUiApi(
      f.deps,
      request("/api/ui/chat", cookie(f.token), { app: "web", project: "p" }, "operator.example"),
    );
    expect(f.recordOperatorHost).toHaveBeenCalledWith("p:web", "operator.example");
  });

  it("404s a missing or unknown app without leaking data", () => {
    const f = fixture();
    for (const query of [
      { project: "p", app: "missing" },
      { project: "missing", app: "web" },
      {},
    ]) {
      const response = handleUiApi(f.deps, request("/api/ui/chat", cookie(f.token), query));
      expect(response, JSON.stringify(query)).toMatchObject({ status: 404 });
      expect(response?.headers?.["cache-control"]).toBe("no-store");
    }
  });

  it("never leaks settings credentials through the chat props", () => {
    const f = fixture();
    const secret = "sentinel-provider-key";
    f.deps.settings?.setProviderKey("global", {}, "deepseek", secret, "owner");
    const response = handleUiApi(
      f.deps,
      request("/api/ui/chat", cookie(f.token), { app: "web", project: "p" }),
    );
    expect(response?.body).not.toContain(secret);
  });
  it("resolves chat and terminal chrome from project/app hints", () => {
    const f = fixture();
    const chat = handleUiApi(
      f.deps,
      request("/api/ui/chrome", cookie(f.token), { path: "/chat", project: "p", app: "web" }),
    );
    expect(chat).toMatchObject({ status: 200 });
    const chatChrome = JSON.parse(chat?.body ?? "{}");
    expect(chatChrome).toMatchObject({
      title: "web chat",
      active: "none",
      activeProjectId: "p",
    });
    expect(chatChrome.breadcrumb).toContain("Chat");
    expect(chatChrome.breadcrumb).toContain("Alpha");

    const terminal = handleUiApi(
      f.deps,
      request("/api/ui/chrome", cookie(f.token), {
        path: "/terminal",
        project: "p",
        app: "web",
      }),
    );
    expect(terminal).toMatchObject({ status: 200 });
    const terminalChrome = JSON.parse(terminal?.body ?? "{}");
    expect(terminalChrome).toMatchObject({
      title: "web terminal",
      active: "project",
      activeProjectId: "p",
    });
    expect(terminalChrome.breadcrumb).toContain("Terminal");
  });
  it("characterizes the same page-frame values the legacy renderer emits", async () => {
    const f = fixture();
    const response = handleUiApi(
      f.deps,
      request("/api/ui/chat", cookie(f.token), { app: "web", project: "p" }),
    );
    const props = JSON.parse(response?.body ?? "{}");
    const legacy = await handleChat(f.deps, {
      method: "GET",
      path: "/chat",
      headers: { authorization: `Bearer ${f.token}` },
      query: { app: "web", project: "p" },
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body).toContain(`data-app-key="${props.app.appKey}"`);
    expect(legacy.body).toContain(`data-project-id="${props.app.projectId}"`);
    expect(legacy.body).toContain(`data-runtime-url="${props.runtime.runtimeUrl}"`);
    expect(legacy.body).toContain(`href="${props.links.app}"`);
    expect(legacy.body).toContain('id="chat-input-needed-count"');
    expect(legacy.body).toContain('id="chat-policy-chip"');
    expect(legacy.body).toContain("data-chat-context-toggle");
  });
});
