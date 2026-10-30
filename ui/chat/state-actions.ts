/**
 * Applies typed chat actions to the Pinia stores and returns render intents.
 *
 * Components consume the intents (dirty ids, scroll, notices/toasts, reconcile/refresh requests).
 * No action writes the URL or performs network I/O.
 */

import { useChatContextStore } from "../stores/chat-context.js";
import { type NoticeView, useChatFeedStore } from "../stores/chat-feed.js";
import { useChatSessionStore } from "../stores/chat-session.js";
import type { ChatAction, PromptResolveAction, PromptUpsertAction } from "./event-reducer.js";

export type RefreshTarget = "runtime" | "commands" | "context" | "notices" | "messages";

export type RenderIntent =
  | { type: "dirty-message"; messageID: string }
  | { type: "dirty-part"; partID: string }
  | { type: "scroll"; target: "bottom" | "preserve"; reason: string }
  | { type: "notice"; tone: "info" | "warning" | "error" | "success"; message: string }
  | { type: "toast"; tone: "success" | "error"; message: string }
  | { type: "reconcile"; reason: string; delayMs: number }
  | { type: "refresh"; targets: readonly RefreshTarget[] }
  | { type: "stream-paused"; message: string | null }
  | {
      type: "prompt-upsert";
      kind: "question" | "permission";
      request: PromptUpsertAction["request"];
      active: boolean;
    }
  | {
      type: "prompt-resolve";
      kind: "question" | "permission";
      outcome: PromptResolveAction["outcome"];
      requestID: string;
      source: PromptResolveAction["source"];
      reply?: string;
      active: boolean;
    };

const RECONCILE_MS = 500;
const IDLE_RECONCILE_MS = 200;

function isActive(sessionID: string | undefined, activeSessionID: string | null): boolean {
  return sessionID === undefined || sessionID === activeSessionID;
}

function errorMessageText(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "The agent failed without an error message.";
}

function toastMessage(message: string): string {
  return message.length > 180 ? `${message.slice(0, 179)}…` : message;
}

function applyPromptIntent(
  action: PromptUpsertAction | PromptResolveAction,
  activeSessionID: string | null,
): RenderIntent {
  const active = isActive(action.sessionID, activeSessionID);
  if (action.type === "prompt/upsert") {
    return {
      type: "prompt-upsert",
      kind: action.kind,
      request: action.request,
      active,
    };
  }
  return {
    type: "prompt-resolve",
    kind: action.kind,
    outcome: action.outcome,
    requestID: action.requestID,
    source: action.source,
    ...(action.reply === undefined ? {} : { reply: action.reply }),
    active,
  };
}

/**
 * Apply actions in order. Returned intents are ordered the same way; callers may coalesce them.
 */
