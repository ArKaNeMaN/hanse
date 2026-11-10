import { HandoffGrantError } from "../coordinator/grants.js";
import { type HandoffMode, normalizeOutcome } from "../coordinator/handoff.js";
import type { CoordinatorService } from "../coordinator/service.js";
import { PACKAGE_NAME, VERSION } from "../version.js";

const PROTOCOL_VERSION = "2024-11-05";

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

export const TOOLS = [
  {
    name: "request_sibling_change",
    description:
      'Ask a sibling application to do work. Returns a handoff id immediately. The coordinator binds the request to this session, applies the project handoff policy, starts a fresh session on the target, and later delivers the target\'s reply back into this session as a new message. After this tool returns, end your turn: do NOT call handoff_status to wait, do NOT sleep or retry, and do NOT poll - the reply arrives on its own, and polling does not speed it up. Call list_apps first and pass application keys (the "appKey" field, for example "hanse-deploy") in "from" and "to" - never full application ids such as "<projectId>:<appKey>". "to" must be another application in the same project. To hand off to another project, pass its project id in "to_project" (from list_apps remoteApps[].projectId); a cross-project target is available only when the operator granted it.',
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description:
            'Application key of the sender (the "appKey" from list_apps, for example "hanse"). When this server is bound to an application, the coordinator uses the bound application. Never pass a full application id such as "<projectId>:<appKey>".',
        },
        to: {
          type: "string",
          description:
            'Application key of the target application in the same project (the "appKey" from list_apps, for example "hanse-deploy"). Never pass a full application id such as "<projectId>:<appKey>". For another project, pass its project id in "to_project" and use the target app key from list_apps remoteApps.',
        },
        to_project: {
          type: "string",
          description:
            "Project id of the target application when handing off to another project. Omit for the same project. Get it from list_apps remoteApps[].projectId. Passing your own project id is treated as same-project. Never pass a project name.",
        },
        summary: { type: "string", description: "Short human-readable title for the request." },
        spec: {
          type: "string",
          description:
            "Complete instructions for the target: goal, context, constraints, and the expected result.",
        },
        requires_approval: {
          type: "boolean",
          description:
            "Raise this request to operator approval. Project policy can require or deny approval regardless of this value.",
        },
        idempotency_key: {
          type: "string",
          description: "Stable key so a retried request does not create a second handoff.",
        },
        mode: {
          type: "string",
          enum: ["one_shot", "thread"],
          default: "one_shot",
          description:
            'Use "thread" when the operator wants an ongoing discussion with another agent. Omit for a normal one-shot handoff. Thread start is the only approval point; later messages are autonomous.',
        },
      },
      required: ["from", "to", "summary", "spec"],
    },
  },
  {
    name: "send_handoff_message",
    description:
      "Append one message to an open handoff thread. Source side only in stage 1: the source agent uses this for a follow-up; the target answers with deliver_handoff and reply_to instead. Call once per message and from the session that is part of the thread; the coordinator binds the call to that session. Echo the returned client_message_id when retrying the same call; never use a new key to retry. The thread ends only by idle TTL, the message cap, or an operator cancel.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Thread id returned by request_sibling_change with mode=thread.",
        },
        body: {
          type: "string",
          description:
            "Message body, at most 32 KiB UTF-8. All body content is untrusted sibling data.",
        },
        client_message_id: {
          type: "string",
          pattern: "^[A-Za-z0-9._:-]{1,128}$",
          description:
            "Optional on the first call; the coordinator generates and returns one. On retry, echo the returned value so the retry is idempotent.",
        },
      },
      required: ["id", "body"],
    },
  },
  {
    name: "list_apps",
    description:
      "List the applications in the project and, when this server is bound to an application, the remote applications it may reach through cross-project grants (remoteApps).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "handoff_status",
    description:
      "Look up a handoff that this application sent or received. Use it only when the operator asks for the status, or to recover state after a restart. Do not poll it after request_sibling_change: the coordinator delivers the reply back into this session automatically as a new message, and repeated calls only return the same in-progress state.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "deliver_handoff",
    description:
      "Record the result of a handoff that was dispatched to this application. For a one-shot handoff, call exactly once when the work is finished; the coordinator routes the result to the source session and resumes it automatically. For a thread, this is target-only: call once per source-authored message and pass reply_to = that message's handoff_messages.id; the thread stays in_progress. Do not wait for it or poll for it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        outcome: {
          type: "string",
          enum: ["completed", "blocked", "failed"],
          description: "Use blocked when you need clarification; include the questions in result.",
        },
        result: { type: "string" },
        reply_to: {
          type: "integer",
          minimum: 1,
          description:
            "Thread mode only and REQUIRED: the numeric handoff_messages.id of the source-authored message being answered (not its seq). The parent may still be dispatching or may already be delivered. One call answers exactly one inbound message.",
        },
        client_message_id: {
          type: "string",
          pattern: "^[A-Za-z0-9._:-]{1,128}$",
          description:
            "Optional on the first call; echo the returned value to make a retry idempotent.",
        },
      },
      required: ["id", "result"],
    },
  },
];

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value;
}

