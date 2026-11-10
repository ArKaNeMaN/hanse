import type { SessionNoticeKind } from "../opencode/recovery.js";
import type { SqliteDatabase } from "../store/index.js";
import { getNotificationMeta, writeNotificationMeta } from "../store/notifications.js";

export const NOTICE_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const NOTIFICATION_META_KEYS = {
  firstSweepAt: "telegram.first_sweep_at",
  noticeScanAt: "telegram.notice_scan_at",
  enabledAt: "telegram.enabled_at",
  channelEnabled: "telegram.channel_enabled",
} as const;

export const NOTICE_ATTENTION_KINDS: readonly SessionNoticeKind[] = [
  "agent_stopped",
  "subagent_interrupted",
  "resume_failed",
  "resume_unavailable",
];

const NOTIFY_REASONS: ReadonlySet<string> = new Set([
  "process_exit",
  "unknown_restart",
  "unknown",
  "missing",
  "stale",
  "ttl_expired",
  "resume_failed",
  "resume_unavailable",
]);

const SUPPRESS_REASONS: ReadonlySet<string> = new Set([
  "operator_restart",
  "operator_stop",
  "deletion",
  "deployment",
  "operator_abort",
  "subagent_abort",
  "stopped",
  "superseded",
  "completed",
  "ambiguous",
]);

export interface NotificationMetaState {
  firstSweepAt?: string;
  noticeScanAt?: string;
  enabledAt?: string;
  channelEnabled?: boolean;
}

export interface NoticeCandidate {
  noticeId: string;
  appId: string;
  sessionId: string;
  parentSessionId?: string;
  kind: SessionNoticeKind;
  reason?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  /** `notice:<noticeId>`; Phase F appends `:<chunkIndex>` per chunk. */
  dedupeKey: string;
}

export interface NoticeScanResult {
  candidates: NoticeCandidate[];
  /** Newest four-kind row the scan considered, including rows the reason matrix suppressed. */
  latestCreatedAt: string | null;
  threshold: string;
}

export interface ScanMissedNoticesOptions {
  now: number;
  noticeScanAt?: string | null;
  enabledAt?: string | null;
}

export type WatermarkAction = "notify" | "initialize" | "skip";

export function readNotificationMetaState(db: SqliteDatabase): NotificationMetaState {
  const channelEnabled = getNotificationMeta(db, NOTIFICATION_META_KEYS.channelEnabled);
  const firstSweepAt = getNotificationMeta(db, NOTIFICATION_META_KEYS.firstSweepAt);
  const noticeScanAt = getNotificationMeta(db, NOTIFICATION_META_KEYS.noticeScanAt);
  const enabledAt = getNotificationMeta(db, NOTIFICATION_META_KEYS.enabledAt);
  return {
    ...(firstSweepAt === undefined ? {} : { firstSweepAt }),
    ...(noticeScanAt === undefined ? {} : { noticeScanAt }),
    ...(enabledAt === undefined ? {} : { enabledAt }),
    ...(channelEnabled === undefined ? {} : { channelEnabled: channelEnabled === "true" }),
  };
}

export function writeNoticeScanMarker(
  db: SqliteDatabase,
  at: string,
  now = new Date().toISOString(),
): void {
  writeNotificationMeta(db, NOTIFICATION_META_KEYS.noticeScanAt, at, now);
}

/** The notice reason matrix (design §6.1). Unrecognized reasons notify for stop kinds. */
export function noticeReasonNotifies(kind: SessionNoticeKind, reason: string | undefined): boolean {
  if (kind === "resume_failed" || kind === "resume_unavailable") return true;
  if (kind === "agent_stopped" || kind === "subagent_interrupted") {
    if (reason === undefined || reason.length === 0) return true;
    if (NOTIFY_REASONS.has(reason)) return true;
    return !SUPPRESS_REASONS.has(reason);
  }
  return false;
}

/**
 * The shared watermark rule (design §4.3). `undefined` means no row exists; a row with a null
 * `lastNotifiedMessageId` is a real watermark that can differ from a later occurrence id.
 */
export function decideWatermark(input: {
  watermark: string | null | undefined;
  currentId: string | null;
  sessionCreatedAt?: number;
  firstSweepAt?: string;
}): WatermarkAction {
  if (input.watermark !== undefined) {
    return input.watermark === input.currentId ? "skip" : "notify";
  }
  if (input.firstSweepAt === undefined) return "initialize";
  if (input.sessionCreatedAt === undefined) return "initialize";
  const firstSweepMs = Date.parse(input.firstSweepAt);
  if (!Number.isFinite(firstSweepMs)) return "initialize";
  return input.sessionCreatedAt > firstSweepMs ? "notify" : "initialize";
}

function maxIso(values: Array<string | null | undefined>): string {
  let max = "";
  for (const value of values) {
    if (typeof value === "string" && value.length > 0 && value > max) max = value;
  }
  return max;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt payload must not stop the sweep; the notice still notifies without details.
  }
  return {};
}

interface NoticeRow {
  id: string;
  app_id: string;
  session_id: string;
  parent_session_id: string | null;
  kind: string;
  reason: string | null;
  payload_json: string;
  created_at: string;
}

const ATTENTION_KIND_SET: ReadonlySet<string> = new Set(NOTICE_ATTENTION_KINDS);

function asAttentionKind(value: string): SessionNoticeKind | undefined {
  return ATTENTION_KIND_SET.has(value) ? (value as SessionNoticeKind) : undefined;
}

/**
 * Scan `session_notices` for the four attention kinds newer than `max(notice_scan_at, enabled_at)`
 * and within seven days. Candidates are ordered oldest-first so Phase F enqueues in occurrence
 * order; suppressed rows still advance `latestCreatedAt` so they are not rescanned on every boot.
 */
export function scanMissedNotices(
  db: SqliteDatabase,
  options: ScanMissedNoticesOptions,
): NoticeScanResult {
  const floor = new Date(options.now - NOTICE_SCAN_WINDOW_MS).toISOString();
  const threshold = maxIso([floor, options.noticeScanAt, options.enabledAt]);
  const placeholders = NOTICE_ATTENTION_KINDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, app_id, session_id, parent_session_id, kind, reason, payload_json, created_at
         FROM session_notices
        WHERE kind IN (${placeholders})
          AND created_at > ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(...NOTICE_ATTENTION_KINDS, threshold) as NoticeRow[];

  const candidates: NoticeCandidate[] = [];
  let latestCreatedAt: string | null = null;
  for (const row of rows) {
    if (latestCreatedAt === null || row.created_at > latestCreatedAt) {
      latestCreatedAt = row.created_at;
    }
    const kind = asAttentionKind(row.kind);
    if (kind === undefined) continue;
    const reason = row.reason ?? undefined;
    if (!noticeReasonNotifies(kind, reason)) continue;
    candidates.push({
      noticeId: row.id,
      appId: row.app_id,
      sessionId: row.session_id,
      ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
      kind,
      ...(reason === undefined ? {} : { reason }),
      payload: parsePayload(row.payload_json),
      createdAt: row.created_at,
      dedupeKey: `notice:${row.id}`,
    });
  }
  return { candidates, latestCreatedAt, threshold };
}
