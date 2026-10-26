import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverProject, registerProject, resolveAppBuild } from "../src/registry/index.js";
import { computeLegacyBuildSpecHashV1 } from "../src/runtime/build-spec.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const FROM_BASE = `FROM \${HANSE_BASE}\n`;
const dirs: string[] = [];
const previousBaseImage = process.env.HANSE_AGENT_BASE_IMAGE;

beforeEach(() => {
  process.env.HANSE_AGENT_BASE_IMAGE = "agent-base:test";
});

afterEach(async () => {
  if (previousBaseImage === undefined) delete process.env.HANSE_AGENT_BASE_IMAGE;
  else process.env.HANSE_AGENT_BASE_IMAGE = previousBaseImage;
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

  it("preserves deletion markers across re-registration", async () => {
    const root = await projectDir();
    const { project, rootPath } = await discoverProject(root);
    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);
    const registered = registerProject(db, project, rootPath, rootPath);
    for (const app of registered.apps) {
      expect(app.deleting).toBe(false);
    }

    db.prepare("UPDATE apps SET deleting = 1 WHERE project_id = ?").run(project.id);
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(project.id);

    const again = registerProject(db, project, rootPath, rootPath);
    for (const app of again.apps) {
      expect(app.deleting).toBe(true);
    }
    const appRows = db
      .prepare("SELECT deleting FROM apps WHERE project_id = ? ORDER BY id")
      .all(project.id) as { deleting: number }[];
    expect(appRows).toEqual([{ deleting: 1 }, { deleting: 1 }]);
    const projectRow = db.prepare("SELECT deleting FROM projects WHERE id = ?").get(project.id) as {
      deleting: number;
    };
    expect(projectRow).toEqual({ deleting: 1 });
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

describe("registry durable image identity", () => {
  async function buildAppProject(): Promise<{
    root: string;
    project: Awaited<ReturnType<typeof discoverProject>>["project"];
    rootPath: string;
    webDir: string;
  }> {
    const root = await projectDir();
    const webDir = path.join(root, "apps", "web");
    await mkdir(path.join(webDir, ".hanse"), { recursive: true });
    await writeFile(
      path.join(webDir, ".hanse", "app.yaml"),
      ["name: web", "build:", "  base: base", "  dockerfile: .hanse/Dockerfile", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(webDir, ".hanse", "Dockerfile"),
      `ARG HANSE_BASE\n${FROM_BASE}`,
      "utf8",
    );
    const { project, rootPath } = await discoverProject(root);
    return { root, project, rootPath, webDir };
  }

  it("writes build_configured and preserves base, hash, build, and rejected state", async () => {
    const { root, project, rootPath } = await buildAppProject();
    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);
    registerProject(db, project, rootPath, rootPath);

    const initial = db
      .prepare(
        `SELECT build_configured, image_base_ref, image_base_kind, image_hash_version,
                image_build_id, image_build_ref, image_build_started_at, image_build_rejected_ref
         FROM apps WHERE project_id = ? AND app_key = 'web'`,
      )
      .get(project.id);
    expect(initial).toEqual({
      build_configured: 1,
      image_base_ref: null,
      image_base_kind: null,
      image_hash_version: 2,
      image_build_id: null,
      image_build_ref: null,
      image_build_started_at: null,
      image_build_rejected_ref: null,
    });

    db.prepare(
      `UPDATE apps SET image_ref = 'old-ref', image_base_ref = 'agent-base:tag',
         image_base_kind = 'base', image_hash_version = 2, image_build_id = 'build-1',
         image_build_ref = 'hanse-app:build-1', image_build_started_at = '2026-10-26T00:00:00.000Z',
         image_build_rejected_ref = 'hanse-app:rejected', image_status = 'error',
         image_error = 'build target mismatch'
       WHERE project_id = ? AND app_key = 'web'`,
    ).run(project.id);

    const again = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(again).toMatchObject({
      imageStatus: "error",
      imageError: "build target mismatch",
      imageBaseRef: "agent-base:tag",
      imageBaseKind: "base",
      imageHashVersion: 2,
      imageBuildId: "build-1",
      imageBuildRef: "hanse-app:build-1",
      imageBuildStartedAt: "2026-10-26T00:00:00.000Z",
      imageBuildRejectedRef: "hanse-app:rejected",
      buildConfigured: true,
    });

    expect(
      db
        .prepare(
          `SELECT build_configured, image_status, image_error, image_base_ref, image_base_kind,
                  image_hash_version, image_build_id, image_build_ref, image_build_started_at,
                  image_build_rejected_ref
           FROM apps WHERE project_id = ? AND app_key = 'web'`,
        )
        .get(project.id),
    ).toEqual({
      build_configured: 1,
      image_status: "error",
      image_error: "build target mismatch",
      image_base_ref: "agent-base:tag",
      image_base_kind: "base",
      image_hash_version: 2,
      image_build_id: "build-1",
      image_build_ref: "hanse-app:build-1",
      image_build_started_at: "2026-10-26T00:00:00.000Z",
      image_build_rejected_ref: "hanse-app:rejected",
    });
    db.close();
  });

  it("does not fill a null hash or infer legacy base identity for an existing image", async () => {
    const { root, project, rootPath } = await buildAppProject();
    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);
    const first = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(first?.imageHash).toMatch(/^[a-f0-9]{64}$/);

    db.prepare(
      `UPDATE apps SET image_ref = 'legacy-ref', image_hash = NULL, image_status = 'ready',
         image_hash_version = 1
       WHERE project_id = ? AND app_key = 'web'`,
    ).run(project.id);

    const again = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(again?.imageHash).toBeNull();
    expect(again?.imageBaseRef).toBeNull();
    expect(again?.imageBaseKind).toBeNull();
    expect(again?.imageHashVersion).toBe(1);
    expect(
      db
        .prepare(
          "SELECT image_ref, image_hash, image_base_ref, image_base_kind, image_hash_version FROM apps WHERE project_id = ? AND app_key = 'web'",
        )
        .get(project.id),
    ).toEqual({
      image_ref: "legacy-ref",
      image_hash: null,
      image_base_ref: null,
      image_base_kind: null,
      image_hash_version: 1,
    });
    db.close();
  });
});

describe("registry build-spec version 2 rules", () => {
  async function setup(
    dockerfile: string,
    appYaml = "name: web\nbuild:\n  dockerfile: Dockerfile\n",
  ): Promise<{
    root: string;
    project: Awaited<ReturnType<typeof discoverProject>>["project"];
    rootPath: string;
    webDir: string;
  }> {
    const root = await projectDir();
    const webDir = path.join(root, "apps", "web");
    await mkdir(path.join(webDir, ".hanse"), { recursive: true });
    await writeFile(path.join(webDir, ".hanse", "app.yaml"), appYaml, "utf8");
    await writeFile(path.join(webDir, "Dockerfile"), dockerfile, "utf8");
    const { project, rootPath } = await discoverProject(root);
    return { root, project, rootPath, webDir };
  }

  it("resolves and exposes the base kind/reference for the next build", async () => {
    const { webDir } = await setup(`ARG HANSE_BASE\n${FROM_BASE}`);
    expect(resolveAppBuild(webDir, "agent-default:test", "agent-base:test")).toMatchObject({
      status: "missing",
      baseKind: "default",
      baseRef: "agent-default:test",
      hashVersion: 2,
    });

    const explicit = await setup("FROM node:20\n");
    expect(resolveAppBuild(explicit.webDir, "agent-default:test", "agent-base:test")).toMatchObject(
      { baseKind: "explicit", baseRef: "node:20", hashVersion: 2 },
    );

    const base = await setup(
      `ARG HANSE_BASE\n${FROM_BASE}`,
      "name: web\nbuild:\n  base: base\n  dockerfile: Dockerfile\n",
    );
    expect(resolveAppBuild(base.webDir, "agent-default:test", "agent-base:test")).toMatchObject({
      baseKind: "base",
      baseRef: "agent-base:test",
    });
  });

  it("marks a contradictory build.base and a missing base env as bounded config errors", async () => {
    const mismatch = await setup(
      "FROM node:20\n",
      "name: web\nbuild:\n  base: default\n  dockerfile: Dockerfile\n",
    );
    const mismatchInspection = resolveAppBuild(
      mismatch.webDir,
      "agent-default:test",
      "agent-base:test",
    );
    expect(mismatchInspection.status).toBe("error");
    expect(mismatchInspection.baseErrorCode).toBe("base_mismatch");
    expect(mismatchInspection.error?.length ?? 0).toBeLessThanOrEqual(400);

    const missing = await setup(
      `ARG HANSE_BASE\n${FROM_BASE}`,
      "name: web\nbuild:\n  base: base\n  dockerfile: Dockerfile\n",
    );
    delete process.env.HANSE_AGENT_BASE_IMAGE;
    const missingInspection = resolveAppBuild(missing.webDir, "agent-default:test");
    expect(missingInspection).toMatchObject({
      status: "error",
      baseErrorCode: "base_unavailable",
    });

    const db = openDatabase(path.join(missing.root, "db.sqlite"));
    runMigrations(db);
    const registered = registerProject(
      db,
      missing.project,
      missing.rootPath,
      missing.rootPath,
    ).apps.find((app) => app.appKey === "web");
    expect(registered?.imageStatus).toBe("error");
    expect(registered?.imageError?.length ?? 0).toBeLessThanOrEqual(400);
    db.close();
  });

  it("writes version 2 for a new row and for an unbuilt row, but never for a built row", async () => {
    const { root, project, rootPath, webDir } = await setup(`ARG HANSE_BASE\n${FROM_BASE}`);
    const db = openDatabase(path.join(root, "db.sqlite"));
    runMigrations(db);

    const first = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(first?.imageHashVersion).toBe(2);
    expect(first?.buildSpecHash).toMatch(/^[a-f0-9]{64}$/);

    db.prepare(
      "UPDATE apps SET image_ref = 'legacy-ref', image_hash = NULL, image_status = 'ready', image_hash_version = 1 WHERE project_id = ?",
    ).run(project.id);
    const built = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(built?.imageHash).toBeNull();
    expect(built?.imageHashVersion).toBe(1);

    // A stored v1 hash is never replaced by the current v2 hash at registration.
    const legacyHash = computeLegacyBuildSpecHashV1({
      dockerfile: `ARG HANSE_BASE\n${FROM_BASE}`,
      defaultImage: "agent-default:legacy",
      buildArgs: {},
    });
    db.prepare(
      `UPDATE apps SET image_hash = ?, image_hash_version = 1,
         image_base_digest = 'agent-default:legacy' WHERE project_id = ?`,
    ).run(legacyHash, project.id);
    await writeFile(
      path.join(webDir, "Dockerfile"),
      `ARG HANSE_BASE\n${FROM_BASE}RUN true\n`,
      "utf8",
    );
    const legacy = registerProject(db, project, rootPath, rootPath).apps.find(
      (app) => app.appKey === "web",
    );
    expect(legacy?.imageHash).toBe(legacyHash);
    expect(legacy?.imageHashVersion).toBe(1);
    expect(legacy?.imageStatus).toBe("stale");
    db.close();
  });
});
