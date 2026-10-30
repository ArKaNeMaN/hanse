/**
 * Pure chat event reducer.
 *
 * It turns one enveloped `HanseEvent` into typed state actions, owns stream identity/sequence/gap
 * decisions, and applies the legacy per-session filters. It never touches the document, network,
 * timers, storage, or Pinia; `state-actions.ts` applies the returned actions.
 */

import { normalizeStreamWarning } from "../../assets/chat-core.js";
import type {
  BoundedPermissionRequest,
  BoundedQuestionRequest,
  HanseActivityCause,
  HanseEvent,
  HanseMessageUsage,
  HanseSessionStatus,
  PartType,
  StreamWarningCode,
  Truncation,
} from "../../src/opencode/events.js";

/** The wire event: every frame carries per-connection sequence and stream identity. */
export type InboundChatEvent = HanseEvent & { seq?: number; streamID?: string };

/** Every part type the legacy projector and the SPA render explicitly. */
export const PART_TYPES: readonly PartType[] = [
  "text",
  "reasoning",
  "tool",
  "step-start",
  "step-finish",
  "patch",
  "file",
  "subtask",
  "retry",
  "compaction",
  "snapshot",
  "agent",
];

const PART_TYPE_SET: ReadonlySet<string> = new Set(PART_TYPES);

type PromptSource = Extract<HanseEvent, { type: "permission.replied" }>["source"];
type MessageUpdated = Extract<HanseEvent, { type: "message.updated" }>;
type ContextSnapshot = Extract<HanseEvent, { type: "context.updated" }>["context"];
type NormalizedTodo = Extract<HanseEvent, { type: "todo.updated" }>["todos"][number];
type SessionNotice = Extract<HanseEvent, { type: "notice.created" }>["notice"];

export interface StreamReadyAction {
  type: "stream/ready";
  streamID: string | null;
  reset: boolean;
}

export interface StreamSeqAction {
  type: "stream/seq";
  streamID: string;
  seq: number;
  reset: boolean;
  changed: boolean;
  gap: boolean;
}

export interface StreamWarningAction {
  type: "stream/warning";
  code: string;
  message: string;
  sessionID?: string;
}

export interface StreamLimitAction {
  type: "stream/limit";
  code: string;
  message: string;
}

export interface NoticeUpsertAction {
  type: "notice/upsert";
  notice: SessionNotice;
}

export interface ContextSetAction {
  type: "context/set";
  sessionID: string;
  snapshot: ContextSnapshot;
}

export interface ContextTodosAction {
  type: "context/todos";
  sessionID: string;
  todos: readonly NormalizedTodo[];
  truncated: boolean;
}

export type MessageUpsertAction = Omit<MessageUpdated, "type"> & {
  type: "message/upsert";
  usage?: HanseMessageUsage;
};

export type PartUpsertAction = Omit<
  Extract<HanseEvent, { type: "message.part.updated" }>,
  "type" | "partType" | "part"
> & {
  type: "part/upsert";
  partType: string;
  part: Record<string, unknown>;
  known: boolean;
};

export type PartDeltaAction = Omit<
  Extract<HanseEvent, { type: "message.part.delta" }>,
  "type" | "partType"
> & {
  type: "part/delta";
  partType?: string;
};

export type PartOmitAction = Omit<
  Extract<HanseEvent, { type: "message.part.omitted" }>,
  "type" | "partType"
> & {
  type: "part/omit";
  partType?: string;
};

export type SessionStatusAction = Omit<Extract<HanseEvent, { type: "session.status" }>, "type"> & {
  type: "session/status";
  status: HanseSessionStatus;
  truncated?: Truncation;
};

export type SessionErrorAction = Omit<Extract<HanseEvent, { type: "session.error" }>, "type"> & {
  type: "session/error";
  errorID: string;
};

export type SessionCompactedAction = Omit<
  Extract<HanseEvent, { type: "session.compacted" }>,
  "type"
