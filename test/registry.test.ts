import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject, registerProject } from "../src/registry/index.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const FROM_BASE = `FROM \${HANSE_BASE}\n`;
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
    const registered = registerProject(db, project, rootPath, rootPath);
    expect(registered.apps.map((app) => app.appKey).sort()).toEqual(["api", "web"]);
    for (const app of registered.apps) {
      expect(app.imageStatus).toBe("missing");
      expect(app.imageError).toBeNull();
      expect(app.buildDockerfile).toBeNull();
      expect(app.buildConfigured).toBe(false);
      expect(app.buildArgs).toEqual({});
      expect(app.buildSpecHash).toBeNull();
    }

    registerProject(db, project, rootPath, rootPath);
    const count = db.prepare("SELECT COUNT(*) AS c FROM apps").get() as { c: number };
    expect(count.c).toBe(2);
    db.close();
  });

  it("throws for a directory without a manifest", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "hanse-empty-"));
    dirs.push(empty);
    await expect(discoverProject(empty)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads a per-app build declaration and stores image metadata", async () => {
    const root = await projectDir();
    const webDir = path.join(root, "apps", "web");
    await mkdir(path.join(webDir, ".hanse"), { recursive: true });
    await writeFile(
      path.join(webDir, ".hanse", "app.yaml"),
      [
        "name: web",
        "build:",
        "  dockerfile: .hanse/Dockerfile",
        "  args:",
        "    NODE_VERSION: '22'",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(webDir, ".hanse", "Dockerfile"),
      `ARG HANSE_BASE\n${FROM_BASE}`,
      "utf8",
    );

    const { project, rootPath } = await discoverProject(root);
    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);
    const registered = registerProject(db, project, rootPath, rootPath);
    const web = registered.apps.find((app) => app.appKey === "web");
    expect(web).toBeDefined();
    expect(web?.imageStatus).toBe("missing");
    expect(web?.imageError).toBeNull();
    expect(web?.imageRef).toBeNull();
    expect(web?.imageBaseDigest).toBeNull();
    expect(web?.imageBuiltAt).toBeNull();
    expect(web?.buildDockerfile).toBe(path.join(webDir, ".hanse", "Dockerfile"));
    expect(web?.buildArgs).toEqual({ NODE_VERSION: "22" });
    expect(web?.buildSpecHash).toMatch(/^[a-f0-9]{64}$/);
    expect(web?.imageHash).toBe(web?.buildSpecHash);
    expect(web?.buildConfigured).toBe(true);

    const row = db
      .prepare(
        "SELECT image_status, image_hash, image_error FROM apps WHERE project_id = ? AND app_key = 'web'",
      )
      .get(project.id) as { image_status: string; image_hash: string; image_error: string | null };
    expect(row.image_status).toBe("missing");
    expect(row.image_hash).toBe(web?.buildSpecHash);
    expect(row.image_error).toBeNull();

    const originalHash = web?.buildSpecHash;
    await writeFile(path.join(webDir, "server.js"), "console.log('one');\n", "utf8");
    const afterCodeChange = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(afterCodeChange?.buildSpecHash).toBe(originalHash);

    await writeFile(path.join(webDir, ".hanse", "Dockerfile"), `${FROM_BASE}RUN true\n`, "utf8");
    const afterDockerfileChange = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(afterDockerfileChange?.buildSpecHash).not.toBe(originalHash);
    expect(afterDockerfileChange?.imageHash).toBe(originalHash);
    db.close();
  });

  it("marks an invalid app.yaml as an image error without failing the project", async () => {
    const root = await projectDir();
    const webDir = path.join(root, "apps", "web");
    await mkdir(path.join(webDir, ".hanse"), { recursive: true });
    await writeFile(
      path.join(webDir, ".hanse", "app.yaml"),
      "name: web\nbuild:\n  dockerfile: ../../escape\n",
      "utf8",
    );

    const { project, rootPath } = await discoverProject(root);
    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);
    const registered = registerProject(db, project, rootPath, rootPath);
    const web = registered.apps.find((app) => app.appKey === "web");
    const api = registered.apps.find((app) => app.appKey === "api");
    expect(web?.imageStatus).toBe("error");
    expect(web?.imageError).toContain("build.dockerfile");
    expect(web?.imageError?.length).toBeLessThanOrEqual(400);
    expect(web?.buildDockerfile).toBeNull();
    expect(web?.buildConfigured).toBe(true);
    expect(api?.imageStatus).toBe("missing");
    expect(api?.buildConfigured).toBe(false);
    db.close();
  });

  it("marks a Dockerfile symlink escape as an image error", async () => {
    const root = await projectDir();
    const webDir = path.join(root, "apps", "web");
    const outside = path.join(root, "outside");
    await mkdir(path.join(webDir, ".hanse"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "Dockerfile"), "FROM scratch\n", "utf8");
    await symlink(path.join(outside, "Dockerfile"), path.join(webDir, ".hanse", "Dockerfile"));
    await writeFile(
      path.join(webDir, ".hanse", "app.yaml"),
      "name: web\nbuild:\n  dockerfile: .hanse/Dockerfile\n",
      "utf8",
    );

    const { project, rootPath } = await discoverProject(root);
    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);
    const web = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(web?.imageStatus).toBe("error");
    expect(web?.imageError).toContain("escapes");
    expect(web?.buildDockerfile).toBeNull();
    expect(web?.buildConfigured).toBe(true);
    db.close();
  });
});
