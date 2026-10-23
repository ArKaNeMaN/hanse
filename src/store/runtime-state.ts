import type { SqliteDatabase } from "./database.js";

/** Current runtime state for one application; `failed` is reported as `error`. */
export function runtimeState(db: SqliteDatabase, appId: string): string {
  const row = db
    .prepare("SELECT COALESCE(runtime_state, state) AS state FROM instances WHERE app_id = ?")
    .get(appId) as { state: string } | undefined;
  const state = row?.state ?? "stopped";
  return state === "failed" ? "error" : state;
}
