import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, type ConfigErrorCode } from "../src/config/load.js";
import { appDir } from "../src/http/apps.js";
import type { RegisteredApp } from "../src/registry/index.js";
import { registerProject } from "../src/registry/index.js";
import { resolveAppPath } from "../src/runtime/app-path.js";
import type { Project } from "../src/schema/index.js";
import { openDatabase, runMigrations, type SqliteDatabase } from "../src/store/index.js";

const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const db of databases) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  databases.length = 0;
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

async function fixture(): Promise<{
  base: string;
  workspace: string;
  projectRoot: string;
  outside: string;
}> {
  const base = await mkdtemp(path.join(tmpdir(), "hanse-path-"));
  dirs.push(base);
  const workspace = path.join(base, "workspace");
  const projectRoot = path.join(workspace, "project");
  const outside = path.join(base, "outside");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { base, workspace, projectRoot, outside };
}

function expectConfigError(run: () => unknown, code: ConfigErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    return;
  }
  throw new Error("expected resolveAppPath to throw ConfigError");
}

function project(projectId: string, appPaths: string[]): Project {
  return {
    id: projectId,
    name: "demo",
    base_branch: "main",
    apps: appPaths.map((appPath) => ({ path: appPath })),
  };
}

function registeredApp(appPath: string): RegisteredApp {
  return {
    id: `p:${path.basename(appPath)}`,
    projectId: "p",
    appKey: path.basename(appPath),
    path: appPath,
    kind: null,
    contract: "AGENTS.md",
    imageStatus: "missing",
    imageRef: null,
    imageHash: null,
    imageBaseDigest: null,
    imageBuiltAt: null,
    imageError: null,
    buildDockerfile: null,
    buildArgs: {},
    buildSpecHash: null,
  };
}

