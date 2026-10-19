import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Reconcile the per-instance opencode auth file with the merged snapshot.
 *
 * The caller supplies the final merged auth; this module never reads or merges host auth. An empty
 * snapshot removes the file so a revoked key cannot survive from a previous launch.
 */
export function writeAuthFile(authFile: string, auth: Record<string, unknown>): void {
  if (Object.keys(auth).length === 0) {
    rmSync(authFile, { force: true });
    return;
  }
  const directory = path.dirname(authFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(authFile)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(auth), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, authFile);
    chmodSync(authFile, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