export function applyChatActions(actions: readonly ChatAction[]): RenderIntent[] {
  const feed = useChatFeedStore();
  const session = useChatSessionStore();
  const context = useChatContextStore();
  const intents: RenderIntent[] = [];
  const activeSessionID = feed.thread.sessionID;

  for (const action of actions) {
    switch (action.type) {
      case "stream/ready": {
        feed.setStreamReady(action.streamID, action.reset);
        intents.push({
          type: "refresh",
          targets: ["runtime", "commands", "context", "notices", "messages"],
        });
        break;
      }
      case "stream/seq": {
        feed.applyStreamSeq(action.streamID, action.seq, action.reset);
        if (action.gap) {
          intents.push({ type: "reconcile", reason: "stream-gap", delayMs: RECONCILE_MS });
        }
        break;
      }
      case "stream/warning": {
        feed.setStreamWarning(action.message);
        intents.push(
          { type: "notice", tone: "warning", message: action.message },
          { type: "reconcile", reason: "stream-warning", delayMs: RECONCILE_MS },
        );
        break;
      }
      case "stream/limit": {
        feed.setStreamWarning(action.message);
        feed.setStreamPaused(true);
        intents.push(
          { type: "notice", tone: "warning", message: action.message },
          { type: "stream-paused", message: action.message },
        );
        break;
      }
      case "notice/upsert": {
        feed.upsertNotice(action.notice as unknown as NoticeView);
        break;
      }
      case "context/set": {
        const active = action.sessionID === activeSessionID;
        context.setSnapshot(action.sessionID, action.snapshot, active);
        break;
      }
      case "context/todos": {
        const active = action.sessionID === activeSessionID;
        context.setTodos(action.sessionID, action.todos, action.truncated, active);
        break;
      }
      case "message/upsert": {
        const record = feed.upsertMessage(action);
        intents.push({ type: "dirty-message", messageID: record.id });
        if (isActive(action.sessionID, activeSessionID)) {
          intents.push({ type: "scroll", target: "bottom", reason: "message-updated" });
        }
        break;
      }
      case "part/upsert": {
        const { record } = feed.upsertPart(action);
        intents.push(
          { type: "dirty-message", messageID: record.id },
          { type: "dirty-part", partID: action.partID },
          { type: "scroll", target: "bottom", reason: "part-updated" },
        );
        if (!action.known) {
          intents.push(
            { type: "reconcile", reason: "unknown-part-type", delayMs: RECONCILE_MS },
            {
              type: "notice",
              tone: "warning",
              message: "A live update used an unknown part type; refreshing from history.",
            },
          );
        }
        break;
      }
      case "part/delta": {
        if (feed.appendDelta(action)) {
          intents.push(
            { type: "dirty-message", messageID: action.messageID },
            { type: "dirty-part", partID: action.partID },
            { type: "scroll", target: "bottom", reason: "part-delta" },
          );
        }
        break;
      }
      case "part/omit": {
        const applied = feed.markPartOmitted(action);
        if (applied !== null) {
          intents.push(
            { type: "dirty-message", messageID: action.messageID },
            { type: "dirty-part", partID: action.partID },
            {
              type: "notice",
              tone: "warning",
              message: "A large live update was skipped; refreshing that part from history.",
            },
            { type: "reconcile", reason: "part-omitted", delayMs: RECONCILE_MS },
            { type: "scroll", target: "bottom", reason: "part-omitted" },
          );
        }
        break;
      }
      case "session/status": {
        session.setAgentStatus(action.sessionID, action.status);
        if (action.sessionID === activeSessionID) {
          feed.setAgentStatus(action.status);
          if (action.status.type === "idle") {
            intents.push(
              { type: "reconcile", reason: "idle", delayMs: IDLE_RECONCILE_MS },
              { type: "refresh", targets: ["context"] },
            );
          }
        }
        break;
      }
      case "session/error": {
        feed.failPendingOptimistic();
        const errorID = feed.appendErrorRow(action);
        const message = errorMessageText(action.message);
        session.setAgentStatus(action.sessionID, { type: "idle" });
        intents.push(
          { type: "dirty-message", messageID: errorID },
          { type: "toast", tone: "error", message: `Agent error: ${toastMessage(message)}` },
          { type: "notice", tone: "error", message },
          { type: "scroll", target: "bottom", reason: "session-error" },
          { type: "refresh", targets: ["context"] },
        );
        break;
      }
      case "session/compacted": {
        const active = action.sessionID === activeSessionID;
        context.markCompacted(active);
        intents.push(
          { type: "toast", tone: "success", message: "Session compacted." },
          { type: "notice", tone: "info", message: "Session compacted." },
          { type: "refresh", targets: ["context"] },
        );
        break;
      }
      case "session/activity": {
        if (action.cause !== "message" && action.cause !== "status") {
          intents.push({ type: "reconcile", reason: "session-activity", delayMs: RECONCILE_MS });
        }
        break;
      }
      case "prompt/upsert": {
        session.trackPromptPending(action.sessionID, action.request.key);
        intents.push(applyPromptIntent(action, activeSessionID));
        break;
      }
      case "prompt/resolve": {
        if (action.sessionID !== undefined) {
          session.resolvePromptPending(action.sessionID, `${action.source}:${action.requestID}`);
        }
        intents.push(applyPromptIntent(action, activeSessionID));
        break;
      }
      case "event/unknown": {
        intents.push({ type: "reconcile", reason: "unknown-event", delayMs: RECONCILE_MS });
        break;
      }
    }
  }

  return intents;
}
