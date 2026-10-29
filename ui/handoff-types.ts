/**
 * Structural mirror of `src/http/props/handoffs.ts` for the client.
 *
 * `GET /api/ui/handoffs` and the boot payload share this shape; keeping the mirror in the client
 * avoids importing server code into the Vite bundle while still typing the inbox page.
 */

import type { BootChrome } from "./boot.js";
import type { ProjectHandoff } from "./project-types.js";

export type HandoffFilter = "all" | "waiting" | "active" | "closed" | "replies";

export interface HandoffCounts {
  readonly all: number;
  readonly waiting: number;
  readonly active: number;
  readonly closed: number;
  readonly replies: number;
}

export interface HandoffFilterEntry {
  readonly value: HandoffFilter;
  readonly label: string;
  readonly href: string;
  readonly count: number;
  readonly current: boolean;
}

export interface HandoffInlineDecision {
  readonly action: string;
  readonly approvalKind: "dispatch" | "reply";
  readonly returnTo: string;
}

export interface HandoffRow {
  readonly id: string;
  readonly shortId: string;
  readonly fromAppId: string;
  readonly toAppId: string;
  readonly fromAppKey: string;
  readonly toAppKey: string;
  readonly summary: string;
  readonly state: ProjectHandoff["state"];
  readonly replyState: ProjectHandoff["replyState"];
  readonly displayState: ProjectHandoff["displayState"];
  readonly updatedAt: string;
  readonly inlineDecision: HandoffInlineDecision | null;
  readonly dialog: ProjectHandoff;
}

export interface HandoffsSearch {
  readonly action: string;
  readonly filter: HandoffFilter;
  readonly query: string;
  readonly hiddenFilter: HandoffFilter | null;
  readonly placeholder: string;
  readonly clearHref: string | null;
}

export interface HandoffsEmptyState {
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
  readonly filters: readonly HandoffFilterEntry[];
  readonly search: HandoffsSearch;
  readonly returnTo: string;
  readonly tableTitle: string;
  readonly rows: readonly HandoffRow[];
  readonly emptyState: HandoffsEmptyState | null;
}

export interface HandoffsResponse extends HandoffsProps {
  readonly chrome?: BootChrome;
}
