/** Kind of a structured cross-app message. */
export type HandoffKind = "request" | "response" | "note";

/** Lifecycle state of a handoff. */
export type HandoffState = "queued" | "in_progress" | "delivered" | "rejected";

/** A structured cross-app handoff message (spec, requirement, or answer). */
export interface HandoffMessage {
  id: string;
  createdAt: string;
  from: string;
  to: string;
  kind: HandoffKind;
  subject: string;
  body: string;
  correlationId?: string;
}

export interface HandoffQueue {
  enqueue(message: HandoffMessage): Promise<void>;
  dequeue(app: string): Promise<HandoffMessage | undefined>;
  list(app: string): Promise<HandoffMessage[]>;
}

/**
 * In-memory queue.
 * TODO(persistence): back this by a durable queue (SQLite) under the runtime root so handoffs
 * survive restarts and so the user's own messages can share the same ingress.
 */
export class InMemoryHandoffQueue implements HandoffQueue {
  readonly #byApp = new Map<string, HandoffMessage[]>();

  async enqueue(message: HandoffMessage): Promise<void> {
    const list = this.#byApp.get(message.to) ?? [];
    list.push(message);
    this.#byApp.set(message.to, list);
  }

  async dequeue(app: string): Promise<HandoffMessage | undefined> {
    return this.#byApp.get(app)?.shift();
  }

  async list(app: string): Promise<HandoffMessage[]> {
    return [...(this.#byApp.get(app) ?? [])];
  }
}
