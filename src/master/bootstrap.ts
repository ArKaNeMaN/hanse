import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isValidAppId } from "../agent/spec.js";
import { resolveAppPath } from "../runtime/app-path.js";
import type { SqliteDatabase } from "../store/index.js";
import {
  MASTER_APP_ID,
  MASTER_APP_KEY,
  MASTER_DIR_NAME,
  MASTER_PROJECT_ID,
  MASTER_PROJECT_NAME,
} from "./constants.js";
import { MASTER_INSTRUCTIONS } from "./instructions.js";
import { writeRegularFileNoFollow } from "./workspace-files.js";

/** Startup failed because the reserved master directory or rows could not be established. */
export class MasterBootstrapError extends Error {
  readonly code = "master_bootstrap_failed";

  constructor(message: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : undefined;
    super(detail === undefined ? message : `${message}: ${detail}`);
    this.name = "MasterBootstrapError";
  }
}

function ensureRealMasterDirectory(workspaceReal: string): string {
  const directory = path.join(workspaceReal, MASTER_DIR_NAME);
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new MasterBootstrapError(`cannot inspect ${directory}`, error);
    }
  }
  if (stat !== undefined) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MasterBootstrapError(
        `${directory} must be a real directory; a symlink or file is not allowed`,
      );
    }
    const resolved = realpathSync(directory);
    if (resolved !== directory) {
      throw new MasterBootstrapError(`${directory} resolves outside its canonical path`);
    }
    return directory;
  }
  try {
    mkdirSync(directory, { mode: 0o755 });
    const resolved = realpathSync(directory);
    if (resolved !== directory) {
      throw new MasterBootstrapError(`${directory} resolves outside its canonical path`);
    }
  } catch (error) {
    if (error instanceof MasterBootstrapError) {
      throw error;
    }
    throw new MasterBootstrapError(`cannot create ${directory}`, error);
  }
  return directory;
}

/**
 * Establish the reserved master project, application, directory, and instructions.
 *
 * Idempotent. Every filesystem write happens before the database transaction commits, and the
 * directory is canonicalized and checked so a pre-existing symlink can never redirect the write.
 */
export function ensureMasterAgent(db: SqliteDatabase, workspaceRoot: string): void {
  let workspaceReal: string;
  try {
    workspaceReal = realpathSync(workspaceRoot);
  } catch (error) {
    throw new MasterBootstrapError(`workspace root is not readable: ${workspaceRoot}`, error);
  }
  const directory = ensureRealMasterDirectory(workspaceReal);

  try {
    writeRegularFileNoFollow(directory, "AGENTS.md", MASTER_INSTRUCTIONS, 0o644);
  } catch (error) {
    throw new MasterBootstrapError(`cannot write the master instructions`, error);
  }

  let appDirectory: string;
  try {
    appDirectory = resolveAppPath({
      appPath: ".",
      projectRoot: directory,
      workspaceRoot: workspaceReal,
    });
  } catch (error) {
    throw new MasterBootstrapError("cannot resolve the master application directory", error);
  }
  if (appDirectory !== directory) {
    throw new MasterBootstrapError("the master application directory is not canonical");
  }
  if (!isValidAppId(MASTER_APP_ID)) {
    throw new MasterBootstrapError("the reserved master application id is not valid");
  }

  const now = new Date().toISOString();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO projects (id, name, base_branch, root_path, created_at, updated_at, deleting)
         VALUES (@id, @name, 'main', @root_path, @created_at, @updated_at, 0)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_branch = excluded.base_branch,
           root_path = excluded.root_path,
           deleting = 0,
           updated_at = excluded.updated_at`,
      ).run({
        id: MASTER_PROJECT_ID,
        name: MASTER_PROJECT_NAME,
        root_path: directory,
        created_at: now,
        updated_at: now,
      });
      db.prepare("DELETE FROM apps WHERE project_id = ? AND id <> ?").run(
        MASTER_PROJECT_ID,
        MASTER_APP_ID,
      );
      db.prepare(
        `INSERT INTO apps (
           id, project_id, app_key, path, kind, contract, created_at, deleting,
           image_ref, image_status, image_hash, image_base_digest, image_built_at, image_error
         )
         VALUES (@id, @project_id, @app_key, '.', 'master', 'AGENTS.md', @created_at, 0,
                 NULL, 'missing', NULL, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           app_key = excluded.app_key,
           path = excluded.path,
           kind = excluded.kind,
           contract = excluded.contract,
           deleting = 0,
           image_ref = NULL,
           image_status = 'missing',
           image_hash = NULL,
           image_base_digest = NULL,
           image_built_at = NULL,
           image_error = NULL`,
      ).run({
        id: MASTER_APP_ID,
        project_id: MASTER_PROJECT_ID,
        app_key: MASTER_APP_KEY,
        created_at: now,
      });
    })();
  } catch (error) {
    throw new MasterBootstrapError("cannot write the reserved master rows", error);
  }
}
