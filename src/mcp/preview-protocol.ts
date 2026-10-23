import type { InstanceManager } from "../opencode/manager.js";
import type { PreviewService } from "../preview/service.js";
import { PreviewError } from "../preview/types.js";
import { appContainerName } from "../runner/names.js";
import type { AgentTokenIdentity } from "./agent-tokens.js";

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_REQUIREMENT =
  "key must be 1-32 lowercase letters, digits, or hyphens and start with a letter or digit";

/** The three app-scoped preview tools; advertised only when previews are configured. */
export const PREVIEW_TOOLS = [
  {
    name: "preview_open",
    description:
      "Open (or update) a demo preview of a service running in this application's container, exposed through the coordinator. Demo-only and runner-mode only. Call preview_open BEFORE starting the service to obtain base_path (trailing slash; use it as Vite `base`) and base_path_without_trailing_slash (use it as Next `basePath`). Serve the application under that base and bind it to 0.0.0.0. Vite: set `base = base_path` and `server.allowedHosts: true` or `operator_hostname`. Next: set `basePath = base_path_without_trailing_slash`, `trailingSlash: true`, and `allowedDevOrigins` from `operator_hostname` (or the framework's supported wildcard when it is null). Do not use port 4100; it is reserved. After the server is listening, call preview_open again with the same key to refresh the name/port (idempotent). At most 8 previews per application; reusing a key updates it without consuming a slot.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,31}$",
          minLength: 1,
          maxLength: 32,
        },
        name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[ -~]+$" },
        port: { type: "integer", minimum: 1024, maximum: 65535 },
      },
      required: ["key", "name", "port"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_close",
    description:
      "Remove one preview from this application's preview registry. Idempotent: an unknown or expired key returns closed:false. It does not stop the service in the application container; stop the service yourself if it is no longer needed.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,31}$",
          minLength: 1,
          maxLength: 32,
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_list",
    description:
      "List this application's active previews, newest first, with their URL and both base-path spellings. Expired previews are pruned before the list is returned.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const PREVIEW_TOOL_NAMES = new Set(PREVIEW_TOOLS.map((tool) => tool.name));

/** True when `name` is one of the preview tools, even if previews are not configured. */
export function isPreviewToolName(name: string): boolean {
  return PREVIEW_TOOL_NAMES.has(name);
}

/** Optional dependencies for preview dispatch; both are required for a call to succeed. */
export interface PreviewToolContext {
  previews?: PreviewService;
  manager?: InstanceManager;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asKey(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asName(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asPort(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function boundedMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function unavailable(): unknown {
  return { ok: false, code: "preview_unavailable", message: "previews are not configured" };
}

function notRunning(): unknown {
  return { ok: false, code: "preview_app_not_running", message: "application is not running" };
}

/**
 * Dispatch one preview tool. Identity comes only from the verified agent token; the only target
 * input is a port. Never throws: every failure becomes an `{ok:false, code, message}` envelope.
 */
export function callPreviewTool(
  context: PreviewToolContext,
  agent: AgentTokenIdentity,
  name: string,
  rawArgs: unknown,
): unknown {
  const previews = context.previews;
  const manager = context.manager;
  if (previews === undefined || manager === undefined) {
    return unavailable();
  }

  const args = asRecord(rawArgs);
  try {
    switch (name) {
      case "preview_open": {
        if (!manager.isRunning(agent.appId)) {
          return notRunning();
        }
        const record = previews.open({
          appId: agent.appId,
          projectId: agent.projectId,
          appKey: agent.appKey,
          key: asKey(args.key),
          name: asName(args.name),
          port: asPort(args.port),
          targetHost: appContainerName(agent.appId),
        });
        if (!manager.isRunning(agent.appId)) {
          previews.close(agent.appId, record.key);
          return notRunning();
        }
        const view = previews.view(record);
        const operator = previews.operatorHost(agent.appId);
        return {
          ok: true,
          preview: {
            key: view.key,
            name: view.name,
            port: view.port,
            url: view.url,
            base_path: view.basePath,
            base_path_without_trailing_slash: view.basePathWithoutTrailingSlash,
            operator_host: operator?.host ?? null,
            operator_hostname: operator?.hostname ?? null,
            expires_at: view.expiresAt,
          },
        };
      }
      case "preview_close": {
        const key = asKey(args.key);
        if (!KEY_PATTERN.test(key)) {
          return { ok: false, code: "preview_invalid_key", message: KEY_REQUIREMENT };
        }
        return { ok: true, closed: previews.close(agent.appId, key) };
      }
      case "preview_list":
        return {
          ok: true,
          previews: previews.views(agent.appId).map((view) => ({
            key: view.key,
            name: view.name,
            port: view.port,
            url: view.url,
            base_path: view.basePath,
            base_path_without_trailing_slash: view.basePathWithoutTrailingSlash,
            expires_at: view.expiresAt,
          })),
        };
      default:
        return {
          ok: false,
          code: "preview_internal_error",
          message: "unknown preview tool",
        };
    }
  } catch (error) {
    if (error instanceof PreviewError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: "preview_internal_error",
      message: boundedMessage(error),
    };
  }
}
