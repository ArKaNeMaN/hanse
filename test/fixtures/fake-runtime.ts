import type { AgentRuntimeClient } from "../../src/agent/client.js";
import {
  type ReconcileResponse,
  type RuntimeAppStatus,
  type RuntimeLogs,
  stoppedStatus,
} from "../../src/agent/protocol.js";
import type { AppRuntimeSpec } from "../../src/agent/spec.js";

/** In-memory runtime used by manager/policy tests; never starts a process. */
export class FakeAgentRuntime implements AgentRuntimeClient {
  readonly ensured: AppRuntimeSpec[] = [];
  readonly deleted: string[] = [];
  readonly reconcileCalls: string[][] = [];
  readonly statuses = new Map<string, RuntimeAppStatus>();
  readonly endpoints = new Map<string, string>();

  constructor(
    private readonly endpointFor: (appId: string) => string = () => "http://127.0.0.1:1",
  ) {}

  async ensure(spec: AppRuntimeSpec): Promise<RuntimeAppStatus> {
    this.ensured.push(spec);
    const endpoint = this.endpointFor(spec.appId);
    const status: RuntimeAppStatus = {
      appId: spec.appId,
      endpoint,
      state: "running",
      specHash: spec.specHash,
      version: null,
    };
    this.statuses.set(spec.appId, status);
    this.endpoints.set(spec.appId, endpoint);
    return status;
  }

  async delete(appId: string): Promise<RuntimeAppStatus> {
    this.deleted.push(appId);
    const previous = this.statuses.get(appId);
    this.statuses.delete(appId);
    this.endpoints.delete(appId);
    return previous === undefined
      ? stoppedStatus(appId)
      : { ...previous, endpoint: null, state: "stopped" };
  }

  async status(appId: string): Promise<RuntimeAppStatus | undefined> {
    return this.statuses.get(appId);
  }

  async logs(appId: string): Promise<RuntimeLogs | undefined> {
    return this.statuses.has(appId) ? { appId, logs: "", truncated: false } : undefined;
  }

  async reconcile(appIds: string[]): Promise<ReconcileResponse> {
    this.reconcileCalls.push([...appIds]);
    const desired = new Set(appIds);
    const stopped: string[] = [];
    for (const appId of [...this.statuses.keys()]) {
      if (desired.has(appId)) continue;
      await this.delete(appId);
      stopped.push(appId);
    }
    return { stopped, apps: [...this.statuses.values()] };
  }
}