> & { type: "session/compacted" };

export type SessionActivityAction = Omit<
  Extract<HanseEvent, { type: "session.activity" }>,
  "type" | "cause"
> & {
  type: "session/activity";
  cause?: HanseActivityCause;
};

export interface PromptUpsertAction {
  type: "prompt/upsert";
  kind: "question" | "permission";
  request: BoundedQuestionRequest | BoundedPermissionRequest;
  sessionID: string;
}

export interface PromptResolveAction {
  type: "prompt/resolve";
  kind: "question" | "permission";
  outcome: "answered" | "dismissed" | "replied";
  sessionID?: string;
  requestID: string;
  source: PromptSource;
  reply?: string;
}

export interface UnknownEventAction {
  type: "event/unknown";
  eventType: string;
}

export type ChatAction =
  | StreamReadyAction
  | StreamSeqAction
  | StreamWarningAction
  | StreamLimitAction
  | NoticeUpsertAction
  | ContextSetAction
  | ContextTodosAction
  | MessageUpsertAction
  | PartUpsertAction
  | PartDeltaAction
  | PartOmitAction
  | SessionStatusAction
  | SessionErrorAction
  | SessionCompactedAction
  | SessionActivityAction
  | PromptUpsertAction
  | PromptResolveAction
  | UnknownEventAction;

export type DropReason = "duplicate" | "other-session" | "invalid" | "malformed";

export interface ReducerContext {
  /** Active/selected session; mirrors `route.query.session` in the SPA. */
  sessionID: string | null;
  currentStreamID?: string | null;
  lastSeqByStream?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
}

export interface StreamDecision {
  streamID: string | null;
  seq: number | null;
  reset: boolean;
  changed: boolean;
  gap: boolean;
}

export interface ReduceResult {
  accepted: boolean;
  dropReason?: DropReason;
  stream: StreamDecision | null;
  actions: ChatAction[];
}

function lastSequence(context: ReducerContext, streamID: string): number {
  const source = context.lastSeqByStream;
  if (source === undefined) {
    return 0;
  }
  if (source instanceof Map) {
    return source.get(streamID) ?? 0;
  }
  const value = (source as Readonly<Record<string, number>>)[streamID];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function streamOf(event: InboundChatEvent): { streamID: string | null; seq: number | null } {
  return {
    streamID: typeof event.streamID === "string" ? event.streamID : null,
    seq: typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : null,
  };
}

function drop(dropReason: DropReason): ReduceResult {
  return { accepted: false, dropReason, stream: null, actions: [] };
}

function accepted(actions: ChatAction[], stream: StreamDecision | null = null): ReduceResult {
  return { accepted: true, stream, actions };
}

function isOtherSession(value: unknown, sessionID: string | null): boolean {
  return typeof value === "string" && value !== sessionID;
}

function normalizePartType(value: unknown, part: Record<string, unknown>): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  const fromPart = part.type;
  return typeof fromPart === "string" && fromPart.length > 0 ? fromPart : "text";
}

