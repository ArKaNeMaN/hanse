/**
 * Page props for the projects index.
 *
 * The legacy `renderProjects` and `GET /api/ui/projects` both consume this assembly so the two
 * renderers cannot drift. It intentionally accepts a structural project shape instead of importing
 * `dashboard.ts`, which keeps the data module acyclic and testable.
 */

export interface ProjectsSourceHandoff {
  readonly updatedAt: string;
  readonly state: string;
  readonly replyState: string;
}

export interface ProjectsSourceProject {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAt: string;
  readonly deleting: boolean;
  readonly builtin?: boolean;
  readonly apps: readonly unknown[];
  readonly handoffs: readonly ProjectsSourceHandoff[];
}

export interface ProjectsSource {
  readonly projects: readonly ProjectsSourceProject[];
  readonly appCount: number;
}

export interface ProjectRowProps {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly appCount: number;
  readonly waitingCount: number;
  readonly updatedAt: string;
  readonly deleting: boolean;
}

export interface ProjectsProps {
  readonly query: string;
  readonly rows: readonly ProjectRowProps[];
  readonly projectCount: number;
  readonly appCount: number;
  readonly matchedCount: number;
}

function lastActivity(project: ProjectsSourceProject): string {
  let latest = project.createdAt;
  for (const handoff of project.handoffs) {
    if (handoff.updatedAt > latest) {
      latest = handoff.updatedAt;
    }
  }
  return latest;
}

function waitingCount(project: ProjectsSourceProject): number {
  let waiting = 0;
  for (const handoff of project.handoffs) {
    if (handoff.state === "awaiting_approval" || handoff.replyState === "awaiting_approval") {
      waiting += 1;
    }
  }
  return waiting;
}

export function buildProjectsProps(site: ProjectsSource, q?: string): ProjectsProps {
  const query = (q ?? "").trim();
  const needle = query.toLowerCase();
  const operator = site.projects.filter((project) => project.builtin !== true);
  const filtered = operator.filter((project) => {
    if (needle.length === 0) {
      return true;
    }
    return (
      project.name.toLowerCase().includes(needle) || project.rootPath.toLowerCase().includes(needle)
    );
  });
  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted.map((project) => ({
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    appCount: project.apps.length,
    waitingCount: waitingCount(project),
    updatedAt: lastActivity(project),
    deleting: project.deleting,
  }));
  return {
    query,
    rows,
    projectCount: operator.length,
    appCount: site.appCount,
    matchedCount: rows.length,
  };
}
