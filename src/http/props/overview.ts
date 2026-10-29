/**
 * Page props for the fleet overview (`/`).
 *
 * `buildOverviewProps` is the single assembly used by the legacy `renderOverview` and by
 * `GET /api/ui/overview`, so the two renderers cannot drift. The `SiteModel` import is type-only,
 * keeping the runtime dependency graph acyclic.
 */

import type { HandoffReplyState, HandoffState } from "../../coordinator/handoff.js";
import type { SiteModel } from "../dashboard.js";
import {
  allHandoffs,
  appKeyFor,
  displayState,
  handoffCounts,
  projectLastActivity,
  reviewHref,
  sortedHandoffs,
  waitingHandoffs,
} from "./shared.js";

export interface OverviewCountsProps {
  readonly projects: number;
  readonly applications: number;
  readonly running: number;
  readonly starting: number;
  readonly stopped: number;
  readonly error: number;
  readonly handoffsWaiting: number;
  readonly handoffsTotal: number;
}

export interface OverviewProjectRowProps {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly appCount: number;
  readonly waitingCount: number;
  readonly lastActivity: string;
  readonly deleting: boolean;
}

export interface OverviewHandoffRowProps {
  readonly id: string;
  readonly fromAppId: string;
  readonly toAppId: string;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly summary: string;
  readonly state: HandoffState;
  readonly replyState: HandoffReplyState;
  readonly updatedAt: string;
  readonly reviewHref: string;
}

export interface OverviewWaitingHandoffProps {
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

export interface OverviewProps {
  readonly counts: OverviewCountsProps;
  readonly projects: readonly OverviewProjectRowProps[];
  readonly recentHandoffs: readonly OverviewHandoffRowProps[];
  readonly waitingHandoffs: readonly OverviewWaitingHandoffProps[];
}

export function buildOverviewProps(site: SiteModel): OverviewProps {
  const projects = site.projects
    .filter((project) => project.builtin !== true)
    .sort((a, b) => projectLastActivity(b).localeCompare(projectLastActivity(a)));
  const recent = sortedHandoffs(allHandoffs(site)).slice(0, 8);
  const waiting = waitingHandoffs(allHandoffs(site));

  return {
    counts: {
      projects: projects.length,
      applications: site.appCount,
      running: site.runningCount,
      starting: site.startingCount,
      stopped: site.stoppedCount,
      error: site.errorCount,
      handoffsWaiting: site.pendingCount,
      handoffsTotal: site.handoffCount,
    },
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      rootPath: project.rootPath,
      appCount: project.apps.length,
      waitingCount: handoffCounts(project.handoffs).waiting,
      lastActivity: projectLastActivity(project),
      deleting: project.deleting,
    })),
    recentHandoffs: recent.map((handoff) => ({
      id: handoff.id,
      fromAppId: handoff.fromAppId,
      toAppId: handoff.toAppId,
      fromAppKey: appKeyFor(site, handoff.fromAppId),
      toAppKey: appKeyFor(site, handoff.toAppId),
      summary: handoff.summary,
      state: handoff.state,
      replyState: handoff.replyState,
      updatedAt: handoff.updatedAt,
      reviewHref: reviewHref(handoff),
    })),
    waitingHandoffs: waiting.map((handoff) => ({
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
      reviewHref: "/handoffs?filter=waiting",
    })),
  };
}
