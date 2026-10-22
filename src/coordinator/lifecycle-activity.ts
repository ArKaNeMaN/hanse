/**
 * Process-local count of lifecycle operations that can mutate a managed container or image.
 *
 * `/readyz` exposes the count so the external orchestrator can wait for quiescence before switching
 * images. Fast reconnect, reads, and the separate `hanse images` CLI are intentionally excluded.
 */
export class LifecycleActivity {
  #count = 0;

  /** Increment the count and return an idempotent callback that decrements it. */
  begin(_operation: string): () => void {
    this.#count += 1;
    let ended = false;
    return (): void => {
      if (ended) {
        return;
      }
      ended = true;
      this.#count = Math.max(0, this.#count - 1);
    };
  }

  get count(): number {
    return this.#count;
  }
}
