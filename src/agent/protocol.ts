import type { AppRuntimeSpec } from "./spec.js";

/** Lifecycle states reported by the runtime backend (supervisor in B0, runner in B1/B2). */
export type RuntimeAppState = "starting" | "running" | "stopped" | "error";

/** Version handshake returned for one application host. */
export interface RuntimeVersion {
  hanseVersion: string;
  opencodeVersion: string | null;
  specHash: string;
}

/** Effective status of one application, returned by every mutating runtime endpoint. */
export interface RuntimeAppStatus {
  appId: string;
  endpoint: string | null;
  state: RuntimeAppState;
  specHash: string | null;
  version: RuntimeVersion | null;
  containerId?: string | null;
  containerName?: string | null;
  error?: string;
}

/** Effective status for a host that has never been started. */
export function stoppedStatus(appId: string): RuntimeAppStatus {
  return { appId, endpoint: null, state: "stopped", specHash: null, version: null };
}

/** Request body for `POST /v1/apps/:appId/ensure`. */
export type EnsureAppRequest = AppRuntimeSpec;

/** Response body for `GET /v1/apps/:appId/logs`. */
export interface RuntimeLogs {
  appId: string;
  logs: string;
  truncated: boolean;
}

/** Request body for `POST /v1/reconcile`: the app ids that should keep running. */
export interface ReconcileRequest {
  appIds: string[];
}

/** Response body for `POST /v1/reconcile`. */
export interface ReconcileResponse {
  stopped: string[];
  apps: RuntimeAppStatus[];
}

/** Response body for `GET /healthz` (unauthenticated). */
export interface RuntimeHealth {
  ok: true;
  hanseVersion: string;
  apps: number;
}

/** Error response body shared by every runtime endpoint. */
export interface RuntimeErrorBody {
  error: string;
  code?: string;
  root?: string;
}

/** Status file written by the agent host under `<stateDir>/runtime/host-status.json`. */
export interface HostStatusPayload {
  hanseVersion: string;
  opencodeVersion: string | null;
  specHash: string;
  state: RuntimeAppState;
  pid: number | null;
  port: number;
  startedAt: string;
}
