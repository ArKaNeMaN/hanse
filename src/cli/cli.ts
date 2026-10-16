import { PACKAGE_NAME, VERSION } from "../version.js";
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
    `  ${PACKAGE_NAME} [command] [options]`,
    "",
    "Options:",
    "  -h, --help       Show this help and exit",
    "  -v, --version    Show the version and exit",
    "",
    "Commands are not implemented yet (pre-alpha). See docs/architecture.md.",
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

  io.stderr(`Unknown command: ${args.command}`);
  io.stderr(`Run \`${PACKAGE_NAME} --help\` for usage.`);
  return 2;
}
