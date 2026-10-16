import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../config/load.js";
import { discoverProject, registerProject } from "../registry/index.js";
import { coordinatorDbPath, defaultStateHome } from "../runtime/index.js";
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
