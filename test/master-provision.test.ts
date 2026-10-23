import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addApplication,
  createProject,
  type ProvisioningDeps,
  ProvisioningError,
} from "../src/coordinator/provision.js";
import { MASTER_DIR_NAME } from "../src/master/constants.js";
import type { GitAuthResolution } from "../src/settings/git-auth.js";
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

function fixture(): ProvisioningDeps & { workspace: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-master-provision-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  return { db, workspaceRoot: workspace, workspace };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("master provisioning", () => {
  it("creates a project with a YAML-safe manifest and a database row", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas: QA project" });
    expect(project.name).toBe("Atlas: QA project");
    expect(project.directory).toBe("atlas-qa-project");
    const manifest = readFileSync(path.join(project.rootPath, ".hanse", "project.yaml"), "utf8");
    expect(manifest).toContain(`id: ${project.id}`);
    expect(manifest).toContain("base_branch: main");
    expect(
      deps.db.prepare("SELECT name, root_path FROM projects WHERE id = ?").get(project.id),
    ).toEqual({ name: project.name, root_path: project.rootPath });
  });

  it("refuses duplicate and reserved project targets", () => {
    const deps = fixture();
    createProject(deps, { name: "Atlas" });
    expectCode(() => createProject(deps, { name: "Atlas" }), "project_exists");
    expectCode(
      () => createProject(deps, { name: "x", directory: MASTER_DIR_NAME }),
      "invalid_path",
    );
    expectCode(() => createProject(deps, { name: "x", directory: ".git" }), "invalid_path");
    expectCode(() => createProject(deps, { name: "x", directory: "." }), "invalid_path");
    expectCode(() => createProject(deps, { name: "x\ninjected" }), "invalid_argument");
  });

  it("adds an application directory, manifest entry, and row", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    const app = addApplication(deps, { projectId: project.id, name: "Reviewer" });
    expect(app.appKey).toBe("reviewer");
    expect(app.path).toBe("apps/reviewer");
    const appYaml = readFileSync(path.join(app.rootPath, app.path, ".hanse", "app.yaml"), "utf8");
    expect(appYaml).toContain("name: Reviewer");
    expect(readFileSync(path.join(project.rootPath, ".hanse", "project.yaml"), "utf8")).toContain(
      "path: apps/reviewer",
    );
    expect(deps.db.prepare("SELECT app_key, path FROM apps WHERE id = ?").get(app.id)).toEqual({
      app_key: "reviewer",
      path: "apps/reviewer",
    });
    expectCode(
      () => addApplication(deps, { projectId: project.id, name: "Reviewer" }),
      "app_exists",
    );
  });

  it("refuses root, reserved, and traversal application paths", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    expectCode(
      () => addApplication(deps, { projectId: project.id, name: "x", path: "." }),
      "invalid_path",
    );
    expectCode(
      () => addApplication(deps, { projectId: project.id, name: "x", path: "../escape" }),
      "invalid_path",
    );
    expectCode(
      () => addApplication(deps, { projectId: project.id, name: "x", path: ".git/hooks" }),
      "reserved_path",
    );
    expectCode(
      () => addApplication(deps, { projectId: project.id, name: "x", path: "apps/.hanse" }),
      "reserved_path",
    );
  });

  it("validates remotes and cleans a failed clone", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    for (const remote of [
      "--upload-pack=sh",
      "file:///etc",
      "/srv/repo",
      "https://user:token@host/x",
      "https://host/repo.git?token=secret",
      "https://host/repo.git#fragment",
    ]) {
      expectCode(
        () => addApplication(deps, { projectId: project.id, name: "x", remote }),
        "invalid_argument",
      );
    }
    let target = "";
    expectCode(
      () =>
        addApplication(
          {
            ...deps,
            clone: (_remote, directory) => {
              target = directory;
              mkdirSync(directory, { recursive: true });
              throw new Error("clone failed");
            },
          },
          { projectId: project.id, name: "x", remote: "https://example.invalid/repo.git" },
        ),
      "clone_failed",
    );
    expect(target.length).toBeGreaterThan(0);
    expect(() => readFileSync(target, "utf8")).toThrow();
  });

  it("refuses a cloned .hanse symlink instead of writing outside the workspace", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    const outside = path.join(path.dirname(deps.workspace), "outside");
    mkdirSync(outside);
    const clone = (_remote: string, target: string): void => {
      mkdirSync(target, { recursive: true });
      symlinkSync(outside, path.join(target, ".hanse"));
    };
    expectCode(
      () =>
        addApplication(
          { ...deps, clone },
          { projectId: project.id, name: "x", remote: "https://example.invalid/repo.git" },
        ),
      "invalid_path",
    );
    expect(() => readFileSync(path.join(outside, "app.yaml"), "utf8")).toThrow();
  });

  it("honors deletion reservations when a guard is supplied", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    const projectDeleting: ProvisioningDeps = {
      ...deps,
      deletion: {
        isActive: () => true,
        isDeletingProject: () => true,
        isDeletingApp: () => false,
        isDeletingAppState: () => false,
        isDeletingPath: () => false,
      },
    };
    expectCode(() => createProject(projectDeleting, { name: "Other" }), "deletion_in_progress");
    expectCode(
      () => addApplication(projectDeleting, { projectId: project.id, name: "x" }),
      "deletion_in_progress",
    );
  });
});