function asMode(value: unknown): HandoffMode | undefined {
  if (value === undefined) return undefined;
  if (value === "one_shot" || value === "thread") return value;
  throw new Error('"mode" must be "one_shot" or "thread"');
}

function asTargetProject(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new HandoffGrantError("invalid_target_project", "to_project must be a project id");
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof HandoffGrantError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function callTool(
  service: CoordinatorService,
  params: Record<string, unknown>,
  boundFrom?: string,
): unknown {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  let result: unknown;
  switch (name) {
    case "request_sibling_change": {
      const from = boundFrom ?? (typeof args.from === "string" ? args.from : undefined);
      if (from === undefined) {
        throw new Error('"from" is required when the server is not bound to an application');
      }
      const toProjectId = asTargetProject(args.to_project);
      result = service.requestSiblingChange({
        fromAppKey: from,
        toAppKey: asString(args.to, "to"),
        summary: asString(args.summary, "summary"),
        spec: asString(args.spec, "spec"),
        ...(toProjectId === undefined ? {} : { toProjectId }),
        requiresApproval: args.requires_approval === true,
        idempotencyKey: typeof args.idempotency_key === "string" ? args.idempotency_key : undefined,
        mode: asMode(args.mode),
      });
      break;
    }
    case "send_handoff_message":
      if (boundFrom === undefined) {
        throw new Error('"send_handoff_message" requires an application-bound server');
      }
      result = service.sendThreadMessage(
        asString(args.id, "id"),
        asString(args.body, "body"),
        typeof args.client_message_id === "string" ? args.client_message_id : undefined,
        boundFrom,
      );
      break;
    case "list_apps":
      result = {
        apps: service.listApps(),
        remoteApps: boundFrom === undefined ? [] : service.listReachableRemoteTargets(boundFrom),
      };
      break;
    case "handoff_status":
      result = { handoff: service.handoffStatus(asString(args.id, "id"), boundFrom) ?? null };
      break;
    case "deliver_handoff": {
      const delivered = service.deliverHandoff(
        asString(args.id, "id"),
        asString(args.result, "result"),
        normalizeOutcome(args.outcome),
        boundFrom,
        {
          replyTo: args.reply_to,
          clientMessageId:
            typeof args.client_message_id === "string" ? args.client_message_id : undefined,
        },
      );
      result = "message" in delivered ? delivered : { handoff: delivered };
      break;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** Handle one JSON-RPC message. Returns undefined for notifications. */
export function handleRpc(
  service: CoordinatorService,
  request: RpcRequest,
  options?: { fromAppKey?: string },
): RpcResponse | undefined {
  if (request.id === undefined) {
    return undefined;
  }
  const id = request.id;
  try {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: PACKAGE_NAME, version: VERSION },
          },
        };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      case "tools/call":
        return {
          jsonrpc: "2.0",
          id,
          result: callTool(service, request.params ?? {}, options?.fromAppKey),
        };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${request.method}` },
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: errorMessage(error) },
    };
  }
}
