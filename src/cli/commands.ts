import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpAgentRuntimeClient } from "../agent/client.js";
import { runAgentHost } from "../agent/host.js";
import { runAgentSupervisor } from "../agent/supervisor.js";
import { ConfigError } from "../config/load.js";
import { CoordinatorService } from "../coordinator/service.js";
import {
  GIT_SANDBOX_APP_DIR_ENV,
  GIT_SANDBOX_BRANCH_ENV,
  GIT_SANDBOX_MESSAGE_ENV,
  GIT_SANDBOX_OPERATION_ENV,
  GIT_SANDBOX_TEST_KIND_ENV,
  GIT_SANDBOX_TEST_REMOTE_ENV,
  GIT_SANDBOX_WORKSPACE_ROOT,
  gitOpError,
  runGitOperation,
  runGitTest,
} from "../git/op.js";
import { validateGitRequest } from "../git/request.js";
import { GitService } from "../git/service.js";
import type { ProjectContext } from "../http/handler.js";
import { createHttpServer } from "../http/server.js";
import { upsertPrincipalWithToken } from "../identity/principals.js";
import { RunnerImageClient } from "../images/client.js";
import { ImageService, ImageServiceError } from "../images/service.js";
import { runRemoteMcpServer } from "../mcp/remote.js";
import { runMcpServer } from "../mcp/server.js";
import { InstanceManager } from "../opencode/manager.js";
import { OmoProfileStore } from "../opencode/omo-profile.js";
import { discoverProject, registerProject } from "../registry/index.js";
import { DockerClient } from "../runner/docker.js";
import { runRunner } from "../runner/server.js";
import { loadRunnerConfig } from "../runner/validate.js";
import { defaultImageReference } from "../runtime/build-spec.js";
import {
  agentsHome,
  coordinatorDbPath,
  coordinatorStateDir,
  defaultStateHome,
  secretKeyPath,
} from "../runtime/index.js";
import { loadOrCreateKey } from "../secrets/index.js";
import { SettingsService } from "../settings/index.js";
import { SshService } from "../ssh/service.js";
import { openDatabase, runMigrations } from "../store/index.js";
import { parseWebMcpConfig } from "../web/config.js";
import { runWebMcpServer } from "../web/mcp.js";
import type { CliIo } from "./cli.js";

export interface CommandContext {
  cwd: string;
  stateHome: string;
  io: CliIo;
}

export function defaultContext(
  cwd: string,
  io: CliIo,
  flags: Record<string, string | boolean> = {},
): CommandContext {
  const stateHome =
    typeof flags["state-home"] === "string"
      ? flags["state-home"]
      : (process.env.HANSE_STATE_HOME ?? defaultStateHome());
  return { cwd, stateHome, io };
}

