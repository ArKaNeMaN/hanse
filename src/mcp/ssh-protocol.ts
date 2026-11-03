import { AgentMediaService } from "../agent-media/service.js";
import { appStateRoot } from "../attachments/paths.js";
import type { CoordinatorService } from "../coordinator/service.js";
import { appDir, findApp } from "../http/apps.js";
import type { InstanceManager } from "../opencode/manager.js";
import type { PreviewService } from "../preview/service.js";
import { APP_SKILL_TOOLS, callAppSkillTool, isAppSkillToolName } from "../skills/app-tools.js";
import type { SkillService } from "../skills/service.js";
import { toSkillFailure } from "../skills/tool-errors.js";
import type { SshService } from "../ssh/service.js";
import { SshError } from "../ssh/types.js";
import type { SqliteDatabase } from "../store/database.js";
import type { AgentTokenIdentity } from "./agent-tokens.js";
import { callPreviewTool, isPreviewToolName, PREVIEW_TOOLS } from "./preview-protocol.js";
import { handleRpc, type RpcRequest, type RpcResponse, TOOLS } from "./protocol.js";
import { textResult } from "./result.js";

export const SHOW_IMAGE_TOOL = {
  name: "show_image",
  description:
    "Show one image to the operator in this chat. Use only when the operator should see an image; do not call it for routine reading or analysis. The path must be a real file inside the application workspace or its runtime temp/attachments roots. Save screenshots there first; a tool attachment or a container /tmp path is not readable. A literal leading $TMPDIR/ is expanded to the app runtime temp directory; no other shell expansion is performed. Supports PNG, JPEG, GIF, and WebP up to 20 MiB. Returns a media id; the operator sees the image, not you.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 2048 },
      caption: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

export const SSH_TOOLS = [
  {
    name: "ssh_list_hosts",
    description: "List SSH hosts that this application may use, with active grant status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ssh_exec",
    description:
      "Run a command over SSH on an allowed host. Hosts come from ssh_list_hosts; never invent an address. May require operator approval; if the result is ssh_approval_pending, wait for the operator and retry the same call.",
    inputSchema: {
      type: "object",
      properties: {
        host_id: { type: "string" },
        command: { type: "string", maxLength: 16 * 1024 },
        timeout_sec: { type: "number" },
      },
      required: ["host_id", "command"],
    },
  },
  {
    name: "ssh_upload",
    description:
      "Upload a regular file from the application directory over SFTP. Paths are confined; approval may be required.",
    inputSchema: {
      type: "object",
      properties: {
        host_id: { type: "string" },
        local_path: { type: "string" },
        remote_path: { type: "string" },
      },
      required: ["host_id", "local_path", "remote_path"],
    },
  },
  {
    name: "ssh_download",
    description:
      "Download a regular remote file over SFTP into the application directory. Paths are confined; approval may be required.",
    inputSchema: {
      type: "object",
      properties: {
        host_id: { type: "string" },
        remote_path: { type: "string" },
        local_path: { type: "string" },
      },
      required: ["host_id", "remote_path", "local_path"],
    },
  },
];

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SshError("ssh_invalid_argument", `"${field}" must be a non-empty string`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SshError("ssh_invalid_argument", `"${field}" must be a number`);
  }
  return value;
}

async function callSshTool(
  ssh: SshService,
  agent: AgentTokenIdentity,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "ssh_list_hosts":
      return ssh.listHosts(agent);
    case "ssh_exec":
      return ssh.exec(agent, {
        hostId: asString(args.host_id, "host_id"),
        command: asString(args.command, "command"),
        ...(asNumber(args.timeout_sec, "timeout_sec") === undefined
          ? {}
          : { timeoutSec: asNumber(args.timeout_sec, "timeout_sec") }),
      });
    case "ssh_upload":
      return ssh.upload(agent, {
        hostId: asString(args.host_id, "host_id"),
        localPath: asString(args.local_path, "local_path"),
        remotePath: asString(args.remote_path, "remote_path"),
      });
    case "ssh_download":
      return ssh.download(agent, {
        hostId: asString(args.host_id, "host_id"),
        remotePath: asString(args.remote_path, "remote_path"),
        localPath: asString(args.local_path, "local_path"),
      });
    default:
      throw new SshError("ssh_invalid_argument", `Unknown SSH tool: ${name}`);
  }
}

function notConfiguredPreview(): unknown {
  return { ok: false, code: "preview_unavailable", message: "previews are not configured" };
}

