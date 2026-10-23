import { CoordinatorService } from "../coordinator/service.js";
import {
  callMasterTool,
  MASTER_TOOLS,
  type MasterToolContext,
  MasterToolError,
} from "../master/tools.js";
import type { AgentTokenIdentity } from "./agent-tokens.js";
import { handleRpc, type RpcRequest, type RpcResponse } from "./protocol.js";

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failureResult(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof MasterToolError) {
    return { ok: false, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: "internal_error", message: message.slice(0, 300) };
}

/**
 * JSON-RPC surface for the reserved master application.
 *
 * Only the master tool list is advertised and only master tools are dispatched. Every other tool
 * name - including the SSH and handoff tools available to normal applications - is rejected instead
 * of falling through to `handleRpcAsync`.
 */
export async function handleMasterRpc(
  context: MasterToolContext,
  agent: AgentTokenIdentity,
  request: RpcRequest,
): Promise<RpcResponse | undefined> {
  if (request.id === undefined) {
    return undefined;
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools: MASTER_TOOLS } };
  }
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const rawArguments = params.arguments;
    const args =
      typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)
        ? (rawArguments as Record<string, unknown>)
        : {};
    try {
      const result = await callMasterTool(context, agent, name, args);
      return { jsonrpc: "2.0", id: request.id, result: textResult(result) };
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id, result: textResult(failureResult(error)) };
    }
  }
  return handleRpc(new CoordinatorService(context.db, agent.projectId), request, {
    fromAppKey: agent.appKey,
  });
}