function resolution(
  options: { https?: GitAuthResolution["gitAuth"]["https"]; httpsError?: boolean } = {},
): GitAuthResolution {
  const scoped = { global: "absent", project: "absent", app: "absent" } as const;
  return {
    ssh: { status: { state: "missing", kind: "ssh" }, scoped: { ...scoped } },
    https: {
      status: options.httpsError
        ? { state: "error", kind: "https", message: "The stored HTTPS credential is unreadable." }
        : { state: "missing", kind: "https" },
      scoped: { ...scoped },
    },
    gitAuth: options.https === undefined ? {} : { https: options.https },
    gitAuthHash: "hash",
  };
}

describe("add-application clone credentials", () => {
  it("resolves the project credential once and passes it to the clone seam", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    const calls: string[] = [];
    const https = { hosts: ["github.com"], username: "user", token: "token-body" };
    let received: unknown;
    const clone = (_remote: string, target: string, auth: { https?: typeof https }): void => {
      mkdirSync(target, { recursive: true });
      received = auth;
    };
    addApplication(
      {
        ...deps,
        resolveGitAuth: (projectId) => {
          calls.push(projectId);
          return resolution({ https });
        },
        clone,
      },
      { projectId: project.id, name: "Worker", remote: "https://github.com/o/r.git" },
    );
    expect(calls).toEqual([project.id]);
    expect(received).toEqual({ https });
  });

  it("rejects an unreadable credential for the remote kind before cloning", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    let cloned = false;
    try {
      addApplication(
        {
          ...deps,
          resolveGitAuth: () => resolution({ httpsError: true }),
          clone: () => {
            cloned = true;
          },
        },
        { projectId: project.id, name: "Worker", remote: "https://github.com/o/r.git" },
      );
      throw new Error("expected a clone failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as ProvisioningError).code).toBe("clone_failed");
      expect((error as ProvisioningError).status).toBe(500);
      expect((error as ProvisioningError).message).toContain("unreadable");
    }
    expect(cloned).toBe(false);
    expect(
      lstatSync(path.join(project.rootPath, "apps", "worker"), { throwIfNoEntry: false }),
    ).toBeUndefined();
    const apps = deps.db.prepare("SELECT COUNT(*) AS count FROM apps").get() as { count: number };
    expect(apps.count).toBe(0);
  });

  it("does not resolve credentials for a local add and keeps two-argument clones assignable", () => {
    const deps = fixture();
    const project = createProject(deps, { name: "Atlas" });
    let resolved = false;
    const localClone = (_remote: string, _target: string): void => {};
    const app = addApplication(
      {
        ...deps,
        clone: localClone,
        resolveGitAuth: () => {
          resolved = true;
          return resolution();
        },
      },
      { projectId: project.id, name: "Worker" },
    );
    expect(app.appKey).toBe("worker");
    expect(resolved).toBe(false);
  });
});
