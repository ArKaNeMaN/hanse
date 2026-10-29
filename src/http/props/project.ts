/**
 * Page props for project detail (`/projects/:id`).
 *
 * `buildProjectProps` is the single assembly used by the legacy `renderProject` and by
 * `GET /api/ui/projects/:id`, so the two renderers cannot drift. It returns `undefined` for an
 * unknown project so the endpoint can answer 404 and the SPA document can render its error view.
 *
 * No settings, credentials, provider keys, or MCP tokens are read here: the payload is project
 * metadata, app/runtime rows, handoff rows, and the dialog state needed by the SPA.
 */

import type {
  Handoff,
  HandoffDispatchMode,
  HandoffOrigin,
  HandoffOutcome,
  HandoffReplyMode,
  HandoffReplyState,
  HandoffState,
} from "../../coordinator/handoff.js";
import { masterChatHref } from "../../master/constants.js";
import { appDir } from "../apps.js";
import type { ProjectView, SiteModel } from "../dashboard.js";
import { ideFolderUrl, type RuntimeState } from "../ui.js";
import {
  appKeyFor,
  displayState,
  handoffCounts,
  projectLastActivity,
  reviewHref,
  sortedHandoffs,
} from "./shared.js";

export interface ProjectSummaryProps {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly baseBranch: string;
  readonly deleting: boolean;
}

export interface ProjectHrefsProps {
  readonly self: string;
  readonly settings: string;
  readonly skills: string;
  readonly ide: string;
}

export interface ProjectCountsProps {
  readonly applications: number;
  readonly running: number;
  readonly waiting: number;
  readonly handoffs: number;
}

export interface ProjectAppProps {
  readonly id: string;
  readonly appKey: string;
  readonly path: string;
  readonly kind: string;
  readonly runtime: RuntimeState;
  readonly pendingRestart: boolean;
  readonly deleting: boolean;
  readonly href: string;
  readonly chatHref: string | null;
  readonly settingsHref: string;
  readonly skillsHref: string;
  readonly restartHref: string;
  readonly ideHref: string;
}

export interface ProjectHandoffProps {
  readonly id: string;
  readonly fromAppId: string;
  readonly toAppId: string;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly summary: string;
  readonly state: HandoffState;
  readonly replyState: HandoffReplyState;
  readonly displayState: HandoffState;
  readonly updatedAt: string;
  readonly reviewHref: string;
  readonly spec: string;
  readonly attempts: number;
  readonly error: string | null;
  readonly result: string | null;
  readonly outcome: HandoffOutcome | null;
  readonly createdAt: string;
  readonly approvalKind: "dispatch" | "reply" | null;
  readonly policyDispatchMode: HandoffDispatchMode;
  readonly policyReplyMode: HandoffReplyMode;
  readonly origin: HandoffOrigin;
  readonly sourceSessionId: string | null;
  readonly sourceSessionHref: string | null;
  readonly sourceSessionDeleted: boolean;
  readonly targetSessionId: string | null;
  readonly targetSessionHref: string | null;
  readonly replyError: string | null;
  readonly replyDeliveredSessionId: string | null;
  readonly replyDeliveredAt: string | null;
  readonly replyDeliveredHref: string | null;
  readonly deliveredVia: string | null;
  readonly operatorNote: string | null;
  readonly canCancel: boolean;
  readonly canRelaunch: boolean;
  readonly canRetryReply: boolean;
  readonly canCancelReply: boolean;
  readonly returnTo: string;
}

export interface ProjectWaitingHandoffProps {
  readonly id: string;
  readonly fromAppId: string;
  readonly toAppId: string;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly state: HandoffState;
  readonly replyState: HandoffReplyState;
  readonly displayState: HandoffState;
  readonly summary: string;
  readonly updatedAt: string;
  readonly reviewHref: string;
}

export interface ProjectPolicyRuleProps {
  readonly id: number;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly dispatchMode: HandoffDispatchMode;
  readonly replyMode: HandoffReplyMode;
}

export interface ProjectPolicyProps {
  readonly rules: readonly ProjectPolicyRuleProps[];
  readonly appOptions: readonly string[];
  readonly wildcard: "*";
  readonly dispatchModes: readonly HandoffDispatchMode[];
  readonly replyModes: readonly HandoffReplyMode[];
}

export interface ProjectDeletionProps {
  readonly deleting: boolean;
  readonly projectName: string;
  readonly appCount: number;
  readonly action: string;
  readonly returnTo: string;
  readonly confirmName: string;
}

export interface AddAppDialogProps {
  readonly action: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly rootPath: string;
  readonly returnTo: string;
}

export interface NewHandoffDialogProps {
  readonly action: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly appOptions: readonly string[];
  readonly fromKey: string | null;
  readonly toKey: string | null;
  readonly disabled: boolean;
  readonly returnTo: string;
}

