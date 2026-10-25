import { normalizeOutcome } from "../coordinator/handoff.js";
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
      'Ask a sibling application to do work. Returns a handoff id immediately. The coordinator binds the request to this session, applies the project handoff policy, starts a fresh session on the target, and later delivers the target\'s reply back into this session. Do not wait or poll. Call list_apps first and pass application keys (the "appKey" field, for example "hanse-deploy") in "from" and "to" - never full application ids such as "<projectId>:<appKey>". "to" must be another application in the same project.',
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
            'Application key of the target application in the same project (the "appKey" from list_apps, for example "hanse-deploy"). Never pass a full application id such as "<projectId>:<appKey>".',
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
      },
      required: ["from", "to", "summary", "spec"],
    },
  },
  {
    name: "list_apps",
    description: "List the applications in the project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "handoff_status",
    description: "Look up a handoff that this application sent or received.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "deliver_handoff",
    description:
      "Record the result of a handoff that was dispatched to this application. Call exactly once when the work is finished. The coordinator routes the result to the source session.",
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
      result = service.requestSiblingChange({
        fromAppKey: from,
        toAppKey: asString(args.to, "to"),
        summary: asString(args.summary, "summary"),
        spec: asString(args.spec, "spec"),
        requiresApproval: args.requires_approval === true,
        idempotencyKey: typeof args.idempotency_key === "string" ? args.idempotency_key : undefined,
      });
      break;
    }
    case "list_apps":
      result = { apps: service.listApps() };
      break;
    case "handoff_status":
      result = { handoff: service.handoffStatus(asString(args.id, "id"), boundFrom) ?? null };
      break;
    case "deliver_handoff":
      result = {
        handoff: service.deliverHandoff(
          asString(args.id, "id"),
          asString(args.result, "result"),
          normalizeOutcome(args.outcome),
          boundFrom,
        ),
      };
      break;
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
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    };
  }
}
