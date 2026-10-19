import path from "node:path";

/** Identity of a managed application instance. */
export interface InstanceIdentity {
  /** Stable project id (from `.hanse/project.yaml`). */
  projectId: string;
  /** Application key (from `.hanse/app.yaml`). */
  app: string;
}

/** Per-instance, isolated XDG and opencode environment variables. */
export interface IsolatedEnv {
  XDG_DATA_HOME: string;
  XDG_STATE_HOME: string;
  XDG_CONFIG_HOME: string;
  XDG_CACHE_HOME: string;
  OPENCODE_DB: string;
}

/** Name under which the coordinator MCP server is exposed to managed agents. */
export const COORDINATOR_MCP_NAME = "hanse";
/** Name under which the image-baked codegraph MCP server is exposed to managed agents. */
export const CODEGRAPH_MCP_NAME = "codegraph";

/** Minimal opencode MCP server config (local, v1-compatible subset). */
export interface McpLocalServer {
  type: "local";
  command: string[];
  enabled?: boolean;
  environment?: Record<string, string>;
}

/** Subset of the opencode config produced as a per-instance overlay. */
export interface OpencodeOverlay {
  mcp?: Record<string, McpLocalServer>;
  instructions?: string[];
  plugin?: string[];
}

export interface BuildOverlayOptions {
  /** Command used to launch the coordinator MCP server. */
  coordinatorCommand: string[];
  /** Command used to launch the image-baked codegraph MCP server. */
  codegraphCommand?: string[];
  /** Extra instruction paths merged into every agent context (project-shared docs). */
  instructions?: string[];
  /** Baseline plugins injected into every instance (for example the image-baked OMO package). */
  plugins?: string[];
  /** Environment passed to the coordinator MCP server. */
  environment?: Record<string, string>;
}

/** Make an application key safe to use as a filesystem path segment. */
export function sanitizeAppKey(app: string): string {
  return app.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Default runtime root: outside managed repositories, keyed by stable project id. */
export function defaultRuntimeRoot(xdgStateHome: string, projectId: string): string {
  return path.join(xdgStateHome, "hanse", projectId);
}

/** Compute the isolated environment for a single application instance. */
export function resolveInstanceEnv(runtimeRoot: string, identity: InstanceIdentity): IsolatedEnv {
  const appDir = path.join(runtimeRoot, "apps", sanitizeAppKey(identity.app));
  const stateDir = path.join(appDir, "state");
  return {
    XDG_DATA_HOME: path.join(appDir, "data"),
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: path.join(appDir, "config"),
    XDG_CACHE_HOME: path.join(appDir, "cache"),
    OPENCODE_DB: path.join(stateDir, "opencode.db"),
  };
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` overlay injected into an instance.
 *
 * The overlay adds baseline plugins/MCP servers, the coordinator MCP server, and project-shared
 * instructions. It must be applied through `OPENCODE_CONFIG_CONTENT` (the highest non-managed
 * opencode config layer): `OPENCODE_CONFIG` is overridden by project config, and on opencode v2
 * `OPENCODE_CONFIG_DIR` replaces the global config directory. Adding a NEW MCP server name is safe;
 * leaving the app's own servers untouched.
 */
export function buildConfigOverlay(options: BuildOverlayOptions): OpencodeOverlay {
  const overlay: OpencodeOverlay = {};
  if (options.plugins !== undefined && options.plugins.length > 0) {
    overlay.plugin = options.plugins;
  }
  const mcp: Record<string, McpLocalServer> = {};
  if (options.codegraphCommand !== undefined && options.codegraphCommand.length > 0) {
    mcp[CODEGRAPH_MCP_NAME] = {
      type: "local",
      command: options.codegraphCommand,
      enabled: true,
    };
  }
  if (options.coordinatorCommand.length > 0) {
    mcp[COORDINATOR_MCP_NAME] = {
      type: "local",
      command: options.coordinatorCommand,
      enabled: true,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    };
  }
  if (Object.keys(mcp).length > 0) {
    overlay.mcp = mcp;
  }
  if (options.instructions !== undefined && options.instructions.length > 0) {
    overlay.instructions = options.instructions;
  }
  return overlay;
}

/** Serialize the overlay for the `OPENCODE_CONFIG_CONTENT` environment variable. */
export function serializeConfigOverlay(options: BuildOverlayOptions): string {
  return JSON.stringify(buildConfigOverlay(options));
}