export interface ProjectDialogsProps {
  readonly addApp: AddAppDialogProps;
  readonly newHandoff: NewHandoffDialogProps;
  readonly delete: ProjectDeletionProps;
}

export interface MasterProjectSummaryProps {
  readonly runtime: RuntimeState;
  readonly kind: string;
  readonly path: string;
  readonly chatHref: string;
  readonly settingsHref: string;
  readonly skillsHref: string;
}

export interface ProjectProps {
  readonly project: ProjectSummaryProps;
  readonly hrefs: ProjectHrefsProps;
  readonly counts: ProjectCountsProps;
  readonly lastActivity: string;
  readonly apps: readonly ProjectAppProps[];
  readonly handoffs: readonly ProjectHandoffProps[];
  readonly waitingHandoffs: readonly ProjectWaitingHandoffProps[];
  readonly policy: ProjectPolicyProps;
  readonly deletion: ProjectDeletionProps;
  readonly dialogs: ProjectDialogsProps;
  readonly master: boolean;
  readonly masterSummary: MasterProjectSummaryProps | null;
}

function chatSessionHref(site: SiteModel, appId: string, sessionId: string | null): string | null {
  if (sessionId === null) return null;
  const app = site.apps.get(appId);
  if (app === undefined) return null;
  return `/chat?app=${encodeURIComponent(app.appKey)}&project=${encodeURIComponent(app.projectId)}&session=${encodeURIComponent(sessionId)}`;
}

function appChatHref(project: ProjectView, appKey: string): string {
  return `/chat?app=${encodeURIComponent(appKey)}&project=${encodeURIComponent(project.id)}`;
}

export function buildProjectHandoffProps(
  site: SiteModel,
  handoff: Handoff,
  returnTo: string,
): ProjectHandoffProps {
  const approvalKind =
    handoff.replyState === "awaiting_approval"
      ? ("reply" as const)
      : handoff.state === "awaiting_approval"
        ? ("dispatch" as const)
        : null;
  const terminal =
    handoff.state === "delivered" ||
    handoff.state === "rejected" ||
    handoff.state === "failed" ||
    handoff.state === "expired" ||
    handoff.state === "cancelled";
  const replyWaiting =
    handoff.replyState === "waiting_operator" ||
    handoff.replyState === "failed" ||
    handoff.replyState === "cancelled";
  const replyCancellable =
    handoff.state === "delivered" &&
    (handoff.replyState === "pending" ||
      handoff.replyState === "awaiting_approval" ||
      handoff.replyState === "waiting_operator" ||
      handoff.replyState === "failed");
  return {
    id: handoff.id,
    fromAppId: handoff.fromAppId,
    toAppId: handoff.toAppId,
    fromAppKey: appKeyFor(site, handoff.fromAppId),
    toAppKey: appKeyFor(site, handoff.toAppId),
    summary: handoff.summary,
    state: handoff.state,
    replyState: handoff.replyState,
    displayState: displayState(handoff),
    updatedAt: handoff.updatedAt,
    reviewHref: reviewHref(handoff),
    spec: handoff.spec,
    attempts: handoff.attempts,
    error: handoff.error,
    result: handoff.result,
    outcome: handoff.outcome,
    createdAt: handoff.createdAt,
    approvalKind,
    policyDispatchMode: handoff.policyDispatchMode,
    policyReplyMode: handoff.policyReplyMode,
    origin: handoff.origin,
    sourceSessionId: handoff.sourceSessionId,
    sourceSessionHref: chatSessionHref(site, handoff.fromAppId, handoff.sourceSessionId),
    sourceSessionDeleted: handoff.sourceSessionDeletedAt !== null,
    targetSessionId: handoff.targetSessionId,
    targetSessionHref: chatSessionHref(site, handoff.toAppId, handoff.targetSessionId),
    replyError: handoff.replyError,
    replyDeliveredSessionId: handoff.replyDeliveredSessionId,
    replyDeliveredAt: handoff.replyDeliveredAt,
    replyDeliveredHref: chatSessionHref(site, handoff.fromAppId, handoff.replyDeliveredSessionId),
    deliveredVia: handoff.deliveredVia,
    operatorNote: handoff.operatorNote,
    canCancel: !terminal,
    canRelaunch: handoff.result !== null && replyWaiting,
    canRetryReply:
      handoff.result !== null &&
      (handoff.replyState === "waiting_operator" || handoff.replyState === "failed") &&
      handoff.sourceSessionId !== null &&
      handoff.sourceSessionDeletedAt === null,
    canCancelReply: replyCancellable,
    returnTo,
  };
}

