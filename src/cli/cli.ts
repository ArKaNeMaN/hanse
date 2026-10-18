import { PACKAGE_NAME, VERSION } from "../version.js";
import {
  defaultContext,
  initCommand,
  mcpCommand,
  serveCommand,
  statusCommand,
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
    "",
    "Options:",
    "  -h, --help            Show this help and exit",
    "  -v, --version         Show the version and exit",
    "      --state-home <p>  Override the coordinator state directory",
    "      --workspace <p>   Workspace of projects (serve; default: cwd)",
    "      --hostname <h>    Bind host (serve; default: 127.0.0.1)",
    "      --port <n>        Bind port (serve; default: 8787)",
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
    default:
      io.stderr(`Unknown command: ${args.command}`);
      io.stderr(`Run \`${PACKAGE_NAME} --help\` for usage.`);
      return 2;
  }
}