function mapEvent(event: InboundChatEvent): { actions: ChatAction[]; dropReason?: DropReason } {
  switch (event.type) {
    case "notice.created": {
      const notice = event.notice;
      if (notice === null || typeof notice !== "object") {
        return { actions: [], dropReason: "malformed" };
      }
      return { actions: [{ type: "notice/upsert", notice }] };
    }
    case "context.updated": {
      const snapshot = event.context;
      if (snapshot === null || typeof snapshot !== "object") {
        return { actions: [], dropReason: "malformed" };
      }
      if (typeof snapshot.sessionID !== "string" || snapshot.sessionID.length === 0) {
        return { actions: [], dropReason: "malformed" };
      }
      if (typeof event.sessionID === "string" && event.sessionID !== snapshot.sessionID) {
        return { actions: [], dropReason: "malformed" };
      }
      return {
        actions: [{ type: "context/set", sessionID: snapshot.sessionID, snapshot }],
      };
    }
    case "message.updated": {
      if (typeof event.messageID !== "string") {
        return { actions: [], dropReason: "malformed" };
      }
      return {
        actions: [{ ...event, type: "message/upsert" }],
      };
    }
    case "message.part.updated": {
      if (typeof event.messageID !== "string" || typeof event.partID !== "string") {
        return { actions: [], dropReason: "malformed" };
      }
      const part = event.part !== null && typeof event.part === "object" ? event.part : {};
      const partType = normalizePartType(event.partType, part);
      return {
        actions: [
          {
            ...event,
            type: "part/upsert",
            partType,
            part,
            known: PART_TYPE_SET.has(partType),
          },
        ],
      };
    }
    case "message.part.delta": {
      if (
        typeof event.messageID !== "string" ||
        typeof event.partID !== "string" ||
        typeof event.delta !== "string" ||
        event.delta.length === 0
      ) {
        return { actions: [], dropReason: "malformed" };
      }
      return { actions: [{ ...event, type: "part/delta" }] };
    }
    case "message.part.omitted": {
      if (typeof event.messageID !== "string" || typeof event.partID !== "string") {
        return { actions: [], dropReason: "malformed" };
      }
      return { actions: [{ ...event, type: "part/omit" }] };
    }
    case "session.error": {
      if (typeof event.sessionID !== "string" || event.sessionID.length === 0) {
        return { actions: [], dropReason: "malformed" };
      }
      const streamID = typeof event.streamID === "string" ? event.streamID : "";
      const seq = typeof event.seq === "number" ? event.seq : 0;
      return {
        actions: [
          {
            ...event,
            type: "session/error",
            errorID: `local_error_${streamID.length > 0 ? streamID : "stream"}_${seq}`,
          },
        ],
      };
    }
    case "session.compacted": {
      if (typeof event.sessionID !== "string" || event.sessionID.length === 0) {
        return { actions: [], dropReason: "malformed" };
      }
      return { actions: [{ ...event, type: "session/compacted" }] };
    }
    case "session.status": {
      return { actions: [{ ...event, type: "session/status" }] };
    }
    case "session.activity": {
      return { actions: [{ ...event, type: "session/activity" }] };
    }
    case "question.asked":
    case "permission.asked": {
      const kind = event.type === "question.asked" ? "question" : "permission";
      return {
        actions: [
          {
            type: "prompt/upsert",
            kind,
            request: event.request,
            sessionID: event.request.sessionID,
          },
        ],
      };
    }
    case "question.replied": {
      return {
        actions: [
          {
            type: "prompt/resolve",
            kind: "question",
            outcome: "answered",
            sessionID: event.sessionID,
            requestID: event.requestID,
            source: event.source,
          },
        ],
      };
    }
    case "question.rejected": {
      return {
        actions: [
          {
            type: "prompt/resolve",
            kind: "question",
            outcome: "dismissed",
            sessionID: event.sessionID,
            requestID: event.requestID,
            source: event.source,
          },
        ],
      };
    }
    case "permission.replied": {
      return {
        actions: [
          {
            type: "prompt/resolve",
            kind: "permission",
            outcome: "replied",
            sessionID: event.sessionID,
            requestID: event.requestID,
            source: event.source,
            reply: event.reply,
          },
        ],
      };
    }
    case "todo.updated": {
      if (typeof event.sessionID !== "string" || event.sessionID.length === 0) {
        return { actions: [], dropReason: "malformed" };
      }
      return {
        actions: [
          {
            type: "context/todos",
            sessionID: event.sessionID,
            todos: event.todos,
            truncated: event.truncated === true,
          },
        ],
      };
    }
    case "stream.ready":
    case "stream.warning":
      return { actions: [] };
    default: {
      const eventType = (event as { type?: unknown }).type;
      return {
        actions: [
          {
            type: "event/unknown",
            eventType: typeof eventType === "string" ? eventType : "unknown",
          },
        ],
      };
    }
  }
}

