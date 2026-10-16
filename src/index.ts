#!/usr/bin/env node
import { runCli } from "./cli/cli.js";

function handleStreamError(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
}

process.stdout.on("error", handleStreamError);
process.stderr.on("error", handleStreamError);

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
