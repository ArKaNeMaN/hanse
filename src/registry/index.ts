import path from "node:path";
import { loadProject } from "../config/load.js";
import type { Project } from "../schema/index.js";
import type { SqliteDatabase } from "../store/index.js";

/** An application registered with the coordinator. */
export interface RegisteredApp {
  id: string;
  projectId: string;
  appKey: string;
  path: string;
  kind: string | null;
  contract: string;
}

export interface RegisteredProject {
  id: string;
  name: string;
  baseBranch: string;
  rootPath: string;
  apps: RegisteredApp[];
}

/** Stable application id: unique per (project, app). */
export function appId(projectId: string, appKey: string): string {
  return `${projectId}:${appKey}`;
}

/** Discover a project manifest by walking up from `startDir`. */
export async function discoverProject(
  startDir: string,
): Promise<{ project: Project; rootPath: string }> {
  const { project, rootPath } = await loadProject(startDir);
  return { project, rootPath };
}

/** Upsert a project and its applications into the store. Idempotent. */
export function registerProject(
  db: SqliteDatabase,
  project: Project,
  rootPath: string,
): RegisteredProject {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at)
     VALUES (@id, @name, @base_branch, @root_path, @created_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, base_branch = excluded.base_branch,
       root_path = excluded.root_path, updated_at = excluded.updated_at`,
  ).run({
    id: project.id,
    name: project.name,
    base_branch: project.base_branch,
    root_path: rootPath,
    created_at: now,
    updated_at: now,
  });

  const upsertApp = db.prepare(
    `INSERT INTO apps (id, project_id, app_key, path, kind, contract, created_at)
     VALUES (@id, @project_id, @app_key, @path, @kind, @contract, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       path = excluded.path, kind = excluded.kind, contract = excluded.contract`,
  );

  const apps: RegisteredApp[] = [];
  for (const entry of project.apps) {
    const appKey = path.basename(entry.path);
    const id = appId(project.id, appKey);
    const kind = entry.kind ?? null;
    upsertApp.run({
      id,
      project_id: project.id,
      app_key: appKey,
      path: entry.path,
      kind,
      contract: "AGENTS.md",
      created_at: now,
    });
    apps.push({ id, projectId: project.id, appKey, path: entry.path, kind, contract: "AGENTS.md" });
  }

  return { id: project.id, name: project.name, baseBranch: project.base_branch, rootPath, apps };
}