function passesSessionFilter(event: InboundChatEvent, sessionID: string | null): boolean {
  switch (event.type) {
    case "notice.created": {
      const noticeSession = event.notice?.sessionId;
      return !isOtherSession(noticeSession, sessionID);
    }
    case "message.updated":
    case "message.part.updated":
    case "message.part.delta":
    case "message.part.omitted":
    case "session.error":
    case "session.activity":
      return !isOtherSession(event.sessionID, sessionID);
    case "session.compacted":
      return typeof event.sessionID === "string" && event.sessionID === sessionID;
    case "todo.updated":
      return typeof event.sessionID === "string" && event.sessionID.length > 0;
    default:
      return true;
  }
}

/**
 * Reduce one event. `stream.ready` resets stream identity before envelope acceptance, exactly like
 * the legacy handler. A duplicate sequence is dropped with no actions; a gap keeps the event and
 * asks the applier for a reconcile.
 */
export function reduceEvent(event: InboundChatEvent, context: ReducerContext): ReduceResult {
  if (event === null || typeof event !== "object") {
    return drop("malformed");
  }
  const { streamID, seq } = streamOf(event);

  if (event.type === "stream.ready") {
    const reset = streamID !== null;
    const changed = streamID !== null && streamID !== context.currentStreamID;
    return accepted([{ type: "stream/ready", streamID, reset }], {
      streamID,
      seq,
      reset,
      changed,
      gap: false,
    });
  }

  let streamAction: StreamSeqAction | null = null;
  let streamDecision: StreamDecision | null = null;
  if (streamID !== null) {
    const changed = streamID !== context.currentStreamID;
    if (!changed && seq !== null) {
      const last = lastSequence(context, streamID);
      if (seq <= last) {
        return drop("duplicate");
      }
      const gap = last > 0 && seq > last + 1;
      streamAction = { type: "stream/seq", streamID, seq, reset: false, changed: false, gap };
      streamDecision = { streamID, seq, reset: false, changed: false, gap };
    } else if (changed) {
      streamAction = {
        type: "stream/seq",
        streamID,
        seq: seq ?? 0,
        reset: true,
        changed: true,
        gap: false,
      };
      streamDecision = { streamID, seq, reset: true, changed: true, gap: false };
    }
  }

  if (event.type === "stream.warning") {
    const warning = normalizeStreamWarning(event);
    if (warning === null) {
      return accepted(streamAction === null ? [] : [streamAction], streamDecision);
    }
    if (warning.limit) {
      return accepted(
        [
          ...(streamAction === null ? [] : [streamAction]),
          { type: "stream/limit", code: warning.code, message: warning.message },
        ],
        streamDecision,
      );
    }
    if (warning.sessionID !== undefined && isOtherSession(warning.sessionID, context.sessionID)) {
      return drop("other-session");
    }
    return accepted(
      [
        ...(streamAction === null ? [] : [streamAction]),
        {
          type: "stream/warning",
          code: warning.code,
          message: warning.message,
          ...(warning.sessionID === undefined ? {} : { sessionID: warning.sessionID }),
        },
      ],
      streamDecision,
    );
  }

  if (!passesSessionFilter(event, context.sessionID)) {
    return drop("other-session");
  }

  const mapped = mapEvent(event);
  if (mapped.dropReason !== undefined) {
    return drop(mapped.dropReason);
  }
  return accepted(
    [...(streamAction === null ? [] : [streamAction]), ...mapped.actions],
    streamDecision,
  );
}

/** Convenience for tests and the stream adapter: the warning codes the reducer handles. */
export function isKnownWarningCode(code: string): code is StreamWarningCode {
  return (
    code === "frame_too_large" ||
    code === "stream_budget" ||
    code === "invalid_json" ||
    code === "delta_too_large"
  );
}
