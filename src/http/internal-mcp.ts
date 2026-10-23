import { CoordinatorService } from "../coordinator/service.js";
import { isMasterAppId } from "../master/constants.js";
import { verifyAgentToken } from "../mcp/agent-tokens.js";
import { handleMasterRpc } from "../mcp/master.js";
import type { RpcRequest } from "../mcp/protocol.js";
import { handleRpcAsync } from "../mcp/ssh-protocol.js";
import type { HttpDeps, HttpRequest, HttpResponse } from "./handler.js";

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(value),
    headers: { "cache-control": "no-store" },
  };
}

function bearerToken(request: HttpRequest): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization?.trim() ?? "");
  return match?.[1]?.trim();
}

function rpcError(status: number, code: number, message: string): HttpResponse {
  return json(status, { jsonrpc: "2.0", id: null, error: { code, message } });
}

/** Internal per-app MCP endpoint. The token alone selects the project/app; the body cannot. */
export async function handleInternalMcp(
  deps: HttpDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const token = bearerToken(request);
  const agent =
    token === undefined || token.length === 0 ? undefined : verifyAgentToken(deps.db, token);
  if (agent === undefined) {
    return rpcError(401, -32000, "invalid agent token");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(request.body ?? "");
  } catch {
    return rpcError(400, -32700, "parse error");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return rpcError(400, -32700, "parse error");
  }
  if (isMasterAppId(agent.appId)) {
    const response = await handleMasterRpc(
      {
        db: deps.db,
        workspaceRoot: deps.workspaceRoot,
        ...(deps.settings === undefined ? {} : { settings: deps.settings }),
        ...(deps.manager === undefined ? {} : { manager: deps.manager }),
        ...(deps.deletion === undefined ? {} : { deletion: deps.deletion }),
        ...(deps.skills === undefined ? {} : { skills: deps.skills }),
      },
      agent,
      payload as RpcRequest,
    );
    if (response === undefined) {
      return { status: 204, contentType: "application/json; charset=utf-8", body: "" };
    }
    return json(200, response);
  }
  const service = new CoordinatorService(deps.db, agent.projectId);
  const response = await handleRpcAsync(
    service,
    deps.ssh,
    agent,
    payload as Parameters<typeof handleRpcAsync>[3],
    {
      db: deps.db,
      ...(deps.skills === undefined ? {} : { skills: deps.skills }),
      ...(deps.manager === undefined ? {} : { manager: deps.manager }),
      ...(deps.previews === undefined ? {} : { previews: deps.previews }),
    },
  );
  if (response === undefined) {
    return { status: 204, contentType: "application/json; charset=utf-8", body: "" };
  }
  return json(200, response);
}
