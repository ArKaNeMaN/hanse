import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../config/load.js";
import { CoordinatorService } from "../coordinator/service.js";
import type { ProjectContext } from "../http/handler.js";
import { createHttpServer } from "../http/server.js";
import { upsertPrincipalWithToken } from "../identity/principals.js";
import { runMcpServer } from "../mcp/server.js";
import { InstanceManager } from "../opencode/manager.js";
import { discoverProject, registerProject } from "../registry/index.js";
import { coordinatorDbPath, coordinatorStateDir, defaultStateHome } from "../runtime/index.js";
import { openDatabase, runMigrations } from "../store/index.js";
import type { CliIo } from "./cli.js";

export interface CommandContext {
  cwd: string;
  stateHome: string;
  io: CliIo;
}

export function defaultContext(
  cwd: string,
  io: CliIo,
  flags: Record<string, string | boolean> = {},
): CommandContext {
  const stateHome =
    typeof flags["state-home"] === "string"
      ? flags["state-home"]
      : (process.env.HANSE_STATE_HOME ?? defaultStateHome());
  return { cwd, stateHome, io };
}

/** Scaffold `.hanse/project.yaml`. Idempotent. */
export async function initCommand(dir: string, ctx: CommandContext): Promise<number> {
  const target = path.resolve(ctx.cwd, dir);
  const configPath = path.join(target, ".hanse", "project.yaml");
  if (existsSync(configPath)) {
    ctx.io.stdout(`Project already initialized: ${configPath}`);
    return 0;
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  const manifest = [
    `id: ${randomUUID()}`,
    `name: ${path.basename(target)}`,
    "base_branch: main",
    "apps: []",
    "",
  ].join("\n");
  await writeFile(configPath, manifest, "utf8");
  ctx.io.stdout(`Initialized project at ${configPath}`);
  return 0;
}

/** Discover and register a project, then print its status. */
export async function statusCommand(dir: string, ctx: CommandContext): Promise<number> {
  const target = path.resolve(ctx.cwd, dir);
  let rootPath: string;
  let project: Awaited<ReturnType<typeof discoverProject>>["project"];
  try {
    const discovered = await discoverProject(target);
    project = discovered.project;
    rootPath = discovered.rootPath;
  } catch (error) {
    if (error instanceof ConfigError) {
      ctx.io.stderr(error.message);
      return 1;
    }
    throw error;
  }

  const db = openDatabase(coordinatorDbPath(ctx.stateHome));
  try {
    runMigrations(db);
    const registered = registerProject(db, project, rootPath);
    ctx.io.stdout(`Project ${registered.name} (${registered.id})`);
    ctx.io.stdout(`  root: ${registered.rootPath}`);
    if (registered.apps.length === 0) {
      ctx.io.stdout("  (no applications)");
    }
    for (const app of registered.apps) {
      const row = db.prepare("SELECT state FROM instances WHERE app_id = ?").get(app.id) as
        | { state: string }
        | undefined;
      ctx.io.stdout(`  app ${app.appKey} [${row?.state ?? "stopped"}] -> ${app.path}`);
    }
  } finally {
    db.close();
  }
  return 0;
}

export interface ServeOptions {
  workspace: string;
  hostname: string;
  port: number;
}

function prepareIde(stateHome: string): { extDir: string; userDataDir: string } {
  const base = path.join(coordinatorStateDir(stateHome), "code-server");
  const extDir = path.join(base, "extensions");
  const userDataDir = path.join(base, "data");
  mkdirSync(extDir, { recursive: true });
  mkdirSync(path.join(userDataDir, "User"), { recursive: true });

  const ownExtension = "/app/extensions/hanse-agent";
  if (existsSync(ownExtension)) {
    const target = path.join(extDir, "hanse.hanse-agent-0.1.0");
    rmSync(target, { recursive: true, force: true });
    cpSync(ownExtension, target, { recursive: true });
  }
  const bakedExtensions = "/opt/hanse-ext";
  if (existsSync(bakedExtensions)) {
    for (const entry of readdirSync(bakedExtensions)) {
      const target = path.join(extDir, entry);
      if (!existsSync(target)) {
        cpSync(path.join(bakedExtensions, entry), target, { recursive: true });
      }
    }
  }
  const settingsPath = path.join(userDataDir, "User", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  settings["workbench.colorTheme"] = "GitHub Dark Dimmed";
  settings["workbench.startupEditor"] = "none";
  settings["terminal.integrated.profiles.linux"] = {
    hanse: { path: "/usr/local/bin/hanse-shell" },
  };
  settings["terminal.integrated.defaultProfile.linux"] = "hanse";
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { extDir, userDataDir };
}

async function discoverProjectDirs(workspace: string): Promise<string[]> {
  const dirs: string[] = [];
  if (existsSync(path.join(workspace, ".hanse", "project.yaml"))) {
    dirs.push(workspace);
  }
  const entries = await readdir(workspace, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(workspace, entry.name);
    if (existsSync(path.join(candidate, ".hanse", "project.yaml"))) {
      dirs.push(candidate);
    }
  }
  return dirs;
}

/** Serve the web dashboard and HTTP API for every project found in the workspace. */
export async function serveCommand(options: ServeOptions, ctx: CommandContext): Promise<number> {
  const workspace = path.resolve(ctx.cwd, options.workspace);
  const db = openDatabase(coordinatorDbPath(ctx.stateHome));
  runMigrations(db);

  const token = process.env.HANSE_OPERATOR_TOKEN;
  if (token !== undefined && token.length > 0) {
    upsertPrincipalWithToken(db, { kind: "human", name: "operator", token });
  }

  for (const dir of await discoverProjectDirs(workspace)) {
    const { project, rootPath } = await discoverProject(dir);
    registerProject(db, project, rootPath);
  }

  const manager = new InstanceManager(
    db,
    coordinatorDbPath(ctx.stateHome),
    coordinatorStateDir(ctx.stateHome),
  );
  const getProjects = (): ProjectContext[] => {
    const rows = db.prepare("SELECT id, name, root_path FROM projects").all() as {
      id: string;
      name: string;
      root_path: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      service: new CoordinatorService(db, row.id),
    }));
  };
  const server = createHttpServer({ db, workspaceRoot: workspace, getProjects, manager });

  let ide: ChildProcess | null = null;
  const ideBin = process.env.HANSE_IDE_BIN ?? "/usr/lib/code-server/bin/code-server";
  if (process.env.HANSE_IDE !== "0" && existsSync(ideBin)) {
    const ideDirs = prepareIde(ctx.stateHome);
    ide = spawn(
      ideBin,
      [
        "--auth",
        "none",
        "--bind-addr",
        "127.0.0.1:8080",
        "--abs-proxy-base-path",
        "/ide",
        "--disable-telemetry",
        "--disable-update-check",
        "--user-data-dir",
        ideDirs.userDataDir,
        "--extensions-dir",
        ideDirs.extDir,
        workspace,
      ],
      { stdio: "inherit" },
    );
  }
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.hostname, resolve);
  });
  ctx.io.stdout(
    `hanse serving ${getProjects().length} project(s) at http://${options.hostname}:${options.port}`,
  );

  return await new Promise<number>((resolve) => {
    const shutdown = (): void => {
      manager.stopAll();
      ide?.kill("SIGTERM");
      server.close(() => {
        db.close();
        resolve(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/** Run the coordinator MCP server (stdio) bound to one application. */
export async function mcpCommand(ctx: CommandContext): Promise<number> {
  const projectId = process.env.HANSE_PROJECT_ID;
  const appKey = process.env.HANSE_APP_KEY;
  if (projectId === undefined || appKey === undefined) {
    ctx.io.stderr("mcp: HANSE_PROJECT_ID and HANSE_APP_KEY are required");
    return 2;
  }
  const db = openDatabase(process.env.HANSE_DB ?? coordinatorDbPath(ctx.stateHome));
  runMigrations(db);
  await runMcpServer(new CoordinatorService(db, projectId), appKey);
  db.close();
  return 0;
}
