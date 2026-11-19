/**
 * Pure projection for the chat transcript work timeline: collapse contiguous reasoning and
 * non-question tool parts into one collapsed `Working` group, across assistant messages that
 * continue the turn (`finish: "tool-calls"`).
 *
 * This module has no Vue, DOM, network, or storage dependency so it can be unit tested directly.
 */

import { isHiddenSyntheticTextPart } from "../../assets/chat-core.js";
import { isQuestionToolPart } from "./prompt-utils.js";
import type { ChatMessagePartView, ChatThreadItem, ChatWorkGroupView } from "./types.js";

const HIDDEN_PART_TYPES = new Set([
  "step-start",
  "step-finish",
  "retry",
  "compaction",
  "snapshot",
  "agent",
  "patch",
]);

function isVisibleText(part: ChatMessagePartView): boolean {
  return part.type === "text" && part.text.length > 0 && !isHiddenSyntheticTextPart(part);
}

function isWorkPart(part: ChatMessagePartView): boolean {
  return part.type === "reasoning" || (part.type === "tool" && !isQuestionToolPart(part));
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function buildGroup(parts: readonly ChatMessagePartView[]): ChatWorkGroupView {
  const toolCount = parts.filter((part) => part.type === "tool").length;
  const reasoningCount = parts.filter((part) => part.type === "reasoning").length;
  const hasError = parts.some((part) => part.type === "tool" && part.status === "error");
  const metrics: string[] = [];
  if (toolCount > 0) metrics.push(plural(toolCount, "tool call"));
  if (reasoningCount > 0) metrics.push(plural(reasoningCount, "thought"));
  return {
    id: `work-group:${parts[0]?.id ?? ""}`,
    parts,
    toolCount,
    reasoningCount,
    hasError,
    metricsText: metrics.join(" · "),
  };
}

/** Project a flat timeline into the rendered timeline, hiding work cycles inside groups. */
export function buildWorkTimeline(items: readonly ChatThreadItem[]): ChatThreadItem[] {
  const out: ChatThreadItem[] = [];
  let run: ChatMessagePartView[] = [];

  const flushWork = (): void => {
    if (run.length === 0) return;
    out.push({ type: "work-group", group: buildGroup(run) });
    run = [];
  };

  for (const item of items) {
    if (item.type !== "message") {
      flushWork();
      out.push(item);
      continue;
    }

    const message = item.message;
    if (
      message.omo !== null ||
      (message.handoff ?? null) !== null ||
      message.role !== "assistant"
    ) {
      flushWork();
      out.push(item);
      continue;
    }

    if (!message.parts.some((part) => isWorkPart(part))) {
      flushWork();
      out.push(item);
      continue;
    }

    let boundaryParts: ChatMessagePartView[] = [];
    let metaShown = false;

    const flushBoundary = (): void => {
      if (boundaryParts.length === 0) return;
      out.push({
        type: "message",
        message: {
          ...message,
          parts: boundaryParts,
          ...(metaShown ? { showMeta: false } : {}),
          ...(metaShown ? { attachments: undefined } : {}),
        },
        sliceKey: boundaryParts[0]?.id ?? "attachments",
      });
      metaShown = true;
      boundaryParts = [];
    };

    for (const part of message.parts) {
      if (HIDDEN_PART_TYPES.has(part.type)) continue;
      if (part.type === "text" && !isVisibleText(part)) continue;
      if (isWorkPart(part)) {
        flushBoundary();
        run.push(part);
        continue;
      }
      flushWork();
      boundaryParts.push(part);
    }

    if (!metaShown && boundaryParts.length === 0 && (message.attachments?.length ?? 0) > 0) {
      flushWork();
      out.push({
        type: "message",
        message: { ...message, parts: [] },
        sliceKey: "attachments",
      });
      metaShown = true;
    } else {
      flushBoundary();
    }

    const completed = message.time?.completed;
    if (typeof completed === "number" && message.finish !== "tool-calls") {
      flushWork();
    }
  }

  flushWork();
  return out;
}
