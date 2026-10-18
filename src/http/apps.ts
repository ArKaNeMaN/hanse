import type { RegisteredApp } from "../registry/index.js";
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
 * Resolve an application path: absolute paths stay absolute, relative paths are joined to the
 * project root. Kept identical to the historical chat/dashboard rule.
 */
export function appDir(project: Pick<ProjectContext, "rootPath">, app: RegisteredApp): string {
  return app.path.startsWith("/")
    ? app.path
    : `${project.rootPath.replace(/\/+$/, "")}/${app.path.replace(/^\/+/, "")}`;
}
