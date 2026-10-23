import type { SqliteDatabase } from "./database.js";

/** Append one audit event, replacing an oversized payload with its key list. */
export function recordEvent(
  db: SqliteDatabase,
  scope: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  const serialized = JSON.stringify(payload);
  const body =
    Buffer.byteLength(serialized, "utf8") > 8 * 1024
      ? JSON.stringify({ truncated: true, keys: Object.keys(payload) })
      : serialized;
  db.prepare("INSERT INTO events (scope, type, payload, created_at) VALUES (?, ?, ?, ?)").run(
    scope,
    type,
    body,
    new Date().toISOString(),
  );
}
