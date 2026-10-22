import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sanitizeAppKey } from "../opencode/instance.js";
import type { SqliteDatabase } from "../store/index.js";

/** Per-app MCP token identity resolved from `agent_tokens`. */
export interface AgentTokenIdentity {
  appId: string;
  projectId: string;
  appKey: string;
}

interface AgentTokenRow {
  id: string;
  app_id: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
}

/** Hash a plaintext agent token for storage. Only the hash is persisted. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Revoke every active token for an app. */
export function revokeAgentToken(db: SqliteDatabase, appId: string): void {
  db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL").run(
    new Date().toISOString(),
    appId,
  );
}

function activeTokenRow(db: SqliteDatabase, appId: string): AgentTokenRow | undefined {
  return db
    .prepare(
      "SELECT * FROM agent_tokens WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(appId) as AgentTokenRow | undefined;
}

/**
 * Mint a new token for an app, revoking the previous active token first.
 *
 * The revoke and the insert share one `better-sqlite3` transaction so a failed insert cannot leave
 * the app without its previous token.
 */
export function mintAgentToken(db: SqliteDatabase, appId: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  db.transaction(() => {
    revokeAgentToken(db, appId);
    db.prepare(
      "INSERT INTO agent_tokens (id, app_id, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
    ).run(randomUUID(), appId, hashAgentToken(token), now);
  })();
  return token;
}

function readTokenFile(tokenFile: string): string | undefined {
  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    return token.length === 0 ? undefined : token;
  } catch {
    return undefined;
  }
}

/** True when the token file exists and matches the app's active token hash. */
export function agentTokenMatches(db: SqliteDatabase, appId: string, tokenFile: string): boolean {
  const token = readTokenFile(tokenFile);
  if (token === undefined) {
    return false;
  }
  const row = activeTokenRow(db, appId);
  return row !== undefined && row.token_hash === hashAgentToken(token);
}

/**
 * Reuse the token file/hash when they agree; otherwise revoke the old token, mint a new one, and
 * atomically rewrite the file. A token file is never trusted by existence alone.
 *
 * A failed file write revokes the freshly minted row and leaves no active token row. The previous
 * row is not restored because the previous file bytes are no longer guaranteed; the next
 * reconciliation repairs the pair. An orphan file is therefore tolerated.
 */
export function ensureAgentToken(db: SqliteDatabase, appId: string, tokenFile: string): string {
  const token = readTokenFile(tokenFile);
  if (token !== undefined) {
    const row = activeTokenRow(db, appId);
    if (row !== undefined && row.token_hash === hashAgentToken(token)) {
      return token;
    }
  }
  const minted = mintAgentToken(db, appId);
  try {
    writeAgentTokenFile(tokenFile, minted);
  } catch (error) {
    revokeAgentToken(db, appId);
    throw error;
  }
  return minted;
}

/** Resolve a plaintext token to its app/project, or undefined when missing/revoked. */
export function verifyAgentToken(
  db: SqliteDatabase,
  token: string,
): AgentTokenIdentity | undefined {
  if (token.length === 0) {
    return undefined;
  }
  return db
    .prepare(
      `SELECT t.app_id AS appId, a.project_id AS projectId, a.app_key AS appKey
       FROM agent_tokens t
       JOIN apps a ON a.id = t.app_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    )
    .get(hashAgentToken(token)) as AgentTokenIdentity | undefined;
}

/** Canonical per-app token path, using the same path-segment sanitization as the instance env. */
export function mcpTokenPath(
  agentsHome: string,
  identity: { projectId: string; app: string },
): string {
  return path.join(
    agentsHome,
    sanitizeAppKey(identity.projectId),
    sanitizeAppKey(identity.app),
    "mcp-token",
  );
}

/** Write a token file atomically with mode 0600 (temp file + rename in the same directory). */
export function writeAgentTokenFile(tokenFile: string, token: string): void {
  const directory = path.dirname(tokenFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(tokenFile)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, token, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, tokenFile);
    chmodSync(tokenFile, 0o600);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
