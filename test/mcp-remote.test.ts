import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runRemoteMcpServer } from "../src/mcp/remote.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(token = "token-1"): { tokenFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-mcp-remote-"));
  dirs.push(dir);
  const tokenFile = path.join(dir, "mcp-token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  return { tokenFile };
}

function capture(): { lines: string[]; output: { write(chunk: string): void } } {
  const lines: string[] = [];
  return {
    lines,
    output: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
}

function bridge(
  tokenFile: string,
  inputLines: string[],
  fetchImpl: typeof fetch,
  options: { requestTimeoutMs?: number; maxQueued?: number } = {},
): Promise<string[]> {
  const { lines, output } = capture();
  return runRemoteMcpServer({
    baseUrl: "http://127.0.0.1:8787/",
    tokenFile,
    input: Readable.from(inputLines),
    output,
    fetchImpl,
    ...options,
  }).then(() => lines);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for bridge");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("remote MCP bridge", () => {
  it("forwards a stdin line to the coordinator and writes the response as one line", async () => {
    const { tokenFile } = fixture("secret-token");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
      });
    }) as typeof fetch;

    const lines = await bridge(
      tokenFile,
      ['{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'],
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/internal/mcp");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    });
    expect(calls[0]?.init?.body).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n']);
  });

  it("writes nothing when the endpoint returns 204", async () => {
    const { tokenFile } = fixture();
    const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;

    const lines = await bridge(
      tokenFile,
      ['{"jsonrpc":"2.0","method":"notifications/initialized"}\n'],
      fetchImpl,
    );

    expect(lines).toEqual([]);
  });

  it("turns an HTTP error into a JSON-RPC error line", async () => {
    const { tokenFile } = fixture();
    const fetchImpl = (async () => new Response("denied", { status: 500 })) as typeof fetch;

    const lines = await bridge(
      tokenFile,
      ['{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n'],
      fetchImpl,
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32000 },
    });
  });

  it("turns a transport error into a JSON-RPC error line", async () => {
    const { tokenFile } = fixture();
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;

    const lines = await bridge(
      tokenFile,
      ['{"jsonrpc":"2.0","id":8,"method":"tools/list"}\n'],
      fetchImpl,
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32000, message: expect.stringContaining("connection refused") },
    });
  });

  it("times out a hung request and writes one transport error line", async () => {
    const { tokenFile } = fixture();
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("fetch was called without an abort signal"));
          return;
        }
        const abort = (): void => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch;

    const lines = await bridge(
      tokenFile,
      ['{"jsonrpc":"2.0","id":11,"method":"tools/list"}\n'],
      fetchImpl,
      { requestTimeoutMs: 20 },
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32000, message: expect.stringContaining("mcp transport error") },
    });
  });

  it("rejects requests beyond the queue cap without reaching fetch", async () => {
    const { tokenFile } = fixture();
    const calls: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      await held;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
      });
    }) as typeof fetch;

    const { lines, output } = capture();
    const done = runRemoteMcpServer({
      baseUrl: "http://127.0.0.1:8787/",
      tokenFile,
      input: Readable.from([
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
        '{"jsonrpc":"2.0","id":3,"method":"tools/list"}\n',
      ]),
      output,
      fetchImpl,
      maxQueued: 1,
    });

    await waitFor(() => calls.length === 1 && lines.length >= 2);
    expect(calls).toHaveLength(1);
    const rejected = lines.map((line) => JSON.parse(line) as { id?: unknown; error?: unknown });
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toMatchObject({
      id: 2,
      error: { message: "mcp bridge queue is full" },
    });
    expect(rejected[1]).toMatchObject({
      id: 3,
      error: { message: "mcp bridge queue is full" },
    });

    release();
    await done;

    const all = lines.map((line) => JSON.parse(line) as { id?: unknown; result?: unknown });
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({ id: 1, result: { tools: [] } });
  });

  it("rereads the token file for every request", async () => {
    const { tokenFile } = fixture("token-1");
    const seen: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers.authorization ?? "");
      if (seen.length === 1) {
        writeFileSync(tokenFile, "token-2", { mode: 0o600 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
    }) as typeof fetch;

    await bridge(
      tokenFile,
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"initialize"}\n',
      ],
      fetchImpl,
    );

    expect(seen).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("fails an in-flight old-token request and succeeds on the next file-token request", async () => {
    const { tokenFile } = fixture("old-token");
    const seen: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers.authorization ?? "");
      if (seen.length === 1) {
        writeFileSync(tokenFile, "new-token", { mode: 0o600 });
        return new Response("denied", { status: 401 });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }), {
        status: 200,
      });
    }) as typeof fetch;

    const lines = await bridge(
      tokenFile,
      [
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
      ],
      fetchImpl,
    );

    expect(seen).toEqual(["Bearer old-token", "Bearer new-token"]);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ jsonrpc: "2.0", id: 1, error: {} });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("reports a missing token file as a JSON-RPC error without printing anything else", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hanse-mcp-remote-"));
    dirs.push(dir);
    const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;

    const lines = await bridge(
      path.join(dir, "missing-token"),
      ['{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n'],
      fetchImpl,
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ jsonrpc: "2.0", id: 9, error: {} });
  });
});
