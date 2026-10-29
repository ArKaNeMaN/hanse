import { describe, expect, it } from "vitest";
import type { Handoff } from "../src/coordinator/handoff.js";
import type { ProjectView, SiteModel } from "../src/http/dashboard.js";
import { renderProjects } from "../src/http/dashboard.js";
import { buildProjectsProps, type ProjectsSourceProject } from "../src/http/props/projects.js";

function handoff(state: string, replyState: string, updatedAt: string): Handoff {
  return { state, replyState, updatedAt } as unknown as Handoff;
}

function sourceProject(
  id: string,
  name: string,
  rootPath: string,
  options: {
    builtin?: boolean;
    deleting?: boolean;
    appCount?: number;
    handoffs?: Handoff[];
    createdAt?: string;
  } = {},
): ProjectsSourceProject {
  return {
    id,
    name,
    rootPath,
    createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
    deleting: options.deleting ?? false,
    ...(options.builtin === undefined ? {} : { builtin: options.builtin }),
    apps: Array.from({ length: options.appCount ?? 0 }, () => ({})),
    handoffs: options.handoffs ?? [],
  };
}

function siteModel(projects: ProjectsSourceProject[]): SiteModel {
  return {
    projects: projects as unknown as ProjectView[],
    apps: new Map(),
    runtime: new Map(),
    pendingRestart: new Map(),
    pendingRestartReasons: new Map(),
    pendingCount: 0,
    sshPendingCount: 0,
    sshPendingByApp: new Map(),
    sshHostsByApp: new Map(),
    startingCount: 0,
    runningCount: 0,
    errorCount: 0,
    stoppedCount: 0,
    appCount: projects.reduce((total, project) => total + project.apps.length, 0),
    handoffCount: 0,
  };
}

describe("projects page props", () => {
  it("excludes the master project and sorts operator projects by name", () => {
    const props = buildProjectsProps({
      projects: [
        sourceProject("zulu", "Zulu", "/workspace/zulu", { appCount: 2 }),
        sourceProject("master", "Hanse master", "/workspace/.hanse-master", { builtin: true }),
        sourceProject("alpha", "Alpha", "/workspace/alpha", { appCount: 1 }),
      ],
      appCount: 3,
    });
    expect(props.projectCount).toBe(2);
    expect(props.appCount).toBe(3);
    expect(props.matchedCount).toBe(2);
    expect(props.rows.map((row) => row.id)).toEqual(["alpha", "zulu"]);
    expect(props.rows[1]).toMatchObject({ id: "zulu", appCount: 2, waitingCount: 0 });
  });

  it("filters by name or root path and trims the query", () => {
    const source = {
      projects: [
        sourceProject("alpha", "Alpha", "/workspace/alpha"),
        sourceProject("beta", "Beta", "/workspace/beta"),
      ],
      appCount: 0,
    };
    expect(buildProjectsProps(source, "  alp  ").rows.map((row) => row.id)).toEqual(["alpha"]);
    expect(buildProjectsProps(source, "beta").query).toBe("beta");
    expect(buildProjectsProps(source, "workspace/beta").rows.map((row) => row.id)).toEqual([
      "beta",
    ]);
    expect(buildProjectsProps(source, "nothing")).toMatchObject({
      matchedCount: 0,
      projectCount: 2,
    });
  });

  it("counts waiting handoffs and uses the latest handoff as updated time", () => {
    const props = buildProjectsProps({
      projects: [
        sourceProject("alpha", "Alpha", "/workspace/alpha", {
          deleting: true,
          handoffs: [
            handoff("awaiting_approval", "none", "2026-02-01T00:00:00.000Z"),
            handoff("delivered", "awaiting_approval", "2026-03-01T00:00:00.000Z"),
            handoff("delivered", "none", "2026-01-15T00:00:00.000Z"),
          ],
        }),
      ],
      appCount: 0,
    });
    expect(props.rows[0]).toEqual({
      id: "alpha",
      name: "Alpha",
      rootPath: "/workspace/alpha",
      appCount: 0,
      waitingCount: 2,
      updatedAt: "2026-03-01T00:00:00.000Z",
      deleting: true,
    });
  });

  it("keeps the legacy projects HTML deriving from the same props", () => {
    const site = siteModel([
      sourceProject("alpha", "Alpha", "/workspace/alpha", { appCount: 2 }),
      sourceProject("beta", "Beta", "/workspace/beta", { appCount: 1 }),
    ]);
    const response = renderProjects(site, {
      chrome: { operatorName: "alice" },
    });
    expect(response).toContain("Project ledger");
    expect(response).toContain('name="q"');
    expect(response).toContain(">Alpha</a>");
    expect(response).toContain(">Beta</a>");
    expect(response).toContain("2 projects");
    expect(response).toContain("3 applications");
  });

  it("keeps the legacy no-match and no-project states", () => {
    const site = siteModel([sourceProject("alpha", "Alpha", "/workspace/alpha")]);
    const none = renderProjects(site, { q: "nothing", chrome: { operatorName: "alice" } });
    expect(none).toContain("No matching projects");
    expect(none).toContain("Clear search");

    const empty = renderProjects(siteModel([]), {
      chrome: { operatorName: "alice" },
    });
    expect(empty).toContain("No projects yet");
    expect(empty).toContain("A project is a folder with a manifest.");
  });
});
