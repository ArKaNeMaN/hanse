/**
 * Client-side process shapes shared by the chat process view, the status vocabulary, and the SSE
 * adapter. These mirror the server `src/store/process.ts` / `/api/apps/:app/process` payloads
 * structurally so page props and stream frames can flow through without a cast.
 */

export type ProcessState = "starting" | "running" | "stopped" | "error";

export type ProcessPhase =
  | "requested"
  | "preparing"
  | "creating"
  | "waiting_ready"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed"
  | "interrupted";

export type ProcessSource = "operator" | "runtime" | "reconciler" | "system";

export interface ProcessError {
  readonly code: string | null;
  readonly message: string | null;
  readonly at: string | null;
}

export interface ProcessCurrent {
  readonly state: ProcessState;
  readonly phase: ProcessPhase | null;
  readonly attemptId: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly error: ProcessError | null;
}

/** Current process plus the newest durable event id (`GET /process` / props). */
export interface ProcessSnapshot extends ProcessCurrent {
  readonly lastEventId: number;
}

export interface ProcessEvent {
  readonly id: number;
  readonly attemptId: string;
  readonly seq: number;
  readonly state: ProcessState;
  readonly phase: ProcessPhase | null;
  readonly source: ProcessSource;
  readonly reason: string | null;
  readonly errorCode: string | null;
  readonly message: string | null;
  readonly createdAt: string;
}

export interface ProcessResponse {
  readonly current: ProcessSnapshot;
  readonly events: readonly ProcessEvent[];
  readonly nextCursor: string | null;
}
