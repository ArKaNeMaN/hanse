/**
 * Handoff helpers shared by the page-prop builders and the legacy renderers.
 *
 * These functions are pure over the rendered data (`Handoff`/`ProjectView` shapes) so the props
 * modules and `dashboard.ts` cannot drift, while staying free of `dashboard.ts` imports.
 */

import type { Handoff, HandoffReplyState, HandoffState } from "../../coordinator/handoff.js";

export type HandoffFilter = "all" | "waiting" | "active" | "closed" | "replies";

export const ACTIVE_HANDOFF_STATES: readonly HandoffState[] = [
  "queued",
  "dispatching",
  "in_progress",
];

export const CLOSED_HANDOFF_STATES: readonly HandoffState[] = [
  "delivered",
  "rejected",
  "failed",
  "expired",
  "cancelled",
];

export interface HandoffCounts {
  readonly all: number;
  readonly waiting: number;
  readonly active: number;
  readonly closed: number;
  readonly replies: number;
}

export interface AppKeySource {
  readonly apps: ReadonlyMap<string, { readonly appKey: string }>;
}

export interface ActivitySource {
  readonly createdAt: string;
  readonly handoffs: readonly { readonly updatedAt: string }[];
}

export interface HandoffCollection {
  readonly projects: readonly { readonly handoffs: readonly Handoff[] }[];
}

export function handoffCounts(handoffs: readonly Handoff[]): HandoffCounts {
  let waiting = 0;
  let active = 0;
  let closed = 0;
  let replies = 0;
  for (const handoff of handoffs) {
    if (handoff.state === "awaiting_approval" || handoff.replyState === "awaiting_approval") {
      waiting += 1;
    }
    if (ACTIVE_HANDOFF_STATES.includes(handoff.state)) {
      active += 1;
    }
    if (CLOSED_HANDOFF_STATES.includes(handoff.state)) {
      closed += 1;
    }
    if (
      handoff.replyState === "waiting_operator" ||
      handoff.replyState === "failed" ||
      handoff.replyState === "awaiting_approval"
    ) {
      replies += 1;
    }
  }
  return { all: handoffs.length, waiting, active, closed, replies };
}

export function appKeyFor(site: AppKeySource, appId: string): string {
  return site.apps.get(appId)?.appKey ?? appId.split(":").pop() ?? appId;
}

export function projectLastActivity(project: ActivitySource): string {
  let latest = project.createdAt;
  for (const handoff of project.handoffs) {
    if (handoff.updatedAt > latest) {
      latest = handoff.updatedAt;
    }
  }
  return latest;
}

export function allHandoffs(site: HandoffCollection): Handoff[] {
  return site.projects.flatMap((project) => project.handoffs);
}

export function sortedHandoffs<T extends { readonly updatedAt: string }>(
  handoffs: readonly T[],
): T[] {
  return [...handoffs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function waitingHandoffs<
  T extends {
    readonly state: HandoffState;
    readonly replyState: HandoffReplyState;
    readonly updatedAt: string;
  },
>(handoffs: readonly T[]): T[] {
  return sortedHandoffs(
    handoffs.filter(
      (handoff) =>
        handoff.state === "awaiting_approval" || handoff.replyState === "awaiting_approval",
    ),
  );
}

export function displayState(handoff: Pick<Handoff, "state" | "replyState">): HandoffState {
  return handoff.replyState === "awaiting_approval" ? "awaiting_approval" : handoff.state;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function parseHandoffFilter(value: string | undefined): HandoffFilter {
  return value === "waiting" || value === "active" || value === "closed" || value === "replies"
    ? value
    : "all";
}

export function filterHref(filter: HandoffFilter, q: string): string {
  const params = new URLSearchParams();
  if (filter !== "all") {
    params.set("filter", filter);
  }
  if (q.length > 0) {
    params.set("q", q);
  }
  const query = params.toString();
  return query.length === 0 ? "/handoffs" : `/handoffs?${query}`;
}

export interface HandoffQuerySource {
  readonly apps: ReadonlyMap<string, { readonly appKey: string; readonly projectName: string }>;
}

export function matchesQuery(
  site: HandoffQuerySource,
  handoff: Pick<Handoff, "id" | "summary" | "fromAppId" | "toAppId">,
  needle: string,
): boolean {
  if (needle.length === 0) {
    return true;
  }
  const from = appKeyFor(site, handoff.fromAppId).toLowerCase();
  const to = appKeyFor(site, handoff.toAppId).toLowerCase();
  const project = site.apps.get(handoff.fromAppId)?.projectName.toLowerCase() ?? "";
  return (
    handoff.id.toLowerCase().includes(needle) ||
    handoff.summary.toLowerCase().includes(needle) ||
    from.includes(needle) ||
    to.includes(needle) ||
    project.includes(needle)
  );
}

export function reviewHref(handoff: Pick<Handoff, "id">, filter: HandoffFilter = "all"): string {
  const params = new URLSearchParams();
  if (filter !== "all") {
    params.set("filter", filter);
  }
  params.set("q", shortId(handoff.id));
  return `/handoffs?${params.toString()}`;
}
