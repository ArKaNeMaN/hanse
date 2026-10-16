import { createInterface } from "node:readline";
import type { CoordinatorService } from "../coordinator/service.js";
import { handleRpc } from "./protocol.js";

/** Minimal MCP server over stdio (newline-delimited JSON-RPC). */
export async function runMcpServer(service: CoordinatorService): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let response: unknown;
    try {
      response = handleRpc(service, JSON.parse(trimmed));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
    }
    if (response !== undefined) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
