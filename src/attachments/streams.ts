/** Per-app browser-stream slots and active-sender priority markers (design §D5). */
export const MAX_APP_STREAMS = 8;

interface AppStreamState {
  browser: number;
  active: Map<string, number>;
}

export class AppStreamRegistry {
  readonly #max: number;
  readonly #activeTtlMs: number;
  readonly #apps = new Map<string, AppStreamState>();

  constructor(max = MAX_APP_STREAMS, activeTtlMs = 2 * 60 * 1000) {
    this.#max = max;
    this.#activeTtlMs = activeTtlMs;
  }

  #state(appId: string): AppStreamState {
    const existing = this.#apps.get(appId);
    if (existing !== undefined) return existing;
    const created: AppStreamState = { browser: 0, active: new Map() };
    this.#apps.set(appId, created);
    return created;
  }

  /** Reserve one client-facing browser slot; internal monitor/fallback streams do not use this. */
  acquireBrowser(appId: string): (() => void) | undefined {
    const state = this.#state(appId);
    if (state.browser >= this.#max) return undefined;
    state.browser += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.browser = Math.max(0, state.browser - 1);
      this.#prune(appId);
    };
  }

  browserCount(appId: string): number {
    return this.#apps.get(appId)?.browser ?? 0;
  }

  /** A send route registers the client's app-stream id for priority admission. */
  registerActive(appId: string, streamID: string | undefined, now = Date.now()): void {
    if (streamID === undefined || streamID.length === 0 || streamID.length > 200) return;
    const state = this.#state(appId);
    this.#pruneActive(state, now);
    state.active.set(streamID, now);
  }

  isActive(appId: string, streamID: string, now = Date.now()): boolean {
    const state = this.#apps.get(appId);
    if (state === undefined) return false;
    this.#pruneActive(state, now);
    const at = state.active.get(streamID);
    if (at === undefined) return false;
    if (now - at > this.#activeTtlMs) {
      state.active.delete(streamID);
      return false;
    }
    return true;
  }

  /** Test-only visibility into the tracked active ids for one app. */
  activeEntryCountForTests(appId: string): number {
    return this.#apps.get(appId)?.active.size ?? 0;
  }

  resetForTests(): void {
    this.#apps.clear();
  }

  #pruneActive(state: AppStreamState, now: number): void {
    for (const [streamID, at] of state.active) {
      if (now - at > this.#activeTtlMs) state.active.delete(streamID);
    }
  }

  #prune(appId: string): void {
    const state = this.#apps.get(appId);
    if (state === undefined) return;
    this.#pruneActive(state, Date.now());
    if (state.browser === 0 && state.active.size === 0) this.#apps.delete(appId);
  }
}

export const appStreams = new AppStreamRegistry();
