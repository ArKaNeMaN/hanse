/** Parsed command-line arguments. */
export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal argv parser: supports `--flag`, `--flag=value`, `--flag value`, `-x`, and positionals. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      if (body.length === 0) {
        continue;
      }
      const equals = body.indexOf("=");
      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      flags[token.slice(1)] = true;
      continue;
    }
    positionals.push(token);
  }

  const command = positionals.shift();
  return { command, positionals, flags };
}
