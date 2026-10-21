import { mkdtempSync, rmSync } from "node:fs";
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

describe("skills asset", () => {
  it("is allowlisted and implements the fragment surface swap", () => {
    const response = handleRequest(deps(), {
      method: "GET",
      path: "/assets/skills.js",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("text/javascript; charset=utf-8");
    expect(response.body).toContain("x-hanse-fragment");
    expect(response.body).toContain('"skills"');
    expect(response.body).toContain("skills-surface");
    expect(response.body).toContain("data-skill-form");
    expect(response.body).toContain("replaceWith");
    expect(response.body).toContain("data-skill-delete");
    expect(response.body).toContain("data-skill-counter");
    expect(response.body).not.toContain("innerHTML = message");
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
