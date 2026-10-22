import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** On-disk deployment lock written by the external orchestrator, read-only for the coordinator. */
export interface DeploymentLockState {
  version: 1;
  id: string;
  phase: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type DeploymentLockStatus =
  | { active: false; state?: undefined; reason?: "missing" | "stale" | "malformed" }
  | { active: true; state?: DeploymentLockState; reason?: "malformed" };

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

/**
 * Thrown by {@link DeploymentLock.assertUnlocked} and lifecycle entry points when an active
 * deployment lock forbids a destructive operation. HTTP callers map it to 409.
 */
export class DeploymentInProgressError extends Error {
  readonly code = "deployment_in_progress";
  readonly status = 409;
  readonly operation: string;
  readonly phase?: string;
  readonly staleAt?: string;

  constructor(operation: string, options: { phase?: string; staleAt?: string } = {}) {
    super(`deployment in progress: ${options.phase ?? operation}`);
    this.name = "DeploymentInProgressError";
    this.operation = operation;
    this.phase = options.phase;
    this.staleAt = options.staleAt;
  }
}

/**
 * Read-only view of the external deployment lock.
 *
 * The file is advisory: it is written and repaired by the external orchestrator, never by the
 * coordinator. `status()` fails closed on any read error other than `ENOENT` and treats an
 * unparseable file as active until its mtime is older than the stale window.
 */
export class DeploymentLock {
  readonly #path: string;
  readonly #staleAfterMs: number;
  readonly #now: () => number;
  #lastLoggedKey: string | undefined;

  constructor(path: string, options: { staleAfterMs?: number; now?: () => number } = {}) {
    this.#path = path;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#now = options.now ?? Date.now;
  }

  status(): DeploymentLockStatus {
    let raw: string;
    try {
      raw = readFileSync(this.#path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return { active: false, reason: "missing" };
      }
      this.#log("unreadable", "unreadable; treating as active");
      return { active: true, reason: "malformed" };
    }

    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(this.#path).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }

    const parsed = parseLock(raw);
    if (parsed === undefined) {
      if (mtimeMs === undefined || this.#now() - mtimeMs <= this.#staleAfterMs) {
        this.#log("malformed-active", "malformed; treating as active");
        return { active: true, reason: "malformed" };
      }
      this.#log("malformed-stale", "malformed and older than the stale window; ignoring");
      return { active: false, reason: "malformed" };
    }

    if (parsed.phase !== undefined && !KNOWN_PHASES.has(parsed.phase)) {
      this.#log(`unknown-phase:${parsed.phase}`, `unknown phase "${parsed.phase}"; accepting`);
    }

    const updatedMs = Date.parse(parsed.updatedAt);
    const expiresMs = Math.min(Date.parse(parsed.expiresAt), updatedMs + MAX_LIFETIME_MS);
    const now = this.#now();
    if (now - updatedMs > this.#staleAfterMs || now > expiresMs) {
      this.#log(`stale:${parsed.id}`, "stale; ignoring");
      return { active: false, reason: "stale" };
    }

    const state: DeploymentLockState = {
      ...parsed,
      expiresAt: new Date(expiresMs).toISOString(),
    };
    return { active: true, state };
  }

  isActive(): boolean {
    return this.status().active;
  }

  assertUnlocked(operation: string): void {
    const status = this.status();
    if (!status.active) {
      return;
    }
    throw new DeploymentInProgressError(operation, {
      ...(status.state?.phase === undefined ? {} : { phase: status.state.phase }),
      ...(status.state?.expiresAt === undefined ? {} : { staleAt: status.state.expiresAt }),
    });
  }

  #log(key: string, message: string): void {
    if (this.#lastLoggedKey === key) {
      return;
    }
    this.#lastLoggedKey = key;
    process.stderr.write(`[deploy-lock] ${message}\n`);
  }
}

/** Resolve the configured lock path; `HANSE_DEPLOY_LOCK_FILE` must be absolute when set. */
export function deploymentLockPath(
  stateHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.HANSE_DEPLOY_LOCK_FILE?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!path.isAbsolute(configured)) {
      throw new Error("HANSE_DEPLOY_LOCK_FILE must be an absolute path");
    }
    return configured;
  }
  return path.join(stateHome, "hanse", "deploy.lock");
}

const KNOWN_PHASES = new Set([
  "preparing",
  "backing_up",
  "pulling",
  "switching",
  "health_checking",
  "rolling_back",
]);

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseLock(raw: string): DeploymentLockState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    record.id.trim().length === 0 ||
    typeof record.phase !== "string" ||
    record.phase.trim().length === 0 ||
    !isoTimestamp(record.startedAt) ||
    !isoTimestamp(record.updatedAt) ||
    !isoTimestamp(record.expiresAt)
  ) {
    return undefined;
  }
  if (Date.parse(record.expiresAt) < Date.parse(record.updatedAt)) {
    return undefined;
  }
  return {
    version: 1,
    id: record.id,
    phase: record.phase,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
}
