/**
 * Page props for the handoffs inbox (`/handoffs`).
 *
 * `buildHandoffsProps` is the single assembly used by the legacy `renderHandoffs` and by
 * `GET /api/ui/handoffs`, so the two renderers cannot drift. The `SiteModel` import is type-only,
 * keeping the runtime dependency graph acyclic.
 *
 * No settings, credentials, provider keys, or MCP tokens are read here: the payload is handoff
 * rows, filter state, and the dialog data needed by the SPA decision/reply actions.
 */

import type { Handoff, HandoffReplyState, HandoffState } from "../../coordinator/handoff.js";
import type { SiteModel } from "../dashboard.js";
import { buildProjectHandoffProps, type ProjectHandoffProps } from "./project.js";
import {
  ACTIVE_HANDOFF_STATES,
  allHandoffs,
  appKeyFor,
  CLOSED_HANDOFF_STATES,
  displayState,
  filterHref,
  type HandoffCounts,
  type HandoffFilter,
  handoffCounts,
  matchesQuery,
  parseHandoffFilter,
  shortId,
  sortedHandoffs,
} from "./shared.js";

export interface HandoffFilterProps {
  readonly value: HandoffFilter;
  readonly label: string;
  readonly href: string;
  readonly count: number;
  readonly current: boolean;
}

export interface HandoffInlineDecisionProps {
  readonly action: string;
  readonly approvalKind: "dispatch" | "reply";
  readonly returnTo: string;
}

export interface HandoffRowProps {
  readonly id: string;
  readonly shortId: string;
  readonly fromAppId: string;
  readonly toAppId: string;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly summary: string;
  readonly state: HandoffState;
  readonly replyState: HandoffReplyState;
  readonly displayState: HandoffState;
  readonly updatedAt: string;
  readonly inlineDecision: HandoffInlineDecisionProps | null;
  readonly dialog: ProjectHandoffProps;
}

export interface HandoffsSearchProps {
  readonly action: string;
  readonly filter: HandoffFilter;
  readonly query: string;
  readonly hiddenFilter: HandoffFilter | null;
  readonly placeholder: string;
  readonly clearHref: string | null;
}

export interface HandoffsEmptyStateProps {
  readonly iconName: "branch" | "search";
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly actionHref: string;
}

export interface HandoffsProps {
  readonly counts: HandoffCounts;
  readonly filter: HandoffFilter;
  readonly query: string;
  readonly filters: readonly HandoffFilterProps[];
  readonly search: HandoffsSearchProps;
  /** Clear-search URL used by inline decisions and dialogs. */
  readonly returnTo: string;
  readonly tableTitle: string;
  readonly rows: readonly HandoffRowProps[];
  readonly emptyState: HandoffsEmptyStateProps | null;
}

const FILTER_LABELS: ReadonlyArray<{ value: HandoffFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting" },
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
  { value: "replies", label: "Replies" },
];

function filterMatches(filter: HandoffFilter, handoff: Handoff): boolean {
  if (
    filter === "waiting" &&
    handoff.state !== "awaiting_approval" &&
    handoff.replyState !== "awaiting_approval"
  ) {
    return false;
  }
  if (filter === "active" && !ACTIVE_HANDOFF_STATES.includes(handoff.state)) {
    return false;
  }
  if (filter === "closed" && !CLOSED_HANDOFF_STATES.includes(handoff.state)) {
    return false;
  }
  if (
    filter === "replies" &&
    handoff.replyState !== "waiting_operator" &&
    handoff.replyState !== "failed" &&
    handoff.replyState !== "awaiting_approval"
  ) {
    return false;
  }
  return true;
}

function emptyStateFor(
  filter: HandoffFilter,
  query: string,
  counts: HandoffCounts,
): HandoffsEmptyStateProps {
  const allEmpty = counts.all === 0;
  const title = allEmpty
    ? "No handoffs yet"
    : query.length > 0
      ? "No matching handoffs"
      : filter === "waiting"
        ? "No handoffs waiting"
        : filter === "active"
          ? "No active handoffs"
          : filter === "replies"
            ? "No replies waiting"
            : "No closed handoffs";
  const body = allEmpty
    ? "Handoffs route work between applications. Open a project to create the first one."
    : query.length > 0
      ? `Nothing matches “${query}” in this filter.`
      : filter === "waiting"
        ? "Approval requests arrive here when an agent requires a human decision."
        : filter === "active"
          ? "Queued, dispatching, and in-progress handoffs appear here."
          : filter === "replies"
            ? "Sibling replies that need a source session or an operator decision appear here."
            : "Delivered, rejected, failed, expired, and cancelled handoffs appear here.";
  if (allEmpty) {
    return {
      iconName: "branch",
      title,
      body,
      actionLabel: "Open a project",
      actionHref: "/projects",
    };
  }
  if (query.length > 0) {
    return {
      iconName: "search",
      title,
      body,
      actionLabel: "Clear search",
      actionHref: filterHref(filter, ""),
    };
  }
  return {
    iconName: "search",
    title,
    body,
    actionLabel: "Show all handoffs",
    actionHref: "/handoffs",
  };
}

function tableTitleFor(filter: HandoffFilter): string {
  return filter === "all"
    ? "All handoffs"
    : filter === "waiting"
      ? "Waiting for approval"
      : filter === "active"
        ? "Active handoffs"
        : "Closed handoffs";
}

export function buildHandoffsProps(
  site: SiteModel,
  filterValue?: string,
  q?: string,
): HandoffsProps {
  const filter = parseHandoffFilter(filterValue);
  const query = (q ?? "").trim();
  const needle = query.toLowerCase();
  const counts = handoffCounts(allHandoffs(site));
  const returnTo = filterHref(filter, "");
  const filtered = sortedHandoffs(
    allHandoffs(site).filter(
      (handoff) => filterMatches(filter, handoff) && matchesQuery(site, handoff, needle),
    ),
  );

  const rows: HandoffRowProps[] = filtered.map((handoff) => {
    const inlineDecision =
      handoff.state === "awaiting_approval" || handoff.replyState === "awaiting_approval"
        ? {
            action: `/api/handoffs/${encodeURIComponent(handoff.id)}/decision`,
            approvalKind:
              handoff.replyState === "awaiting_approval"
                ? ("reply" as const)
                : ("dispatch" as const),
            returnTo,
          }
        : null;
    return {
      id: handoff.id,
      shortId: shortId(handoff.id),
      fromAppId: handoff.fromAppId,
      toAppId: handoff.toAppId,
      fromAppKey: appKeyFor(site, handoff.fromAppId),
      toAppKey: appKeyFor(site, handoff.toAppId),
      summary: handoff.summary,
      state: handoff.state,
      replyState: handoff.replyState,
      displayState: displayState(handoff),
      updatedAt: handoff.updatedAt,
      inlineDecision,
      dialog: buildProjectHandoffProps(site, handoff, returnTo),
    };
  });

  const filters = FILTER_LABELS.map(({ value, label }) => ({
    value,
    label,
    href: filterHref(value, query),
    count: counts[value],
    current: filter === value,
  }));

  return {
    counts,
    filter,
    query,
    filters,
    search: {
      action: "/handoffs",
      filter,
      query,
      hiddenFilter: filter === "all" ? null : filter,
      placeholder: "Id, summary, application",
      clearHref: query.length > 0 ? filterHref(filter, "") : null,
    },
    returnTo,
    tableTitle: tableTitleFor(filter),
    rows,
    emptyState: rows.length === 0 ? emptyStateFor(filter, query, counts) : null,
  };
}
