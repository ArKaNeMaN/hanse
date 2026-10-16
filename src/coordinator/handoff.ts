import type { HandoffMessage, HandoffQueue, HandoffState } from "./queue.js";
import type { RegisteredApp } from "./registry.js";

/** A request from one application to a sibling application. */
export interface SiblingChangeRequest {
  from: string;
  to: string;
  summary: string;
  spec: string;
  references?: string[];
}

/** A tracked handoff with its current lifecycle state. */
export interface Handoff {
  id: string;
  state: HandoffState;
  request: SiblingChangeRequest;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffService {
  requestSiblingChange(request: SiblingChangeRequest): Promise<Handoff>;
  listApps(): RegisteredApp[];
  handoffStatus(id: string): Promise<Handoff | undefined>;
}

/**
 * In-memory handoff service.
 *
 * TODO(handoff): expose this as thin MCP tools (`request_sibling_change`, `list_apps`,
 * `handoff_status`) over the coordinator queue, gate cross-app writes behind an approval
 * state machine (`queued -> in_progress -> delivered/rejected`), and wake the target
 * application by creating a fresh opencode session (isolated context) seeded with the
 * app's own contract plus the request spec.
 */
export class InMemoryHandoffService implements HandoffService {
  readonly #queue: HandoffQueue;
  readonly #apps: () => RegisteredApp[];
  readonly #handoffs = new Map<string, Handoff>();
  #counter = 0;

  constructor(queue: HandoffQueue, apps: () => RegisteredApp[]) {
    this.#queue = queue;
    this.#apps = apps;
  }

  async requestSiblingChange(request: SiblingChangeRequest): Promise<Handoff> {
    this.#counter += 1;
    const now = new Date().toISOString();
    const handoff: Handoff = {
      id: `handoff-${this.#counter}`,
      state: "queued",
      request,
      createdAt: now,
      updatedAt: now,
    };
    this.#handoffs.set(handoff.id, handoff);
    const message: HandoffMessage = {
      id: handoff.id,
      createdAt: now,
      from: request.from,
      to: request.to,
      kind: "request",
      subject: request.summary,
      body: request.spec,
    };
    await this.#queue.enqueue(message);
    return handoff;
  }

  listApps(): RegisteredApp[] {
    return this.#apps();
  }

  async handoffStatus(id: string): Promise<Handoff | undefined> {
    return this.#handoffs.get(id);
  }
}
