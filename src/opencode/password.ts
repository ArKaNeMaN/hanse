import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** File name of the per-app opencode server password under `XDG_STATE_HOME`. */
export const OPENCODE_PASSWORD_FILENAME = "opencode-password";

/** Path of the per-app opencode server password file. */
export function opencodePasswordPath(stateDir: string): string {
  return path.join(stateDir, OPENCODE_PASSWORD_FILENAME);
}

/** Read the existing password, or `undefined` when the file is missing or empty. */
export function readOpencodePassword(file: string): string | undefined {
  try {
    const password = readFileSync(file, "utf8").trim();
    return password.length === 0 ? undefined : password;
  } catch {
    return undefined;
  }
}

/**
 * Reuse the per-app password or mint a new random one, writing it atomically with mode 0600.
 *
 * The supervisor host reads this file and exports `OPENCODE_SERVER_PASSWORD` to `opencode serve`; the
 * coordinator registers the same value as the endpoint's Basic authorization.
 */
export function ensureOpencodePassword(file: string): string {
  const existing = readOpencodePassword(file);
  if (existing !== undefined) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // The file is readable; a metadata change is not worth failing a healthy instance.
    }
    return existing;
  }

  const password = randomBytes(32).toString("base64url");
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${password}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return password;
}
