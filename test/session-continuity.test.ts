import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, handleRequest } from "../src/http/handler.js";
import { maybeServeSpa } from "../src/http/spa.js";
import { createPrincipal } from "../src/identity/principals.js";
import { loadOrCreateKey } from "../src/secrets/index.js";
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

function depsFor(db: SqliteDatabase, workspace: string): HttpDeps {
  return {
    db,
    workspaceRoot: workspace,
    git: new GitService({ workspaceRoot: workspace }),
    getProjects: () => [],
  };
}

describe("operator session continuity", () => {
  it("keeps the cookie valid across a coordinator database reopen", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-session-"));
    dirs.push(dir);
    const workspace = path.join(dir, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "README.md"), "fixture\n", "utf8");
    const dbPath = path.join(dir, "coordinator.db");

    const db = openDatabase(dbPath);
    databases.push(db);
    runMigrations(db);
    const { token } = createPrincipal(db, { kind: "human", name: "operator" });

    const login = handleRequest(depsFor(db, workspace), {
      method: "POST",
      path: "/api/session",
      headers: {},
      body: JSON.stringify({ token, next: "/" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers?.["set-cookie"]?.split(";")[0];
    expect(cookie).toBeDefined();
    db.close();

    const reopened = openDatabase(dbPath);
    databases.push(reopened);
    runMigrations(reopened);
    const page = maybeServeSpa(depsFor(reopened, workspace), {
      method: "GET",
      path: "/login",
      headers: { accept: "text/html", cookie: cookie ?? "" },
    });
    expect(page?.status).toBe(302);
    expect(page?.headers?.location).toBe("/");
  });

  it("keeps secret.key stable so encrypted settings stay readable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-secret-"));
    dirs.push(dir);
    const keyPath = path.join(dir, "secret.key");
    const first = loadOrCreateKey(keyPath);
    const second = loadOrCreateKey(keyPath);
    expect(second.equals(first)).toBe(true);
  });
});
