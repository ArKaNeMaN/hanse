import {
  MAX_CONCURRENT_AGENT_IMAGES_PER_APP,
  MAX_GLOBAL_INFLIGHT_AGENT_IMAGE_BYTES,
} from "./types.js";

/** Agent-media ids with an in-memory copy; reconcile must not touch them. */
export const activeAgentMediaIds = new Set<string>();

interface InflightApp {
  count: number;
  bytes: number;
}

export class AgentMediaAdmission {
  readonly #apps = new Map<string, InflightApp>();
  #bytes = 0;

  reserve(appId: string, bytes: number): boolean {
    const current = this.#apps.get(appId) ?? { count: 0, bytes: 0 };
    if (current.count >= MAX_CONCURRENT_AGENT_IMAGES_PER_APP) return false;
    if (this.#bytes + bytes > MAX_GLOBAL_INFLIGHT_AGENT_IMAGE_BYTES) return false;
    current.count += 1;
    current.bytes += bytes;
    this.#apps.set(appId, current);
    this.#bytes += bytes;
    return true;
  }

  release(appId: string, bytes: number): void {
    const current = this.#apps.get(appId);
    if (current === undefined) return;
    current.count = Math.max(0, current.count - 1);
    current.bytes = Math.max(0, current.bytes - bytes);
    this.#bytes = Math.max(0, this.#bytes - bytes);
    if (current.count === 0) this.#apps.delete(appId);
  }

  resetForTests(): void {
    this.#apps.clear();
    this.#bytes = 0;
  }
}

export const agentMediaAdmission = new AgentMediaAdmission();