/** Scaffold `.hanse/project.yaml`. Idempotent. */
export async function initCommand(dir: string, ctx: CommandContext): Promise<number> {
  const target = path.resolve(ctx.cwd, dir);
  const configPath = path.join(target, ".hanse", "project.yaml");
  if (existsSync(configPath)) {
    ctx.io.stdout(`Project already initialized: ${configPath}`);
    return 0;
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  const manifest = [
    `id: ${randomUUID()}`,
    `name: ${path.basename(target)}`,
    "base_branch: main",
    "apps: []",
    "",
  ].join("\n");
  await writeFile(configPath, manifest, "utf8");
  ctx.io.stdout(`Initialized project at ${configPath}`);
  return 0;
}

/** Discover and register a project, then print its status. */
export async function statusCommand(dir: string, ctx: CommandContext): Promise<number> {
  const target = path.resolve(ctx.cwd, dir);
  let rootPath: string;
  let project: Awaited<ReturnType<typeof discoverProject>>["project"];
  try {
    const discovered = await discoverProject(target);
    project = discovered.project;
    rootPath = discovered.rootPath;
  } catch (error) {
    if (error instanceof ConfigError) {
      ctx.io.stderr(error.message);
      return 1;
    }
    throw error;
  }

  const db = openDatabase(coordinatorDbPath(ctx.stateHome));
  try {
    runMigrations(db);
    const registered = registerProject(db, project, rootPath, rootPath);
    ctx.io.stdout(`Project ${registered.name} (${registered.id})`);
    ctx.io.stdout(`  root: ${registered.rootPath}`);
    if (registered.apps.length === 0) {
      ctx.io.stdout("  (no applications)");
    }
    for (const app of registered.apps) {
      const row = db.prepare("SELECT state FROM instances WHERE app_id = ?").get(app.id) as
        | { state: string }
        | undefined;
      ctx.io.stdout(`  app ${app.appKey} [${row?.state ?? "stopped"}] -> ${app.path}`);
    }
  } finally {
    db.close();
  }
  return 0;
}

export interface ServeOptions {
  workspace: string;
  hostname: string;
  port: number;
}
export interface ImagesOptions {
  action: string | undefined;
  app: string | undefined;
  project: string | undefined;
  workspace: string;
}

/**
 * `hanse images build` - start one human-requested app image build through the runner.
 *
 * The CLI only reads the coordinator DB/manifest and calls the runner HTTP API; Docker never runs in
 * the CLI process. `--workspace` is the coordinator workspace root used to map app paths back to the
 * runner host path (defaults to the current directory).
 */
export async function imagesCommand(options: ImagesOptions, ctx: CommandContext): Promise<number> {
  if (options.action !== "build") {
    ctx.io.stderr(
      "images: usage: hanse images build --app <appKey> [--project <id|path>] [--workspace <p>]",
    );
    return 2;
  }
  const runnerUrl = process.env.HANSE_RUNNER_URL?.trim();
  const token = process.env.HANSE_RUNTIME_TOKEN?.trim();
  if (
    runnerUrl === undefined ||
    runnerUrl.length === 0 ||
    token === undefined ||
    token.length === 0
  ) {
    ctx.io.stderr("images: HANSE_RUNNER_URL and HANSE_RUNTIME_TOKEN are required");
    return 2;
  }

  const workspaceRoot = path.resolve(ctx.cwd, options.workspace);
  const db = openDatabase(coordinatorDbPath(ctx.stateHome));
  try {
    runMigrations(db);
    let rootPath: string;
    try {
      rootPath = await imagesProjectRoot(db, options.project, ctx.cwd, workspaceRoot);
    } catch (error) {
      ctx.io.stderr(`images: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const { project } = await discoverProject(rootPath);
    const registered = registerProject(db, project, rootPath, workspaceRoot);
    const candidates = registered.apps.filter((app) => app.buildDockerfile !== null);
    const app =
      options.app === undefined
        ? candidates.length === 1
          ? candidates[0]
          : undefined
        : registered.apps.find((candidate) => candidate.appKey === options.app);
    if (app === undefined) {
      if (options.app === undefined && candidates.length !== 1) {
        ctx.io.stderr(
          "images: --app <appKey> is required when the project has zero or multiple buildable apps",
        );
      } else {
        ctx.io.stderr(`images: unknown or non-buildable app: ${options.app ?? ""}`);
      }
      return 1;
    }

    const hostWorkspace = process.env.HANSE_HOST_WORKSPACE?.trim() || workspaceRoot;
    const service = new ImageService({
      db,
      workspaceRoot,
      hostWorkspace,
      defaultImage: defaultImageReference(),
      runner: new RunnerImageClient({ baseUrl: runnerUrl, token }),
    });
    const result = await service.build(app.id, app.appKey);
    ctx.io.stdout(`Building image for ${app.appKey} (build ${result.buildId})`);
    return 0;
  } catch (error) {
    if (error instanceof ImageServiceError) {
      ctx.io.stderr(`images: ${error.message}`);
      return 1;
    }
    ctx.io.stderr(`images: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}

async function imagesProjectRoot(
  db: ReturnType<typeof openDatabase>,
  project: string | undefined,
  cwd: string,
  workspaceRoot: string,
): Promise<string> {
  if (project === undefined) {
    return workspaceRoot;
  }
  const row = db.prepare("SELECT root_path FROM projects WHERE id = ?").get(project) as
    | { root_path: string }
    | undefined;
  if (row !== undefined) {
    return row.root_path;
  }
  return path.resolve(cwd, project);
}

function prepareIde(stateHome: string): { extDir: string; userDataDir: string } {
  const base = path.join(coordinatorStateDir(stateHome), "code-server");
  const extDir = path.join(base, "extensions");
  const userDataDir = path.join(base, "data");
  mkdirSync(extDir, { recursive: true });
  mkdirSync(path.join(userDataDir, "User"), { recursive: true });

  const codeServer = process.env.HANSE_IDE_BIN ?? "/usr/lib/code-server/bin/code-server";
  const vsix = "/app/extensions/hanse-agent.vsix";
  if (existsSync(vsix)) {
    try {
      execFileSync(
        codeServer,
        ["--install-extension", vsix, "--extensions-dir", extDir, "--force"],
        { stdio: "ignore" },
      );
    } catch (error) {
      process.stderr.write(
        `hanse: failed to install bundled extension: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  const hasTheme = readdirSync(extDir).some((entry) =>
    entry.startsWith("github.github-vscode-theme"),
  );
  if (!hasTheme) {
    try {
      execFileSync(
        codeServer,
        [
          "--install-extension",
          "GitHub.github-vscode-theme",
          "--extensions-dir",
          extDir,
          "--force",
        ],
        { stdio: "ignore" },
      );
    } catch (error) {
      process.stderr.write(
        `hanse: failed to install GitHub theme: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  const settingsPath = path.join(userDataDir, "User", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  settings["workbench.colorTheme"] = "GitHub Dark Dimmed";
  settings["workbench.startupEditor"] = "none";
  settings["terminal.integrated.profiles.linux"] = {
    hanse: { path: "/usr/local/bin/hanse-shell" },
  };
  settings["terminal.integrated.defaultProfile.linux"] = "hanse";
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { extDir, userDataDir };
}

async function discoverProjectDirs(workspace: string): Promise<string[]> {
  const dirs: string[] = [];
  if (existsSync(path.join(workspace, ".hanse", "project.yaml"))) {
    dirs.push(workspace);
  }
  const entries = await readdir(workspace, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(workspace, entry.name);
    if (existsSync(path.join(candidate, ".hanse", "project.yaml"))) {
      dirs.push(candidate);
    }
  }
  return dirs;
}

/** Run a single-app agent host (internal runtime process). */
export async function agentHostCommand(specFile: string, ctx: CommandContext): Promise<number> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    return await runAgentHost(specFile, { signal: controller.signal });
  } catch (error) {
    ctx.io.stderr(`agent-host: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

export interface AgentSupervisorCommandOptions {
  hostname: string;
  port: number;
}

/** Run the B0 runtime supervisor (internal runtime process). */
export async function agentSupervisorCommand(
  options: AgentSupervisorCommandOptions,
  ctx: CommandContext,
): Promise<number> {
  const token = process.env.HANSE_RUNTIME_TOKEN;
  if (token === undefined || token.trim().length === 0) {
    ctx.io.stderr("agent-supervisor: HANSE_RUNTIME_TOKEN is required");
    return 2;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    ctx.io.stderr("agent-supervisor: --port must be an integer between 1 and 65535");
    return 2;
  }
  try {
    return await runAgentSupervisor({
      token,
      hostname: options.hostname,
      port: options.port,
      onListening: (address) => ctx.io.stdout(`hanse agent-supervisor listening on ${address}`),
    });
  } catch (error) {
    ctx.io.stderr(`agent-supervisor: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export interface RunnerCommandOptions {
  hostname: string;
  port: number;
}

async function gitTestCommand(ctx: CommandContext): Promise<number> {
  const env = process.env;
  const kind = env[GIT_SANDBOX_TEST_KIND_ENV];
  if (kind !== "ssh" && kind !== "https") {
    ctx.io.stdout(
      JSON.stringify({
        error: `${GIT_SANDBOX_TEST_KIND_ENV} must be ssh or https`,
        code: "invalid_input",
      }),
    );
    return 1;
  }
  const appDir = env[GIT_SANDBOX_APP_DIR_ENV];
  if (appDir === undefined || appDir.length === 0) {
    ctx.io.stdout(
      JSON.stringify({ error: `${GIT_SANDBOX_APP_DIR_ENV} is required`, code: "invalid_input" }),
    );
    return 1;
  }
  try {
    const test = await runGitTest({
      workspaceRoot: GIT_SANDBOX_WORKSPACE_ROOT,
      appDir,
      env,
      kind,
      ...(env[GIT_SANDBOX_TEST_REMOTE_ENV] === undefined
        ? {}
        : { remote: env[GIT_SANDBOX_TEST_REMOTE_ENV] }),
    });
    ctx.io.stdout(JSON.stringify({ test }));
    return 0;
  } catch (error) {
    ctx.io.stdout(JSON.stringify(gitOpError(error)));
    return 1;
  }
}

/** Run the sandboxed fixed git operation helper inside the one-shot app-image container. */
export async function gitOpCommand(ctx: CommandContext): Promise<number> {
  const env = process.env;
  if (env[GIT_SANDBOX_OPERATION_ENV] === "test") {
    return gitTestCommand(ctx);
  }
  const raw: Record<string, unknown> = {
    operation: env[GIT_SANDBOX_OPERATION_ENV],
  };
  if (env[GIT_SANDBOX_BRANCH_ENV] !== undefined) {
    raw.branch = env[GIT_SANDBOX_BRANCH_ENV];
  }
  if (env[GIT_SANDBOX_MESSAGE_ENV] !== undefined) {
    raw.message = env[GIT_SANDBOX_MESSAGE_ENV];
  }

  let request: ReturnType<typeof validateGitRequest>;
  try {
    request = validateGitRequest(raw);
  } catch (error) {
    ctx.io.stdout(
      JSON.stringify({
        error: error instanceof Error ? error.message : "invalid git request",
        code: "invalid_input",
      }),
    );
    return 2;
  }

  const appDir = env[GIT_SANDBOX_APP_DIR_ENV];
  if (appDir === undefined || appDir.length === 0) {
    ctx.io.stdout(
      JSON.stringify({
        error: `${GIT_SANDBOX_APP_DIR_ENV} is required`,
        code: "invalid_input",
      }),
    );
    return 2;
  }

  try {
    const payload = await runGitOperation({
      request,
      workspaceRoot: GIT_SANDBOX_WORKSPACE_ROOT,
      appDir,
      env,
    });
    ctx.io.stdout(JSON.stringify(payload));
    return 0;
  } catch (error) {
    const payload = gitOpError(error);
    ctx.io.stdout(
      JSON.stringify(
        error instanceof ConfigError ? { ...payload, code: "invalid_input" } : payload,
      ),
    );
    return 1;
  }
}

/** Run the B1 runner control API (internal; rootful Docker socket holder). */
export async function runnerCommand(
  options: RunnerCommandOptions,
  ctx: CommandContext,
): Promise<number> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    ctx.io.stderr("runner: --port must be an integer between 1 and 65535");
    return 2;
  }
  let config: ReturnType<typeof loadRunnerConfig>;
  try {
    config = loadRunnerConfig();
  } catch (error) {
    ctx.io.stderr(`runner: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  try {
    const docker = DockerClient.unixSocket(config.dockerSocket, config.dockerApiVersion);
    return await runRunner({
      config,
      docker,
      exec: docker,
      build: docker,
      validation: docker,
      hostname: options.hostname,
      port: options.port,
      onListening: (address) => ctx.io.stdout(`hanse runner listening on ${address}`),
    });
  } catch (error) {
    ctx.io.stderr(`runner: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Serve the web dashboard and HTTP API for every project found in the workspace. */
export async function serveCommand(options: ServeOptions, ctx: CommandContext): Promise<number> {
  const workspace = path.resolve(ctx.cwd, options.workspace);
  let secretKey: Buffer;
  try {
    secretKey = loadOrCreateKey(secretKeyPath(ctx.stateHome));
  } catch (error) {
    ctx.io.stderr(
      `serve: cannot load settings secret key at ${secretKeyPath(ctx.stateHome)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }
  const runtimeToken = process.env.HANSE_RUNTIME_TOKEN;
  if (runtimeToken === undefined || runtimeToken.trim().length === 0) {
    ctx.io.stderr("serve: HANSE_RUNTIME_TOKEN is required");
    return 1;
  }
  const runnerUrl = process.env.HANSE_RUNNER_URL?.trim();
  const hostWorkspace = process.env.HANSE_HOST_WORKSPACE?.trim() || undefined;
  const hostAgents = process.env.HANSE_HOST_AGENTS?.trim() || undefined;
  if (runnerUrl !== undefined && runnerUrl.length > 0) {
    if (hostWorkspace === undefined || hostAgents === undefined) {
      ctx.io.stderr(
        "serve: HANSE_HOST_WORKSPACE and HANSE_HOST_AGENTS are required with HANSE_RUNNER_URL",
      );
      return 1;
    }
  }
  const runtime = new HttpAgentRuntimeClient({
    baseUrl:
      runnerUrl && runnerUrl.length > 0
        ? runnerUrl
        : process.env.HANSE_AGENT_SUPERVISOR_URL?.trim() || "http://127.0.0.1:8789",
    token: runtimeToken,
  });
  const db = openDatabase(coordinatorDbPath(ctx.stateHome));
  runMigrations(db);
  const settings = new SettingsService({
    db,
    secretKey,
    hostAuthFile: process.env.HANSE_AUTH_FILE,
  });
  const omoProfiles = new OmoProfileStore({
    path: path.join(os.homedir(), ".omo", "omo.jsonc"),
  });
  const ssh = new SshService({
    db,
    secretKey,
    workspaceRoot: workspace,
    agentsHome: path.resolve(agentsHome()),
  });

  const token = process.env.HANSE_OPERATOR_TOKEN;
  if (token !== undefined && token.length > 0) {
    upsertPrincipalWithToken(db, { kind: "human", name: "operator", token });
  }

  for (const dir of await discoverProjectDirs(workspace)) {
    const { project, rootPath } = await discoverProject(dir);
    registerProject(db, project, rootPath, workspace);
  }

  const manager = new InstanceManager(db, path.resolve(agentsHome()), {
    runtime,
    settings,
    omoProfiles,
    workspaceRoot: workspace,
    ...(hostWorkspace === undefined ? {} : { hostWorkspace }),
    ...(hostAgents === undefined ? {} : { hostAgents }),
  });
  const getProjects = (): ProjectContext[] => {
    const rows = db.prepare("SELECT id, name, root_path FROM projects").all() as {
      id: string;
      name: string;
      root_path: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      workspaceRoot: workspace,
      service: new CoordinatorService(db, row.id),
    }));
  };
  const git = new GitService({
    workspaceRoot: workspace,
    ...(runnerUrl === undefined || runnerUrl.length === 0
      ? {}
      : { remote: { baseUrl: runnerUrl, token: runtimeToken } }),
  });
  const images =
    runnerUrl === undefined || runnerUrl.length === 0 || hostWorkspace === undefined
      ? undefined
      : new ImageService({
          db,
          workspaceRoot: workspace,
          hostWorkspace,
          defaultImage: defaultImageReference(),
          runner: new RunnerImageClient({ baseUrl: runnerUrl, token: runtimeToken }),
        });
  const server = createHttpServer({
    db,
    workspaceRoot: workspace,
    getProjects,
    git,
    manager,
    settings,
    ssh,
    ...(runnerUrl === undefined || runnerUrl.length === 0
      ? {}
      : { runner: { url: runnerUrl, token: runtimeToken } }),
    ...(images === undefined ? {} : { images }),
  });

  let ide: ChildProcess | null = null;
  const ideBin = process.env.HANSE_IDE_BIN ?? "/usr/lib/code-server/bin/code-server";
  if (process.env.HANSE_IDE !== "0" && existsSync(ideBin)) {
    const ideDirs = prepareIde(ctx.stateHome);
    ide = spawn(
      ideBin,
      [
        "--auth",
        "none",
        "--bind-addr",
        "127.0.0.1:8080",
        "--abs-proxy-base-path",
        "/ide",
        "--disable-telemetry",
        "--disable-update-check",
        "--user-data-dir",
        ideDirs.userDataDir,
        "--extensions-dir",
        ideDirs.extDir,
        workspace,
      ],
      { stdio: "inherit" },
    );
  }
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.hostname, resolve);
  });
  ctx.io.stdout(
    `hanse serving ${getProjects().length} project(s) at http://${options.hostname}:${options.port}`,
  );

  return await new Promise<number>((resolve) => {
    const shutdown = (): void => {
      manager.detach();
      ide?.kill("SIGTERM");
      server.close(() => {
        db.close();
        resolve(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/** Run the managed web tools MCP server (stdio) for one application. */
export async function webMcpCommand(ctx: CommandContext): Promise<number> {
  const rawConfig = process.env.HANSE_WEB_CONFIG;
  if (rawConfig === undefined || rawConfig.trim().length === 0) {
    ctx.io.stderr("web-mcp: HANSE_WEB_CONFIG is required");
    return 2;
  }
  const authFile = process.env.HANSE_OPENCODE_AUTH_FILE;
  if (authFile === undefined || authFile.length === 0) {
    ctx.io.stderr("web-mcp: HANSE_OPENCODE_AUTH_FILE is required");
    return 2;
  }
  let config: ReturnType<typeof parseWebMcpConfig>;
  try {
    config = parseWebMcpConfig(rawConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.io.stderr(`web-mcp: ${message}`);
    return 2;
  }
  await runWebMcpServer(config, authFile);
  return 0;
}

/** Run the coordinator MCP server (stdio) bound to one application. */
export async function mcpCommand(ctx: CommandContext): Promise<number> {
  const apiBase = process.env.HANSE_MCP_API_BASE?.trim();
  const tokenFile = process.env.HANSE_AGENT_TOKEN_FILE?.trim();
  if (
    apiBase !== undefined &&
    apiBase.length > 0 &&
    tokenFile !== undefined &&
    tokenFile.length > 0
  ) {
    await runRemoteMcpServer({ baseUrl: apiBase, tokenFile });
    return 0;
  }
  const projectId = process.env.HANSE_PROJECT_ID;
  const appKey = process.env.HANSE_APP_KEY;
  if (projectId === undefined || appKey === undefined) {
    ctx.io.stderr("mcp: HANSE_PROJECT_ID and HANSE_APP_KEY are required");
    return 2;
  }
  const db = openDatabase(process.env.HANSE_DB ?? coordinatorDbPath(ctx.stateHome));
  runMigrations(db);
  await runMcpServer(new CoordinatorService(db, projectId), appKey);
  db.close();
  return 0;
}
