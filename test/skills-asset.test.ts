import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitService } from "../src/git/service.js";
import { type HttpDeps, handleRequest } from "../src/http/handler.js";
import { openDatabase, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function deps(): HttpDeps {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-skills-asset-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  return {
    db,
    workspaceRoot: dir,
    git: new GitService({ workspaceRoot: dir }),
    getProjects: () => [],
  };
}

describe("skills assets", () => {
  it("serves the shared markdown renderer used by the skill preview", () => {
    const response = handleRequest(deps(), {
      method: "GET",
      path: "/assets/markdown.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/javascript; charset=utf-8");
    expect(response.body).toContain("renderMarkdown");
    expect(response.body).not.toContain("x-hanse-fragment");
  });

  it("removes the old fragment asset from the allowlist", () => {
    const response = handleRequest(deps(), {
      method: "GET",
      path: "/assets/skills.js",
      headers: {},
    });
    expect(response.status).toBe(404);
  });

  it("allowlists the workspace script and keeps the removed fragment asset out", () => {
    const source = readFileSync(new URL("../src/http/handler.ts", import.meta.url), "utf8");
    expect(source).toContain('"/assets/skill-detail.js"');
    expect(source).not.toContain('"/assets/skills.js"');
  });

  it("still returns 404 for an unknown skills asset", () => {
    const response = handleRequest(deps(), {
      method: "GET",
      path: "/assets/skills-missing.js",
      headers: {},
    });
    expect(response.status).toBe(404);
  });
});
