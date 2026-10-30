/**
 * Page props for the operator terminal (`/terminal?app=&project=`).
 *
 * `buildTerminalProps` extracts the identity, runtime state, WebSocket path, and links that the
 * legacy `renderTerminalPage` assembles, so the future SPA endpoint/document cannot drift. The WS
 * path carries only the app key and project id; no runtime token is included.
 */

import { appDir } from "../apps.js";
import type { SiteModel } from "../dashboard.js";
import { type Crumb, ideFolderUrl, type RuntimeState } from "../ui.js";

export interface TerminalAppIdentityProps {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly appKey: string;
  readonly href: string;
  readonly folder: string;
}

export interface TerminalLinksProps {
  readonly app: string;
  readonly chat: string;
  readonly ide: string;
}

export interface TerminalRuntimeProps {
  readonly state: RuntimeState;
  readonly wsPath: string;
  readonly runtimeUrl: string;
}

export interface TerminalTopbarProps {
  readonly ideHref: string;
}

export interface TerminalProps {
  readonly app: TerminalAppIdentityProps;
  readonly links: TerminalLinksProps;
  readonly runtime: TerminalRuntimeProps;
  readonly deleting: boolean;
  readonly breadcrumb: readonly Crumb[];
  readonly title: string;
  readonly topbar: TerminalTopbarProps;
}

export interface BuildTerminalPropsInput {
  readonly site: SiteModel;
  readonly projectId: string;
  readonly appKey: string;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function buildTerminalProps(input: BuildTerminalPropsInput): TerminalProps | undefined {
  const project = input.site.projects.find((candidate) => candidate.id === input.projectId);
  if (project === undefined) {
    return undefined;
  }
  const app = project.apps.find((candidate) => candidate.appKey === input.appKey);
  if (app === undefined) {
    return undefined;
  }

  const folder = appDir(project, app);
  const appHref = `/projects/${encoded(project.id)}/apps/${encoded(app.appKey)}`;
  const ideHref = ideFolderUrl(folder);
  const breadcrumb: Crumb[] = [
    { label: "Projects", href: "/projects" },
    { label: project.name, href: `/projects/${encoded(project.id)}` },
    { label: app.appKey, href: appHref },
    { label: "Terminal" },
  ];

  return {
    app: {
      id: app.id,
      projectId: project.id,
      projectName: project.name,
      appKey: app.appKey,
      href: appHref,
      folder,
    },
    links: {
      app: appHref,
      chat: `/chat?app=${encoded(app.appKey)}&project=${encoded(project.id)}`,
      ide: ideHref,
    },
    runtime: {
      state: input.site.runtime.get(app.id) ?? "stopped",
      wsPath: `/api/apps/${encoded(app.appKey)}/terminal?project=${encoded(project.id)}`,
      runtimeUrl: `/api/apps/${encoded(app.appKey)}/runtime?project=${encoded(project.id)}`,
    },
    deleting: app.deleting || project.deleting,
    breadcrumb,
    title: `${app.appKey} terminal`,
    topbar: { ideHref },
  };
}
