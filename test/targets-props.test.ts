import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorService } from "../src/coordinator/service.js";
import { GitService } from "../src/git/service.js";
import { buildSite } from "../src/http/dashboard.js";
import type { HttpDeps } from "../src/http/handler.js";
import { buildTargets } from "../src/http/props/targets.js";
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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  deps: HttpDeps;
}

function fixture(options: { master?: boolean } = {}): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-targets-props-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "coordinator.db"));
  databases.push(db);
  runMigrations(db);
  const now = new Date().toISOString();
  const insertProject = db.prepare(
    "INSERT INTO projects (id,name,base_branch,root_path,created_at,updated_at,deleting) VALUES (?,?,'main',?,?,?,?)",
  );
  const insertApp = db.prepare(
    "INSERT INTO apps (id,project_id,app_key,path,kind,contract,created_at,deleting) VALUES (?,?,?,?,?,'AGENTS.md',?,?)",
  );
  const projects: Array<[string, string, number]> = [
    ["p-alpha", "Alpha", 0],
    ["p-zeta", "Alpha", 0],
    ["p-beta", "Beta", 0],
    ["p-empty", "Empty project", 0],
    ["p-gone", "Gone", 1],
  ];
  for (const [id, name, deleting] of projects) {
    insertProject.run(id, name, `/sentinel/${id}`, now, now, deleting);
  }
  const apps: Array<[string, string, number]> = [
    ["p-alpha", "web", 0],
    ["p-alpha", "api", 0],
    ["p-alpha", "old", 1],
    ["p-beta", "web", 0],
    ["p-gone", "app", 0],
  ];
  for (const [projectId, appKey, deleting] of apps) {
    insertApp.run(
      `${projectId}:${appKey}`,
      projectId,
      appKey,
      `apps/${appKey}`,
      "app",
      now,
      deleting,
    );
  }
  if (options.master === true) {
    insertProject.run("hanse-master", "Hanse master", "/sentinel/master", now, now, 0);
    insertApp.run("hanse-master:master", "hanse-master", "master", "apps/master", "app", now, 0);
  }
  const deps: HttpDeps = {
    db,
    workspaceRoot: "/sentinel",
    git: new GitService({ workspaceRoot: "/sentinel" }),
    getProjects: () =>
      [...projects.map(([id]) => id), ...(options.master === true ? ["hanse-master"] : [])].map(
        (id) => {
          const name =
            id === "hanse-master" ? "Hanse master" : (projects.find((p) => p[0] === id)?.[1] ?? id);
          return {
            id,
            name,
            rootPath: `/sentinel/${id}`,
            workspaceRoot: "/sentinel",
            deleting: projects.find((project) => project[0] === id)?.[2] === 1,
            service: new CoordinatorService(db, id),
          };
        },
      ),
  };
  return { deps };
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("targets props", () => {
  it("returns stable identities, includes zero-app projects, and excludes deleting entries", () => {
    const f = fixture({ master: true });
    const targets = buildTargets(buildSite(f.deps));

    expect(targets.projects.map((project) => [project.id, project.name])).toEqual([
      ["p-alpha", "Alpha"],
      ["p-zeta", "Alpha"],
      ["p-beta", "Beta"],
      ["p-empty", "Empty project"],
    ]);
    expect(
      targets.projects.find((project) => project.id === "p-alpha")?.apps.map((app) => app.appKey),
    ).toEqual(["api", "web"]);
    expect(
      targets.projects.find((project) => project.id === "p-beta")?.apps.map((app) => app.appKey),
    ).toEqual(["web"]);
    expect(targets.projects.find((project) => project.id === "p-empty")?.apps).toEqual([]);
    expect(targets.projects.some((project) => project.id === "p-gone")).toBe(false);
    expect(targets.projects.some((project) => project.id === "hanse-master")).toBe(false);
    expect(
      targets.projects.flatMap((project) => project.apps).some((app) => app.appKey === "old"),
    ).toBe(false);
  });

  it("separates the reserved master app from the operator catalog", () => {
    const f = fixture({ master: true });
    const targets = buildTargets(buildSite(f.deps));
    expect(targets.master).toEqual({
      projectId: "hanse-master",
      projectName: "Hanse master",
      appKey: "master",
      kind: "app",
      master: true,
    });
  });

  it("returns master null when the reserved app is absent", () => {
    const f = fixture();
    const targets = buildTargets(buildSite(f.deps));
    expect(targets.master).toBeNull();
    expect(targets.projects.map((project) => project.id)).toEqual([
      "p-alpha",
      "p-zeta",
      "p-beta",
      "p-empty",
    ]);
  });

  it("returns identities only, with no paths, hrefs, or secrets", () => {
    const f = fixture({ master: true });
    const targets = buildTargets(buildSite(f.deps));
    const app = targets.projects[0]?.apps[0];
    expect(app).toBeDefined();
    expect(Object.keys(app ?? {}).sort()).toEqual([
      "appKey",
      "kind",
      "master",
      "projectId",
      "projectName",
    ]);
    expect(Object.keys(targets.projects[0] ?? {}).sort()).toEqual(["apps", "id", "name"]);
    const body = serialized(targets);
    expect(body).not.toContain("sentinel");
    expect(body).not.toContain("rootPath");
    expect(body).not.toContain("href");
    expect(body).not.toContain("path");
    expect(body).not.toContain("token");
    expect(body).not.toContain("secret");
  });
});
