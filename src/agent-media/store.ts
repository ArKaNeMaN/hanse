import { rmSync } from "node:fs";
import path from "node:path";
import { sanitizeAppKey } from "../opencode/instance.js";
import type { SqliteDatabase } from "../store/index.js";
import { agentMediaFinalPath, agentMediaTempPath } from "./paths.js";
import type { AgentMediaRow } from "./types.js";

const COLUMNS = `id, app_id AS appId, session_id AS sessionId, message_id AS messageId,
  part_id AS partId, original_name AS originalName, stored_name AS storedName,
  rel_path AS relPath, mime, size, caption, state,
  created_at AS createdAt, updated_at AS updatedAt`;

export function readAgentMedia(
  db: SqliteDatabase,
  appId: string,
  id: string,
): AgentMediaRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM agent_media WHERE app_id = ? AND id = ?`)
    .get(appId, id) as AgentMediaRow | undefined;
}

export function readSessionAgentMedia(
  db: SqliteDatabase,
  appId: string,
  sessionId: string,
): AgentMediaRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM agent_media WHERE app_id = ? AND session_id = ? ORDER BY created_at, id`,
    )
    .all(appId, sessionId) as AgentMediaRow[];
}

export function listStagedAgentMedia(db: SqliteDatabase, appId?: string): AgentMediaRow[] {
  return appId === undefined
    ? (db
        .prepare(`SELECT ${COLUMNS} FROM agent_media WHERE state = 'staged' ORDER BY created_at`)
        .all() as AgentMediaRow[])
    : (db
        .prepare(
          `SELECT ${COLUMNS} FROM agent_media WHERE app_id = ? AND state = 'staged' ORDER BY created_at`,
        )
        .all(appId) as AgentMediaRow[]);
}

export function listAgentMediaRoots(
  db: SqliteDatabase,
  agentsHome: string,
): Array<{ appId: string; appRoot: string }> {
  const rows = db
    .prepare("SELECT id AS appId, project_id AS projectId, app_key AS appKey FROM apps")
    .all() as Array<{ appId: string; projectId: string; appKey: string }>;
  return rows.map((row) => ({
    appId: row.appId,
    appRoot: path.join(agentsHome, sanitizeAppKey(row.projectId), sanitizeAppKey(row.appKey)),
  }));
}

export interface InsertStagedInput {
  id: string;
  appId: string;
  originalName: string;
  storedName: string;
  relPath: string;
  mime: string;
  size: number;
  caption: string | null;
  now: string;
}

export function insertStagedAgentMedia(db: SqliteDatabase, input: InsertStagedInput): void {
  db.prepare(
    `INSERT INTO agent_media (
       id, app_id, session_id, message_id, part_id, original_name, stored_name, rel_path,
       mime, size, caption, state, created_at, updated_at
     ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'staged', ?, ?)`,
  ).run(
    input.id,
    input.appId,
    input.originalName,
    input.storedName,
    input.relPath,
    input.mime,
    input.size,
    input.caption,
    input.now,
    input.now,
  );
}

export function touchAgentMedia(db: SqliteDatabase, id: string, now: string): void {
  db.prepare("UPDATE agent_media SET updated_at = ? WHERE id = ?").run(now, id);
}

export function deleteAgentMediaRow(db: SqliteDatabase, appId: string, id: string): void {
  db.prepare("DELETE FROM agent_media WHERE app_id = ? AND id = ?").run(appId, id);
}

export function markAgentMediaMissing(db: SqliteDatabase, id: string, now: string): void {
  db.prepare("UPDATE agent_media SET state = 'missing', updated_at = ? WHERE id = ?").run(now, id);
}

export type AgentMediaAttachOutcome =
  | { status: "attached"; row: AgentMediaRow }
  | { status: "missing"; row: AgentMediaRow }
  | { status: "conflict" }
  | { status: "unknown" };

export function attachAgentMedia(
  db: SqliteDatabase,
  appId: string,
  id: string,
  sessionId: string,
  messageId: string,
  partId: string,
  now: string,
): AgentMediaAttachOutcome {
  const run = db.transaction((): AgentMediaAttachOutcome => {
    const row = readAgentMedia(db, appId, id);
    if (row === undefined) return { status: "unknown" };
    if (row.state === "staged") {
      const result = db
        .prepare(
          `UPDATE agent_media
              SET session_id = ?, message_id = ?, part_id = ?, state = 'attached', updated_at = ?
            WHERE app_id = ? AND id = ? AND state = 'staged'`,
        )
        .run(sessionId, messageId, partId, now, appId, id);
      if (result.changes === 0) return { status: "conflict" };
      const updated = readAgentMedia(db, appId, id);
      return updated === undefined ? { status: "unknown" } : { status: "attached", row: updated };
    }
    const same =
      row.sessionId === sessionId && row.messageId === messageId && row.partId === partId;
    if (row.state === "missing") {
      if (row.sessionId === null || row.messageId === null || row.partId === null) {
        return { status: "unknown" };
      }
      return same ? { status: "missing", row } : { status: "conflict" };
    }
    return same ? { status: "attached", row } : { status: "conflict" };
  });
  return run();
}

/** Delete a session's media rows and files. Returns the number of rows removed. */
export function deleteSessionAgentMedia(
  db: SqliteDatabase,
  appRoot: string,
  appId: string,
  sessionId: string,
): number {
  const rows = readSessionAgentMedia(db, appId, sessionId);
  if (rows.length === 0) return 0;
  db.transaction(() => {
    db.prepare("DELETE FROM agent_media WHERE app_id = ? AND session_id = ?").run(appId, sessionId);
  })();
  for (const row of rows) {
    bestEffortRemove(agentMediaFinalPath(appRoot, row.storedName));
    bestEffortRemove(agentMediaTempPath(appRoot, row.id));
  }
  return rows.length;
}

export function removeStagedAgentMedia(
  db: SqliteDatabase,
  appRoot: string,
  row: AgentMediaRow,
): void {
  db.prepare("DELETE FROM agent_media WHERE app_id = ? AND id = ?").run(row.appId, row.id);
  bestEffortRemove(agentMediaFinalPath(appRoot, row.storedName));
  bestEffortRemove(agentMediaTempPath(appRoot, row.id));
}

function bestEffortRemove(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // The daily orphan pass repairs leftovers.
  }
}

export function listAttachedAgentMedia(db: SqliteDatabase, appId: string): AgentMediaRow[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM agent_media WHERE app_id = ? AND state = 'attached' ORDER BY created_at`,
    )
    .all(appId) as AgentMediaRow[];
}

export function listAllAgentMedia(db: SqliteDatabase, appId: string): AgentMediaRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM agent_media WHERE app_id = ? ORDER BY created_at`)
    .all(appId) as AgentMediaRow[];
}
