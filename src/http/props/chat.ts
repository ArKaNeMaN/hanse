/**
 * Page props for the chat workspace (`/chat?app=&project=`).
 *
 * `buildChatProps` extracts the page-frame and context-rail data the legacy `renderChatPage`
 * assembles, so the future SPA endpoint and document cannot invent a second shape. Chat messages,
 * sessions, queues, and prompts stay on the existing `/api/apps/*` APIs; this module only carries
 * route identity, links, runtime state, app-selector options, handoffs, previews, and the stable
 * first-paint topbar fallback.
 *
 * No secret is read or returned: no runner token, provider key, MCP token, or password.
 */

import type { Handoff, HandoffReplyState, HandoffState } from "../../coordinator/handoff.js";
import { isMasterApp } from "../../master/constants.js";
import type { PreviewView } from "../../preview/types.js";
import { appDir } from "../apps.js";
import type { SiteModel } from "../dashboard.js";
import { type Crumb, ideFolderUrl, type RuntimeState } from "../ui.js";

export interface ChatAppIdentityProps {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly appKey: string;
  readonly href: string;
  readonly folder: string;
  readonly master: boolean;
}

export interface ChatLinksProps {
  readonly app: string;
  readonly ide: string;
  readonly settings: string;
  readonly skills: string;
  readonly terminal: string;
  readonly handoffs: string;
}

export interface ChatRuntimeProps {
  readonly state: RuntimeState;
  readonly runtimeUrl: string;
}

export interface ChatAppOptionProps {
  readonly appKey: string;
  readonly value: string;
  readonly projectId: string;
  readonly selected: boolean;
}

export interface ChatAppGroupProps {
  readonly projectId: string;
  readonly projectName: string;
  readonly apps: readonly ChatAppOptionProps[];
}

export interface ChatHandoffProps {
  readonly id: string;
  readonly shortId: string;
  readonly state: HandoffState;
  readonly replyState: HandoffReplyState;
  readonly summary: string;
  readonly updatedAt: string;
  readonly href: string;
}

export interface ChatDeletingProps {
  readonly app: boolean;
  readonly project: boolean;
  readonly pending: boolean;
}

export interface ChatTopbarProps {
  readonly ideHref: string;
  readonly needsInputCount: number;
  readonly policyVisible: boolean;
  readonly contextToggle: boolean;
}

export interface ChatProps {
  readonly app: ChatAppIdentityProps;
  readonly links: ChatLinksProps;
  readonly runtime: ChatRuntimeProps;
  readonly appOptions: readonly ChatAppGroupProps[];
  readonly pendingRestart: boolean;
  readonly handoffs: readonly ChatHandoffProps[];
  readonly previews: readonly PreviewView[];
  readonly deleting: ChatDeletingProps;
  readonly breadcrumb: readonly Crumb[];
  readonly title: string;
  readonly topbar: ChatTopbarProps;
}

export interface BuildChatPropsInput {
  readonly site: SiteModel;
  readonly projectId: string;
  readonly appKey: string;
  readonly previews?: readonly PreviewView[];
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function contextHandoffs(site: SiteModel, appId: string): Handoff[] {
  return site.projects
    .flatMap((project) => project.handoffs)
    .filter((handoff) => handoff.fromAppId === appId || handoff.toAppId === appId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function appGroups(
  site: SiteModel,
  selectedProjectId: string,
  selectedAppKey: string,
): ChatAppGroupProps[] {
  return site.projects
    .filter((project) => project.builtin !== true || project.id === selectedProjectId)
    .map((project) => ({
      projectId: project.id,
      projectName: project.name,
      apps: project.apps.map((app) => ({
        appKey: app.appKey,
        value: `${project.id}:${app.appKey}`,
        projectId: project.id,
        selected: project.id === selectedProjectId && app.appKey === selectedAppKey,
      })),
    }));
}

export function buildChatProps(input: BuildChatPropsInput): ChatProps | undefined {
  const project = input.site.projects.find((candidate) => candidate.id === input.projectId);
  if (project === undefined) {
    return undefined;
  }
  const app = project.apps.find((candidate) => candidate.appKey === input.appKey);
  if (app === undefined) {
    return undefined;
  }

  const runtime = input.site.runtime.get(app.id) ?? "stopped";
  const folder = appDir(project, app);
  const appHref = `/projects/${encoded(project.id)}/apps/${encoded(app.appKey)}`;
  const settingsHref = `${appHref}/settings`;
  const skillsHref = `${appHref}/skills`;
  const ideHref = ideFolderUrl(folder);
  const handoffs = contextHandoffs(input.site, app.id);
  const breadcrumb: Crumb[] = [
    { label: "Projects", href: "/projects" },
    { label: project.name, href: `/projects/${encoded(project.id)}` },
    { label: app.appKey, href: appHref },
    { label: "Chat" },
  ];

  return {
    app: {
      id: app.id,
      projectId: project.id,
      projectName: project.name,
      appKey: app.appKey,
      href: appHref,
      folder,
      master: isMasterApp(project.id, app.appKey),
    },
    links: {
      app: appHref,
      ide: ideHref,
      settings: settingsHref,
      skills: skillsHref,
      terminal: `/terminal?app=${encoded(app.appKey)}&project=${encoded(project.id)}`,
      handoffs: `/handoffs?q=${encoded(app.appKey)}`,
    },
    runtime: {
      state: runtime,
      runtimeUrl: `/api/apps/${encoded(app.appKey)}/runtime?project=${encoded(project.id)}`,
    },
    appOptions: appGroups(input.site, project.id, app.appKey),
    pendingRestart: input.site.pendingRestart.get(app.id) ?? false,
    handoffs: handoffs.map((handoff) => ({
      id: handoff.id,
      shortId: handoff.id.slice(0, 8),
      state: handoff.state,
      replyState: handoff.replyState,
      summary: handoff.summary,
      updatedAt: handoff.updatedAt,
      href: `/handoffs?q=${encoded(handoff.id)}`,
    })),
    previews: input.previews ?? [],
    deleting: {
      app: app.deleting,
      project: project.deleting,
      pending: app.deleting || project.deleting,
    },
    breadcrumb,
    title: `${app.appKey} chat`,
    topbar: {
      ideHref,
      needsInputCount: 0,
      policyVisible: false,
      contextToggle: true,
    },
  };
}
