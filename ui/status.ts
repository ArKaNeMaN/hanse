/**
 * Client-side status vocabulary.
 *
 * Mirrors the `statusPill`/`replyPill`/`runtimePill` primitives in `src/http/ui.ts` without
 * importing server code. The shapes are structural so page props typed on the server can be passed
 * straight through.
 */

import type { ProcessPhase } from "./process/types.js";

export type HandoffState =
  | "queued"
  | "awaiting_approval"
  | "dispatching"
  | "in_progress"
  | "delivered"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export type HandoffReplyState =
  | "none"
  | "pending"
  | "awaiting_approval"
  | "delivered"
  | "waiting_operator"
  | "failed"
  | "cancelled";

export type RuntimeState = "starting" | "running" | "stopped" | "error";

export interface PillSpec {
  readonly variant: "status" | "badge";
  /** `data-state` value for `.status` pills; absent for `.badge` reply pills. */
  readonly dataState?: string;
  readonly icon: string;
  readonly label: string;
}

const STATUS: Record<HandoffState, PillSpec> = {
  queued: { variant: "status", dataState: "queued", icon: "clock", label: "Queued" },
  awaiting_approval: {
    variant: "status",
    dataState: "awaiting_approval",
    icon: "stamp",
    label: "Awaiting approval",
  },
  dispatching: {
    variant: "status",
    dataState: "dispatching",
    icon: "send",
    label: "Dispatching",
  },
  in_progress: {
    variant: "status",
    dataState: "in_progress",
    icon: "activity",
    label: "In progress",
  },
  delivered: { variant: "status", dataState: "delivered", icon: "check", label: "Delivered" },
  rejected: { variant: "status", dataState: "rejected", icon: "x", label: "Rejected" },
  failed: { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Failed" },
  expired: { variant: "status", dataState: "expired", icon: "hourglass", label: "Expired" },
  cancelled: { variant: "status", dataState: "cancelled", icon: "slash", label: "Cancelled" },
};

const REPLY_STATUS: Record<HandoffReplyState, PillSpec | null> = {
  none: null,
  pending: { variant: "badge", icon: "clock", label: "Reply queued" },
  awaiting_approval: { variant: "badge", icon: "stamp", label: "Reply approval" },
  delivered: { variant: "badge", icon: "check", label: "Reply delivered" },
  waiting_operator: { variant: "badge", icon: "inbox", label: "Reply waiting" },
  failed: { variant: "badge", icon: "alert-triangle", label: "Reply failed" },
  cancelled: { variant: "badge", icon: "slash", label: "Reply cancelled" },
};

export function statusPill(state: HandoffState): PillSpec {
  return STATUS[state];
}

export function replyPill(state: HandoffReplyState): PillSpec | undefined {
  return REPLY_STATUS[state] ?? undefined;
}

export function runtimePill(state: RuntimeState): PillSpec {
  if (state === "starting") {
    return { variant: "status", dataState: "dispatching", icon: "loader", label: "Starting" };
  }
  if (state === "running") {
    return { variant: "status", dataState: "in_progress", icon: "activity", label: "Running" };
  }
  if (state === "error") {
    return { variant: "status", dataState: "failed", icon: "alert-triangle", label: "Error" };
  }
  return { variant: "status", dataState: "queued", icon: "clock", label: "Stopped" };
}

/**
 * Phase vocabulary for the process panels. The coarse runtime states stay `starting | running |
 * stopped | error`; the phase only labels what the attempt is doing inside them.
 */
const PROCESS_PHASE: Record<
  ProcessPhase,
  { readonly label: string; readonly dataState: string; readonly icon: string }
> = {
  requested: { label: "Requested", dataState: "queued", icon: "clock" },
  preparing: { label: "Preparing", dataState: "dispatching", icon: "loader" },
  creating: { label: "Creating", dataState: "dispatching", icon: "loader" },
  waiting_ready: { label: "Waiting for readiness", dataState: "dispatching", icon: "loader" },
  ready: { label: "Ready", dataState: "in_progress", icon: "activity" },
  stopping: { label: "Stopping", dataState: "dispatching", icon: "loader" },
  stopped: { label: "Stopped", dataState: "queued", icon: "clock" },
  failed: { label: "Failed", dataState: "failed", icon: "alert-triangle" },
  interrupted: { label: "Interrupted", dataState: "failed", icon: "alert-triangle" },
};

export function processPhaseLabel(phase: ProcessPhase | null | undefined): string {
  if (phase === null || phase === undefined) {
    return "Starting";
  }
  return PROCESS_PHASE[phase].label;
}

/** Phase pill, or `undefined` when the server did not persist a phase (legacy rows). */
export function processPhasePill(phase: ProcessPhase | null | undefined): PillSpec | undefined {
  if (phase === null || phase === undefined) {
    return undefined;
  }
  const spec = PROCESS_PHASE[phase];
  return {
    variant: "status",
    dataState: spec.dataState,
    icon: spec.icon,
    label: spec.label,
  };
}

/** Status pill for a process snapshot, preferring the phase over the coarse runtime state. */
export function processPill(state: RuntimeState, phase?: ProcessPhase | null): PillSpec {
  return processPhasePill(phase ?? null) ?? runtimePill(state);
}
