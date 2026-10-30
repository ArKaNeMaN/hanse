import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { handleChat } from "../src/http/chat.js";
import { buildSite, type PageChrome } from "../src/http/dashboard.js";
import { type HttpDeps, type HttpRequest, handleRequest } from "../src/http/handler.js";
import { maybeServeSpa } from "../src/http/spa.js";
import { renderTerminalPage } from "../src/http/terminal.js";
import { createPrincipal } from "../src/identity/principals.js";
import { ROUTES, routeById } from "../src/shared/routes.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

// Baseline hashes captured from HEAD 292aa48 before Stage 1. The legacy renderers are frozen until
// Stage 9, so any change is a byte-identity regression.
const CHAT_SHA256 = "bd4c2e695eb6e8ba8be17c5b398d5bc7899133702423126be69fda0861c42aab";
const TERMINAL_SHA256 = "f5878374a8a6bd85798722d4bce295a62816654330de04ae817e3ee3103f2060";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const originalLegacy = process.env.HANSE_UI_LEGACY;
const originalAllowlist = process.env.HANSE_UI_SPA_ROUTES;
const originalDevUrl = process.env.HANSE_UI_DEV_URL;
const originalIdeUrl = process.env.HANSE_IDE_URL;

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ["HANSE_UI_LEGACY", originalLegacy],
    ["HANSE_UI_SPA_ROUTES", originalAllowlist],
    ["HANSE_UI_DEV_URL", originalDevUrl],
    ["HANSE_IDE_URL", originalIdeUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Fixture {
  deps: HttpDeps;
  token: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-legacy-bytes-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at) VALUES ('p','Alpha','main','/workspace/legacy-project',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at) VALUES ('p:web','p','web','apps/web','app','AGENTS.md',?)",
  ).run(now);
  const service = new CoordinatorService(db, "p");
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/workspace",
    git: new GitService({ workspaceRoot: "/workspace" }),
    getProjects: () => [
      {
        id: "p",
        name: "Alpha",
        rootPath: "/workspace/legacy-project",
        workspaceRoot: "/workspace",
        service,
      },
    ],
  };
  return {
    deps,
    token: createPrincipal(db, { kind: "human", name: "operator" }).token,
  };
}

function request(pathname: string, token: string, query: Record<string, string> = {}): HttpRequest {
  return {
    method: "GET",
    path: pathname,
    headers: { authorization: `Bearer ${token}` },
    query,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function chrome(): PageChrome {
  return { operatorName: "operator" };
}

describe("legacy chat and terminal byte identity", () => {
  it("keeps both registry flags off in Stage 1", () => {
    expect(routeById("chat")?.spa).toBe(false);
    expect(routeById("terminal")?.spa).toBe(false);
    expect(routeById("chat")?.legacyRetired).toBe(false);
    expect(routeById("terminal")?.legacyRetired).toBe(false);
  });

  it("keeps /chat on the legacy renderer byte-for-byte", async () => {
    delete process.env.HANSE_IDE_URL;
    const f = fixture();
    const response = await handleChat(
      f.deps,
      request("/chat", f.token, { app: "web", project: "p" }),
    );
    expect(response.status).toBe(200);
    expect(sha256(response.body)).toBe(CHAT_SHA256);
  });

  it("keeps /terminal on the legacy renderer byte-for-byte", () => {
    delete process.env.HANSE_IDE_URL;
    const f = fixture();
    const response = handleRequest(
      f.deps,
      request("/terminal", f.token, { app: "web", project: "p" }),
    );
    expect(response.status).toBe(200);
    expect(sha256(response.body)).toBe(TERMINAL_SHA256);

    const direct = renderTerminalPage(buildSite(f.deps), "p", "web", chrome());
    expect(direct).toBeDefined();
    expect(sha256(direct ?? "")).toBe(TERMINAL_SHA256);
  });

  it("never serves /chat or /terminal as SPA without a cutover", () => {
    const f = fixture();
    delete process.env.HANSE_UI_LEGACY;
    process.env.HANSE_UI_SPA_ROUTES = ROUTES.filter((route) => route.spa)
      .map((route) => route.id)
      .join(",");
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";
    for (const pathname of ["/chat", "/terminal"]) {
      const response = maybeServeSpa(f.deps, {
        ...request(pathname, f.token, { app: "web", project: "p" }),
        headers: {
          cookie: `hanse_token=${encodeURIComponent(f.token)}`,
          accept: "text/html",
        },
      });
      expect(response, pathname).toBeUndefined();
    }
  });
});
