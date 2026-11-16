import type { RuntimeOomEvent } from "../agent/protocol.js";
import type { DockerContainerInspect, DockerEvent } from "./docker.js";

const MAX_EVENTS = 256;
const RING_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const OOM_FILTER: Readonly<Record<string, string[]>> = {
  type: ["container"],
  event: ["oom"],
  label: ["hanse.managed=true"],
};

/** The narrow Docker capability the event tracker needs. */
export interface ContainerEventDocker {
  streamEvents(filter: Record<string, string[]>, signal?: AbortSignal): AsyncIterable<string>;
  inspectContainer(idOrName: string): Promise<DockerContainerInspect | undefined>;
}

export interface ContainerEventTrackerOptions {
  docker: ContainerEventDocker;
  /** Injectable clock for tests and ring pruning. */
  now?: () => number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

interface TrackedOomEvent {
  appId: string;
  at: string;
  atMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventTimeMs(event: DockerEvent, fallback: number): number {
  if (typeof event.time === "number" && Number.isFinite(event.time) && event.time > 0) {
    return Math.floor(event.time * 1000);
  }
  if (typeof event.timeNano === "number" && Number.isFinite(event.timeNano) && event.timeNano > 0) {
    return Math.floor(event.timeNano / 1_000_000);
  }
  return fallback;
}

/**
 * Best-effort in-memory ring of Docker OOM events for the runner's per-app status handler.
 *
 * The ring survives reconnects, but a runner or Docker daemon restart loses the events it held; the
 * coordinator's crashed-container branch remains the durable fallback.
 */
export class ContainerEventTracker {
  readonly #docker: ContainerEventDocker;
  readonly #now: () => number;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #events: TrackedOomEvent[] = [];
  #controller: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ContainerEventTrackerOptions) {
    this.#docker = options.docker;
    this.#now = options.now ?? Date.now;
    this.#initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  start(): void {
    if (this.#controller !== undefined) return;
    const controller = new AbortController();
    this.#controller = controller;
    void this.#run(controller.signal);
  }

  stop(): void {
    const controller = this.#controller;
    this.#controller = undefined;
    this.#clearTimer();
    controller?.abort();
  }

  /** Events for one app strictly newer than `since`; the ring is never drained. */
  eventsFor(appId: string, since?: string): RuntimeOomEvent[] {
    const now = this.#now();
    this.#prune(now);
    const defaultSince = now - RING_WINDOW_MS;
    const parsed = since === undefined ? Number.NaN : Date.parse(since);
    const sinceMs = Number.isFinite(parsed) ? parsed : defaultSince;
    const cutoff = now - RING_WINDOW_MS;
    return this.#events
      .filter((event) => event.appId === appId && event.atMs > sinceMs && event.atMs >= cutoff)
      .map((event) => ({ appId: event.appId, at: event.at }));
  }

  async #run(signal: AbortSignal): Promise<void> {
    let backoff = this.#initialBackoffMs;
    while (!signal.aborted) {
      try {
        for await (const line of this.#docker.streamEvents(
          Object.fromEntries(Object.entries(OOM_FILTER).map(([key, value]) => [key, [...value]])),
          signal,
        )) {
          if (signal.aborted) break;
          backoff = this.#initialBackoffMs;
          await this.#handleLine(line, signal);
        }
      } catch {
        // A closed or timed-out stream is the normal reconnect path.
      }
      if (signal.aborted) break;
      await this.#sleep(backoff, signal);
      if (signal.aborted) break;
      backoff = Math.min(backoff * 2, this.#maxBackoffMs);
    }
    if (this.#controller?.signal === signal) {
      this.#controller = undefined;
    }
  }

  async #handleLine(line: string, signal: AbortSignal): Promise<void> {
    let event: DockerEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      event = parsed;
    } catch {
      return;
    }
    if (event.Type !== undefined && event.Type !== "container") return;
    if ((event.Action ?? event.status) !== "oom") return;
    const atMs = eventTimeMs(event, this.#now());
    const actor = isRecord(event.Actor) ? event.Actor : undefined;
    const attributes = isRecord(actor?.Attributes) ? actor.Attributes : undefined;
    const containerId = typeof actor?.ID === "string" && actor.ID.length > 0 ? actor.ID : undefined;
    let appId =
      typeof attributes?.["hanse.app.id"] === "string" ? attributes["hanse.app.id"] : undefined;
    if ((appId === undefined || appId.length === 0) && containerId !== undefined) {
      const inspect = await this.#docker.inspectContainer(containerId).catch(() => undefined);
      const label = inspect?.Config?.Labels?.["hanse.app.id"];
      if (typeof label === "string" && label.length > 0) appId = label;
    }
    if (appId === undefined || appId.length === 0 || signal.aborted) return;
    this.#events.push({ appId, at: new Date(atMs).toISOString(), atMs });
    this.#prune(this.#now());
  }

  #prune(now: number): void {
    while (this.#events.length > MAX_EVENTS) this.#events.shift();
    const cutoff = now - RING_WINDOW_MS;
    while (this.#events.length > 0 && (this.#events[0]?.atMs ?? 0) < cutoff) {
      this.#events.shift();
    }
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        this.#clearTimer();
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.#timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
