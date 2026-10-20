import os from "node:os";
import path from "node:path";

/** Root for machine-specific state (XDG_STATE_HOME, or ~/.local/state). */
export function defaultStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}

/** Directory holding all coordinator state. */
export function coordinatorStateDir(stateHome: string): string {
  return path.join(stateHome, "hanse");
}

/**
 * Root for per-app agent runtime state (`<projectId>/<appKey>/{home,data,...}`).
 *
 * This is deliberately independent of `HANSE_STATE_HOME`: agent state must never live under the
 * coordinator state directory.
 */
export function agentsHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.HANSE_AGENTS_HOME;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return path.join(os.homedir(), ".local", "state", "hanse-agents");
}

/** Path to the coordinator SQLite database. */
export function coordinatorDbPath(stateHome: string): string {
  return path.join(coordinatorStateDir(stateHome), "coordinator.db");
}

/** Runtime root for a project, keyed by its stable id. */
export function projectRuntimeRoot(stateHome: string, projectId: string): string {
  return path.join(coordinatorStateDir(stateHome), "projects", projectId);
}

/** Path to the secret-store key file (kept outside the ciphertext). */
export function secretKeyPath(stateHome: string): string {
  return path.join(coordinatorStateDir(stateHome), "secret.key");
}
