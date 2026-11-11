import { describe, expect, it } from "vitest";
import { buildNoticeTimeline, noticeGroupKey, threadItemKey } from "../../ui/chat/notice-groups.js";
import type { ChatMessageView, ChatThreadItem } from "../../ui/chat/types.js";
import { absoluteTime } from "../../ui/format.js";
import type { NoticeView } from "../../ui/stores/chat-feed.js";

let seq = 0;

function notice(overrides: Partial<NoticeView> = {}): NoticeView {
  seq += 1;
  return { id: `notice-${seq}`, ...overrides };
}

function message(id?: string): ChatMessageView {
  seq += 1;
  return { id: id ?? `message-${seq}`, role: "assistant", omo: null, parts: [] };
}

function noticeItem(value: NoticeView): ChatThreadItem {
  return { type: "notice", notice: value };
}

function messageItem(id?: string): ChatThreadItem {
  return { type: "message", message: message(id) };
}

function localIso(year: number, month: number, day: number, hour: number, minute: number): string {
  return new Date(year, month, day, hour, minute, 0).toISOString();
}

function groups(items: readonly ChatThreadItem[]): ChatThreadItem[] {
  return buildNoticeTimeline(items, { historyComplete: true });
}

describe("noticeGroupKey", () => {
  it("uses a trimmed non-empty reason", () => {
    expect(noticeGroupKey(notice({ reason: "  process_exit  ", kind: "agent_stopped" }))).toBe(
      "process_exit",
    );
  });

  it("falls back to a trimmed kind when reason is blank", () => {
    expect(noticeGroupKey(notice({ reason: "   ", kind: " resume_started " }))).toBe(
      "resume_started",
    );
  });

  it("returns an empty string when neither is present", () => {
    expect(noticeGroupKey(notice())).toBe("");
    expect(noticeGroupKey(notice({ reason: "  ", kind: "" }))).toBe("");
  });
});

describe("threadItemKey", () => {
  it("prefixes messages and notices and passes through a group id", () => {
    const first = notice({ id: "n1", reason: "process_exit" });
    const second = notice({ id: "n2", reason: "process_exit" });
    const timeline = groups([noticeItem(first), noticeItem(second)]);
    const group = timeline[0];
    expect(group?.type).toBe("notice-group");
    if (group === undefined || group.type !== "notice-group") throw new Error("missing group");

    expect(threadItemKey({ type: "message", message: message("m1") })).toBe("message:m1");
    expect(threadItemKey(noticeItem(first))).toBe("notice:n1");
    expect(threadItemKey(group)).toBe("notice-group:n1");
    expect(threadItemKey(group)).toBe(group.group.id);
  });
});

describe("buildNoticeTimeline grouping", () => {
  it("groups mixed kinds that share one reason", () => {
    const first = notice({ id: "a", kind: "agent_stopped", reason: "process_exit" });
    const second = notice({ id: "b", kind: "subagent_interrupted", reason: "process_exit" });
    const result = groups([noticeItem(first), noticeItem(second)]);

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item?.type).toBe("notice-group");
    if (item === undefined || item.type !== "notice-group") throw new Error("missing group");
    expect(item.group.id).toBe("notice-group:a");
    expect(item.group.count).toBe(2);
    expect(item.group.reason).toBe("process_exit");
    expect(item.group.reasonLabel).toBe("Process exited");
    expect(item.group.kindBreakdown).toEqual([
      { label: "Agent was restarted here", count: 1 },
      { label: "Subagent interrupted", count: 1 },
    ]);
  });

  it("splits a run on a message", () => {
    const result = groups([
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
      messageItem("m1"),
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
    ]);

    expect(result.map((item) => item.type)).toEqual(["notice-group", "message", "notice-group"]);
  });

  it("splits a run when the reason changes", () => {
    const result = groups([
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
      noticeItem(notice({ kind: "agent_stopped", reason: "operator_restart" })),
      noticeItem(notice({ kind: "agent_stopped", reason: "operator_restart" })),
    ]);

    expect(result.map((item) => item.type)).toEqual(["notice-group", "notice-group"]);
    const [first, second] = result;
    if (first?.type !== "notice-group" || second?.type !== "notice-group") {
      throw new Error("expected two groups");
    }
    expect(first.group.reason).toBe("process_exit");
    expect(second.group.reason).toBe("operator_restart");
  });

  it("emits a singleton run as a plain notice", () => {
    const only = notice({ kind: "resume_started" });
    const result = groups([noticeItem(only)]);
    expect(result).toEqual([{ type: "notice", notice: only }]);
  });

  it("never mutates the input array or its items", () => {
    const first = noticeItem(notice({ reason: "process_exit" }));
    const second = noticeItem(notice({ reason: "process_exit" }));
    const input = [first, second, messageItem("m1")];
    const snapshot = [...input];

    const result = groups(input);

    expect(input).toEqual(snapshot);
    expect(input).toHaveLength(3);
    expect(result).not.toBe(input);
  });
});

