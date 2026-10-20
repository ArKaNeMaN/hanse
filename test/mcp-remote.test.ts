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
): Promise<string[]> {
  const { lines, output } = capture();
  return runRemoteMcpServer({
    baseUrl: "http://127.0.0.1:8787/",
    tokenFile,
    input: Readable.from(inputLines),
    output,
    fetchImpl,
  }).then(() => lines);
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
