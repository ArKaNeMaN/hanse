import { MASTER_APP_KEY, MASTER_PROJECT_ID } from "../../master/constants.js";
import type { RegisteredApp } from "../../registry/index.js";
import { operatorProjects, type ProjectView, type SiteModel } from "../dashboard.js";

export interface TargetAppProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly appKey: string;
  readonly kind: string | null;
  readonly master: boolean;
}

export interface TargetProjectProps {
  readonly id: string;
  readonly name: string;
  readonly apps: readonly TargetAppProps[];
}

export interface TargetsProps {
  readonly projects: readonly TargetProjectProps[];
  readonly master: TargetAppProps | null;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function targetApp(project: ProjectView, app: RegisteredApp, master: boolean): TargetAppProps {
  return {
    projectId: project.id,
    projectName: project.name,
    appKey: app.appKey,
    kind: app.kind,
    master,
  };
}

export function buildTargets(site: SiteModel): TargetsProps {
  const projects = operatorProjects(site)
    .filter((project) => !project.deleting)
    .map(
      (project): TargetProjectProps => ({
        id: project.id,
        name: project.name,
        apps: project.apps
          .filter((app) => !app.deleting)
          .map((app) => targetApp(project, app, false))
          .sort((left, right) => compareStrings(left.appKey, right.appKey)),
      }),
    )
    .sort(
      (left, right) => compareStrings(left.name, right.name) || compareStrings(left.id, right.id),
    );

  const masterProject = site.projects.find(
    (project) => project.id === MASTER_PROJECT_ID && !project.deleting,
  );
  const masterApp = masterProject?.apps.find(
    (app) => app.appKey === MASTER_APP_KEY && !app.deleting,
  );

  return {
    projects,
    master:
      masterProject === undefined || masterApp === undefined
        ? null
        : targetApp(masterProject, masterApp, true),
  };
}