describe("buildNoticeTimeline leading hide", () => {
  it("drops leading notices while history is incomplete", () => {
    const hidden = notice({ id: "leading" });
    const kept = notice({ id: "after" });
    const result = buildNoticeTimeline([noticeItem(hidden), messageItem("m1"), noticeItem(kept)], {
      historyComplete: false,
    });
    expect(result.map((item) => (item.type === "notice" ? item.notice.id : item.type))).toEqual([
      "message",
      "after",
    ]);
  });

  it("keeps leading notices when history is complete", () => {
    const first = notice({ id: "a", reason: "process_exit" });
    const second = notice({ id: "b", reason: "process_exit" });
    const result = buildNoticeTimeline([noticeItem(first), noticeItem(second), messageItem("m1")], {
      historyComplete: true,
    });
    expect(result.map((item) => item.type)).toEqual(["notice-group", "message"]);
  });

  it("drops every notice when history is incomplete and no message is loaded", () => {
    const result = buildNoticeTimeline([noticeItem(notice()), noticeItem(notice())], {
      historyComplete: false,
    });
    expect(result).toEqual([]);
  });

  it("keeps every notice when history is complete and no message is loaded", () => {
    const first = notice({ id: "a", reason: "process_exit" });
    const second = notice({ id: "b", reason: "process_exit" });
    const result = buildNoticeTimeline([noticeItem(first), noticeItem(second)], {
      historyComplete: true,
    });
    expect(result.map((item) => item.type)).toEqual(["notice-group"]);
  });

  it("keeps everything when the first message is already at index 0", () => {
    const trailing = notice({ id: "trailing" });
    const result = buildNoticeTimeline([messageItem("m1"), noticeItem(trailing)], {
      historyComplete: false,
    });
    expect(result.map((item) => item.type)).toEqual(["message", "notice"]);
  });
});

