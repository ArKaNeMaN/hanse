import type { SqliteDatabase } from "../store/index.js";
import { getCredential } from "./store.js";

export interface GitCredentialResult {
  found: boolean;
  output: string;
}

export function parseGitCredentialInput(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) {
      fields[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return fields;
}

/**
 * Answer a git credential request. Returns git's `key=value` output for the requested host, or an
 * empty result when no credential is stored. Credentials never leave this process except to git.
 */
export function handleGitCredential(
  db: SqliteDatabase,
  key: Buffer,
  input: string,
): GitCredentialResult {
  const fields = parseGitCredentialInput(input);
  const host = fields.host;
  if (host === undefined) {
    return { found: false, output: "" };
  }
  const credential = getCredential(db, key, host);
  if (credential === undefined) {
    return { found: false, output: "" };
  }
  return {
    found: true,
    output: `username=${credential.username}\npassword=${credential.token}\n`,
  };
}