export function buildProjectProps(site: SiteModel, projectId: string): ProjectProps | undefined {
  const project = site.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) {
    return undefined;
  }

  const encodedId = encodeURIComponent(project.id);
  const projectBase = `/projects/${encodedId}`;
  const hrefs: ProjectHrefsProps = {
    self: projectBase,
    settings: `${projectBase}/settings`,
    skills: `${projectBase}/skills`,
    ide: ideFolderUrl(project.rootPath),
  };
  const counts = handoffCounts(project.handoffs);
  const waiting = sortedHandoffs(
    project.handoffs.filter(
      (handoff) =>
        handoff.state === "awaiting_approval" || handoff.replyState === "awaiting_approval",
    ),
  );
  const running = project.apps.filter(
    (app) => (site.runtime.get(app.id) ?? "stopped") === "running",
  ).length;

  const apps: ProjectAppProps[] = project.apps.map((app) => {
    const runtime = site.runtime.get(app.id) ?? "stopped";
    const appBase = `${projectBase}/apps/${encodeURIComponent(app.appKey)}`;
    return {
      id: app.id,
      appKey: app.appKey,
      path: app.path,
      kind: app.kind ?? "app",
      runtime,
      pendingRestart: site.pendingRestart.get(app.id) ?? false,
      deleting: app.deleting,
      href: appBase,
      chatHref: app.deleting || project.deleting ? null : appChatHref(project, app.appKey),
      settingsHref: `${appBase}/settings`,
      skillsHref: `${appBase}/skills`,
      restartHref: `${appBase}/settings`,
      ideHref: ideFolderUrl(appDir(project, app)),
    };
  });

  const returnTo = `/projects/${project.id}`;
  const handoffs: ProjectHandoffProps[] = project.handoffs.map((handoff) =>
    buildProjectHandoffProps(site, handoff, returnTo),
  );
  const waitingHandoffs: ProjectWaitingHandoffProps[] = waiting.map((handoff) => ({
    id: handoff.id,
    fromAppId: handoff.fromAppId,
    toAppId: handoff.toAppId,
    fromAppKey: appKeyFor(site, handoff.fromAppId),
    toAppKey: appKeyFor(site, handoff.toAppId),
    state: handoff.state,
    replyState: handoff.replyState,
    displayState: displayState(handoff),
    summary: handoff.summary,
    updatedAt: handoff.updatedAt,
    reviewHref: reviewHref(handoff, "waiting"),
  }));

  const appOptions = project.apps.map((app) => app.appKey);
  const fromKey = appOptions[0] ?? null;
  const toKey = appOptions[1] ?? fromKey;
  const deletion: ProjectDeletionProps = {
    deleting: project.deleting,
    projectName: project.name,
    appCount: project.apps.length,
    action: `/api/projects/${encodedId}/delete`,
    returnTo: projectBase,
    confirmName: project.name,
  };

  const policy: ProjectPolicyProps = {
    rules: project.handoffPolicies.map((rule) => ({
      id: rule.id,
      fromAppKey: rule.fromAppKey,
      toAppKey: rule.toAppKey,
      dispatchMode: rule.dispatchMode,
      replyMode: rule.replyMode,
    })),
    appOptions,
    wildcard: "*",
    dispatchModes: ["auto", "approve", "deny"],
    replyModes: ["auto", "approve"],
  };

  const dialogs: ProjectDialogsProps = {
    addApp: {
      action: `/api/projects/${encodedId}/apps`,
      projectId: project.id,
      projectName: project.name,
      rootPath: project.rootPath,
      returnTo: `/projects/${project.id}`,
    },
    newHandoff: {
      action: "/api/handoffs",
      projectId: project.id,
      projectName: project.name,
      appOptions,
      fromKey,
      toKey,
      disabled: appOptions.length === 0,
      returnTo: `/projects/${project.id}`,
    },
    delete: deletion,
  };

  let masterSummary: MasterProjectSummaryProps | null = null;
  if (project.builtin === true) {
    const app = project.apps[0];
    const runtime = app === undefined ? "stopped" : (site.runtime.get(app.id) ?? "stopped");
    masterSummary = {
      runtime,
      kind: app?.kind ?? "master",
      path: app?.path ?? project.rootPath,
      chatHref: app === undefined ? masterChatHref() : appChatHref(project, app.appKey),
      settingsHref:
        app === undefined
          ? `${projectBase}/settings`
          : `${projectBase}/apps/${encodeURIComponent(app.appKey)}/settings`,
      skillsHref:
        app === undefined
          ? `${projectBase}/skills`
          : `${projectBase}/apps/${encodeURIComponent(app.appKey)}/skills`,
    };
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      baseBranch: project.baseBranch,
      deleting: project.deleting,
    },
    hrefs,
    counts: {
      applications: project.apps.length,
      running,
      waiting: counts.waiting,
      handoffs: counts.all,
    },
    lastActivity: projectLastActivity(project),
    apps,
    handoffs,
    waitingHandoffs,
    policy,
    deletion,
    dialogs,
    master: project.builtin === true,
    masterSummary,
  };
}
