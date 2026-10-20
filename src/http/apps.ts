import type { ManagedApp } from "../opencode/manager.js";
import type { RegisteredApp } from "../registry/index.js";
import { resolveAppPath } from "../runtime/app-path.js";
import type { HttpDeps, ProjectContext } from "./handler.js";

export interface FoundApp {
  project: ProjectContext;
  app: RegisteredApp;
}

/** Find an application by project id and app key, both resolved server-side. */
export function findApp(
  deps: Pick<HttpDeps, "getProjects">,
  projectId: string | undefined,
  appKey: string,
): FoundApp | undefined {
  for (const project of deps.getProjects()) {
    if (projectId !== undefined && project.id !== projectId) {
      continue;
    }
    const app = project.service.listApps().find((candidate) => candidate.appKey === appKey);
    if (app !== undefined) {
      return { project, app };
    }
  }
  return undefined;
}

/**
 * Resolve an application path and re-validate its containment on every use. Relative paths stay
 * relative to the project root; absolute paths must stay inside the workspace. A stale manifest or
 * database row therefore cannot launch an agent outside its allowed root.
 */
export function appDir(
  project: Pick<ProjectContext, "rootPath" | "workspaceRoot">,
  app: RegisteredApp,
): string {
  return resolveAppPath({
    appPath: app.path,
    projectRoot: project.rootPath,
    workspaceRoot: project.workspaceRoot,
  });
}

export function toManagedApp(found: FoundApp): ManagedApp {
  return {
    id: found.app.id,
    projectId: found.project.id,
    appKey: found.app.appKey,
    appDir: appDir(found.project, found.app),
    imageStatus: found.app.imageStatus,
    imageRef: found.app.imageRef,
  };
}
