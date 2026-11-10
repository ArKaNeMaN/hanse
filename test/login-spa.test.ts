import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../src/git/service.js";
import type { HttpDeps, HttpRequest } from "../src/http/handler.js";
import { maybeServeSpa } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];
const env = {
  HANSE_UI_DEV_URL: process.env.HANSE_UI_DEV_URL,
  HANSE_ASSETS: process.env.HANSE_ASSETS,
};

beforeEach(() => {
  delete process.env.HANSE_UI_DEV_URL;
  delete process.env.HANSE_ASSETS;
});

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

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-login-"));
  dirs.push(root);
  const db = openDatabase(path.join(root, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  return {
    deps: {
      db,
      workspaceRoot: "/workspace",
      git: new GitService({ workspaceRoot: "/workspace" }),
      getProjects: () => [],
    },
    token: createPrincipal(db, { kind: "human", name: "operator" }).token,
    root,
  };
}

function request(
  pathname: string,
  options: { token?: string; query?: Record<string, string>; accept?: string } = {},
): HttpRequest {
  return {
    method: "GET",
    path: pathname,
    headers: {
      accept: options.accept ?? "text/html",
      ...(options.token === undefined
        ? {}
        : { cookie: `hanse_token=${encodeURIComponent(options.token)}` }),
    },
    ...(options.query === undefined ? {} : { query: options.query }),
  };
}

describe("SPA login route", () => {
  it("serves an unauthenticated static login document with no server plate or legacy scripts", () => {
    const f = fixture();
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";

    const response = maybeServeSpa(f.deps, request("/login", { query: { next: "/projects" } }));

    expect(response?.status).toBe(200);
    expect(response?.body).toContain('id="hanse-boot"');
    expect(response?.body).toContain('"route":{"id":"login","params":{}}');
    expect(response?.body).toContain('"next":"/projects"');
    expect(response?.body).toContain('<main class="cover chart-ground" id="main"></main>');
    expect(response?.body).toContain("Sign-in requires JavaScript.");
    expect(response?.body).not.toContain('class="login-plate"');
    expect(response?.body).not.toContain('action="/login"');
    expect(response?.body).not.toContain("/assets/app.js");
    expect(response?.body).not.toContain("/assets/app-content.js");
    expect(response?.body).toContain(
      '<script type="module" src="http://127.0.0.1:5173/assets/ui/main.ts">',
    );
  });

  it("redirects an authenticated session to the validated next path", () => {
    const f = fixture();
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";

    const response = maybeServeSpa(
      f.deps,
      request("/login", { token: f.token, query: { next: "/handoffs?filter=waiting" } }),
    );
    expect(response?.status).toBe(302);
    expect(response?.headers?.location).toBe("/handoffs?filter=waiting");

    const loop = maybeServeSpa(
      f.deps,
      request("/login", { token: f.token, query: { next: "/login?next=/projects" } }),
    );
    expect(loop?.headers?.location).toBe("/");

    const open = maybeServeSpa(
      f.deps,
      request("/login", { token: f.token, query: { next: "//evil.example" } }),
    );
    expect(open?.headers?.location).toBe("/");
  });

  it("serves the login document for a non-HTML Accept instead of redirect-looping", () => {
    const f = fixture();
    process.env.HANSE_UI_DEV_URL = "http://127.0.0.1:5173";

    const response = maybeServeSpa(f.deps, request("/login", { accept: "*/*" }));
    expect(response?.status).toBe(200);
    expect(response?.body).toContain('"route":{"id":"login","params":{}}');
  });

  it("returns a self-contained 503 when the UI build is missing", () => {
    const f = fixture();
    process.env.HANSE_ASSETS = path.join(f.root, "empty-assets");

    const response = maybeServeSpa(f.deps, request("/login"));
    expect(response?.status).toBe(503);
    expect(response?.body).toContain("Interface unavailable");
    expect(response?.headers?.["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response?.body).not.toContain("/assets/app.css");
    expect(response?.body).not.toContain("/assets/app.js");
    expect(response?.body).not.toContain("login-plate");
  });
});