describe("resolveAppPath", () => {
  it("accepts a relative path inside the project", async () => {
    const f = await fixture();
    const projectReal = await realpath(f.projectRoot);
    expect(
      resolveAppPath({
        appPath: "apps/web",
        projectRoot: f.projectRoot,
        workspaceRoot: f.workspace,
      }),
    ).toBe(path.join(projectReal, "apps", "web"));
  });

  it("accepts an absolute path inside the workspace", async () => {
    const f = await fixture();
    const target = path.join(f.workspace, "standalone");
    expect(
      resolveAppPath({ appPath: target, projectRoot: f.projectRoot, workspaceRoot: f.workspace }),
    ).toBe(path.join(await realpath(f.workspace), "standalone"));
  });

  it("accepts a non-existent app directory under the project", async () => {
    const f = await fixture();
    const projectReal = await realpath(f.projectRoot);
    expect(
      resolveAppPath({
        appPath: "apps/not-created-yet",
        projectRoot: f.projectRoot,
        workspaceRoot: f.workspace,
      }),
    ).toBe(path.join(projectReal, "apps", "not-created-yet"));
  });

  it("rejects ../../.. traversal", async () => {
    const f = await fixture();
    expectConfigError(
      () =>
        resolveAppPath({
          appPath: "../../..",
          projectRoot: f.projectRoot,
          workspaceRoot: f.workspace,
        }),
      "INVALID_APP_PATH",
    );
  });

  it("rejects an interior .. segment even when it resolves back inside", async () => {
    const f = await fixture();
    expectConfigError(
      () =>
        resolveAppPath({
          appPath: "sub/../app",
          projectRoot: f.projectRoot,
          workspaceRoot: f.workspace,
        }),
      "INVALID_APP_PATH",
    );
  });

  it("rejects absolute paths outside the workspace", async () => {
    const f = await fixture();
    for (const appPath of ["/data/state", "/etc"]) {
      expectConfigError(
        () =>
          resolveAppPath({
            appPath,
            projectRoot: f.projectRoot,
            workspaceRoot: f.workspace,
          }),
        "PATH_OUTSIDE_ROOT",
      );
    }
  });

  it("rejects a symlink app entry that points outside the project", async () => {
    const f = await fixture();
    await symlink(f.outside, path.join(f.projectRoot, "app"));
    expectConfigError(
      () =>
        resolveAppPath({
          appPath: "app",
          projectRoot: f.projectRoot,
          workspaceRoot: f.workspace,
        }),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("rejects a symlinked ancestor escape for a non-existent target", async () => {
    const f = await fixture();
    await symlink(f.outside, path.join(f.projectRoot, "escape"));
    expectConfigError(
      () =>
        resolveAppPath({
          appPath: "escape/new-app",
          projectRoot: f.projectRoot,
          workspaceRoot: f.workspace,
        }),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("rejects a dangling symlink ancestor instead of treating it as missing", async () => {
    const f = await fixture();
    await symlink(path.join(f.outside, "not-created"), path.join(f.projectRoot, "dangling"));
    expectConfigError(
      () =>
        resolveAppPath({
          appPath: "dangling/new-app",
          projectRoot: f.projectRoot,
          workspaceRoot: f.workspace,
        }),
      "PATH_OUTSIDE_ROOT",
    );
  });
});

describe("registration and launch containment", () => {
  it("registers valid relative apps when a workspace root is supplied", async () => {
    const f = await fixture();
    const db = openDatabase(path.join(f.base, "valid.sqlite"));
    databases.push(db);
    runMigrations(db);
    const registered = registerProject(
      db,
      project("3f1c9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b", ["apps/web"]),
      f.projectRoot,
      f.workspace,
    );
    expect(registered.apps.map((app) => app.appKey)).toEqual(["web"]);
  });

  it("rejects traversal at registration", async () => {
    const f = await fixture();
    const db = openDatabase(path.join(f.base, "traversal.sqlite"));
    databases.push(db);
    runMigrations(db);
    expectConfigError(
      () =>
        registerProject(
          db,
          project("3f1c9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5c", ["../../.."]),
          f.projectRoot,
          f.workspace,
        ),
      "INVALID_APP_PATH",
    );
    const count = db.prepare("SELECT COUNT(*) AS c FROM apps").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("rejects an absolute path outside the workspace at registration", async () => {
    const f = await fixture();
    const db = openDatabase(path.join(f.base, "absolute.sqlite"));
    databases.push(db);
    runMigrations(db);
    expectConfigError(
      () =>
        registerProject(
          db,
          project("3f1c9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5d", ["/data/state"]),
          f.projectRoot,
          f.workspace,
        ),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("rejects a symlink escape at registration", async () => {
    const f = await fixture();
    await symlink(f.outside, path.join(f.projectRoot, "app"));
    const db = openDatabase(path.join(f.base, "symlink.sqlite"));
    databases.push(db);
    runMigrations(db);
    expectConfigError(
      () =>
        registerProject(
          db,
          project("3f1c9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5e", ["app"]),
          f.projectRoot,
          f.workspace,
        ),
      "PATH_OUTSIDE_ROOT",
    );
  });

  it("rejects traversal and symlink escapes in appDir", async () => {
    const f = await fixture();
    const projectContext = { rootPath: f.projectRoot, workspaceRoot: f.workspace };
    expectConfigError(() => appDir(projectContext, registeredApp("../../..")), "INVALID_APP_PATH");
    expectConfigError(
      () => appDir(projectContext, registeredApp("/data/state")),
      "PATH_OUTSIDE_ROOT",
    );
    await symlink(f.outside, path.join(f.projectRoot, "app"));
    expectConfigError(() => appDir(projectContext, registeredApp("app")), "PATH_OUTSIDE_ROOT");
  });

  it("returns the resolved path from appDir for a valid app", async () => {
    const f = await fixture();
    const projectReal = await realpath(f.projectRoot);
    expect(
      appDir({ rootPath: f.projectRoot, workspaceRoot: f.workspace }, registeredApp("apps/web")),
    ).toBe(path.join(projectReal, "apps", "web"));
  });
});
