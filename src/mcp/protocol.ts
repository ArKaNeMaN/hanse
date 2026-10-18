import type { CoordinatorService } from "../coordinator/service.js";
import { PACKAGE_NAME, VERSION } from "../version.js";

const PROTOCOL_VERSION = "2024-11-05";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: "request_sibling_change",
    description: "Request a change in a sibling application. Returns a handoff id immediately.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        summary: { type: "string" },
        spec: { type: "string" },
        requires_approval: { type: "boolean" },
        idempotency_key: { type: "string" },
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
    description: "Look up a handoff by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "deliver_handoff",
    description: "Record the result of a handoff. Idempotent per handoff id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, result: { type: "string" } },
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
      result = { handoff: service.handoffStatus(asString(args.id, "id")) ?? null };
      break;
    case "deliver_handoff":
      result = {
        handoff: service.deliverHandoff(asString(args.id, "id"), asString(args.result, "result")),
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
