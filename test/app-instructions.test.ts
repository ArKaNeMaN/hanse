import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { addApplication, createProject } from "../src/coordinator/provision.js";
import { CoordinatorService } from "../src/coordinator/service.js";
import { toManagedApp } from "../src/http/apps.js";
import { resolveAppInstructionSources } from "../src/opencode/app-instructions.js";
import { materializeSharedInstructions } from "../src/opencode/shared-instructions.js";
import { openDatabase, runMigrations } from "../src/store/index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "hanse-instructions-")));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeProject(root: string, shared: string[] = []): void {
  mkdirSync(path.join(root, ".hanse"), { recursive: true });
  writeFileSync(
    path.join(root, ".hanse", "project.yaml"),
    stringify({
      id: "3f1c9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      name: "demo",
      base_branch: "main",
      shared,
      apps: [],
    }),
    "utf8",
  );
}

describe("resolveAppInstructionSources", () => {
  it("resolves project-shared docs and the app contract", () => {
    const projectRoot = tempDir();
    const appDir = path.join(projectRoot, "apps", "web");
    mkdirSync(appDir, { recursive: true });
    mkdirSync(path.join(projectRoot, "shared"), { recursive: true });
    writeProject(projectRoot, ["shared/AGENTS.md"]);
    writeFileSync(path.join(projectRoot, "shared", "AGENTS.md"), "# Shared\n", "utf8");
    writeFileSync(path.join(appDir, "AGENTS.md"), "# Web\n", "utf8");

    expect(
      resolveAppInstructionSources({
        appDir,
        projectRoot,
        workspaceRoot: projectRoot,
        contract: "AGENTS.md",
      }),
    ).toEqual({
      shared: [path.join(projectRoot, "shared", "AGENTS.md")],
      contract: path.join(appDir, "AGENTS.md"),
    });
  });

  it("skips missing, escaping, and duplicate paths", () => {
    const projectRoot = tempDir();
    const appDir = path.join(projectRoot, "apps", "web");
    mkdirSync(appDir, { recursive: true });
    writeProject(projectRoot, ["apps/web/AGENTS.md", "../outside.md", "missing.md"]);
    writeFileSync(path.join(appDir, "AGENTS.md"), "# Web\n", "utf8");

    expect(
      resolveAppInstructionSources({
        appDir,
        projectRoot,
        workspaceRoot: projectRoot,
        contract: "AGENTS.md",
      }),
    ).toEqual({
      shared: [],
      contract: path.join(appDir, "AGENTS.md"),
    });
  });

  it("refuses a contract that escapes the app directory", () => {
    const projectRoot = tempDir();
    const appDir = path.join(projectRoot, "apps", "web");
    mkdirSync(appDir, { recursive: true });
    writeProject(projectRoot, []);
    writeFileSync(path.join(projectRoot, "apps", "AGENTS.md"), "# Outside\n", "utf8");
    writeFileSync(path.join(appDir, "AGENTS.md"), "# Web\n", "utf8");

    expect(
      resolveAppInstructionSources({
        appDir,
        projectRoot,
        workspaceRoot: projectRoot,
        contract: "../AGENTS.md",
      }),
    ).toEqual({ shared: [] });
  });

  it("keeps the contract when the project manifest is missing", () => {
    const projectRoot = tempDir();
    const appDir = path.join(projectRoot, "apps", "web");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(path.join(appDir, "AGENTS.md"), "# Web\n", "utf8");

    expect(
      resolveAppInstructionSources({
        appDir,
        projectRoot,
        workspaceRoot: projectRoot,
        contract: "AGENTS.md",
      }),
    ).toEqual({
      shared: [],
      contract: path.join(appDir, "AGENTS.md"),
    });
  });

  it("wires project-shared docs and the app contract into toManagedApp", () => {
    const workspaceRoot = tempDir();
    const db = openDatabase(path.join(workspaceRoot, "db.sqlite"));
    runMigrations(db);
    try {
      const deps = { db, workspaceRoot };
      const project = createProject(deps, { name: "Demo" });
      const app = addApplication(deps, { projectId: project.id, name: "Web" });
      mkdirSync(path.join(project.rootPath, "shared"), { recursive: true });
      writeFileSync(path.join(project.rootPath, "shared", "AGENTS.md"), "# Shared\n", "utf8");
      writeFileSync(path.join(app.appDir, "AGENTS.md"), "# Web\n", "utf8");
      writeFileSync(
        path.join(project.rootPath, ".hanse", "project.yaml"),
        stringify({
          id: project.id,
          name: project.name,
          base_branch: "main",
          shared: ["shared/AGENTS.md"],
          apps: [{ path: app.path }],
        }),
        "utf8",
      );

      const service = new CoordinatorService(db, project.id);
      const appRow = service.listApps()[0];
      if (appRow === undefined) {
        throw new Error("registered app row is missing");
      }
      const found = {
        project: {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          workspaceRoot,
          service,
        },
        app: appRow,
      };

      const managed = toManagedApp(found);
      expect(managed.instructions).toEqual([path.join(app.appDir, "AGENTS.md")]);
      expect(managed.sharedInstructions).toEqual([
        path.join(project.rootPath, "shared", "AGENTS.md"),
      ]);
    } finally {
      db.close();
    }
  });
});

describe("materializeSharedInstructions", () => {
  it("writes sources into the app state and removes stale copies", () => {
    const root = tempDir();
    const state = path.join(root, "state");
    const first = path.join(root, "first.md");
    const second = path.join(root, "second.md");
    writeFileSync(first, "# First\n", "utf8");
    writeFileSync(second, "# Second\n", "utf8");
    const env = { XDG_STATE_HOME: state };

    const written = materializeSharedInstructions(env, [first, second]);
    expect(written).toEqual([
      path.join(state, "hanse", "instructions", "shared-00.md"),
      path.join(state, "hanse", "instructions", "shared-01.md"),
    ]);
    expect(readFileSync(written[0] ?? "", "utf8")).toBe("# First\n");

    const next = materializeSharedInstructions(env, [second]);
    expect(next).toEqual([path.join(state, "hanse", "instructions", "shared-00.md")]);
    expect(readFileSync(next[0] ?? "", "utf8")).toBe("# Second\n");
    expect(existsSync(written[1] ?? "")).toBe(false);
  });

  it("skips missing sources and removes the directory when the list is empty", () => {
    const root = tempDir();
    const env = { XDG_STATE_HOME: path.join(root, "state") };
    expect(materializeSharedInstructions(env, [path.join(root, "missing.md")])).toEqual([]);
    expect(existsSync(path.join(env.XDG_STATE_HOME, "hanse", "instructions"))).toBe(false);
  });
});
