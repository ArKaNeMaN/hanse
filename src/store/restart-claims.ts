import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";

export interface PersistedRestartClaim {
  appId: string;
  claimId: string;
  reason: string | null;
  createdAt: string;
}

interface RestartClaimRow {
  app_id: string;
  claim_id: string;
  reason: string | null;
  created_at: string;
}

function rowToClaim(row: RestartClaimRow): PersistedRestartClaim {
  return {
    appId: row.app_id,
    claimId: row.claim_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/**
 * Persist an async restart claim before the caller answers `202`.
 *
 * The table primary key makes the claim atomic across a coordinator restart; `undefined` means a
 * claim already exists (or the app row is gone).
 */
export function claimPersistedRestart(
  db: SqliteDatabase,
  appId: string,
  reason = "restart",
): string | undefined {
  const claimId = randomUUID();
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO restart_claims (app_id, claim_id, reason, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(appId, claimId, reason, new Date().toISOString());
  return result.changes === 1 ? claimId : undefined;
}

/** Release a claim only when it is still the same claim; a newer owner is never deleted. */
export function releasePersistedRestart(db: SqliteDatabase, appId: string, claimId?: string): void {
  if (claimId === undefined) {
    db.prepare("DELETE FROM restart_claims WHERE app_id = ?").run(appId);
    return;
  }
  db.prepare("DELETE FROM restart_claims WHERE app_id = ? AND claim_id = ?").run(appId, claimId);
}

export function listPersistedRestarts(db: SqliteDatabase): PersistedRestartClaim[] {
  const rows = db
    .prepare("SELECT app_id, claim_id, reason, created_at FROM restart_claims ORDER BY created_at")
    .all() as RestartClaimRow[];
  return rows.map(rowToClaim);
}
