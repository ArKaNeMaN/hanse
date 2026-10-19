import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/cli.js";
import { type CommandContext, webMcpCommand } from "../src/cli/commands.js";
import type { EffectiveSettings, EffectiveValue } from "../src/settings/types.js";
import { buildWebMcpConfig, parseWebMcpConfig } from "../src/web/config.js";
import { handleWebRpc, runWebMcpServer } from "../src/web/mcp.js";
import type { DeepSeekOptions, WebMcpConfig, WebToolConfig } from "../src/web/types.js";

const KEY = "sk-mcp-secret-sentinel";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hanse-web-mcp-"));
  dirs.push(dir);
  return dir;
}

function authFile(entries: Record<string, unknown>): string {
  const file = path.join(tempDir(), "auth.json");
  writeFileSync(file, JSON.stringify(entries), "utf8");
  return file;
}

function effectiveValue<T>(value: T | null): EffectiveValue<T> {
  return {
    value,
    state: value === null ? "cleared" : "set",
    source: value === null ? "default" : "app",
    sources: [value === null ? "default" : "app"],
  };
}

function effectiveSettings(
  search: WebToolConfig | null,
  fetch: WebToolConfig | null,
): EffectiveSettings {
  return {
    llm: { model: effectiveValue("deepseek/deepseek-flash") },
    web: { search: effectiveValue(search), fetch: effectiveValue(fetch) },
  };
}

interface RecordedRequest {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  json: unknown;
}

