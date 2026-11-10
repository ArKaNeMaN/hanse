import type { Logger } from "../logging/logger.js";
import type { DrainController, WalCheckpoint } from "./drain.js";

export interface ShutdownServer {
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export interface GracefulShutdownOptions {
  drain: DrainController;
  server: ShutdownServer;
  closeDb: () => void;
  graceMs: number;
  stopBackground?: () => void | Promise<void>;
  onClose?: () => void;
  logger?: Logger;
  now?: () => number;
}

export interface GracefulShutdownResult {
  drained: boolean;
  checkpoint: WalCheckpoint;
  elapsedMs: number;
}

const SHUTDOWN_RESERVE_MS = 500;

export async function runGracefulShutdown(
  options: GracefulShutdownOptions,
): Promise<GracefulShutdownResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const log = (phase: string, fields: Record<string, unknown> = {}): void => {
    options.logger?.info("shutdown_phase", {
      phase,
      elapsedMs: now() - started,
      ...fields,
    });
  };

  options.drain.beginShutdown();
  log("readiness_false", { shutdownAt: options.drain.shutdownAt });

  try {
    options.server.close(() => undefined);
  } catch {
    // A server that already closed still lets the remaining phases run.
  }
  options.server.closeIdleConnections?.();
  log("stop_accepting");

  const stopStarted = now();
  try {
    await options.stopBackground?.();
  } catch (error) {
    options.logger?.warn("shutdown_background_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const stopElapsedMs = now() - stopStarted;
  log("background_stopped", { stopElapsedMs });

  const drained = await options.drain.awaitQuiescence(
    Math.max(0, options.graceMs - SHUTDOWN_RESERVE_MS - stopElapsedMs),
  );
  log("drained", { drained, inFlightHttp: options.drain.inFlightHttp });

  const checkpoint = options.drain.checkpoint();
  log("wal_checkpoint", { ...checkpoint });

  options.server.closeAllConnections?.();
  options.onClose?.();
  try {
    options.closeDb();
  } catch {
    // A database already closed by the caller must not turn a clean exit into a failure.
  }
  log("closed");
  return { drained, checkpoint, elapsedMs: now() - started };
}

export function shutdownGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.HANSE_SHUTDOWN_GRACE_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 25_000;
  }
  return Math.min(28_000, Math.max(1_000, Math.floor(parsed)));
}

export function startDrainedFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.HANSE_START_DRAINED?.trim() ?? "");
}
