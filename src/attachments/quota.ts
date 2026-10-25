import type { SqliteDatabase } from "../store/index.js";
import {
  ATTACHMENT_QUOTA_BYTES,
  MAX_CONCURRENT_UPLOADS_PER_APP,
  MAX_FILE_BYTES,
  MAX_GLOBAL_INFLIGHT_UPLOAD_BYTES,
} from "./types.js";

export interface QuotaView {
  percent: number;
}

export function quotaView(usedBytes: number): QuotaView {
  const percent = Math.min(100, Math.floor((usedBytes / ATTACHMENT_QUOTA_BYTES) * 100));
  return { percent };
}

export function availableAttachmentBytes(db: SqliteDatabase, appId: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(size), 0) AS used FROM app_attachments WHERE app_id = ? AND state = 'available'",
    )
    .get(appId) as { used: number };
  return row.used;
}

/** `available` bytes plus the reservation of every `uploading` row (capped per file). */
export function reservedAttachmentBytes(db: SqliteDatabase, appId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
          CASE WHEN state = 'available' THEN COALESCE(size, 0)
               WHEN state = 'uploading' THEN MIN(COALESCE(declared_size, ?), ?)
               ELSE 0 END
        ), 0) AS used
       FROM app_attachments WHERE app_id = ?`,
    )
    .get(MAX_FILE_BYTES, MAX_FILE_BYTES, appId) as { used: number };
  return row.used;
}

export type UploadReservationResult =
  | { ok: true }
  | { ok: false; code: "upload_busy" | "attachment_quota_exceeded" };

interface InflightApp {
  count: number;
  bytes: number;
}

/**
 * Process-local upload admission. The durable quota is recomputed from SQLite under the per-app
 * lock; this only bounds concurrent streams and in-flight bytes so a burst cannot fill the disk
 * before a row exists.
 */
export class UploadCoordinator {
  readonly #apps = new Map<string, InflightApp>();
  #bytes = 0;

  reserve(appId: string, declaredBytes: number): UploadReservationResult {
    const current = this.#apps.get(appId) ?? { count: 0, bytes: 0 };
    if (current.count >= MAX_CONCURRENT_UPLOADS_PER_APP) {
      return { ok: false, code: "upload_busy" };
    }
    if (this.#bytes + declaredBytes > MAX_GLOBAL_INFLIGHT_UPLOAD_BYTES) {
      return { ok: false, code: "upload_busy" };
    }
    current.count += 1;
    current.bytes += declaredBytes;
    this.#apps.set(appId, current);
    this.#bytes += declaredBytes;
    return { ok: true };
  }

  release(appId: string, declaredBytes: number): void {
    const current = this.#apps.get(appId);
    if (current === undefined) return;
    current.count = Math.max(0, current.count - 1);
    current.bytes = Math.max(0, current.bytes - declaredBytes);
    this.#bytes = Math.max(0, this.#bytes - declaredBytes);
    if (current.count === 0) this.#apps.delete(appId);
  }

  resetForTests(): void {
    this.#apps.clear();
    this.#bytes = 0;
  }
}

export const uploadCoordinator = new UploadCoordinator();
/** Ids with an in-memory stream; the daily reconcile must not settle their rows. */
export const activeUploadIds = new Set<string>();
