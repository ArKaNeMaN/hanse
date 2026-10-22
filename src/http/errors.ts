import { DeploymentInProgressError } from "../coordinator/deployment-lock.js";
import { AgentTokenReconcileError, RestartInProgressError } from "../opencode/manager.js";
import type { HttpResponse } from "./handler.js";

export interface MappedHttpError {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * Map a typed deployment/lifecycle error to its exact HTTP contract.
 *
 * Returns `undefined` for errors the caller should handle itself. Every route that can reach a
 * deployment guard, a restart claim, or token reconciliation uses this helper so the bodies and
 * `Retry-After` header stay identical across JSON and browser form posts.
 */
export function mapLifecycleHttpError(error: unknown): MappedHttpError | undefined {
  if (error instanceof DeploymentInProgressError) {
    return {
      status: 409,
      body: {
        error: "deployment_in_progress",
        message: `deployment in progress: ${error.phase ?? error.operation}`,
        retryAfter: 30,
      },
      headers: { "retry-after": "30" },
    };
  }
  if (error instanceof RestartInProgressError) {
    return { status: 409, body: { error: "restart_in_progress" } };
  }
  if (error instanceof AgentTokenReconcileError) {
    return { status: 500, body: { error: "agent_token_reconcile_failed" } };
  }
  return undefined;
}

/** Convert a typed lifecycle error to a ready HTTP response, or `undefined` when unmapped. */
export function lifecycleErrorResponse(error: unknown): HttpResponse | undefined {
  const mapped = mapLifecycleHttpError(error);
  if (mapped === undefined) {
    return undefined;
  }
  return {
    status: mapped.status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(mapped.body),
    ...(mapped.headers === undefined ? {} : { headers: mapped.headers }),
  };
}