async function fakeServer(
  handler: (request: RecordedRequest, response: import("node:http").ServerResponse) => void,
): Promise<{ baseUrl: string; requests: RecordedRequest[]; close(): Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        url: req.url,
        headers: req.headers,
        json: body.length > 0 ? (JSON.parse(body) as unknown) : undefined,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind fake server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function jsonResponse(
  response: import("node:http").ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

interface RpcPayload {
  id: string | number | null;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name?: string };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function toolText(payload: RpcPayload): unknown {
  const text = payload.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as unknown;
}

const deepseek: DeepSeekOptions = { provider: "deepseek" };

describe("buildWebMcpConfig", () => {
  it("includes only managed tools as bare per-tool options", () => {
    const config = buildWebMcpConfig(
      effectiveSettings(
        { driver: "deepseek", options: { provider: "deepseek", count: 3 } },
        { driver: "builtin" },
      ).web,
    );
    expect(config).toEqual({ search: { provider: "deepseek", count: 3 } });
    expect(config).not.toHaveProperty("fetch");
    expect(config).not.toHaveProperty("driver");
  });

  it("returns undefined when no tool is managed", () => {
    expect(buildWebMcpConfig(effectiveSettings({ driver: "builtin" }, null).web)).toBeUndefined();
    expect(buildWebMcpConfig(effectiveSettings(null, null).web)).toBeUndefined();
  });
});

describe("parseWebMcpConfig", () => {
  it("accepts the exact bare shape", () => {
    expect(parseWebMcpConfig(JSON.stringify({ search: deepseek, fetch: deepseek }))).toEqual({
      search: deepseek,
      fetch: deepseek,
    });
    expect(parseWebMcpConfig("{}")).toEqual({});
  });

  it("rejects malformed JSON and out-of-range or wrapped options", () => {
    expect(() => parseWebMcpConfig("{")).toThrow(/valid JSON/);
    expect(() => parseWebMcpConfig(JSON.stringify({ search: { count: 1 } }))).toThrow();
    expect(() =>
      parseWebMcpConfig(JSON.stringify({ search: { provider: "deepseek", count: 99 } })),
    ).toThrow();
    expect(() =>
      parseWebMcpConfig(JSON.stringify({ search: { driver: "deepseek", options: deepseek } })),
    ).toThrow();
    expect(() => parseWebMcpConfig(JSON.stringify({ other: deepseek }))).toThrow();
  });
});

describe("hanse_web MCP server", () => {
  it("initializes with the hanse_web server name", async () => {
    const response = (await handleWebRpc({}, "/nonexistent", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    })) as RpcPayload;
    expect(response.result?.protocolVersion).toBeTruthy();
    expect(response.result?.serverInfo?.name).toBe("hanse_web");
  });

  it("lists only configured managed tools with a usable api credential", async () => {
    const config: WebMcpConfig = { search: deepseek, fetch: deepseek };
    const apiAuth = authFile({ deepseek: { type: "api", key: KEY } });
    const list = (await handleWebRpc(config, apiAuth, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as RpcPayload;
    expect(list.result?.tools?.map((tool) => tool.name)).toEqual(["search", "fetch"]);

    const oauthAuth = authFile({ deepseek: { type: "oauth", key: KEY } });
    const oauthList = (await handleWebRpc(config, oauthAuth, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
    })) as RpcPayload;
    expect(oauthList.result?.tools).toEqual([]);

    const missingAuth = path.join(tempDir(), "missing.json");
    const missingList = (await handleWebRpc(config, missingAuth, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
    })) as RpcPayload;
    expect(missingList.result?.tools).toEqual([]);

    const searchOnly = (await handleWebRpc({ search: deepseek }, apiAuth, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/list",
    })) as RpcPayload;
    expect(searchOnly.result?.tools?.map((tool) => tool.name)).toEqual(["search"]);
  });

  it("calls search with the configured options and provider key", async () => {
    const server = await fakeServer((_request, response) =>
      jsonResponse(response, {
        results: [{ title: "T", url: "https://example.com", snippet: "S" }],
      }),
    );
    try {
      const config: WebMcpConfig = {
        search: { provider: "deepseek", count: 3, needContent: true },
      };
      const response = (await handleWebRpc(
        config,
        authFile({ deepseek: { type: "api", key: KEY } }),
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: { name: "search", arguments: { query: "hanse" } },
        },
        { baseUrl: server.baseUrl },
      )) as RpcPayload;
      expect(response.result?.isError).toBeUndefined();
      expect(response.result?.content?.[0]?.text).toContain("https://example.com");
      expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(server.requests[0]?.json).toEqual({
        query: "hanse",
        count: 3,
        need_content: true,
      });
    } finally {
      await server.close();
    }
  });

  it("re-checks the credential on every call", async () => {
    const server = await fakeServer((_request, response) =>
      jsonResponse(response, { title: "T", content: "body" }),
    );
    const file = path.join(tempDir(), "auth.json");
    const config: WebMcpConfig = { fetch: deepseek };
    try {
      const before = (await handleWebRpc(
        config,
        file,
        { jsonrpc: "2.0", id: 7, method: "tools/list" },
        { baseUrl: server.baseUrl },
      )) as RpcPayload;
      expect(before.result?.tools).toEqual([]);

      writeFileSync(file, JSON.stringify({ deepseek: { type: "api", key: KEY } }), "utf8");
      const listed = (await handleWebRpc(
        config,
        file,
        { jsonrpc: "2.0", id: 8, method: "tools/list" },
        { baseUrl: server.baseUrl },
      )) as RpcPayload;
      expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(["fetch"]);

      rmSync(file);
      const after = (await handleWebRpc(
        config,
        file,
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "fetch", arguments: { url: "https://example.com" } },
        },
        { baseUrl: server.baseUrl },
      )) as RpcPayload;
      expect(after.result?.isError).toBe(true);
      expect(after.result?.content?.[0]?.text).toContain("no usable API key");
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("returns JSON-RPC errors for unknown and disabled tools", async () => {
    const auth = authFile({ deepseek: { type: "api", key: KEY } });
    const unknown = (await handleWebRpc({ search: deepseek }, auth, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    })) as RpcPayload;
    expect(unknown.error?.code).toBe(-32602);
    expect(unknown.result).toBeUndefined();

    const disabled = (await handleWebRpc({ search: deepseek }, auth, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "fetch", arguments: { url: "https://example.com" } },
    })) as RpcPayload;
    expect(disabled.error?.code).toBe(-32602);
    expect(disabled.error?.message).toContain("disabled");
  });

  it("returns isError for driver failures and invalid tool input without leaking keys", async () => {
    const server = await fakeServer((_request, response) =>
      jsonResponse(response, { error: { message: `leaked ${KEY}` } }, 401),
    );
    try {
      const config: WebMcpConfig = { search: deepseek, fetch: deepseek };
      const auth = authFile({ deepseek: { type: "api", key: KEY } });
      const failed = (await handleWebRpc(
        config,
        auth,
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: { name: "search", arguments: { query: "q" } },
        },
        { baseUrl: server.baseUrl },
      )) as RpcPayload;
      expect(failed.result?.isError).toBe(true);
      const text = failed.result?.content?.[0]?.text ?? "";
      expect(text).toContain("authentication failed");
      expect(text).not.toContain(KEY);

      const invalidUrl = (await handleWebRpc(
        config,
        auth,
        {
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: { name: "fetch", arguments: { url: "ftp://example.com" } },
        },
        { baseUrl: server.baseUrl },
      )) as RpcPayload;
      expect(invalidUrl.result?.isError).toBe(true);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("ignores notifications and unknown methods are errors", async () => {
    const notification = await handleWebRpc({}, "/nonexistent", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notification).toBeUndefined();

    const unknown = (await handleWebRpc({}, "/nonexistent", {
      jsonrpc: "2.0",
      id: 14,
      method: "nope",
    })) as RpcPayload;
    expect(unknown.error?.code).toBe(-32601);
  });

  it("handles interleaved requests concurrently and matches responses by id", async () => {
    const server = await fakeServer((request, response) => {
      const body = request.json as { query?: string };
      const delay = body.query === "slow" ? 120 : 5;
      setTimeout(
        () =>
          jsonResponse(response, {
            results: [{ title: body.query, url: `https://example.com/${body.query}` }],
          }),
        delay,
      );
    });
    try {
      const config: WebMcpConfig = { search: deepseek };
      const auth = authFile({ deepseek: { type: "api", key: KEY } });
      const input = new PassThrough();
      const output: string[] = [];
      const done = runWebMcpServer(config, auth, {
        input,
        write: (line) => output.push(line),
        baseUrl: server.baseUrl,
      });
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search", arguments: { query: "slow" } },
        })}\n`,
      );
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "search", arguments: { query: "fast" } },
        })}\n`,
      );
      input.end();
      await done;
      const responses = output.map((line) => JSON.parse(line) as RpcPayload);
      expect(responses.map((response) => response.id)).toEqual([2, 1]);
      expect(toolText(responses[0] as RpcPayload)).toMatchObject({
        query: "fast",
      });
      expect(toolText(responses[1] as RpcPayload)).toMatchObject({
        query: "slow",
      });
    } finally {
      await server.close();
    }
  });
});

