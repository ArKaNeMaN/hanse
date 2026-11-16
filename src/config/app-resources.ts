/**
 * Shared defaults for per-application container resources.
 *
 * The memory default is environment-derived and resolved per call so a coordinator restart with a
 * different `HANSE_APP_MEMORY_MB` changes the effective setting, the settings hash, and the launch
 * fingerprint. CPU and PID limits stay environment-only.
 */

export const DEFAULT_APP_MEMORY_MB = 2048;
export const DEFAULT_APP_CPUS = 2;
export const DEFAULT_APP_PIDS = 512;

/** Settings-schema bounds for the per-application memory limit. */
export const MIN_APP_MEMORY_MB = 128;
export const MAX_APP_MEMORY_MB = 65536;

export function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let warnedInvalidMemory = false;

/**
 * Normalize `HANSE_APP_MEMORY_MB` to an integer within the settings bounds. Non-finite,
 * fractional, and out-of-range values fall back to the default with one process-wide warning
 * so every settings resolve does not repeat it.
 */
export function defaultAppMemoryMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HANSE_APP_MEMORY_MB;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_APP_MEMORY_MB;
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_APP_MEMORY_MB ||
    value > MAX_APP_MEMORY_MB
  ) {
    if (!warnedInvalidMemory) {
      warnedInvalidMemory = true;
      console.warn(
        `invalid HANSE_APP_MEMORY_MB=${JSON.stringify(raw)}; falling back to ${DEFAULT_APP_MEMORY_MB} MB`,
      );
    }
    return DEFAULT_APP_MEMORY_MB;
  }
  return value;
}
