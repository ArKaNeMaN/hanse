import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject, registerProject } from "../src/registry/index.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

async function projectDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "hanse-proj-"));
  dirs.push(root);
  await mkdir(path.join(root, ".hanse"), { recursive: true });
  await writeFile(
    path.join(root, ".hanse", "project.yaml"),
    [
      "id: 3f1c9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      "name: demo",
      "apps:",
      "  - path: apps/web",
      "  - path: apps/api",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("registry", () => {
  it("discovers and registers a project idempotently", async () => {
    const root = await projectDir();
    const { project, rootPath } = await discoverProject(root);
    expect(project.name).toBe("demo");
    expect(rootPath).toBe(root);

    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);
    const registered = registerProject(db, project, rootPath);
    expect(registered.apps.map((app) => app.appKey).sort()).toEqual(["api", "web"]);

    registerProject(db, project, rootPath);
    const count = db.prepare("SELECT COUNT(*) AS c FROM apps").get() as { c: number };
    expect(count.c).toBe(2);
    db.close();
  });

  it("throws for a directory without a manifest", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "hanse-empty-"));
    dirs.push(empty);
    await expect(discoverProject(empty)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
