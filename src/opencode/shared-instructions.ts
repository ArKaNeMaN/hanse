import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SharedInstructionEnv {
  XDG_STATE_HOME: string;
}

/** Absolute directory for materialized project-shared instruction files. */
export function sharedInstructionsDir(env: SharedInstructionEnv): string {
  return path.join(env.XDG_STATE_HOME, "hanse", "instructions");
}

/**
 * Copy project-shared instruction sources into the app state and return the container-visible
 * paths. Stale copies are removed so the directory mirrors the current manifest.
 */
export function materializeSharedInstructions(
  env: SharedInstructionEnv,
  sources: readonly string[],
): string[] {
  const directory = sharedInstructionsDir(env);
  rmSync(directory, { recursive: true, force: true });
  if (sources.length === 0) {
    return [];
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  sources.forEach((source, index) => {
    try {
      const content = readFileSync(source);
      const target = path.join(directory, `shared-${String(index).padStart(2, "0")}.md`);
      const temporary = `${target}.tmp-${randomUUID()}`;
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, target);
      written.push(target);
    } catch {
      // Missing or unreadable shared docs are skipped; they must not block launch.
    }
  });
  if (written.length === 0) {
    rmSync(directory, { recursive: true, force: true });
  }
  return written;
}
