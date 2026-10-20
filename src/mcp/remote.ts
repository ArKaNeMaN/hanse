import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** Options for the stdio <-> HTTP MCP bridge. */
export interface RemoteMcpBridgeOptions {
  /** Coordinator base URL, for example `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** File holding this app's plaintext token. Read per request so rotation is picked up. */
  tokenFile: string;
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
  fetchImpl?: typeof fetch;
}

type RpcId = string | number | null;

interface JsonRpcErrorLine {
  jsonrpc: "2.0";
  id: RpcId;
  error: { code: number; message: string };
}

function errorLine(id: RpcId, message: string): JsonRpcErrorLine {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function requestId(line: string): RpcId {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") {
        return id;
      }
    }
  } catch {
    // Invalid JSON is still forwarded; the coordinator answers with a parse error.
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRpcError(value: unknown): value is JsonRpcErrorLine {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { jsonrpc?: unknown; error?: unknown };
  return candidate.jsonrpc === "2.0" && typeof candidate.error === "object";
}

function singleLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * Run a newline-delimited JSON-RPC stdio bridge to `${baseUrl}/internal/mcp`.
 *
 * Each stdin line is forwarded as-is with the app bearer token; HTTP 204 produces no output and
 * every other outcome produces exactly one JSON-RPC line. Resolves when stdin closes.
 */
export function runRemoteMcpServer(options: RemoteMcpBridgeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/internal/mcp`;

  const write = (value: unknown): void => {
    output.write(singleLine(value));
  };

  const forward = async (line: string): Promise<void> => {
    const id = requestId(line);
    let token: string;
    try {
      token = readFileSync(options.tokenFile, "utf8").trim();
    } catch {
      write(errorLine(id, "agent token file is not readable"));
      return;
    }
    if (token.length === 0) {
      write(errorLine(id, "agent token file is empty"));
      return;
    }

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: line,
      });
    } catch (error) {
      write(
        errorLine(
          id,
          `mcp transport error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    if (response.status === 204) {
      return;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      write(
        errorLine(
          id,
          `mcp transport error: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    const body = parseJson(text);
    if (response.ok) {
      if (body === undefined) {
        write(errorLine(id, "mcp endpoint returned an invalid response body"));
        return;
      }
      write(body);
      return;
    }

    write(
      isJsonRpcError(body) ? body : errorLine(id, `mcp endpoint returned HTTP ${response.status}`),
    );
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input });
    let queue: Promise<void> = Promise.resolve();
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }
      queue = queue.then(() => forward(trimmed));
    });
    lines.on("close", () => {
      void queue.then(
        () => resolve(),
        () => resolve(),
      );
    });
  });
}