describe("web-mcp CLI command", () => {
  it("advertises the web-mcp command in help", async () => {
    const lines: string[] = [];
    const code = await runCli(["--help"], {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("web-mcp");
  });

  function context(): {
    ctx: CommandContext;
    stdout: string[];
    stderr: string[];
  } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      ctx: {
        cwd: tempDir(),
        stateHome: tempDir(),
        io: {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      },
      stdout,
      stderr,
    };
  }

  function withEnv<T>(
    values: Record<string, string | undefined>,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(values)) {
      previous[name] = process.env[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    return run().finally(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });
  }

  it("exits 2 with stderr and no stdout when the config is missing", async () => {
    const { ctx, stdout, stderr } = context();
    const code = await withEnv(
      { HANSE_WEB_CONFIG: undefined, HANSE_OPENCODE_AUTH_FILE: undefined },
      () => webMcpCommand(ctx),
    );
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("HANSE_WEB_CONFIG");
    expect(stdout).toHaveLength(0);
  });

  it("exits 2 with stderr and no stdout when the config is invalid", async () => {
    const { ctx, stdout, stderr } = context();
    const code = await withEnv(
      { HANSE_WEB_CONFIG: "{bad", HANSE_OPENCODE_AUTH_FILE: "/tmp/auth.json" },
      () => webMcpCommand(ctx),
    );
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("valid JSON");
    expect(stdout).toHaveLength(0);
  });

  it("exits 2 with stderr and no stdout when the auth path is missing", async () => {
    const { ctx, stdout, stderr } = context();
    const code = await withEnv(
      {
        HANSE_WEB_CONFIG: JSON.stringify({ search: deepseek }),
        HANSE_OPENCODE_AUTH_FILE: undefined,
      },
      () => webMcpCommand(ctx),
    );
    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("HANSE_OPENCODE_AUTH_FILE");
    expect(stdout).toHaveLength(0);
  });
});