/** Optional app-skill wiring for the non-master MCP surface; omitted contexts expose no app tools. */
export interface AppSkillRpcOptions {
  db?: SqliteDatabase;
  skills?: SkillService;
  manager?: InstanceManager;
  previews?: PreviewService;
  agentsHome?: string;
  getProjects?: () => ReturnType<import("../http/handler.js").HttpDeps["getProjects"]>;
}

/** Handle one JSON-RPC message for the coordinator MCP server. */
export async function handleRpcAsync(
  service: CoordinatorService,
  ssh: SshService | undefined,
  agent: AgentTokenIdentity,
  request: RpcRequest,
  options: AppSkillRpcOptions = {},
): Promise<RpcResponse | undefined> {
  if (request.id === undefined) {
    return undefined;
  }
  const id = request.id;
  if (request.method === "tools/list") {
    const tools = [
      ...TOOLS,
      ...SSH_TOOLS,
      ...(options.agentsHome !== undefined &&
      options.manager !== undefined &&
      options.getProjects !== undefined
        ? [SHOW_IMAGE_TOOL]
        : []),
      ...(options.skills !== undefined && options.db !== undefined ? APP_SKILL_TOOLS : []),
      ...(options.previews !== undefined ? PREVIEW_TOOLS : []),
    ];
    return {
      jsonrpc: "2.0",
      id,
      result: { tools },
    };
  }
  if (request.method !== "tools/call") {
    return handleRpc(service, request, { fromAppKey: agent.appKey });
  }
  const params = request.params ?? {};
  const name = typeof params.name === "string" ? params.name : "";
  if (name === "show_image") {
    if (
      options.agentsHome === undefined ||
      options.manager === undefined ||
      options.getProjects === undefined ||
      options.db === undefined
    ) {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult({
          ok: false,
          code: "image_unavailable",
          message: "image display is not configured",
        }),
      };
    }
    const found = findApp({ getProjects: options.getProjects }, agent.projectId, agent.appKey);
    if (found === undefined) {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult({
          ok: false,
          code: "image_unavailable",
          message: "application not found",
        }),
      };
    }
    const rawArgs = params.arguments;
    const args =
      typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    const service = new AgentMediaService(options.db, {
      appId: found.app.id,
      projectId: found.project.id,
      appKey: found.app.appKey,
      appDir: appDir(found.project, found.app),
      appRoot: appStateRoot(options.agentsHome, found.project.id, found.app.appKey),
      workspaceRoot: found.project.workspaceRoot,
      pathMode: options.manager.attachmentsPathMode() === "host" ? "runner" : "supervisor",
    });
    const caption = typeof args.caption === "string" ? args.caption : undefined;
    const result = await service.showImage({
      path: typeof args.path === "string" ? args.path : "",
      ...(caption === undefined ? {} : { caption }),
    });
    return { jsonrpc: "2.0", id, result: textResult(result) };
  }
  if (isPreviewToolName(name)) {
    if (options.previews === undefined) {
      return { jsonrpc: "2.0", id, result: textResult(notConfiguredPreview()) };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: textResult(
        callPreviewTool(
          {
            previews: options.previews,
            ...(options.manager === undefined ? {} : { manager: options.manager }),
          },
          agent,
          name,
          params.arguments,
        ),
      ),
    };
  }
  if (isAppSkillToolName(name)) {
    if (options.skills === undefined || options.db === undefined) {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult({
          ok: false,
          code: "unavailable",
          message: "skills are not configured",
        }),
      };
    }
    const rawArgs = params.arguments;
    const args =
      typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    try {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult(
          await callAppSkillTool(
            {
              db: options.db,
              skills: options.skills,
              ...(options.manager === undefined ? {} : { manager: options.manager }),
            },
            agent,
            name,
            args,
          ),
        ),
      };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: textResult(toSkillFailure(error)) };
    }
  }
  if (!name.startsWith("ssh_")) {
    return handleRpc(service, request, { fromAppKey: agent.appKey });
  }
  if (ssh === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      result: textResult({ ok: false, code: "ssh_unavailable", message: "SSH is not configured" }),
    };
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    return { jsonrpc: "2.0", id, result: textResult(await callSshTool(ssh, agent, name, args)) };
  } catch (error) {
    if (error instanceof SshError) {
      return {
        jsonrpc: "2.0",
        id,
        result: textResult({
          ok: false,
          code: error.code,
          message: error.message,
          ...(error.details ?? {}),
        }),
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      result: textResult({
        ok: false,
        code: "ssh_transport_error",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
