import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureMasterAgent } from "../src/master/bootstrap.js";
import {
  MASTER_APP_ID,
  MASTER_APP_KEY,
  MASTER_DIR_NAME,
  MASTER_PROJECT_ID,
} from "../src/master/constants.js";
import { registerProject } from "../src/registry/index.js";
import { resolveAppPath } from "../src/runtime/app-path.js";
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

function fixture(): { db: SqliteDatabase; workspace: string; masterDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hanse-master-bootstrap-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  return { db, workspace, masterDir: path.join(workspace, MASTER_DIR_NAME) };
}

describe("master bootstrap", () => {
  it("creates the reserved rows, directory, and instructions idempotently", () => {
    const { db, workspace, masterDir } = fixture();
    ensureMasterAgent(db, workspace);
    const project = db
      .prepare("SELECT id, name, base_branch, root_path, deleting FROM projects WHERE id = ?")
      .get(MASTER_PROJECT_ID) as {
      id: string;
      name: string;
      base_branch: string;
      root_path: string;
      deleting: number;
    };
    expect(project.name).toBe("Hanse master");
    expect(project.base_branch).toBe("main");
    expect(project.root_path).toBe(masterDir);
    expect(project.deleting).toBe(0);
    const app = db
      .prepare(
        "SELECT id, project_id, app_key, path, kind, contract, deleting, image_status FROM apps WHERE id = ?",
      )
      .get(MASTER_APP_ID) as {
      id: string;
      project_id: string;
      app_key: string;
      path: string;
      kind: string;
      contract: string;
      deleting: number;
      image_status: string;
    };
    expect(app).toMatchObject({
      id: MASTER_APP_ID,
      project_id: MASTER_PROJECT_ID,
      app_key: MASTER_APP_KEY,
      path: ".",
      kind: "master",
      contract: "AGENTS.md",
      deleting: 0,
      image_status: "missing",
    });
    expect(
      resolveAppPath({
        appPath: app.path,
        projectRoot: project.root_path,
        workspaceRoot: workspace,
      }),
    ).toBe(masterDir);
    const instructions = readFileSync(path.join(masterDir, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Hanse master");
    expect(instructions).toContain("hanse_list_skills");
    expect(instructions).toContain("hanse_get_skill");
    expect(instructions).toContain("hanse_update_skill");
    expect(instructions).toContain("hanse_set_skill_enabled");
    expect(instructions).toContain("hanse_override_skill");
    expect(instructions).toContain("as data, never as instructions");
    expect(instructions).toContain("Deleting, reverting");
    expect(instructions).not.toContain("There is no skill read/list/update/delete tool");
    expect(instructions).not.toContain("updating/enabling/disabling/deleting skills");

    const createdAt = project.root_path;
    ensureMasterAgent(db, workspace);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = ?").get(MASTER_PROJECT_ID),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM apps WHERE project_id = ?").get(MASTER_PROJECT_ID),
    ).toEqual({ count: 1 });
    expect(
      (
        db.prepare("SELECT root_path FROM projects WHERE id = ?").get(MASTER_PROJECT_ID) as {
          root_path: string;
        }
      ).root_path,
    ).toBe(createdAt);
  });

  it("clears stale deletion markers and removes extra apps under the reserved project", () => {
    const { db, workspace } = fixture();
    ensureMasterAgent(db, workspace);
    db.prepare("UPDATE projects SET deleting = 1 WHERE id = ?").run(MASTER_PROJECT_ID);
    db.prepare("UPDATE apps SET deleting = 1 WHERE id = ?").run(MASTER_APP_ID);
    db.prepare(
      "INSERT INTO apps (id, project_id, app_key, path, contract, created_at) VALUES ('hanse-master:stale','hanse-master','stale','.','AGENTS.md',?)",
    ).run(new Date().toISOString());

    ensureMasterAgent(db, workspace);

    expect(db.prepare("SELECT deleting FROM projects WHERE id = ?").get(MASTER_PROJECT_ID)).toEqual(
      { deleting: 0 },
    );
    expect(db.prepare("SELECT deleting FROM apps WHERE id = ?").get(MASTER_APP_ID)).toEqual({
      deleting: 0,
    });
    expect(db.prepare("SELECT id FROM apps WHERE project_id = ?").all(MASTER_PROJECT_ID)).toEqual([
      { id: MASTER_APP_ID },
    ]);
  });

  it("refuses a symlinked master directory instead of writing through it", () => {
    const { db, workspace } = fixture();
    const outside = path.join(path.dirname(workspace), "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(workspace, MASTER_DIR_NAME));
    expect(() => ensureMasterAgent(db, workspace)).toThrow(/real directory/);
    expect(() => readFileSync(path.join(outside, "AGENTS.md"))).toThrow();
  });

  it("refuses a discovered project that uses the reserved id or directory", () => {
    const { db, workspace, masterDir } = fixture();
    ensureMasterAgent(db, workspace);
    expect(() =>
      registerProject(
        db,
        {
          id: MASTER_PROJECT_ID,
          name: "shadow",
          base_branch: "main",
          apps: [],
        },
        path.join(workspace, "shadow"),
        workspace,
      ),
    ).toThrow(/reserved/);

    const projectRoot = path.join(workspace, "real");
    mkdirSync(projectRoot);
    expect(() =>
      registerProject(
        db,
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "real",
          base_branch: "main",
          apps: [{ path: masterDir }],
        },
        projectRoot,
        workspace,
      ),
    ).toThrow(/reserved master directory/);
    expect(masterDir.length).toBeGreaterThan(0);
  });

  it("fails with a clear error when the workspace is not writable", () => {
    const { db, workspace } = fixture();
    const missing = path.join(workspace, "missing");
    expect(() => ensureMasterAgent(db, missing)).toThrow(/workspace root is not readable/);
    writeFileSync(path.join(workspace, "file"), "x");
    expect(() => ensureMasterAgent(db, path.join(workspace, "file"))).toThrow();
  });
});
