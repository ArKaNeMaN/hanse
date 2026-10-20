import { PACKAGE_NAME, VERSION } from "../version.js";
import {
  agentHostCommand,
  agentSupervisorCommand,
  defaultContext,
  gitOpCommand,
  initCommand,
  mcpCommand,
  runnerCommand,
  serveCommand,
  statusCommand,
  webMcpCommand,
} from "./commands.js";
import { parseArgs } from "./parse.js";

/** Output sinks, injectable for testing. */
export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultIo: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

function buildUsage(): string[] {
  return [
    `${PACKAGE_NAME} ${VERSION}`,
    "",
    "Coordinator/workbench for projects of isolated opencode agent applications.",
    "",
    "Usage:",
    `  ${PACKAGE_NAME} <command> [options]`,
    "",
    "Commands:",
    "  init [dir]      Scaffold a project (.hanse/project.yaml)",
    "  status [dir]    Discover and register a project, print its status",
    "  serve           Serve the web dashboard and HTTP API",
    "  mcp             Run the coordinator MCP server (stdio)",
    "  web-mcp         Run the managed web tools MCP server (stdio)",
    "  agent-host      Run a single-app agent host (internal; --spec <file>)",
    "  agent-supervisor Run the B0 runtime supervisor (internal)",
    "  runner          Run the B1 container runner (internal)",
    "  git-op          Run a fixed git operation in the sandbox (internal)",
    "",
    "Options:",
    "  -h, --help            Show this help and exit",
    "  -v, --version         Show the version and exit",
    "      --state-home <p>  Override the coordinator state directory",
    "      --workspace <p>   Workspace of projects (serve; default: cwd)",
    "      --hostname <h>    Bind host (serve/agent-supervisor/runner; default: 127.0.0.1/0.0.0.0)",
    "      --port <n>        Bind port (serve/agent-supervisor/runner; default: 8787/8789/8790)",
    "      --spec <p>        Runtime spec file (agent-host)",
  ];
}

/** Run the CLI and return the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const args = parseArgs(argv);

  if (args.flags.help === true || args.flags.h === true || args.command === "help") {
    for (const line of buildUsage()) {
      io.stdout(line);
    }
    return 0;
  }

  if (args.flags.version === true || args.flags.v === true || args.command === "version") {
    io.stdout(`${PACKAGE_NAME} ${VERSION}`);
    return 0;
  }

  if (args.command === undefined) {
    for (const line of buildUsage()) {
      io.stdout(line);
    }
    return 0;
  }

  switch (args.command) {
    case "init":
      return initCommand(args.positionals[0] ?? ".", defaultContext(process.cwd(), io, args.flags));
    case "status":
      return statusCommand(
        args.positionals[0] ?? ".",
        defaultContext(process.cwd(), io, args.flags),
      );
    case "serve":
      return serveCommand(
        {
          workspace: typeof args.flags.workspace === "string" ? args.flags.workspace : ".",
          hostname: typeof args.flags.hostname === "string" ? args.flags.hostname : "127.0.0.1",
          port: typeof args.flags.port === "string" ? Number(args.flags.port) : 8787,
        },
        defaultContext(process.cwd(), io, args.flags),
      );
    case "mcp":
      return mcpCommand(defaultContext(process.cwd(), io, args.flags));
    case "web-mcp":
      return webMcpCommand(defaultContext(process.cwd(), io, args.flags));
    case "agent-host": {
      const spec = typeof args.flags.spec === "string" ? args.flags.spec : undefined;
      if (spec === undefined || spec.length === 0) {
        io.stderr("agent-host: --spec <file> is required");
        return 2;
      }
      return agentHostCommand(spec, defaultContext(process.cwd(), io, args.flags));
    }
    case "agent-supervisor": {
      const rawPort =
        typeof args.flags.port === "string"
          ? args.flags.port
          : process.env.HANSE_AGENT_SUPERVISOR_PORT;
      const port = rawPort === undefined || rawPort.length === 0 ? 8789 : Number(rawPort);
      const hostname = typeof args.flags.hostname === "string" ? args.flags.hostname : "0.0.0.0";
      return agentSupervisorCommand(
        { hostname, port },
        defaultContext(process.cwd(), io, args.flags),
      );
    }
    case "runner": {
      const rawPort =
        typeof args.flags.port === "string" ? args.flags.port : process.env.HANSE_RUNNER_PORT;
      const port = rawPort === undefined || rawPort.length === 0 ? 8790 : Number(rawPort);
      const hostname = typeof args.flags.hostname === "string" ? args.flags.hostname : "0.0.0.0";
      return runnerCommand({ hostname, port }, defaultContext(process.cwd(), io, args.flags));
    }
    case "git-op":
      return gitOpCommand(defaultContext(process.cwd(), io, args.flags));
    default:
      io.stderr(`Unknown command: ${args.command}`);
      io.stderr(`Run \`${PACKAGE_NAME} --help\` for usage.`);
      return 2;
  }
}
