import type { SqliteDatabase } from "../store/index.js";
import { open, seal } from "./crypto.js";

export interface Credential {
  host: string;
  username: string;
  token: string;
}

interface CredentialRow {
  host: string;
  username: string;
  cipher: string;
  nonce: string;
}

export function putCredential(db: SqliteDatabase, key: Buffer, credential: Credential): void {
  const sealed = seal(key, credential.token);
  db.prepare(
    `INSERT INTO secrets (host, username, cipher, nonce, created_at)
     VALUES (@host, @username, @cipher, @nonce, @created_at)
     ON CONFLICT(host) DO UPDATE SET
       username = excluded.username, cipher = excluded.cipher, nonce = excluded.nonce`,
  ).run({
    host: credential.host,
    username: credential.username,
    cipher: sealed.cipher,
    nonce: sealed.nonce,
    created_at: new Date().toISOString(),
  });
}

export function getCredential(
  db: SqliteDatabase,
  key: Buffer,
  host: string,
): Credential | undefined {
  const row = db.prepare("SELECT * FROM secrets WHERE host = ?").get(host) as
    | CredentialRow
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  return { host: row.host, username: row.username, token: open(key, row) };
}

export function listCredentialHosts(db: SqliteDatabase): string[] {
  return (db.prepare("SELECT host FROM secrets ORDER BY host").all() as { host: string }[]).map(
    (row) => row.host,
  );
}
