/**
 * Structural mirror of `src/http/props/project.ts` for the client.
 *
 * The server renderer and `GET /api/ui/projects/:id` share one assembly, so these shapes are the
 * data contract. Keeping them in a small client module avoids importing server code into the Vite
 * bundle while still typing the boot payload and query response.
 */

import type { BootChrome } from "./boot.js";
import type { HandoffReplyState, HandoffState, RuntimeState } from "./status.js";

export type HandoffDispatchMode = "auto" | "approve" | "deny";
export type HandoffReplyMode = "auto" | "approve";
export type HandoffOutcome = "completed" | "failed" | "rejected" | "expired" | string;
export type HandoffOrigin = "agent" | "operator" | string;

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly baseBranch: string;
  readonly deleting: boolean;
}

export interface ProjectHrefs {
  readonly self: string;
  readonly settings: string;
  readonly skills: string;
  readonly ide: string;
}

export interface ProjectCounts {
  readonly applications: number;
  readonly running: number;
  readonly waiting: number;
  readonly handoffs: number;
}

export interface ProjectApp {
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

export interface ProjectHandoff {
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

export interface ProjectWaitingHandoff {
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

export interface ProjectPolicyRule {
  readonly id: number;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly dispatchMode: HandoffDispatchMode;
  readonly replyMode: HandoffReplyMode;
}

export interface ProjectPolicy {
  readonly rules: readonly ProjectPolicyRule[];
  readonly appOptions: readonly string[];
  readonly wildcard: "*";
  readonly dispatchModes: readonly HandoffDispatchMode[];
  readonly replyModes: readonly HandoffReplyMode[];
}

export interface ProjectDeletion {
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

export interface ProjectDialogs {
  readonly addApp: AddAppDialogProps;
  readonly newHandoff: NewHandoffDialogProps;
  readonly delete: ProjectDeletion;
}

export interface MasterProjectSummary {
  readonly runtime: RuntimeState;
  readonly kind: string;
  readonly path: string;
  readonly chatHref: string;
  readonly settingsHref: string;
  readonly skillsHref: string;
}

export interface ProjectProps {
  readonly project: ProjectSummary;
  readonly hrefs: ProjectHrefs;
  readonly counts: ProjectCounts;
  readonly lastActivity: string;
  readonly apps: readonly ProjectApp[];
  readonly handoffs: readonly ProjectHandoff[];
  readonly waitingHandoffs: readonly ProjectWaitingHandoff[];
  readonly policy: ProjectPolicy;
  readonly deletion: ProjectDeletion;
  readonly dialogs: ProjectDialogs;
  readonly master: boolean;
  readonly masterSummary: MasterProjectSummary | null;
}

export interface ProjectResponse extends ProjectProps {
  readonly chrome?: BootChrome;
}
