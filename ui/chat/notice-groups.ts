/**
 * Pure projection for chat notice dividers: hide leading notices while older message history is
 * unloaded, then group maximal contiguous runs with the same normalized cause.
 *
 * This module has no Vue, DOM, network, or storage dependency so it can be unit tested directly.
 */

import { noticeLabel } from "../../assets/chat-core.js";
import { absoluteTime } from "../format.js";
import type { NoticeView } from "../stores/chat-feed.js";
import type { ChatNoticeGroupView, ChatThreadItem } from "./types.js";

const RESTART_REASONS = new Set([
  "process_exit",
  "operator_restart",
  "auto_update",
  "deployment",
  "unknown_restart",
]);

/** Normalized grouping cause: trimmed `reason`, else trimmed `kind`, else `""`. */
export function noticeGroupKey(notice: NoticeView): string {
  const reason = typeof notice.reason === "string" ? notice.reason.trim() : "";
  if (reason.length > 0) return reason;
  const kind = typeof notice.kind === "string" ? notice.kind.trim() : "";
  return kind.length > 0 ? kind : "";
}

/** Stable `v-for` key. Group ids already carry the `notice-group:` prefix. */
export function threadItemKey(item: ChatThreadItem): string {
  switch (item.type) {
    case "message":
      return `message:${item.message.id}`;
    case "notice":
      return `notice:${item.notice.id}`;
    case "notice-group":
      return item.group.id;
  }
}

/** Hide notices that precede the first loaded message while older message history may exist. */
function hideLeadingNotices(items: readonly ChatThreadItem[]): readonly ChatThreadItem[] {
  const firstMessage = items.findIndex((item) => item.type === "message");
  if (firstMessage < 0) {
    return items.filter((item) => item.type !== "notice");
  }
  return firstMessage === 0 ? items : items.slice(firstMessage);
}

function payloadOf(notice: NoticeView): Record<string, unknown> | null {
  const payload = notice.payload;
  return payload !== null && typeof payload === "object" ? payload : null;
}

function distinctStrings(
  notices: readonly NoticeView[],
  key: string,
  skip?: (notice: NoticeView) => string | null,
): number {
  const seen = new Set<string>();
  for (const notice of notices) {
    const value = payloadOf(notice)?.[key];
    if (typeof value !== "string") continue;
    if (skip !== undefined) {
      const own = skip(notice);
      if (own !== null && value === own) continue;
    }
    seen.add(value);
  }
  return seen.size;
}

function parseDate(value: string): Date | null {
  if (value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function timeRange(
  firstAt: string,
  lastAt: string,
): { readonly timeText: string; readonly timeTitle: string } {
  const first = parseDate(firstAt);
  const last = parseDate(lastAt);
  if (first === null || last === null) {
    return { timeText: "", timeTitle: "" };
  }
  const timeTitle = `${absoluteTime(firstAt)} - ${absoluteTime(lastAt)}`;
  if (!sameCalendarDay(first, last)) {
    return { timeText: timeTitle, timeTitle };
  }
  const start = clock(first);
  const end = clock(last);
  return { timeText: start === end ? start : `${start}-${end}`, timeTitle };
}

function buildGroup(first: NoticeView, rest: readonly NoticeView[]): ChatNoticeGroupView {
  const notices = [first, ...rest];
  const reason = noticeGroupKey(first);
  const mapped = noticeLabel(first);

  const breakdown = new Map<string, number>();
  for (const notice of notices) {
    const label = noticeLabel(notice).label;
    breakdown.set(label, (breakdown.get(label) ?? 0) + 1);
  }
  const kindBreakdown = Array.from(breakdown, ([label, count]) => ({ label, count }));

  const subagentCount = distinctStrings(notices, "childSessionID", (notice) =>
    typeof notice.sessionId === "string" ? notice.sessionId : null,
  );
  const restartCount = RESTART_REASONS.has(reason) ? distinctStrings(notices, "runtimeEpoch") : 0;

  let firstAt = "";
  let lastAt = "";
  for (const notice of notices) {
    const createdAt = notice.createdAt;
    if (typeof createdAt !== "string") continue;
    if (parseDate(createdAt) === null) continue;
    if (firstAt.length === 0) firstAt = createdAt;
    lastAt = createdAt;
  }

  const metrics = [plural(notices.length, "notice")];
  if (subagentCount > 0) metrics.push(plural(subagentCount, "subagent"));
  if (restartCount > 0) metrics.push(plural(restartCount, "restart"));

  const { timeText, timeTitle } = timeRange(firstAt, lastAt);

  return {
    id: `notice-group:${first.id}`,
    notices,
    reason,
    reasonLabel: mapped.reason || mapped.label,
    count: notices.length,
    kindBreakdown,
    subagentCount,
    restartCount,
    firstAt,
    lastAt,
    metricsText: metrics.join(" · "),
    breakdownText: kindBreakdown.map(({ label, count }) => `${label} ×${count}`).join(" · "),
    timeText,
    timeTitle,
  };
}

function flushRun(run: readonly NoticeView[], out: ChatThreadItem[]): void {
  if (run.length === 0) return;
  if (run.length === 1) {
    const [notice] = run;
    if (notice !== undefined) out.push({ type: "notice", notice });
    return;
  }
  const [first, ...rest] = run;
  if (first === undefined) return;
  out.push({ type: "notice-group", group: buildGroup(first, rest) });
}

/**
 * Project a flat timeline into the rendered timeline: optionally hide leading notices, then group
 * contiguous notice runs that share a normalized cause. The input is never mutated.
 */
export function buildNoticeTimeline(
  items: readonly ChatThreadItem[],
  options: { readonly historyComplete: boolean },
): ChatThreadItem[] {
  const visible = options.historyComplete ? items : hideLeadingNotices(items);
  const out: ChatThreadItem[] = [];
  let run: NoticeView[] = [];
  let runKey: string | null = null;

  for (const item of visible) {
    if (item.type === "notice") {
      const key = noticeGroupKey(item.notice);
      if (runKey !== null && key !== runKey) {
        flushRun(run, out);
        run = [];
      }
      runKey = key;
      run.push(item.notice);
      continue;
    }
    flushRun(run, out);
    run = [];
    runKey = null;
    out.push(item);
  }
  flushRun(run, out);
  return out;
}