describe("group summary metrics", () => {
  it("counts distinct child sessions and excludes the notice's own session", () => {
    const result = groups([
      noticeItem(
        notice({
          kind: "subagent_interrupted",
          reason: "subagent_abort",
          sessionId: "child-self",
          payload: { childSessionID: "child-self" },
        }),
      ),
      noticeItem(
        notice({
          kind: "subagent_interrupted",
          reason: "subagent_abort",
          payload: { childSessionID: "child-shared" },
        }),
      ),
      noticeItem(
        notice({
          kind: "subagent_interrupted",
          reason: "subagent_abort",
          payload: { childSessionID: "child-shared" },
        }),
      ),
      noticeItem(
        notice({
          kind: "subagent_interrupted",
          reason: "subagent_abort",
          payload: { childSessionID: "child-other" },
        }),
      ),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.count).toBe(4);
    expect(item.group.subagentCount).toBe(2);
    expect(item.group.metricsText).toBe("4 notices · 2 subagents");
  });

  it("counts restarts for restart reasons and dedupes runtime epochs", () => {
    const result = groups([
      noticeItem(
        notice({ kind: "agent_stopped", reason: "process_exit", payload: { runtimeEpoch: "e1" } }),
      ),
      noticeItem(
        notice({ kind: "agent_stopped", reason: "process_exit", payload: { runtimeEpoch: "e1" } }),
      ),
      noticeItem(
        notice({ kind: "agent_stopped", reason: "process_exit", payload: { runtimeEpoch: "e2" } }),
      ),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.restartCount).toBe(2);
    expect(item.group.metricsText).toBe("3 notices · 2 restarts");
  });

  it("counts auto_update as a restart", () => {
    const result = groups([
      noticeItem(
        notice({ kind: "agent_stopped", reason: "auto_update", payload: { runtimeEpoch: "e1" } }),
      ),
      noticeItem(
        notice({ kind: "agent_stopped", reason: "auto_update", payload: { runtimeEpoch: "e2" } }),
      ),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.restartCount).toBe(2);
    expect(item.group.metricsText).toBe("2 notices · 2 restarts");
  });

  it("does not count restarts for non-restart reasons", () => {
    const result = groups([
      noticeItem(
        notice({
          kind: "subagent_interrupted",
          reason: "subagent_abort",
          payload: { runtimeEpoch: "e1" },
        }),
      ),
      noticeItem(
        notice({
          kind: "subagent_interrupted",
          reason: "subagent_abort",
          payload: { runtimeEpoch: "e2" },
        }),
      ),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.restartCount).toBe(0);
    expect(item.group.metricsText).toBe("2 notices");
  });

  it("omits metrics when payloads are missing or non-string", () => {
    const result = groups([
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
      noticeItem(
        notice({
          kind: "agent_stopped",
          reason: "process_exit",
          payload: { childSessionID: 42, runtimeEpoch: null },
        }),
      ),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.subagentCount).toBe(0);
    expect(item.group.restartCount).toBe(0);
    expect(item.group.metricsText).toBe("2 notices");
  });

  it("pluralizes each metric correctly", () => {
    const single = groups([
      noticeItem(
        notice({
          kind: "agent_stopped",
          reason: "process_exit",
          payload: { childSessionID: "child-1", runtimeEpoch: "e1" },
        }),
      ),
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
    ]);
    const [singleItem] = single;
    if (singleItem?.type !== "notice-group") throw new Error("missing group");
    expect(singleItem.group.metricsText).toBe("2 notices · 1 subagent · 1 restart");

    const plural = groups([
      noticeItem(
        notice({
          kind: "agent_stopped",
          reason: "process_exit",
          payload: { childSessionID: "child-1", runtimeEpoch: "e1" },
        }),
      ),
      noticeItem(
        notice({
          kind: "agent_stopped",
          reason: "process_exit",
          payload: { childSessionID: "child-2", runtimeEpoch: "e2" },
        }),
      ),
    ]);
    const [pluralItem] = plural;
    if (pluralItem?.type !== "notice-group") throw new Error("missing group");
    expect(pluralItem.group.metricsText).toBe("2 notices · 2 subagents · 2 restarts");
  });

  it("builds the breakdown text from noticeLabel in first-seen order", () => {
    const result = groups([
      noticeItem(notice({ kind: "subagent_interrupted", reason: "process_exit" })),
      noticeItem(notice({ kind: "agent_stopped", reason: "process_exit" })),
      noticeItem(notice({ kind: "subagent_interrupted", reason: "process_exit" })),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.breakdownText).toBe("Subagent interrupted ×2 · Agent was restarted here ×1");
  });

  it("keeps resume_failed + ambiguous labelled as Outcome unknown", () => {
    const result = groups([
      noticeItem(notice({ kind: "resume_failed", reason: "ambiguous" })),
      noticeItem(notice({ kind: "resume_failed", reason: "ambiguous" })),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.reason).toBe("ambiguous");
    expect(item.group.reasonLabel).toBe("Outcome unknown");
    expect(item.group.breakdownText).toBe("Agent resume unconfirmed ×2");
  });
});

describe("group time range", () => {
  it("renders a same-day HH:MM-HH:MM range and a full title", () => {
    const firstAt = localIso(2026, 0, 2, 9, 5);
    const lastAt = localIso(2026, 0, 2, 10, 15);
    const result = groups([
      noticeItem(notice({ reason: "process_exit", createdAt: firstAt })),
      noticeItem(notice({ reason: "process_exit", createdAt: lastAt })),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.firstAt).toBe(firstAt);
    expect(item.group.lastAt).toBe(lastAt);
    expect(item.group.timeText).toBe("09:05-10:15");
    expect(item.group.timeTitle).toBe(`${absoluteTime(firstAt)} - ${absoluteTime(lastAt)}`);
  });

  it("collapses a single-minute range to one HH:MM", () => {
    const firstAt = localIso(2026, 0, 2, 9, 5);
    const lastAt = new Date(new Date(firstAt).getTime() + 40_000).toISOString();
    const result = groups([
      noticeItem(notice({ reason: "process_exit", createdAt: firstAt })),
      noticeItem(notice({ reason: "process_exit", createdAt: lastAt })),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.timeText).toBe("09:05");
  });

  it("renders the absolute range across calendar days", () => {
    const firstAt = localIso(2026, 0, 2, 23, 50);
    const lastAt = localIso(2026, 0, 3, 0, 10);
    const result = groups([
      noticeItem(notice({ reason: "process_exit", createdAt: firstAt })),
      noticeItem(notice({ reason: "process_exit", createdAt: lastAt })),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    const expected = `${absoluteTime(firstAt)} - ${absoluteTime(lastAt)}`;
    expect(item.group.timeText).toBe(expected);
    expect(item.group.timeTitle).toBe(expected);
  });

  it("skips unparseable timestamps and renders an empty range when none parse", () => {
    const result = groups([
      noticeItem(notice({ reason: "process_exit", createdAt: "not-a-date" })),
      noticeItem(notice({ reason: "process_exit", createdAt: "" })),
    ]);

    const [item] = result;
    if (item?.type !== "notice-group") throw new Error("missing group");
    expect(item.group.firstAt).toBe("");
    expect(item.group.lastAt).toBe("");
    expect(item.group.timeText).toBe("");
    expect(item.group.timeTitle).toBe("");
  });
});
