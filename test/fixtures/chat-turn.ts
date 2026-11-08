import type {
  OpencodeMessage,
  OpencodePart,
  OpencodeSessionStatus,
} from "../../src/opencode/client.js";

export const TURN_SESSION_ID = "ses_turn";

export interface TurnMessageOptions {
  parentID?: string;
  finish?: string;
  completed?: boolean;
  createdAt?: number;
  completedAt?: number;
  sessionID?: string;
  hanse?: Record<string, unknown>;
}

export function textPart(text: string, extra: Record<string, unknown> = {}): OpencodePart {
  return { type: "text", text, ...extra };
}

export function toolPart(extra: Record<string, unknown> = {}): OpencodePart {
  return { type: "tool", tool: "bash", ...extra };
}

export function reasoningPart(text: string): OpencodePart {
  return { type: "reasoning", text };
}

export function manifestPart(): OpencodePart {
  return {
    type: "text",
    synthetic: true,
    metadata: { hanse: "attachment-manifest" },
    text: "Attached files",
  };
}

export function resumePart(): OpencodePart {
  return {
    type: "text",
    synthetic: true,
    metadata: { hanse: "agent-resume" },
    text: "Continue the same task.",
  };
}

export function omoPart(
  text = "<!-- OMO_INTERNAL_INITIATOR -->\n[SYSTEM DIRECTIVE]",
): OpencodePart {
  return { type: "text", synthetic: true, text };
}

function messageInfo(
  id: string,
  role: "user" | "assistant",
  options: TurnMessageOptions,
): OpencodeMessage["info"] {
  const info: OpencodeMessage["info"] = {
    id,
    role,
    sessionID: options.sessionID ?? TURN_SESSION_ID,
  };
  if (options.parentID !== undefined) info.parentID = options.parentID;
  if (options.finish !== undefined) info.finish = options.finish;
  if (options.completed !== undefined || options.createdAt !== undefined) {
    info.time = {
      ...(options.createdAt === undefined ? {} : { created: options.createdAt }),
      ...(options.completed === true ? { completed: options.completedAt ?? 2 } : {}),
    };
  }
  if (options.hanse !== undefined) info.hanse = options.hanse;
  return info;
}

export function userMessage(
  id: string,
  parts: OpencodePart[],
  options: TurnMessageOptions = {},
): OpencodeMessage {
  return { info: messageInfo(id, "user", options), parts };
}

export function assistantMessage(
  id: string,
  parts: OpencodePart[],
  options: TurnMessageOptions = {},
): OpencodeMessage {
  return { info: messageInfo(id, "assistant", options), parts };
}

export const idleStatus: OpencodeSessionStatus = { type: "idle" };
export const busyStatus: OpencodeSessionStatus = { type: "busy" };
export const retryStatus: OpencodeSessionStatus = {
  type: "retry",
  attempt: 2,
  message: "retrying",
  next: 1_000,
};

const completedTurn = [
  userMessage("msg_u1", [textPart("run")]),
  assistantMessage("msg_a1", [textPart("done")], {
    parentID: "msg_u1",
    finish: "stop",
    completed: true,
  }),
];

const busyPreFirstPart = [userMessage("msg_u1", [textPart("run")])];

const busyWithQueue = [
  userMessage("msg_u1", [textPart("run")]),
  assistantMessage("msg_a1", [textPart("working")], { parentID: "msg_u1" }),
  userMessage("msg_u2", [textPart("queued")]),
];

const multiStep = [
  userMessage("msg_u1", [textPart("run")]),
  assistantMessage("msg_a1", [toolPart()], {
    parentID: "msg_u1",
    finish: "tool-calls",
    completed: true,
  }),
  userMessage("msg_u2", [textPart("queued")]),
];

const resumeAfterInterrupted = [
  userMessage("msg_u1", [textPart("interrupted")]),
  assistantMessage("msg_a1", [], { parentID: "msg_u1", completed: true }),
  userMessage("msg_resume", [resumePart()]),
];

const attachmentOnlyQueue = [
  ...completedTurn,
  userMessage("msg_att", [manifestPart()], {
    hanse: { attachments: [{ id: "att_1" }] },
  }),
];

export const turnFixtures = {
  completedTurn,
  busyPreFirstPart,
  busyWithQueue,
  multiStep,
  resumeAfterInterrupted,
  attachmentOnlyQueue,
} as const;
